// 读磁盘上的日志文件，让 GUI 能看到往次运行的记录。
//
// 文件格式（和 engine.log 写的一致）：
//   2026-11-11 23:50:27 消息内容
// 时间是北京时间。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const FILE_RE = /^yuyugu-(\d{4}-\d{2}-\d{2})\.log$/

/** 列出有日志的日期（新→旧） */
export function listLogDays(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((f) => FILE_RE.exec(f)?.[1])
    .filter(Boolean)
    .sort()
    .reverse()
}

/**
 * 旧版 Chrome 插件把日志存在浏览器的 Local Extension Settings（LevelDB）里。
 * 这里只读地把它抠出来，供 GUI 的「旧插件记录」页展示。
 *
 * 不做完整的 LevelDB 解析：按「时间戳 → 下一个 \0」切块，再用正则抽单条日志。
 */
/**
 * 自动找到旧插件（v1）在浏览器里的 Local Extension Settings 目录。
 * 扫描 Chrome / Edge 的所有 profile；不写死 Profile 1。
 * 返回 [{ browser, profile, dir, size }]，按文件大小倒序。
 */
export function findLegacyExtensionStores(extensionId, { extraRoots = [] } = {}) {
  const localApp = process.env.LOCALAPPDATA || ''
  const roots = [
    ...extraRoots,
    join(localApp, 'Google', 'Chrome', 'User Data'),
    join(localApp, 'Microsoft', 'Edge', 'User Data'),
    join(localApp, 'BraveSoftware', 'Brave-Browser', 'User Data'),
  ].filter(Boolean)

  const out = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    let profiles = []
    try { profiles = readdirSync(root).filter((n) => n === 'Default' || /^Profile \d+$/.test(n)) } catch { continue }
    for (const prof of profiles) {
      const dir = join(root, prof, 'Local Extension Settings', extensionId)
      if (!existsSync(dir)) continue
      let size = 0
      try {
        for (const f of readdirSync(dir)) {
          if (!/\.(log|ldb)$/.test(f)) continue
          try { size += statSync(join(dir, f)).size } catch {}
        }
      } catch {}
      out.push({
        browser: /Chrome/.test(root) ? 'Chrome' : /Edge/.test(root) ? 'Edge' : /Brave/.test(root) ? 'Brave' : '未知',
        profile: prof,
        dir,
        size,
      })
    }
  }
  out.sort((a, b) => b.size - a.size)
  return out
}

/** 把一个扩展存储目录里所有 .log/.ldb 拼起来读（LevelDB 写入日志是追加的） */
export function readLegacyDir(dir, { maxLines = 500 } = {}) {
  if (!dir || !existsSync(dir)) return { rows: [], error: '目录不存在' }
  const files = readdirSync(dir).filter((f) => /\.(log|ldb)$/.test(f)).sort()
  const merged = []
  const seen = new Set()
  for (const f of files) {
    const r = readLegacyExtensionLogs(join(dir, f), { maxLines: 100000 })
    for (const row of r.rows) {
      const key = row.ts + '|' + row.msg.slice(0, 80)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(row)
    }
  }
  merged.sort((a, b) => a.ts.localeCompare(b.ts))
  return { rows: merged.slice(-maxLines), total: merged.length, error: '', files: files.length }
}

export function readLegacyExtensionLogs(file, { maxLines = 500 } = {}) {
  if (!file || !existsSync(file)) return { rows: [], error: '找不到旧插件存储文件' }
  let buf
  try { buf = readFileSync(file) } catch (e) { return { rows: [], error: e.message } }

  const timeRe = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g
  const text = buf.toString('latin1')          // 先按字节读，避免 UTF-8 截断报错
  const out = []
  const seen = new Set()

  // 在未转义的文本里找时间戳，向后截到第一个 \0
  for (const m of text.matchAll(timeRe)) {
    const start = m.index
    let end = text.indexOf('\x00', start)
    if (end < 0 || end - start > 4000) end = Math.min(start + 400, text.length)
    const raw = text.slice(start, end)
    // 用 UTF-8 重新解码这一段（latin1 → buffer → utf8）
    let decoded
    try { decoded = Buffer.from(raw, 'latin1').toString('utf8') } catch { continue }
    if (decoded.length < 18) continue
    // 一段里可能粘了多条日志，拆开
    const parts = decoded.split(/","|(?=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} )/)
    for (const p of parts) {
      let one = p.replace(/^"+|"+$/g, '').replace(/[\x00-\x08\x0b-\x1f]/g, '').trim()
      // LevelDB 记录尾部会跟上一条 key 的二进制残片：从第一个替换字符或
      // 明显不属于日志的符号处截断（日志正文里不会出现 U+FFFD）。
      const cut = one.search(/[�]/)
      if (cut > 0) one = one.slice(0, cut).trim()
      // 再砍掉尾部紧贴的短噪声（引号后跟 1–6 个 ASCII 控制/符号字符）
      one = one.replace(/["\]]+[A-Za-z0-9%$#@!^&*()_+=|\\/<>{}[\];:,.\-]{0,8}$/, (m) => {
        // 只有当这段噪声里含非日志常见字符时才截断，避免误伤正常结尾
        return /[A-Za-z0-9%$#@!^&*()_+=|\\/<>{}[\];:,.\-]{0,8}$/.test(m) && m.length <= 9 && /["\]]/.test(m) ? '' : m
      }).trim()
      const mm = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) ([\s\S]+)$/.exec(one)
      if (!mm) continue
      const [, ts, msgRaw] = mm
      const msg = msgRaw.trim()
      if (msg.length < 3) continue
      const key = ts + '|' + msg.slice(0, 80)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ts, msg, level: /出错|失败|未成功|⚠/.test(msg) ? 'err' : 'info' })
    }
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts))
  return { rows: out.slice(-maxLines), total: out.length, error: '' }
}

/** 把 "YYYY-MM-DD HH:MM:SS" 的北京时间解析成 epoch 毫秒 */
function parseBeijingTime(s) {
  // 2026-11-11 23:50:27 → UTC 是 2026-11-11T15:50:27Z
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s)
  if (!m) return 0
  const [, y, mo, d, h, mi, se] = m
  return Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +se)
}

/**
 * 读某一天（或最近 N 天）的日志。
 * 返回 [{ t, ts, level, msg }]，按时间正序。
 *   days    读最近几天（默认 3）
 *   maxLines 最多返回多少行（取尾部）
 */
export function readLogHistory(dir, { days = 3, maxLines = 800 } = {}) {
  const all = listLogDays(dir).slice(0, days)
  const out = []
  for (const day of all.reverse()) {          // 从旧到新拼
    const file = resolve(dir, `yuyugu-${day}.log`)
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.*)$/.exec(line)
      if (!m) { out.push({ t: 0, ts: '', level: 'info', msg: line }); continue }
      const t = parseBeijingTime(m[1])
      const msg = m[2]
      out.push({ t, ts: m[1], level: /出错|失败|错误|⚠/.test(msg) ? 'err' : 'info', msg })
    }
  }
  return out.slice(-maxLines)
}

/**
 * 从 ledger.csv 里取今天的起点（当天第一条记录）。
 * 这样重启程序后，「今日净增」还能接着算，不会归零。
 * 返回 { day, startCoins, startStock, firstTime } 或 null
 */
export function todayStartFromLedger(dir, nowMs = Date.now()) {
  const file = resolve(dir, 'ledger.csv')
  if (!existsSync(file)) return null
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return null
  const todayBj = new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
  let hit = null
  for (const line of lines.slice(1)) {
    const [time, coins, stock] = line.split(',')
    if (!time || !time.startsWith(todayBj)) continue
    // 只认当天【第一条】：越早的越接近「今天开始时的资产」
    if (!hit) hit = { day: todayBj, startCoins: Number(coins) || 0, startStock: Number(stock) || 0, firstTime: time }
  }
  return hit
}

/** 日志目录概况（给 GUI 显示有哪些天可选） */
export function logInventory(dir) {
  const days = listLogDays(dir)
  return days.map((day) => {
    const file = resolve(dir, `yuyugu-${day}.log`)
    let size = 0, mtime = 0
    try { const st = statSync(file); size = st.size; mtime = st.mtimeMs } catch {}
    return { day, size, mtime }
  })
}
