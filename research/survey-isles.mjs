// 只读：访问最近活跃的小岛，验证「成熟后 30 分钟保护期」的判定，并统计大家的配置。结果存 research/live-survey.json
import { readFileSync, writeFileSync } from 'node:fs'
import * as R from '../cache/rules-4be1c2b4.mjs'
const cookie = readFileSync(new URL('../../messages/cookie.txt', import.meta.url), 'utf8').trim(), base = 'https://52dmeme.com'
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const get = async (path) => { const r = await fetch(base + path, { headers: { cookie, referer: base + '/pets' }, signal: AbortSignal.timeout(30000) }); return { status: r.status, json: await r.json().catch(() => ({})) } }
const scan = JSON.parse(readFileSync(new URL('./live-scan.json', import.meta.url), 'utf8'))
const w = (await get('/api/pet/world')).json
R.b12ConfigureClock(w.clockStart)
const nowS = Date.now() / 1000
const targets = scan.neighbors.filter((o) => nowS - o.active < 86400).sort((a, b) => b.level - a.level).slice(0, Number(process.argv[2]) || 45)
const rows = [], check = { ok: 0, bad: [] }
for (const o of targets) {
  const { status, json: d } = await get('/api/pet/world/visit/' + o.id)
  if (status !== 200) { console.log('visit', o.id, status, JSON.stringify(d).slice(0, 120)); await sleep(1500); continue }
  const t = d.now, s = d.state, weather = R.weatherOf(R.isleDay(t))
  const plots = (d.isle.plots || []).map((v, i) => {
    const p = s.plots[i]; if (!v || !p) return null
    const auto = R.sprinkled(s, i) || weather === 1, st = R.cropStage(p, t, auto), ripeAt = p.t + st.total
    const sinceRipe = st.stage === 3 ? Math.round(t - ripeAt) : null
    if (st.stage === 3 && v.stolen < d.rules.perPlot) { const expect = sinceRipe >= d.rules.protect; if (expect === !!v.steal) check.ok++; else check.bad.push({ id: o.id, i, sinceRipe, steal: v.steal, stolen: v.stolen, sv: p.sv, c: p.c }) }
    return { c: p.c, stage: v.stage, vStage: st.stage, steal: v.steal, stolen: v.stolen, sinceRipe, left: v.left, sv: p.sv }
  })
  rows.push({ id: o.id, name: o.name, level: d.owner.level, guard: d.owner.guard, boost: d.owner.boost, active: o.active, plotN: s.plotN, tools: s.tools, barn: s.barn.map((b) => b.k), pens: d.isle.barn, traps: s.traps.length, effects: s.b12?.effects, auto: s.auto?.on || false, mineMax: s.mine?.max, plots, invKinds: Object.keys(s.inv || {}).length, invValue: Math.round(Object.entries(s.inv || {}).reduce((v, [id, qs]) => v + qs.reduce((x, n, q) => x + n * (R.BASE_PRICE[id] || 0) * R.QUALITY[q], 0), 0)) })
  await sleep(900)
}
writeFileSync(new URL('./live-survey.json', import.meta.url), JSON.stringify({ at: Date.now(), rows }))
console.log(`访问 ${rows.length} 座岛。保护期规则核对：符合 ${check.ok} 块，不符 ${check.bad.length} 块`, JSON.stringify(check.bad).slice(0, 600))
const cnt = (arr) => Object.entries(arr.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + '×' + n).join(' ')
console.log('地块数', cnt(rows.map((r) => r.plotN)))
console.log('作物', cnt(rows.flatMap((r) => r.plots.filter(Boolean).map((p) => R.ITEM_NAME[p.c]))))
console.log('动物', cnt(rows.flatMap((r) => r.barn.map((k) => R.ANIMALS.find((a) => a.id === k).name))))
console.log('鱼竿', cnt(rows.map((r) => r.tools.rod)), '｜镐子', cnt(rows.map((r) => r.tools.pick)), '｜洒水器', cnt(rows.map((r) => r.tools.spr)), '｜小屋', cnt(rows.map((r) => r.tools.house)), '｜蟹笼', cnt(rows.map((r) => r.traps)))
console.log('站内管家开启', rows.filter((r) => r.auto).length, '｜有大肥鱼看家', rows.filter((r) => r.guard).length, '｜道具', cnt(rows.flatMap((r) => Object.values(r.effects || {}).filter((e) => e.until > nowS).map((e) => R.ITEM_NAME[e.id]))))
console.log('库存按基础价（前 10）', rows.slice().sort((a, b) => b.invValue - a.invValue).slice(0, 10).map((r) => r.name + ':' + (r.invValue / 1e4).toFixed(0) + '万').join(' '))
console.log('成熟待收的地（含保护期内）', rows.reduce((n, r) => n + r.plots.filter((p) => p && p.vStage === 3).length, 0), '｜其中可偷', rows.reduce((n, r) => n + r.plots.filter((p) => p && p.steal).length, 0), '｜已被偷过', rows.reduce((n, r) => n + r.plots.filter((p) => p && p.stolen).length, 0))
console.log('窝里有货', JSON.stringify(rows.flatMap((r) => r.pens.filter((p) => p.n > 0).map((p) => ({ k: p.k, n: p.n, steal: p.steal })))).slice(0, 500))
