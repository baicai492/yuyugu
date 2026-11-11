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

/** 作物成熟时间（秒） */
export function cropReadyIn(R, s, p, t) {
  const st = R.cropStage(p, t, R.sprinkled(s, s.plots.indexOf(p)) || R.weatherOf(R.isleDay(t)) === 1)
  return st.stage === 3 ? 0 : Math.max(0, st.left)
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

  const goals = R.dailyGoals(R.worldDay(t), s)
  for (let k = 0; k < 4; k++) {
    if (!s.cnt['goal' + k] && (s.cnt[goals[k]?.id] || 0) >= goals[k]?.n) push({ a: 'goal', k })
  }
  if (!s.cnt.goal4 && [0, 1, 2, 3].every((k) => s.cnt['goal' + k])) push({ a: 'goal', k: 4 })

  // ---------- 2. 收割 / 收产物 / 收蟹笼（成熟即收，防偷） ----------
  const weather = R.weatherOf(R.isleDay(t))
  let harvested = 0, collected = 0, trapped = 0
  for (let i = 0; i < s.plotN; i++) {
    const p = s.plots[i]
    if (!p) continue
    const auto = R.sprinkled(s, i) || weather === 1
    const st = R.cropStage(p, t, auto)
    if (st.stage === 3) { if (push({ a: 'harvest', i })) harvested++ }
    else if (st.stage === -1) push({ a: 'clear', i })
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

  // ---------- 5. 补种 ----------
  if (cfg.farm?.enabled) {
    const season = R.seasonOf(R.isleDay(t))
    const best = cfg.farm.preferCrop
      ? R.CROPS.find((c) => c.id === cfg.farm.preferCrop && c.seasons.includes(season))
      : bestCropFor(R, season, expPrices)
    const empty = []
    for (let i = 0; i < s.plotN; i++) if (!s.plots[i]) empty.push(i)
    if (best && empty.length) {
      // 留几块地种口粮：口粮是当天就会吃掉的，按现价评估回体力的性价比
      const foodCrop = R.CROPS.filter((c) => c.seasons.includes(season))
        .sort((a, b) => ((prices[a.id] || a.price) / a.eat) - ((prices[b.id] || b.price) / b.eat))[0]
      const foodCount = Math.min(empty.length, cfg.farm.foodPlots || 0)
      let planted = 0
      empty.forEach((i, idx) => {
        const c = idx < foodCount && foodCrop ? foodCrop : best
        if (push({ a: 'plant', i, c: c.id })) planted++
      })
      if (planted) summary.push(`补种 ${planted} 块（${best.name}${foodCount ? ' + 口粮' : ''}）`)
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
      if (push({ a: 'craft', id: r.id, n })) { made += n; summary.push(`加工 ${r.name}×${n}`) }
    }
  }

  // ---------- 8. 花体力做最高收益的事（钓/挖/炸） ----------
  if (cfg.work) {
    // 口粮是立刻消耗掉的，按现价算成本
    const eatCost = foodChoices(R, s, prices)[0]?.costPerEnergy ?? 300
    const reserve = Math.max(0, cfg.energy?.minEnergyToLeave ?? 0)
    let guard = 0
    while (s.en >= 3 && guard++ < 200) {
      const fishLeft = R.WORLD.daily.fish - ((s.iq?.d === R.isleIndex(t) ? s.iq.fish : 0) || 0)
      const mineLeft = R.WORLD.daily.mine - ((s.iq?.d === R.isleIndex(t) ? s.iq.mine : 0) || 0)
      const bombLeft = R.WORLD.daily.bomb - ((s.iq?.d === R.isleIndex(t) ? s.iq.bomb : 0) || 0)
      const useBait = cfg.work.bait && (s.inv.bait?.[0] || 0) > 0
      // 钓到的鱼、挖到的矿都要囤到价格峰值才卖，按未来均价估才准
      const fishVal = cfg.work.fish && fishLeft > 0 ? fishEV(R, s, t, expPrices, useBait) : -1
      const mineVal = cfg.work.mine && mineLeft >= 3 ? mineEV(R, s, expPrices, false) / (1.25 + 0.05 * s.tools.pick) : -1
      const bombVal = cfg.work.bomb && bombLeft > 0 && mineLeft >= 6 && (s.inv.bomb?.[0] || 0) > 0 ? mineEV(R, s, expPrices, true) : -1
      const jobs = []
      if (fishVal > 0 && s.en >= R.WORLD.cost.fish) jobs.push({ a: { a: 'fish', bait: useBait }, cost: R.WORLD.cost.fish, v: fishVal / R.WORLD.cost.fish, label: '钓鱼' })
      if (mineVal > 0 && s.en >= R.WORLD.cost.mine) jobs.push({ a: { a: 'mine', f: Math.min(s.mine.max, R.PICK_FLOOR[s.tools.pick]) }, cost: R.WORLD.cost.mine, v: mineVal / R.WORLD.cost.mine, label: '挖矿' })
      if (bombVal > 0 && s.en >= R.WORLD.cost.bomb) jobs.push({ a: { a: 'bomb', f: Math.min(s.mine.max, R.PICK_FLOOR[s.tools.pick]) }, cost: R.WORLD.cost.bomb, v: bombVal / R.WORLD.cost.bomb, label: '炸矿' })
      jobs.sort((x, y) => y.v - x.v)
      const job = jobs[0]
      if (!job) break
      // 收益必须高于口粮成本，否则不值得做
      if (job.v <= eatCost * (cfg.work.minValueRatio ?? 1.2)) break
      if (!push(job.a)) break
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
    let sold = 0
    for (const r of sells.slice(0, cfg.sell.maxSellPerRound || 40)) {
      // 按品质从高到低卖
      for (let q = 2; q >= 0 && r.n > 0; q--) {
        const have = R.b12Available(s, r.id, q)
        if (have <= 0) continue
        const take = Math.min(999, have, r.n)
        if (push({ a: 'sell', id: r.id, q, n: take })) { r.n -= take; sold++ }
      }
    }
    if (sold) summary.push(`卖出 ${sold} 格`)
  }

  // ---------- 10. 货船进货 ----------
  if (cfg.cargo?.enabled) {
    const stock = R.b12Stock(t, prices)
    let bought = 0
    for (const it of stock) {
      if (bought >= (cfg.cargo.maxItems || 12)) break
      const left = R.b12StockLeft(s, it, t)
      if (left <= 0) continue
      // 未来能卖出的最高价
      const fc = M.forecastPrices(R, t, prices, { days: 6, external: world.externalSoldRatio || {} })
      const peak = Math.max(...fc.map((f) => f.price[it.id] || 0))
      const margin = peak / it.price - 1
      if (margin < (cfg.cargo.minMargin || 0.08)) continue
      const n = Math.min(left, it.limit, Math.max(1, Math.floor((coins - (cfg.cargo.reserveCoins || 0)) / it.price)))
      if (n <= 0) continue
      if (push({ a: 'stockBuy', id: it.id, n, day: R.isleDay(t) })) { bought++; summary.push(`货船进 ${it.name}×${n}（预期 +${(margin * 100).toFixed(0)}%）`) }
    }
  }

  return { actions, summary, coinsAfter: coins }
}

/** 投资建议：只买预计 N 天内回本的 */
export function planInvestments(R, s, prices, coins, cfg, t) {
  const out = []
  const reserve = cfg.invest?.reserveCoins || 0
  const maxPayback = cfg.invest?.maxPaybackDays || 10

  const add = (name, action, cost, dailyGain) => {
    if (cost == null || !(dailyGain > 0)) return
    const payback = cost / dailyGain
    if (payback > maxPayback) return
    out.push({ name, action, cost, dailyGain, payback })
  }

  // 地块
  if (s.plotN < Math.min(R.WORLD.plotsMax, cfg.invest?.maxPlot ?? 24)) {
    const price = R.WORLD.plotPrice(s.plotN + 1)
    const best = bestCropFor(R, R.seasonOf(R.isleDay(t)), prices)
    if (best) {
      const perDay = (best.price * 1.54 * 1.285 - best.seed) * (1440 / Math.max(1, best.grow)) * 6
      add(`开垦第 ${s.plotN + 1} 块地`, { a: 'expand', k: 'plot' }, price, perDay)
    }
  }
  // 工具
  for (const tool of ['rod', 'pick', 'spr']) {
    const maxLv = { rod: cfg.invest?.maxRod ?? 4, pick: cfg.invest?.maxPick ?? 4, spr: cfg.invest?.maxSpr ?? 3 }[tool]
    if (s.tools[tool] >= maxLv) continue
    const price = R.upgradePrice(s, tool)
    if (price == null) continue
    const dailyGain = { rod: 300000, pick: 200000, spr: 150000 }[tool] * (s.tools[tool] + 1)
    add(`${tool === 'rod' ? '鱼竿' : tool === 'pick' ? '镐子' : '洒水器'} Lv${s.tools[tool] + 1}`, { a: 'upgrade', k: tool }, price, dailyGain)
  }
  // 蟹笼
  if (s.traps.length < R.WORLD.trapMax) {
    const price = R.WORLD.trapPrice(s.traps.length + 1)
    add(`第 ${s.traps.length + 1} 个蟹笼`, { a: 'buyTrap' }, price, 60000)
  }
  // 畜栏 + 动物
  if (s.barn.length < s.barnN) {
    for (const a of R.ANIMALS) {
      const perDay = (a.productPrice * 1.2 * 1440) / a.every - 300
      add(a.name, { a: 'buyAnimal', k: a.id }, a.price, perDay)
    }
  } else if (s.barnN < Math.min(R.WORLD.barnMax, cfg.invest?.maxBarn ?? 8)) {
    const price = R.WORLD.barnPrice(s.barnN + 1)
    const a = R.ANIMALS[R.ANIMALS.length - 1]
    const perDay = (a.productPrice * 1.2 * 1440) / a.every - 300
    add(`扩畜栏 + ${a.name}`, { a: 'expand', k: 'barn' }, price + a.price, perDay)
  }
  // 小屋（体力上限）
  if (s.tools.house < Math.min(R.WORLD.houseMax, cfg.invest?.maxHouse ?? 0)) {
    const price = R.upgradePrice(s, 'house')
    add(`小屋 Lv${s.tools.house + 1}`, { a: 'upgrade', k: 'house' }, price, 100000)
  }
  out.sort((a, b) => a.payback - b.payback)
  return out
}

/** 下一次该醒来的时刻（秒） */
export function nextWake(world, cfg) {
  const R = world.R
  const t = world.now
  const s = world.state
  const cands = []
  const push = (sec) => { if (sec != null && sec >= 0 && Number.isFinite(sec)) cands.push(Math.max(1, Math.ceil(sec))) }

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
  }
  // 蟹笼
  for (const tr of s.traps) {
    const st = R.trapReady(tr, t, weather === 2)
    if (st.n) push(1)
  }
  // 体力回满
  if (s.en < R.energyMax(s)) {
    const n = Math.ceil((R.energyMax(s) - s.en) * R.WORLD.regen)
    push(n)
  }
  // 换岛日（价格/额度刷新）
  push(R.b12NextIsleBoundary(t) - t)
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
  }

  cands.push(cfg.loop?.maxSleep || 600)
  return Math.min(...cands, cfg.loop?.maxSleep || 600)
}
