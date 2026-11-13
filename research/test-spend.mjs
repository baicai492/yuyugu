// 验证训练和强化接口（共花约 2700 D）
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const cookie = readFileSync(new URL('../cookie.txt', import.meta.url), 'utf8').trim(), base = 'https://52dmeme.com'
const call = async (path, body) => { const r = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { cookie, referer: base + '/pets', ...(body ? { 'content-type': 'application/json', origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) } }
const show = (t, r) => console.log(t, r.status, r.json.error || '', 'coins', r.json.coins, 'daily', JSON.stringify(r.json.daily), 'gear', JSON.stringify(r.json.gear), 'level', r.json.level)
show('train10', await call('/pet/battle/train?xp=10', { operation: randomUUID() }))
show('enhance fan', await call('/pet/battle/enhance?item=fan', { operation: randomUUID() }))
