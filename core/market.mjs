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
    // 报价是 round(q × s)，所以真实供需落在 [(p−0.5)/q, (p+0.5)/q]。
    // 这个区间才是「我们真正知道的」，点估计只是它的中点。
    //
    // 钳到 [0.8, 1.06] 之后如果区间被截断，说明供需顶到了边界：
    //   · 接地板 0.8  → 全站卖得太狠，我们只能知道「至少卖了这么多」，
    //                    具体量反推不出来（删失下界）
    //   · 顶天花板 1.06 → 根本没人卖，只能知道「至多卖了这么多」（删失上界）
    // 这两种情况必须显式标出来。把「区间一端贴在边界」当成精确值，
    // 会让后面的预测和卖货决策系统性地过度自信。
    const rawLo = (p - 0.5) / q
    const rawHi = (p + 0.5) / q
    const lo = clampSupply(rawLo)
    const hi = clampSupply(rawHi)
    const censored = rawLo <= 0.8 ? 'floor' : (rawHi >= 1.06 ? 'ceil' : null)
    // 兼容旧字段：以前的容差判据是 0.5/p + 0.5/q，这里用精确区间等价表达。
    const clampedLow = rawLo <= 0.8
    const clampedHigh = rawHi >= 1.06
    const supply = clampSupply(s)
    rows[id] = {
      quote: q, price: p, raw: s, supply, lo, hi, censored, depth,
      clampedLow, clampedHigh,
      soldRatio: clampedHigh ? 0 : (1.06 - supply) / 0.3,
      soldSolid: (!clampedHigh && !clampedLow) ? (1.06 - supply) / 0.3 : null,
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
      // 区间传播：未来唯一的未知量是「别人卖了多少」。
      // 它的不确定度直接用今天反推出来的供需区间换算——
      // 供需上限 hi 对应「卖得最少」，下限 lo 对应「卖得最多」：
      //   soldRatio = (1.06 − supply) / 0.3
      // 这样如果今天已经删失（顶到 0.8 或 1.06），区间会自然收敛到「明天
      // 大概率还是这个状态」，而不是凭空给一个 ±45% 的伪区间。
      const rec = cur.rows[id]
      const extLo = rec ? Math.max(0, (1.06 - rec.hi) / 0.3) : ext * 0.4
      const extHi = rec ? Math.max(extLo, (1.06 - rec.lo) / 0.3) : ext * 1.8
      // 外部卖得越多 → 供需越低 → 价格越低（glut）；卖得越少 → tight。
      const sBase = supplyAfterSelling(R, id, sell, ext)
      const sGlut = supplyAfterSelling(R, id, sell, Math.max(extHi, ext))
      const sTight = supplyAfterSelling(R, id, sell, Math.min(extLo, ext))
      out.supply[id] = sBase
      out.price[id] = Math.max(1, Math.round(q * sBase))
      out.low[id] = Math.max(1, Math.round(q * Math.min(sGlut, sTight)))
      out.high[id] = Math.max(1, Math.round(q * Math.max(sGlut, sTight)))
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
 * 未来到货：地里还没熟的作物，按「哪个岛日能收多少」列出来。
 *
 * 为什么卖货要用到它：作物每个自然日只有 150 件全价、250 件 85% 的额度，
 * 明后天陆续成熟的货会占掉那些额度。今天手里这批货如果还按「未来某天
 * 还有一份全价额度」去等，等到的就是第二档、第三档。
 *
 * 估算偏满（宁可催我们早点卖）：每块地每次收获期望 1.3 + 0.08w 个
 * （w=3 → 1.54），品质期望 1.285 倍（金星 35% / 银星 44% / 普通 21%），
 * 再乘 sellShare（默认 0.7）——剩下的当口粮和加工原料。
 * 已成熟（stage 3）的地不计：它们要么本轮已经收进 inventory 参与了卖出，
 * 要么在等体力，算进来会重复计数。
 */
/**
 * 一茬作物的成熟时刻。
 *
 * 洒水器/雨天走 auto 分支（服务端直接把总时长 ×0.6）；
 * 手工浇水不缩短 total，而是每次浇水把「剩余时间」折成 p.g += 25%。
 * 我们每个阶段都会浇，所以不能拿 cropStage(p, now, false).left 当剩余时间——
 * 那是「从现在起再也不浇水」的口径，会把玉米、南瓜这类长周期作物算晚半天以上，
 * 未来到货就会被排到更晚的岛日，档期占用算少。
 *
 * 这里按规则原文逐阶段推进（浇水 → 阶段边界 → 再浇水），
 * 结果和在线结算的 cropStage / water / harvest 完全一致。
 */
function cropMatureAt(R, p, from, auto) {
  const st0 = R.cropStage(p, from, auto)
  if (!st0 || st0.stage < 0) return Infinity
  if (auto) return st0.stage >= 3 ? from : from + st0.left
  const q = { ...p }
  let t = from
  for (let it = 0; it < 12; it++) {
    const st = R.cropStage(q, t, false)
    if (!st || st.stage < 0) return Infinity
    if (st.stage >= 3) return t
    if (q.w <= st.stage) {
      q.g += Math.floor(st.left * 0.25)
      q.w++
      continue
    }
    // 未浇水时，下一阶段出现在 el = (stage+1) × total / 3
    const tNext = q.t + ((st.stage + 1) * st.total) / 3
    if (!(tNext > t)) return Infinity
    t = tNext
  }
  return Infinity
}

export function cropArrivals(R, s, now, fc, { sellShare = 0.7 } = {}) {
  const out = {}
  if (!s?.plots?.length || !fc?.length) return out
  const bucketAt = (at) => {
    for (let k = 0; k < fc.length; k++) if (fc[k].end != null && at < fc[k].end) return k
    return -1
  }
  const rainy = R.weatherOf(R.isleDay(now)) === 1
  for (let i = 0; i < s.plots.length; i++) {
    const p = s.plots[i]
    if (!p?.c) continue
    const crop = R.CROPS?.find((c) => c.id === p.c)
    if (!crop) continue
    const sprinkled = R.sprinkled(s, i)
    const cur = R.cropStage(p, now, sprinkled || rainy)
    // 已成熟（stage 3）的地不计：它们要么本轮已经收进 inventory 参与了卖出，
    // 要么在等体力，算进来会重复计数。枯萎（stage -1）的也跳过。
    if (!cur || cur.stage < 0 || cur.stage >= 3) continue
    const first = cropMatureAt(R, p, now, sprinkled || rainy)
    if (!(first < Infinity)) continue
    // w=3：我们每轮都会把能浇的浇满，收获时的浇水数就是 3
    const w = 3
    const n = (1.3 + 0.08 * w) * sellShare
    const p2 = 0.05 + 0.1 * w, p1 = 0.2 + 0.08 * w
    const qAvg = p2 * 1.5 + p1 * 1.25 + (1 - p1 - p2)
    const cycles = crop.regrow && p.h + 1 < (crop.times || 1) ? (crop.times || 1) - (p.h + 1) : 0
    let at = first
    for (let c = 0; c <= cycles; c++) {
      if (!(at < Infinity)) break
      const k = at > now ? bucketAt(at) : 0
      if (k >= 0) (out[p.c] ||= []).push({ k, at, n, qAvg })
      // 下一茬：收获后 w/g 归零重新长，时长按那天的天气重算
      const fresh = { c: p.c, t: at, w: 0, g: 0, h: p.h + 1 + c }
      at = cropMatureAt(R, fresh, at, sprinkled || R.weatherOf(R.isleDay(at)) === 1)
    }
  }
  return out
}

/**
 * 精确分配（最小费用流）：把供应按「可用时点 × 自然日阶梯容量」分到各岛日。
 *
 * 逐件贪心在两种情况下会错：
 *   1. 供应有可用时点（明后天成熟的作物不能今天卖）——早到的货能填早档，
 *      晚到的不能，贪心会把早货填到后面的高价档，把前面的档空着；
 *   2. 阶梯容量按自然日而不是按岛日——同一个自然日有 3~4 个岛日，
 *      150/400 的额度是那几天共享的，不是每天各一份。
 *
 * 规模很小：供应 ≤ 桶数+1 组 × 自然日 ≤ 4 × 3 档，节点不到 40 个，
 * 连续最短路（SPFA）增广几十次就收敛。收益口径与旧版一致：
 * 未来岛日的预测价先打 (1−markdown) 折扣，今天用真实报价。
 */
function assignCrops(R, id, fc, supplies, { soldToday = 0, markdown = 0 } = {}) {
  const tiers = R.CROP_TIERS || [[Infinity, 1]]
  const NT = tiers.length
  const L = fc.length
  // 桶 → 自然日。没有 at 的合成数据按「一桶一天」处理，等价于旧行为。
  const dayKey = fc.map((f, k) => (f?.at != null ? R.worldDay(f.at) : '#' + k))
  const todayKey = dayKey[0]
  const dayKeys = [...new Set(dayKey)]
  const dOf = dayKey.map((d) => dayKeys.indexOf(d))
  const D = dayKeys.length

  // 每个自然日每档的剩余容量；今天要扣掉已经卖掉的件数
  const caps = dayKeys.map((d) => {
    const used = d === todayKey ? Math.max(0, soldToday) : 0
    const out = []
    let from = used
    for (const [upTo] of tiers) {
      if (!Number.isFinite(upTo)) { out.push(Infinity); break }
      out.push(Math.max(0, upTo - from))
      from = Math.max(from, upTo)
    }
    return out
  })

  // 每组供应在每个自然日能拿到的最好单价，和对应的桶下标
  const best = supplies.map((sp) => dayKeys.map((_, di) => {
    let bk = -1, bv = 0
    for (let k = 0; k < L; k++) {
      if (dOf[k] !== di || k < sp.u) continue
      const p = Number(fc[k].price?.[id]) || 0
      if (p <= 0) continue
      const v = p * (k === 0 ? 1 : Math.max(0, 1 - markdown))
      if (v > bv) { bv = v; bk = k }
    }
    return { k: bk, v: bv }
  }))

  const P = supplies.length
  const totalSupply = supplies.reduce((a, sp) => a + sp.n, 0) || 1
  const SRC = 0
  const supNode = (i) => 1 + i
  const dtNode = (di, ti) => 1 + P + di * NT + ti
  const SNK = 1 + P + D * NT
  const N = SNK + 1
  const to = [], cap = [], cost = [], next = [], head = new Array(N).fill(-1)
  const add = (u, v, c, w) => {
    to.push(v); cap.push(c); cost.push(w); next.push(head[u]); head[u] = to.length - 1
    to.push(u); cap.push(0); cost.push(-w); next.push(head[v]); head[v] = to.length - 1
  }

  const dayEdges = []
  for (let i = 0; i < P; i++) {
    add(SRC, supNode(i), supplies[i].n, 0)
    for (let di = 0; di < D; di++) {
      const b = best[i][di]
      if (b.k < 0 || !(b.v > 0)) continue
      for (let ti = 0; ti < NT; ti++) {
        const c = caps[di][ti]
        if (!(c > 0)) continue
        // 容量不能写 Infinity：回收流量要用「初始容量 − 剩余容量」，
        // Infinity − Infinity 会变成 NaN，第三次增广的流量就统计不到。
        const ecap = Math.min(Number.isFinite(c) ? c : supplies[i].n, supplies[i].n)
        const idx = to.length
        add(supNode(i), dtNode(di, ti), ecap, -(b.v * tiers[ti][1] * supplies[i].m))
        dayEdges.push({ idx, init: ecap, k: b.k, i })
      }
    }
  }
  for (let di = 0; di < D; di++) {
    for (let ti = 0; ti < NT; ti++) {
      const c = caps[di][ti]
      if (c > 0) add(dtNode(di, ti), SNK, Number.isFinite(c) ? c : totalSupply, 0)
    }
  }

  // SPFA 连续最短路：每次增广一条负费用（= 正收益）路径，直到没有正收益
  const EPS = 1e-9
  for (let iter = 0; iter < 500; iter++) {
    const dist = new Array(N).fill(Infinity)
    const pe = new Array(N).fill(-1)
    const inq = new Array(N).fill(false)
    const q = [SRC]
    dist[SRC] = 0; inq[SRC] = true
    while (q.length) {
      const u = q.shift()
      inq[u] = false
      for (let e = head[u]; e !== -1; e = next[e]) {
        if (!(cap[e] > EPS)) continue
        const v = to[e], nd = dist[u] + cost[e]
        if (nd < dist[v] - EPS) {
          dist[v] = nd; pe[v] = e
          if (!inq[v]) { inq[v] = true; q.push(v) }
        }
      }
    }
    if (!(dist[SNK] < -EPS)) break
    let f = Infinity
    for (let v = SNK; v !== SRC; v = to[pe[v] ^ 1]) f = Math.min(f, cap[pe[v]])
    if (!(f > EPS)) break
    for (let v = SNK; v !== SRC; v = to[pe[v] ^ 1]) { const e = pe[v]; cap[e] -= f; cap[e ^ 1] += f }
  }

  const plan = new Array(L).fill(0)
  let gross = 0, todayAll = 0
  for (const e of dayEdges) {
    const f = e.init - cap[e.idx]
    if (!(f > EPS)) continue
    // 收益和 plan 只统计当前库存（供应 0）：未来到货的收入不该算进
    // 「这批货等下去值多少」，否则日志里的分配收益会被明后天的收成撑高。
    if (supplies[e.i].u === 0 && e.k === 0) todayAll += f
    if (e.i !== 0) continue
    plan[e.k] += f
    gross += f * -cost[e.idx]
  }
  // 今天能卖的量：当前库存里能进今天的部分。同值槽位由未来（今天稍晚
  // 成熟、u=0）的到货去填时，可以等价换成现在卖，所以取两者较小值。
  return { today: Math.min(supplies[0].n, todayAll), plan, gross }
}

/**
 * 跨期最优分配：决定「今天卖多少、未来哪天卖多少」。
 *
 * 以前是二元判断——全卖今天，或者全等峰值日。但作物每个自然日有
 * 150 件全价 / 250 件 85% / 其余 70% 的阶梯，额度不用掉也不会累积。
 *
 * 把「未来 N 个岛日 × 三档阶梯」展开成容量桶之后：
 *   - 没有到货约束时，按单价降序填库存就是精确最优（线性问题）；
 *   - 带上未来到货（arrivals）后不再是纯线性，早到的货能填早档、
 *     晚到的不能，必须用 assignCrops 的费用流解。
 *
 * 未来天的单价先打 (1−markdown) 折扣，今天不打：未来的高价是预测，
 * 拿到手才算数。
 *
 * 自身砸价（卖得多会压低下一岛日价格）暂不建模：我们单品的量通常
 * 只有几十件，marketDepth 是 800~6000，影响在 1% 以内。
 */
export function allocateSale(R, id, qty, fc, { isCrop = false, soldToday = 0, qAvg = 1, markdown = 0, arrivals = [] } = {}) {
  if (!(qty > 0) || !fc?.length) return { today: 0, plan: [], netOptimal: 0 }
  if (!isCrop) {
    // 非作物没有阶梯，到货之间也不抢容量：每件选它能卖到的最高价那天
    const slots = []
    for (let k = 0; k < fc.length; k++) {
      const p = Number(fc[k].price?.[id]) || 0
      if (p <= 0) continue
      slots.push({ k, unit: p * qAvg * (k === 0 ? 1 : Math.max(0, 1 - markdown)) })
    }
    slots.sort((a, b) => b.unit - a.unit)
    const plan = new Array(fc.length).fill(0)
    if (slots.length) plan[slots[0].k] = qty
    return { today: plan[0] || 0, plan, netOptimal: qty * (slots[0]?.unit || 0) }
  }
  const supplies = [{ u: 0, n: qty, m: qAvg }]
  // 同一岛日的到货合并成一组（否则 24 块地 × 4 茬会有近百个供应节点）
  const byK = new Map()
  for (const a of arrivals) {
    if (!(a.n > 0) || !(a.k >= 0)) continue
    const g = byK.get(a.k) || { u: a.k, n: 0, q: 0 }
    g.n += a.n
    g.q += a.n * (a.qAvg ?? 1)
    byK.set(a.k, g)
  }
  for (const g of byK.values()) supplies.push({ u: g.u, n: g.n, m: g.q / g.n })
  const r = assignCrops(R, id, fc, supplies, { soldToday, markdown })
  return { today: r.today, plan: r.plan, netOptimal: r.gross }
}

/**
 * 终端清算（简化版）：不再假设「未来某天能按峰值一次全卖」，而是把货
 * 压到 horizon 的最后 keepDays 个岛日，按那几天的真实阶梯价逐件卖掉，
 * 算出「最迟什么时候、能拿回多少钱」。
 *
 * 为什么需要：sellPlan 的 peak 是「某一天全卖」的乐观估计——作物一天
 * 只有 150 件全价，一批 600 件在峰值日根本卖不出全价。这个函数给
 * 「一直等下去」一个可执行的下界，日志里能看到等峰值的真实收益，
 * 而不是被单日全价额度撑起来的虚高数字。
 *
 * 榜一的 objective.mjs 用它做整个规划的目标函数（期末净资产 = 现金 +
 * 真实清算价值）；我们只做卖货决策和日志，不引入完整的 rollout。
 */
export function liquidationValue(R, id, qty, fc, { isCrop = false, qAvg = 1, keepDays = 4 } = {}) {
  if (!(qty > 0) || !fc?.length) return { gross: 0, unitPrice: 0, byDay: [] }
  const start = Math.max(0, fc.length - Math.max(1, keepDays))
  const buckets = []
  for (let k = start; k < fc.length; k++) {
    const p = Number(fc[k].price?.[id]) || 0
    if (p <= 0) continue
    if (!isCrop) { buckets.push({ k, cap: Infinity, unit: p * qAvg }); continue }
    const tiers = R.CROP_TIERS || [[Infinity, 1]]
    let from = 0
    for (const [upTo, pct] of tiers) {
      if (upTo === Infinity) {
        buckets.push({ k, cap: Infinity, unit: p * pct * qAvg })
        break
      }
      const cap = Math.max(0, upTo - from)
      if (cap > 0) buckets.push({ k, cap, unit: p * pct * qAvg })
      from = Math.max(from, upTo)
    }
  }
  buckets.sort((a, b) => b.unit - a.unit)
  let left = qty, gross = 0
  const byDay = new Array(fc.length).fill(0)
  for (const b of buckets) {
    if (left <= 0) break
    const take = Math.min(left, b.cap)
    if (!(take > 0)) continue
    byDay[b.k] += take
    gross += take * b.unit
    left -= take
  }
  return { gross, unitPrice: qty > 0 ? gross / qty : 0, byDay, keepDays }
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
  // 售卖税的「当日已缴」按自然日重置（R:1650-1653 的 b12TaxSale：d.tax.day!==day
  // 就 paid=0）。b12SaleQuote 本身是纯函数、不管日界，所以这里必须自己判：
  // 跨过 0 点后 state.b12.tax 里还是昨天的 paid，直接拿来预测会高估今天的税，
  // 把「现在卖」判得比实际更亏。世界时钟未配置时规则不收税，同样按 0 处理。
  const taxDay = R.worldDay(now)
  const taxRec = world.state?.b12?.tax
  const paid = (taxRec && taxRec.day === taxDay) ? (Number(taxRec.paid) || 0) : 0
  const fc = forecastPrices(R, now, world.prices, { days, external })
  const cur = inferSupply(R, world.prices, fc[0].day)
  const rows = []
  // 未来到货只算一次（每块地要跑 cropStage，别在物品循环里重复算）
  let arrivalsAll = null
  const arrivalsOf = (id) => (arrivalsAll ||= cropArrivals(R, world.state, now, fc, { sellShare: cfg.futureSellShare ?? 0.7 }))[id] || []

  for (const id of Object.keys(R.BASE_PRICE)) {
    const base = R.BASE_PRICE[id] || 0
    const p0 = Number(world.prices?.[id]) || 0
    if (!base || !p0) continue
    const vault = world.state?.b12?.vault?.[id]
    let qty = 0, qSum = 0
    for (let q = 0; q < 3; q++) {
      const n = Math.max(0, (world.state?.inv?.[id]?.[q] || 0) - (vault?.[q] || 0))
      qty += n
      qSum += n * (R.QUALITY?.[q] ?? 1)
    }
    if (qty <= 0) continue

    const isCrop = !!R.CROPS?.some((c) => c.id === id)
    const soldToday = isCrop ? (world.state?.cnt?.['sc_' + id] || 0) : 0
    const ratio = isCrop ? cropTierRatio(R, soldToday, qty) : 1
    // 品质系数必须进收入：规则卖出时是**逐件** round(price*QUALITY[q])
    // （R:87、R:910），prices 里的 p0 是普通品质价。漏乘会把现价和峰值系统性地
    // 低估最多 50%，gain 跟着偏小 → planVault 判「锁仓不划算」、日志少报收益。
    // 用 qAvg 近似逐件取整，误差 < 1 个金币。
    const qAvg = qty > 0 ? qSum / qty : 1
    const grossNow = Math.round(p0 * ratio * qty * qAvg)
    const nowQuote = netSaleQuote(R, wallet, paid, grossNow)

    // 逐件最优：今天卖多少 / 未来哪天卖多少（阶梯 × 预测价，未来打折）
    const arrivals = isCrop ? arrivalsOf(id) : []
    const alloc = allocateSale(R, id, qty, fc, {
      isCrop, soldToday, qAvg, markdown, arrivals,
    })
    // 终端清算：把这批货压到 horizon 末尾几天按真实阶梯卖掉，
    // 给「一直等」一个可执行的下界（峰值是全卖单日的虚高口径）。
    const liq = liquidationValue(R, id, qty, fc, {
      isCrop, qAvg, keepDays: cfg.terminalDays ?? 4,
    })
    const liqQuote = netSaleQuote(R, wallet, paid, Math.round(liq.gross))
    // 逐件最优分配的总收入（税后）。和 netNow 口径一致，才能直接比较。
    const allocQuote = netSaleQuote(R, wallet, paid, Math.round(alloc.netOptimal))

    let best = { k: 0, price: p0, net: nowQuote.net, gross: grossNow }
    for (let k = 1; k < fc.length; k++) {
      const day = fc[k]
      const price = baseQuote(R, id, day.day) * supplyAfterSelling(R, id, 0, external[id] || 0)
      const t2 = isCrop ? cropTierRatio(R, 0, qty) : 1
      const gross = Math.round(price * t2 * qty * qAvg)
      const q = netSaleQuote(R, wallet, 0, gross)
      if (q.net > best.net) best = { k, price, net: q.net, gross }
    }

    rows.push({
      id, name: R.ITEM_NAME?.[id] || id, qty, base,
      cur: p0, curPct: p0 / base - 1,
      supply: cur.rows[id]?.supply ?? 1,
      // 供需区间与删失标记：supply 是点估计，lo/hi 才是「真正知道的」。
      // censored = 'floor' 表示已经卖到地板（谁都砸不动了），
      // 'ceil' 表示没人卖（价格还能再涨的空间也说不准）。
      supplyLo: cur.rows[id]?.lo ?? 1,
      supplyHi: cur.rows[id]?.hi ?? 1,
      censored: cur.rows[id]?.censored ?? null,
      soldYesterday: cur.rows[id]?.soldSolid,
      peak: best.price, peakIn: best.k, peakPct: best.price / base - 1,
      peakDay: fc[best.k].day,
      netNow: nowQuote.net, netAtPeak: best.net, gain: best.net - nowQuote.net,
      // 一直等到 horizon 末再清算能拿多少（真实阶梯，不是单日全价）
      netIfWait: liqQuote.net, liqUnit: liq.unitPrice, liqDays: liq.keepDays,
      // 折让只作用于未来岛日：峰值就在今天时再打折会让「卖线」低于现价，
      // 看上去像「现价已经超过卖线却不卖」，其实 MCMF 今天该卖就卖。
      line: Math.round(best.price * (best.k === 0 ? 1 : 1 - markdown)),
      todayQty: alloc.today,
      allocPlan: alloc.plan,
      allocNet: allocQuote.net,
      // 未来到货（已计入档期）：卖货日志里要能看出「为什么今天该卖」
      soonQty: arrivals.reduce((a, x) => a + x.n, 0),
      soonIn: arrivals.length ? Math.min(...arrivals.map((x) => x.k)) : null,
      sellNow: alloc.today > 0,
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

/**
 * 给「产出型活动」用的期望价：未来 outlook 个岛日里这个物品的平均价。
 *
 * 为什么不用今天的价：钓鱼/挖矿/加工产出的东西不是当天就卖掉，
 * 通常要放进囤货仓库等峰值。按今天的价挑干哪种活，会系统性地选错。
 * 但也不能用绝对峰值（太乐观，逼着你去赌一个可能被外部供给打下去的点），
 * 所以取未来几天的均值——这是「这批货最终能拿到的价格」的稳健估计。
 *
 * 返回 { id: price } 的字典，可直接当作 prices 传给 planner 的估值函数。
 */
export function expectedPrices(R, now, prices, { outlook = 3, external = {} } = {}) {
  const fc = forecastPrices(R, now, prices, { days: Math.max(1, outlook), external })
  const out = {}
  for (const id of Object.keys(R.BASE_PRICE)) {
    let sum = 0, n = 0
    for (const day of fc) {
      const p = day.price[id] || 0
      if (p > 0) { sum += p; n++ }
    }
    // 当天有真实报价就用真实值（前 k=0 天本来就是真报价），否则退回预测均值
    out[id] = n ? sum / n : (Number(prices?.[id]) || 0)
  }
  return out
}
