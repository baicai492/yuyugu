// 串门：帮忙（稳定小收益）与偷菜（高风险高收益）。
//
// 帮忙：每天 10 家，每家 1 次，每次 1 体力，得 200 D + 2 经验，D币日上限 4000。
// 偷菜：每次 5 体力起（每多一处 +1，上限 15），被发现则打一场守家战，
//       输了按市价 1.2 倍赔（单次上限 5000，每日 20000）。
import { randomUUID } from 'node:crypto'
import {
  updateIsleSchedule, stealEV, nextUnlock, nextWave, advanceIsleWave,
  physicalPrepLeadSec, stealGearSwaps,
  WAKE_GRACE_SEC, SNIPE_MIN_GAP_SEC,
} from './steal-schedule.mjs'
import { energyActions } from './planner.mjs'
import {
  computeGuardPosteriorForTarget, executeWithTacticalLoadout, recordBattleSnapshot,
  fetchGear, loadObservedPanels, defaultProfileStorePath, defaultLockRoot,
  noteBattleOutcome, syncGuardLogProfiles, battleOutcomeOf,
} from './battle.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 下一个北京时间 0 点（服务端按自然日重置每日上限）。
 * now 是服务端秒；返回同一个时间轴上的秒。
 */
export function nextCstDayStart(nowSec) {
  const t = Math.floor(Number(nowSec) || 0)
  return Math.floor((t + 8 * 3600) / 86400) * 86400 + 86400 - 8 * 3600
}

/**
 * 偷菜被拒绝时怎么处理（参考 recordSnipeReceipt 的 rejected 分支）。
 *
 *   daily-cap       服务端按自然日封顶（「上限 / 今天偷过 / 新手」）：
 *                   封到次日 0 点，这家今天不用再排；
 *   boundary-retry  409 恰好卡在推算解禁时刻 ±2 秒：时钟截断抖动，不是真失败，
 *                   1 秒后再试一次（每家只重试一次）；
 *   cooldown        其余拒绝（最常见是「没有能偷的」= 被别人抢先/刚被收）：
 *                   90 秒内不再碰这家。
 *
 * @returns {{kind:string, until?:number, retryAt?:number}}
 */
export function classifyStealReject({ status = 0, message = '', clock = 0, expectedAt = 0, earlyRetry = false } = {}) {
  // 文案比参考实现多收了「已经偷过 TA 家」这种更常见的表述；
  // 不收裸「偷过」，免得把「这茬已经被偷过 2 个」这类 stolen 计数误判成每日封顶
  // ——那会把整座岛封到明天，代价远大于措辞上的宽容。
  if (/上限|新手|今天偷过|已经偷过 TA 家/.test(String(message))) {
    return { kind: 'daily-cap', until: nextCstDayStart(clock) }
  }
  if (Number(status) === 409 && Number(expectedAt) > 0 &&
      Math.abs(clock - expectedAt) <= 2 && !earlyRetry) {
    return { kind: 'boundary-retry', retryAt: Math.max(clock + 1, Number(expectedAt) + 1) }
  }
  return { kind: 'cooldown', until: clock + 90 }
}

async function wget(world, path) {
  return world.client.get('/api/pet/world/' + path)
}
async function wpost(world, path, body) {
  // 手动游乐馆让位：串门/帮忙也是写请求，同样会让玩家的 arcEnd 因 rev 过期 409。
  // 主循环开头已经整轮停写，这里兜住「巡视途中玩家开始玩」的情况。
  const ma = world.manualArcade?.(world.now)
  if (ma?.active && !world.ourArcadeHeld?.()) {
    const err = new Error(`游乐馆手操中（${ma.game}，剩 ${ma.remainingSec} 秒），跳过串门`)
    err.name = 'ManualArcadeError'
    err.manualArcade = ma
    throw err
  }
  return world.client.post('/api/pet/world/' + path, body)
}

/**
 * 偷菜守家线的「按岛状态」。
 *
 * 以前是 stealLoseAt / stealBlockAt 两个平行的 map：前者记打输时刻、后者记
 * 负期望封禁时刻，冷却时间还都读同一个 blockSec，语义重叠；而且没有胜场
 * 计数，没法做「打输后立刻用新战报重算」。这里统一成一份状态，由 engine
 * 负责持久化：
 *   lossCount    连续打输次数（赢一场清零）
 *   lastLossAt   上一次打输的时刻
 *   needSync     战报里没带对方面板，下次动手前要补一次守家日志
 *   cooldownUntil 短暂冷却（打输后几秒 / 打平后几秒）
 *   blockedUntil  主动放弃：重算后 EV 仍为负，按 guardBlockSec 封禁
 *   blockedReason 放弃原因（日志/复盘用）
 */
function stealStateOf(memo, id, create = false) {
  const key = String(id)
  const map = memo.stealState || (memo.stealState = {})
  if (!map[key] && create) {
    map[key] = {
      lossCount: 0, lastLossAt: 0, needSync: false,
      cooldownUntil: 0, blockedUntil: 0, blockedReason: '',
    }
  }
  return map[key] || null
}

/** 这座岛此刻还该不该跳过；返回解禁时刻（0 = 可以去）。 */
function stealBlockedUntil(memo, id) {
  const s = memo.stealState?.[String(id)]
  if (!s) return 0
  return Math.max(Number(s.blockedUntil) || 0, Number(s.cooldownUntil) || 0)
}

/** 拉邻居目录（分页） */
export async function neighbors(world, { q = '', cursor = null, limit = 20, marked = false, stealable = false } = {}) {
  const p = new URLSearchParams({ limit: String(limit), q })
  if (cursor) p.set('cursor', cursor)
  // a4a62d77 新增：stealable=1 只返回「列表生成时可偷」的岛，省掉大量无效访问
  if (stealable) p.set('stealable', '1')
  return wget(world, (marked ? 'neighbors/marked' : 'neighbors') + '?' + p)
}

/** 拉某座岛的状态 */
export async function visitInfo(world, id) { return wget(world, 'visit/' + id) }

/**
 * 便宜地探一下「这一刻有没有能偷的岛」——一次 GET，不访问任何岛。
 *
 * 榜一 shouldBlockBackgroundWork 的前半条：只要现在有能偷的，后台模块
 * （五子棋/擂台/帮忙/修仙）全部让路。我们的调度表只记「未来解禁」，
 * 看不到「此刻已经可偷」——那类目标在 updateIsleSchedule 里被排除
 * （pl.steal=true 的行交给 targetFromVisit 直接处理），所以必须单独探一次。
 *
 * 用服务端的 stealable=1 筛选，一页就够。失败当作「没有」，
 * 不能因为探测失败就跳过正常流程。
 *
 * @returns {Array<{id,name,level}>} 此刻列出为可偷的岛（已过滤新手/标记）
 */
export async function probeStealable(world, cfg = {}, { limit = 20 } = {}) {
  const st = cfg.social?.steal || {}
  try {
    const d = await neighbors(world, { limit, stealable: true })
    return (d.neighbors || [])
      .filter((o) => o && !o.newbie && !(st.skipMarked && o.marked))
      .map((o) => ({ id: o.id, name: o.name, level: o.level }))
  } catch { return [] }
}

/**
 * 帮忙：去某座岛一键帮忙。
 * 返回 { coins, xp, energy, aff, done }
 */
export async function helpIsle(world, id) {
  const r = await wpost(world, 'help/' + id, { operation: randomUUID() })
  // 注意：串门类接口返回的 r.state 是**对方岛**的状态，rev 也被服务端作废
  // （站点前端在串门期间把 rev 置 -1，回自家岛才重新拉一次）。
  // 以前这里把 r.state 塞回 world.state，等于把自家世界换成了邻居的：
  // 同一轮紧接着开五子棋时，本地读到的是邻居的 cnt.gomokuPaid，
  // 于是在「今日计奖 10/10」已满时仍然发 start，被 409「小岛状态已变化」打回。
  world.revDirty = true
  return r.result || {}
}

/**
 * 帮忙日常：扫目录、挑「能帮的」去帮，直到用满当天额度。
 * 每天 10 家、每家 1 次；同一家今天帮过就跳过。
 */
export async function helpDaily(world, cfg, log = () => {}, memo = {}) {
  const g = cfg.social?.help
  if (!g?.enabled) return { helped: 0, coins: 0 }
  const R = world.R
  const day = R.worldDay(world.now)
  if (memo.helpDay !== day) { memo.helpDay = day; memo.helpedIds = new Set(); memo.helpCount = 0 }
  const memoHelp = memo.helpedIds || (memo.helpedIds = new Set())

  let helped = 0, coins = 0
  const perDay = g.perDay ?? 10
  if ((memo.helpCount || 0) >= perDay) return { helped: 0, coins: 0 }
  // 帮忙的 D 币有**每日上限**（实测四家 feeds 累加正好 4,000）。
  // 到顶后服务端只扣体力不给钱：11-13 有六家一共烧了 31 点体力换 0 D，
  // 其中 00:43 刚补的 12 点被一次 water×12 直接烧光。到顶就停，
  // 把体力留给钓鱼/挖矿/偷菜（1 点体力值 700~2,800 D）。
  const HELP_DAILY_CAP = 4000
  const capBase = Number(world.state?.cnt?.helpCoin) || 0
  if (capBase >= HELP_DAILY_CAP) {
    const key = `${day}|cap`
    if (memo.helpCapLogged !== key) {
      memo.helpCapLogged = key
      log(`帮忙：今日 D 币已到上限（${capBase.toLocaleString('en-US')}/${HELP_DAILY_CAP}），不再帮`)
    }
    return { helped: 0, coins: 0 }
  }
  // 体力不够就先攒。但**必须说一声**：以前这里直接 return，
  // 日志里完全看不出帮忙停摆的原因，只能看到偷菜那一行，
  // 让人以为帮忙根本没被调用（实测今天停在 5/10 家，29 次静默跳过）。
  const needE = g.minEnergy ?? 20
  if (world.state.en < needE) {
    const last = memo.helpWaitLogged
    // 只在体力档次变化时打一次，别每轮刷屏
    if (last !== `${memo.helpCount}|${Math.floor(world.state.en)}`) {
      memo.helpWaitLogged = `${memo.helpCount}|${Math.floor(world.state.en)}`
      log(`帮忙：等体力（当前 ${Math.floor(world.state.en)}，要 ${needE} 才动手）` +
        `，今日 ${memo.helpCount || 0}/${perDay}`)
    }
    return { helped: 0, coins: 0 }
  }

  let cursor = null
  let pages = 0, scanned = 0, skippedNewbie = 0, tried = 0
  const need = () => perDay - (memo.helpCount || 0)
  const helpCapped = () => capBase + coins >= HELP_DAILY_CAP
  while (helped < need() && !helpCapped() && pages++ < (g.maxPages ?? 8)) {
    let d
    try { d = await neighbors(world, { cursor, limit: 20 }) } catch (e) { log('读邻居失败：' + e.message); break }
    for (const o of d.neighbors || []) {
      scanned++
      if (helped >= need()) break
      if (helpCapped()) break
      if (memoHelp.has(o.id)) continue
      if (world.state.en < (g.minEnergy ?? 20)) break
      if (o.newbie) { skippedNewbie++; continue }        // 新手 24 小时内不可互动
      // 关键：能不能帮，以服务端的 canHelp 为准。
      // 旧代码用 `if (!(o.plots + o.pens)) continue` ——
      // 但列表里的 plots/pens 表示「当前有可偷/可采的东西」，不是「能帮忙」。
      // 实测 120 个邻居里 canHelp=true 的有 118 个，而 plots+pens>0 的只有 2 个，
      // 也就是说 116 个能帮的岛被那句判断全部跳过了。
      const canHelp = o.canHelp !== undefined ? !!o.canHelp : true
      if (!canHelp) continue
      tried++
      try {
        const res = await helpIsle(world, o.id)
        memoHelp.add(o.id)
        memo.helpCount = (memo.helpCount || 0) + 1
        helped++
        coins += res.coins || 0
        if (res.energy != null) world.state.en = Math.max(0, (world.state.en || 0) - res.energy)
        // 每家一行明细（旧版格式）：干了什么、拿多少、亲密度、花多少体力
        const did = Object.entries(res.done || {}).map(([k, n]) => `${k}×${n}`).join(' ') || '帮了一把'
        log(`  帮 ${res.owner || o.name} 干活：${did}，+${Math.round(res.coins || 0).toLocaleString('en-US')} D` +
          `${res.aff != null ? `，亲密度 ${res.aff}` : ''}${res.energy != null ? `，体力 -${res.energy}` : ''}`)
      } catch (e) {
        // 今天帮过 / 已达上限 → 记为已处理，别再试
        if (e.status === 409 || /今天帮过|已经帮|上限|额度/.test(e.message)) memoHelp.add(o.id)
        else log(`帮 ${o.name} 失败：${e.message}`)
      }
      await sleep(1200)
    }
    cursor = d.nextCursor
    if (!cursor) break
  }
  if (helped) {
    log(`帮忙 ${helped} 家，+${Math.round(coins).toLocaleString('en-US')} D（今日累计 ${memo.helpCount || 0}/${perDay}` +
      `${helpCapped() ? '，D 币已到日上限' : ''}）`)
  } else if (helpCapped()) {
    log(`帮忙：本轮撞到 D 币日上限（${(capBase + coins).toLocaleString('en-US')}/${HELP_DAILY_CAP}），提前收工`)
  } else {
    log(`帮忙：扫了 ${pages} 页 ${scanned} 家（尝试 ${tried} 家` +
      `${skippedNewbie ? `，跳过新手 ${skippedNewbie}` : ''}）没帮到，今日 ${memo.helpCount || 0}/${perDay}，稍后再试`)
  }
  return { helped, coins }
}

/** 折叠菜篮是否生效：生效时每处多拿 1 个（旧版 steal.useSack）。 */
function sackActive(R, world) {
  try { return !!R.b12Effect(world.state, 'carry', world.now) } catch { return false }
}

/** 组装 updateIsleSchedule 需要的参数，保证扫描/巡逻/掐点三处口径一致。 */
function scheduleArgs(R, world, cfg, info, memo, level) {
  const st = cfg.social?.steal || {}
  const state = info.state || null
  const rules = info.rules || {}
  const t = Number(info.now) || world.now
  let detect = 0.55
  try { detect = R.b12Detection(state || {}, world.state, t, 0) } catch { /* 用默认值 */ }
  return {
    R,
    isle: info.isle || {},
    state,
    rules,
    now: t,
    prices: world.prices,
    level: level || info.owner?.level || 1,
    myLevel: memo.arenaLevel || 1,
    guard: !!info.owner?.guard,
    detect,
    sack: sackActive(R, world),
    minEV: st.minEV ?? st.minValue ?? 3000,
    energyValue: st.energyValue ?? 300,
    groupSpanSec: st.groupSpanSec ?? 2,
    checkEvery: st.checkEvery ?? 1800,
    prepLeadSec: st.prepLeadSec || 15,
    horizonSec: st.horizonSec ?? 7200,
    // 多波次：同一座岛的作物分批成熟时，把后续 EV 达标的组也排进表里。
    // left.owner 是「这座岛主今天还能被偷几次」，服务端按它封顶；拿不到就按 3 算。
    ownerLeft: Number.isFinite(Number(info.left?.owner)) ? Number(info.left.owner) : null,
    maxWaves: st.maxWaves ?? 2,
    waveGapSec: st.waveGapSec ?? 20,
  }
}

/** 访问完一座岛就更新它的调度记录；失败时不破坏旧记录。 */
function recordVisitSchedule(R, world, cfg, memo, id, info, level) {
  const schedule = memo.stealSchedule || (memo.stealSchedule = {})
  try {
    const { rec } = updateIsleSchedule({ ...scheduleArgs(R, world, cfg, info, memo, level), prev: schedule[id] || null })
    schedule[id] = rec
    return rec
  } catch {
    return schedule[id] || null
  }
}

/** 现在能不能付得起这么多体力（不够就用口粮补，上限 maxEnergyCost）。 */
function canPayEnergy(R, world, cfg, needE) {
  if ((world.state.en || 0) >= needE) return true
  try {
    return !!energyActions(R, world.state, world.prices, {
      need: needE, maxPerE: cfg.social?.steal?.maxEnergyCost ?? 600, cfg, coins: world.coins,
    })
  } catch { return false }
}

/** 这一家现在去偷值不值（EV 过线 + 体力付得起）。 */
function worthStealing(R, world, cfg, memo, tg) {
  const st = cfg.social?.steal || {}
  const ev = stealEV(tg, memo.arenaLevel || 1, st.energyValue ?? 300)
  const needE = Math.min(tg.energy || 5, st.maxEnergy ?? 15)
  return ev >= (st.minEV ?? st.minValue ?? 3000) && canPayEnergy(R, world, cfg, needE)
}

/**
 * 从一次 visit 响应里抽出「现在能偷」的目标和估值。
 * scanStealTargets、watchRound、掐点快速路径共用，保证口径一致。
 *
 * 估值口径（旧版 v1 的 inspect()）：
 *   · 每块地服务端给 rules.perPlot 个；带折叠菜篮再多 1 个
 *   · 畜栏按窝里实际有的 pen.n 个给（至少 rules.perPen），带菜篮再多 1 个
 */
function targetsFromIsle(R, world, isle, rules) {
  const targets = []
  let value = 0
  let unitSum = 0        // 各处「多拿 1 个」值多少（守家胜利的加成按它算）
  const sack = sackActive(R, world) ? 1 : 0
  const perPlot = rules.perPlot || 2
  ;(isle.plots || []).forEach((pl, i) => {
    if (!pl?.steal) return
    // 保护期：成熟后一段时间内不可偷。服务端已用 steal 标记，直接信它。
    // 但「这一茬已经被偷过几个」要看 stolen（每茬上限 2，S:442、S:476、S:583）：
    // 剩下能拿的是 perPlot − stolen，旧版一律按 perPlot+sack 算，
    // stolen=1 的地块高估约 33%，正好会把不该去的目标推过 minEV。
    const stolen = Number(pl.stolen) || 0
    if (stolen >= 2) return
    const qty = Math.max(0, perPlot - stolen) + sack
    if (qty <= 0) return
    targets.push({ kind: 'plot', i })
    const unit = world.prices[pl.c] || R.BASE_PRICE[pl.c] || 0
    value += unit * qty
    unitSum += unit
  })
  ;(isle.barn || []).forEach((pen, i) => {
    if (!pen?.steal) return
    targets.push({ kind: 'pen', i })
    const def = R.ANIMALS.find((a) => a.id === pen.k)
    const n = Math.max(rules.perPen || 2, Number(pen.n) || 0)
    const unit = world.prices[def?.product] || def?.productPrice || 0
    value += unit * (n + sack)
    unitSum += unit
  })
  return { targets, value, unitSum }
}

/** 被发现概率（对方潮铃 +% / 我们斗篷 −%）；规则模块缺失时按基础 55%。 */
function detectOf(R, world, info) {
  try {
    return R.b12Detection(info.state || {}, world.state, Number(info.now) || world.now, 0)
  } catch { return 0.55 }
}

/**
 * 偷一批的体力消耗：规则原文 max(1, min(max, base+(spots−1)*per) − 口哨减耗)
 * （R:200-202）。旧版把 perSpot 写死成 1、也不减风声口哨，
 * 手动装备口哨时每次多算 1 点体力（按 energyValue 300 约 300 D/趟）。
 */
function stealCostOf(R, world, now, spots, rules) {
  try {
    return R.b12StealCost(world.state, now, Math.max(1, spots),
      Number(rules.energy) || 5, Number(rules.perSpot) || 1, Number(rules.energyMax) || 15)
  } catch {
    return Math.min(Number(rules.energyMax) || 15, (Number(rules.energy) || 5) + Math.max(0, spots - 1))
  }
}

/** 从 visit 结果里组装一个「现在就能偷」的目标对象。 */
function targetFromVisit(R, world, cfg, info, extra = {}) {
  const isle = info.isle || {}
  const rules = info.rules || {}
  const { targets, value, unitSum } = targetsFromIsle(R, world, isle, rules)
  if (!targets.length) return null
  const now = Number(info.now) || world.now
  return {
    targets, value,
    bonus: unitSum,
    detect: detectOf(R, world, info),
    fineMax: rules.fineMax || 5000,
    energy: stealCostOf(R, world, now, targets.length, rules),
    seenAt: now,
    ...extra,
  }
}

/**
 * 「还没到解禁时刻」的目标：服务端此刻的 steal 标记还是 false，
 * 但调度表已经算准了它几秒后解禁。
 *
 * 掐点醒来时访问的正是这个时刻——如果只认 targetsFromIsle（服务端当前
 * 的 steal 标记），一波目标全都还没解锁，会被整波丢掉，只能等第二次唤醒。
 * 这里直接用调度表记下的那几处（地块/畜栏 + 估值）组装目标：
 * 提交时服务端按岛结算，真正能不能拿到由它判定。
 */
function targetFromSchedule(R, world, info, c) {
  const entries = c.entries || []
  if (!entries.length) return null
  const rules = info.rules || {}
  const spots = entries.length
  const now = Number(info.now) || world.now
  return {
    targets: entries.map((e) => ({ kind: e.kind, i: e.i })),
    value: Number(c.value) || 0,
    // 守家胜利每处多拿 1 个：各处的单件价之和（steal-schedule 的 candidate.unit）
    bonus: entries.reduce((a, e) => a + (Number(e.unit) || 0), 0),
    detect: detectOf(R, world, info),
    fineMax: rules.fineMax || 5000,
    energy: stealCostOf(R, world, now, spots, rules),
    seenAt: now,
    id: c.targetId,
    name: c.name,
    level: c.level || 1,
    guard: !!info.owner?.guard,
    at: c.at,
    // 解禁时刻是本地推算的（不是服务端确认过的）：提交前要再 GET 一次校准。
    scheduled: true,
  }
}

/**
 * 扫目录，找出「现在能偷」的岛：有成熟作物或窝里有产物，且过了保护期、不在新手保护。
 * 同时把每座岛的「最近的值得掐的解禁组」记进 memo.stealSchedule，供 nextWake 精确唤醒。
 * 返回 [{ id, name, level, guard, targets: [...], value }]
 *
 * 和旧版 v1 一样：一旦发现「现在能偷且 EV 过线、体力付得起」的岛就立刻返回，
 * 不再把剩下的页扫完——扫描期间对手就在抢同一块地。
 */
export async function scanStealTargets(world, cfg, log = () => {}, memo = {}) {
  const R = world.R
  const t = world.now
  const st = cfg.social?.steal || {}
  const out = []
  const schedule = memo.stealSchedule || (memo.stealSchedule = {})
  let upcomingCount = 0
  const pages = st.pages ?? 6
  let cursor = null, scanned = 0, skipped = 0, readyN = 0
  // 是否成功用上了「只看可偷」筛选。必须声明在循环外——循环末尾的日志要用它。
  let usedFilter = true
  for (let p = 0; p < pages; p++) {
    let d
    // 站点 a4a62d77 起支持只列可偷的岛；列表是「生成时」的快照，抵达后仍需核对
    try { d = await neighbors(world, { cursor, limit: 20, stealable: true }) }
    catch (e) {
      // 老版本站点不支持这个参数，退回全量扫描
      usedFilter = false
      try { d = await neighbors(world, { cursor, limit: 20 }) } catch (e2) { log('扫目录失败：' + e2.message); break }
    }
    for (const o of d.neighbors || []) {
      scanned++
      if (o.newbie) { skipped++; continue }        // 新手保护（创建后 24 小时）
      if (st.skipMarked && o.marked) { skipped++; continue }
      if (!usedFilter && !(o.plots + o.pens)) { skipped++; continue }
      // 用了可偷筛选时，服务端已经保证有目标，可以省掉一次访问；
      // 但为了拿到准确的目标与体力消耗，仍然读一次详情（它同时给出 rules）。
      let info
      try { info = await visitInfo(world, o.id) } catch { skipped++; continue }
      const isle = info.isle || {}

      // 更新这座岛的解禁调度表（精确的成熟 + 保护期时刻）
      try {
        const rec = recordVisitSchedule(R, world, cfg, memo, o.id, info, o.level)
        upcomingCount += rec?.nextAt ? 1 : 0
      } catch { /* 调度只是优化，算不出来不影响正常扫描 */ }

      const tg = targetFromVisit(R, world, cfg, info, {
        id: o.id, name: o.name, level: o.level || 1, guard: !!info.owner?.guard,
      })
      if (!tg) continue
      readyN++
      const ev = stealEV(tg, memo.arenaLevel || 1, st.energyValue ?? 300)
      tg.ev = ev
      // 巡逻/扫描时一旦发现值得偷的就立刻收工去偷，别把剩下的页扫完。
      if (worthStealing(R, world, cfg, memo, tg)) {
        log(`扫目录：${o.name}（Lv${tg.level}${tg.guard ? '·有守家' : ''}）现在能偷 ` +
          `${tg.targets.length} 处，估 ${Math.round(tg.value).toLocaleString('en-US')} D，` +
          `期望 ${Math.round(ev).toLocaleString('en-US')} D，立即去（不再扫后面的页）`)
        return [tg]
      }
      out.push({ ...tg, ev })
    }
    cursor = d.nextCursor
    if (!cursor) break
  }
  out.sort((a, b) => b.ev - a.ev)
  log(`扫了 ${scanned} 座岛${skipped ? `（跳过 ${skipped} 座）` : ''}，` +
    (readyN ? `${readyN} 家现在能偷，但没有一家期望收益过线` : '找到 0 家可偷') +
    (usedFilter ? '（用了可偷筛选）' : ''))
  // 提示「还有多少处正在生长/保护期、什么时候解禁」——这是旧的到点扫描完全看不到的信息
  if (upcomingCount > 0) {
    const nx = nextUnlock(schedule, t)
    log(`  ${upcomingCount} 座岛有未来解禁目标` +
      (nx ? `，最近一处 ${nx.item} 在 ${Math.round(nx.at - t)} 秒后解禁${nx.exact ? '（时刻确定）' : '（估计）'}` : ''))
  }
  // 把候选按性价比列出来，方便判断为什么去/不去某一家
  for (const tg of out.slice(0, 6)) {
    log(`  ${tg.name}（Lv${tg.level}${tg.guard ? '·有守家' : ''}）` +
      `${tg.targets.length} 处，估 ${Math.round(tg.value).toLocaleString('en-US')} D，耗 ${tg.energy} 体力` +
      `，期望 ${Math.round(tg.ev).toLocaleString('en-US')} D` +
      `（每体力 ${Math.round(tg.value / Math.max(1, tg.energy)).toLocaleString('en-US')} D）`)
  }
  if (out.length > 6) log(`  …还有 ${out.length - 6} 家`)
  return out
}

/**
 * 清掉已经到点、却一直没偷成的解禁记录。
 *
 * 判据是「解禁时刻已经过去 leadSec 秒以上」。到了这个点还没偷到，只有两种可能：
 *   · 目标已经被偷满（stolen 到 2）或被别人抢走
 *   · 我们体力不够 / 被守家打跑
 * 两种情况下再留着这条记录都只会让主循环反复「到点醒来 → 扫一遍 → 什么都没做」。
 * 下次真正扫到那座岛时，updateIsleSchedule 会按最新状态重新算出解禁时刻。
 */
function sweepStaleUnlocks(schedule, now, leadSec = 8) {
  for (const [id, rec] of Object.entries(schedule || {})) {
    if (!rec) continue
    const list = Array.isArray(rec.upcoming) ? rec.upcoming : []
    const keep = list.filter((u) => u.unlockAt > now - leadSec)
    if (keep.length !== list.length) {
      if (keep.length) {
        rec.upcoming = keep
      } else {
        // 这一波没赶上（被别人抢 / 体力不够 / 被守家打跑）。
        // 多波次：把排好的下一波提上来继续盯；没有下一波才真正清空。
        // 以前这里无条件清空，第二批成熟就彻底丢失了。
        advanceIsleWave(rec, now)
      }
    }
    // 过期的明细只留着占内存，一小时前的记录没有参考价值。
    for (const map of [rec.plots, rec.pens]) {
      for (const [k, v] of Object.entries(map || {})) {
        if ((v?.unlockAt || 0) < now - 3600) delete map[k]
      }
    }
    // 后续波次同样要清理，否则表会随着访问过的岛无限增长。
    if (Array.isArray(rec.waves) && rec.waves.length) {
      rec.waves = rec.waves.filter((w) => (Number(w?.at) || 0) > now - 3600)
    }
  }
}

/**
 * 重建「值得盯」的岛列表（watchlist）。
 *
 * 为什么要这张表：服务端的「可偷」筛选只告诉我们**此刻**谁能偷。
 * 线上实测 970 座邻居里成熟的地有 410 块、可偷的 0 块——
 * 每块地一茬最多被偷 2 个（stolen 到 2 就锁死），好地早就被别人扫干净了。
 * 想抢到就只能**掐着解禁那一刻**去，而解禁时刻只有访问过才知道
 * （visit 返回每块地的 left，成熟 + 保护期 = 解禁）。
 * 所以必须提前把活跃的岛看一遍、把解禁时刻记进 stealSchedule，交给 nextWake 掐点。
 *
 * 旧版 v1 也是这么做的：每 2 小时扫一遍全服目录，维护一份「盯」的名单。
 */
export async function refreshWatchList(world, cfg, log = () => {}, memo = {}) {
  const st = cfg.social?.steal
  if (!st) return memo.stealWatch || {}
  const now = world.now
  const every = st.dirEvery ?? 7200
  if (memo.stealWatch && now - (memo.stealWatchAt || 0) < every) return memo.stealWatch

  const watch = {}
  const avoid = new Set((st.avoid || []).map(Number))   // 手动排除的岛
  let cursor = null, seen = 0, kept = 0, pages = 0
  for (let p = 0; p < (st.dirPages ?? 12); p++) {
    let d
    try { d = await neighbors(world, { cursor, limit: 20 }) }
    catch (e) { log('偷菜：读目录失败：' + e.message); break }
    pages++
    for (const o of d.neighbors || []) {
      seen++
      if (o.newbie) continue
      if (avoid.has(o.id)) continue
      // 被自己标记过的岛跳过（旧版 skipMarked；站点有 marked 字段时才生效）
      if (st.skipMarked && o.marked) continue
      const act = Number(o.active) || 0
      // 深页全是早就没人玩的 Lv1 空岛（active 缺失）。至少要 24 小时内活跃过。
      if (!act || now - act > 86400) continue
      // hint = 目录里看到的「有货的地块 + 畜栏数」，只用来给同时解禁的岛排先后
      watch[o.id] = { name: o.name, level: o.level || 1, hint: (Number(o.plots) || 0) + (Number(o.pens) || 0) }
      kept++
    }
    cursor = d.nextCursor
    if (!cursor) break
    await sleep(600)
  }
  memo.stealWatch = watch
  memo.stealWatchAt = now
  // 名单之外的岛的调度记录没用了（旧版每次重建目录都会整份替换）
  const schedule = memo.stealSchedule
  if (schedule) {
    let dropped = 0
    for (const id of Object.keys(schedule)) {
      if (!watch[id]) { delete schedule[id]; dropped++ }
    }
    if (dropped) log(`偷菜：目录重建，清掉 ${dropped} 座不再活跃的岛的调度记录`)
  }
  log(`偷菜：目录 ${pages} 页 ${seen} 座岛，盯 ${kept} 座 24 小时内活跃的`)
  return watch
}

/**
 * 逐个访问 watchlist 里的岛，把每块地 / 每个畜栏的解禁时刻记进调度表。
 *
 * 选择规则（旧版 v1 的 `check` 队列）：
 *   · 记录里 checkAt <= now 的岛优先，按 checkAt 升序
 *   · 没有记录的岛也排队（checkAt 视为 0），保证每座岛至少被看一次
 *   · 冷却期 / 负期望封禁期内的岛跳过（memo.stealState，封禁时长 battle.guardBlockSec）
 * 每轮最多 visitsPerScan 家。访问过程中一旦发现「现在能偷且值得偷」的，
 * 立刻停止巡逻、返回这一家——巡逻剩下的岛不花体力，但会错过偷菜窗口。
 *
 * 返回这一轮顺带发现的「现在就能偷」的目标（最多一家，早退）。
 */
export async function watchRound(world, cfg, log = () => {}, memo = {}) {
  const st = cfg.social?.steal
  const R = world.R
  const now = world.now
  // 巡逻是「顺手」做的，不该每轮巡视都花 10 秒在这上面。
  // 两分钟一批，活跃岛几分钟轮完一圈，够掐解禁时刻了。
  const every = st.watchEvery ?? 120
  if (now - (memo.stealWatchRoundAt || 0) < every) return []
  memo.stealWatchRoundAt = now
  const watch = memo.stealWatch || {}
  const ids = Object.keys(watch)
  if (!ids.length) return []
  const schedule = memo.stealSchedule || (memo.stealSchedule = {})
  const per = st.visitsPerScan ?? 12
  const maxAge = st.checkEvery ?? 1800   // 多久没看过就值得再看一眼

  // 按「下次该访问的时刻」排队。没有记录的岛 checkAt=0，最先被看。
  // 同一时刻的用目录 hint（有货的地块数）做 tiebreak，好岛排前面。
  const queue = []
  for (const id of ids) {
    if (stealBlockedUntil(memo, id) > now) continue  // 打输冷却 / 负期望封禁期内不去
    const rec = schedule[id]
    const checkAt = Number(rec?.checkAt) || 0
    const stale = !rec?.seenAt || now - rec.seenAt >= maxAge
    if (checkAt > now && !stale) continue               // 离下次访问还早
    queue.push({ id: Number(id), name: watch[id].name, level: watch[id].level, checkAt, hint: watch[id].hint || 0 })
  }
  queue.sort((a, b) => a.checkAt - b.checkAt || b.hint - a.hint)
  const picked = queue.slice(0, per)
  if (!picked.length) return []

  let ripeSeen = 0, exhausted = 0, readyN = 0
  for (const o of picked) {
    let info
    try { info = await visitInfo(world, o.id) } catch { continue }
    const isle = info.isle || {}
    recordVisitSchedule(R, world, cfg, memo, o.id, info, o.level)
    // 统计用：成熟但偷不了的地，说明已经被偷满或还在保护期
    for (const pl of isle.plots || []) {
      if (!pl || pl.stage !== 3) continue
      if (pl.steal) continue
      if ((pl.stolen || 0) >= 2) exhausted++
      else ripeSeen++
    }
    const tg = targetFromVisit(R, world, cfg, info, {
      id: o.id, name: o.name, level: o.level || 1, guard: !!info.owner?.guard,
    })
    if (!tg) {
      await sleep(600)
      continue
    }
    readyN++
    const ev = stealEV(tg, memo.arenaLevel || 1, st.energyValue ?? 300)
    tg.ev = ev
    // 巡逻途中撞见现在就能偷的，先偷，别继续看剩下的岛。
    if (worthStealing(R, world, cfg, memo, tg)) {
      log(`偷菜：巡逻发现 ${o.name}（Lv${tg.level}${tg.guard ? '·有守家' : ''}）现在能偷 ` +
        `${tg.targets.length} 处，估 ${Math.round(tg.value).toLocaleString('en-US')} D，` +
        `期望 ${Math.round(ev).toLocaleString('en-US')} D，立即去`)
      return [tg]
    }
    await sleep(600)
  }
  log(`偷菜：看了 ${picked.length} 座岛` +
    (readyN ? `，${readyN} 家有货但期望收益不够` : '，暂时没有可偷的') +
    (ripeSeen ? `｜${ripeSeen} 块成熟在保护期` : '') +
    (exhausted ? `｜${exhausted} 块已被偷满` : ''))
  return []
}

/** 偷菜道具：轻步斗篷（被发现率 −10 个百分点）+ 折叠菜篮（每处多拿 1 个）。
 *  旧版每次真要去偷之前都会补这两样；新版漏了，配置项成了死代码。 */
export async function ensureThiefItems(world, cfg, log = () => {}) {
  const st = cfg.social?.steal
  if (!st) return
  const R = world.R
  const t = world.now
  const want = []
  if (st.useCloak && !R.b12Effect(world.state, 'stealth', t)) want.push('cloak')
  if (st.useSack && !R.b12Effect(world.state, 'carry', t)) want.push('sack')
  if (!want.length) return
  const reserve = Math.min(cfg.invest?.reserveCoins || 0, 50000)
  const acts = []
  let cost = 0
  for (const id of want) {
    const price = R.THIEF_ITEMS?.[id]?.price || 0
    if (!price) continue
    if (world.coins - cost - price < reserve) continue
    acts.push({ a: 'buy', id })
    cost += price
  }
  if (!acts.length) return
  try {
    const r = await world.act(acts, { silent: true })
    const ok = (r.out || []).filter((o) => o?.ok).length
    if (ok) log(`偷菜：买了${want.map((id) => R.THIEF_ITEMS?.[id]?.name || id).join('、')}（${Math.round(cost).toLocaleString('en-US')} D，24 小时有效）`)
  } catch (e) { log('偷菜：买道具失败：' + e.message) }
}

/**
 * 解禁前把体力补到「这一波全偷完」的量（榜一 executeStagedSnipe 里 physical-prep 的移植）。
 *
 * 以前体力是在 stealFromTargets 的循环里按目标现场吃：解禁那一刻先发一个
 * act（吃口粮），2.15 秒后才发 visit。线上 11-13 13:21 就是这么丢的：
 *   13:21:04 发现能偷 3 处 → 13:21:06 吃口粮 → 13:21:09 提交，
 *   服务端回「已经没得偷了｜目标数据 3 秒前拿到」。
 *
 * 现在把补体力挪到「解禁之前」：醒来 → 拉最新快照 → 吃口粮/喝咖啡 → 等解禁 →
 * 解禁那一刻只发 visit 请求。和榜一一样，解禁窗口里不排任何准备动作。
 *
 * 返回补了多少点体力（0 表示本来就够 / 补不上）。
 */
async function preStageStamina(world, cfg, log, targets, { label = '' } = {}) {
  const st = cfg.social?.steal || {}
  const R = world.R
  if (!targets?.length) return 0
  const per = Math.max(1, st.maxEnergy ?? 15)
  // 一波全偷完需要的体力。超过上限的部分补不进去，按上限补即可。
  const waveNeed = targets.reduce((a, t) => a + Math.min(Number(t.energy) || 5, per), 0)
  const cap = R.energyMax(world.state)
  const target = Math.min(waveNeed, cap)
  const before = Math.floor(world.state.en)
  if (before >= target) return 0
  const acts = energyActions(R, world.state, world.prices, {
    need: target, maxPerE: st.maxEnergyCost ?? 600, cfg, coins: world.coins,
  })
  if (!acts?.length) return 0
  try {
    const r = await world.act(acts, { silent: true })
    const ok = (r.out || []).filter((o) => o?.ok).length
    if (!ok) return 0
    const after = Math.floor(world.state.en)
    log(`偷菜：解禁前先把体力补到 ${after}（${before} → ${after}，花 ${Math.round(r.spend || 0).toLocaleString('en-US')} D）${label}`)
    return after - before
  } catch (e) {
    log('偷菜：解禁前补体力失败：' + e.message)
    return 0
  }
}

/** 偷一家（一批全偷） */
export async function stealIsle(world, id) {
  const r = await wpost(world, 'visit/' + id, { operation: randomUUID(), kind: 'all', i: 0 })
  // 同上：r.state 是对方岛的，不能拿来覆盖自家的世界状态；只标脏。
  world.revDirty = true
  return r
}

/**
 * 偷菜一轮：扫描 → 按价值/体力比排序 → 挨个偷。
 * 默认关闭；开启前请确认擂台等级能打过守家鱼。
 */
/**
 * 从调度表里取出「现在到点」的几家，供掐点偷菜直接访问。
 *
 * 为什么需要它：偷菜的价值全在「解禁那一刻」。可偷筛选返回的都是别人
 * 已经漏掉的，真正的好货解禁几秒内就被抢走。线上 2026-11-12 一整天
 * 记下 250 处待解禁、实际偷到 0 件——不是没掐点，是掐到点之后还先扫
 * 一遍目录（40~50 页、上千座岛）再访问十几家邻居，等轮到发包时早过了。
 *
 * 榜一 snipe-scheduler 提前用 T_prep 算好准备时间，醒来直接对目标发包；
 * 我们至少做到：掐点这一轮只访问调度表里到点的那几家。
 */
/**
 * 取「当前这一波」里要访问的岛。
 *
 * 以前只取最早的 3 家，同波的其他岛要等下一轮——偷菜的窗口只有几十秒，
 * 等下一轮基本就是别人的了。现在按 nextWave 把 ±2 秒内解禁的条目聚成
 * 一波，整波一起访问；上限 5 家（再多访问也赶不上窗口，还会把请求间隔拖长）。
 *
 * 注意：这里只决定「访问谁」，具体偷哪些由 targetsFromIsle 按货值/守家胜率
 * 重新算；还没到解禁时刻的（服务端 steal 仍是 false）退回调度表的估值。
 * 所以多访问一家的代价只是一次 visit（不花体力）。
 */
function waveTargets(schedule, watch, now, leadSec, limit = 5, prices = {}) {
  const wave = nextWave(schedule, now, { leadSec, waveSpanSec: 2 })
  if (!wave) return []
  // 同一波里先访问最值钱的岛。
  //
  // 一波常常有 5~10 家同时解禁，而 limit 只允许访问 5 家、之后还要按顺序
  // 提交偷菜请求——先访问谁直接决定抢到的是葡萄还是萝卜。以前按解禁时刻
  // 排序（同一波内几乎相同），等于按 id 顺序。这里用 watch 表里记下的
  // 作物/产物 id 乘当前市价做粗估（此时还没访问，拿不到精确目标数）。
  return wave.isles
    .map(({ targetId, entries }) => {
      const w = watch?.[targetId] || {}
      const rec = schedule?.[targetId] || {}
      const items = entries.map((e) => e.item).filter(Boolean)
      const est = items.reduce((a, id) => a + (Number(prices[id]) || 0), 0)
      // 调度时算好的估值：解禁前服务端的 steal 标记还是 false，
      // 这是唯一能提前知道「这一波值多少」的来源（targetFromSchedule 用它）。
      const value = entries.reduce((a, e) => {
        const v = e.kind === 'plot' ? rec.plots?.[e.i]?.value : rec.pens?.[e.i]?.value
        return a + (Number(v) || 0)
      }, 0)
      return {
        targetId, name: w.name || `岛 ${targetId}`, level: w.level || 1,
        at: entries[0].at, items, est, value, entries,
      }
    })
    .sort((a, b) => b.value - a.value || b.est - a.est || a.at - b.at)
    .slice(0, limit)
}

// ---------- 守家档案 / 战前换装 ----------

/**
 * 偷菜侧的战斗上下文。
 *
 * 以前守家胜率是「0.5 + 等级差×0.15」——既没看对方真实面板，
 * 也没考虑我们能换装备。这里接上榜一的方案：
 *   · 从战报档案里取出对手的守家面板；
 *   · 跑蒙特卡洛模拟算出赢/平/输三结局；
 *   · 若换装能显著提高胜率（z > 2），就在解禁前把装备换好，偷完还原。
 * 全部关掉时（battle.guardPosterior=false / arena.autoEquip=false）退回旧公式。
 */
function stealBattleCtx(cfg) {
  const b = cfg.battle || {}
  return {
    on: cfg.arena?.enabled && cfg.arena?.autoEquip !== false && b.stealSwap !== false && b.guardPosterior !== false,
    storePath: b.profileStore || defaultProfileStorePath(),
    lockRoot: b.lockRoot || defaultLockRoot(),
    accountKey: b.accountKey || 'main',
    trials: b.guardTrials ?? 800,
    minGain: b.minGain ?? 0.005,
    zThreshold: b.zThreshold ?? 2.0,
    blockSec: b.guardBlockSec ?? 600,
    // 打输后的「观察冷却」：只等几秒，够用新战报重算一次 EV；重算后仍为负
    // 才升级成 blockSec 封禁（榜一 recordSnipeReceipt 的 outcome 分支）。
    lossCooldownSec: b.lossCooldownSec ?? 5,
    drawCooldownSec: b.drawCooldownSec ?? 4,
    // 真实战绩在守家后验里的分量（相当于几场模拟），见 battle.mjs。
    recordPrior: b.recordPrior ?? 4,
  }
}

const gearFnFor = (world) => () => world.client.get('/api/pet/battle/gear')
const equipSlotFnFor = (world) => async (slot, item) => {
  try {
    const body = await world.client.post('/api/pet/battle/equip', { slot, item })
    return { status: 200, body }
  } catch (e) {
    // 交给调用方按「状态未知」处理：它会重新拉一次装备页确认实际穿着。
    return { status: e.status ?? 0 }
  }
}

/** 拉装备页 + 给有守家的目标附上模拟胜率（没有档案的目标保持旧公式）。 */
async function prepareStealBattle(world, cfg, memo, targets) {
  const bc = stealBattleCtx(cfg)
  if (!bc.on) return null
  // 上一场打输且战报里没带对方面板（battle 为空）时，先增量补一次守家日志，
  // 否则这次模拟用的还是旧面板，会对着同一个强敌反复送罚款
  // （榜一 snipe-scheduler 的 needsGuardLogSync）。
  const pending = targets.filter((t) => stealStateOf(memo, t.id)?.needSync)
  if (pending.length) {
    try {
      await syncGuardLogProfiles(world.client, bc.accountKey, {
        storePath: bc.storePath, maxFetch: cfg.battle?.guardSyncMax ?? 8,
      })
      for (const t of pending) stealStateOf(memo, t.id).needSync = false
    } catch { /* 拿不到就按旧面板算，下一轮再补 */ }
  }
  let gear
  try {
    gear = await fetchGear(world, memo, { maxAge: cfg.battle?.gearCacheSec ?? 600 })
  } catch { return null }
  if (!gear?.catalog) return null
  const observed = loadObservedPanels(bc.accountKey, bc.lockRoot)
  let simulated = 0
  for (const t of targets) {
    if (!t.guard) { t.pWin = 1; t.pLoss = 0; t.pDraw = 0; continue }
    try {
      const post = computeGuardPosteriorForTarget(gear, t.id, {
        knownOpponentLevel: t.level || null,
        observedPanels: observed,
        storePath: bc.storePath,
        trials: bc.trials,
        minGain: bc.minGain,
        zThreshold: bc.zThreshold,
        recordPrior: bc.recordPrior,
      })
      if (post) {
        t.pWin = post.winRateMid
        t.pLoss = post.lossRateMid
        t.pDraw = post.drawRate
        t._post = post
        simulated++
      }
    } catch { /* 单条档案坏了不影响其他目标 */ }
  }
  return { ...bc, gear, simulated }
}

/** 从排好序的目标里挑一个「换装后胜率显著更高」的，作为这一波的战前准备。 */
function pickSwapTarget(ranked) {
  for (const { t } of ranked) {
    const dec = t?._post?.decision
    if (dec?.switched && dec.loadout) return { t, decision: dec }
  }
  return null
}

/**
 * 跑一轮偷菜：掐点优先，其次巡逻/扫描。
 *
 * forceScan=true 时绕过 scanEvery 直接扫目录——engine 用可偷筛选探到
 * 「此刻有货」时会传它，避免被「半小时才扫一次」的间隔挡住。
 */
export async function stealRound(world, cfg, log = () => {}, memo = {}, { forceScan = false, snipeNow = false } = {}) {
  const st = cfg.social?.steal
  if (!st?.enabled) return { stolen: 0, value: 0 }
  // 掐点判断依赖「此刻」，而 world.now 只在上次 accept 时更新。
  // 一次巡视可能已经跑了几个分钟（扫目录、擂台），这里先校准一次。
  world.tickClock?.()
  const R = world.R
  const lastScan = memo.stealScanAt || 0
  const every = st.scanEvery ?? 1800
  // 提前量 T_prep：配置显式指定就照用，否则按「这一波有几家」算——
  // 醒来后要串行访问每一家（约 1.5 秒/家），访问完最后一家刚好越过解禁点。
  // 固定 8 秒时，一波 4~5 家根本访问不完，第一家还没提交就过窗口了。
  // 开了战前换装的话还要再留出 3 个槽位的 POST 时间（约 6.6 秒），
  // 否则换完装解禁时刻已经过去。体力不够这一波还要加「剩余 POST 冷却 +
  // minGap + 2×RTT」——补体力也是一个 act POST，不能在解禁那一刻排队。
  const client = world.client || {}
  const leadSec = physicalPrepLeadSec({
    schedule: memo.stealSchedule || {},
    now: world.now,
    gearSwaps: stealGearSwaps(cfg),
    needPrepAct: world.state.en < Math.min(st.maxEnergy ?? 15, 15),
    remainingPostCdMs: client.getRemainingPostCooldownMs?.() || 0,
    minGapSec: cfg.minGap ?? 2.15,
    rttMs: client.lastRttMs || 600,
    fixedLeadSec: st.prepLeadSec || 0,
  })

  // 先把「已经处理过 / 已经失效」的解禁记录清掉，再判断要不要绕过扫描间隔。
  //
  // 这一步是这次「每 5 秒输出一次『有已解禁未处理的目标，提前扫描』」的真正解法。
  // 线上日志（2026-11-12 14:07）是这么循环的：
  //   1. 调度表里有 433 条记录（watchRound 巡逻时把「成熟在保护期」的地
  //      全记成 900 秒后解禁，53 座岛 × 平均 8 块）
  //   2. 时间到 → nextWake 给 1 秒 → 主循环立刻醒
  //   3. stealRound 看到 overdue（过期 10 秒以上、300 秒宽限内）→ 绕过扫描间隔去扫
  //   4. 扫描用 stealable=1 筛选，服务端返回 0 家 → 一个岛都没访问
  //      → 那些记录一条都不会被 updateIsleSchedule 更新 → 还留在表里
  //   5. 回到 2，无限循环
  //
  // 关键：一次扫描都没偷到就说明这条记录已经没用了（被偷满 / 已被别人抢走 /
  // 守家打不过）。留着它只会让主循环反复空转。所以过期即弃，
  // 下次真正扫到那座岛时 updateIsleSchedule 会重新算。
  sweepStaleUnlocks(memo.stealSchedule, world.now, leadSec)

  // 体力不够偷任何一家时，先看「能不能补上」，补不上才整轮跳过。
  //
  // 偷菜最便宜也要 rules.energy（服务端常量 5 点）体力。这里的判断以前是
  // 一条硬门槛「en < 5 就整轮跳过」——那是错的：体力被钓鱼/挖矿花光之后，
  // 明明有口粮也照样跳过，于是一整天的偷菜额度都是 0（11-12 全天只偷到 1 处）。
  // 旧版 extension/lib/strategy.mjs 的 energyActions 就是干这个的：
  // 现场吃口粮把体力补到够，只要每点体力的成本不超过 steal.maxEnergyCost。
  //
  // 注意：这里**不**立刻补。扫描（访问岛屿）本身不花体力，先看这一轮有没有
  // 值得偷的目标，有的话在 stealFromTargets 里按那个目标实际需要的体力补，
  // 避免「为了扫一圈先吃掉一份口粮」。
  const minStealE = 5
  const maxPerE = st.maxEnergyCost ?? 600
  if (world.state.en < minStealE) {
    const acts = energyActions(R, world.state, world.prices, {
      need: minStealE, maxPerE, cfg, coins: world.coins,
    })
    if (!acts?.length) {
      const key = `${world.worldDay || ''}:${Math.floor(world.state.en)}`
      if (memo.stealLowEnergyNoted !== key) {
        memo.stealLowEnergyNoted = key
        log(`偷菜：体力不足（${Math.floor(world.state.en)} < ${minStealE}），口粮也补不上，这一轮跳过`)
      }
      return { stolen: 0, value: 0 }
    }
    memo.stealLowEnergyNoted = ''
  }

  // 「解禁时刻到了」必须同时满足两件事才算数：
  //   1. 节流窗口已过 —— 巡逻一圈会记下几百条解禁时刻，平均每 20 秒有一条到点。
  //      不加节流的话每一轮都会判定「有精确时刻」，绕过 scanEvery 全量扫描，
  //      而每次都是「扫了 8 座岛，找到 0 家可偷」。线上 14:32~14:35 刷了 3 分钟。
  //      偷到过就 60 秒一次，连续白醒就翻倍到 15 分钟（见 steal-schedule.mjs）。
  //   2. 这条记录还没过点（nx.at >= now − leadSec）—— 用 <= 单向判断会让
  //      过去很久的记录也算命中，配合 nextWake 的 1 秒候选变成几秒一醒。
  const gap = Math.max(SNIPE_MIN_GAP_SEC, memo.stealWakeGap || SNIPE_MIN_GAP_SEC)
  // snipeNow：引擎已经在 tick 里确认过「这一波该抢」。白醒节流只用于决定
  // 要不要为偷菜再醒一次；已经醒着、目标就在 leadSec 内时不能再被它拦住——
  // 否则会白等一个 gap（10 秒起步，连续抢不到时能到 15 分钟），货早没了。
  const wakeReady = snipeNow === true || world.now - (memo.stealWakeAt || 0) >= gap
  const nx = nextUnlock(memo.stealSchedule || {}, world.now, { leadSec })
  const snipeReady = wakeReady && !!nx && nx.at >= world.now - leadSec && nx.at - world.now <= leadSec + 5
  // 宽限必须和 nextUnlock 的 WAKE_GRACE_SEC 一致。
  // 用 EXPIRED_GRACE_SEC（300 秒）会变成：解禁后 300 秒内每一轮都绕过扫描间隔，
  // 而 nextWake 只在前 30 秒里催醒——中间的 270 秒就成了「醒了就扫、扫了也没用」。
  const overdue = wakeReady && Object.values(memo.stealSchedule || {})
    .some((rec) => (rec.upcoming || []).some((u) => u.unlockAt < world.now - 10 && u.unlockAt > world.now - WAKE_GRACE_SEC))

  if (!forceScan && world.now - lastScan < every && !snipeReady && !overdue) {
    // 还没到全量扫描的时候，但可以顺手巡逻几家 watchlist：
    // 服务端的「可偷」筛选只看得到「此刻已经被别人漏掉的」，
    // 真正的好货是解禁瞬间就被抢的，必须提前记下解禁时刻才能掐到。
    await refreshWatchList(world, cfg, log, memo)
    const watchTargets = await watchRound(world, cfg, log, memo)
    if (!watchTargets.length) return { stolen: 0, value: 0 }
    return await stealFromTargets(world, cfg, log, memo, watchTargets)
  }
  // 到点（snipeReady）或已过点还在宽限内（overdue）都走快速路径。
  //
  // overdue 以前会「绕过扫描间隔做全量扫描」——一次几十秒，扫完目标早没了，
  // 而且下一次解禁照样被拖过去。过点的记录只有两种结局：货被抢光，
  // 或者我们体力/胜率不够；两种情况都只需要去目标岛确认一下，不需要扫全服。
  if (snipeReady || overdue) {
    if (snipeReady) {
      memo.stealWakeAt = world.now
      memo.stealWakePending = true
    }
    // 掐点这一轮**不扫目录**。以前这里只打一行日志就继续往下走，
    // 于是「醒来 → refreshWatchList 拉 40~50 页目录 → watchRound 访问
    // 12 家（每家 sleep 900ms）→ 才开始偷」，几十秒过去了，
    // 解禁的货早被别人抢光。线上 2026-11-12 记下 250 处待解禁、偷到 0 件。
    const cands = waveTargets(memo.stealSchedule, memo.stealWatch, world.now, leadSec, 5, world.prices)
    if (cands.length) {
      log(`偷菜：${snipeReady ? '解禁时刻到了' : '有已解禁未处理的目标'}，直接抢这一波 ${cands.length} 家（不扫目录）`)
      // 用 visit 回来的最新地块数据**重算**这一家的解禁时刻，
      // 不能再拿 cands 里的旧记录：那是上一轮巡逻算的，岛日天气/连茬一变
      // 就对不上了。线上 11-13 的 33 次偷菜失败里有 21 次是
      // 「目标数据 0~8 秒前拿到，1 处」——访问刚拿到最新数据，提交时却用旧条目。
      const SNIPE_WAIT_MAX_SEC = 20
      // 掐点一律用服务端时钟（client 用每次带 now 的回执校准，误差几十毫秒），
      // 不能用 Date.now()：实测本地比服务端慢 1.10 秒，晚 1 秒就是「货 0 秒前被人拿走」。
      const serverNowSec = () => world.clockNowMs() / 1000
      const realNow = serverNowSec()
      const out = []
      const skipped = []
      for (const c of cands) {
        let info
        try { info = await visitInfo(world, c.targetId) } catch { continue }
        const rec = recordVisitSchedule(R, world, cfg, memo, c.targetId, info, c.level)
        // 服务端此刻已经标了 steal=true：不用等，立刻可以提交。
        let tg = targetFromVisit(R, world, cfg, info, {
          id: c.targetId, name: c.name, level: c.level || 1, guard: !!info.owner?.guard, at: realNow,
          // 掐点路径：提交前再确认一次服务端的 steal 标记（见 stealFromTargets）。
          snipe: true,
        })
        if (!tg) {
          // 提前量到场时，这几处往往还没到解禁（服务端 steal=false），
          // 只认 targetFromVisit 会整波丢掉——用 visit 刷新后的 upcoming 重建。
          const fresh = (rec?.upcoming || []).map((u) => {
            const v = u.kind === 'plot' ? rec?.plots?.[u.i]?.value : rec?.pens?.[u.i]?.value
            return { ...u, value: Number(v) || 0 }
          })
          if (fresh.length) {
            const atFresh = Math.min(...fresh.map((u) => u.unlockAt))
            if (atFresh - realNow <= SNIPE_WAIT_MAX_SEC) {
              tg = targetFromSchedule(R, world, info, {
                ...c,
                entries: fresh,
                value: fresh.reduce((a, e) => a + e.value, 0),
                at: atFresh,
              })
            } else {
              // 刷新后解禁还在 20 秒以外：说明这一波是被旧记录提前叫醒的，
              // 等下去只会白占窗口（后面的目标会更晚），交给下一轮唤醒。
              skipped.push(`${c.name || c.targetId} ${Math.round(atFresh - realNow)} 秒`)
            }
          }
        }
        if (!tg) continue
        out.push(tg)
      }
      if (skipped.length) {
        log(`偷菜：${skipped.length} 家刷新后解禁还在 ${SNIPE_WAIT_MAX_SEC} 秒以外，本轮不等（${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? ' 等' : ''}）`)
      }
      if (out.length) {
        // 访问完全部岛时可能还没到解禁时刻：T_prep 是按访问耗时反推的，
        // 但 http 间隔和网络抖动都会带来偏差。早提交会被服务端判
        // steal=false 直接拒掉，所以宁可在这里等到点，也不发无效请求。
        const waveAt = Math.min(...out.map((o) => o.at).filter((x) => Number.isFinite(x)))
        const waitMs = Number.isFinite(waveAt)
          ? Math.round((waveAt - serverNowSec() + 0.3) * 1000)
          : 0

        // 战前准备：拉装备页 + 用对手档案模拟这一波每家的守家胜率。
        // 装备页是 GET（不节流），模拟是本地计算，几百毫秒内完成。
        const ctx = await prepareStealBattle(world, cfg, memo, out)
        const myLevel = memo.arenaLevel || 1
        const rankedPrep = out
          .map((t) => ({ t, ev: stealEV(t, myLevel, st.energyValue ?? 300) }))
          .sort((a, b) => b.ev - a.ev)
        const swap = ctx ? pickSwapTarget(rankedPrep) : null

        // 榜一 physical-prep：解禁前先把体力补够（一个 act POST），
        // 解禁那一刻只发 visit。补体力排在换装/买道具前面，三者都在等解禁之前。
        await preStageStamina(world, cfg, log, out, { label: `，${out.length} 家等解禁` })

        if (swap) {
          // 道具（24 小时有效）先买好，再换装，最后用剩余时间等解禁。
          // 三者都是串行 POST，顺序反过来会把换装挤到解禁之后。
          try { await ensureThiefItems(world, cfg, log) } catch {}
          const sleepUntilUnlock = async () => {
            const ms = Number.isFinite(waveAt)
              ? Math.round((waveAt - serverNowSec() + 0.3) * 1000)
              : 0
            if (ms > 0) {
              log(`偷菜：换好守家装，距解禁还有 ${(ms / 1000).toFixed(1)} 秒，等到点再动手`)
              await sleep(Math.min(ms, 30000))
            }
          }
          try {
            const rr = await executeWithTacticalLoadout({
              accountKey: ctx.accountKey,
              lockRoot: ctx.lockRoot,
              opponentId: swap.t.id,
              mode: 'guard',
              knownOpponentLevel: swap.t.level || null,
              storePath: ctx.storePath,
              precomputedDecision: swap.decision,
              getGearFn: gearFnFor(world),
              equipSlotFn: equipSlotFnFor(world),
              waitBeforeActionFn: sleepUntilUnlock,
              actionFn: async () => {
                try { return await stealFromTargets(world, cfg, log, memo, out, { tactical: false, ctx, energyPrepped: true }) }
                catch (e) { return { stolen: 0, value: 0, error: e } }
              },
              trials: ctx.trials,
              minGain: ctx.minGain,
              zThreshold: ctx.zThreshold,
            })
            if (rr?.result) {
              if (rr.result.error) log('偷菜出错：' + rr.result.error.message)
              if (!rr.restoreOk) log(`偷菜后恢复静止装失败（${rr.restoreError}），下次运行会先恢复`)
              return rr.result
            }
            // 换装没成功（preEquipError）：退回静止装路径，仍在窗口内就继续偷。
            log('偷菜：战前换装未完成，按静止装直接上')
          } catch (e) {
            log('偷菜：守家换装出错（' + e.message + '），按静止装直接上')
          }
        } else if (ctx?.simulated) {
          log(`偷菜：这波有 ${ctx.simulated} 家可按档案模拟守家，静止装已是最优或提升不显著，不换装`)
        }

        // 道具（24 小时有效）在等待期间先买好：解禁那一刻只发偷菜请求，
        // 别让一次买道具的 POST 把提交拖到窗口之后。
        if (waitMs > 3000) await ensureThiefItems(world, cfg, log)
        const leftMs = Number.isFinite(waveAt)
          ? Math.round((waveAt - serverNowSec() + 0.3) * 1000)
          : 0
        if (leftMs > 0) {
          log(`偷菜：访问完 ${out.length} 家，距解禁还有 ${(leftMs / 1000).toFixed(1)} 秒，等到点再动手`)
          // 上限 30 秒 = prepLeadSec 的上限。以前卡 15 秒，一波很多家时
          // 访问没跑完就到点，等待被截断、提前提交被服务端拒掉。
          await sleep(Math.min(leftMs, 30000))
        }
        return await stealFromTargets(world, cfg, log, memo, out, { ctx, energyPrepped: true })
      }
      // 到点了但货已经没了（被抢 / 被偷满）。把这些过时记录清掉，
      // 否则下一轮还是 overdue，主循环会被它反复催醒。
      for (const c of cands) {
        const rec = memo.stealSchedule?.[c.targetId]
        if (rec) rec.upcoming = (rec.upcoming || []).filter((u) => u.unlockAt > world.now)
      }
      // 全是被旧记录提前叫醒的（刷新后发现解禁还早）：这不是「没抢到」，
      // 不该据此放宽狙击节流——否则下一次真实解禁会被翻倍的间隔挡掉。
      return { stolen: 0, value: 0, staleWake: skipped.length > 0 }
    }
    // 没有可去的候选（记录刚好被 sweep 清掉）→ 落回正常流程
  }

  memo.stealScanAt = world.now
  // 先进 watchlist 看一批：它们带着「成熟 + 保护期」算出来的精确解禁时刻，
  // 是拿到「刚好解禁那几块地」的唯一途径；顺便也能捞到此刻就能偷的。
  await refreshWatchList(world, cfg, log, memo)
  const watched = await watchRound(world, cfg, log, memo)
  // 巡逻一旦撞见值得偷的就直接去了（watchRound 自己会早退），不再扫全服目录。
  if (watched.length) return await stealFromTargets(world, cfg, log, memo, watched)
  const scanned = await scanStealTargets(world, cfg, log, memo)
  return await stealFromTargets(world, cfg, log, memo, scanned)
}

/**
 * 一次偷菜的期望收益在 steal-schedule.mjs 里（扫描、巡逻、调度预筛共用同一份），
 * 这里直接 import 使用。
 */

/**
 * 掐点目标要不要在提交前再 GET 一次确认。
 *
 * 确认为 true 的条件：目标是「掐点/调度推算」出来的（解禁时刻由本地算，
 * 不是服务端确认的），并且已经接近/过了推算的解禁时刻。
 * 抽成纯函数只是为了可测——逻辑本身两行。
 */
export function shouldConfirmSnipe(tg, clock) {
  return Boolean((tg?.snipe || tg?.scheduled) && Number(tg?.at) > 0 && clock >= tg.at - 1.5)
}

/** 挨个偷。抽出来是因为「巡逻发现的」和「全量扫描发现的」走同一套逻辑。 */
async function stealFromTargets(world, cfg, log, memo, targets, { tactical = true, ctx = null, energyPrepped = false } = {}) {
  const st = cfg.social?.steal
  const R = world.R
  let stolen = 0, value = 0, tried = 0
  // 打输要按市价 1.2 倍赔（单次上限 fineMax、每日上限由服务端管）。
  // 以前只把金额打进日志，账本里完全不记，GUI 的「今日收支」会高估净收益，
  // 严重时（单次 5,000、每日 20,000）能差出好几万。
  let fine = 0
  // 有目标但一个都偷不了时，说明是体力不够。要说明白，
  // 否则日志里只有「找到 N 家可偷」然后什么都没发生，看不出原因。
  let starved = 0
  // 我的等级：对手档案缺失时用它估算守家胜率（旧版 myWhale 缓存 10 分钟）。
  // arenaDaily 每轮都会跑，等级写在 memo.arenaLevel 里；没有就当 1 级（保守）。
  const myLevel = memo.arenaLevel || 1
  const energyValue = st.energyValue ?? 300
  const minEV = st.minEV ?? st.minValue ?? 3000
  // 有档案就按模拟出的赢/平/输三结局算期望；没有档案的目标仍用等级差公式。
  const bc = ctx || await prepareStealBattle(world, cfg, memo, targets)
  const blockSec = bc?.blockSec ?? 600
  // 按期望收益从高到低排。
  //
  // 以前是按「扫描/巡逻返回的顺序」（目录顺序）去偷，体力又受 visitsPerScan
  // 上限约束，等于随机挑几家——同样的体力可能全花在萝卜上，而隔壁岛上
  // 就有一片葡萄。榜一 snipe-scheduler 选目标是按 projectedScore（四结局
  // 期望）降序，我们的 stealEV 已经是同一个模型，只是一直没拿它排序。
  const ranked = targets
    .map((t) => ({ t, ev: stealEV(t, myLevel, energyValue) }))
    .sort((a, b) => b.ev - a.ev)
  // 真要去偷之前把道具补齐：轻步斗篷（被发现率 −10 个百分点）、
  // 折叠菜篮（每处多拿 1 个）。旧版有这一步，新版漏了。
  // 体力不够但能靠口粮补上的也算「值得」——偷菜本身会现场补体力。
  const canPay = (needE) => world.state.en >= needE || !!energyActions(R, world.state, world.prices, {
    need: needE, maxPerE: st.maxEnergyCost ?? 600, cfg, coins: world.coins,
  })
  const worth = ranked.some(({ t, ev }) => ev >= minEV && canPay(Math.min(t.energy, st.maxEnergy ?? 15)))
  // 巡逻/扫描发现的（非掐点路径）也要在动手前一次性把体力补够：
  // 循环里按目标逐次补体力，每个都占一个 2.15 秒的 POST 间隔。
  // 掐点路径已经在等解禁时补过（energyPrepped），不重复。
  if (worth && !energyPrepped) {
    await preStageStamina(world, cfg, log, ranked.map(({ t }) => t), { label: '（巡逻发现）' })
  }
  if (worth) await ensureThiefItems(world, cfg, log)

  // 真正动手的那段。抽成闭包是为了能整体套在「换装 → 偷 → 还原」里：
  // finally 一定会把静止防守装换回去，不会被中途的异常绕过。
  const runSteals = async () => {
    let skippedEV = 0
    for (const entry of ranked) {
      let tg = entry.t
      let ev = entry.ev
      if (tried >= (st.visitsPerScan ?? 8)) break
      // 冷却 / 负期望封禁期内跳过。打输后只冷却几秒——下一轮会用刚拿到的
      // 战报重算后验，打不过才升级成 blockSec 的长期封禁。
      if (stealBlockedUntil(memo, tg.id) > world.now) continue
      // 掐点目标的解禁时刻是本地推算的（成熟 + 保护期）。天气翻转、岛主临时
      // 浇水、或者别人抢先，都会让它失准；而一次失败的 visit 提交要占掉
      // 2.15 秒的 POST 间隔——在解禁瞬间，这 2.15 秒就是下一家（甚至同一家
      // 第二处）的窗口。提交前先 GET 一次（不节流、不花体力），用服务端此刻
      // 的 steal 标记校准：能偷就按最新 targets 提交，不能偷就跳过并留待下轮。
      // 线上 11-12~14 每天有 25~59 次「TA 家现在没有能偷的」白撞，一半的
      // 提交槽位浪费在这里。
      if (shouldConfirmSnipe(tg, world.tickClock())) {
        const clock = world.tickClock()
        let info = null
        try { info = await visitInfo(world, tg.id) } catch { /* GET 失败就按原计划提交 */ }
        if (info) {
          const fresh = targetFromVisit(R, world, cfg, info, {
            id: tg.id, name: tg.name, level: tg.level || 1, guard: !!info.owner?.guard,
          })
          if (!fresh) {
            log(`偷 ${tg.name}：服务端说还没解禁（本地推算 ${Math.round(clock - tg.at)} 秒前到点），跳过`)
            continue
          }
          tg = fresh
          ev = stealEV(tg, myLevel, energyValue)
        }
      }
      const needE = Math.min(tg.energy, st.maxEnergy ?? 15)
      // 期望收益（旧版 inspect() 的 ev）：货值 × 不被发现的概率 + 被发现后的
      // 「打赢多得 1 个 / 打输按 1.2 倍赔款」的期望 − 体力机会成本。
      // 只比货值是不够的——守家比我们强时，去一趟就是白送罚金。
      // ev 在排序时已经算过一次，这里直接复用。
      if (ev < minEV) {
        skippedEV++
        if (ev < 0 && tg.guard) {
          const s = stealStateOf(memo, tg.id, true)
          s.blockedUntil = world.now + blockSec
          s.blockedReason = 'negative-ev'
        }
        continue
      }
      // 体力不够这一家：现场补。这是旧版 energyActions 的用法——
      // 偷菜是掐着解禁时刻的机会，错过这次这块地要再等半小时保护期，
      // 而补体力只要几十上百 D。上限 steal.maxEnergyCost 防止口粮太贵时倒亏。
      if (world.state.en < needE) {
        const acts = energyActions(R, world.state, world.prices, {
          need: needE, maxPerE: st.maxEnergyCost ?? 600, cfg, coins: world.coins,
        })
        if (!acts?.length) { starved++; continue }
        try {
          const beforeE = Math.floor(world.state.en)
          const r = await world.act(acts, { silent: true })
          const ok = (r.out || []).filter((o) => o?.ok).length
          if (ok) log(`  偷 ${tg.name} 体力不够（${beforeE} < ${needE}），吃口粮补到 ${Math.floor(world.state.en)}（花 ${Math.round(r.spend || 0).toLocaleString('en-US')} D）`)
        } catch (e) { log(`  偷 ${tg.name} 补体力失败：${e.message}`) }
        if (world.state.en < needE) { starved++; continue }
      }
      tried++
      let skipAdvance = false
      try {
        const r = await stealIsle(world, tg.id)
        const res = r.result || {}
        // 拿到一次成功回执：清掉 409 边界重试的标记，下次卡边界还能再重试一次。
        const osOk = stealStateOf(memo, tg.id)
        if (osOk?.earlyRetry) osOk.earlyRetry = 0
        const unitOf = (id) => world.prices[id] || R.BASE_PRICE[id] || 0
        const nameOf = (id) => R.ITEM_NAME?.[id] || id

        if (res.outcome === 'win') {
          // 服务端返回 res.items = [[id, n], ...]，可能不止一种货
          const items = res.items?.length ? res.items : (res.item ? [[res.item, res.n || 1]] : [])
          const spots = res.spots || tg.targets?.length || 1
          let thisValue = 0
          for (const [id, n] of items) thisValue += unitOf(id) * n
          stolen += spots
          value += thisValue

          // 明细：偷了谁、几处、每样东西多少件、单价、合计
          const detail = items.map(([id, n]) => {
            const u = unitOf(id)
            return `${nameOf(id)}×${n}（${Math.round(u).toLocaleString('en-US')} D/个 = ${Math.round(u * n).toLocaleString('en-US')} D）`
          }).join('　')
          log(`偷 ${tg.name}（Lv${tg.level}${tg.guard ? '·有守家' : ''}）成功：扫 ${spots} 处 → ${detail || `共 ${res.n || 1} 件`}｜合计 ${Math.round(thisValue).toLocaleString('en-US')} D`)
          if (r.battle) {
            const b = r.battle
            const won = battleOutcomeOf(b) === 'win' || res.outcome === 'win'
            log(`  守家战${won ? '打赢了' : '打完'}：${b.log?.slice?.(-1)?.[0] || ''}${res.xp ? `，+${res.xp} 擂台经验` : ''}`.trim())
          }
        } else if (res.outcome === 'lose') {
          const spots = res.spots || 1
          fine += Number(res.fine) || 0
          // 真正要不要封禁由下面的「重算」决定：先按刚拿到的战报重算 EV，
          // 仍为负才冷 blockSec，否则过几秒还能再试（榜一 lose 分支）。
          log(`偷 ${tg.name}（Lv${tg.level}）被守家鱼打跑：${spots} 处一个没拿到` +
            (res.fine ? `，按市价 1.2 倍赔 ${Math.round(res.fine).toLocaleString('en-US')} D` : '（主人今天罚款已到上限，这次没赔钱）'))
        } else {
          log(`偷 ${tg.name}（Lv${tg.level}）打平：${res.spots || 1} 处，谁也没占便宜`)
        }
        // 每次守家战都是一份免费的战报：B（守家方）的面板直接进档案，
        // 下次偷这家之前就能先模拟，而不是再来一次盲打。
        if (r.battle && bc?.storePath) {
          try { recordBattleSnapshot(r.battle, 'guard', { storePath: bc.storePath }) } catch {}
        }
        // 战绩 + 冷却：真实胜负按 guard 模式记进档案（下次后验会混合经验胜率），
        // 并按结果更新这座岛的状态。结果优先用服务端的 res.outcome；
        // 没带就按「拿到货 / 赔了罚款」推断（榜一 recordReconciledVisit 的
        // reconcile 思路）。战报里的 win 视角不确定（攻方/守方），不用来推断，
        // 推断不出来就不猜。
        let outcome = (res.outcome === 'win' || res.outcome === 'lose' || res.outcome === 'draw')
          ? res.outcome
          : null
        let reconciled = false
        if (!outcome) {
          if (Number(res.fine) > 0) outcome = 'lose'
          else if (res.items?.length || res.item) outcome = 'win'
          reconciled = Boolean(outcome)
        }
        if (reconciled) log(`  （结果未明，按${outcome === 'win' ? '战利品' : outcome === 'lose' ? '罚款' : '战报'}推断为 ${outcome}）`)
        if (outcome && (tg.guard || r.battle)) {
          const os = stealStateOf(memo, tg.id, true)
          if (bc?.storePath) {
            try {
              noteBattleOutcome(tg.id, outcome, {
                mode: 'guard',
                storePath: bc.storePath,
                // 没有守家目标时 prepareStealBattle 会把 pWin 填成 1（占位），
                // 那不是模拟结果，不能当赛前预测存进档案。
                predicted: tg.guard && Number.isFinite(tg.pWin)
                  ? { winRate: tg.pWin, drawRate: tg.pDraw, lossRate: tg.pLoss }
                  : null,
                atSec: world.now,
              })
            } catch { /* 档案写失败不影响这一轮偷菜 */ }
          }
          if (outcome === 'win') {
            // 打赢就完全清零并删掉这条：状态本身没有信息量了（战绩在档案里），
            // 留着只会让 state.json 随着访问过的岛越堆越大。
            os.lossCount = 0
            os.lastLossAt = 0
            os.needSync = false
            os.cooldownUntil = 0
            os.blockedUntil = 0
            os.blockedReason = ''
            delete memo.stealState?.[String(tg.id)]
          } else if (outcome === 'lose') {
            os.lossCount = (os.lossCount || 0) + 1
            os.lastLossAt = world.now
            // 战报没带对方面板 → 下次动手前先补一次守家日志再模拟。
            os.needSync = !r.battle
            os.cooldownUntil = world.now + (bc?.lossCooldownSec ?? 5)
            // 立即用新面板重算。recordBattleSnapshot 已经写进了新的 updatedAt，
            // 模拟缓存 key 变了，这里拿到的是真·新结果而不是复用的旧决策。
            let rePost = null
            if (bc?.gear) {
              try {
                rePost = computeGuardPosteriorForTarget(bc.gear, tg.id, {
                  knownOpponentLevel: tg.level || null,
                  storePath: bc.storePath,
                  trials: bc.trials,
                  minGain: bc.minGain,
                  zThreshold: bc.zThreshold,
                  recordPrior: bc.recordPrior,
                })
              } catch { /* 单条档案坏了不影响冷却逻辑 */ }
            }
            if (rePost) {
              const oldWin = tg.pWin
              tg.pWin = rePost.winRateMid
              tg.pLoss = rePost.lossRateMid
              tg.pDraw = rePost.drawRate
              tg._post = rePost
              const reEv = stealEV(tg, myLevel, energyValue)
              const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`
              if (reEv < minEV) {
                os.blockedUntil = world.now + blockSec
                os.blockedReason = 'negative-ev-after-loss'
                log(`  重算：胜率 ${pct(oldWin)} → ${pct(rePost.winRateMid)}，` +
                  `EV ${Math.round(reEv).toLocaleString('en-US')} D 仍不划算，${Math.round(blockSec / 60)} 分钟内不再来`)
              } else {
                log(`  重算：胜率 ${pct(oldWin)} → ${pct(rePost.winRateMid)}，` +
                  `EV ${Math.round(reEv).toLocaleString('en-US')} D 仍为正，${Math.round(bc?.lossCooldownSec ?? 5)} 秒后可再试`)
              }
            } else {
              // 拿不到面板就没法判断，保守地沿用旧的封禁逻辑。
              os.blockedUntil = world.now + blockSec
              os.blockedReason = 'loss-no-panel'
            }
          } else {
            os.cooldownUntil = world.now + (bc?.drawCooldownSec ?? 4)
          }
        }
        if (r.energy != null) {
          const spent = (world.state.en || 0) - r.energy
          log(`  体力 ${Math.round(world.state.en)} → ${r.energy}${spent > 0 ? `（−${Math.round(spent)}）` : ''}`)
          world.state.en = r.energy
        }
      } catch (e) {
        // 最常见的两种：409/「TA 家现在没有能偷的」= 被别人抢先；
        // 403/401 = cookie 失效。把状态码和「这份数据是几秒前的」都打出来，
        // 否则日志里只有一句话，分不清是程序 bug 还是竞争。
        // 时差一律按 tickClock()（此刻）算：world.now 是上次 refresh 的时刻，
        // 拿它减 seenAt 会得到 0 甚至负数，日志里永远是「目标数据 0 秒前拿到」。
        const clock = world.tickClock()
        const age = Math.max(0, Math.round(clock - (tg.seenAt || clock)))
        const since = tg.at ? `，到点${clock >= tg.at ? '后' : '前'} ${Math.abs(Math.round(clock - tg.at))} 秒` : ''
        log(`偷 ${tg.name} 出错${e.status ? `（HTTP ${e.status}）` : ''}：${e.message}` +
          `｜目标数据 ${age} 秒前拿到，${tg.targets?.length || 0} 处${since}`)
        // 回执分类（见 classifyStealReject）：
        //   · 「上限/今天偷过/新手」= 服务端按自然日封顶 → 封到次日 0 点；
        //   · 409 卡在推算解禁时刻 ±2 秒 = 时钟截断抖动 → 1 秒后再试一次，
        //     别当成「这一波没了」推进到下一波；
        //   · 其余拒绝（最常见是「没有能偷的」= 被别人抢先/刚被收）→ 90 秒冷却。
        const os = stealStateOf(memo, tg.id, true)
        const k = classifyStealReject({
          status: e.status, message: String(e.message || ''), clock,
          expectedAt: Number(tg.at) || 0, earlyRetry: Boolean(os.earlyRetry),
        })
        if (k.kind === 'daily-cap') {
          os.blockedUntil = Math.max(os.blockedUntil || 0, k.until)
          os.blockedReason = 'server-daily-cap'
          const rec = memo.stealSchedule?.[tg.id]
          if (rec) { rec.upcoming = []; rec.waves = []; rec.nextAt = 0 }
        } else if (k.kind === 'boundary-retry') {
          os.earlyRetry = 1
          os.cooldownUntil = Math.max(os.cooldownUntil || 0, clock + 1)
          skipAdvance = true
          if (memo.stealSchedule?.[tg.id]) memo.stealSchedule[tg.id].nextAt = k.retryAt
        } else {
          os.cooldownUntil = Math.max(os.cooldownUntil || 0, k.until)
          os.blockedReason = 'rejected'
        }
      }
      // 这座岛已经处理过了：推进到排好的下一波（多波次），没有就清空。
      // 不清的话 nextWake 会一直把它当成「马上要解禁」来唤醒。
      // 以前这里直接 `rec.upcoming = []`——第二批成熟的作物因此只能等
      // 下一次全量巡逻（默认 30 分钟）才会被重新发现，通常早被别人偷了。
      // 409 边界重试是「同一波再来一次」，不是「这波结束」，所以不推进。
      if (!skipAdvance && memo.stealSchedule && memo.stealSchedule[tg.id]) {
        const rec = memo.stealSchedule[tg.id]
        const completedAt = Number(rec.nextAt) || 0
        const more = advanceIsleWave(rec, world.now, { completedAt })
        if (more && rec.upcoming?.length) {
          log(`  ${tg.name} 还有下一波：${rec.upcoming.length} 处，` +
            `${Math.max(0, Math.round(rec.nextAt - world.now))} 秒后解禁（已排进调度表）`)
        }
      }
      await sleep(1500)
    }
    return { stolen, value, fine, skippedEV }
  }

  // 全量扫描/巡逻发现的目标通常「现在就能偷」，换装时间来得及。
  // 掐点路径（stealRound）会在等待解禁期间就完成换装，传 tactical:false，
  // 避免在解禁之后再花几秒换装备。
  const swap = tactical && bc ? pickSwapTarget(ranked) : null
  let runRes
  if (swap) {
    try {
      const rr = await executeWithTacticalLoadout({
        accountKey: bc.accountKey,
        lockRoot: bc.lockRoot,
        opponentId: swap.t.id,
        mode: 'guard',
        knownOpponentLevel: swap.t.level || null,
        storePath: bc.storePath,
        precomputedDecision: swap.decision,
        getGearFn: gearFnFor(world),
        equipSlotFn: equipSlotFnFor(world),
        actionFn: runSteals,
        trials: bc.trials,
        minGain: bc.minGain,
        zThreshold: bc.zThreshold,
      })
      if (rr?.result) runRes = rr.result
      if (rr && !rr.restoreOk) log(`偷菜后恢复静止装失败（${rr.restoreError}），下次运行会先恢复`)
      if (!runRes) {
        log('偷菜：战前换装未完成，按静止装直接上')
        runRes = await runSteals()
      }
    } catch (e) {
      // 锁被别的进程占住（超时）时动作还没跑，可以安全地退回静止装；
      // 其他异常多半发生在偷菜过程中，stolen/value 已按实情累加，不再重跑。
      if (/换装锁/.test(e.message || '')) {
        log('偷菜：换装锁被占用，按静止装直接上')
        runRes = await runSteals()
      } else {
        log('偷菜：守家换装出错（' + e.message + '）')
        runRes = { skippedEV: 0 }
      }
    }
  } else {
    runRes = await runSteals()
  }
  const skippedEV = runRes?.skippedEV || 0

  if (stolen) log(`本轮偷菜小结：${stolen} 处，${Math.round(value).toLocaleString('en-US')} D（去了 ${tried} 家）`)
  else if (tried) log(`本轮偷菜：去了 ${tried} 家，没有收获`)
  else if (starved) {
    const costs = targets
      .filter((t) => t.value >= minEV)
      .map((t) => Math.min(t.energy, st.maxEnergy ?? 15))
    const cheapest = costs.length ? Math.min(...costs) : (st.maxEnergy ?? 15)
    log(`偷菜：${starved} 家可偷但体力不够（当前 ${Math.floor(world.state.en)}，最便宜要 ${cheapest} 点，` +
      `口粮补不上或每点超过 ${st.maxEnergyCost ?? 600} D）`)
  } else if (skippedEV) {
    log(`偷菜：${skippedEV} 家有货但期望收益不够（发现率/守家胜率/体力成本折算后 < ${minEV} D），不去`)
  }
  return { stolen, value, fine, skippedEV }
}
