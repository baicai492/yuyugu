// 把囤货仓库中「等峰值更划算」的货锁起来；把「该卖」的货解锁。
// 用法：node scripts/vault.mjs [--dry]
import { readSession } from '../core/session.mjs'
import { createClient } from '../core/http.mjs'
import { loadRules } from '../core/rules.mjs'
import { World } from '../core/world.mjs'
import { loadConfig } from '../core/config.mjs'
import { planVault, vaultSummary } from '../core/warehouse.mjs'
import { resolve } from 'node:path'

const dry = process.argv.includes('--dry')
const cfg = loadConfig()
const session = readSession(resolve(import.meta.dirname, '..', cfg.cookieFile))
const client = createClient({ baseUrl: cfg.baseUrl, cookie: session.cookie, minGap: cfg.minGap })
const R = await loadRules({ baseUrl: cfg.baseUrl, cookie: session.cookie })
const world = new World(client, console.log)
await world.refresh()

const sum = vaultSummary(R, world)
console.log(`当前仓库：${sum.rows.length} 项，按现价 ${Math.round(sum.totalValue).toLocaleString('en-US')} D`)
for (const r of sum.rows.slice(0, 15)) console.log(`  ${r.name}${r.q ? ' ★' + r.q : ''} ×${r.n}（${Math.round(r.value).toLocaleString('en-US')} D）`)

const acts = planVault(R, world, cfg)
if (!acts.length) { console.log('无需调整'); process.exit(0) }
console.log(`\n计划调整 ${acts.length} 项：`)
for (const a of acts) console.log(`  ${R.ITEM_NAME[a.id]} 品质${a.q} → ${a.n ? '锁 ' + a.n : '解锁'}`)

if (dry) { console.log('\n[演练] 未提交'); process.exit(0) }
const res = await world.act(acts)
console.log(`\n完成：${res.out.filter((o) => o?.ok).length}/${acts.length} 项生效`)
