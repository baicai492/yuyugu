// 世界状态：拉取、缓存、订阅、动作提交。
// 所有本地预演都用站点的 applyActions，和真实结算一致。
import { randomUUID } from 'node:crypto'
import * as RL from './rules.mjs'

const fmt = (n) => Math.round(n).toLocaleString('en-US')

// 手动游乐馆的兜底 TTL：Esc 退出时前端不会发 arcEnd，state.arc.cur 会永久残留。
// 180 秒和站点 MIN_PLAY（最长 8 秒）+ 正常一局时长相比已经很宽松。
const MANUAL_ARCADE_TTL = 180

export class World {
  constructor(client, log = () => {}) {
    this.client = client
    this.log = log
    this.state = null      // state
    this.rev = 0
    // 串门接口（visit/help）返回的 state 是「对方岛」的，rev 也随之作废。
    // 标脏后，下一次 act() 前必须先重新拉自家世界状态（见 social.mjs 的说明）。
    this.revDirty = false
    this.coins = 0
    this.prices = {}
    this.now = 0
    this.snapshotNow = 0   // 最近一次快照里的服务端时间
    this.clockOffset = 0   // 服务端时间 − 本地时间（秒），每次 accept 校准
    this.clockStart = 0
    this.fetchedAt = 0
    this.lastOut = []
    this.tax = null
  }

  get R() { return RL.rules() }
  get ready() { return !!this.state }
  get isleDay() { return this.R.isleDay(this.now) }
  get isleIndex() { return this.R.isleIndex(this.now) }
  get season() { return this.R.seasonOf(this.isleDay) }
  get weather() { return this.R.weatherOf(this.isleDay) }
  get energyMax() { return this.R.energyMax(this.state) }

  /**
   * 有没有人在浏览器里手操游乐馆。
   *
   * `/isle-arcade.js` 在 arcStart 时把当时的 world.rev 记在前端，arcEnd 用这个**旧 rev**
   * 提交；期间只要后台有任何写入推进了 rev，服务端就回 409 world_conflict，而前端
   * **不会自动重试**——玩家这一局直接作废（次数还照扣）。所以检测到 state.arc.cur
   * 时后台必须停止一切写入，等 cur 被 arcEnd 清掉再恢复。
   *
   * t 是服务端 arcStart 的处理时刻；Esc 退出不会发 arcEnd，用 TTL 兜底。
   * @returns {{active:boolean,game:string,startedAtSec:number,elapsedSec:number,remainingSec:number,resumeAtSec:number,ttlSec:number}}
   */
  manualArcade(now = this.now, ttlSec = this.manualArcadeTtlSec ?? MANUAL_ARCADE_TTL) {
    const ttl = Math.max(10, Number(ttlSec) || MANUAL_ARCADE_TTL)
    const idle = { active: false, game: '', startedAtSec: 0, elapsedSec: 0, remainingSec: 0, resumeAtSec: 0, ttlSec: ttl }
    const cur = this.state?.arc?.cur
    const startedAtSec = Math.floor(Number(cur?.t || 0))
    if (!cur || typeof cur !== 'object' || startedAtSec <= 0) return idle
    const refNow = Math.floor(Number(now ?? this.now ?? startedAtSec) || startedAtSec)
    const resumeAtSec = startedAtSec + ttl
    const remainingSec = Math.max(0, resumeAtSec - refNow)
    return {
      active: refNow < resumeAtSec,
      game: typeof cur.g === 'string' && cur.g ? cur.g : 'unknown',
      startedAtSec,
      elapsedSec: Math.max(0, refNow - startedAtSec),
      remainingSec,
      resumeAtSec,
      ttlSec: ttl,
    }
  }

  /**
   * 当前 arc.cur 是不是**我们自己开的**那一局。
   * arcadeRound 在 arcStart 之后、arcEnd 之前设置 this.ourArcade；这期间写入必须放行，
   * 否则托管会被自己刚开的局挡住。
   */
  ourArcadeHeld() {
    const ours = this.ourArcade
    if (!ours) return false
    const cur = this.state?.arc?.cur
    // 刚 start、快照还没同步到 cur：按自己的局处理（求解只要几十秒，
    // 这段时间不可能有第二个人在同一账号上开局）
    if (!cur) return true
    return cur.g === ours.g && Number(cur.seed) === Number(ours.seed)
  }

  /** 应用服务端返回的世界快照 */
  accept(j) {
    if (!j || !j.state) return this
    if (j.clockStart && j.clockStart !== this.clockStart) {
      this.clockStart = j.clockStart
      RL.configureClock(j.clockStart)
    }
    this.state = j.state
    if (j.rev != null) {
      this.rev = j.rev
      // 拿到带 rev 的自家快照，「状态已过期」的标记就可以清了。
      this.revDirty = false
    }
    if (j.coins != null) this.coins = j.coins
    if (j.prices) this.prices = j.prices
    if (j.now) {
      this.now = j.now
      this.snapshotNow = j.now
      // 服务端时间与本地时钟的偏移。之后 tickClock() 用它把 now 往前推，
      // 不必等下一次网络往返——偷菜掐点依赖「此刻」而不是「上次拉取时」。
      // 误差约一个 RTT，秒级决策可以接受。
      this.clockOffset = j.now - Date.now() / 1000
    }
    this.fetchedAt = Date.now()
    return this
  }

  /**
   * 把 now 推进到「当前」。
   *
   * w.now 原本只在 accept() 时更新。可是一次巡视可能跑几分钟（扫目录、
   * 擂台 30 场），等走到偷菜段时 now 还是几分钟前的——掐点判断会以为
   * 「还没到解禁时刻」，实际早过了。这里用本地时钟 + 校准偏移补上。
   *
   * 只往前推，不往回退：服务端快照里的时间永远是下界。
   */
  tickClock() {
    if (!this.snapshotNow) return this.now
    const est = Math.floor(Date.now() / 1000 + (this.clockOffset || 0))
    if (est > this.now) this.now = est
    return this.now
  }

  async refresh() {
    const j = await this.client.world()
    this.accept(j)
    return this
  }

  /** 本地克隆 + 预演（rand 固定 0.5，只用于确定性部分） */
  preview(actions, { coins, now } = {}) {
    const R = this.R
    const t = now ?? this.now
    const s = structuredClone(this.state)
    const r = R.applyActions(s, actions, {
      t, day: R.worldDay(t), rand: () => 0.5,
      prices: this.prices, coins: coins ?? this.coins,
    })
    return { state: s, out: r.out, spend: r.spend, earn: r.earn, xp: r.xp, tax: r.tax || 0 }
  }

  /** 提交动作（自动分批；409 冲突抛给调用方，由引擎用响应里的新快照重新规划） */
  async act(actions, { silent = false } = {}) {
    const R = this.R
    if (!actions.length) return { out: [], spend: 0, earn: 0 }
    // 手动游乐馆：别人正在手操时，任何写入都会让他的 arcEnd 因 rev 过期被判 409
    // （前端不重试，这局白玩）。托管自己开的局（ourArcade）放行。
    const ma = this.manualArcade(this.now)
    if (ma.active && !this.ourArcadeHeld()) {
      const err = new Error(`游乐馆手操中（${ma.game}，剩 ${ma.remainingSec} 秒），后台暂停写入`)
      err.name = 'ManualArcadeError'
      err.manualArcade = ma
      throw err
    }
    // 刚串门/帮过忙：手里的 state 和 rev 都是对方岛的，直接发动作必被 409 打回。
    // 先重新拉一次自家世界状态（一次 GET，代价远小于一轮动作全部作废）。
    if (this.revDirty) await this.refresh()
    const batches = []
    const max = R.WORLD.maxActions
    for (let i = 0; i < actions.length; i += max) batches.push(actions.slice(i, i + max))

    const all = { out: [], spend: 0, earn: 0, xp: 0, tax: 0 }
    for (const batch of batches) {
      const j = await this.client.act(this.rev, batch, randomUUID())
      this.accept(j)
      // 站内管家代替我们跑了巡视：它会和托管抢体力。
      // 05a5c445 起 AUTO.fee=0、surcharge=0（cache/rules-05a5c445.mjs:1021），
      // 管家已不抽成；旧版日志里的「抽 20% 代卖费」不再成立。
      if (j.autoLog?.visits && this.autoLogNotedDay !== this.R.worldDay(this.now)) {
        this.autoLogNotedDay = this.R.worldDay(this.now)
        this.log(`站内管家补算了 ${j.autoLog.visits} 轮巡视（建议在游戏里关掉管家，避免和托管抢体力）`)
      }
      const out = j.out || []
      all.out.push(...out)
      all.spend += j.spend || 0
      all.earn += j.earn || 0
      all.xp += j.xp || 0
      // 税只在单条动作里（out[i].tax = gross − earn），响应体顶层根本没有 tax 字段。
      // 以前写的是 all.tax += j.tax || 0 —— 永远是 undefined → 0，
      // 于是「今日卖货税」一直显示 0（实测卖 1,197 D 扣 36 D 税，GUI 记成 0）。
      all.tax += out.reduce((a, o) => a + (o?.tax || 0), 0)
      this.lastOut = out
      if (!silent) this.logActions(batch, out)
    }
    return all
  }

  logActions(batch, out) {
    const R = this.R
    const names = { plant: '种植', water: '浇水', harvest: '收获', clear: '清理', feed: '喂食', pet: '摸摸', collect: '收产物', trap: '收蟹笼', fish: '钓鱼', mine: '挖矿', bomb: '炸矿', craft: '加工', sell: '卖出', buy: '购买', upgrade: '升级', expand: '扩建', buyTrap: '买蟹笼', buyAnimal: '买动物', sellAnimal: '卖动物', goal: '领目标', coffee: '喝咖啡', eat: '进食', stockBuy: '货船进货', npc: '52弟', scratch: '刮刮乐', lotto: '彩票', warehouse: '囤货', nightClaim: '夜潮', storyRead: '纪事', guardRefund: '守家补偿',
      // 囤货仓库 b26
      whUp: '仓库升级', whOrder: '到价出售', whAlert: '到价提醒',
      // 游乐馆
      arcStart: '游乐馆开局', arcEnd: '游乐馆结算',
      // 修仙 2.0
      xsTalk: '叙话', xsGift: '赠礼', xsChap: '往事', xsEvroll: '机缘', xsEvpick: '机缘抉择',
      xsTasks: '领委托', xsTask: '交委托', xsStipend: '领俸禄', xsSlots: '配招', xsPeek: '观气',
      xsAb: '自动斗法', xsRin: '入秘境', xsRgo: '秘境前进', xsRbuy: '秘境购物', xsRout: '撤出秘境' }
    const ok = {}, fail = {}, got = {}
    let earn = 0, spend = 0, tax = 0
    out.forEach((o, k) => {
      const a = batch[k] || {}
      const key = names[a.a] || a.a
      if (o?.ok) {
        ok[key] = (ok[key] || 0) + 1
        earn += o.earn || 0; spend += o.spend || 0; tax += o.tax || 0
        // 关键：把「具体拿到了什么」捞出来（旧版日志就是靠这个写得详细）
        for (const g of o.got || []) {
          const nm = (R.ITEM_NAME?.[g.id] || g.id) + (g.q ? '★'.repeat(g.q) : '')
          got[nm] = (got[nm] || 0) + (g.n || 1)
        }
      } else if (o?.msg) {
        fail[key + '：' + o.msg] = (fail[key + '：' + o.msg] || 0) + 1
      }
    })
    const kv = (o) => Object.entries(o).map(([k, n]) => `${k}×${n}`).join(' ')
    let line = `提交 ${batch.length} 条：${kv(ok) || '全部失败'}`
    if (earn) line += `｜收入 ${fmt(earn)}`
    if (tax) line += `（已扣税 ${fmt(tax)}）`
    if (spend) line += `｜支出 ${fmt(spend)}`
    if (Object.keys(got).length) line += `｜获得 ${kv(got)}`
    if (Object.keys(ok).length || Object.keys(fail).length) this.log(line)
    for (const [k, n] of Object.entries(fail)) this.log(`  未成功 ${n} 次 → ${k}`)
  }

  // ---------- 常用派生量 ----------
  /** 当前可卖库存（扣除仓库预留） */
  available(id, q) { return this.R.b12Available(this.state, id, q) }
  vault(id, q) { return this.state.b12?.vault?.[id]?.[q] || 0 }

  /** 库存按当前价估值（含仓库） */
  stockValue() {
    let v = 0
    for (const [id, qs] of Object.entries(this.state.inv || {})) {
      const p = Number(this.prices[id]) || 0
      qs.forEach((n, q) => { v += n * p * this.R.QUALITY[q] })
    }
    return v
  }

  /** 岛日剩余额度 */
  quota(key) {
    const R = this.R, iq = this.state.iq
    const used = (iq && iq.d === this.isleIndex) ? (iq[key] || 0) : 0
    return Math.max(0, (R.WORLD.daily[key] || 0) - used)
  }

  /** 自然日计数 */
  dayCount(key) { return (this.state.cnt || {})[key] || 0 }
}
