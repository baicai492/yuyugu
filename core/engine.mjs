// 引擎：把所有模块串成持续运行的托管循环。
// 职责：拉状态 → 规划 → 提交 → 擂台/社交/小游戏 → 算下次唤醒 → 记账 → 上报。
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ROOT } from './rules.mjs'
import { checkRulesUpdate, rulesVersion, rulesContentHash } from './rules.mjs'
import { planRound, nextWake, decisionSnapshot, nextRipe, foodChoices, energyActions, ANIMAL_FEED_SEC } from './planner.mjs'
import { todayStartFromLedger, todayBookFromLog, todayTaxFromLog } from './logfile.mjs'
import { loadState, saveState, rollDay, readLedger } from './persist.mjs'
import { playGomoku, playOther } from './npc.mjs'
import { arenaDaily } from './arena.mjs'
import { petCareRound } from './pet-care.mjs'
import { helpDaily, stealRound, probeStealable } from './social.mjs'
import { shouldSnipe, snipeDue, noteSnipeResult, physicalPrepLeadSec, stealGearSwaps, snipeStaminaReservation, snipeWindowOpen, SNIPE_MIN_GAP_SEC } from './steal-schedule.mjs'
import { xianRound, xianSnapshot } from './xian.mjs'
import { xian2Round, xian2Snapshot } from './xian2.mjs'
import { arcadeRound, arcadeSummary } from './arcade.mjs'
import { planVaultUpgrade, vaultSummary, vaultCapacity, disableAuto } from './warehouse.mjs'
import { acquireLock, releaseLock, defaultLockPath } from './daemon-lock.mjs'
import * as M from './market.mjs'

const fmt = (n) => Math.round(n).toLocaleString('en-US')
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)

export class Engine {
  /** 游乐馆今天还剩几局（三种游戏合计） */
  arcadeLeft() {
    try {
      const sum = arcadeSummary(this.world)
      if (!sum) return 0
      return Object.values(sum).reduce((a, g) => a + (g.left || 0), 0)
    } catch { return 0 }
  }

  constructor({ world, cfg, logDir }) {
    this.world = world
    this.cfg = cfg
    this.logDir = logDir || resolve(ROOT, 'logs')
    if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true })
    this.running = false
    this.halted = false
    this.busy = false              // 正在巡视（防止「巡视一次」和定时巡视撞车）
    this.wakeNow = false           // 外部要求立刻醒来（GUI 的「巡视一次」）
    this.watchSnap = null          // 上一次巡视结束时的世界快照，用来发现突发变化
    this.logs = []
    this.memo = {}                 // 跨轮记忆（今日已帮谁、上次扫偷菜…）
    this.ledger = { day: '', earn: 0, spend: 0, tax: 0, startCoins: 0, startStock: 0 }
    this.status = { state: 'idle', step: '', round: 0, nextAt: 0, lastError: '', lastRun: 0 }
    this.externalSoldRatio = {}
    this.history = []
    this.stats = { totalRuns: 0, totalEarn: 0, firstRunAt: 0 }
    this.lockPath = defaultLockPath(this.logDir)
    this.restore()
  }

  /** 从磁盘恢复跨重启的状态（今日收支、帮忙记录、资产曲线） */
  restore() {
    const st = loadState(this.logDir)
    this.persist = st
    this.stats = st.stats || this.stats
    // 帮忙记录 / 偷菜扫描时间
    if (Array.isArray(st.helped) && st.helped.length) this.memo.helpedIds = new Set(st.helped)
    if (st.helpCount) this.memo.helpCount = st.helpCount
    if (st.stealScanAt) this.memo.stealScanAt = st.stealScanAt
    if (st.helpDay) this.memo.helpDay = st.helpDay
    // 偷菜解禁调度表（重启后继续用，不必重新扫一遍才知道什么时候能偷）
    if (st.stealSchedule && typeof st.stealSchedule === 'object') this.memo.stealSchedule = st.stealSchedule
    if (st.helpStall) this.memo.helpStall = st.helpStall
    if (st.gomokuStall) this.memo.gomokuStall = st.gomokuStall
    if (st.stolenAt) this.memo.stolenAt = st.stolenAt
    // 擂台今日场次：重启后不用等打完一轮才知道擂台有没有做完
    if (st.arenaDay) this.memo.arenaDay = st.arenaDay
    if (st.arenaToday != null) this.memo.arenaToday = st.arenaToday
    if (st.arenaMax) this.memo.arenaMax = st.arenaMax
    if (st.arenaChest != null) this.memo.arenaChest = st.arenaChest
    if (st.arenaChestEarned != null) this.memo.arenaChestEarned = st.arenaChestEarned
    if (st.arenaChestMax) this.memo.arenaChestMax = st.arenaChestMax
    if (st.arenaSpendDay) this.memo.arenaSpendDay = st.arenaSpendDay
    if (st.arenaCostDay) this.memo.arenaCostDay = st.arenaCostDay
    if (st.arenaCost != null) this.memo.arenaCost = st.arenaCost
    // 规则版本/内容 hash 的最近一次检查结果（GUI 展示 + 连续失败告警计数）
    if (st.rulesStatus && typeof st.rulesStatus === 'object') this.memo.rulesStatus = st.rulesStatus
    // 全站销量学习值：卖货/囤货/投资的「峰值」都要用它折算供需。
    // 不持久化的话每次重启都会退化成「假设没人卖」——峰值被高估，
    // 货就全部压着不卖（线上重启后 20 种货全部 sellNow=false 就是这个原因）。
    if (st.externalSold && typeof st.externalSold === 'object') this.externalSoldRatio = st.externalSold
    // 偷菜守家线的按岛状态（打输计数 / 冷却 / 待补守家日志 / 负期望封禁）。
    // 旧版是两个平行的 map（stealLoseAt / stealBlockAt），这里做一次性迁移。
    if (st.stealState && typeof st.stealState === 'object') {
      this.memo.stealState = st.stealState
    } else {
      const legacy = {}
      // 迁移时间戳也走服务端时钟：这些 cooldown/until 之后会和服务端时刻比较
      const now = Math.floor((this.world?.clockNowMs?.() ?? Date.now()) / 1000)
      for (const [id, at] of Object.entries(st.stealLoseAt || {})) {
        legacy[id] = { lossCount: 1, lastLossAt: Number(at) || 0, needSync: false, cooldownUntil: 0, blockedUntil: 0, blockedReason: '' }
      }
      for (const [id, at] of Object.entries(st.stealBlockAt || {})) {
        const s = legacy[id] || { lossCount: 0, lastLossAt: 0, needSync: false, cooldownUntil: 0, blockedUntil: 0, blockedReason: '' }
        // 旧记录存的是「封禁开始的时刻」，按默认 10 分钟折算成结束时刻。
        s.blockedUntil = Math.max(s.blockedUntil || 0, (Number(at) || 0) + (this.cfg?.battle?.guardBlockSec ?? 600))
        s.blockedReason = 'legacy-negative-ev'
        legacy[id] = s
        if (s.blockedUntil < now) delete legacy[id]
      }
      if (Object.keys(legacy).length) this.memo.stealState = legacy
    }
    // 资产曲线（从 ledger.csv 恢复，GUI 的走势图不会因为重启断掉）
    try { this.history = readLedger(this.logDir, 240) } catch {}
    // 今日累计收支：只恢复「收支累计」，不恢复 day/起点——
    // 起点一律交给 ensureLedger() 从 ledger.csv 重新推算，避免出现「起点=0」。
    if (st.daily && st.day) {
      this.ledger = {
        ...this.ledger,
        // day 先留空，ensureLedger 会判断当前自然日；若同一天则保留累计值
        pendingDay: st.day,
        earn: st.daily.earn || 0,
        spend: st.daily.spend || 0,
        tax: st.daily.tax || 0,
      }
    }
    this.stats.totalRuns = (this.stats.totalRuns || 0) + 1
    this.stats.firstRunAt ||= Date.now()
    // 注意：这里不调 savePersist()。
    // 此刻 ledger.day 还没确定（要等 ensureLedger 从 ledger.csv 推算），
    // 提前存盘会把 day 写成空字符串，下次启动 restore() 就拿不到有效的 day。
    // 计数变化（totalRuns）在下一次 tick 收尾时自然落盘。
    // 启动时立刻记一行，保证「今日起点」有据可查
    if (this.world?.ready) this.snapshot(true)
  }

  savePersist() {
    try {
      this.persist = {
        day: this.ledger.day || this.ledger.pendingDay || '',
        daily: { earn: this.ledger.earn, spend: this.ledger.spend, tax: this.ledger.tax },
        helped: [...(this.memo.helpedIds || [])],
        helpCount: this.memo.helpCount || 0,
        helpDay: this.memo.helpDay || '',
        stealScanAt: this.memo.stealScanAt || 0,
        // 解禁调度表：重启后不用重新扫一遍才知道什么时候能偷
        stealSchedule: this.memo.stealSchedule || {},
        helpStall: this.memo.helpStall || 0,
        gomokuStall: this.memo.gomokuStall || 0,
        // 最近一次被偷的时刻：之后 24 小时都要续守家道具
        stolenAt: this.memo.stolenAt || 0,
        // 擂台今日场次（只从 /battle/gear 拿得到）：nextWake 靠它判断擂台是否打完
        arenaDay: this.memo.arenaDay || '',
        arenaToday: this.memo.arenaToday || 0,
        arenaMax: this.memo.arenaMax || 0,
        // 擂台每日宝箱进度（同样只从 /battle/gear 拿得到）
        arenaChest: this.memo.arenaChest || 0,
        arenaChestEarned: this.memo.arenaChestEarned || 0,
        arenaChestMax: this.memo.arenaChestMax || 0,
        // 擂台养成：今天做没做过、花了多少。不存的话每次重启都会重新花一份预算。
        arenaSpendDay: this.memo.arenaSpendDay || '',
        arenaCostDay: this.memo.arenaCostDay || '',
        arenaCost: this.memo.arenaCost || 0,
        // 全站销量学习值：重启后立刻能继续按真实供需估峰值，不会退化成「没人卖」
        externalSold: this.externalSoldRatio || {},
        // 偷菜守家线的按岛状态（打输计数/冷却/待补日志/负期望封禁）
        stealState: this.memo.stealState || {},
        // 规则版本/内容 hash 的最近一次检查结果
        rulesStatus: this.memo.rulesStatus || {},
        stats: this.stats,
      }
      saveState(this.logDir, this.persist)
    } catch {}
  }

  /** 标记「当前正在做什么」。GUI 靠它显示「正在巡视：擂台」而不是干巴巴的「已暂停」。 */
  setStep(step) {
    this.status = { ...this.status, state: 'working', step }
  }

  /**
   * 立刻把一笔收支记进今日账本。
   * 巡视一轮可能要跑好几分钟（擂台 30 场要 8.5 秒/场），
   * 如果等整轮结束才记账，GUI 上的「今日收支」会长时间停在 0，看着像没在工作。
   */
  credit(earn = 0, spend = 0, tax = 0, { cash = true } = {}) {
    if (!earn && !spend && !tax) return
    // 跨自然日的第一笔收支：正常路径由 tick 开头的 ensureLedger 处理，
    // 但收尾统计、后台任务也可能先记账。这里再兜一次，绝不能把昨天的
    // 累计继续加到今天头上（2026-11-13 跨日后「今日收入 970 万」）。
    if (this.world?.ready && this.ledger.day) {
      const day = this.world.R.worldDay(this.world.now)
      if (this.ledger.day !== day) {
        this.ledger.earn = 0
        this.ledger.spend = 0
        this.ledger.tax = 0
      }
    }
    this.ledger.earn += earn
    this.ledger.spend += spend
    this.ledger.tax += tax
    this.stats.totalEarn = (this.stats.totalEarn || 0) + earn
    // 自己赚/花的钱不是「外部突变」。把巡检基线一起平移，
    // 否则刚投出去的钱会在下一轮巡检里被当成突发变化，立刻再醒一轮——
    // 2026-11-12 就是这样在 3 分钟里连买了 6 轮畜栏。
    //
    // cash=false 用于「记账但现金没动」的收益：偷菜拿到的是**库存**，
    // 按市价记进今日收入是对的，但 coins 一点没变。以前也平移基线，
    // 于是下一轮巡检立刻判出「D币突变 -172,956」并提前唤醒（11-13 01:43）。
    if (cash && this.watchSnap) this.watchSnap.coins = Number(this.watchSnap.coins || 0) + earn - spend
    this.savePersist()
  }

  log(msg, level = 'info') {
    const line = `${bj()} ${msg}`
    this.logs.push({ t: Date.now(), level, msg })
    const max = this.cfg.log?.maxLines || 2000
    if (this.logs.length > max) this.logs.splice(0, this.logs.length - max)
    console.log(line)
    try {
      appendFileSync(resolve(this.logDir, `yuyugu-${bj().slice(0, 10)}.log`), line + '\n', 'utf8')
    } catch {}
  }

  /**
   * 开始今天的账本（自然日切换时重置）。
   * 重启程序时，如果 ledger.csv 里今天已经有更早的记录，就用那条作为起点，
   * 这样「今日净增」不会因为重启而清零。
   */
  ensureLedger() {
    const R = this.world.R
    const day = R.worldDay(this.world.now)
    // 已经算过今天就跳过——但 startCoins 必须是有效值（>0），
    // 否则说明是从 state.json 恢复了一个只有 day 的空账本，需要重算。
    if (this.ledger.day === day && this.ledger.startCoins > 0) return
    // 跨自然日：恢复的累计值只在同一天有效。
    //
    // 这里必须同时看 ledger.day 和 pendingDay：
    //   · pendingDay 只在「重启」时有值（restore 从 state.json 带出来的）；
    //   · 进程一直在跑、跨过 0 点时 pendingDay 早就被删掉了，只有 ledger.day
    //     能说明账本属于哪一天。以前只判断 pendingDay，导致跨日不清零——
    //     2026-11-13 00:02 线上就是这样把 11-12 的 970 万收入和 763 万支出
    //     原样算进了新的一天（当天其实只赚了 4,916）。
    const dayChanged = Boolean(this.ledger.day) && this.ledger.day !== day
    const pendingChanged = Boolean(this.ledger.pendingDay) && this.ledger.pendingDay !== day
    if (dayChanged || pendingChanged) {
      this.ledger.earn = 0; this.ledger.spend = 0; this.ledger.tax = 0
    }
    delete this.ledger.pendingDay

    const coinsNow = this.world.coins
    const stockNow = this.world.stockValue()
    const fromFile = todayStartFromLedger(this.logDir)
    // 磁盘上的起点必须合理：正数、且不超过当前余额的 5 倍（防 CSV 被改坏）
    const usable = fromFile && fromFile.startCoins > 0 && fromFile.startCoins < coinsNow * 5

    // 收支累计：今天的日志是可信来源（日志按日期分文件、只追加不覆盖）。
    // 日志里除了每轮的「本轮收支」，还记了服务端的「按服务端补账」——
    // todayBookFromLog 会把补账当成「重置到今天累计值」处理，所以五子棋奖励
    // 这类不在轮次里的收入也不会丢。state.json 仅在日志为空时兜底：
    // 它是覆盖写，一旦哪天跨日没清零（就是上面那个 bug），脏值会一直跟着。
    let earn = this.ledger.earn || 0
    let spend = this.ledger.spend || 0
    let tax = this.ledger.tax || 0
    {
      const book = todayBookFromLog(this.logDir)
      if (book.rounds > 0) {
        if (earn !== book.earn || spend !== book.spend) {
          this.log(`今日收支以日志为准：+${fmt(book.earn)} / −${fmt(book.spend)}（税 ${fmt(book.tax)}；state.json 里是 +${fmt(earn)} / −${fmt(spend)}）`)
        }
        earn = book.earn
        spend = book.spend
        // 税也以日志为准（日志按天隔离，昨天带过来的 26 万必须丢掉）；
        // 旧版本把税写成 0 的脏值由下面的 todayTaxFromLog 兜底。
        tax = book.tax
      }
    }
    // 税单独兜一次底：旧版本把「卖货税」记成了恒 0（取错字段，见 world.act），
    // 那个 0 已经覆盖写进 state.json 了。光修取值不够——当天已经跑过的部分
    // 恢复出来仍然是 0，GUI 会一直显示 0 到下一个自然日。
    // 日志里每批卖货都有「（已扣税 N）」，取两者较大值即可平滑过渡。
    {
      const fromLog = todayTaxFromLog(this.logDir)
      if (fromLog > tax) {
        this.log(`今日卖货税从日志重建：${fmt(fromLog)}（state.json 里是 ${fmt(tax)}，旧版本没记上）`)
        tax = fromLog
      }
    }

    this.ledger = {
      ...this.ledger,
      day,
      earn,
      spend,
      tax,
      startCoins: usable ? fromFile.startCoins : coinsNow,
      startStock: usable ? fromFile.startStock : stockNow,
      resumedFrom: usable ? fromFile.firstTime : '',
      startFrom: usable ? fromFile.from : 'now',
    }
    this.log(`—— ${day}：D币 ${fmt(coinsNow)}，库存 ${fmt(stockNow)}` +
      (usable
        ? `（起点取自 ${fromFile.firstTime} 的 ${fmt(fromFile.startCoins)}，${fromFile.from === 'yesterday' ? '昨天收盘' : '今天早些时候'}）`
        : '（首次运行，起点=当前值）') + ' ——')
    this.savePersist()      // day 已确定，立刻落盘（否则重启后 restore 拿到空 day）
  }

  /**
   * 按服务端数据补今天的账（旧版 recoverBook）。
   * 日志被清空、换机器、进程重启前的操作都能补上：
   *   收入 = 赚钱榜里自己今天的累计（已扣税）
   *   卖货税 = 税务流水里今天的 pet-world-sale-tax
   *   支出 = 08:00 余额税后的余额 + 今日收入 − 现在的余额
   * 每天只做一次；接口失败就下次再试，不影响托管。
   */
  async recoverBookFromServer() {
    const R = this.world.R
    const day = R.worldDay(this.world.now)
    if (this.memo.srvBook?.day === day) return
    const c = this.world.client
    if (!c?.get) return
    let rank, tax
    try {
      rank = await c.get('/api/pet/world/rank/earn/day?limit=1')
      tax = await c.get('/api/pet/world/tax')
    } catch { return }
    const hist = (tax?.history || []).filter((h) => R.worldDay(h.created_at) === day)
    const saleTax = hist.filter((h) => h.kind === 'pet-world-sale-tax').reduce((x, h) => x - h.delta, 0)
    const earn = rank?.day === day && rank?.mine ? Number(rank.mine.value) || 0 : 0
    if (earn > this.ledger.earn) {
      this.log(`今日收入按服务端补账：+${fmt(earn)}（日志里是 +${fmt(this.ledger.earn)}）`)
      this.ledger.earn = earn
    }
    if (saleTax > this.ledger.tax) {
      this.log(`今日卖货税按服务端补账：${fmt(saleTax)}（日志里是 ${fmt(this.ledger.tax)}）`)
      this.ledger.tax = saleTax
    }
    const bal = hist.find((h) => h.kind === 'pet-world-balance-tax')
    if (bal && earn) {
      const spend = (bal.balance_after + earn) - this.world.coins
      if (spend > this.ledger.spend) {
        this.log(`今日支出按服务端补账：−${fmt(spend)}（日志里是 −${fmt(this.ledger.spend)}）`)
        this.ledger.spend = spend
      }
    }
    // 余额税单独留一份给 GUI：它每天 08:00 按那一刻的现金扣 0.1%/0.3%，
    // 是「钱放着不动」的日成本。用户看到这个数才会决定要不要把现金花掉。
    const balTax = hist.filter((h) => h.kind === 'pet-world-balance-tax').reduce((x, h) => x - h.delta, 0)
    this.memo.srvTax = { day, saleTax, balanceTax: balTax, at: bal?.created_at || 0 }
    this.memo.srvBook = { day }
    this.savePersist()
  }

  /**
   * 「游乐馆手操中」的让位轮次：不发任何写请求，只刷新状态、安排下次唤醒。
   *
   * 玩家一局最长 MIN_PLAY+操作，通常几十秒；TTL 兜底 180 秒（Esc 退出时
   * state.arc.cur 不会清）。每 10~20 秒回来看一次，cur 一空就恢复正常托管。
   * 修仙/擂台走独立接口、不改 world rev，本来可以不暂停；但一次手操只有
   * 几十秒，统一停掉更简单，也避免「托管还在后台换装/斗法」的观感问题。
   */
  standbyTick(w, ma, cfg) {
    const key = `${ma.game}@${ma.startedAtSec}`
    if (this.memo.arcadeStandbyKey !== key) {
      this.memo.arcadeStandbyKey = key
      this.log(`游乐馆手动游玩中（${ma.game}，剩 ${ma.remainingSec} 秒）：本轮暂停所有提交——` +
        '后台写入会让本轮 arcEnd 因 rev 过期被判 409 丢掉', 'warn')
    }
    const sleep = Math.max(10, Math.min(ma.remainingSec + 2, cfg.loop?.manualArcadePollSec ?? 20))
    this.status = {
      state: 'waiting',
      step: '游乐馆手操中，暂停写入',
      round: (this.status.round || 0) + 1,
      nextAt: Date.now() + sleep * 1000,
      sleep,
      lastError: '',
      lastRun: Date.now(),
      arcadeStandby: ma,
    }
    this.busy = false
    try { this.snapshot() } catch {}
    return { sleep, plan: { actions: [] }, standby: ma }
  }

  /** 一轮完整的巡视 */
  async tick() {
    // 单实例锁：GUI「重启」会先拉起新进程、旧进程可能还在 tick 里（擂台 4 分钟、
    // 偷菜 30 秒）。两边同时用同一个 rev 提交 = 重复卖出/买入 + 存档互相覆盖。
    // 拿不到锁就跳过本轮——新进程晚几秒接上，不会有第二份写入。
    const lock = acquireLock(this.lockPath, { now: Math.floor(Date.now() / 1000) })
    if (!lock.ok) {
      const holder = lock.holder || {}
      const key = `${holder.pid}`
      if (this.memo.lockSkipPid !== key) {
        this.memo.lockSkipPid = key
        this.log(`另一个托管进程（pid ${holder.pid}）正在巡视，跳过本轮`, 'warn')
      }
      this.status = { ...this.status, state: 'waiting', step: '等待另一个进程退出' }
      return { sleep: 5 }
    }
    this.memo.lockSkipPid = ''
    try {
      return await this.tickBody()
    } finally {
      releaseLock(this.lockPath)
    }
  }

  /** 真正的一轮巡视（调用方已持有单实例锁） */
  async tickBody() {
    const w = this.world
    const R = w.R
    const cfg = this.cfg
    // 全站销量学习值挂在 engine 上（savePersist 从这里落盘），world 只是借用
    if (!w.externalSoldRatio || !Object.keys(w.externalSoldRatio).length) {
      w.externalSoldRatio = this.externalSoldRatio || {}
    }

    // 关键：一轮可能要跑好几分钟（擂台 30 场就要 4 分钟）。
    // 必须一进来就把状态切成「工作中」，否则 GUI 整轮都显示上一轮留下的「已暂停」。
    this.busy = true
    this.setStep('读取世界状态')
    await w.refresh()
    // 手动游乐馆让位（v1.4.6 移植）：/isle-arcade.js 提交 arcEnd 时用的是 arcStart
    // 那一刻的旧 rev，前端不会重试 409。后台任何写入都会让玩家这一局作废（次数还照扣），
    // 所以检测到 state.arc.cur 就整轮停写，只保留状态刷新，等 cur 清掉再恢复。
    {
      const ma = w.manualArcade(w.now, cfg.arcade?.manualTtlSec)
      if (ma.active) return this.standbyTick(w, ma, cfg)
      if (this.memo.arcadeStandbyKey) {
        this.memo.arcadeStandbyKey = ''
        this.status.arcadeStandby = null
        this.log('游乐馆手操结束，恢复托管')
      }
    }
    // 新人礼：账号还没有 gift 状态时领一次（旧版 page.mjs 在 world() 里做）。
    // 领完要重新拉世界状态，否则这一轮的动作都是基于「没领礼」的旧快照。
    if (!cfg.dry && !w.state.gift && !this.memo.welcomeTried) {
      this.memo.welcomeTried = true
      try {
        await w.client.post('/api/pet/world/welcome', { operation: randomUUID() })
        this.log('领取新人礼')
        await w.refresh()
      } catch { /* 领不了就算了，不影响托管 */ }
    }
    // 站内挂机管家：它每 2 小时自己巡视一轮、最多补算 24 轮，和托管抢同一池体力。
    // 站点默认就是关的（AUTO_DEFAULT.on=false），发现被打开就关掉——
    // 旧代码只是在 autoLog 有补算时提醒一句，那时体力已经被烧掉了。
    if (!cfg.dry && w.state?.auto?.on) {
      try {
        if (await disableAuto(w)) this.log('已关闭站内挂机管家（它会和托管抢体力）')
      } catch (e) { this.log('关闭站内管家失败：' + e.message, 'warn') }
    }
    this.ensureLedger()
    await this.recoverBookFromServer()

    // 站点规则热重载：定期查版本号，变了就重新下载并补喂 clockStart。
    // 旧版（Chrome 插件）是每 30 分钟查一次，重写 v2 时漏掉了这个，
    // 变成只在进程启动时加载一次——站点改规则后要等下次重启才能用上新公式，
    // 中间会一直「悄悄用错的规则做决策」，不报错、只是收益变低。
    try {
      const lastChk = this.memo.rulesCheckedAt || 0
      if (w.now - lastChk > 1800) {
        this.memo.rulesCheckedAt = w.now
        // 必须带登录 cookie：未登录的 /pets 不渲染带 ?v= 的 script 标签，
        // fetchVersion 会拿到空字符串 —— 旧代码不传 cookie，于是「版本检查」
        // 每次都被当成「没变化」静默跳过，站点更新后永远发现不了。
        const u = await checkRulesUpdate({ baseUrl: this.cfg.baseUrl, cookie: this.world.client?.cookie })
        if (u) {
          if (u.changed) {
            if (u.sameVersion) {
              // 版本号没换但公式变了——最危险的一种更新，必须显眼地记一笔
              this.log(`站点规则内容在版本号 ${u.to} 下变了` +
                `（${String(u.oldHash || '').slice(0, 8)} → ${String(u.hash || '').slice(0, 8)}），已热替换`, 'warn')
            } else {
              this.log(`站点更新：规则模块 ${u.from} → ${u.to}（时钟已重新校准）`)
            }
            // 解禁时刻表是按旧公式算的（生长/保护期/连茬都可能写在规则里），
            // 留着只会按错的时刻醒。丢掉，下一轮按新规则重算。
            this.memo.stealSchedule = {}
            this.memo.stealScanAt = 0
          }
          this.memo.rulesStatus = {
            at: w.now,
            ver: u.to || rulesVersion(),
            hash: u.hash || '',
            contentCheckedAt: u.contentChecked ? w.now : (this.memo.rulesStatus?.contentCheckedAt || 0),
            ok: true,
            fail: 0,
          }
        } else {
          // null 是「取不到版本号/下载失败」，不是「没变化」。
          // 第一次失败 + 之后每 12 次（30 分钟一轮 ≈ 6 小时）提醒一次，不刷屏。
          const prev = this.memo.rulesStatus || {}
          const fail = (prev.fail || 0) + 1
          this.memo.rulesStatus = { ...prev, ok: false, fail }
          if (fail === 1 || fail % 12 === 0) {
            this.log(`规则版本检查失败（连续 ${fail} 次），继续用 rules-${rulesVersion()}；网络恢复后会自动重试`, 'warn')
          }
        }
      }
    } catch (e) { /* 规则检查失败不影响托管 */ }

    // 本轮巡视的起点，收尾时对比「这次巡视赚了多少」（和旧版一样的口径）
    const startCoins = w.coins
    const startStock = w.stockValue()

    // 市场供需反推（供卖货与预测）
    try {
      const obs = M.inferSupply(R, w.prices, w.isleDay)
      // 反推出的供需里包含**自己**今天卖的量。先把这部分扣掉，剩下的才是外部供给，
      // 否则预测会把「自己卖压价」误判成「别人也在卖」，越卖越不敢卖。
      const mine = {}
      for (const [id, r] of Object.entries(obs.rows)) {
        const sold = w.state?.cnt?.['sc_' + id] || 0
        if (sold > 0) mine[id] = sold / Math.max(1, r.depth)
      }
      w.externalSoldRatio = M.learnExternal(w.externalSoldRatio, obs, mine)
      this.externalSoldRatio = w.externalSoldRatio   // savePersist 从这里落盘
      w.lastSupply = obs
    } catch {}

    const s = w.state
    // 第一行：世界状态概览（和旧版一致）
    this.log([
      `岛日 ${R.isleDayNo(w.now)}（${R.SEASONS[w.season]}·${R.WEATHERS[w.weather]}·${R.isleHour(w.now)} 点）`,
      `D币 ${fmt(w.coins)}`,
      `体力 ${Math.floor(s.en)}/${R.energyMax(s)}`,
      `库存 ${fmt(w.stockValue())}`,
    ].join('｜'))

    // 第二行：决策依据——每点体力各能干出多少，为什么选这个活
    try {
      const exp = M.expectedPrices(R, w.now, w.prices, { outlook: cfg.sell?.outlookDays ?? 3, external: w.externalSoldRatio || {} })
      const d = decisionSnapshot(R, s, w.now, w.prices, exp, cfg)
      // 每项后面带上本岛日剩余额度。「炸矿 2,952」只是单价，不代表还能炸；
      // 额度打完时写成「剩 0」，一眼就知道为什么没动作。
      const q = d.quota || {}
      const jobs = []
      if (cfg.work?.fish) jobs.push(`钓鱼 ${fmt(d.fish)}${q.fish <= 0 ? '(剩0)' : `(剩${q.fish})`}`)
      if (cfg.work?.mine) jobs.push(`挖矿 ${fmt(d.mine)}${q.mine <= 0 ? '(剩0)' : `(剩${q.mine})`}`)
      if (cfg.work?.bomb) jobs.push(`炸矿 ${fmt(d.bomb)}${q.bomb <= 0 ? '(剩0)' : `(剩${q.bomb})`}`)
      // 全部没额度时说清楚「等换岛日」，而不是继续报「当前最优 炸矿」
      const verdict = d.allWorkDone
        ? '本岛日体力活额度已用尽，等换岛日'
        : `当前最优 ${d.bestJob}${d.worthWorking ? '' : '（不值得，收益低于口粮）'}`
      this.log(`每点体力收益：${jobs.join('  ')}｜口粮成本 ${d.foodName ? `${fmt(d.foodCost)}（${d.foodName}）` : '库存无口粮'}` +
        `｜${verdict}` +
        `｜地块 ${d.plotN - d.empty}/${d.plotN} 已种（${d.topCrop}）｜空 ${d.empty} 块`)
    } catch (e) { /* 决策依据只是辅助信息，算不出来不影响主流程 */ }

    // ---------- 偷菜体力预留 ----------
    //
    // 榜一 computeImminentSnipeStaminaReservation 的移植：未来 reserveHorizonSec
    // 秒内有解禁目标时，先按「这一波要几点体力 − 到解禁自然回复几点」算出下限，
    // 交给规划器当 keep，钓鱼/挖矿/炸矿不会把体力花到不够偷。
    // 以前是解禁那一刻才现场吃口粮：一个 POST 2.15 秒，等吃完货已经被抢光
    // （线上 11-13 13:21 就是这么丢了 3 处）。
    let snipeReserve = 0
    {
      const st = cfg.social?.steal
      if (st?.enabled && !cfg.dry && st.reserve !== false) {
        try {
          const res = snipeStaminaReservation(this.memo.stealSchedule || {}, w.now, {
            horizonSec: st.reserveHorizonSec ?? 900,
            regenSec: R.WORLD.regen || 180,
            energyMax: R.energyMax(s),
            maxEnergy: st.maxEnergy ?? 15,
          })
          snipeReserve = res.floor
          // 只在「目标换了」时记一次，避免每次巡视都刷同样一行。
          const key = snipeReserve > 0 ? `${res.targetId}@${res.unlockAt}` : ''
          if (key && this.memo.snipeReserveKey !== key) {
            this.memo.snipeReserveKey = key
            this.log(`偷菜：${Math.max(0, Math.round(res.unlockAt - w.now))} 秒后有目标解禁，规划时先留 ${snipeReserve} 点体力（需要 ${res.need}，自然回复补一部分）`)
          }
        } catch { /* 调度表异常不影响规划 */ }
      }
    }

    // ---------- 主规划 ----------
    let plan = { actions: [], summary: [] }
    let rounds = 0
    let totalEarn = 0, totalSpend = 0, totalTax = 0
    let totalActions = 0        // 本轮真正提交成功的动作数（判断「有没有推进」用）
    // 不走 world.act 的模块（偷菜/帮忙/擂台/五子棋/游乐馆/站宠护理）有自己的回执，
    // 上面那个计数抓不到。它们做成事同样算「本轮有推进」——否则会出现
    // 「刚偷到 6 处，却因为 totalActions=0 被判成空转、退避 300 秒、错过下一波解禁」
    // （线上 2026-11-14 15:09 就是这个表现）。
    let didWork = false
    // 本轮巡视已经投过资就不再评估新的投资。配合 planner 的 maxPerRound=1，
    // 保证一次巡视最多只买一项；是否继续投，等下次巡视重新看现金和规则。
    let investedThisTick = false

    // 偷菜窗口的硬截断：解禁前一秒都不该再排新的经济 POST。
    // 以前只有「窗口是否已经打开」的布尔值传给后台模块，主规划的 8 轮循环
    // 照样跑满——每轮 2.15 秒的提交间隔，8 轮就是 17 秒，正好把 15 秒的提前量
    // 全吃掉，等走到偷菜段时货已经被抢了。这里做两件事：
    //   1) 进来就有目标在窗口内 → 只跑 1 轮（把自家成熟作物先收掉），立刻去偷；
    //   2) 每提交完一批再看一眼 → 窗口在规划途中打开就停手。
    // 剩下的经济动作下一轮巡视继续（nextWake 会因为还有活而很快醒来）。
    const snipeLead = cfg.social?.steal?.enabled ? this.snipeLeadSec(w) : 8
    const snipeAtStart = Boolean(this.snipeDueNow(w, snipeLead))
    if (snipeAtStart) this.log('偷菜：解禁窗口已打开，本轮只跑 1 批农务就去抢')
    const maxRounds = snipeAtStart ? 1 : (cfg.loop?.maxRoundsPerTick || 8)
    while (rounds < maxRounds) {
      rounds++
      this.setStep(rounds === 1 ? '规划本轮动作' : `规划第 ${rounds} 批动作`)
      // 一次规划循环可能横跨几分钟（每批要串行提交、等 http 间隔）。
      // 用校准过的本地时钟把 now 推上来，别拿几分钟前的快照时间做决策。
      w.tickClock()
      // 把「上次被偷的时刻」交给规划器：它据此决定要不要续守家道具。
      // world 是每轮共享的对象，规划器往里写 stolenAt 也能被这里读回来。
      if (this.memo.stolenAt) w.stolenAt = this.memo.stolenAt
      plan = planRound(w, cfg, this.log.bind(this), { allowInvest: !investedThisTick, memo: this.memo, snipeReserve })
      if (!plan.actions.length) break
      if (cfg.dry) {
        this.log(`[演练] 本轮计划：${summarizeActions(R, plan.actions)}`)
        break
      }
      try {
        this.setStep('提交动作')
        const res = await w.act(plan.actions)
        totalEarn += res.earn || 0
        totalSpend += res.spend || 0
        totalTax += res.tax || 0
        totalActions += (res.out || []).filter((o) => o?.ok).length
        this.credit(res.earn || 0, res.spend || 0, res.tax || 0)   // 边赚边记，GUI 立刻能看到
        if (plan.summary.length) this.log(`第 ${rounds} 轮：${plan.summary.join('；')}`)
        if (plan.summary.some((x) => x.startsWith('投资：'))) investedThisTick = true
        if (!res.out?.some?.((o) => o?.ok)) break   // 全失败就别再转
        // 批与批之间再看一眼：窗口是在这一批提交期间打开的
        if (this.snipeDueNow(w, snipeLead)) {
          this.log('偷菜：解禁窗口在规划途中打开，停止本轮剩余规划')
          break
        }
      } catch (e) {
        // 409：小岛状态在别处变了（网页端手动操作、站内管家抢先提交、另一个标签页）。
        // 旧版 core.mjs 的做法是「用响应里的新快照重新规划，continue」；
        // 新版以前把它当普通错误，整轮巡视中断并退避 30 秒——一次冲突就白等半分钟，
        // 而冲突在开着站内管家时很常见。服务端 409 的响应体里带着最新世界快照。
        if (e?.name === 'ConflictError') {
          if (e.data && e.data.state) w.accept(e.data)
          this.log('小岛状态在别处变了，按最新状态重新规划')
          continue
        }
        // 中途有人开始手操游乐馆：世界级的写入门控会拦住后面的提交。
        // 这时直接结束本轮，别再让偷菜/五子棋/擂台接着发请求。
        if (e?.name === 'ManualArcadeError') {
          if (totalActions === 0) return this.standbyTick(w, e.manualArcade, cfg)
          this.log(e.message, 'warn')
          break
        }
        this.log('提交失败：' + e.message, 'err')
        break
      }
    }

    // ---------- 偷菜（掐点优先） ----------
    //
    // 偷菜的价值全在「解禁那一刻」：可偷筛选能看到的都是别人漏掉的，
    // 真正的好货几秒内就被抢走。而五子棋 10 局要一分钟、擂台 30 场要四分钟，
    // 等它们跑完再去偷，解禁早过了——线上 2026-11-12 全天记下 250 处待解禁、
    // 实际偷到 0 件。所以只在「确实有目标进入解禁窗口」时插队，
    // 平时仍按原顺序（下面那块）走，不改变日常节奏。
    let stealSnipeDone = false
    w.tickClock()
    const snipeNx = this.snipeDueNow(w, snipeLead)
    if (snipeNx) {
      try {
        this.setStep('串门 · 偷菜（掐点）')
        const r = await stealRound(w, cfg, this.log.bind(this), this.memo, { snipeNow: true })
        totalEarn += r.value || 0
        // value 是**库存**按市价折算（现金没动，cash:false）；
        // fine 是打输守家战真扣的 D（现金动了，要按支出记，否则账本少一笔）。
        this.credit(r.value || 0, 0, 0, { cash: false })
        if (r.fine > 0) { totalSpend += r.fine; this.credit(0, r.fine) }
        if ((r.stolen || 0) > 0) { noteSnipeResult(this.memo, r.stolen); didWork = true }
        else if (this.memo.stealWakePending && !r.staleWake) {
          const before = this.memo.stealWakeGap || 60
          noteSnipeResult(this.memo, 0)
          if (this.memo.stealWakeGap > before) {
            this.log(`偷菜：这一趟没抢到，下次因解禁唤醒的间隔放宽到 ${this.memo.stealWakeGap} 秒`)
          }
        }
        this.memo.stealWakePending = false
        stealSnipeDone = true
      } catch (e) { this.log('偷菜（掐点）出错：' + e.message, 'err') }
    }

    // ---------- 「此刻有货」优先 ----------
    //
    // 榜一 shouldBlockBackgroundWork 的另一半：只要现在有能偷的，后台模块
    // 全部让路。调度表只记「未来解禁」，看不到此刻已经可偷的岛
    // （那类行在 updateIsleSchedule 里被排除），所以用服务端的可偷筛选探一次——
    // 一条 GET，不访问任何岛。
    //
    // 不这么做的话，突然可偷的货要等五子棋（约 1 分钟）+ 擂台（约 4 分钟）
    // 跑完才轮到下面的偷菜，早被抢光了。
    // 探到就 forceScan 跳过 scanEvery 直接扫；扫完没偷到就把探测间隔翻倍，
    // 避免「全是低价值目标」时每轮都全量扫一遍目录。
    let stealNowDone = false
    if (cfg.social?.steal?.enabled && !cfg.dry && !stealSnipeDone) {
      const gap = Math.max(30, this.memo.stealProbeGap || 60)
      if (w.now - (this.memo.stealProbeAt || 0) >= gap) {
        this.memo.stealProbeAt = w.now
        let found = []
        try { found = await probeStealable(w, cfg) } catch { found = [] }
        if (found.length) {
          const names = found.slice(0, 3).map((x) => x.name || x.id).join('、')
          this.log(`偷菜：现在有 ${found.length} 家可偷（${names}${found.length > 3 ? ' 等' : ''}），先偷再跑后台任务`)
          this.setStep('串门 · 偷菜（此刻可偷）')
          try {
            const r = await stealRound(w, cfg, this.log.bind(this), this.memo, { forceScan: true })
            totalEarn += r.value || 0
            this.credit(r.value || 0, 0, 0, { cash: false })
            if (r.fine > 0) { totalSpend += r.fine; this.credit(0, r.fine) }
            if ((r.stolen || 0) > 0) this.memo.stealProbeGap = 60
            else this.memo.stealProbeGap = Math.min(900, gap * 2)
            stealNowDone = true
          } catch (e) { this.log('偷菜（此刻可偷）出错：' + e.message, 'err') }
        }
      }
    }

    // 掐点偷菜走的是 visit 接口：响应里的 state 是对方岛的、rev 也已作废。
    // 紧接着的五子棋要用自家 cnt.gomokuPaid 判断计奖额度，必须先把自家快照换回来，
    // 否则会拿邻居的计数去发 start，被服务端 409「小岛状态已变化」打回。
    if (w.revDirty) {
      try { await w.refresh() } catch (e) { this.log('偷菜后刷新状态失败：' + e.message) }
    }

    // ---------- 偷菜窗口：抢占后台任务 ----------
    // 榜一 shouldBlockBackgroundWork 的移植：有目标在 lead+4 秒内解禁（或刚解禁
    // 30 秒内）时，五子棋/擂台/帮忙/修仙全部让路。这些模块每个 POST 都占
    // 2.15 秒，插一个就可能把解禁那一刻的请求推到窗口外。
    let snipeWindow = null
    if (cfg.social?.steal?.enabled && !cfg.dry && cfg.social.steal.preempt !== false) {
      try {
        snipeWindow = snipeWindowOpen(this.memo.stealSchedule || {}, w.tickClock(), { leadSec: snipeLead })
        if (snipeWindow && this.memo.snipeWindowKey !== snipeWindow.at) {
          this.memo.snipeWindowKey = snipeWindow.at
          this.log(`偷菜：${Math.max(0, Math.round(snipeWindow.at - w.now))} 秒内解禁，这一轮先不跑五子棋/擂台/帮忙/修仙`)
        }
      } catch { snipeWindow = null }
    }

    // ---------- 52弟 ----------
    if (cfg.npc?.enabled && !cfg.dry && !snipeWindow) {
      try {
        if (cfg.npc.gomoku) {
          this.setStep('52弟 · 五子棋')
          const r = await playGomoku(w, cfg, this.log.bind(this))
          totalEarn += r.coins || 0
          this.credit(r.coins || 0)
          if (r.games > 0) { this.memo.gomokuStall = 0; didWork = true }
          else if (r.fails > 0) this.memo.gomokuStall = (this.memo.gomokuStall || 0) + 1
        }
        if (cfg.npc.rps || cfg.npc.card || cfg.npc.box) {
          this.setStep('52弟 · 小游戏')
          const r = await playOther(w, cfg, this.log.bind(this))
          totalEarn += r.coins || 0
          this.credit(r.coins || 0)
          if (r.games > 0) didWork = true
        }
      } catch (e) { this.log('52弟出错：' + e.message, 'err') }
    }

    // ---------- 站宠护理 ----------
    // 必须在擂台之前：站宠等级就是擂台等级，升级带来的面板成长和自由属性点
    // 要先在服务端生效，紧接着的换装/加点才算得对（参考实现的 syncPetCareFirst
    // 也是这个因果顺序）。不花 D 币和小岛体力，只刷每日经验。
    if (cfg.petCare?.enabled !== false && !cfg.dry && !snipeWindow) {
      try {
        this.setStep('站宠护理')
        const r = await petCareRound(w, cfg, this.log.bind(this), this.memo)
        if (r?.pet) this.status.pet = r.pet
        if (r?.saved > 0) didWork = true
      } catch (e) { this.log('站宠护理出错：' + e.message, 'err') }
    }

    // ---------- 擂台 ----------
    if (cfg.arena?.enabled && !cfg.dry && !snipeWindow) {
      try {
        this.setStep('擂台')
        const ar = await arenaDaily(w, cfg, this.log.bind(this), {
          // 擂台每场 8.5 秒，30 场要 4 分钟。逐场回报进度，GUI 才不会看着像卡死。
          onBattle: (n, need) => this.setStep(`擂台 · 第 ${n}/${need} 场`),
          memo: this.memo,
          // 一场 8.5 秒、一批 5 场 40 秒。偷菜解禁窗口在批次途中打开时，
          // 打完这批再走就晚了——每场开打前问一次，该让路就让路。
          shouldAbort: () => Boolean(this.snipeDueNow(w, snipeLead)),
        })
        if (ar?.battles > 0) didWork = true
        // 今日已打场次只在这里拿得到（要发 /battle/gear）。存进 memo，
        // nextWake 才能判断「擂台是不是也打完了」，进而决定要不要长睡。
        if (ar) {
          // 擂台养成花的 D 单独记账：/api/pet/battle/{train,buy,enhance} 不走
          // world.act，没有 earn/spend 回执，以前直接掉进 GUI 的「其他变动」。
          if (ar.spend > 0) {
            totalSpend += ar.spend
            this.credit(0, ar.spend)
          }
          this.memo.arenaDay = ar.day
          this.memo.arenaToday = ar.today ?? 0
          this.memo.arenaMax = ar.maxBattles ?? 30
          // 每日宝箱：每 3 场发一个，最多 5 个。earned 是「已挣到」，chest 是「已开」。
          this.memo.arenaChest = ar.chest ?? 0
          this.memo.arenaChestEarned = ar.chestEarned ?? 0
          this.memo.arenaChestMax = ar.chestMax ?? 5
          // 偷菜算守家战胜率要用（旧版每 10 分钟拉一次我的等级）
          if (ar.level) this.memo.arenaLevel = ar.level
        }
      } catch (e) { this.log('擂台出错：' + e.message, 'err') }
    }

    // ---------- 帮忙 ----------
    if (cfg.social?.help?.enabled && !cfg.dry && !snipeWindow) {
      try {
        this.setStep('串门 · 帮忙')
        const r = await helpDaily(w, cfg, this.log.bind(this), this.memo)
        totalEarn += r.coins || 0
        this.credit(r.coins || 0)
        // 没帮到人就累加 stall，连续几次后 nextWake 会退避，避免空转
        if (r.helped > 0) { this.memo.helpStall = 0; didWork = true }
        else if (this.memo.helpCount < (cfg.social.help.perDay ?? 10)) this.memo.helpStall = (this.memo.helpStall || 0) + 1
      } catch (e) { this.log('帮忙出错：' + e.message, 'err') }
    }

    // ---------- 修仙 ----------
    // 灵石不能换 D 币，所以这一步对现金收益零贡献；它只推进养成进度。
    // 放在帮忙之后、偷菜之前：修仙的短窗口（炼丹 19 秒出炉、抢双倍收获）
    // 靠 xianRound 内部的连批完成，不会拖住后面的掐点偷菜。
    if (cfg.xian?.enabled && !snipeWindow) {
      // 2.0 必须先跑。两者抢的是同一池灵力：斗法 10/场（每天 8 场）、秘境 15/次（每天 3 次），
      // 而 1.0 的药园是个只要还有灵力就会一直锄地/播种/浇水/收获的无底洞。
      // 顺序反过来的话，1.0 先把灵力吃到 0，2.0 每次规划都只能返回 idle——
      // 线上实测 en=0/100 时「同门斗法 0/8、秘境 0/3、试炼首通 0/4」挂了好几天。
      // 单位灵力收益也支持这个顺序：秘境 15 点换一次首通（培元丹×2、回灵丹×2，
      // 按卖价 300 灵石）外加路径掉落，而灵草一整茬（锄3+种1+浇1+收2=7 点）只卖约 15 灵石。
      if (cfg.xian2?.enabled !== false) {
        try {
          this.setStep('修仙 · 秘境')
          const x2 = await xian2Round(w, cfg, this.log.bind(this), this.memo)
          totalActions += x2.actions || 0
        } catch (e) { this.log('修仙2.0出错：' + e.message, 'err') }
      }
      // 1.0：药园/炼丹/打坐，用 2.0 剩下的灵力。
      try {
        this.setStep('修仙 · 药园')
        const xr = await xianRound(w, cfg, this.log.bind(this), this.memo)
        totalActions += xr.actions || 0
      } catch (e) { this.log('修仙出错：' + e.message, 'err') }
    }

    // ---------- 游乐馆 ----------
    // 不发 D 币，只争榜单，所以放在所有经济动作之后、偷菜之前；
    // 每局要等 MIN_PLAY（5/6/8 秒），单轮只玩 perTick 局，不拖住掐点偷菜。
    if (cfg.arcade?.enabled && !cfg.dry && !snipeWindow) {
      try {
        const left = this.arcadeLeft()
        if (left > 0) {
          this.setStep('游乐馆')
          const ar = await arcadeRound(w, cfg, this.log.bind(this), this.memo)
          if (ar.played > 0) { this.memo.arcadeStall = 0; didWork = true }
          else this.memo.arcadeStall = (this.memo.arcadeStall || 0) + 1
        }
      } catch (e) { this.log('游乐馆出错：' + e.message, 'err') }
    }

    // ---------- 偷菜 ----------
    // 掐点那一块已经跑过就跳过：否则会紧接着再全量扫一遍目录，白花几十秒。
    if (cfg.social?.steal?.enabled && !cfg.dry && !stealSnipeDone && !stealNowDone) {
      try {
        this.setStep('串门 · 偷菜')
        const r = await stealRound(w, cfg, this.log.bind(this), this.memo)
        totalEarn += r.value || 0
        this.credit(r.value || 0, 0, 0, { cash: false })
        if (r.fine > 0) { totalSpend += r.fine; this.credit(0, r.fine) }
        // 记录这次「因解禁而醒」的结果，喂给自适应节流：
        // 偷到了就恢复 60 秒的敏锐节奏，白醒一趟就放宽一倍（封顶 15 分钟）。
        if ((r.stolen || 0) > 0) {
          noteSnipeResult(this.memo, r.stolen)
          didWork = true
        } else if (this.memo.stealWakePending && !r.staleWake) {
          const before = this.memo.stealWakeGap || 60
          noteSnipeResult(this.memo, 0)
          if (this.memo.stealWakeGap > before) {
            this.log(`偷菜：这一趟没抢到，下次因解禁唤醒的间隔放宽到 ${this.memo.stealWakeGap} 秒`)
          }
        }
        this.memo.stealWakePending = false
      } catch (e) { this.log('偷菜出错：' + e.message, 'err') }
    }

    // ---------- 收尾 ----------
    if (totalEarn || totalSpend) {
      this.log(`本轮收支：+${fmt(totalEarn)} / −${fmt(totalSpend)}（税 ${fmt(totalTax)}）`)
    }
    // 规划器在被偷记录/防偷道具里会写 world.stolenAt，收回 memo 才能跨轮、跨重启生效
    if (w.stolenAt && w.stolenAt !== this.memo.stolenAt) this.memo.stolenAt = w.stolenAt
    // 无论这轮有没有收支都要落盘：帮忙/偷菜的进度（helpCount、stealSchedule）
    // 是「无收支」的，只在 credit() 里存会永远丢失。
    this.savePersist()
    // 本次巡视小结：D币 + 库存 的变化（库存也要算，否则卖货那天会看着像亏了）
    try {
      await w.refresh()
      const dCoins = w.coins - startCoins
      const dStock = w.stockValue() - startStock
      const dAll = dCoins + dStock
      if (dCoins || dStock) {
        this.log(`本次巡视：D币 ${fmt(startCoins)} → ${fmt(w.coins)}（${dCoins >= 0 ? '+' : ''}${fmt(dCoins)}）` +
          `｜库存 ${fmt(startStock)} → ${fmt(w.stockValue())}（${dStock >= 0 ? '+' : ''}${fmt(dStock)}）` +
          `｜合计 ${dAll >= 0 ? '+' : ''}${fmt(dAll)}`)
      }
    } catch {}
    this.snapshot()

    // ---------- 下次唤醒 ----------
    this.setStep('计算下次巡视时间')
    let sleep = cfg.dry ? (cfg.loop?.maxSleep || 120) : nextWake(w, cfg, this.memo)
    // 修仙的短窗口（丹炉 19 秒后出炉、作物长一阶、灵力回够起炉）比主岛任何
    // 事件都密，nextWake 不知道它们。这里把 memo 里的时刻并进来。
    //
    // 阈值 10 秒是防自旋：planXianActions 在「现在有活」时会返回 t+3，
    // 但真有活时 xianRound 内部的连批已经做过了；剩下还返回 t+3 只可能是
    // 服务端一直拒（规则过期/灵力不够），再 3 秒醒一次就是空转。
    if (cfg.xian?.enabled && !cfg.dry) {
      const at = Number(this.memo.xianWakeAt) || 0
      const wait = at > 0 ? at - w.tickClock() : Infinity
      if (wait >= 10 && wait < sleep) sleep = wait
      // 修仙 2.0 自己的窗口（机缘冷却 600 秒、秘境进行中、委托刷新）
      if (cfg.xian2?.enabled !== false) {
        const at2 = Number(this.memo.xian2WakeAt) || 0
        const wait2 = at2 > 0 ? at2 - w.tickClock() : Infinity
        if (wait2 >= 10 && wait2 < sleep) sleep = wait2
      }
    }
    // 游乐馆：还有次数就按 wake.arcade 回来；连续几轮一局都开不起来就退避，
    // 避免「看起来有次数、其实每次都失败」变成每 60 秒一次的空转。
    if (cfg.arcade?.enabled && !cfg.dry) {
      const left = this.arcadeLeft()
      if (left > 0) {
        const stall = this.memo.arcadeStall || 0
        const want = stall >= 3 ? Math.max(cfg.loop?.stuckCool ?? 300, 300) : (cfg.wake?.arcade ?? 60)
        if (sleep > want) sleep = want
      }
    }
    // 保险：nextWake 说「立刻有事」（<10 秒）但这一轮一个动作都没做成，
    // 说明「看起来有活其实干不了」（体力/材料/现金卡住）。
    // 这时必须退避，否则就是每几秒醒一次的刷屏循环——
    // 之前体力 0 收不了地那次就是这种表现。
    if (!cfg.dry && sleep < 10 && totalActions === 0 && !didWork) {
      const cool = cfg.loop?.stuckCool ?? 300
      this.log(`本轮没有做成任何动作但唤醒间隔只有 ${sleep} 秒，退避到 ${cool} 秒`, 'warn')
      sleep = cool
    }
    // 把「为什么睡这么久」讲清楚。以前只有一行「岛日…体力…」，
    // 完全看不出下一轮打算做什么、什么在等、为什么不做钓鱼/偷菜/帮忙。
    // 这段每天只多几十行，但能省掉大量「看起来在空转」的误会。
    if (!cfg.dry) {
      try { this.log(this.describeNext(sleep)) } catch {}
    }
    this.status = {
      state: 'waiting',
      step: '',
      round: (this.status.round || 0) + 1,
      nextAt: Date.now() + sleep * 1000,
      sleep,
      lastError: '',
      lastRun: Date.now(),
    }
    this.busy = false
    return { sleep, plan }
  }

  /**
   * 「下次安排」：把这一轮到下一轮之间在等什么、为什么这么等讲清楚。
   *
   * 起因：日志里只有「岛日…体力…库存」和「每点体力收益」两行，
   * 看不出偷菜/帮忙/五子棋/擂台到底跑没跑、为什么没跑。
   * 线上排查时就吃过这个亏——帮忙停在 5/10 家、连续 29 次静默跳过，
   * 日志里一个字都没有，只能翻代码才知道是体力没到 minEnergy。
   */
  describeNext(sleep) {
    const w = this.world
    if (!w?.ready) return '下次巡视：' + Math.round(sleep) + ' 秒后'
    const R = w.R
    const s = w.state
    const t = w.now
    const cfg = this.cfg
    const bits = []

    // 1) 农场：熟了几块、多久后要熟
    let ripe = 0, nextRipeSec = Infinity
    for (let i = 0; i < s.plotN; i++) {
      const p = s.plots[i]
      if (!p) continue
      const st = R.cropStage(p, t, R.sprinkled(s, i) || R.weatherOf(R.isleDay(t)) === 1)
      if (st.stage === 3) ripe++
      else if (st.stage >= 0) nextRipeSec = Math.min(nextRipeSec, st.left)
    }
    const empty = (s.plots || []).filter((p) => !p).length
    if (ripe) bits.push(`${ripe} 块待收`)
    if (empty) bits.push(`${empty} 块空地`)
    if (nextRipeSec < Infinity) bits.push(`${Math.round(nextRipeSec)} 秒后熟一块`)

    // 2) 各类日常额度：谁还没做完、卡在哪
    const q = (k) => Math.max(0, (R.WORLD?.daily?.[k] || 0) - ((s.iq?.d === R.isleIndex(t) ? s.iq?.[k] : 0) || 0))
    const work = []
    if (cfg.work?.fish && q('fish') > 0) work.push(`钓鱼剩 ${q('fish')}`)
    if (cfg.work?.mine && q('mine') > 0) work.push(`挖矿剩 ${q('mine')}`)
    if (cfg.work?.bomb && q('bomb') > 0) work.push(`炸矿剩 ${q('bomb')}`)
    if (work.length) bits.push(work.join('/') + `｜体力 ${Math.floor(s.en)}`)

    // 3) 帮忙
    if (cfg.social?.help?.enabled) {
      const done = this.memo.helpDay === R.worldDay(t) ? (this.memo.helpCount || 0) : 0
      const per = cfg.social.help.perDay ?? 10
      const needE = cfg.social.help.minEnergy ?? 5
      // 帮忙的 D 币有日上限（实测四家就够 4,000）。到顶后再跑只扣体力不给钱，
      // 但 helpCount 永远到不了 perDay，以前会一直显示「4/10 待做」，
      // 看起来像欠了六家没帮。按上限状态说清楚。
      const capGot = Number(s.cnt?.helpCoin) || 0
      if (capGot >= 4000) bits.push(`帮忙 ${done}/${per}（D 币已到日上限 4,000）`)
      else if (done < per) {
        bits.push(s.en >= needE
          ? `帮忙 ${done}/${per} 待做`
          : `帮忙 ${done}/${per}（等体力 ${needE}）`)
      } else bits.push(`帮忙 ${done}/${per} 已完成`)
    }

    // 4) 偷菜
    if (cfg.social?.steal?.enabled) {
      const every = cfg.social.steal.scanEvery ?? 1800
      const left = Math.max(0, every - (t - (this.memo.stealScanAt || 0)))
      const sched = this.memo.stealSchedule || {}
      const ups = Object.values(sched).flatMap((r) => r.upcoming || []).filter((u) => u.unlockAt > t)
      if (ups.length) {
        const nx = Math.min(...ups.map((u) => u.unlockAt))
        bits.push(`偷菜 ${ups.length} 处等解禁（最近 ${Math.round(nx - t)} 秒）`)
      } else if (left > 0) {
        bits.push(`偷菜 ${Math.round(left)} 秒后重扫`)
      }
    }

    // 5) 五子棋 / 擂台：说清楚是「今日已满」还是「还能打」
    if (cfg.npc?.enabled && cfg.npc?.gomoku) {
      const paid = s.cnt?.gomokuPaid || 0
      const paidLeft = Math.max(0, (R.GOMOKU_PAID || 0) - paid)
      bits.push(paidLeft > 0 ? `五子棋剩 ${paidLeft} 局` : `五子棋已满 ${paid}`)
    }
    if (cfg.arena?.enabled) {
      const today = this.memo.arenaDay === R.worldDay(t) ? (this.memo.arenaToday || 0) : 0
      const maxB = this.memo.arenaMax || cfg.arena.battles || 30
      // 服务端的 daily.battles 还会把守家/被打这类对战算进去，可能超过上限
      // （线上显示过「擂台已满 39/30」）。额度只看前 maxB 场，显示也别超。
      const shown = Math.min(today, maxB)
      bits.push(today >= maxB ? `擂台已满 ${shown}/${maxB}` : `擂台 ${shown}/${maxB}`)
    }

    // 6) 为什么现在不做体力活
    const why = []
    if (s.en < 4) why.push(`体力 ${Math.floor(s.en)} 太低`)
    if (!cfg.work?.fish) why.push('钓鱼关着')
    if (why.length && !work.length) bits.push(`无事可做：${why.join('、')}`)

    return `下次巡视 ${Math.round(sleep)} 秒后｜` + (bits.length ? bits.join('｜') : '没有待办')
  }

  /** 每轮记一行资产到 ledger.csv（每小时最多一次） */
  snapshot(force = false) {
    const w = this.world
    const last = this.history[this.history.length - 1]
    if (!force && last && Date.now() - last.t < 3600_000) return
    const s = w.state
    const row = {
      t: Date.now(),
      time: bj(),
      coins: w.coins,
      stock: w.stockValue(),
      energy: s.en,
      plots: s.plotN,
      animals: s.barn.length,
      ...s.tools,
    }
    this.history.push(row)
    if (this.history.length > 2000) this.history.shift()
    try {
      const file = resolve(this.logDir, 'ledger.csv')
      if (!existsSync(file)) writeFileSync(file, 'time,coins,stock_value,energy,plots,animals,rod,pick,spr,house\n', 'utf8')
      appendFileSync(file, `${row.time},${Math.round(row.coins)},${Math.round(row.stock)},${Math.round(row.energy)},${row.plots},${row.animals},${row.rod},${row.pick},${row.spr},${row.house}\n`, 'utf8')
    } catch {}
  }

  /** 持续运行 */
  async run() {
    this.running = true
    this.halted = false
    let failures = 0
    this.log(`托管启动${this.cfg.dry ? '（演练模式，不提交）' : ''}`)
    while (this.running && !this.halted) {
      try {
        if (!this.cfg.enabled) {
          this.status = { ...this.status, state: 'paused', step: '' }
          await new Promise((r) => setTimeout(r, 3000))
          continue
        }
        const { sleep } = await this.tick()
        failures = 0
        await this.idleWait(sleep)
      } catch (e) {
        this.busy = false
        // 失败退避（旧版 page.mjs 的做法）：连续失败越久等越久，
        // 登录失效直接等 5 分钟——每 15 秒无意义重试只会刷屏。
        const auth = e?.name === 'AuthError' || /登录|401/.test(e?.message || '')
        failures++
        const wait = auth ? 300 : Math.min(600, 30 * failures)
        this.status = { ...this.status, state: auth ? 'auth' : 'error', lastError: e.message }
        this.log(`巡视出错（第 ${failures} 次，${wait} 秒后重试）：${e.message}`, 'err')
        await new Promise((r) => setTimeout(r, wait * 1000))
      }
    }
    this.status = { ...this.status, state: 'stopped', step: '' }
    this.log('托管已停止')
  }

  /**
   * 巡视之间的等待。
   *
   * 不是死等——每 20 秒轻量拉一次世界状态（只读，不提交），
   * 发现「作物提前成熟 / 动物产出 / 蟹笼有货 / 有人偷了东西」就提前醒来。
   * 突发情况（被人偷、地里有小偷记录）也会立刻处理。
   *
   * 轮询开销：一次 GET /api/pet/world，20 秒一次，不会触发写限流。
   */
  async idleWait(sleepSec) {
    const until = Date.now() + sleepSec * 1000
    // 巡检间隔跟随等待时长：
    //   等 60~120 秒时，本来马上就要醒，再 20 秒一轮纯属浪费请求；
    //   等 900 秒的退避时，20 秒一轮才值得（尽早发现突发）；
    //   等 1800 秒（额度全刷完后的空闲）时，5 分钟一轮就够了——
    //   这段时间里没有本地事件会变，巡检只是为了盯「被偷」这类外部突发。
    // 规则：间隔 = 等待时长的 1/10，夹在 [20, 300] 秒之间。
    const base = this.cfg.loop?.watchInterval ?? 20
    const interval = Math.max(base, Math.min(300, Math.round(sleepSec / 10))) * 1000
    // 从「现在」开始计，不要从 0 开始。
    //
    // 从 0 开始等于进等待时立刻巡检一次，而此刻世界状态刚刚在后端 refresh 过
    // （tick 收尾那次），这次巡检纯属重复请求。更要命的是它会破了退避：
    // 线上 2026-11-12 14:07 的日志里，退避到 300 秒后 3 秒就「提前醒来：偷菜解禁」——
    // 就是这一下立刻巡检造成的，接着又扫一遍、又什么都没有、再退避，每 3~5 秒一轮。
    let lastCheck = Date.now()
    while (this.running && Date.now() < until) {
      const step = Math.min(2000, until - Date.now())
      await new Promise((r) => setTimeout(r, step))
      if (!this.cfg.enabled) return
      if (this.wakeNow) { this.wakeNow = false; this.log('手动唤醒，提前巡视'); return }
      if (Date.now() - lastCheck < interval) continue
      lastCheck = Date.now()
      const reason = await this.watchOnce()
      if (reason) { this.log('提前醒来：' + reason); return }
    }
  }

  /**
   * 轻量巡检：只读世界状态，判断有没有值得立刻巡视的变化。
   * 返回醒来原因（字符串），没变化返回 ''。
   */
  async watchOnce() {
    const w = this.world
    if (!w?.ready) return ''
    const R = w.R
    try { await w.refresh() } catch { return '' }        // 网络抖动就当这次没查到

    const s = w.state
    const t = w.now
    const weather = R.weatherOf(R.isleDay(t))
    const prev = this.watchSnap || {}

    // 1. 作物成熟了 —— 且我们**真的收得动**才醒
    //
    // 以前只要看到 stage=3 就报「N 块地成熟了」，不管体力够不够。
    // 体力 0 时每轮巡检都报一次、醒一次、又收不了，整夜空转
    // （截图里 3 秒一条「提前醒来：2 块地成熟了」就是这么来的）。
    // 体力不够时不算「有事可做」——等体力自然回复或主循环吃口粮，
    // 那时才值得醒。
    let ripe = 0
    for (let i = 0; i < s.plotN; i++) {
      const p = s.plots[i]
      if (!p) continue
      const st = R.cropStage(p, t, R.sprinkled(s, i) || weather === 1)
      if (st.stage === 3) ripe++
    }
    if (ripe > 0) {
      const canHarvest = s.en >= (R.WORLD.cost.harvest || 1)
      // 体力不够时看看能不能吃口粮补上（主循环里有 ensureEnergy 会做这件事）
      let canEat = false
      if (!canHarvest) {
        try { canEat = foodChoices(R, s, w.prices).length > 0 && this.cfg.energy?.eat !== false } catch {}
      }
      if (canHarvest || canEat) return `${ripe} 块地成熟了`
      // 两者都不行：醒着也收不了，不算「有事可做」，继续睡
    }

    // 2. 动物能收了 / 饿了
    let animal = 0
    for (const pen of s.barn) {
      const st = R.animalReady(pen, t)
      if (st.ready) animal++
      else if (!st.retired && t - pen.f >= ANIMAL_FEED_SEC) animal++
    }
    if (animal > 0) return `${animal} 个畜栏要处理`

    // 3. 蟹笼有货
    let trap = 0
    for (const tr of s.traps) if (R.trapReady(tr, t, weather === 2).n) trap++
    if (trap > 0) return `${trap} 个蟹笼有货`

    // 4. 有人来偷了（地块上出现小偷记录）—— 突发，优先级最高
    const stolen = (s.plots || []).filter((p) => p?.sv?.length).length
    if (stolen > (prev.stolen || 0)) {
      this.watchSnap = { stolen, coins: w.coins }
      return `发现 ${stolen} 块地有小偷记录`
    }
    this.watchSnap = { stolen, coins: w.coins }

    // 5. 偷菜解禁时刻到了（精确调度，比「到点扫一遍」准得多）
    //
    // 体力门槛不能写成「en >= 5 才算有事可做」：体力被钓鱼/挖矿花光是常态，
    // 而偷菜是掐着解禁时刻的机会——只要有口粮能补上来就值得醒。
    // 补体力本身就是主循环里会发生的事（social.stealRound 会现场吃口粮）。
    //
    // 光有体力门槛还不够：巡逻 53 座岛会记下 380 条解禁时刻，
    // 平均每 20 秒就有一条到点，于是变成每 30~60 秒醒一次、
    // 每次都是「扫了 8 座岛，找到 0 家可偷」。真正的问题不是醒得不勤，
    // 而是这种「成熟 + 保护期」的目标到点时早就被别人偷满了。
    //
    // shouldSnipe 带自适应节流：偷到过就 60 秒一次，连续白醒就翻倍到 15 分钟。
    if (this.cfg.social?.steal?.enabled) {
      const stealE = 5
      const canSteal = w.state.en >= stealE || !!energyActions(R, w.state, w.prices, {
        need: stealE, maxPerE: this.cfg.social.steal.maxEnergyCost ?? 600, cfg: this.cfg, coins: w.coins,
      })
      if (canSteal) {
        // 提前量按这一波的岛数算：醒来后要串行访问每家 ~1.5 秒，
        // 固定 8 秒在 4~5 家同波时根本访问不完。
        const leadSec = this.snipeLeadSec(w, t)
        const nx = shouldSnipe(this.memo, this.memo.stealSchedule || {}, t, { leadSec })
        if (nx) {
          this.memo.stealWakeAt = t
          this.memo.stealWakePending = true
          return `偷菜解禁：${nx.item || '目标'}（${nx.exact ? '时刻确定' : '估计'}）`
        }
      }
    }

    // 6. D币突然大幅变化（被罚 / 别人互动 / 结算）
    const dCoins = w.coins - (prev.coins || w.coins)
    if (prev.coins && Math.abs(dCoins) > 100000) {
      return `D币突变 ${dCoins > 0 ? '+' : ''}${Math.round(dCoins).toLocaleString('en-US')}`
    }

    return ''
  }

  /**
   * 掐点唤醒的提前量。唤醒时刻（watchOnce / planner.nextWake）和
   * shouldSnipe 必须用同一个值，否则引擎以为该醒了、窗口判定却说不算。
   * 换装和补体力都是 POST，必须算进去（见 steal-schedule.physicalPrepLeadSec）。
   */
  /**
   * 现在就该去抢的解禁目标（tick 内的判定）。
   *
   * 和 shouldSnipe 的区别是**不带白醒节流**：节流只用于「要不要为偷菜再醒一次」，
   * 醒着的时候窗口打开就该抢。但「刚试过、什么都没偷到」的退避仍然生效——
   * 除非这一趟本来就是为它醒的（stealWakePending），否则不重复空抢。
   *
   * @returns {object|null} nextUnlock 的结果
   */
  snipeDueNow(w, leadSec) {
    if (!this.cfg.social?.steal?.enabled || this.cfg.dry) return null
    const t = w.tickClock()
    let nx = null
    try { nx = snipeDue(this.memo.stealSchedule || {}, t, { leadSec }) } catch { return null }
    if (!nx) return null
    const gap = Math.max(SNIPE_MIN_GAP_SEC, this.memo.stealWakeGap || SNIPE_MIN_GAP_SEC)
    if (!this.memo.stealWakePending && t - (this.memo.stealWakeAt || 0) < gap) return null
    return nx
  }

  snipeLeadSec(w, now = w.tickClock()) {
    const cfg = this.cfg
    const st = cfg.social?.steal || {}
    const client = w.client || {}
    return physicalPrepLeadSec({
      schedule: this.memo.stealSchedule || {},
      now,
      gearSwaps: stealGearSwaps(cfg),
      needPrepAct: w.state.en < Math.min(st.maxEnergy ?? 15, 15),
      remainingPostCdMs: client.getRemainingPostCooldownMs?.() || 0,
      minGapSec: cfg.minGap ?? 2.15,
      rttMs: client.lastRttMs || 600,
      fixedLeadSec: st.prepLeadSec || 0,
    })
  }

  /** 让主循环立刻醒来巡视（GUI 用） */
  requestTick() { this.wakeNow = true }

  stop() { this.running = false }

  /** 给 GUI 的状态快照 */
  statusSnapshot() {
    const w = this.world
    const R = w.R
    const s = w.state
    const stockNow = w.ready ? w.stockValue() : 0
    // 世界状态还没就绪时不要算净增——否则库存读成 0，dayNet 会瞬间变成一个大负数
    const dayNet = (w.ready && stockNow > 0)
      ? (w.coins - this.ledger.startCoins) + (stockNow - this.ledger.startStock)
      : (w.ready ? w.coins - this.ledger.startCoins : 0)
    return {
      state: this.status.state,
      step: this.status.step || '',
      // 游乐馆手操让位：GUI 显示「玩家在玩，托管暂停」，避免误以为程序卡死
      arcadeStandby: this.status.arcadeStandby || null,
      running: this.running,
      dry: this.cfg.dry,
      round: this.status.round || 0,
      nextAt: this.status.nextAt || 0,
      sleep: this.status.sleep || 0,
      lastError: this.status.lastError || '',
      lastRun: this.status.lastRun || 0,
      // 站宠：最近一次护理后的等级/经验/三围（GUI 可展示等级进度）
      pet: this.status.pet || null,
      world: w.ready ? {
        now: w.now,
        isleDay: w.isleDay,
        isleNo: R.isleDayNo(w.now),
        season: R.SEASONS[w.season],
        weather: R.WEATHERS[w.weather],
        hour: R.isleHour(w.now),
        longNight: R.b12IsLongNight(w.now),
        nextIsleAt: R.b12NextIsleBoundary(w.now),
        coins: w.coins,
        stock: stockNow,
        energy: s.en,
        energyMax: R.energyMax(s),
        plots: s.plotN,
        barn: s.barn.length,
        barnN: s.barnN,
        traps: s.traps.length,
        tools: { ...s.tools },
        mineMax: s.mine.max,
        // 防偷状态：最近一次被偷是多久前、下一块地什么时候熟。
        // 快熟时人得盯着（成熟后 30 分钟内不收就会被偷），GUI 靠这两个字段提示。
        stolenAgo: w.stolenAt || this.memo?.stolenAt ? Math.max(0, w.now - (w.stolenAt || this.memo.stolenAt)) : -1,
        nextRipeAt: nextRipe(R, w, this.cfg),
        quotas: {
          fish: { used: quotaUsed(R, s, w, 'fish'), max: R.WORLD.daily.fish },
          mine: { used: quotaUsed(R, s, w, 'mine'), max: R.WORLD.daily.mine },
          craft: { used: quotaUsed(R, s, w, 'craft'), max: R.WORLD.daily.craft },
          bomb: { used: quotaUsed(R, s, w, 'bomb'), max: R.WORLD.daily.bomb },
          coffee: { used: s.cnt?.coffee || 0, max: R.WORLD.daily.coffee },
          npc: { used: s.cnt?.npc || 0, max: R.NPC.daily },
          gomokuPaid: { used: s.cnt?.gomokuPaid || 0, max: R.GOMOKU_PAID },
          // 擂台每日宝箱：已开 / 已挣到（每 3 场发一个，最多 5 个）。
          // 和别的额度不同，这里是「已开/可开」，进度条满 = 今天的箱子都开完了。
          arenaChest: { used: this.memo?.arenaChest || 0, max: Math.max(this.memo?.arenaChest || 0, this.memo?.arenaChestEarned || 0) },
        },
      } : null,
      ledger: {
        ...this.ledger,
        stockNow,
        dayNet,
        resumedFrom: this.ledger.resumedFrom || '',
      },
      stats: this.stats,
      history: this.history.slice(-240),
      // 修仙面板的数据。灵石不能换 D 币，界面上必须写清楚（见 GUI）。
      xian: this.xianView(),
      xian2: this.xian2View(),
      arcade: this.arcadeView(),
      vault: this.vaultView(),
      tax: this.taxView(),
      // 站点规则：当前版本 / 内容 hash / 最近一次检查结果。
      // GUI 显示它才看得出「站点悄悄改了公式」和「版本检查一直失败」——
      // 这两种情况都不会报错，只会让托管悄悄用错规则。
      rules: {
        ver: rulesVersion(),
        hash: rulesContentHash(),
        checkedAt: this.memo.rulesStatus?.at || 0,
        contentCheckedAt: this.memo.rulesStatus?.contentCheckedAt || 0,
        ok: this.memo.rulesStatus?.ok !== false,
        fail: this.memo.rulesStatus?.fail || 0,
      },
    }
  }

  /**
   * 税务快照：余额税是「持有现金的日成本」——每天 08:00 按那一刻钱包余额扣，
   * 300 万以内免、300 万~1000 万 0.1%、超出 1000 万的部分 0.3%（不扣穿 300 万）。
   * 账号 2600 万现金时日成本约 5.6 万 D，比大多数投资的日收益都高。
   */
  taxView() {
    const w = this.world
    if (!w.ready) return null
    const R = w.R
    let next = 0
    try { next = Number(R.b12BalanceTax?.(w.coins)) || 0 } catch { next = 0 }
    const today = this.memo?.srvTax?.day === R.worldDay(w.now)
    return {
      free: R.B12_TAX?.free ?? 3000000,
      high: R.B12_TAX?.high ?? 10000000,
      saleToday: this.ledger.tax || 0,
      balancePaidToday: today ? Number(this.memo.srvTax.balanceTax) || 0 : 0,
      balanceNext: next,
      paidAt: today ? Number(this.memo.srvTax.at) || 0 : 0,
    }
  }

  /** 囤货仓库（b26）快照：等级、已用/总格数、单格上限、下一级价格 */
  vaultView() {
    const w = this.world
    if (!w.ready) return null
    try {
      const s = vaultSummary(w.R, w)
      const cap = vaultCapacity(w.R, w.state)
      return { lv: s.lv, used: s.used, slots: s.slots, unit: s.unit, nextCost: s.lv < 4 ? cap.nextCost : 0, totalValue: s.totalValue }
    } catch (e) { return { error: e.message } }
  }

  /** 修仙快照（GUI 用；世界状态没就绪时返回 null） */
  xianView() {
    const w = this.world
    if (!w.ready) return null
    try { return xianSnapshot(w, this.cfg) } catch (e) { return { exists: false, error: e.message } }
  }

  /** 修仙 2.0 快照（人脉/机缘/宗门/秘境） */
  xian2View() {
    const w = this.world
    if (!w.ready) return null
    try { return xian2Snapshot(w) } catch (e) { return { error: e.message } }
  }

  /** 游乐馆快照（各游戏今日剩余、个人纪录） */
  arcadeView() {
    const w = this.world
    if (!w.ready) return null
    try { return arcadeSummary(w) } catch (e) { return { error: e.message } }
  }

  /** 市场预测（给 GUI 的市场面板） */
  marketSnapshot(opts = {}) {
    const w = this.world
    if (!w.ready) return null
    const R = w.R
    const plan = M.sellPlan(R, w.now, { coins: w.coins, state: w.state, prices: w.prices }, {
      days: opts.days ?? this.cfg.sell?.horizonDays ?? 12,
      markdownPct: opts.markdownPct ?? this.cfg.sell?.markdownPct ?? 6,
      external: w.externalSoldRatio || {},
    })
    return {
      supply: {
        day: plan.supply.day,
        items: Object.fromEntries(Object.entries(plan.supply.rows).map(([id, r]) => [id, {
          supply: r.supply, price: r.price, quote: r.quote,
          clamped: r.clampedLow || r.clampedHigh,
          soldRatio: r.soldSolid,
        }])),
      },
      forecast: plan.forecast.map((f) => ({
        at: f.at, day: f.day, season: R.SEASONS[f.season], weather: R.WEATHERS[f.weather],
        events: f.events,
        prices: f.price, low: f.low, high: f.high,
      })),
      rows: plan.rows,
    }
  }
}

function quotaUsed(R, s, w, key) {
  const iq = s.iq
  return (iq && iq.d === R.isleIndex(w.now)) ? (iq[key] || 0) : 0
}

function summarizeActions(R, actions) {
  const c = {}
  for (const a of actions) c[a.a] = (c[a.a] || 0) + 1
  return Object.entries(c).map(([k, n]) => `${k}×${n}`).join(' ')
}
