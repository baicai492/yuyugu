// 规划器：输入世界快照，输出本轮要提交的动作。
// 纯函数，不做网络请求；所有决策先在规则的本地副本上预演一遍。
//
// 设计原则：
//   1. 先做「确定性正收益」的事（收获、收产物、喂食、收蟹笼、领奖、夜潮）
//   2. 再花体力做「单位体力收益最高」的事（钓/挖/炸），直到体力或额度用尽
//   3. 卖货只在价格接近未来峰值时做，并尊重阶梯价与累进税
//   4. 投资只看回本周期
import * as M from './market.mjs'
import { planVault } from './warehouse.mjs'
import { nextUnlock } from './steal-schedule.mjs'

const clone = (x) => structuredClone(x)
const fmt = (n) => Math.round(n).toLocaleString('en-US')

/** 体力/精力相关：找出最便宜的补体力方式 */
export function foodChoices(R, s, prices) {
  const room = Math.max(0, R.energyMax(s) - s.en)
  const out = []
  for (const c of R.CROPS) {
    const qs = s.inv?.[c.id] || []
    for (let q = 0; q < 3; q++) {
      const n = R.b12Available(s, c.id, q)
      if (n <= 0) continue
      const restore = Math.min(room, Math.round(c.eat * R.QUALITY[q]))
      if (restore <= 0) continue
      const unit = Math.round((prices[c.id] || 0) * R.QUALITY[q])
      out.push({ id: c.id, q, n, restore, unit, costPerEnergy: unit / restore })
    }
  }
  // 潮汐饭团
  const snack = R.b12Available(s, 'tide_snack', 0)
  if (snack > 0 && (s.cnt?.tide_snack || 0) < R.B12_SNACK.daily && room > 0) {
    const restore = Math.min(R.B12_SNACK.energy, room)
    out.push({ id: 'tide_snack', q: 0, n: snack, restore, unit: R.B12_SNACK.price, costPerEnergy: R.B12_SNACK.price / restore })
  }
  out.sort((a, b) => a.costPerEnergy - b.costPerEnergy)
  return out
}

/** 钓鱼的期望收益（每点体力） */
export function fishEV(R, s, t, prices, useBait) {
  const pool = R.fishPool(s, t)
  if (!pool.length) return 0
  const weather = R.weatherOf(R.isleDay(t))
  const miss = Math.max(0.05, 0.22 - 0.04 * s.tools.rod - (useBait ? 0.08 : 0) - (weather === 1 ? 0.05 : 0))
  const boost = (useBait ? 2 : 1) * (weather === 1 ? 1.5 : 1)
  const w = pool.map((f) => f.w * (f.price >= 9000 ? boost : 1))
  const sum = w.reduce((a, b) => a + b, 0)
  let ev = 0
  pool.forEach((f, i) => { ev += (w[i] / sum) * (prices[f.id] || f.price) })
  const gold = 0.08 + 0.05 * s.tools.rod
  const quality = gold * 1.5 + (1 - gold) * (0.28 * 1.25 + 0.72)
  const baitCost = useBait ? (R.SHOP.bait?.price || 400) : 0
  return (1 - miss) * quality * ev - baitCost
}

/** 挖矿的期望收益 */
export function mineEV(R, s, prices, useBomb) {
  const floor = Math.min(s.mine.max, R.PICK_FLOOR[s.tools.pick])
  const weather = R.weatherOf(R.isleDay(Date.now() / 1000 + (s.enT || 0) * 0))
  const pool = R.ORES.filter((o) => o.floor <= floor)
  const w = pool.map((o) => o.w * (1 + (floor - o.floor) / 40))
  const sum = w.reduce((a, b) => a + b, 0)
  let ev = 0
  pool.forEach((o, i) => { ev += (w[i] / sum) * (prices[o.id] || o.price) })
  if (useBomb) {
    const bombPool = R.ORES.filter((o) => o.floor <= floor)
    const bw = bombPool.map((o) => o.w * (o.price >= 7000 ? 1.35 : 1) * (1 + (floor - o.floor) / 40))
    const bsum = bw.reduce((a, b) => a + b, 0)
    let bev = 0
    bombPool.forEach((o, i) => { bev += (bw[i] / bsum) * (prices[o.id] || o.price) })
    const hits = 6 + 0.3 * 2
    return bev * hits - (R.SHOP.bomb?.price || 2500)
  }
  return ev * (1.25 + 0.05 * s.tools.pick)
}

/**
 * 离线时段：这段时间没人收菜，成熟超过保护期的地会被偷。
 * 返回包含 time 的离线区间 [开始, 结束]（unix 秒），不在离线时段返回 null。
 * 手机关着 / 不托管的时间段，种地计划要避开让它在这段时间里成熟。
 */
export function offlineWindow(cfg, time) {
  if (!cfg.offline?.enabled) return null
  const parse = (v) => { const [h, m] = String(v).split(':').map(Number); return (h * 60 + (m || 0)) * 60 }
  const from = parse(cfg.offline.from), to = parse(cfg.offline.to)
  if (!(from >= 0) || !(to >= 0) || from === to) return null
  const local = time + 8 * 3600, day0 = Math.floor(local / 86400) * 86400
  for (const d of [day0 - 86400, day0]) {
    const a = d + from, b = d + (to > from ? to : to + 86400)
    if (local >= a && local < b) return [a - 8 * 3600, b - 8 * 3600]
  }
  return null
}

/** 最近一块地成熟的时刻（弹窗显示「防偷」状态用）；没有在长的作物返回 0 */
export function nextRipe(R, world, cfg = {}) {
  const s = world.state, t = world.now, weather = R.weatherOf(R.isleDay(t))
  let at = 0
  for (let i = 0; i < (s.plotN || 0); i++) {
    const p = s.plots?.[i]
    if (!p) continue
    const st = R.cropStage(p, t, R.sprinkled(s, i) || weather === 1)
    if (st.stage >= 0 && st.stage < 3 && (!at || t + st.left < at)) at = Math.ceil(t + st.left)
  }
  return at
}

/**
 * 这块地现在种下去，成熟时刻会不会落在离线时段里？
 * 落在里面的话，成熟后没人收，超过保护期就被偷（被偷过的地每次只收 1 个）。
 * 返回 true 表示「该换一种成熟更快/更慢的作物」。只在离线时段开启时检查。
 */
export function ripensWhileOffline(cfg, now, growSec, regrow = 0) {
  if (!cfg.offline?.enabled) return false
  const ripeAt = now + (regrow || growSec) * 60
  return !!offlineWindow(cfg, ripeAt + 60)
}

/** 作物成熟时间（秒） */
export function cropReadyIn(R, s, p, t) {
  const st = R.cropStage(p, t, R.sprinkled(s, s.plots.indexOf(p)) || R.weatherOf(R.isleDay(t)) === 1)
  return st.stage === 3 ? 0 : Math.max(0, st.left)
}

/**
 * 逐块种植规划器：决定「下一块空地种什么」。
 *
 * 为什么不能一次性选「当季最赚的作物」然后全种上：
 *   1. 阶梯价——同一作物每岛日卖过 150 个后掉到 85%，又过 400 掉到 70%。
 *      24 块地全种番茄，后一半产量只能按 70% 卖，实际均值远低于按全价算的估值。
 *   2. 加工坊容量——每岛日只有 40 次加工，某些作物加工后增值更多，
 *      但加工名额被先种下去的作物吃掉，后面的作物就不能再按加工价估值。
 *
 * 做法（和旧版一致）：维护一张「已经规划了哪些作物、每岛日各品质产出多少」的表，
 * 每加一块地就试一遍所有当季作物，取「加这一块能多赚多少」最大的那个。
 * 加进去之后再规划下一块，所以后面的决策知道前面已经占掉了多少阶梯和加工名额。
 *
 * 返回 { pick(mode, foodMode) → {crop, value} | null }
 *   mode      —— 这块地的浇水方式（auto/manual/none）
 *   foodMode  —— 传入时优先按「回体力最多」挑口粮作物
 */
export function makeCropPlanner(R, s, t, prices, cfg, weather, foodCost = 300) {
  const season = R.seasonOf(R.isleDay(t))
  const TIERS = R.CROP_TIERS || [[150, 1], [400, 0.85], [Infinity, 0.7]]
  const QUALITY = R.QUALITY || [1, 1.25, 1.5]
  const modeOf = (i) => (R.sprinkled(s, i) || weather === 1 ? 'auto' : (cfg.farm?.water ? 'manual' : 'none'))

  /** 一茬的产量（按品质）与耗时，折算成「每岛日」 */
  const cycleOf = (c, mode) => {
    const W = R.WORLD
    const base = (c.grow || 60) * 60 * 0.8            // 基础生长（规则里岛日时钟比现实快 0.8）
    const times = c.regrow ? (c.times || 1) : 1
    const per = (h) => (h > 0 ? c.regrow * 0.8 : c.grow) * 60 * 0.8
    let waters = 0
    const total = mode === 'auto' ? base * 0.6 : mode === 'manual' ? base * 0.75 : base
    if (mode === 'auto') waters = 3
    else if (mode === 'manual') waters = 2
    // 浇水次数决定品质：越多金/银星比例越高
    const y = 1.3 + 0.08 * waters
    const gold = 0.05 + 0.1 * waters
    const silver = 0.2 + 0.08 * waters
    // 复茬作物是「种一次、收 times 次」，所以产量要按收获次数累加。
    // 只算一次收获的话（同时 secs 已经累加了所有茬的间隔）会严重低估复茬作物。
    const items = [y * (1 - gold - silver), y * silver, y * gold].map((n) => n * times)
    let secs = total
    for (let h = 1; h < times; h++) secs += per(h) * (mode === 'auto' ? 0.6 : mode === 'manual' ? 0.75 : 1)
    const perDay = 86400 / Math.max(1, secs)
    const opsE = (W.cost.plant + W.cost.harvest * times + waters * W.cost.water) * perDay
    return { items: items.map((x) => x * perDay), seed: c.seed * times * perDay, energy: opsE }
  }

  const crops = R.CROPS.filter((c) => c.seasons.includes(season)).map((c) => {
    // 单原料配方：加工能增值就用加工价（普通/银星），金星直接卖
    const rec = cfg.craft?.enabled
      ? R.RECIPES.filter((r) => r.price && Object.keys(r.in).length === 1 && r.in[c.id])
        .sort((a, b) => ((prices[b.id] || b.price) / b.in[c.id]) - ((prices[a.id] || a.price) / a.in[c.id]))[0]
      : null
    return { c, v0: prices[c.id] || c.price, u: rec ? (prices[rec.id] || rec.price) / rec.in[c.id] : 0, k: rec ? rec.in[c.id] : 1 }
  })
  const byId = Object.fromEntries(crops.map((x) => [x.c.id, x]))
  const prod = {}   // 作物 → 已经规划进去的 [普通, 银星, 金星] 每岛日产量

  const craftedSlots = () => Object.entries(prod).reduce((a, [id, p]) => {
    const x = byId[id]
    return a + (x?.u > 0 ? p.reduce((q, n) => q + n, 0) / (x.k || 1) : 0)
  }, 0)

  /** 给定产量和可用加工名额，按「加工优先、再按阶梯」算出能卖多少钱 */
  const revenue = (x, p, craftCap) => {
    let ti = 0, tierLeft = TIERS[0][0], craftLeft = craftCap * (x.k || 1), rev = 0, used = 0
    for (const q of [2, 1, 0]) {
      let n = p[q]
      while (n > 1e-6) {
        const raw = x.v0 * QUALITY[q] * TIERS[ti][1]
        const useCraft = q < 2 && craftLeft > 1e-6 && x.u > raw
        const take = Math.min(n, useCraft ? craftLeft : tierLeft)
        if (useCraft) { rev += take * x.u; craftLeft -= take; used += take / (x.k || 1) } else {
          rev += take * raw; tierLeft -= take
          if (tierLeft <= 1e-6 && ti < TIERS.length - 1) { ti++; tierLeft = TIERS[ti][0] - TIERS[ti - 1][0] }
        }
        n -= take
      }
    }
    return { rev, used }
  }

  // 加工坊每天的名额：约 3.5 个岛日 × 每岛日 40 次，挖矿类配方还要占掉一部分
  const craftTotal = (R.WORLD.daily.craft || 40) * 3.5 - (cfg.work?.mine ? 90 : 0)
  const craftCapOf = (id) => {
    const mine = byId[id]?.u > 0 ? (prod[id] || []).reduce((a, n) => a + n, 0) / (byId[id].k || 1) : 0
    const others = craftedSlots() - mine
    return Math.max(0, craftTotal - others)
  }

  return {
    modeOf,
    /** 这块空地种什么最赚。foodMode=true 时按「净回体力最多」挑 */
    pick(mode, foodMode = false) {
      let top = null
      for (const x of crops) {
        const cy = cycleOf(x.c, mode)
        if (foodMode) {
          const energy = cy.items.reduce((a, n, q) => a + n * x.c.eat * QUALITY[q], 0) - cy.energy
          if (!top || energy > top.value) top = { crop: x.c, cy, value: energy }
          continue
        }
        const cur = prod[x.c.id] || [0, 0, 0]
        const next = cur.map((n, q) => n + cy.items[q])
        const cap = craftCapOf(x.c.id)
        // 农务体力按口粮价折钱：这点体力本来可以拿去钓鱼/挖矿
        const value = revenue(x, next, cap).rev - revenue(x, cur, cap).rev - cy.seed - cy.energy * foodCost
        if (!top || value > top.value) top = { crop: x.c, cy, value }
      }
      return top
    },
    /** 记账：这块地已经种下去了，后面的决策要扣掉它占的阶梯和加工名额 */
    add(id, mode) {
      const x = byId[id]
      if (!x) return
      const cy = cycleOf(x.c, mode)
      const p = (prod[id] ||= [0, 0, 0])
      cy.items.forEach((n, q) => { p[q] += n })
    },
    prod,
  }
}


/** 选当季最赚的作物（按每分钟净收益估） */
export function bestCropFor(R, season, prices) {
  const list = R.CROPS.filter((c) => c.seasons.includes(season))
  if (!list.length) return null
  let best = null, bestV = -Infinity
  for (const c of list) {
    const price = prices[c.id] || c.price
    const perMin = (price * (1 + 0.54) * 1.285 - c.seed) / c.grow
    // 复茬作物按总产量摊
    const total = c.regrow ? c.times : 1
    const minutes = c.grow + (c.regrow || 0) * (total - 1)
    const v = (price * 1.54 * 1.285 * total - c.seed) / minutes
    if (v > bestV) { bestV = v; best = c }
  }
  return best
}

/**
 * 决策依据快照：把「每点体力能干出多少」这类判断摆到日志里。
 * 旧版这行信息量最大——不看它根本不知道为什么程序选了钓鱼而不是挖矿。
 */
export function decisionSnapshot(R, s, t, prices, expPrices, cfg) {
  const fmt = (n) => Math.round(n).toLocaleString('en-US')
  const season = R.seasonOf(R.isleDay(t))
  const useBait = cfg.work?.bait && (s.inv.bait?.[0] || 0) > 0
  // 体力超上限时 room=0，foodChoices 会返回空（没有「恢复空间」）。
  // 但口粮成本仍然是个有意义的参考值，这时按「不考虑上限」再算一遍。
  let food = foodChoices(R, s, prices)
  if (!food.length) food = foodChoices(R, { ...s, en: 0 }, prices)
  const foodCost = Math.round(food[0]?.costPerEnergy ?? 0)
  const foodName = food[0] ? (R.ITEM_NAME?.[food[0].id] || food[0].id) : ''

  const perE = (v, cost) => (v > 0 ? Math.round(v / cost) : 0)
  const fish = cfg.work?.fish ? perE(fishEV(R, s, t, expPrices, useBait), R.WORLD.cost.fish) : 0
  const mine = cfg.work?.mine ? perE(mineEV(R, s, expPrices, false) / (1.25 + 0.05 * s.tools.pick), R.WORLD.cost.mine) : 0
  const bomb = cfg.work?.bomb ? perE(mineEV(R, s, expPrices, true), R.WORLD.cost.bomb) : 0

  // 当前地里种得最多的作物 / 口粮地
  const plantCount = {}
  let empty = 0
  for (let i = 0; i < s.plotN; i++) {
    const p = s.plots[i]
    if (!p) { empty++; continue }
    plantCount[p.c] = (plantCount[p.c] || 0) + 1
  }
  const topCrop = Object.entries(plantCount).sort((a, b) => b[1] - a[1])[0]
  const best = bestCropFor(R, season, expPrices)

  const jobs = [['钓鱼', fish], ['挖矿', mine], ['炸矿', bomb]].filter(([, v]) => v > 0)
  jobs.sort((a, b) => b[1] - a[1])

  return {
    season: R.SEASONS[season], weather: R.WEATHERS[R.weatherOf(R.isleDay(t))], hour: R.isleHour(t),
    fish, mine, bomb, foodCost, foodName,
    bestJob: jobs[0]?.[0] || '无',
    // 赚的还不够口粮钱 → 不值得干
    worthWorking: jobs.length ? jobs[0][1] > foodCost * (cfg.work?.minValueRatio ?? 1.2) : false,
    empty, topCrop: topCrop ? `${R.ITEM_NAME?.[topCrop[0]] || topCrop[0]}×${topCrop[1]}` : '无',
    bestCrop: best?.name || '无',
    foodPlots: cfg.farm?.foodPlots ?? 0,
    plotN: s.plotN,
  }
}

/**
 * 主规划：返回 { actions, summary }
 */
export function planRound(world, cfg, log = () => {}) {
  const R = world.R
  const t = world.now
  const s = clone(world.state)
  const prices = world.prices
  // 产出型决策（选作物 / 钓鱼 / 挖矿 / 加工 / 投资）用「未来几个岛日均价」而不是今天的价。
  // 这些产出不会当天卖掉，按当天价挑活会系统性选错。
  let expPrices = prices
  try {
    expPrices = M.expectedPrices(R, t, prices, {
      outlook: cfg.sell?.outlookDays ?? 3,
      external: world.externalSoldRatio || {},
    })
  } catch {}
  const actions = []
  const summary = []
  const MAX = R.WORLD.maxActions

  let coins = world.coins
  // 被服务端拒绝过的动作类型：本轮不再尝试，避免像旧版那样刷 20 多次无效请求
  const blocked = new Set()
  const push = (a) => {
    if (actions.length >= MAX) return false
    const key = a.a + (a.a === 'plant' ? ':' + a.c : '')
    if (blocked.has(key) || blocked.has(a.a)) return false
    const r = R.applyActions(s, [a], { t, day: R.worldDay(t), prices, coins, rand: () => 0.5 })
    const o = r.out[0]
    if (!o?.ok) {
      // 额度类/季节类失败，整类都别再试了
      const msg = o?.msg || ''
      if (/额度|已经钓了|已经挖了|忙不过来|用完|不是这个季节|满了|已经最大|不足/.test(msg)) {
        blocked.add(key); blocked.add(a.a)
      }
      return false
    }
    coins += (o.earn || 0) - (o.spend || 0)
    actions.push(a)
    return true
  }

  const budget = () => Math.max(0, coins - (cfg.invest?.reserveCoins || 0))

  // ---------- 1. 领奖类（零成本） ----------
  const night = R.b12NightView(s, t)
  if (night.claimable) push({ a: 'nightClaim', key: night.key })
  const refund = R.b12GuardRefundQuote(s)
  if (refund > 0) push({ a: 'guardRefund' })

  // 彩票兑奖：开奖结果由服务端提供，本地并不知道中没中，
  // 所以只要手里有「已过开奖日」的票就申请兑一次，中不中由服务端判定。
  // 旧版就是这么做的——放在最前面，因为它是纯收益且零成本。
  {
    const draw = R.lottoDrawId(t)
    const expired = (s.lotto || []).filter((tk) => tk.d < draw).length
    if (expired > 0) {
      if (push({ a: 'lottoClaim' })) summary.push(`彩票兑奖 ${expired} 张`)
    }
  }

  // 防偷守家道具：地里出现过小偷记录后的 24 小时内，或设了离线时段时，
  // 续上「潮铃」（发现率 +10%）和「贝壳护具」（守家生命 +8%）。
  // 这两件是花小钱防大损：一次被偷损失往往上万，道具只要 800/1600。
  if (cfg.defense?.guardItems !== false) {
    // 地里留下小偷记录（p.sv）说明最近被偷过，之后 24 小时都值得续道具
    const stolenRecently = (s.plots || []).some((p) => p?.sv?.length)
    if (stolenRecently) world.stolenAt = t
    const want = cfg.offline?.enabled || (t - (world.stolenAt || 0) < 86400)
    if (want) {
      for (const id of [cfg.defense?.alert ?? 'guard1', cfg.defense?.combat ?? 'guard2']) {
        const item = R.GUARD_ITEMS?.[id]
        if (!item) continue
        const cur = R.b12Effect(s, item.slot, t)
        // 已有同槽位效果且还没快到期的，不重复买
        if (cur && cur.id === id && cur.until - t > 1800) continue
        if (coins - item.price < 20000) continue
        if (push({ a: 'buy', id })) summary.push(`防偷：${item.name}续 24 小时（${fmt(item.price)}）`)
      }
    }
  }

  const goals = R.dailyGoals(R.worldDay(t), s)
  for (let k = 0; k < 4; k++) {
    if (!s.cnt['goal' + k] && (s.cnt[goals[k]?.id] || 0) >= goals[k]?.n) push({ a: 'goal', k })
  }
  if (!s.cnt.goal4 && [0, 1, 2, 3].every((k) => s.cnt['goal' + k])) push({ a: 'goal', k: 4 })

  // ---------- 2. 收割 / 收产物 / 收蟹笼（成熟即收，防偷） ----------
  const weather = R.weatherOf(R.isleDay(t))
  let harvested = 0, collected = 0, trapped = 0
  const stolenParcels = []
  for (let i = 0; i < s.plotN; i++) {
    const p = s.plots[i]
    if (!p) continue
    const auto = R.sprinkled(s, i) || weather === 1
    const st = R.cropStage(p, t, auto)
    if (st.stage === 3) {
      if (push({ a: 'harvest', i })) {
        harvested++
        // p.sv 是小偷记录：收获前被偷过，这块地这次只收得到 1 个
        if (p.sv?.length) stolenParcels.push(p.c)
      }
    } else if (st.stage === -1) push({ a: 'clear', i })
  }
  if (stolenParcels.length) {
    const names = [...new Set(stolenParcels)].map((id) => R.ITEM_NAME?.[id] || id).join('、')
    summary.push(`⚠ ${stolenParcels.length} 块地在收获前被偷过（${names}），每块少收 1 个`)
    world.stolenAt = t
  }
  for (let i = 0; i < s.barn.length; i++) {
    const st = R.animalReady(s.barn[i], t)
    if (st.ready) { if (push({ a: 'collect', i })) collected++ }
  }
  for (let i = 0; i < s.traps.length; i++) {
    const st = R.trapReady(s.traps[i], t, weather === 2)
    if (st.n) { if (push({ a: 'trap', i })) trapped++ }
  }
  if (harvested) summary.push(`收获 ${harvested} 块地`)
  if (collected) summary.push(`收产物 ${collected} 窝`)
  if (trapped) summary.push(`收蟹笼 ${trapped} 个`)

  // ---------- 3. 牧场：喂食 / 摸摸 / 补饲料 ----------
  const nowTs = t
  let fed = 0, petted = 0
  const hungry = []
  for (let i = 0; i < s.barn.length; i++) {
    const pen = s.barn[i]
    const stage = R.b12AnimalStage(pen, t)
    if (stage.retired) continue
    if (t - pen.f >= 8 * 3600) hungry.push(i)
    if (!s.cnt['pet' + i]) { if (push({ a: 'pet', i })) petted++ }
  }
  if (hungry.length) {
    const have = s.inv.feed?.[0] || 0
    const lack = hungry.length - have
    if (lack > 0) {
      const n = Math.min(99, lack + 5)
      if (coins >= (R.SHOP.feed.price * n)) push({ a: 'buy', id: 'feed', n })
    }
    for (const i of hungry) { if (push({ a: 'feed', i })) fed++ }
  }
  if (fed) summary.push(`喂食 ${fed} 只`)
  if (petted) summary.push(`摸摸 ${petted} 只`)

  // ---------- 4. 浇水（没有洒水器的地） ----------
  if (cfg.farm?.water && weather !== 1) {
    let watered = 0
    for (let i = 0; i < s.plotN; i++) {
      const p = s.plots[i]
      if (!p || R.sprinkled(s, i)) continue
      const st = R.cropStage(p, t)
      if (st.stage >= 0 && st.stage < 3 && p.w <= st.stage) {
        if (push({ a: 'water', i })) watered++
      }
    }
    if (watered) summary.push(`浇水 ${watered} 块`)
  }

  // ---------- 5. 补种（逐块挑，考虑阶梯价和加工坊容量） ----------
  if (cfg.farm?.enabled) {
    const season = R.seasonOf(R.isleDay(t))
    const foodCost = foodChoices(R, s, prices)[0]?.costPerEnergy ?? 300
    const planner = makeCropPlanner(R, s, t, prices, cfg, weather, foodCost)

    // 已经在长的作物先记账：它们同样占用今天的阶梯价名额和加工坊容量，
    // 不记的话新种的会以为自己还能按全价/加工价卖。
    for (let i = 0; i < s.plotN; i++) {
      const p = s.plots[i]
      if (!p) continue
      const st = R.cropStage(p, t, R.sprinkled(s, i) || weather === 1)
      if (st.stage >= 0) planner.add(p.c, planner.modeOf(i))
    }

    const empty = []
    for (let i = 0; i < s.plotN; i++) if (!s.plots[i]) empty.push(i)
    if (empty.length) {
      // 指定了偏好作物就用它，否则逐块挑
      const prefer = cfg.farm.preferCrop
        ? R.CROPS.find((c) => c.id === cfg.farm.preferCrop && c.seasons.includes(season))
        : null
      const foodCount = Math.min(empty.length, cfg.farm.foodPlots || 0)
      const plantedNames = {}
      let planted = 0, skippedOffline = 0
      empty.forEach((i, idx) => {
        const mode = planner.modeOf(i)
        const wantFood = idx < foodCount
        let pick = prefer
          ? { crop: prefer, value: 1 }
          : planner.pick(mode, wantFood)
        if (!pick || (!wantFood && !(pick.value > 0))) return
        // 离线时段避让：成熟时刻落在没人收菜的时段里就会被偷，换一种或干脆空着
        if (!wantFood && cfg.offline?.enabled && ripensWhileOffline(cfg, t, pick.crop.grow, pick.crop.regrow)) {
          const alt = planner.pick(mode, false)
          if (!alt || alt.crop.id === pick.crop.id) { skippedOffline++; return }
          pick = alt
        }
        if (!push({ a: 'plant', i, c: pick.crop.id })) return
        planted++
        plantedNames[pick.crop.name] = (plantedNames[pick.crop.name] || 0) + 1
        planner.add(pick.crop.id, mode)
      })
      if (planted) {
        const parts = Object.entries(plantedNames).map(([n, k]) => `${n}×${k}`).join('、')
        summary.push(`补种 ${planted} 块（${parts}${foodCount ? `，其中口粮 ${Math.min(foodCount, planted)} 块` : ''}）`)
      }
      if (skippedOffline) summary.push(`  离线避让：${skippedOffline} 块先空着（种什么都赶在离线时段成熟）`)
    }
  }

  // ---------- 6. 投资（只买 10 天内回本的） ----------
  if (cfg.invest?.enabled) {
    const inv = planInvestments(R, s, expPrices, coins, cfg, t)
    for (const it of inv) {
      if (coins < it.cost + (cfg.invest.reserveCoins || 0)) continue
      if (push(it.action)) summary.push(`投资：${it.name}（${fmt(it.cost)}，约 ${it.payback.toFixed(1)} 天回本）`)
    }
  }

  // ---------- 7. 加工 ----------
  if (cfg.craft?.enabled) {
    const left = R.WORLD.daily.craft - ((s.iq?.d === R.isleIndex(t) ? s.iq.craft : 0) || 0)
    let made = 0
    const have = (id) => [0, 1, 2].reduce((a, q) => a + R.b12Available(s, id, q), 0)
    // 原料按现价算（今天就要消耗掉），产品按未来均价算（做好要囤到峰值才卖）
    const ranked = R.RECIPES.filter((r) => r.price).map((r) => {
      const cost = Object.entries(r.in).reduce((a, [id, n]) => a + (prices[id] || 0) * n, 0)
      const salePrice = expPrices[r.id] || prices[r.id] || r.price
      return { r, margin: salePrice - cost }
    }).filter((x) => x.margin > 0).sort((a, b) => b.margin - a.margin)
    for (const { r, margin } of ranked) {
      if (made >= Math.min(left, cfg.craft.maxPerRound || 20)) break
      const n = Math.min(
        left - made,
        Math.floor(s.en),
        ...Object.entries(r.in).map(([id, k]) => Math.floor(have(id) / k)),
      )
      if (n <= 0) continue
      if (push({ a: 'craft', id: r.id, n })) {
        made += n
        const cost = Object.entries(r.in).reduce((a, [id, k]) => a + (prices[id] || 0) * k, 0)
        const sale = (expPrices[r.id] || prices[r.id] || r.price) * n
        summary.push(`加工 ${r.name}×${n}（成本 ${fmt(cost * n)} → 预期 ${fmt(sale)}，毛利 ${fmt(sale - cost * n)}）`)
      }
    }
  }

  // ---------- 8. 花体力做最高收益的事（钓/挖/炸） ----------
  //
  // 这一段有三处「往后看一眼」的判断，都是旧版有、重写时丢掉的：
  //   keep     —— 马上要熟的地，先把收获体力留出来，别全花在钓鱼上
  //   fishOK   —— 钓鱼有时段，低谷期不钓，等最佳时段
  //   regenBudget —— 换岛日边界前自然回复够用的体力，不吃口粮，等它自己回
  if (cfg.work) {
    const W = R.WORLD
    // 口粮是立刻消耗掉的，按现价算成本
    const eatCost = foodChoices(R, s, prices)[0]?.costPerEnergy ?? 300
    const reserve = Math.max(0, cfg.energy?.minEnergyToLeave ?? 0)

    // --- 收获体力预留 ---
    // 没洒水器时手动浇水也要体力，但那是可选的（不浇只是少收），只预留收获。
    // 只算「口粮不够覆盖」的部分：库存口粮足够时，收获时可以现场吃，不用预留。
    const ripeSoon = []
    for (let i = 0; i < s.plotN; i++) {
      const p = s.plots[i]
      if (!p) continue
      const auto = R.sprinkled(s, i) || weather === 1
      const st = R.cropStage(p, t, auto)
      if (st.stage >= 0 && st.stage < 3 && st.left < (cfg.farm?.ripeKeepSec ?? 2400)) ripeSoon.push(i)
    }
    const foodEnergy = foodChoices(R, s, prices).reduce((a, f) => a + f.restore * f.n, 0)
    const keep = Math.max(0, ripeSoon.length * (W.cost.harvest || 1) - Math.floor(foodEnergy / 2))

    // --- 钓鱼时段窗口 ---
    // 岛上的「小时」是现实 10 分钟一格，鱼分时段出没。当前时段收益远低于今天最好的时段时，
    // 先把竿数留着，等窗口。但快到换岛日边界（额度即将重置）时要清掉，别浪费。
    const boundaryIn = R.b12NextIsleBoundary(t) - t
    // 比较各时段的相对好坏时用「同一个价格基准」（现价），只看鱼种分布的差异。
    // 用 expPrices 会把「不同岛日价格不同」也算进去，导致同一批鱼换个时段就跨过阈值。
    const fishNowEV = cfg.work.fish ? fishEV(R, s, t, prices, false) : 0
    let fishBestEV = fishNowEV
    {
      for (let h = 1; h <= 24; h++) {
        // 用「往后挪 h 个岛上小时」的虚拟时刻探一遍鱼池
        const probe = t + h * (R.ISLE_SPAN / 24)
        const ev = fishEV(R, s, probe, prices, false)
        if (ev > fishBestEV) fishBestEV = ev
      }
    }
    const windowRatio = cfg.work.windowRatio ?? 0.97
    const deadlineSec = cfg.work.deadlineSec ?? 1200
    const fishOK = !R.b12IsLongNight(t) &&
      (fishNowEV >= fishBestEV * windowRatio || boundaryIn < deadlineSec)

    // --- 跨期体力预算 ---
    // 换岛日边界前，体力每 regen 秒回 1 点。这部分「白来的」体力用来挖矿/炸矿时
    // 不该吃口粮（吃口粮是有成本的）。先按回复量算出能白嫖几竿。
    const regen = W.regen || 180
    let regenBudget = Math.max(0, Math.floor(Math.max(0, boundaryIn - 600) / regen))

    // 循环条件不能只看「体力够不够一件活」：体力见底时还要能靠吃口粮补上来。
    // 用 0 做下界，真正的门槛在循环体里按任务成本判断。
    let guard = 0
    while (s.en >= 0 && guard++ < 200) {
      const fishLeft = W.daily.fish - ((s.iq?.d === R.isleIndex(t) ? s.iq.fish : 0) || 0)
      const mineLeft = W.daily.mine - ((s.iq?.d === R.isleIndex(t) ? s.iq.mine : 0) || 0)
      const bombLeft = W.daily.bomb - ((s.iq?.d === R.isleIndex(t) ? s.iq.bomb : 0) || 0)
      const useBait = cfg.work.bait && (s.inv.bait?.[0] || 0) > 0
      // 钓到的鱼、挖到的矿都要囤到价格峰值才卖，按未来均价估才准
      const fishVal = cfg.work.fish && fishLeft > 0 && fishOK ? fishEV(R, s, t, expPrices, useBait) : -1
      const mineVal = cfg.work.mine && mineLeft >= 3 ? mineEV(R, s, expPrices, false) / (1.25 + 0.05 * s.tools.pick) : -1
      const bombVal = cfg.work.bomb && bombLeft > 0 && mineLeft >= 6 && (s.inv.bomb?.[0] || 0) > 0 ? mineEV(R, s, expPrices, true) : -1
      // 不按当前体力筛任务：体力不够时下面会决定「吃口粮补」还是「等自然回复」。
      // 按体力筛的话，体力见底会直接跳出，永远等不到吃口粮那一步。
      const jobs = []
      if (fishVal > 0) jobs.push({ a: { a: 'fish', bait: useBait }, cost: W.cost.fish, v: fishVal / W.cost.fish, label: '钓鱼', lazy: false })
      if (mineVal > 0) jobs.push({ a: { a: 'mine', f: Math.min(s.mine.max, R.PICK_FLOOR[s.tools.pick]) }, cost: W.cost.mine, v: mineVal / W.cost.mine, label: '挖矿', lazy: true })
      if (bombVal > 0) jobs.push({ a: { a: 'bomb', f: Math.min(s.mine.max, R.PICK_FLOOR[s.tools.pick]) }, cost: W.cost.bomb, v: bombVal / W.cost.bomb, label: '炸矿', lazy: true })
      jobs.sort((x, y) => y.v - x.v)
      const job = jobs[0]
      if (!job) break
      // 收益必须高于口粮成本，否则不值得做
      if (job.v <= eatCost * (cfg.work.minValueRatio ?? 1.2)) break

      if (s.en < job.cost + keep) {
        // 体力不够干这活。挖矿/炸矿没有时段限制，可以等自然回复——只要换岛日前
        // 回复得够，白白等回来比花口粮买体力划算得多。钓鱼不行：鱼有时段，过了就没了。
        if (job.lazy && regenBudget >= job.cost) break
        // 不能等（快到边界 / 是钓鱼）→ 吃口粮补上来
        const food = foodChoices(R, s, prices)[0]
        if (!food || food.costPerEnergy >= job.v * (cfg.work.minValueRatio ?? 1.2)) break
        // 收获预留还没满足时，别把口粮吃成「超出预留也照吃」
        if (ripeSoon.length && s.en + food.restore > keep + job.cost) break
        if (!push({ a: 'eat', id: food.id, q: food.q })) break
        continue
      }
      if (!push(job.a)) break
      // 这次消耗吃掉了一份「自然回复预算」：用掉的是本来会自己长出来的体力
      if (job.lazy) regenBudget = Math.max(0, regenBudget - job.cost)
    }
  }

  // ---------- 8.5 囤货仓库：把「等峰值更划算」的货锁起来 ----------
  if (cfg.vault?.enabled) {
    let locked = 0
    for (const a of planVault(R, { now: t, state: s, coins, prices, externalSoldRatio: world.externalSoldRatio }, cfg)) {
      if (push(a)) locked++
    }
    if (locked) summary.push(`囤货仓库调整 ${locked} 项`)
  }

  // ---------- 9. 卖货（择时） ----------
  if (cfg.sell?.enabled) {
    const plan = M.sellPlan(R, t, { ...world, state: s, coins }, {
      days: cfg.sell.horizonDays || 12,
      markdownPct: cfg.sell.markdownPct ?? 6,
      external: world.externalSoldRatio || {},
    })
    // 加工原料保留：现在卖出去就再也凑不齐一份加工原料的普通/银星货，先留着。
    // 前提是加工坊本岛日确实还会加工（额度没用完、原料齐了），否则留着就是压库存。
    // 囤得太多（超过 hoardMax）说明加工消化不掉，那就照卖。
    const hoardMax = cfg.craft?.hoardMax ?? 240
    const craftLeft = R.WORLD.daily.craft - ((s.iq?.d === R.isleIndex(t) ? s.iq.craft : 0) || 0)
    const craftable = new Set()
    if (cfg.craft?.enabled && craftLeft > 0) {
      for (const rec of R.RECIPES) {
        if (!rec.price) continue
        const okAll = Object.entries(rec.in).every(([id, k]) => R.b12Available(s, id, 0) + R.b12Available(s, id, 1) >= k)
        if (okAll) for (const id of Object.keys(rec.in)) craftable.add(id)
      }
    }
    const totalOf = (id) => [0, 1, 2].reduce((a, q) => a + (s.inv?.[id]?.[q] || 0), 0)

    const sells = []
    for (const r of plan.rows) {
      if (!r.sellNow) continue
      if (r.gain > 0 && r.gain / Math.max(1, r.netNow) > (cfg.sell.minGainPct || 5) / 100) continue // 等等更赚
      let n = r.qty
      if (cfg.sell.respectTiers && r.isCrop) {
        // 只卖今天还能全价的部分
        const full = R.cropFullLeft(s, r.id)
        n = Math.min(n, full > 0 ? full : 0)
        if (n <= 0) continue
      }
      sells.push({ ...r, n })
    }
    let sold = 0, soldUnits = 0, soldGross = 0
    const soldNames = []
    const hoarded = []
    for (const r of sells.slice(0, cfg.sell.maxSellPerRound || 40)) {
      let units = 0
      // 按品质从高到低卖
      for (let q = 2; q >= 0 && r.n > 0; q--) {
        // 普通/银星原料留给加工坊，除非已经囤太多
        if (q < 2 && craftable.has(r.id) && totalOf(r.id) < hoardMax) {
          if (!hoarded.includes(r.name)) hoarded.push(r.name)
          continue
        }
        const have = R.b12Available(s, r.id, q)
        if (have <= 0) continue
        const take = Math.min(999, have, r.n)
        if (push({ a: 'sell', id: r.id, q, n: take })) { r.n -= take; sold++; units += take }
      }
      if (units > 0) {
        soldUnits += units
        soldGross += r.cur * units
        const pctTxt = `${r.curPct >= 0 ? '+' : ''}${(r.curPct * 100).toFixed(0)}%`
        soldNames.push(`${r.name}×${units}（现价${pctTxt}${r.peakIn > 0 ? `，峰值在 ${r.peakIn} 个岛日后` : '，已在峰值'}）`)
      }
    }
    if (hoarded.length) summary.push(`  留作加工原料不卖：${hoarded.slice(0, 5).join('、')}`)
    if (sold) {
      summary.push(`卖出 ${sold} 格 / ${soldUnits} 件，约 ${fmt(soldGross)} D`)
      for (const s2 of soldNames.slice(0, 8)) summary.push(`  · ${s2}`)
    }
    // 没卖但值得等：也记一笔，方便判断策略是否合理
    const waiting = plan.rows.filter((r) => !r.sellNow && r.gain > 0).slice(0, 3)
    for (const r of waiting) {
      summary.push(`  · ${r.name}×${r.qty} 暂不卖：峰值 ${(r.peakPct * 100).toFixed(0)}%（+${r.peakIn} 个岛日），可多赚 ${fmt(r.gain)} D`)
    }
  }

  // ---------- 10. 货船进货 ----------
  //
  // 两种买法，旧版都有：
  //   套利  —— 基础价买入，预期未来高价卖出
  //   口粮  —— 比自己种口粮还便宜的作物，买来直接吃（回体力）
  // 口粮这一条以前漏了：自己种地要占种子钱、农务体力、占地，货船上的便宜菜往往更划算。
  if (cfg.cargo?.enabled) {
    const stock = R.b12Stock(t, prices)
    let bought = 0
    const eatCost = foodChoices(R, s, prices)[0]?.costPerEnergy ?? 300
    // 口粮库存折成体力，攒够了就不再买
    let foodEnergy = foodChoices(R, s, prices).reduce((a, f) => a + f.restore * f.n, 0)
    const foodCap = cfg.energy?.reserveEnergy ?? 2500
    for (const it of stock) {
      if (bought >= (cfg.cargo.maxItems || 12)) break
      const left = R.b12StockLeft(s, it, t)
      if (left <= 0) continue
      const crop = R.CROPS.find((c) => c.id === it.id)
      // 未来能卖出的最高价
      const fc = M.forecastPrices(R, t, prices, { days: 6, external: world.externalSoldRatio || {} })
      const peak = Math.max(...fc.map((f) => f.price[it.id] || 0))
      const margin = peak / it.price - 1
      const arbitrage = margin >= (cfg.cargo.minMargin || 0.08)
      // 口粮：每点体力比现有口粮更便宜，且库存还没攒够
      const perEnergy = crop && crop.eat > 0 ? it.price / crop.eat : Infinity
      const asFood = crop && foodEnergy < foodCap && perEnergy < eatCost * 0.9
      if (!arbitrage && !asFood) continue
      const n = Math.min(left, it.limit, Math.max(1, Math.floor((coins - (cfg.cargo.reserveCoins || 0)) / it.price)))
      if (n <= 0) continue
      if (push({ a: 'stockBuy', id: it.id, n, day: R.isleDay(t) })) {
        bought++
        if (arbitrage) summary.push(`货船进 ${it.name}×${n}（套利，预期 +${(margin * 100).toFixed(0)}%）`)
        else { summary.push(`货船进 ${it.name}×${n}（当口粮：${Math.round(perEnergy)} D/体力，库存口粮 ${Math.round(eatCost)} D/体力）`); foodEnergy += n * crop.eat }
      }
    }
  }

  return { actions, summary, coinsAfter: coins }
}

/**
 * 投资建议：只买预计 N 天内回本的。
 *
 * 每一项的日收益都从规则模块推，不用硬编码常数——以前鱼竿写死「30 万 × 等级」，
 * 换个季节、换个鱼价就完全是错的，会误导成「先升鱼竿」。
 *
 * 长期资产按「基础价 × longRun 系数」估值，不用未来几天的行情高点：
 * 动物要养几十天，工具要用很久，拿两天的价格峰值算回本期会极端乐观。
 */
export function planInvestments(R, s, prices, coins, cfg, t) {
  const W = R.WORLD
  const out = []
  const maxPayback = cfg.invest?.maxPaybackDays || 10
  // 长期平均的「择时卖出」系数：基础价的 1.3 倍，再扣税
  const longRunFactor = cfg.price?.longRun ?? 1.3
  const taxRate = coins >= R.B12_TAX.high ? 0.03 : coins >= R.B12_TAX.free ? 0.01 : 0
  const lr = (id) => (R.BASE_PRICE[id] || prices[id] || 0) * longRunFactor * (1 - taxRate)

  const add = (name, action, cost, dailyGain, delayDays = 0, extra) => {
    if (cost == null || !(dailyGain > 0)) return
    // delayDays：资产从买到开始产生收益要等多久（动物有生长期）
    const payback = cost / dailyGain + delayDays
    if (payback > maxPayback) return
    out.push({ name, action, cost, dailyGain, payback, extra })
  }
  const ISLE_PER_DAY = 3.5   // 14 小时白昼 ÷ 4 小时一个岛日

  // ---------- 地块：多种一块能多收多少 ----------
  if (s.plotN < Math.min(W.plotsMax, cfg.invest?.maxPlot ?? 24)) {
    const price = W.plotPrice(s.plotN + 1)
    const season = R.seasonOf(R.isleDay(t))
    const best = bestCropFor(R, season, prices)
    if (best) {
      // 一茬的总产出（含品质溢价 54%、复茬 28.5%）减种子钱，按成熟周期折成「每天多少茬」
      const total = best.regrow ? (best.times || 1) : 1
      const minutes = best.grow + (best.regrow || 0) * (total - 1)
      const perRound = (best.price * 1.54 * 1.285 * total - best.seed)
      add(`开垦第 ${s.plotN + 1} 块地`, { a: 'expand', k: 'plot' }, price, (perRound / Math.max(1, minutes)) * 1440)
    }
  }

  // ---------- 鱼竿：四季 × 全天取最好的时段，看升级能多赚多少 ----------
  if (s.tools.rod < (cfg.invest?.maxRod ?? 4) && cfg.work?.fish) {
    const rodPrice = R.upgradePrice(s, 'rod')
    // 四季 × 全天找出「每竿平均收益」最高的时段，取四季平均。
    // 同一个 t 往前推季节，用虚拟时刻让 fishPool 选到对应季节的鱼。
    const fishBest = (rodLv) => {
      const s2 = { ...s, tools: { ...s.tools, rod: rodLv } }
      let sum = 0
      for (let se = 0; se < 4; se++) {
        let best = 0
        for (let h = 0; h < 24; h++) {
          const probe = t + se * 12 * ISLE_PER_DAY * R.ISLE_SPAN + h * (R.ISLE_SPAN / 24)
          // 开不开饵料都试一遍，取更大的那个
          const ev = Math.max(fishEV(R, s2, probe, prices, false), fishEV(R, s2, probe, prices, true))
          if (ev > best) best = ev
        }
        sum += best
      }
      return sum / 4
    }
    const gain = fishBest(s.tools.rod + 1) - fishBest(s.tools.rod)
    // 不能按「钓满每日额度」算：80 竿 × 4 体力 = 320 点，一天总量才约 480 点，
    // 还要分给挖矿、收获、种植。按「体力预算里实际能分给钓鱼的份额」折一下。
    const dayE = 86400 / (R.WORLD.regen || 180)              // 自然回复 + 初始满体力 ≈ 每天多少点
    const fishShare = Math.min(1, dayE * (cfg.invest?.fishEnergyShare ?? 0.4) / (R.WORLD.daily.fish * (R.WORLD.cost.fish || 4)))
    const rodsPerDay = R.WORLD.daily.fish * ISLE_PER_DAY * fishShare
    if (rodPrice != null) add(`鱼竿 Lv${s.tools.rod + 1}`, { a: 'upgrade', k: 'rod' }, rodPrice, gain * rodsPerDay)
  }

  // ---------- 镐子：下潜层数变深，能挖到更值钱的矿 ----------
  if (s.tools.pick < (cfg.invest?.maxPick ?? 4) && cfg.work?.mine) {
    const pickPrice = R.upgradePrice(s, 'pick')
    // 用「该等级能到的层」直接算期望，比模拟时刻稳定。
    // 挖矿一次的期望受 PICK_FLOOR 影响，所以每升一级都会更深一层。
    const dayOre = (pick) => {
      const s2 = { ...s, tools: { ...s.tools, pick } }
      const per = mineEV(R, s2, prices, false)
      const bomb = cfg.work?.bomb ? mineEV(R, s2, prices, true) : 0
      return per * R.WORLD.daily.mine + (bomb > 0 ? bomb * R.WORLD.daily.bomb : 0)
    }
    if (pickPrice != null) add(`镐子 Lv${s.tools.pick + 1}`, { a: 'upgrade', k: 'pick' }, pickPrice, (dayOre(s.tools.pick + 1) - dayOre(s.tools.pick)) * ISLE_PER_DAY)
  }

  // ---------- 洒水器：省下覆盖地块的浇水体力 ----------
  if (s.tools.spr < (cfg.invest?.maxSpr ?? 3) && cfg.farm?.water) {
    const sprPrice = R.upgradePrice(s, 'spr')
    if (sprPrice != null) {
      const covered = Math.max(0, Math.min(s.plotN, W.sprCover[s.tools.spr + 1]) - W.sprCover[s.tools.spr])
      // 每块地每茬要浇 2~3 次水，每次 1 点体力，体力按口粮价折钱
      const foodCost = foodChoices(R, s, prices)[0]?.costPerEnergy ?? 300
      add(`洒水器 Lv${s.tools.spr + 1}`, { a: 'upgrade', k: 'spr' }, sprPrice, covered * 2.5 * Math.min(foodCost, 600) * ISLE_PER_DAY)
    }
  }

  // ---------- 蟹笼：只出普通品质、不会跑货 ----------
  if (s.traps.length < W.trapMax) {
    const trapPrice = W.trapPrice(s.traps.length + 1)
    // 按当前所有产物的长期均价估一个典型收益（蟹笼产物种类固定，不用逐项模拟）
    const trapProducts = (R.TRAP_PRODUCTS || ['shrimp', 'crab', 'lobster']).filter((id) => R.BASE_PRICE[id])
    const productVal = trapProducts.length
      ? trapProducts.reduce((a, id) => a + lr(id), 0) / trapProducts.length
      : 1500
    add(`第 ${s.traps.length + 1} 个蟹笼`, { a: 'buyTrap' }, trapPrice, productVal * (1440 / W.trapEvery) * 1.15)
  }

  // ---------- 动物：整个成年期净赚 ÷ 总天数，挑最好的一种 ----------
  const animalRank = R.ANIMALS.map((a) => {
    const adultDays = (R.B12_ADULT_DAYS?.[a.id] ?? 24) / ISLE_PER_DAY
    const growDays = (R.B12_GROW_DAYS?.[a.id] ?? 2) / ISLE_PER_DAY
    const daily = (1440 / a.every) * lr(a.product) * 1.2 - (R.SHOP.feed?.price ?? 300)
    // 退休时能卖掉一部分本钱（约 60%）
    const life = (daily * adultDays - a.price * 0.4) / (adultDays + growDays)
    return { a, daily, growDays, life, adultDays }
  }).sort((x, y) => y.life - x.life)[0]

  if (animalRank && animalRank.life > 0) {
    if (s.barn.length < s.barnN) {
      // 有空位：直接买最好的那只
      add(`买${animalRank.a.name}`, { a: 'buyAnimal', k: animalRank.a.id }, animalRank.a.price, animalRank.daily, animalRank.growDays)
    } else if (s.barnN < Math.min(W.barnMax, cfg.invest?.maxBarn ?? 8)) {
      // 没空位：扩建一格，连动物一起算
      const barnPrice = W.barnPrice(s.barnN + 1)
      add(`扩畜栏 + ${animalRank.a.name}`, { a: 'expand', k: 'barn' }, barnPrice + animalRank.a.price, animalRank.daily, animalRank.growDays, { first: barnPrice })
    }
  }

  // ---------- 小屋：只加体力上限 ----------
  // 脚本从不让体力攒满，上限提升基本没有实际收益，默认不买（maxHouse = 0）。
  if (s.tools.house < Math.min(W.houseMax, cfg.invest?.maxHouse ?? 0)) {
    const housePrice = R.upgradePrice(s, 'house')
    // 上限 +20 约等于每天多白嫖 20 点体力
    const foodCost = foodChoices(R, s, prices)[0]?.costPerEnergy ?? 300
    if (housePrice != null) add(`小屋 Lv${s.tools.house + 1}`, { a: 'upgrade', k: 'house' }, housePrice, 20 * Math.min(foodCost, 600))
  }

  out.sort((a, b) => a.payback - b.payback)
  return out
}

/** 下一次该醒来的时刻（秒） */
export function nextWake(world, cfg, memo = {}) {
  const R = world.R
  const t = world.now
  const s = world.state
  const cands = []
  const backoffCands = []      // 退避候选单独放，免得被 maxSleep 截断（见函数末尾）
  const push = (sec) => { if (sec != null && sec >= 0 && Number.isFinite(sec)) cands.push(Math.max(1, Math.ceil(sec))) }
  const pushBackoff = (sec) => {
    if (sec == null || !(sec >= 0) || !Number.isFinite(sec)) return
    const v = Math.max(1, Math.ceil(sec))
    cands.push(v); backoffCands.push(v)
  }

  const weather = R.weatherOf(R.isleDay(t))
  // 作物成熟
  for (let i = 0; i < s.plotN; i++) {
    const p = s.plots[i]
    if (!p) continue
    const auto = R.sprinkled(s, i) || weather === 1
    const st = R.cropStage(p, t, auto)
    if (st.stage === 3) push(1)
    else if (st.stage >= 0) push(st.left)
  }
  // 浇水阶段
  if (cfg.farm?.water && weather !== 1) {
    for (let i = 0; i < s.plotN; i++) {
      const p = s.plots[i]
      if (!p || R.sprinkled(s, i)) continue
      const st = R.cropStage(p, t)
      if (st.stage >= 0 && st.stage < 3 && p.w <= st.stage) push(1)
    }
  }
  // 动物产出 / 喂食
  for (const pen of s.barn) {
    const st = R.animalReady(pen, t)
    if (st.ready) push(1)
    if (!st.retired && t - pen.f >= 8 * 3600) push(1)
    // 下一件产物的到达时刻（榜一「事件桶」里最容易漏掉的一个）。
    //
    // animalReady 返回的 nextP 是循环结束后的 cursor——即「最后一件产物完成的时刻」，
    // 不是「下一件产出的时刻」。真正的下一件在 cursor + period。
    // 窝满时 nextP = max(cursor, until)，此时停产，只能等我们收走。
    // 只按「窝里有货」唤醒会导致：产出一件→收走→再等下一件，
    // 中间窝要是满了就白停一段时间。
    if (!st.retired && st.n < (st.def?.cap || 1)) {
      const period = st.period || 0
      const nextAt = (st.nextP || t) + period
      if (nextAt > t) push(Math.min(nextAt - t, R.WORLD.regen || 180))
    }
  }
  // 蟹笼
  for (const tr of s.traps) {
    const st = R.trapReady(tr, t, weather === 2)
    if (st.n) push(1)
  }
  // 体力回复（榜一的做法：体力见底时醒在「下一滴体力到账」的那一刻，而不是干等）
  //
  // 服务端 refresh()：s.enT 是回复周期的相位起点，
  //   下一滴体力在 enT + regen 处到账，之后每隔 regen 到账 1 点。
  // 旧写法是「按当前体力回满所需时间」算（(max-en)*180），
  // 那等于要求「回满才值得醒」，但钓鱼一次只要 4 点体力——
  // 现在有 1 点就能干活，等到回满完全是浪费。
  const maxEn = R.energyMax(s)
  if (s.en < maxEn) {
    const regen = R.WORLD.regen || 180
    const phase = Number(s.enT || s.now || t)
    // 下一滴体力的到账时刻：enT 之后第 (floor((t-enT)/regen)+1) 个 regen 点。
    // 例：enT=179 秒前、regen=180 → 下一滴在 1 秒后（不是 181 秒后）。
    let nextDrop = phase + (Math.floor(Math.max(0, (t - phase) / regen)) + 1) * regen
    if (nextDrop < t) nextDrop = t + 1
    const waitSec = Math.max(1, nextDrop - t)
    // 门槛用「有收益的活」里最便宜的那个（钓鱼 4），不能用 harvest/water 的 1 点——
    // 那两件事随时都能做，拿它当门槛等于永远不触发。
    const jobs = [R.WORLD.cost.fish ?? 4, R.WORLD.cost.mine ?? 3, R.WORLD.cost.bomb ?? 6].filter((x) => x > 0)
    const cheapest = jobs.length ? Math.min(...jobs) : 4
    if (s.en < cheapest) push(waitSec)                     // 一点有收益的活都干不了 → 醒在下一滴
    else if (s.en < cheapest * 2) push(waitSec + regen)    // 只够干一次 → 攒两滴再醒
    // 体力充足时不加这个候选：趟趟醒反而是浪费请求
  }
  // 换岛日（价格/额度刷新）
  push(R.b12NextIsleBoundary(t) - t)
  // 自然日 0 点（北京时间）：每日额度全部清零
  //   钓鱼 80 / 挖矿 100 / 加工 80 / 炸矿 10 / 咖啡 3 / 五子棋计奖 10 / 擂台掉落 30
  //   以及作物阶梯价计数 sc_<crop>、npc 计数
  // 之前只看岛日边界，导致 0 点后额度刷新了却可能一直等到 maxSleep 才醒。
  {
    const local = t + 8 * 3600                        // 转成北京时间的秒数
    const sinceMidnight = ((local % 86400) + 86400) % 86400
    const toMidnight = 86400 - sinceMidnight
    if (toMidnight > 0) push(toMidnight)
    // 长夜 22:00 开始 / 08:00 结束：夜潮小礼在这两个时刻刷新
    // （b12NightView 的 key 就取自 22:00 那天的日期，过了 08:00 就不能再领）
    const H = 3600
    const toNight = 22 * H - sinceMidnight                    // 距今晚 22:00
    if (toNight > 0) push(toNight)
    else {
      const toMorning = 8 * H - sinceMidnight                 // 还在长夜里，等 08:00 收尾
      if (toMorning > 0) push(toMorning)
    }
  }
  // 钓鱼时段开始
  if (cfg.work?.fish) {
    const h = R.isleHour(t)
    for (const f of R.FISH) {
      if (f.rod > s.tools.rod) continue
      let start = f.hours[0]
      while (start <= h) start += 24
      if (f.hours[0] === 0) continue
      const hoursUntil = start - h
      if (hoursUntil > 0 && hoursUntil < 24) push(hoursUntil * (R.ISLE_SPAN / 24))
    }
    // 整点唤醒：鱼池按「岛上小时」换（现实 10 分钟一格），
    // 还有竿数没用完时，每个整点醒一次，好时段一开始就下竿。
    // 只看「时段开始」不够——鱼种会在整点整点地进出，错过一格要再等一整个岛日。
    const fishLeft = R.WORLD.daily.fish - ((s.iq?.d === R.isleIndex(t) ? s.iq.fish : 0) || 0)
    if (fishLeft > 0 && !R.b12IsLongNight(t)) {
      const clock = R.b12ClockSeconds(t)
      const span = R.ISLE_SPAN / 24              // 一个岛上小时 = 现实 600 秒
      const toNextHour = span - (clock % span)
      if (toNextHour > 0) push(toNextHour + 2)
    }
  }

  // ---------- 每日额度没做完：缩短间隔（wake 参数由调用方传入） ----------
  // 这些事不受「作物成熟」等物理事件驱动，只要还有额度就该去做，
  // 否则会一直落到 maxSleep，白白空转。
  const day = R.worldDay(t)
  const dayLeft = Math.max(1, R.b12NextIsleBoundary(t) - t)
  const w = cfg.wake || {}

  // 退避是「全局」的：帮忙连续几轮没进展、或五子棋连续解不出棋谱，
  // 都说明**当前没有什么值得马上回来做的事**。这时如果只让出问题的那一个模块退避，
  // 其余模块仍会每 60 秒把整体唤醒一次，退避就白做了。
  // 所以：任何一个模块连续卡住，就把所有「额度驱动」的间隔一起放宽。
  const stallThreshold = w.stallThreshold ?? 3
  const stalling = (memo.helpStall || 0) >= stallThreshold || (memo.gomokuStall || 0) >= stallThreshold
  const idleWaitSec = Math.min(w.idleStall ?? 900, dayLeft)

  // 帮忙：每天 N 家，还有剩就尽快
  if (cfg.social?.help?.enabled) {
    const done = (memo.helpDay === day ? (memo.helpCount || 0) : 0)
    const need = (cfg.social.help.perDay ?? 10) - done
    if (need > 0 && s.en >= (cfg.social.help.minEnergy ?? 20)) {
      if (stalling) pushBackoff(idleWaitSec)
      else push(w.help ?? 60)
    }
  }

  // 五子棋：每天前 N 局计奖，没打完就尽快
  if (cfg.npc?.enabled && cfg.npc.gomoku) {
    const used = (s.enDay === day ? (s.cnt?.npc || 0) : 0)
    const paid = s.cnt?.gomokuPaid || 0
    const left = Math.min((cfg.npc.gomokuMaxGames ?? 10) - paid, R.NPC.daily - used)
    if (left > 0) {
      if (stalling) pushBackoff(idleWaitSec)
      else push(w.gomoku ?? 60)
    }
  }

  // 擂台：每天 N 场有掉落，没打完就尽快
  // 打满之后 arenaDaily 会直接返回，所以给个宽一点的间隔即可。
  if (cfg.arena?.enabled) {
    if (stalling) pushBackoff(idleWaitSec)
    else push(w.arena ?? 300)
  }

  // 偷菜：扫描间隔到了就该去（不加这个会一直等 maxSleep，实际扫描被拖慢）
  if (cfg.social?.steal?.enabled) {
    const last = memo.stealScanAt || 0
    const every = cfg.social.steal.scanEvery ?? 1800
    const left = Math.max(0, every - (t - last))

    // 精确解禁调度：把「某块地/某个畜栏什么时候能偷」也算进唤醒时刻。
    // 这是到点扫描做不到的——成熟后要过 protect(1800 秒) 才能偷，
    // 到点扫描很容易每次都差几分钟，永远偷不到刚解禁的那批。
    const nx = nextUnlock(memo.stealSchedule || {}, t, { leadSec: cfg.social.steal.prepLeadSec ?? 8 })
    if (nx) {
      // 解禁时刻比下次扫描更早 → 按解禁时刻醒来
      push(Math.min(left > 0 ? left : 5, nx.wakeIn))
    } else {
      push(left > 0 ? left : 5)
    }
  }

  // 兜底：没有更早的事件时也别睡太久
  //
  // 上限的算法要小心：退避（helpStall / gomokuStall）本来是想「这次别再来烦」，
  // 但如果无脑 Math.min(...cands, maxSleep)，退避值会被截回 120 秒，等于没做。
  //
  // 做法：退避候选单独记一个集合 backoffCands。
  // 如果最终选中的就是某个退避候选，就允许睡到退避上限；
  // 否则（说明有别的事更早）按正常 maxSleep 走。
  const maxSleep = cfg.loop?.maxSleep || 120
  const backoffCap = cfg.loop?.maxSleepForBackoff ?? 1800
  const raw = cands.length ? Math.min(...cands) : maxSleep
  // 选中的值若与某个退避候选相等（说明是它赢的），就套退避上限
  const wonByBackoff = backoffCands.length && raw === Math.min(...backoffCands)
  return Math.min(raw, wonByBackoff ? backoffCap : maxSleep)
}
