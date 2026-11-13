import { readFileSync } from 'node:fs'
import * as R from '../cache/rules-4be1c2b4.mjs'
const cookie = readFileSync(new URL('../cookie.txt', import.meta.url), 'utf8').trim(), base = 'https://52dmeme.com'
const get = async (p) => (await fetch(base + p, { headers: { cookie, referer: base + '/pets' } })).json()
const w = await get('/api/pet/world'); R.b12ConfigureClock(w.clockStart)
const s = w.state, t = w.now, names = Object.fromEntries((JSON.parse(readFileSync(new URL('./live-scan.json', import.meta.url), 'utf8')).neighbors).map((o) => [o.id, o.name]))
console.log('coins', w.coins, 'en', s.en, 'isleNo', w.isleNo, 'season', w.season, 'weather', w.weather, 'longNight', w.longNight, 'cnt', JSON.stringify(s.cnt), 'iq', JSON.stringify(s.iq))
s.plots.forEach((p, i) => { if (!p) return console.log(' plot', i, 'empty'); const st = R.cropStage(p, t, R.sprinkled(s, i) || w.weather === 1); console.log(' plot', i, p.c, 'stage', st.stage, 'ripe', st.stage === 3 ? Math.round((t - p.t - st.total) / 60) + ' 分钟前' : Math.round(st.left / 60) + ' 分钟后', 'w', p.w, 'h', p.h, 'sv', JSON.stringify(p.sv), (p.sv || []).map((id) => names[id] || id).join(',')) })
console.log('inv', JSON.stringify(s.inv))
console.log('b12', JSON.stringify(s.b12))
const nb = await get('/api/pet/world/neighbors?limit=1&q=')
console.log('谁来过我家', JSON.stringify(nb.visits))
const gl = await get('/api/pet/world/guard-log'); console.log('guard-log', JSON.stringify(gl).slice(0, 600))
