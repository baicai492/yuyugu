import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const cookie = readFileSync(new URL('../cookie.txt', import.meta.url), 'utf8').trim(), base = 'https://52dmeme.com'
const call = async (path, body) => { const r = await fetch(base + '/api/pet/world/' + path, { method: body ? 'POST' : 'GET', headers: { cookie, referer: base + '/pets', ...(body ? { 'content-type': 'application/json', origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) } }
const nb = (await call('neighbors?limit=20&q=')).json
console.log('neighbors keys', Object.keys(nb), 'count', nb.neighbors.length, 'nextCursor', nb.nextCursor, 'canHelp', nb.neighbors.filter((o) => o.canHelp).length, 'canSteal', nb.neighbors.filter((o) => o.canSteal).length)
const o = nb.neighbors.find((x) => x.canHelp)
const v = (await call('visit/' + o.id)).json
console.log('visit help', JSON.stringify(v.help), 'energy', v.energy)
const r = await call('help/' + o.id, { operation: randomUUID() })
const j = r.json; if (j.state) j.state = '(略)'; if (j.isle) j.isle = '(略)'
console.log('help status', r.status, JSON.stringify(j).slice(0, 900))
