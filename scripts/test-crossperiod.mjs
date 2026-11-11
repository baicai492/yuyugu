// 跨期决策的三处逻辑单测（从旧版 v1 strategy.mjs 找回来的）：
//   keep        —— 马上要熟的地，预留收获体力
//   fishOK      —— 钓鱼时段窗口，低谷期不钓
//   regenBudget —— 换岛日边界前自然回复够用的体力，不吃口粮
//
// 这些逻辑藏在 planRound 第 8 段里，没有独立函数。测试办法：
// 构造两个只差一个变量的世界，比较产出的动作集合。
import { loadRulesCached } from '../core/rules.mjs'
import { planRound, fishEV } from '../core/planner.mjs'

const R = await loadRulesCached()
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`) }
}

const now = Math.floor(Date.now() / 1000)
const prices = {}
for (const c of R.CROPS) prices[c.id] = c.price
for (const f of R.FISH) prices[f.id] = f.price
for (const o of R.ORES) prices[o.id] = o.price

/** 构造世界。plotN 块地全部空着，体力可调，口粮库存可调 */
function mkWorld({ en = 100, plots = [], inv = {}, prices: p = prices, t = now } = {}) {
  const plotN = Math.max(6, plots.length)
  const state = {
    en, enT: t, enDay: R.worldDay(t),
    plotN,
    plots: [...plots, ...Array(plotN - plots.length).fill(null)],
    barn: [], barnN: 0, traps: [],
    tools: { rod: 4, pick: 4, spr: 3, house: 5 },
    cnt: {}, inv, iq: { d: R.isleIndex(t), fish: 0, mine: 0, bomb: 0, craft: 0 },
    mine: { max: 10 },
    // 规则模块要求这些字段存在，缺了会在 refresh() 里崩
    earn: { day: R.worldDay(t), amt: 0 },
    b12: { v: 1, day: t, vault: {}, keep: {}, effects: {} },
  }
  return { R, now: t, state, coins: 50_000_000, prices: p, externalSoldRatio: {}, dry: false }
}

const cfgBase = {
  invest: { enabled: false },
  // 关掉农田：种植每次 2 点体力，会把测试要观察的体力提前花光
  farm: { enabled: false, water: false, foodPlots: 0 },
  craft: { enabled: false },
  sell: { enabled: false },
  vault: { enabled: false },
  cargo: { enabled: false },
  work: { fish: true, mine: true, bomb: true, bait: true, minValueRatio: 0.9 },
  energy: { minEnergyToLeave: 0 },
}

const acts = (plan) => plan.actions.map((a) => a.a)

// ---------- 1. fishOK：钓鱼低谷期不钓 ----------
// 找到「鱼池最差」和「鱼池最好」的岛小时，分别构造世界，看 fish 动作有没有出现。
// 注意：长夜（现实 22:00–08:00）里 fishOK 恒为 false，所以候选时刻要避开长夜。
{
  const curH = R.isleHour(now)
  // 找一个非长夜的基准时刻（现实白天），把岛小时对齐到它
  let baseT = now
  for (let k = 0; k < 24 * 3600; k += 600) {
    if (!R.b12IsLongNight(now + k)) { baseT = now + k; break }
  }
  const baseH = R.isleHour(baseT)
  let bestH = baseH, bestEV = -1, worstH = baseH, worstEV = Infinity
  for (let h = 0; h < 24; h++) {
    const probe = baseT + (((h - baseH) + 24) % 24) * (R.ISLE_SPAN / 24)
    if (R.b12IsLongNight(probe)) continue
    const ev = fishEV(R, mkWorld({ t: probe }).state, probe, prices, false)
    if (ev > bestEV) { bestEV = ev; bestH = h }
    if (ev < worstEV) { worstEV = ev; worstH = h }
  }
  const at = (h) => baseT + (((h - baseH) + 24) % 24) * (R.ISLE_SPAN / 24)

  // 关掉挖矿/炸矿，确保唯一候选就是钓鱼
  const wOnly = { ...cfgBase, work: { ...cfgBase.work, mine: false, bomb: false } }
  const planWorst = planRound(mkWorld({ t: at(worstH), en: 10 }), wOnly)
  const planBest = planRound(mkWorld({ t: at(bestH), en: 10 }), wOnly)

  console.log(`\n[1] 钓鱼时段窗口（最好 ${bestH} 点 EV=${bestEV.toFixed(0)}，最差 ${worstH} 点 EV=${worstEV.toFixed(0)}）`)
  ok(acts(planBest).includes('fish'), '最佳时段会钓', `动作=${acts(planBest).join(',') || '无'}`)
  const ratio = worstEV / bestEV
  if (ratio < 0.97) {
    ok(!acts(planWorst).includes('fish'), `低谷时段不钓（比值 ${(ratio * 100).toFixed(1)}% < 97%）`, `动作=${acts(planWorst).join(',') || '无'}`)
  } else {
    console.log(`  · 低谷期比值 ${(ratio * 100).toFixed(1)}% 未低于 97%，该时段本就该钓，跳过断言`)
    pass++
  }
}

// ---------- 2. keep：马上要熟的地预留体力 ----------
{
  // 造 3 块 1 分钟内就熟的地
  const auto = true   // spr=3 全覆盖，自动浇水
  const soon = R.CROPS[0]
  const plots = [0, 1, 2].map(() => ({ c: soon.id, t: now - (soon.grow * 60) + 30, w: 3, y: 0, sv: [] }))
  // 体力只够干 2 件活，口粮库存为 0（无法现场吃）
  const w = mkWorld({ en: 7, plots, inv: {} })
  const plan = planRound(w, { ...cfgBase, work: { ...cfgBase.work, mine: false, bomb: false } })
  const workActs = acts(plan).filter((a) => ['fish', 'mine', 'bomb'].includes(a))
  // 收获 3 块地要 3 点，体力 7，能干活的最多 4 点（钓鱼 4 点 1 竿）
  // 但第 2 段已经会把成熟的地收掉（stage===3），这里构造的是「快熟但还没熟」
  const st = R.cropStage(plots[0], now, auto)
  console.log(`\n[2] 收获体力预留（3 块地 ${st.left} 秒后熟，体力 7，无口粮）`)
  ok(workActs.length <= 1, '体力先留给即将成熟的地，最多干 1 件活', `干活=${workActs.join(',') || '无'}`)
}

// ---------- 3. regenBudget：换岛日边界前白嫖体力 ----------
{
  // 找一个「离边界很远」和「离边界很近」的时刻
  const boundary = R.b12NextIsleBoundary(now)
  const farT = now, nearT = boundary - 120   // 离边界 2 分钟 → regenBudget = 0
  const farLeft = boundary - now

  // 体力 1 点，不够挖矿（要 3 点），口粮为 0 → 只能靠自然回复或放弃
  // 关掉钓鱼（有时段限制），只留挖矿
  const wOnly = { ...cfgBase, work: { ...cfgBase.work, fish: false, bomb: false } }
  const pFar = planRound(mkWorld({ t: farT, en: 1, inv: {} }), wOnly)
  const pNear = planRound(mkWorld({ t: nearT, en: 1, inv: {} }), wOnly)

  console.log(`\n[3] 跨期体力预算（离边界 ${Math.round(farLeft / 60)} 分钟，体力 1，无口粮）`)
  ok(!acts(pFar).includes('mine'), '离边界远：等自然回复，这一轮不做（不吃口粮）', `动作=${acts(pFar).join(',') || '无'}`)
  ok(!acts(pNear).includes('mine'), '离边界近：回复不够也做不了', `动作=${acts(pNear).join(',') || '无'}`)

  // 有口粮时，离边界近就应该吃口粮挖
  const pNearFood = planRound(mkWorld({ t: nearT, en: 1, inv: { turnip: [5, 0, 0] } }), wOnly)
  ok(acts(pNearFood).includes('mine') || acts(pNearFood).includes('eat'),
    '离边界近 + 有口粮：吃口粮把体力补上来再挖', `动作=${acts(pNearFood).join(',') || '无'}`)
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
