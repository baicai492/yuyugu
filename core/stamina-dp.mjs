// 体力分配背包（移植自榜一 planner/solve.mjs 的 solveBucketStaminaKnapsack 核心）。
//
// 问题：一轮里有若干种「每单位固定体力、固定收益」的活（钓鱼 4 点、挖矿 3 点、
// 炸矿 6 点），额度、库存、现金各不相同。以前用贪心：按 D/体力 排序，能付就做，
// 够不着就退而求其次。贪心在边界上会选错——体力 5 点时先做 3 点的挖矿，
// 4 点的钓鱼就永远差 1 点；而正确解可能是少挖一次、换成钓鱼。
//
// 榜一把它做成有界背包：
//   1. 每类活展开成「单位物品」{ cost, gain, cashCost }；
//   2. 相同物品按 1/2/4/8… 二进制拆分（有界背包的标准做法，O(E·log n)）；
//   3. 现金成本 > 0 的物品（买鱼饵/买炸弹）额外开一个 (体力, 现金) 二维 DP，
//      保证重建出来的方案不会超预算；
//   4. 返回 bestAtMost[e]：体力 e 以内能做到的最大收益。
//      调用方拿它直接回答「吃口粮补到多少体力最划算」。
//
// 和榜一的差别：不做跨时段 Bellman、不预测未来价格，只做「这一轮、这些额度、
// 这点体力」的精确分配。价格由调用方按未来均价折算好再传进来。

const EPS = 1e-6

function gcdInt(a, b) {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))
  while (y > 0) {
    const t = x % y
    x = y
    y = t
  }
  return Math.max(1, x)
}

/**
 * @param {Array<{key:string,cost:number,gain:number,cashCost?:number,act:any}>} units
 *        每个元素是「一件活」；同一 key/cost/gain 的连续元素会被合并再二进制拆分。
 *        act 是重建时要原样返回的动作（调用方自己解释）。
 * @param {{enCap?:number, cashCap?:number}} opts
 *        enCap：可用体力上限（调用方已扣掉收菜预留）；cashCap：可动用的现金。
 * @returns {{ E:number, bestAtMost:Float64Array, reconstructAt:(en:number)=>any[], cashLimited:boolean }}
 *          reconstructAt(en) 返回按 DP 最优解挑出的单位（数组元素是 units 里的对象）。
 */
export function allocateStamina(units, { enCap = 0, cashCap = Infinity } = {}) {
  const raw = (units || []).filter((u) => u && u.cost > 0 && u.gain > EPS)
  const totalCost = raw.reduce((a, b) => a + b.cost, 0)
  const E = Math.max(0, Math.min(Math.floor(enCap), Math.floor(totalCost)))
  const empty = { E: 0, bestAtMost: new Float64Array(1), reconstructAt: () => [], cashLimited: false }
  if (E <= 0 || raw.length === 0) return empty

  // 合并相邻的同质物品，再二进制拆分
  const groups = []
  for (const it of raw) {
    const cost = it.cashCost || 0
    const last = groups[groups.length - 1]
    if (
      last && last.key === it.key && last.cost === it.cost &&
      last.cashCost === cost && Math.abs(last.gain - it.gain) < EPS
    ) {
      last.count++
    } else {
      groups.push({ key: it.key, cost: it.cost, gain: it.gain, cashCost: cost, sample: it, count: 1 })
    }
  }
  // 免费的先排前面、付费的排后面：重建从后往前扫，这样同样的收益优先用免费额度。
  const freeGroups = groups.filter((g) => g.cashCost <= 0)
  const paidGroups = groups.filter((g) => g.cashCost > 0)
  const dpItems = []
  for (const g of [...freeGroups, ...paidGroups]) {
    let rem = g.count
    let pow = 1
    while (rem > 0) {
      const take = Math.min(pow, rem)
      dpItems.push({
        sample: g.sample,
        count: take,
        cost: g.cost * take,
        gain: g.gain * take,
        unitCash: g.cashCost,
      })
      rem -= take
      pow *= 2
    }
  }

  const totalPaidCash = paidGroups.reduce((a, g) => a + g.cashCost * g.count, 0)
  const cashLimited = totalPaidCash > cashCap + EPS

  let takeTable
  let bestAtMost
  let bestExactE
  let stride = 0
  let cashUnit = 1
  let C = 0
  let take2 = null

  if (cashLimited && Number.isFinite(cashCap) && cashCap > 0) {
    // ---- 二维 (体力, 现金) DP：花钱的活受预算约束 ----
    let rawGcd = 0
    for (const it of dpItems) if (it.unitCash > 0) rawGcd = rawGcd === 0 ? it.unitCash : gcdInt(rawGcd, it.unitCash)
    if (rawGcd <= 0) rawGcd = 1
    cashUnit = Math.floor(cashCap / rawGcd) > 500 ? Math.max(1, Math.ceil(cashCap / 500)) : rawGcd
    C = Math.max(0, Math.floor(cashCap / cashUnit))
    stride = C + 1
    const dp2 = new Float64Array((E + 1) * stride).fill(-1e18)
    dp2[0] = 0
    take2 = dpItems.map(() => new Uint8Array((E + 1) * stride))
    let maxReachC = 0
    for (let i = 0; i < dpItems.length; i++) {
      const cEn = dpItems[i].cost
      const cCash = dpItems[i].unitCash > 0 ? dpItems[i].count * Math.ceil(dpItems[i].unitCash / cashUnit) : 0
      if (cEn > E || cCash > C) continue
      const g = dpItems[i].gain
      const cMax = Math.min(C, maxReachC + cCash)
      const tArr = take2[i]
      for (let e = E; e >= cEn; e--) {
        const off = e * stride
        const prev = (e - cEn) * stride
        for (let c = cMax; c >= cCash; c--) {
          const pv = dp2[prev + (c - cCash)]
          if (pv <= -1e17) continue
          const cand = pv + g
          if (cand > dp2[off + c] + EPS) {
            dp2[off + c] = cand
            tArr[off + c] = 1
          }
        }
      }
      if (cCash > 0) maxReachC = Math.min(C, maxReachC + cCash)
    }
    bestAtMost = new Float64Array(E + 1)
    bestExactE = new Int32Array(E + 1)
    const bestExactC = new Int32Array(E + 1)
    for (let e = 0; e <= E; e++) {
      let rowBest = e > 0 ? bestAtMost[e - 1] : 0
      let rowE = e > 0 ? bestExactE[e - 1] : 0
      let rowC = e > 0 ? bestExactC[e - 1] : 0
      const off = e * stride
      for (let c = 0; c <= maxReachC; c++) {
        if (dp2[off + c] > rowBest + EPS) {
          rowBest = dp2[off + c]
          rowE = e
          rowC = c
        }
      }
      bestAtMost[e] = rowBest
      bestExactE[e] = rowE
      bestExactC[e] = rowC
    }
    return {
      E,
      bestAtMost,
      cashLimited,
      reconstructAt: (en) => {
        const clamped = Math.max(0, Math.min(E, Math.floor(en)))
        let curE = bestExactE[clamped]
        let curC = bestExactC[clamped]
        const picked = []
        for (let i = dpItems.length - 1; i >= 0 && curE > 0; i--) {
          if (take2[i][curE * stride + curC]) {
            for (let k = 0; k < dpItems[i].count; k++) picked.push(dpItems[i].sample)
            curE -= dpItems[i].cost
            curC -= dpItems[i].unitCash > 0 ? dpItems[i].count * Math.ceil(dpItems[i].unitCash / cashUnit) : 0
          }
        }
        return picked.reverse()
      },
    }
  }

  // ---- 一维体力 DP：没有需要花钱的活（或预算足够） ----
  const dp = new Float64Array(E + 1)
  takeTable = dpItems.map(() => new Uint8Array(E + 1))
  for (let i = 0; i < dpItems.length; i++) {
    const cEn = dpItems[i].cost
    const g = dpItems[i].gain
    const tArr = takeTable[i]
    for (let e = E; e >= cEn; e--) {
      const cand = dp[e - cEn] + g
      if (cand > dp[e] + EPS) {
        dp[e] = cand
        tArr[e] = 1
      }
    }
  }
  bestAtMost = new Float64Array(E + 1)
  bestExactE = new Int32Array(E + 1)
  for (let e = 1; e <= E; e++) {
    if (dp[e] > bestAtMost[e - 1] + EPS) {
      bestAtMost[e] = dp[e]
      bestExactE[e] = e
    } else {
      bestAtMost[e] = bestAtMost[e - 1]
      bestExactE[e] = bestExactE[e - 1]
    }
  }
  return {
    E,
    bestAtMost,
    cashLimited,
    reconstructAt: (en) => {
      const clamped = Math.max(0, Math.min(E, Math.floor(en)))
      let curE = bestExactE[clamped]
      const picked = []
      for (let i = dpItems.length - 1; i >= 0 && curE > 0; i--) {
        if (takeTable[i][curE]) {
          for (let k = 0; k < dpItems[i].count; k++) picked.push(dpItems[i].sample)
          curE -= dpItems[i].cost
        }
      }
      return picked.reverse()
    },
  }
}
