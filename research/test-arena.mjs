// 一次性验证擂台挑战接口的返回格式（主动挑战不花 D币，对方不扣任何东西）。
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const cookie = readFileSync(new URL('../../messages/cookie.txt', import.meta.url), 'utf8').trim(), base = 'https://52dmeme.com'
const call = async (path, body) => { const r = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { cookie, referer: base + '/pets', ...(body ? { 'content-type': 'application/json', origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); return { status: r.status, json: await r.json().catch(() => ({})) } }
const ops = (await call('/pet/battle/opponents?limit=20&q=')).json.opponents
const o = ops.filter((x) => x.left > 0).sort((a, b) => a.level - b.level)[0]
console.log('对手', JSON.stringify(o))
const r = await call('/pet/battle', { opponent_id: o.id, operation: randomUUID() })
writeFileSync(new URL('./arena-sample.json', import.meta.url), JSON.stringify(r.json))
const j = r.json
console.log('HTTP', r.status, 'keys', Object.keys(j))
for (const k of Object.keys(j)) if (k !== 'skills') { const s = JSON.stringify(j[k]); console.log(' [' + k + ']', s.length > 500 ? s.slice(0, 500) + '…' : s) }
const again = await call('/pet/battle', { opponent_id: o.id, operation: randomUUID() })
console.log('立即再打（看冷却报错格式）HTTP', again.status, JSON.stringify(again.json).slice(0, 300))
const g = (await call('/pet/battle/gear')).json
console.log('daily', JSON.stringify(g.daily), 'items', JSON.stringify(g.items), 'gear', JSON.stringify(g.gear), 'free', g.free)
