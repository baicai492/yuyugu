#!/usr/bin/env node
// 鱼鱼谷托管主程序（v2：Node 主程序 + Chrome GUI）。
//
// 用法：
//   node yuyugu2.mjs              持续托管（需要 config.enabled = true）
//   node yuyugu2.mjs --once       只巡视一次
//   node yuyugu2.mjs --dry        演练：只打印计划，不提交
//   node yuyugu2.mjs --no-server  不启动本地 HTTP 服务（给 GUI 用）
//   node yuyugu2.mjs --port=8787  指定端口
//   node yuyugu2.mjs --market     只打印市场预测报告并退出
//   node yuyugu2.mjs --test-gomoku [难度] [局数]   离线测五子棋求解器
//
// 配置文件：config.json（和本文件同目录），GUI 也能改。
import { resolve } from 'node:path'
import { readSession } from './core/session.mjs'
import { createClient } from './core/http.mjs'
import { loadRules } from './core/rules.mjs'
import { World } from './core/world.mjs'
import { Engine } from './core/engine.mjs'
import { loadConfig, saveConfig } from './core/config.mjs'
import { startServer } from './core/server.mjs'
import { pruneOldLogs } from './core/logfile.mjs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const has = (k) => args.includes('--' + k)
const getArg = (k, dflt) => {
  const a = args.find((x) => x.startsWith('--' + k + '='))
  return a ? a.split('=')[1] : dflt
}

const cfg = loadConfig()
if (has('dry')) cfg.dry = true

async function main() {
  // ---------- 离线测试五子棋 ----------
  if (has('test-gomoku')) {
    const idx = args.indexOf('--test-gomoku')
    const lv = Number(args[idx + 1]) || 3
    const total = Number(args[idx + 2]) || 5
    // 有登录态就带上：未登录的 /pets 不渲染带 ?v= 的 script 标签，
    // fetchVersion 会拿到空串，日志里多一行「规则模块联网失败」的噪音。
    let ck = ''
    try { ck = readSession(resolve(import.meta.dirname || '.', cfg.cookieFile)).cookie || '' } catch {}
    const R = await loadRules({ baseUrl: cfg.baseUrl, cookie: ck })
    const { solveGomoku, verifyGomoku } = await import('./core/gomoku.mjs')
    let win = 0, ms = 0
    for (let i = 0; i < total; i++) {
      const seed = 1000 + i * 7919
      const t0 = Date.now()
      const mv = solveGomoku(R, seed, { N: R.GOMOKU_N, d: lv, budgetMs: 6000, lines: 60, jitter: 0.5 })
      ms += Date.now() - t0
      const ok = mv && verifyGomoku(R, seed, mv, { N: R.GOMOKU_N, d: lv })
      if (ok) win++
      console.log(`  难度 ${lv} 局 ${i + 1}: ${ok ? '胜' : '未解出'}（${Date.now() - t0}ms，${mv ? mv.length : 0} 手）`)
    }
    console.log(`\n难度 ${lv}：${win}/${total} 胜，平均 ${(ms / total).toFixed(0)}ms`)
    return
  }

  // ---------- 初始化 ----------
  const session = readSession(resolve(import.meta.dirname || '.', cfg.cookieFile))
  const client = createClient({ baseUrl: cfg.baseUrl, cookie: session.cookie, minGap: cfg.minGap, dryRun: !!cfg.dry })
  const log0 = (m) => console.log(m)

  process.stdout.write('加载规则模块… ')
  const R = await loadRules({ baseUrl: cfg.baseUrl, cookie: session.cookie })
  console.log('OK（' + (R.GOMOKU_N) + ' 路五子棋，' + Object.keys(R.BASE_PRICE).length + ' 种商品）')

  const world = new World(client, log0)
  const engine = new Engine({ world, cfg })
  // 过期日志清理：一天 1~2MB，不清理一年就是几百 MB。
  // 只删按日期命名的运行日志（yuyugu-*/host-*），账本和状态文件不动。
  try {
    const keepDays = cfg.log?.keepDays ?? 30
    const removed = pruneOldLogs(engine.logDir, { keepDays })
    if (removed.length) console.log(`清理 ${removed.length} 份过期日志（保留 ${keepDays} 天）`)
  } catch {}
  engine.log = engine.log.bind(engine)
  // 世界层（提交动作后的「收入/支出/获得什么」）也要写进日志文件，
  // 否则这些明细只出现在终端里，GUI 的历史记录看不到。
  world.log = (m) => engine.log(m)

  process.stdout.write('拉取世界状态… ')
  try {
    await world.refresh()
    console.log('OK')
  } catch (e) {
    console.error('\n拉取失败：' + e.message)
    if (e.name === 'AuthError') console.error('cookie 已失效，请从浏览器重新复制到 ' + cfg.cookieFile)
    process.exit(1)
  }

  engine.log(`登录状态正常：D币 ${Math.round(world.coins).toLocaleString('en-US')}，岛日 ${R.isleDayNo(world.now)}`)
  engine.ensureLedger()

  // ---------- 只打印市场报告 ----------
  if (has('market')) {
    const snap = engine.marketSnapshot({ days: Number(getArg('days', 12)) })
    const R2 = world.R
    console.log('\n=== 供需反推 ===')
    const clamped = Object.entries(snap.supply.items).filter(([, v]) => v.clamped).length
    console.log(`样本 ${Object.keys(snap.supply.items).length} 个，其中 ${clamped} 个已顶到钳位边界`)
    console.log('\n=== 未来岛日 ===')
    for (const f of snap.forecast) {
      const ev = f.events.map((e) => `${e.text}（${e.m > 1 ? '+' : ''}${Math.round((e.m - 1) * 100)}%）`).join('；') || '无'
      console.log(`  ${f.day} ${f.season}·${f.weather}  商闻：${ev}`)
    }
    console.log('\n=== 择时卖出（按多赚潜力排序） ===')
    console.log('货物'.padEnd(12) + '数量'.padStart(5) + '现价%'.padStart(8) + '峰值%'.padStart(8) + '几天后'.padStart(7) + '今日实收'.padStart(12) + '峰值实收'.padStart(12) + '  建议')
    for (const r of snap.rows.slice(0, 40)) {
      const pct = (x) => (x * 100).toFixed(0) + '%'
      console.log(
        String(r.name).padEnd(12) + String(r.qty).padStart(5) +
        pct(r.curPct).padStart(8) + pct(r.peakPct).padStart(8) + String('+' + r.peakIn).padStart(7) +
        Math.round(r.netNow).toLocaleString('en-US').padStart(12) +
        Math.round(r.netAtPeak).toLocaleString('en-US').padStart(12) +
        '  ' + (r.sellNow ? `今日卖 ${r.todayQty}/${r.qty}` : '等峰值'),
      )
    }
    return
  }

  // ---------- 本地服务 ----------
  let server = null
  if (!has('no-server')) {
    server = startServer({
      engine, cfg,
      port: Number(getArg('port', 8787)),
      token: getArg('token', ''),
      onConfigChange: (c) => { engine.cfg = c },
    })
  }

  // ---------- 单次巡视 ----------
  if (has('once')) {
    try {
      await engine.tick()
      engine.log('单次巡视完成')
    } catch (e) {
      engine.log('巡视出错：' + e.message, 'err')
    }
    server?.close()
    return
  }

  // ---------- 持续运行 ----------
  //
  // 退出要等当前这一轮跑完：tick 里可能正有请求在飞，
  // 硬切会留下 daemon.lock（下次靠死 pid 回收，但会白等一轮），
  // 更糟的是请求已发出、回执没读，账本和库存对不上。
  // 等满 15 秒还没停就强制退（擂台一轮要 4 分钟，不能无限等）。
  const shutdown = (label) => {
    engine.log(`收到 ${label}，正在停止…`)
    engine.stop()
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (!engine.busy || Date.now() - t0 > 15000) {
        clearInterval(timer)
        process.exit(0)
      }
    }, 200)
    timer.unref?.()
  }
  process.on('SIGINT', () => shutdown('Ctrl+C'))
  // Windows 计划任务/服务管理器停止进程时发的是 SIGTERM（或直接 Terminate）。
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // 简单的命令行控制台（没有 GUI 时也能用）
  if (!has('no-console') && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on('line', (line) => {
      const c = line.trim()
      if (c === 'start') { cfg.enabled = true; engine.log('控制台：启动') }
      else if (c === 'stop') { cfg.enabled = false; engine.log('控制台：暂停') }
      else if (c === 'once') engine.tick().catch((e) => engine.log(e.message, 'err'))
      else if (c === 'status') console.log(JSON.stringify(engine.statusSnapshot().world, null, 2))
      else if (c === 'market') {
        const s = engine.marketSnapshot()
        console.table(s.rows.slice(0, 15).map((r) => ({ 货物: r.name, 数量: r.qty, 现价百分比: (r.curPct * 100).toFixed(0) + '%', 峰值百分比: (r.peakPct * 100).toFixed(0) + '%', 几天后: r.peakIn, 今日卖: r.todayQty, 建议: r.sellNow ? '卖' : '等' })))
      }
      else if (c === 'save') { saveConfig(cfg); engine.log('配置已保存') }
      else if (c === 'quit' || c === 'exit') { engine.stop(); setTimeout(() => process.exit(0), 300) }
      else if (c) console.log('命令：start / stop / once / status / market / save / quit')
    })
    console.log('\n控制台命令：start / stop / once / status / market / save / quit\n')
  }

  // 首次启动提示
  if (!cfg.enabled) {
    engine.log('托管控件处于暂停状态。用 GUI 或控制台输入 start 开始。')
  }

  await engine.run()
  server?.close()
}

main().catch((e) => {
  console.error('\n启动失败：' + e.message)
  if (process.env.DEBUG) console.error(e.stack)
  process.exit(1)
})
