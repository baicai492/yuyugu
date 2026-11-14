// 把浏览器里 v1 旧插件留下的日志挖出来，按天写成 logs/legacy-YYYY-MM-DD.log。
//
// 为什么需要：v1 插件只把日志存在 chrome.storage.local（LevelDB），
// 而 Chrome 在扩展卸载/重装、profile 迁移时会直接删掉整个存储目录。
// 本机正式 profile 的库就是 2026-11-12 01:43 重建的（见目录里的 LOG：
// "Creating DB ... since it was missing"），只剩 1 条；
// 反而是测试脚本建在 %TEMP%\yyg-* 里的一次性 profile 存住了 11-11 的 50 条。
//
// 导入后 readLogHistory 会把 legacy-*.log 和 yuyugu-*.log 合并成一天显示，
// 但两者物理分开——主日志要参与「今日收支」重放，不能被旧格式污染。
//
// 用法：
//   node scripts/import-legacy-logs.mjs          # 扫一遍并写入
//   node scripts/import-legacy-logs.mjs --dry    # 只看会写入什么
import { findLegacyExtensionStores, readLegacyDir, legacyCacheFile } from '../core/logfile.mjs'
import { loadConfig } from '../core/config.mjs'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry')

const cfg = loadConfig()
const extId = cfg.log?.legacyExtensionId
if (!extId) {
  console.error('config 里没有 log.legacyExtensionId，无法定位旧插件存储')
  process.exit(1)
}

const stores = findLegacyExtensionStores(extId)
if (!stores.length) {
  console.log('没在浏览器里找到旧插件存储。')
  process.exit(0)
}

const rows = []
const seen = new Set()
for (const st of stores) {
  const r = readLegacyDir(st.dir, { maxLines: 1_000_000 })
  for (const row of r.rows) {
    const k = row.ts + '|' + row.msg.slice(0, 80)
    if (seen.has(k)) continue
    seen.add(k)
    rows.push({ ...row, store: `${st.browser} · ${st.profile}` })
  }
}

rows.sort((a, b) => a.ts.localeCompare(b.ts))
const byDay = new Map()
for (const r of rows) {
  const d = r.ts.slice(0, 10)
  if (!byDay.has(d)) byDay.set(d, [])
  byDay.get(d).push(r)
}

const logsDir = resolve(ROOT, 'logs')
if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })

console.log(`扫到 ${stores.length} 份存储，去重后 ${rows.length} 条`)
for (const st of stores) console.log(`  ${st.browser} / ${st.profile}  ${st.size}B  ${st.dir}`)

let wrote = 0
for (const [day, list] of [...byDay].sort()) {
  const file = resolve(logsDir, `legacy-${day}.log`)
  // 幂等：文件已存在就先读进来，和新内容一起按「时间+消息」去重
  const old = new Map()
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) ([\s\S]*)$/.exec(line)
      if (!m) continue
      const msg = m[2].replace(/^\[旧插件\] /, '')
      old.set(m[1] + '|' + msg.slice(0, 80), { ts: m[1], msg })
    }
  }
  let added = 0
  for (const r of list) {
    const k = r.ts + '|' + r.msg.slice(0, 80)
    if (old.has(k)) continue
    old.set(k, { ts: r.ts, msg: r.msg })
    added++
  }
  const merged = [...old.values()].sort((a, b) => a.ts.localeCompare(b.ts))
  const text = merged.map((r) => `${r.ts} [旧插件] ${r.msg}`).join('\n') + '\n'
  console.log(`  ${day}: 文件里原有 ${old.size - added} 条，新增 ${added} 条 → 共 ${merged.length} 条  ${file}`)
  if (!DRY) writeFileSync(file, text)
  wrote += added
}
console.log(DRY ? `[演练] 本会写入 ${wrote} 条` : `完成：新增 ${wrote} 条`)

// 顺带把缓存也刷一遍：以后浏览器存储被清掉，GUI 还能从 logs/legacy-imported.json 读
if (!DRY) {
  try {
    writeFileSync(legacyCacheFile(logsDir), JSON.stringify(rows))
    console.log(`本地缓存已更新：${legacyCacheFile(logsDir)}`)
  } catch (e) {
    console.log('缓存写入失败：' + e.message)
  }
}
