import { loadRulesCached } from '../core/rules.mjs'
import { createClient } from '../core/http.mjs'
import { readSession } from '../core/session.mjs'
import { foodChoices } from '../core/planner.mjs'
import { loadConfig } from '../core/config.mjs'
const R = await loadRulesCached(); const cfg = loadConfig()
const { cookie } = readSession()
const j = await createClient({ baseUrl: cfg.baseUrl, cookie }).world()
if (j.clockStart) R.b12ConfigureClock(j.clockStart)
const s = j.state, prices = j.prices
console.log('体力', s.en, '/', R.energyMax(s))
console.log('口粮选项（前 5）：')
for (const f of foodChoices(R, s, prices).slice(0, 5)) {
  const inv = s.inv[f.id] || [0,0,0]
  const vault = s.b12?.vault?.[f.id] || [0,0,0]
  console.log(`  ${R.ITEM_NAME?.[f.id]||f.id} 品质${f.q} 可用${f.n} 回${f.restore} 成本${Math.round(f.costPerEnergy)}  D｜inv=${inv} vault=${vault}`)
}
// 试吃一口（预演）
if (foodChoices(R, s, prices)[0]) {
  const f = foodChoices(R, s, prices)[0]
  const r = R.applyActions(structuredClone(s), [{ a: 'eat', id: f.id, q: f.q }], { t: j.now, day: R.worldDay(j.now), prices, coins: j.coins, rand: () => 0.5 })
  console.log('\n预演进食结果：', JSON.stringify(r.out?.[0]))
}
