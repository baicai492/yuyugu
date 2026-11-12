// 诊断：农作物的「体力机会成本」到底该怎么算。
//
// 线上现象（2026-11-12 中午）：
//   日志每轮都写「每点体力收益：钓鱼 3,381(剩80) 挖矿 937(剩100)」，
//   但钓鱼额度一整天 0/80，体力长期 1~5/140。
//   原因不是钓鱼窗口，而是体力被 24 块番茄吃干了：
//     · 收获 1 点 + 补种 2 点，每块地每岛日要吃 30 多点体力
//     · keep（给即将成熟的地预留收割体力）算出来 12~24，
//       `en + 口粮回复 − keep < 4` 永远不成立 → 第 8 段一竿也下不去
//
// 这个脚本回答：把「体力」按口粮采购价（~143 D/点）折钱，
// 和按「同样体力拿去钓鱼能赚多少」（~3,400 D/点）折钱，
// 同一块地的净收益差多少。
//
// 用法：node scripts/probe-crop.mjs
import { loadRulesCached } from '../core/rules.mjs'
import { createClient } from '../core/http.mjs'
import { readSession } from '../core/session.mjs'
import { makeCropPlanner, fishEV } from '../core/planner.mjs'
import { loadConfig } from '../core/config.mjs'

const R = await loadRulesCached()
const cfg = loadConfig()
const { cookie } = readSession()
const client = createClient({ baseUrl: cfg.baseUrl, cookie })
const j = await client.world()
const s = j.state
// 服务端给的 clockStart 必须喂进去，否则 isleIndex 偏 7 个岛日、季节全错
if (j.clockStart && R.b12ConfigureClock) R.b12ConfigureClock(j.clockStart)
const t = j.now
const prices = j.prices

const fmt = (n) => Math.round(n).toLocaleString('en-US')
const season = R.seasonOf(R.isleDay(t))
const weather = R.weatherOf(R.isleDay(t))

console.log(`岛日 ${R.worldDay(t)}｜第 ${R.isleDayNo(t)} 天｜${R.SEASONS[season]}·${R.WEATHERS[weather]}｜${R.isleHour(t)} 点`)
console.log(`体力 ${s.en}/${R.energyMax(s)}｜地块 ${s.plotN}｜已种 ${s.plots.filter(Boolean).length}`)
console.log(`体力回复 ${R.WORLD.regen}s/点 → 每岛日（${R.ISLE_SPAN}s）${Math.round(R.ISLE_SPAN / R.WORLD.regen)} 点、每自然日 ${Math.round(86400 / R.WORLD.regen)} 点`)
console.log('')

const useBait = cfg.work.bait && (s.inv.bait?.[0] || 0) > 0
const fishPerE = cfg.work.fish ? fishEV(R, s, t, prices, useBait) / R.WORLD.cost.fish : 0
const foodCost = 143
console.log(`钓鱼每点体力 ${fmt(fishPerE)} D｜口粮采购价约 ${foodCost} D/点`)
console.log('')

const mode = (p) => p.modeOf(0)
const m1 = makeCropPlanner(R, s, t, prices, cfg, weather, foodCost)
const m2 = makeCropPlanner(R, s, t, prices, cfg, weather, Math.max(foodCost, fishPerE))
const a = m1.pick(mode(m1), false)
const b = m2.pick(mode(m2), false)
console.log('卖钱模式的最优作物：')
console.log(`  体力按口粮价 ${foodCost} 折钱 → ${a?.crop.name}，每块地每岛日净赚 ${fmt(a?.value)}`)
console.log(`  体力按钓鱼机会成本折钱   → ${b?.crop.name}，每块地每岛日净赚 ${fmt(b?.value)}` +
  `  ${(b?.value ?? 0) > 0 ? '（仍值得种）' : '（不如留空，体力拿去钓鱼）'}`)
console.log('')
console.log('口粮模式（按净回体力挑，不受上面的成本影响）：')
console.log(`  最优口粮作物 → ${m1.pick(mode(m1), true)?.crop.name}`)
