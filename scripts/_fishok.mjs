import { loadRulesCached } from '../core/rules.mjs'
import { createClient } from '../core/http.mjs'
import { readSession } from '../core/session.mjs'
import { fishEV } from '../core/planner.mjs'
import { loadConfig } from '../core/config.mjs'
const R = await loadRulesCached(); const cfg = loadConfig()
const { cookie } = readSession()
const j = await createClient({ baseUrl: cfg.baseUrl, cookie }).world()
if (j.clockStart) R.b12ConfigureClock(j.clockStart)
const s = j.state, t = j.now, prices = j.prices
const nowEV = fishEV(R, s, t, prices, false)
const boundaryIn = R.b12NextIsleBoundary(t) - t
const hourSpan = R.ISLE_SPAN / 24
const maxSteps = Math.max(0, Math.floor((boundaryIn - 1) / hourSpan))
let best = nowEV
const rows = []
for (let h = 1; h <= Math.min(23, maxSteps); h++) {
  const probe = t + h * hourSpan
  if (R.isleIndex(probe) !== R.isleIndex(t)) break
  const ev = fishEV(R, s, probe, prices, false)
  rows.push([R.isleHour(probe), Math.round(ev)])
  if (ev > best) best = ev
}
console.log('现在岛小时', R.isleHour(t), 'EV', Math.round(nowEV))
console.log('本岛日剩余时段 EV：', rows.map(([h,e])=>`${h}点:${e}`).join(' '))
console.log('最佳', Math.round(best), '比值', (nowEV/best*100).toFixed(1) + '%', '阈值', (cfg.work.windowRatio*100).toFixed(0)+'%')
console.log('fishOK =', nowEV >= best * (cfg.work.windowRatio ?? 0.97), '｜长夜 =', R.b12IsLongNight(t), '｜边界', Math.round(boundaryIn/60), '分')
