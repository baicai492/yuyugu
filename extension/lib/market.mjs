// 市场预测与择时卖出。全部数字来自站点自己的规则模块（前端线上那一份）与服务端当前报价，不写死。
//
// 价格公式（规则表原文）：
//   price(id) = BASE_PRICE[id] × marketFactor(id,day) × supplyFactor(soldYesterday, depth(id)) × eventFactor(id,day)
//
// 三个因子分三类：
//   1. marketFactor  —— 日期哈希的随机游走 × 季节 × 偶发暴涨暴跌，【完全可预测】
//   2. eventFactor   —— 商会事件，同样只由日期决定，【完全可预测】
//   3. supplyFactor  —— 上一个岛日「全站」卖出量决定，【只和成交量有关】
//
// 所以：任意未来岛日的「基准报价」可以精确算出来（baseQuote），
//       唯一的不确定性只剩 supplyFactor 这一个标量，而且被规则钳在 [0.80, 1.06]。
//
// 更关键的一条（实测确认）：supplyFactor 是【逐物品】的，且很多物品已经顶到钳位边界。
// 作物类 depth = clamp(1600000/基础价, 800, 6000)，最浅 800：
// 一个岛日卖掉约 (1.06-0.80)/0.3 × 800 ≈ 694 个，就能把次日价格砸到地板。
// 因此「一次性把货全清」会自己毁掉第二天的行情——这是择时卖出必须建模的成本。

const ITEMS = (R) => Object.keys(R.BASE_PRICE)
const clampSupply = (s) => Math.max(0.8, Math.min(1.06, s))

// 把当前岛日及其后 n 个岛日的边界算出来（每个岛日约现实 4 小时，边界处刷新价格与行情事件）
export function isleDays(R, now, count = 8) {
  const out = []
  let t = now
  for (let k = 0; k < count; k++) {
    const day = R.isleDay(t)
    out.push({
      at: t,
      end: R.b12NextIsleBoundary(t),
      day,
      index: R.isleIndex(t),
      season: R.seasonOf(day),
      weather: R.weatherOf(day),
      events: R.marketEvents(day).map((e) => ({ id: e.id, text: e.text, m: e.m, items: e.items })),
    })
    t = R.b12NextIsleBoundary(t)
  }
  return out
}

// 无供需扰动的报价：base × marketFactor × eventFactor。priceOf(id, day, 0) 就是它。
export function baseQuote(R, id, day) {
  const base = R.BASE_PRICE[id]
  if (!base) return 0
  return Math.max(1, Math.round(base * R.marketFactor(id, day) * R.eventFactor(id, day)))
}

// 逐物品反推当前岛日的供需系数：supply = 实际报价 / 基准报价。
// 还能反推「上一个岛日全站卖出了这个物品多少」——钳位的样本只知道区间。
export function inferSupply(R, prices, day) {
  const rows = {}
  let n = 0
  for (const id of ITEMS(R)) {
    const q = baseQuote(R, id, day)
    const p = Number(prices?.[id]) || 0
    if (!q || !p) continue
    const s = p / q
    const depth = R.marketDepth(id)
    // 取整误差：报价是 round 过的，相对误差按 0.5/p 估
    const tol = 0.5 / p + 0.5 / q
    const clampedLow = s <= 0.8 + tol
    const clampedHigh = s >= 1.06 - tol
    rows[id] = {
      quote: q, price: p, supply: clampSupply(s), raw: s, depth, tol,
      clampedLow, clampedHigh,
      // 反推的上个岛日卖出量（相对 depth 的比例）。钳高说明几乎没人卖，钳低说明卖爆了。
      soldRatio: clampedHigh ? 0 : (1.06 - clampSupply(s)) / 0.3,
      soldSolid: !clampedHigh && !clampedLow ? (1.06 - clampSupply(s)) / 0.3 : null,
    }
    n++
  }
  return { day, rows, n }
}

// 卖 units 个 id 之后，下一个岛日的供需系数。
// externalRatio 是「除我之外的人」这个岛日会卖掉的量（相对 depth 的比例），来自历史学习。
export function supplyAfterSelling(R, id, units, externalRatio = 0) {
  const depth = R.marketDepth(id)
  const ratio = (units + Math.max(0, externalRatio) * depth) / depth
  return clampSupply(1.06 - 0.3 * ratio)
}

// 学习「别人每个岛日卖多少」：观察到的 soldRatio 减去我自己卖的份，做指数滑动平均。
// 历史存在外部（插件 storage / 日志），这里只做纯计算。
export function learnExternal(prev, obs, mySoldRatio, alpha = 0.35) {
  const out = { ...(prev || {}) }
  for (const [id, r] of Object.entries(obs.rows)) {
    const solid = r.soldSolid
    // 顶到钳位边界时，只能确认「外部卖出 ≥ 0」或「外部几乎没卖」，按边界给一个先验
    const observed = solid != null ? solid : r.clampedLow ? Math.max(0, 0.867 - (mySoldRatio?.[id] || 0)) : 0
    const mine = Math.max(0, mySoldRatio?.[id] || 0)
    const ext = Math.max(0, observed - mine)
    const old = out[id]
    out[id] = old == null ? ext : old * (1 - alpha) + ext * alpha
  }
  return out
}

// 未来 n 个岛日的完整价格预测。
// 第 0 天用服务端实测报价；之后用 baseQuote × 预测供需。
// 预测供需 = 我接下来不动用该物品时的供需（外部流量按学习值），再给出 [悲观(自己砸盘), 乐观] 区间。
export function forecastPrices(R, now, prices, { days = 8, external = {}, plannedSells = {} } = {}) {
  const daysRows = isleDays(R, now, days)
  const cur = inferSupply(R, prices, daysRows[0].day)
  return daysRows.map((d, k) => {
    const out = { ...d, price: {}, low: {}, high: {}, supply: {} }
    for (const id of ITEMS(R)) {
      if (k === 0 && Number(prices?.[id]) > 0) {
        const p = Number(prices[id])
        out.price[id] = p; out.low[id] = p; out.high[id] = p
        out.supply[id] = cur.rows[id]?.supply ?? 1
        continue
      }
      const q = baseQuote(R, id, d.day)
      const ext = external[id] || 0
      const sell = plannedSells[id] || 0
      const s = supplyAfterSelling(R, id, sell, ext)
      // 区间：外部流量按学习值的 0 到 2 倍波动（不知情时就是规则的整个钳位区间）
      const sLow = supplyAfterSelling(R, id, sell, ext * 2 + (ext ? 0 : R.marketDepth(id) * 0.45))
      const sHigh = supplyAfterSelling(R, id, sell, 0)
      out.supply[id] = s
      out.price[id] = Math.max(1, Math.round(q * s))
      out.low[id] = Math.max(1, Math.round(q * sLow))
      out.high[id] = Math.max(1, Math.round(q * sHigh))
    }
    return out
  })
}

// 作物同日阶梯价：同一天同一种作物，前 150 个全价、151–400 个 85%、之后 70%。
// 返回「再卖 n 个」的加权单价系数。
export function cropTierRatio(R, soldToday, n) {
  const tiers = R.CROP_TIERS || [[Infinity, 1]]
  let acc = 0, k = soldToday, left = n
  for (const [upTo, pct] of tiers) {
    if (left <= 0) break
    if (k >= upTo) continue
    const take = Math.min(left, upTo - k)
    acc += take * pct
    k += take; left -= take
  }
  if (left > 0) acc += left * (tiers[tiers.length - 1][1] || 1)
  return n > 0 ? acc / n : 1
}

// 每次卖出的实收（扣累进卖货税）。规则原文 b12SaleQuote：3e6 以下免税，之上 0.1%，1e7 之上 0.3%。
export function netSaleQuote(R, wallet, paid, gross) {
  if (typeof R.b12SaleQuote === 'function') {
    const q = R.b12SaleQuote(wallet, paid, gross)
    return { tax: q.tax, net: gross - q.tax }
  }
  // 老版本没有这个函数时退回保守估计
  const marginal = (v) => {
    const ex = Math.max(0, v - 3e6)
    return (Math.min(ex, 7e6) * 0.001 + Math.max(0, ex - 7e6) * 0.003)
  }
  const tax = Math.max(0, Math.min(gross, marginal(wallet + gross) - marginal(wallet)))
  return { tax, net: gross - tax }
}

// 择时卖出总表。和插件面板一致的口径，但多了三件老面板没算的事：
//   1. 作物阶梯价（当天卖出越多，单价越低）
//   2. 卖货累进税（钱包越大，税越重）
//   3. 自己砸盘（今天卖太多，明天这个物品的供需被打到底）
export function sellPlan(R, now, prices, world, cfg = {}) {
  const days = cfg.days ?? 12
  const markdown = (cfg.markdownPct ?? 6) / 100
  const external = cfg.external || {}
  const wallet = Number(world.coins) || 0
  const paid = Number(world.state?.b12?.tax?.paid) || 0
  const fc = forecastPrices(R, now, prices, { days, external })
  const cur = inferSupply(R, prices, fc[0].day)
  const rows = []

  for (const id of ITEMS(R)) {
    const base = R.BASE_PRICE[id] || 0
    const p0 = Number(prices?.[id]) || 0
    if (!base || !p0) continue
    const vault = world.state?.b12?.vault?.[id]
    let qty = 0
    for (let q = 0; q < 3; q++) qty += Math.max(0, (world.state?.inv?.[id]?.[q] || 0) - (vault?.[q] || 0))
    if (qty <= 0) continue
    const isCrop = !!R.CROPS?.some((c) => c.id === id)
    const soldToday = isCrop ? (world.state?.cnt?.['sc_' + id] || 0) : 0
    // 今天卖掉全部库存的税后实收（含阶梯价与税）
    const ratio = isCrop ? cropTierRatio(R, soldToday, qty) : 1
    const grossNow = Math.round(p0 * ratio * qty)
    const nowQuote = netSaleQuote(R, wallet, paid, grossNow)
    // 未来每一天都算一遍：假设那天卖 qty 个（含砸盘），取税后实收最高的那天
    let best = { k: 0, price: p0, net: nowQuote.net, gross: grossNow }
    for (let k = 1; k < fc.length; k++) {
      const day = fc[k]
      const ext = external[id] || 0
      // 那天卖 qty 会把「再下一天」砸下去，但当天卖价由【前一天】的成交量决定，与当天自己卖多少无关
      const sellPrice = baseQuote(R, id, day.day) * supplyAfterSelling(R, id, 0, ext)
      const t2 = isCrop ? cropTierRatio(R, 0, qty) : 1
      const gross = Math.round(sellPrice * t2 * qty)
      const q = netSaleQuote(R, wallet, 0, gross)
      if (q.net > best.net) best = { k, price: sellPrice, net: q.net, gross }
    }
    const line = Math.round(best.price * (1 - markdown))
    rows.push({
      id, name: R.ITEM_NAME?.[id] || id, qty, base,
      cur: p0, curPct: p0 / base - 1,
      supply: cur.rows[id]?.supply ?? 1,
      soldYesterday: cur.rows[id]?.soldSolid,
      peak: best.price, peakIn: best.k, peakPct: best.price / base - 1,
      peakDay: fc[best.k].day,
      netNow: nowQuote.net, netAtPeak: best.net,
      gain: best.net - nowQuote.net,
      line,
      sellNow: p0 >= line,
      isCrop, soldToday,
      tierRatio: ratio,
    })
  }
  rows.sort((a, b) => b.gain - a.gain)
  return { forecast: fc, supply: cur, rows, days, markdownPct: cfg.markdownPct ?? 6 }
}

// 今日还能按全价卖多少个（作物的阶梯上限）；超出部分只有 85%/70%，通常该留到明天。
export function cropTierLeft(R, state, id) {
  const tiers = R.CROP_TIERS || [[Infinity, 1]]
  const sold = state?.cnt?.['sc_' + id] || 0
  const out = []
  let k = sold
  for (const [upTo, pct] of tiers) {
    if (k >= upTo) continue
    out.push({ pct, n: Math.min(upTo - k, Number.isFinite(upTo) ? upTo - k : Infinity) })
    k = upTo
  }
  return out
}

// 某个物品未来最贵的那天。
export function bestSellMoment(R, now, prices, id, opts = {}) {
  const fc = forecastPrices(R, now, prices, opts)
  let best = { p: Number(prices?.[id]) || 0, k: 0, at: now, day: fc[0].day }
  fc.forEach((f, k) => { const p = f.price[id] || 0; if (p > best.p) best = { p, k, at: f.at, day: f.day } })
  return { price: best.p, inDays: best.k, at: best.at, day: best.day, now: Number(prices?.[id]) || 0 }
}
