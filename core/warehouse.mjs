// 囤货仓库：把「现在不该卖」的货锁进 vault，避免被管家按低价卖掉。
//
// 规则（MODULE 14）：
//   state.b12.vault[id][q] = 预留数量（inv 的子集，不是额外库存）
//   state.b12.keep[id][q]  = 「收获自动补足」目标
//   动作 {a:'warehouse', id, q, n, keep}
//
// 我们的用法：卖货规划里判定「等峰值更划算」的货，就把它全额锁进 vault；
// 判定「现在该卖」的货，先解锁（n=0）再卖，避免 includeWarehouse 的副作用。

import * as M from './market.mjs'

/**
 * 根据市场预测，决定每种货该锁多少。
 * 返回 [{ id, q, n, keep }]，只包含需要变化的项。
 */
export function planVault(R, world, cfg) {
  if (!cfg.vault?.enabled) return []
  const ahead = cfg.vault?.keepPeakAhead ?? 2
  const plan = M.sellPlan(R, world.now, { coins: world.coins, state: world.state, prices: world.prices }, {
    days: cfg.sell?.horizonDays || 12,
    markdownPct: cfg.sell?.markdownPct ?? 6,
    external: world.externalSoldRatio || {},
  })
  const out = []
  for (const row of plan.rows) {
    // 峰值在 ahead 个岛日之内、且等的收获明显更大 → 锁起来
    const shouldHold = !row.sellNow && row.peakIn <= ahead && row.gain > Math.max(1000, row.netNow * 0.05)
    const vaultQs = world.state.b12?.vault?.[row.id] || [0, 0, 0]
    for (let q = 0; q < 3; q++) {
      const have = world.state.inv?.[row.id]?.[q] || 0
      if (have <= 0) continue
      const want = shouldHold ? have : 0
      const cur = vaultQs[q] || 0
      if (want === cur) continue
      out.push({ a: 'warehouse', id: row.id, q, n: want, keep: shouldHold })
    }
  }
  // 一次最多改 20 条，避免单批过大
  return out.slice(0, 20)
}

/** 解锁指定物品（卖出前调用） */
export function unlockActions(R, world, rows) {
  const out = []
  for (const r of rows) {
    const vaultQs = world.state.b12?.vault?.[r.id]
    if (!vaultQs) continue
    if (!vaultQs.some((n) => n > 0)) continue
    out.push({ a: 'warehouse', id: r.id, q: r.q ?? 0, n: 0, keep: false })
  }
  return out
}

/** 给 GUI 看的仓库概况 */
export function vaultSummary(R, world) {
  const vault = world.state.b12?.vault || {}
  const rows = []
  let totalValue = 0
  for (const [id, qs] of Object.entries(vault)) {
    const price = Number(world.prices[id]) || 0
    for (let q = 0; q < 3; q++) {
      const n = qs[q] || 0
      if (n <= 0) continue
      const value = n * price * R.QUALITY[q]
      totalValue += value
      rows.push({ id, name: R.ITEM_NAME[id] || id, q, n, price: Math.round(price * R.QUALITY[q]), value: Math.round(value) })
    }
  }
  rows.sort((a, b) => b.value - a.value)
  return { rows, totalValue: Math.round(totalValue) }
}

/** 把管家配置成「只做我们不在线时的兜底」 */
export function butlerConfig(cfg) {
  // AUTO_DEFAULT: {on, crop, water, feed, fishPct, keep, sell, minPct, budget, craft, bomb, goals, guard}
  return {
    on: true,
    crop: 'best',
    water: true,
    feed: true,
    fishPct: 50,
    keep: 20,              // 保留 20 体力给玩家/程序
    sell: true,
    minPct: 92,            // 只在 ≥92% 基础价时卖（比默认 90 更保守）
    budget: 200000,
    craft: true,
    bomb: true,
    goals: true,
    guard: 0,
  }
}
