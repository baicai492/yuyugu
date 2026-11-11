// 配置挂机管家：让它在主程序不在线时兜底。
// 用法：node scripts/set-butler.mjs [--off] [--dry]
import { readSession } from '../core/session.mjs'
import { createClient } from '../core/http.mjs'
import { loadRules } from '../core/rules.mjs'
import { World } from '../core/world.mjs'
import { loadConfig } from '../core/config.mjs'
import { butlerConfig } from '../core/warehouse.mjs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

const off = process.argv.includes('--off')
const dry = process.argv.includes('--dry')
const cfg = loadConfig()
const session = readSession(resolve(import.meta.dirname, '..', cfg.cookieFile))
const client = createClient({ baseUrl: cfg.baseUrl, cookie: session.cookie, minGap: cfg.minGap })
const R = await loadRules({ baseUrl: cfg.baseUrl, cookie: session.cookie })
const world = new World(client, console.log)
await world.refresh()

const config = off ? { ...butlerConfig(cfg), on: false } : butlerConfig(cfg)
console.log('管家配置：', JSON.stringify(config, null, 2))
console.log(`当前状态：${world.state.auto?.on ? '已开启' : '未开启'}${world.state.auto?.t ? `，上轮巡视 ${new Date((world.state.auto.t + 8 * 3600) * 1000).toISOString().slice(5, 16).replace('T', ' ')}` : ''}`)

if (dry) { console.log('[演练] 未提交'); process.exit(0) }
const j = await client.post('/api/pet/world/auto', { rev: world.rev, operation: randomUUID(), config })
world.accept(j)
console.log(`\n完成：管家${config.on ? '已开启' : '已关闭'}`)
if (j.autoLog?.visits) console.log(`补算了 ${j.autoLog.visits} 轮巡视，收入 ${j.autoLog.earn}，支出 ${j.autoLog.spend}`)
