// 只读采集：榜单、全服小岛目录、可偷岛的访问数据、自己的大肥鱼。结果存 research/live-*.json
import { readFileSync, writeFileSync } from 'node:fs'
const cookie = readFileSync(new URL('../../messages/cookie.txt', import.meta.url), 'utf8').trim(), base = 'https://52dmeme.com'
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const get = async (path) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(base + path, { headers: { cookie, referer: base + '/pets' }, signal: AbortSignal.timeout(30000) }); return { status: r.status, json: await r.json().catch(() => ({})) } } catch (e) { await sleep(2000) } } return { status: 0, json: {} } }
const out = { at: Date.now() }
// 1. 榜单
out.rank = {}
for (const [k, p] of [['earn', 'day'], ['earn', 'total'], ['balance', 'day'], ['steal', 'day'], ['steal', 'total'], ['help', 'day'], ['battle', 'day']]) {
  const r = await get(`/api/pet/world/rank/${k}/${p}?limit=20`)
  out.rank[k + ':' + p] = r.json
  console.log(`rank ${k}/${p}: HTTP ${r.status} total=${r.json.total} day=${r.json.day} mine=${JSON.stringify(r.json.mine)}`)
  console.log('   ', (r.json.rows || []).slice(0, 12).map((x) => `${x.place}.${x.name}:${x.value ?? x.wins + '/' + x.losses}`).join('  '))
  await sleep(500)
}
// 2. 自己的大肥鱼 / 擂台
for (const p of ['/api/pet/state', '/api/pet/battle/home']) { const r = await get(p); out[p] = r.json; console.log(p, 'HTTP', r.status, JSON.stringify(r.json).slice(0, 700)); await sleep(400) }
// 3. 全服目录
const all = []
let cursor = null, meta = null
for (let page = 0; page < 80; page++) {
  const r = await get('/api/pet/world/neighbors?limit=20&q=' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
  if (r.status !== 200) { console.log('neighbors HTTP', r.status, JSON.stringify(r.json).slice(0, 200)); break }
  if (!meta) { meta = { ...r.json }; delete meta.neighbors; out.neighborsMeta = meta }
  all.push(...r.json.neighbors)
  cursor = r.json.nextCursor
  if (!cursor) break
  await sleep(600)
}
out.neighbors = all
const now = Date.now() / 1000
console.log(`目录共 ${all.length} 座岛；可偷 ${all.filter((o) => o.canSteal).length}，可帮 ${all.filter((o) => o.canHelp).length}，新手保护 ${all.filter((o) => o.newbie).length}；24h 内活跃 ${all.filter((o) => now - o.active < 86400).length}，1h 内活跃 ${all.filter((o) => now - o.active < 3600).length}`)
const lv = {}; for (const o of all) lv[o.level] = (lv[o.level] || 0) + 1
console.log('等级分布', JSON.stringify(lv))
console.log('meta', JSON.stringify(meta).slice(0, 900))
// 4. 可偷的岛：看访问数据结构
out.visits = []
for (const o of all.filter((x) => x.canSteal).slice(0, 12)) {
  const r = await get('/api/pet/world/visit/' + o.id)
  const d = r.json
  out.visits.push({ o, d })
  const plots = (d.isle?.plots || []).map((p, i) => (p ? { i, ...p } : null)).filter(Boolean)
  console.log(`visit ${o.id} ${o.name} Lv${d.owner?.level} guard=${d.owner?.guard} boost=${d.owner?.boost} 列表(plots=${o.plots},pens=${o.pens})｜可偷地 ${plots.filter((p) => p.steal).map((p) => p.c + (p.stolen ? '(已被偷' + p.stolen + ')' : '')).join(',')}｜窝 ${JSON.stringify(d.isle?.barn)}`)
  await sleep(700)
}
writeFileSync(new URL('./live-scan.json', import.meta.url), JSON.stringify(out))
