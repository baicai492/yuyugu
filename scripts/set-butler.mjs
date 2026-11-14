// 关闭站内挂机管家（它会每 2 小时自己巡视一轮，和托管抢同一池体力）。
//
// 主程序每轮开头也会自动关（core/engine.mjs 的 state.auto.on 检查），
// 这个脚本用于「不想启动托管、只想先把管家关掉」的场合。
//
// 用法：node scripts/set-butler.mjs [--dry]
import { readSession } from '../core/session.mjs'
import { createClient } from '../core/http.mjs'
import { loadRules } from '../core/rules.mjs'
import { World } from '../core/world.mjs'
import { loadConfig } from '../core/config.mjs'
import { disableAuto } from '../core/warehouse.mjs'
import { resolve } from 'node:path'

const dry = process.argv.includes('--dry')
const cfg = loadConfig()
const session = readSession(resolve(import.meta.dirname, '..', cfg.cookieFile))
const client = createClient({ baseUrl: cfg.baseUrl, cookie: session.cookie, minGap: cfg.minGap })
await loadRules({ baseUrl: cfg.baseUrl, cookie: session.cookie })
const world = new World(client, console.log)
await world.refresh()

const on = !!world.state.auto?.on
console.log(`当前状态：${on ? '已开启' : '未开启'}` +
  (world.state.auto?.t ? `，上轮巡视 ${new Date((world.state.auto.t + 8 * 3600) * 1000).toISOString().slice(5, 16).replace('T', ' ')}` : ''))
if (dry) { console.log('[演练] 未提交'); process.exit(0) }
if (!on) { console.log('本来就是关的，不用改'); process.exit(0) }

const closed = await disableAuto(world)
console.log(closed ? '完成：管家已关闭' : '完成：服务端没有返回可关闭的管家')
