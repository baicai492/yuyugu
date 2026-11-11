// 读磁盘上的日志文件，让 GUI 能看到往次运行的记录。
//
// 文件格式（和 engine.log 写的一致）：
//   2026-11-11 23:50:27 消息内容
// 时间是北京时间。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

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
