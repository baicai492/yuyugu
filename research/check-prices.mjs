import { readFileSync } from 'node:fs'
import * as R from '../cache/rules-4be1c2b4.mjs'
const w = JSON.parse(readFileSync(new URL('./world.json', import.meta.url), 'utf8'))
R.b12ConfigureClock(w.clockStart)
const day = R.isleDay(w.now)
console.log('isleDay local', day, 'server', w.isleDay, '| isleNo local', R.isleDayNo(w.now), 'server', w.isleNo, '| season', R.seasonOf(day), w.season, '| weather', R.weatherOf(day), w.weather, '| nextIsleAt', R.b12NextIsleBoundary(w.now), w.nextIsleAt)
console.log('events', R.marketEvents(day).map((e) => e.id + '×' + e.m).join(' '))
const rows = Object.keys(R.BASE_PRICE).map((id) => ({ id, live: w.prices[id], ref: R.priceOf(id, day, 0), base: R.BASE_PRICE[id] }))
let lo = 9, hi = 0
for (const r of rows) { r.ratio = r.live / r.ref; lo = Math.min(lo, r.ratio); hi = Math.max(hi, r.ratio) }
console.log('live/ref ratio range', lo.toFixed(4), hi.toFixed(4))
console.log(rows.map((r) => `${r.id}:${r.live}/${r.ref}=${r.ratio.toFixed(3)}(x${(r.live / r.base).toFixed(2)})`).join('  '))
