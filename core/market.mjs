// 市场预测与择时卖出（Node 版，和 extension/lib/market.mjs 同源逻辑）。
//
// 价格 = 基础价 × marketFactor(日期哈希：随机游走×季节×偶发事件)
//        × supplyFactor(上一个岛日全站卖出量, depth)  ← 唯一不确定项，钳位 [0.80, 1.06]
//        × eventFactor(商会事件，只依赖日期)
//
// 所以未来任意岛日的「基准报价」可精确预测，只有供需一个标量未知。
// 用当天服务端报价反推它：supply = 报价 / 基准报价。

const clampSupply = (s) => Math.max(0.8, Math.min(1.06, s))

export function isleDays(R, now, count = 8) {
  const out = []
  let t = now
  for (let k = 0; k < count; k++) {
    const day = R.isleDay(t)
    out.push({
      at: t, end: R.b12NextIsleBoundary(t), day, index: R.isleIndex(t),
      season: R.seasonOf(day), weather: R.weatherOf(day),
      events: R.marketEvents(day).map((e) => ({ id: e.id, text: e.text, m: e.m, items: e.items })),
    })
    t = R.b12NextIsleBoundary(t)
  }
  return out
}

/** 无供需扰动的报价：base × marketFactor × eventFactor */
export function baseQuote(R, id, day) {
  const base = R.BASE_PRICE[id]
  if (!base) return 0
  return Math.max(1, Math.round(base * R.marketFactor(id, day) * R.eventFactor(id, day)))
}

/** 逐物品反推当前供需 */
export function inferSupply(R, prices, day) {
  const rows = {}
  for (const id of Object.keys(R.BASE_PRICE)) {
    const q = baseQuote(R, id, day)
    const p = Number(prices?.[id]) || 0
    if (!q || !p) continue
    const s = p / q
    const depth = R.marketDepth(id)
    const tol = 0.5 / p + 0.5 / q
    const clampedLow = s <= 0.8 + tol
    const clampedHigh = s >= 1.06 - tol
    rows[id] = {
      quote: q, price: p, raw: s, supply: clampSupply(s), depth,
      clampedLow, clampedHigh,
      soldRatio: clampedHigh ? 0 : (1.06 - clampSupply(s)) / 0.3,
      soldSolid: (!clampedHigh && !clampedLow) ? (1.06 - clampSupply(s)) / 0.3 : null,
    }
  }
  return { day, rows, n: Object.keys(rows).length }
}

/** 卖掉 units 个后，下一个岛日的供需 */
export function supplyAfterSelling(R, id, units, externalRatio = 0) {
  const depth = R.marketDepth(id)
  return clampSupply(1.06 - 0.3 * ((units + Math.max(0, externalRatio) * depth) / depth))
}

/** 学习别人每岛日卖多少（指数滑动平均） */
export function learnExternal(prev, obs, mySoldRatio = {}, alpha = 0.35) {
  const out = { ...(prev || {}) }
  for (const [id, r] of Object.entries(obs.rows)) {
    const observed = r.soldSolid != null ? r.soldSolid
      : r.clampedLow ? Math.max(0, 0.867 - (mySoldRatio[id] || 0)) : 0
    const mine = Math.max(0, mySoldRatio[id] || 0)
    const ext = Math.max(0, observed - mine)
    out[id] = out[id] == null ? ext : out[id] * (1 - alpha) + ext * alpha
  }
  return out
}

/** 未来 n 个岛日的价格预测 */
export function forecastPrices(R, now, prices, { days = 8, external = {}, plannedSells = {} } = {}) {
  const rows = isleDays(R, now, days)
  const cur = inferSupply(R, prices, rows[0].day)
  return rows.map((d, k) => {
    const out = { ...d, price: {}, low: {}, high: {}, supply: {} }
    for (const id of Object.keys(R.BASE_PRICE)) {
      if (k === 0 && Number(prices?.[id]) > 0) {
        const p = Number(prices[id])
        out.price[id] = p; out.low[id] = p; out.high[id] = p
        out.supply[id] = cur.rows[id]?.supply ?? 1
        continue
      }
      const q = baseQuote(R, id, d.day)
      const ext = external[id] || 0
      const sell = plannedSells[id] || 0
      out.supply[id] = supplyAfterSelling(R, id, sell, ext)
      out.price[id] = Math.max(1, Math.round(q * out.supply[id]))
      // 区间：外部流量 0 ~ 2 倍波动
      out.low[id] = Math.max(1, Math.round(q * supplyAfterSelling(R, id, sell, ext * 2 + (ext ? 0 : 0.45))))
      out.high[id] = Math.max(1, Math.round(q * supplyAfterSelling(R, id, sell, 0)))
    }
    return out
  })
}

/** 作物同日阶梯价系数 */
export function cropTierRatio(R, soldToday, n) {
  const tiers = R.CROP_TIERS || [[Infinity, 1]]
  let acc = 0, k = soldToday, left = n
  for (const [upTo, pct] of tiers) {
    if (left <= 0) break
    if (k >= upTo) continue
    const take = Math.min(left, upTo - k)
    acc += take * pct; k += take; left -= take
  }
  if (left > 0) acc += left * (tiers[tiers.length - 1][1] || 1)
  return n > 0 ? acc / n : 1
}

/** 卖出实收（含累进税） */
export function netSaleQuote(R, wallet, paid, gross) {
  if (typeof R.b12SaleQuote === 'function') {
    const q = R.b12SaleQuote(wallet, paid, gross)
    return { tax: q.tax, net: gross - q.tax }
  }
  const marginal = (v) => {
    const ex = Math.max(0, v - 3e6)
    return Math.min(ex, 7e6) * 0.001 + Math.max(0, ex - 7e6) * 0.003
  }
  const tax = Math.max(0, Math.min(gross, marginal(wallet + gross) - marginal(wallet)))
  return { tax, net: gross - tax }
}

/**
 * 择时卖出总表。返回每件货的现价/峰值/建议。
 * world 需要 { coins, state, prices }
 */
export function sellPlan(R, now, world, cfg = {}) {
  const days = cfg.days ?? 12
  const markdown = (cfg.markdownPct ?? 6) / 100
  const external = cfg.external || {}
  const wallet = Number(world.coins) || 0
  const paid = Number(world.state?.b12?.tax?.paid) || 0
  const fc = forecastPrices(R, now, world.prices, { days, external })
  const cur = inferSupply(R, world.prices, fc[0].day)
  const rows = []

  for (const id of Object.keys(R.BASE_PRICE)) {
    const base = R.BASE_PRICE[id] || 0
    const p0 = Number(world.prices?.[id]) || 0
    if (!base || !p0) continue
    const vault = world.state?.b12?.vault?.[id]
    let qty = 0
    for (let q = 0; q < 3; q++) qty += Math.max(0, (world.state?.inv?.[id]?.[q] || 0) - (vault?.[q] || 0))
    if (qty <= 0) continue

    const isCrop = !!R.CROPS?.some((c) => c.id === id)
    const soldToday = isCrop ? (world.state?.cnt?.['sc_' + id] || 0) : 0
    const ratio = isCrop ? cropTierRatio(R, soldToday, qty) : 1
    const grossNow = Math.round(p0 * ratio * qty)
    const nowQuote = netSaleQuote(R, wallet, paid, grossNow)

    let best = { k: 0, price: p0, net: nowQuote.net, gross: grossNow }
    for (let k = 1; k < fc.length; k++) {
      const day = fc[k]
      const price = baseQuote(R, id, day.day) * supplyAfterSelling(R, id, 0, external[id] || 0)
      const t2 = isCrop ? cropTierRatio(R, 0, qty) : 1
      const gross = Math.round(price * t2 * qty)
      const q = netSaleQuote(R, wallet, 0, gross)
      if (q.net > best.net) best = { k, price, net: q.net, gross }
    }

    rows.push({
      id, name: R.ITEM_NAME?.[id] || id, qty, base,
      cur: p0, curPct: p0 / base - 1,
      supply: cur.rows[id]?.supply ?? 1,
      soldYesterday: cur.rows[id]?.soldSolid,
      peak: best.price, peakIn: best.k, peakPct: best.price / base - 1,
      peakDay: fc[best.k].day,
      netNow: nowQuote.net, netAtPeak: best.net, gain: best.net - nowQuote.net,
      line: Math.round(best.price * (1 - markdown)),
      sellNow: p0 >= Math.round(best.price * (1 - markdown)),
      isCrop, soldToday, tierRatio: ratio,
    })
  }
  rows.sort((a, b) => b.gain - a.gain)
  return { forecast: fc, supply: cur, rows, days, markdownPct: cfg.markdownPct ?? 6 }
}

/** 未来最贵的那天 */
export function bestSellMoment(R, now, prices, id, opts = {}) {
  const fc = forecastPrices(R, now, prices, opts)
  let best = { p: Number(prices?.[id]) || 0, k: 0, at: now, day: fc[0].day }
  fc.forEach((f, k) => { const p = f.price[id] || 0; if (p > best.p) best = { p, k, at: f.at, day: f.day } })
  return { price: best.p, inDays: best.k, at: best.at, day: best.day, now: Number(prices?.[id]) || 0 }
}
