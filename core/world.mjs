// 世界状态：拉取、缓存、订阅、动作提交。
// 所有本地预演都用站点的 applyActions，和真实结算一致。
import { randomUUID } from 'node:crypto'
import * as RL from './rules.mjs'

const fmt = (n) => Math.round(n).toLocaleString('en-US')

export class World {
  constructor(client, log = () => {}) {
    this.client = client
    this.log = log
    this.state = null      // state
    this.rev = 0
    this.coins = 0
    this.prices = {}
    this.now = 0
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

  /** 应用服务端返回的世界快照 */
  accept(j) {
    if (!j || !j.state) return this
    if (j.clockStart && j.clockStart !== this.clockStart) {
      this.clockStart = j.clockStart
      RL.configureClock(j.clockStart)
    }
    this.state = j.state
    if (j.rev != null) this.rev = j.rev
    if (j.coins != null) this.coins = j.coins
    if (j.prices) this.prices = j.prices
    if (j.now) this.now = j.now
    this.fetchedAt = Date.now()
    return this
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

  /** 提交动作（自动分批、自动处理 409） */
  async act(actions, { silent = false } = {}) {
    const R = this.R
    if (!actions.length) return { out: [], spend: 0, earn: 0 }
    const batches = []
    const max = R.WORLD.maxActions
    for (let i = 0; i < actions.length; i += max) batches.push(actions.slice(i, i + max))

    const all = { out: [], spend: 0, earn: 0, xp: 0, tax: 0 }
    for (const batch of batches) {
      const j = await this.client.act(this.rev, batch, randomUUID())
      this.accept(j)
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
    const names = { plant: '种植', water: '浇水', harvest: '收获', clear: '清理', feed: '喂食', pet: '摸摸', collect: '收产物', trap: '收蟹笼', fish: '钓鱼', mine: '挖矿', bomb: '炸矿', craft: '加工', sell: '卖出', buy: '购买', upgrade: '升级', expand: '扩建', buyTrap: '买蟹笼', buyAnimal: '买动物', sellAnimal: '卖动物', goal: '领目标', coffee: '喝咖啡', eat: '进食', stockBuy: '货船进货', npc: '52弟', scratch: '刮刮乐', lotto: '彩票', warehouse: '囤货', nightClaim: '夜潮', storyRead: '纪事', guardRefund: '守家补偿' }
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
