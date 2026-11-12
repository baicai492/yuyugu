// 诊断 2：改完「体力机会成本」之后，一次真实巡视会怎么规划。
//
// 只读：拉一次 world，跑 planRound（纯本地预演，不提交），
// 打印每条动作和摘要，重点看「补种几块」「钓鱼几竿」。
import { loadRulesCached } from '../core/rules.mjs'
import { createClient } from '../core/http.mjs'
import { readSession } from '../core/session.mjs'
import { planRound } from '../core/planner.mjs'
import { loadConfig } from '../core/config.mjs'

const R = await loadRulesCached()
const cfg = loadConfig()
const { cookie } = readSession()
const client = createClient({ baseUrl: cfg.baseUrl, cookie })
const j = await client.world()
if (j.clockStart && R.b12ConfigureClock) R.b12ConfigureClock(j.clockStart)

const w = {
  R, now: j.now, state: j.state, coins: j.coins, prices: j.prices,
  externalSoldRatio: {}, dry: true,
}
// 试跑「有 N 块空地」的情况：线上现在 24/24 种满，看不出补种决策
const clearN = Number(process.env.CLEAR_PLOTS || 0)
if (clearN > 0) {
  w.state = structuredClone(j.state)
  for (let i = 0; i < clearN && i < w.state.plotN; i++) w.state.plots[i] = null
}
Object.defineProperty(w, 'isleDay', { get() { return R.isleDay(this.now) } })

const { actions, summary, sleep } = planRound(w, cfg, () => {})
const count = {}
for (const a of actions) count[a.a] = (count[a.a] || 0) + 1
console.log(`岛日 ${R.worldDay(j.now)}｜${R.SEASONS[R.seasonOf(R.isleDay(j.now))]}·${R.WEATHERS[R.weatherOf(R.isleDay(j.now))]}｜${R.isleHour(j.now)} 点`)
console.log(`体力 ${j.state.en}/${R.energyMax(j.state)}｜已种 ${j.state.plots.filter(Boolean).length}/${j.state.plotN}`)
console.log('')
console.log('动作统计：', Object.entries(count).map(([k, v]) => `${k}×${v}`).join(' ') || '（无）')
console.log('')
console.log('摘要：')
for (const s of summary) console.log('  ' + s)
console.log('')
console.log('sleep:', sleep)
