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
 * 从 ledger.csv 里取今天的起点（离今天 0 点最近的那条记录）。
 * 这样重启程序后，「今日净增」还能接着算，不会归零，也不会只剩重启之后的部分。
 * 返回 { day, startCoins, startStock, firstTime, from } 或 null
 */
export function todayStartFromLedger(dir, nowMs = Date.now()) {
  const file = resolve(dir, 'ledger.csv')
  if (!existsSync(file)) return null
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return null
  const todayBj = new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10)

  let todayFirst = null      // 今天最早的一条
  let prevLast = null        // 今天之前的最后一条
  for (const line of lines.slice(1)) {
    const [time, coins, stock] = line.split(',')
    if (!time) continue
    const c = Number(coins)
    if (!Number.isFinite(c) || c <= 0) continue      // 跳过脏数据（0 / NaN）
    const rec = { time, coins: c, stock: Number(stock) || 0 }
    if (time.startsWith(todayBj)) {
      if (!todayFirst) todayFirst = rec
    } else {
      prevLast = rec                                 // 覆盖式，最终是今天之前最后一条
    }
  }
  // 起点必须尽量贴近今天 0 点。
  //
  // ledger.csv 每小时最多写一条，「今天第一条」可能已经是 00:58 甚至更晚。
  // 直接拿它当起点会漏掉 0 点到它之间的所有变动——重启后 现金盈亏/库存变动
  // 看起来就像从重启那一刻才开始算（线上 01:00 重启后 现金盈亏从 +1,880
  // 变成 0、库存变动从 +28.9 万变成 −3,221，就是这个原因）。
  // 昨天最后一条和今天第一条里，取离 0 点更近的那条；进程停了很久时，
  // 今天第一条自然会更近。
  const midnight = Date.parse(`${todayBj}T00:00:00+08:00`)
  const candidates = []
  if (todayFirst) candidates.push({ ...todayFirst, from: 'today' })
  if (prevLast) candidates.push({ ...prevLast, from: 'yesterday' })
  if (!candidates.length) return null
  candidates.sort((a, b) =>
    Math.abs(parseBeijingTime(a.time) - midnight) - Math.abs(parseBeijingTime(b.time) - midnight))
  const pick = candidates[0]
  return { day: todayBj, startCoins: pick.coins, startStock: pick.stock, firstTime: pick.time, from: pick.from }
}

/**
 * 从今天的日志文件里重建「今日收支」。
 *
 * 为什么需要这个：state.json 是覆盖写的，一旦某次写坏（比如 day 是空字符串
 * 导致恢复失败），当天的收支累计就永久丢了。日志文件是只追加的，每一轮的
 * 「本轮收支：+X / −Y（税 Z）」都留在里面，可以重算出来。
 *
 * 但只累加「本轮收支」会漏掉不在轮次里的收入（五子棋奖励、服务端补账等）。
 * 引擎补账时会在日志里留一行「今日收入按服务端补账：+X（日志里是 +Y）」，
 * 这里按时间顺序重放：
 *   普通轮次  → 累加
 *   补账行    → 把当天累计抬到服务端给出的总额（只升不降，和服务端补账代码一致）
 * 这样重启后重建出来的数和重启前最后的 ledger 完全一致。
 *
 * 返回 { earn, spend, tax, rounds, from }
 */
export function todayBookFromLog(dir, nowMs = Date.now()) {
  const empty = { earn: 0, spend: 0, tax: 0, rounds: 0, from: '' }
  const todayBj = new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const file = resolve(dir, `yuyugu-${todayBj}.log`)
  if (!existsSync(file)) return empty

  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return empty }
  // 本轮收支：+45,200 / −2,700（税 0）
  const reRound = /本轮收支：\+([\d,]+) \/ −([\d,]+)（税 ([\d,]+)）/
  const reEarn = /今日收入按服务端补账：\+([\d,]+)/
  const reSpend = /今日支出按服务端补账：−([\d,]+)/
  const reTax = /今日卖货税按服务端补账：([\d,]+)/
  const n = (s) => Number(s.replace(/,/g, '')) || 0
  let earn = 0, spend = 0, tax = 0, rounds = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(todayBj)) continue
    const m = reRound.exec(line)
    if (m) {
      earn += n(m[1])
      spend += n(m[2])
      tax += n(m[3])
      rounds++
      continue
    }
    // 补账行：服务端给的是「当天累计总额」，不是增量，只升不降
    const me = reEarn.exec(line)
    if (me) { earn = Math.max(earn, n(me[1])); rounds++; continue }
    const ms = reSpend.exec(line)
    if (ms) { spend = Math.max(spend, n(ms[1])); rounds++; continue }
    const mt = reTax.exec(line)
    if (mt) { tax = Math.max(tax, n(mt[1])); rounds++; continue }
  }
  if (!rounds) return empty
  return { earn, spend, tax, rounds, from: file }
}

/**
 * 从今天的日志里重建「卖货税」。
 *
 * 为什么单独来一个：state.json 里的 daily.tax 是**旧版本存进去的 0**。
 * 旧代码 world.act 取的是响应体顶层的 j.tax（服务端根本不返回这个字段），
 * 所以 tax 从头到尾都是 0，还被覆盖写进 state.json。
 * 修好取值之后，只要当天已经跑过一阵，恢复出来的仍是 0，
 * GUI 会一直显示 0 直到下一个自然日。
 *
 * 日志里每批卖货都留了「（已扣税 N）」，是当日累计的最可靠来源。
 * 只数这一种行，不数「本轮收支（税 N）」——那是同一笔税的上卷，会重复计。
 */
export function todayTaxFromLog(dir, nowMs = Date.now()) {
  const todayBj = new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const file = resolve(dir, `yuyugu-${todayBj}.log`)
  if (!existsSync(file)) return 0
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return 0 }
  const re = /已扣税 ([\d,]+)/
  let tax = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(todayBj)) continue
    const m = re.exec(line)
    if (!m) continue
    tax += Number(m[1].replace(/,/g, '')) || 0
  }
  return tax
}

/** 日志目录概况（给 GUI 显示有哪些天可选） */export function logInventory(dir) {
  const days = listLogDays(dir)
  return days.map((day) => {
    const file = resolve(dir, `yuyugu-${day}.log`)
    let size = 0, mtime = 0
    try { const st = statSync(file); size = st.size; mtime = st.mtimeMs } catch {}
    return { day, size, mtime }
  })
}
