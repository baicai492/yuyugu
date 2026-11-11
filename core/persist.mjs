// 持久化：把「重启会丢、但应该跨重启延续」的东西存到磁盘。
//
// 存在 logs/state.json：
//   {
//     day: "2026-11-12",
//     daily: { earn, spend, tax },        // 今日累计收支（本次+之前进程）
//     helped: [id, ...],                  // 今天已经帮过的玩家
//     helpCount: 12,                      // 今天帮忙次数
//     stealScanAt: 1794...,               // 上次扫偷菜目录的 unix 秒
//     steam: { ... },                     // 其他需要跨重启的临时状态
//     stats: { totalRuns, totalEarn, firstRunAt }
//   }
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const FILE = 'state.json'

export function loadState(dir) {
  const file = resolve(dir, FILE)
  const empty = { day: '', daily: { earn: 0, spend: 0, tax: 0 }, helped: [], helpCount: 0, stealScanAt: 0, stats: { totalRuns: 0, totalEarn: 0, firstRunAt: 0 } }
  if (!existsSync(file)) return empty
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return {
      ...empty,
      ...j,
      daily: { ...empty.daily, ...(j.daily || {}) },
      helped: Array.isArray(j.helped) ? j.helped : [],
      stats: { ...empty.stats, ...(j.stats || {}) },
    }
  } catch { return empty }
}

export function saveState(dir, state) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(resolve(dir, FILE), JSON.stringify(state, null, 2), 'utf8')
  } catch {}
}

/** 自然日切换时，把「每日」部分清零 */
export function rollDay(state, day) {
  if (state.day === day) return state
  const fresh = {
    ...state,
    day,
    daily: { earn: 0, spend: 0, tax: 0 },
    helped: [],
    helpCount: 0,
    stealScanAt: 0,
  }
  return fresh
}

/** 读 ledger.csv 的最近 N 行，恢复资产曲线 */
export function readLedger(dir, maxRows = 240) {
  const file = resolve(dir, 'ledger.csv')
  if (!existsSync(file)) return []
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return []
  const rows = []
  for (const line of lines.slice(1)) {
    const [time, coins, stock, energy, plots, animals, rod, pick, spr, house] = line.split(',')
    if (!time) continue
    rows.push({
      time,
      t: Date.parse(time.replace(' ', 'T') + '+08:00'),
      coins: Number(coins) || 0,
      stock: Number(stock) || 0,
      energy: Number(energy) || 0,
      plots: Number(plots) || 0,
      animals: Number(animals) || 0,
      rod: Number(rod) || 0, pick: Number(pick) || 0,
      spr: Number(spr) || 0, house: Number(house) || 0,
    })
  }
  return rows.slice(-maxRows)
}
