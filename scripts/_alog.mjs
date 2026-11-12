import { loadRulesCached } from '../core/rules.mjs'
import { createClient } from '../core/http.mjs'
import { readSession } from '../core/session.mjs'
import { loadConfig } from '../core/config.mjs'
import { randomUUID } from 'node:crypto'
const R = await loadRulesCached(); const cfg = loadConfig()
const { cookie } = readSession()
const client = createClient({ baseUrl: cfg.baseUrl, cookie })
const j = await client.world()
if (j.clockStart) R.b12ConfigureClock(j.clockStart)
console.log('world 响应顶层：', Object.keys(j).join(','))
console.log('autoLog：', JSON.stringify(j.autoLog))
const s = j.state
console.log('b12.tax：', JSON.stringify(s.b12?.tax))
console.log('cnt：', JSON.stringify(s.cnt))
