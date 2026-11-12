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
// 覆盖体力，用来验证「只差 1 点就等自然回复」这类 Just-In-Time 决策
if (process.env.EN != null) {
  w.state = w.state === j.state ? structuredClone(j.state) : w.state
  w.state.en = Number(process.env.EN)
  w.state.enT = j.now
}
Object.defineProperty(w, 'isleDay', { get() { return R.isleDay(this.now) } })

// 复现第 8 段的 keep 计算，否则「体力明明够却不干活」看不出原因
{
  const W = R.WORLD, st = w.state
  const weather = R.weatherOf(R.isleDay(w.now))
  const regen = W.regen || 180
  const workCost = Math.max(W.cost.fish || 0, W.cost.mine || 0, W.cost.bomb || 0)
  const win = Math.max(workCost, 1) * regen
  let soon = 0, mature = 0
  for (let i = 0; i < st.plotN; i++) {
    const p = st.plots[i]; if (!p) continue
    const s2 = R.cropStage(p, w.now, R.sprinkled(st, i) || weather === 1)
    if (s2.stage === 3) { mature++; continue }
    if (s2.stage >= 0 && s2.left < win) soon++
  }
  const replant = cfg.farm?.enabled ? (W.cost.plant || 2) : 0
  const keep = Math.min(soon * ((W.cost.harvest || 1) + replant), Math.floor(R.energyMax(st) * 0.6))
  console.log(`keep=${keep}（${win} 秒内 ${soon} 块要熟 ×（收割+补种 ${(W.cost.harvest || 1) + replant} 点），已熟 ${mature}）｜可用体力 ${st.en - keep}`)
  const iq = st.iq?.d === R.isleIndex(w.now) ? st.iq : {}
  console.log(`额度剩余：钓鱼 ${W.daily.fish - (iq.fish || 0)}｜挖矿 ${W.daily.mine - (iq.mine || 0)}｜炸矿 ${W.daily.bomb - (iq.bomb || 0)}`)
  console.log('')
}

const { actions, summary, sleep } = planRound(w, cfg, () => {})
const count = {}
for (const a of actions) count[a.a] = (count[a.a] || 0) + 1
console.log(`岛日 ${R.worldDay(j.now)}｜${R.SEASONS[R.seasonOf(R.isleDay(j.now))]}·${R.WEATHERS[R.weatherOf(R.isleDay(j.now))]}｜${R.isleHour(j.now)} 点`)
console.log(`体力 ${w.state.en}/${R.energyMax(w.state)}｜已种 ${w.state.plots.filter(Boolean).length}/${w.state.plotN}`)
console.log('')
console.log('动作统计：', Object.entries(count).map(([k, v]) => `${k}×${v}`).join(' ') || '（无）')
console.log('')
console.log('摘要：')
for (const s of summary) console.log('  ' + s)
console.log('')
console.log('sleep:', sleep)
