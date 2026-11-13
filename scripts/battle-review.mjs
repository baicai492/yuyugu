// 守家/擂台战绩复盘（只读）。
//
// 用法：node scripts/battle-review.mjs [profiles.json] [state.json]
//   默认读 logs/battle-profiles.json 和 logs/state.json。
//
// 看三件事：
//   1. 每座岛 / 每个擂台对手的真实 w/d/l 与经验胜率（带 Wilson 区间）；
//   2. 有赛前预测的场次，实际胜率与预测差多少——这个差值就是
//      「模拟偏乐观/偏悲观」的量（榜一 audit 里的 hindsight gap）；
//   3. 当前 stealState 里还封着 / 冷却中的岛，以及封禁原因。
//
// 只读，不会改任何文件，也不会发请求。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { wilsonInterval } from '../core/battle.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const profilesPath = process.argv[2] || path.join(ROOT, 'logs', 'battle-profiles.json')
const statePath = process.argv[3] || path.join(ROOT, 'logs', 'state.json')

const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`
const pad = (s, n) => {
  const str = String(s)
  // 中文按 2 列宽计算，简单对齐终端输出
  const w = [...str].reduce((a, ch) => a + (/[一-龥]/.test(ch) ? 2 : 1), 0)
  return str + ' '.repeat(Math.max(0, n - w))
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return null }
}

const store = readJson(profilesPath)
if (!store) {
  console.error(`读不到对手档案：${profilesPath}`)
  process.exit(1)
}

const summary = { guard: { n: 0, w: 0, predN: 0, predSum: 0, actualSum: 0 }, arena: { n: 0, w: 0, predN: 0, predSum: 0, actualSum: 0 } }

for (const mode of ['guard', 'arena']) {
  const rows = []
  for (const [id, entry] of Object.entries(store.profiles || {})) {
    const rec = entry?.record?.[mode]
    const n = (rec?.w || 0) + (rec?.d || 0) + (rec?.l || 0)
    if (!n) continue
    const wr = (rec.w || 0) / n
    const ci = wilsonInterval(rec.w || 0, n)
    const pred = Number(rec.pred?.win)
    rows.push({ id, name: entry.name || '', rec, n, wr, ci, pred })
    summary[mode].n += n
    summary[mode].w += rec.w || 0
    if (Number.isFinite(pred)) {
      summary[mode].predN += n
      summary[mode].predSum += pred * n
      summary[mode].actualSum += wr * n
    }
  }
  rows.sort((a, b) => b.n - a.n || (a.name || a.id).localeCompare(b.name || b.id, 'zh'))

  console.log(`\n=== ${mode === 'guard' ? '偷菜·守家战' : '擂台'}（${rows.length} 个对手有战绩）===`)
  if (!rows.length) { console.log('  （暂无记录）'); continue }
  console.log('  ' + pad('对手', 22) + pad('w/d/l', 10) + pad('经验胜率', 12) + pad('80% 区间', 16) + pad('赛前预测', 10) + pad('偏差', 8) + '最近')
  for (const r of rows) {
    const name = `${r.name || '#' + r.id}(${r.id})`
    const ci = r.ci ? `[${pct(r.ci[0])},${pct(r.ci[1])}]` : '-'
    const pred = Number.isFinite(r.pred) ? pct(r.pred) : '-'
    // 有预测时用最近一次预测对比整体经验胜率（样本少时只作参考）
    const bias = Number.isFinite(r.pred) ? pct(r.wr - r.pred) : '-'
    const last = r.rec.lastOutcome
      ? `${r.rec.lastOutcome} @ ${new Date((r.rec.lastAt || 0) * 1000).toLocaleString('zh-CN', { hour12: false })}`
      : '-'
    console.log('  ' + pad(name, 22) + pad(`${r.rec.w || 0}/${r.rec.d || 0}/${r.rec.l || 0}`, 10) +
      pad(pct(r.wr), 12) + pad(ci, 16) + pad(pred, 10) + pad(bias, 8) + last)
  }
}

for (const [mode, s] of Object.entries(summary)) {
  if (!s.n) continue
  const label = mode === 'guard' ? '偷菜·守家战' : '擂台'
  let line = `${label}：共 ${s.n} 场，经验胜率 ${pct(s.w / s.n)}`
  if (s.predN) {
    const pred = s.predSum / s.predN
    const actual = s.actualSum / s.predN
    const diff = actual - pred
    line += `｜有预测的 ${s.predN} 场：赛前平均 ${pct(pred)}，实际 ${pct(actual)}` +
      `（${diff < -0.03 ? '模拟偏乐观' : diff > 0.03 ? '模拟偏悲观' : '基本校准'} ${diff > 0 ? '+' : ''}${pct(diff)}）`
  }
  console.log(`\n${line}`)
}

// 当前封禁 / 冷却状态
const state = readJson(statePath)
const stealState = state?.stealState || {}
const now = Math.floor(Date.now() / 1000)
const blocked = Object.entries(stealState)
  .map(([id, s]) => ({
    id,
    until: Math.max(Number(s.blockedUntil) || 0, Number(s.cooldownUntil) || 0),
    reason: s.blockedReason || (Number(s.cooldownUntil) > now ? 'cooldown' : ''),
    lossCount: Number(s.lossCount) || 0,
  }))
  .filter((x) => x.until > now)
  .sort((a, b) => b.until - a.until)

console.log(`\n=== 当前跳过中的岛（${blocked.length}）===`)
if (!blocked.length) console.log('  （无）')
for (const b of blocked) {
  console.log(`  #${b.id}  剩余 ${Math.round(b.until - now)} 秒  ${b.reason}` +
    (b.lossCount ? `  连续打输 ${b.lossCount} 次` : ''))
}
console.log('')
