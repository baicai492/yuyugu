// 检查 cropCycle：全天在线 vs 设了离线时段时，各作物各浇水方式的周期与产量。
import * as R from '../cache/rules-4be1c2b4.mjs'
import { cropCycle } from '../extension/lib/strategy.mjs'
import { DEFAULTS, mergeConfig } from '../extension/lib/defaults.mjs'
R.b12ConfigureClock(1794212939)
const at = (s) => Date.parse(s + '+08:00') / 1000
const off = mergeConfig(DEFAULTS, { offline: { enabled: true } })
for (const [label, cfg, t] of [['全天在线，10:00 种', DEFAULTS, at('2026-11-11T10:00:00')], ['离线 01:00–08:30，22:30 种', off, at('2026-11-11T22:30:00')], ['离线 01:00–08:30，00:40 种', off, at('2026-11-12T00:40:00')]]) {
  console.log('== ' + label)
  for (const c of R.CROPS.filter((c) => c.seasons.includes(R.seasonOf(R.isleDay(t))))) for (const mode of ['manual', 'auto', 'none']) {
    const cy = cropCycle(R, cfg, c, t, mode)
    console.log('  ', c.name.padEnd(5), mode.padEnd(6), '茬', cy.n, '整轮', (cy.secs / 60).toFixed(0).padStart(4) + ' 分', '首茬', (cy.first / 60).toFixed(0).padStart(4) + ' 分', '被偷茬数', cy.stolen, '日产', cy.items.map((x) => x.toFixed(1)).join('/'), '日收入≈', Math.round(cy.items.reduce((a, n, q) => a + n * c.price * R.QUALITY[q], 0) - cy.seed))
  }
}
