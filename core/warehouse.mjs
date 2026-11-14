// 囤货仓库：把「现在不该卖」的货锁进 vault，避免被管家按低价卖掉。
//
// 规则（MODULE 14）：
//   state.b12.vault[id][q] = 预留数量（inv 的子集，不是额外库存）
//   state.b12.keep[id][q]  = 「收获自动补足」目标
//   动作 {a:'warehouse', id, q, n, keep}
//
// 我们的用法：卖货规划里判定「等峰值更划算」的货，就把它全额锁进 vault；
// 判定「现在该卖」的货，先解锁（n=0）再卖，避免 includeWarehouse 的副作用。

import { randomUUID } from 'node:crypto'
import * as M from './market.mjs'

/** 当前仓库等级与容量（05a5c445 的 b26 规则；拿不到规则时按 Lv1 处理） */
export function vaultCapacity(R, state) {
  const B = R.B26 || { slots: [12, 18, 22, 30], unit: [300, 600, 1200, 2400], cost: [0, 80000, 300000, 1000000] }
  const lv = Math.max(1, Math.min(4, Math.floor(Number(state?.b26?.lv)) || 1))
  return { lv, slots: B.slots[lv - 1], unit: B.unit[lv - 1], nextCost: lv < 4 ? B.cost[lv] : 0 }
}

/**
 * 根据市场预测，决定每种货该锁多少。
 * 返回 [{ id, q, n, keep }]，只包含需要变化的项。
 */
export function planVault(R, world, cfg) {
  if (!cfg.vault?.enabled) return []
  const ahead = cfg.vault?.keepPeakAhead ?? 2
  // 容量是真约束：vault 已用格数 ≥ slots 时不能再囤新物品，
  // 单物品三个品质加起来不能超过 unit（服务端 b26Check 的原文口径）。
  const cap = vaultCapacity(R, world.state)
  const vaultIds = Object.keys(world.state.b12?.vault || {})
  // 关键：判断「该不该锁」必须基于**全部解锁后**的库存，而不是当前可售量。
  //
  // sellPlan 的 qty 是 inv − vault（扣除已锁的），gain/netNow 都跟着它算。
  // 拿这个数判断 shouldHold 会造成抖动：
  //   锁满 → qty=0 → 行消失或 gain 变小 → 判成不该锁 → 解锁
  //   → qty 恢复 → gain 变大 → 判成该锁 → 再锁上 → 循环
  // 线上实测 copper 就是这么每 2~3 秒提交一次囤货动作，
  // 一会儿 n=0 一会儿 n=46，永远收敛不了。
  //
  // 所以先造一份「vault 清空」的假状态来跑 sellPlan，
  // 这样 shouldHold 只看货本身值不值得等，和我们锁没锁过无关。
  const bare = { ...world.state, b12: { ...(world.state.b12 || {}), vault: {} } }
  const plan = M.sellPlan(R, world.now, { coins: world.coins, state: bare, prices: world.prices }, {
    days: cfg.sell?.horizonDays || 12,
    markdownPct: cfg.sell?.markdownPct ?? 6,
    external: world.externalSoldRatio || {},
  })
  const out = []
  // 服务端 b26Check 是**逐条**校验的：同一物品三品质总和 + n > unit 就拒绝这一条
  // （R:1516-1520），新物品还要看已用格数。所以规划时必须自己维护两个 running 计数，
  // 不能拿静态的 vaultIds/sumVault 循环算——否则一批里锁 3 个品质会超 unit，
  // 被拒的那一档（通常是金星）留在可售库存里，同一轮就可能按现价卖掉。
  const usedSlots = new Set(vaultIds)
  for (const row of plan.rows) {
    // 峰值在 ahead 个岛日之内、且等的收获明显更大 → 锁起来
    const shouldHold = !row.sellNow && row.peakIn <= ahead && row.gain > Math.max(1000, row.netNow * 0.05)
    // 格数约束：要锁一种新物品，但架子上已经没有空格 → 这一轮先不锁它。
    // 不升级也照样能卖（不锁就是可卖），只是放弃了择时，不影响正确性。
    const isNew = !usedSlots.has(row.id)
    if (shouldHold && isNew && usedSlots.size >= cap.slots) continue
    const vaultQs = world.state.b12?.vault?.[row.id] || [0, 0, 0]
    // 该物品三品质的已锁总量，随本轮规划实时更新
    let running = (vaultQs[0] || 0) + (vaultQs[1] || 0) + (vaultQs[2] || 0)
    for (let q = 0; q < 3; q++) {
      const have = world.state.inv?.[row.id]?.[q] || 0
      if (have <= 0) continue
      // 服务端校验 `n <= s.inv[id][q]`（原库存，未扣 vault），超一条就整条动作作废。
      // world.state 是**本轮预演过**的状态（收获、加工、卖出都会改它），
      // 而服务端此刻的库存是一次动作都没执行的版本——本轮刚收的番茄它还不知道。
      // 所以上限要取「预演后」和「本轮开始时」的较小值，否则每轮都白白失败一条。
      const raw = world.rawInv?.[row.id]?.[q]
      const capN = raw == null ? have : Math.min(have, raw)
      if (capN <= 0) continue
      // 单格上限：锁完后该物品三个品质的总和不能超过 unit。
      // running − cur 就是其他两格的占用量（含本轮已经规划掉的）。
      const cur = vaultQs[q] || 0
      const room = Math.max(0, cap.unit - (running - cur))
      // 但余量不能留：留 1 个会让 vault 永远比 inv 少 1，
      // 而 sellPlan 看到那 1 个可售货就继续生成同一行，
      // 和上面的抖动叠在一起就是无限循环。
      // 改成「要么全锁，要么不锁」——失败的极端情况交给服务端拒绝，
      // 下一轮计划器重算时会自然修正。
      const want = shouldHold ? Math.min(capN, room) : 0
      if (want === cur) continue
      if (shouldHold && want <= 0) continue
      out.push({ a: 'warehouse', id: row.id, q, n: want, keep: shouldHold })
      running += want - cur
      if (shouldHold && isNew) usedSlots.add(row.id)
    }
  }
  // 一次最多改 20 条，避免单批过大
  return out.slice(0, 20)
}

/**
 * 仓库升级决策。
 *
 * b26 只扩囤货容量，对经济收益没有直接贡献（见 ANALYSIS.md 七）。
 * 所以只在「真的撞墙」时升：架子快满了、现金又远超升级价。
 * 这符合「不专门为它调度」的原则——撞到再升，没撞到就不动。
 */
export function planVaultUpgrade(R, world, cfg) {
  if (!cfg.vault?.enabled || !cfg.vault?.upgrade) return null
  const cap = vaultCapacity(R, world.state)
  if (cap.lv >= 4) return null
  const used = Object.keys(world.state.b12?.vault || {}).length
  // 留一格余量：满了才升，等于每次都要先失败一轮囤货动作。
  if (used < cap.slots - 1) return null
  const coins = Number(world.coins) || 0
  const reserve = cfg.invest?.reserveCoins ?? 3000000
  if (coins - cap.nextCost < reserve) return null
  return { a: 'whUp' }
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
  const cap = vaultCapacity(R, world.state)
  return { rows, totalValue: Math.round(totalValue), lv: cap.lv, used: Object.keys(vault).length, slots: cap.slots, unit: cap.unit }
}

/**
 * 关掉站内挂机管家。
 *
 * 站点 AUTO_DEFAULT.on = false（默认关），前端设置面板用 POST /api/pet/world/auto
 * 保存 config。管家每 2 小时自动巡视一轮、最多补算 24 轮——和托管抢同一池体力
 * （线上 11-13 实测一次 autoLog 补算了十几轮）。autoConfig 对缺失字段沿用 prev，
 * 所以只传 { on: false } 就能关掉，不会清空其它策略。
 *
 * 调用方要保证 rev 是新鲜的（world/auto 走乐观锁）。
 * @returns {Promise<boolean>} 是否真的发起了关闭（原本就关着返回 false）
 */
export async function disableAuto(world) {
  if (!world.state?.auto?.on) return false
  const j = await world.client.post('/api/pet/world/auto', {
    rev: world.rev,
    operation: randomUUID(),
    config: { on: false },
  })
  world.accept(j)
  return true
}
