// 一次性验证擂台的宝箱 / 装备 / 加点接口（都不花 D币）。
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const cookie = readFileSync(new URL('../cookie.txt', import.meta.url), 'utf8').trim(), base = 'https://52dmeme.com'
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
const call = async (path, body) => { const r = await fetch(base + '/api' + path, { method: body ? 'POST' : 'GET', headers: { cookie, referer: base + '/pets', ...(body ? { 'content-type': 'application/json', origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); return { status: r.status, json: await r.json().catch(() => ({})) } }
const brief = (j) => { const o = { ...j }; delete o.catalog; delete o.skills; delete o.allSkills; if (o.battle) o.battle = { winner: o.battle.winner, xp: o.battle.xp, drop: o.battle.drop, rounds: o.battle.rounds }; return JSON.stringify(o).slice(0, 700) }

let g = (await call('/pet/battle/gear')).json
console.log('开始 daily', JSON.stringify(g.daily), 'free', g.free, 'points', JSON.stringify(g.points))
const ops = (await call('/pet/battle/opponents?limit=20&q=')).json.opponents.filter((x) => x.left > 0).sort((a, b) => a.level - b.level)
for (let k = 0; k < 6 && !g.daily.ready; k++) {
  await sleep(8500)
  const r = await call('/pet/battle', { opponent_id: ops[k % ops.length].id, operation: randomUUID() })
  console.log('battle', r.status, brief(r.json))
  g = (await call('/pet/battle/gear')).json
  console.log('  daily', JSON.stringify(g.daily))
}
if (g.daily.ready) {
  const r = await call('/pet/battle/chest', {})
  writeFileSync(new URL('./chest-sample.json', import.meta.url), JSON.stringify(r.json))
  console.log('chest', r.status, 'got', JSON.stringify(r.json.got), 'daily', JSON.stringify(r.json.daily), 'items', JSON.stringify(r.json.items))
  g = r.json.items ? r.json : g
}
// 装备：每个槽位挑一件
const cat = Object.fromEntries(g.catalog.map((c) => [c.id, c]))
for (const slot of ['weapon', 'armor', 'charm']) {
  const own = g.items.filter((x) => cat[x.id]?.slot === slot).sort((a, b) => cat[b.id].rarity - cat[a.id].rarity || b.enh - a.enh)[0]
  if (!own || g.gear?.[slot]?.id === own.id) continue
  const r = await call('/pet/battle/equip', { slot, item: own.id })
  console.log('equip', slot, own.id, r.status, 'gear', JSON.stringify(r.json.gear), r.json.error || '')
  if (r.json.gear) g = r.json
}
if (g.free > 0) {
  const pts = { ...g.points }; pts.vit += g.free
  const r = await call('/pet/battle/points', { points: pts })
  console.log('points', r.status, JSON.stringify(r.json.points), 'free', r.json.free, r.json.error || '')
}
const h = (await call('/pet/battle/home')).json
console.log('me', JSON.stringify({ level: h.me.level, hp: h.me.hp, atk: h.me.atk, def: h.me.def, agi: h.me.agi, spd: h.me.spd, gear: h.me.gear, passive: h.me.passive }), 'today', JSON.stringify(h.today))
