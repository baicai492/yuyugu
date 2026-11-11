// 一次性验证偷菜接口的返回格式。只挑「已经被别人偷过」的地（主人每块地最多少收 1 个，再偷不会让主人多损失）。
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const cookie = readFileSync(new URL('../../messages/cookie.txt', import.meta.url), 'utf8').trim(), base = 'https://52dmeme.com'
const call = async (path, body) => { const r = await fetch(base + '/api/pet/world/' + path, { method: body ? 'POST' : 'GET', headers: { cookie, referer: base + '/pets', ...(body ? { 'content-type': 'application/json', origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); return { status: r.status, json: await r.json().catch(() => ({})) } }
let target = null
for (let page = 0, cursor = null; page < 3 && !target; page++) {
  const nb = (await call('neighbors?limit=20&q=' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))).json
  for (const o of (nb.neighbors || []).filter((x) => x.canSteal)) {
    const d = (await call('visit/' + o.id)).json
    const spots = [...d.isle.plots.filter((p) => p?.steal), ...d.isle.barn.filter((p) => p?.steal)]
    console.log(`候选 ${o.id} ${o.name} Lv${d.owner.level}：可偷 ${spots.length} 处，其中已被偷过 ${d.isle.plots.filter((p) => p?.steal && p.stolen > 0).length} 处；我的体力 ${d.energy}；left ${JSON.stringify(d.left)}`)
    if (spots.length && d.isle.plots.filter((p) => p?.steal).every((p) => p.stolen > 0) && !d.isle.barn.some((p) => p?.steal)) { target = { o, d }; break }
  }
  cursor = nb.nextCursor; if (!cursor) break
}
if (!target) { console.log('现在没有符合条件的目标（只偷已被偷过的地），未执行'); process.exit(0) }
const r = await call('visit/' + target.o.id, { operation: randomUUID(), kind: 'all', i: 0 })
writeFileSync(new URL('./steal-sample.json', import.meta.url), JSON.stringify(r.json))
const j = structuredClone(r.json)
if (j.state) j.state = '(略)'; if (j.isle) j.isle = { plots: j.isle.plots?.slice(0, 2), barn: j.isle.barn?.slice(0, 1) }
if (j.battle) { console.log('battle keys', Object.keys(j.battle), JSON.stringify(j.battle).length, 'bytes'); j.battle = { ...Object.fromEntries(Object.entries(j.battle).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v).slice(0, 160) : v])) } }
console.log('HTTP', r.status, JSON.stringify(j).slice(0, 2500))
