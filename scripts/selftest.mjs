// 自检：不碰账号，验证核心模块是否正常。
// 用法：node scripts/selftest.mjs
import { loadRules, loadRulesCached } from '../core/rules.mjs'
import { solveGomoku, verifyGomoku, playLine } from '../core/gomoku.mjs'
import * as M from '../core/market.mjs'
import { DEFAULTS, mergeConfig } from '../core/config.mjs'
import { todayBookFromLog, todayStartFromLedger } from '../core/logfile.mjs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? '：' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? '：' + extra : ''}`) }
}

console.log('\n[1] 规则模块')
const R = await loadRulesCached()
ok('applyActions 可用', typeof R.applyActions === 'function')
ok('五子棋 15 路', R.GOMOKU_N === 15, `GOMOKU_N=${R.GOMOKU_N}`)
ok('计奖 10 局', R.GOMOKU_PAID === 10)
ok('商品数', Object.keys(R.BASE_PRICE).length > 40, `${Object.keys(R.BASE_PRICE).length} 种`)
ok('作物阶梯价', JSON.stringify(R.CROP_TIERS?.[0]) === '[150,1]')

console.log('\n[2] 五子棋求解器（三档各 4 局）')
for (const d of [1, 2, 3]) {
  let win = 0
  const t0 = Date.now()
  for (let i = 0; i < 4; i++) {
    const seed = 777000 + i * 7919
    const mv = solveGomoku(R, seed, { N: 15, d, budgetMs: 5000, lines: 60, jitter: 0.5 })
    if (mv && verifyGomoku(R, seed, mv, { N: 15, d })) win++
  }
  ok(`难度 ${d}`, win >= 3, `${win}/4 胜，${Date.now() - t0}ms`)
}

console.log('\n[3] 五子棋复盘一致性')
{
  const seed = 12345
  const r = playLine(R, seed, { N: 15, d: 2, jitter: 0 })
  const has = r.mv.length > 0
  ok('能走完整局', has, `${r.mv.length} 手，结果 ${r.result}`)
}

console.log('\n[4] 市场预测')
{
  // 用规则自身造一个「假服务端报价」：取某个岛日的基准价 × 1.0 供需
  const now = 1794400000
  R.b12ConfigureClock(1794212939)
  const day = R.isleDay(now)
  const prices = {}
  for (const id of Object.keys(R.BASE_PRICE)) prices[id] = M.baseQuote(R, id, day)
  const obs = M.inferSupply(R, prices, day)
  ok('供需反推样本数', obs.n > 40, `${obs.n} 个`)
  const avg = Object.values(obs.rows).reduce((a, r) => a + r.supply, 0) / obs.n
  ok('供需接近 1.0', Math.abs(avg - 1) < 0.05, `平均 ${avg.toFixed(3)}`)
  const fc = M.forecastPrices(R, now, prices, { days: 6 })
  ok('预测 6 个岛日', fc.length === 6)
  const allPositive = fc.every((f) => Object.values(f.price).every((p) => p > 0))
  ok('所有价格为正', allPositive)
  // 阶梯价
  ok('阶梯 0→1 全价', M.cropTierRatio(R, 0, 1) === 1)
  ok('阶梯 150 后降档', M.cropTierRatio(R, 150, 1) === 0.85)
  ok('阶梯 400 后再降', M.cropTierRatio(R, 400, 1) === 0.7)
  // 税
  const q1 = M.netSaleQuote(R, 1_000_000, 0, 100000)
  ok('300 万以下免税', q1.tax === 0, `税 ${q1.tax}`)
  const q2 = M.netSaleQuote(R, 20_000_000, 0, 100000)
  ok('大额收 3%', q2.tax > 0, `税 ${q2.tax}`)

  // 跨期分配：今天价低、未来更高时，作物只卖今天的全价额度
  const cropId = R.CROPS[0].id
  const fcLow = [{ price: { [cropId]: 100 } }, { price: { [cropId]: 200 } }]
  const aLow = M.allocateSale(R, cropId, 600, fcLow, { isCrop: true, soldToday: 0, markdown: 0.06 })
  ok('跨期：今天低就只卖今天能卖掉的', aLow.today === 0, `today=${aLow.today}`)
  const fcHigh = [{ price: { [cropId]: 200 } }, { price: { [cropId]: 100 } }]
  const aHigh = M.allocateSale(R, cropId, 600, fcHigh, { isCrop: true, soldToday: 0, markdown: 0.06 })
  ok('跨期：今天高就今天全卖', aHigh.today === 600, `today=${aHigh.today}`)

  // 未来到货：明后天成熟的货会占掉后面的档期，今天的货就得先填今天的全价。
  {
    const at0 = now, at1 = now + 3600
    ok('测试时间跨自然日检查', R.worldDay(at0) === R.worldDay(at1), `${R.worldDay(at0)} / ${R.worldDay(at1)}`)
    const fc2 = [
      { at: at0, end: at1, price: { [cropId]: 100 } },
      { at: at1, end: at1 + 3600, price: { [cropId]: 110 } },
    ]
    const noArr = M.allocateSale(R, cropId, 200, fc2, { isCrop: true, soldToday: 0, markdown: 0.06 })
    ok('同一自然日：价格低的先不卖', noArr.today === 0, `today=${noArr.today}`)

    // 换成另一个自然日：明天有一份新的 150 全价额度。
    const at2 = now + 4 * 3600
    ok('测试时间确实跨天', R.worldDay(at0) !== R.worldDay(at2), `${R.worldDay(at0)} / ${R.worldDay(at2)}`)
    const fc2b = [
      { at: at0, end: at1, price: { [cropId]: 100 } },
      { at: at2, end: at2 + 3600, price: { [cropId]: 110 } },
    ]
    const noArr2 = M.allocateSale(R, cropId, 200, fc2b, { isCrop: true, soldToday: 0, markdown: 0.06 })
    ok('无到货：今天只填全价额度', noArr2.today === 50, `today=${noArr2.today}`)
    const withArr = M.allocateSale(R, cropId, 200, fc2b, {
      isCrop: true, soldToday: 0, markdown: 0.06,
      arrivals: [{ k: 1, n: 200, qAvg: 1 }],
    })
    ok('有到货：明天名额被新货占，今天卖满 150', withArr.today === 150, `today=${withArr.today}`)
  }

  // 阶梯容量按自然日共享：同一自然日的两个岛日不能各拿一份 150 全价。
  // 今天 130、下一个岛日 120×0.94=112.8，600 件应该今天全部按今天的价出，
  // 旧模型只算「今天卖 150、明天再 150 全价」，会少卖 450 件。
  {
    const at0 = now, at1 = now + 3600
    const fc3 = [
      { at: at0, end: at1, price: { [cropId]: 130 } },
      { at: at1, end: at1 + 3600, price: { [cropId]: 120 } },
    ]
    const a3 = M.allocateSale(R, cropId, 600, fc3, { isCrop: true, soldToday: 0, markdown: 0.06 })
    const expect = 150 * 130 + 250 * 130 * 0.85 + 200 * 130 * 0.7
    ok('同一自然日的阶梯共享', a3.today === 600, `today=${a3.today}`)
    ok('同一自然日的分配收益', Math.abs(a3.netOptimal - expect) < 1, `gross=${Math.round(a3.netOptimal)} 期望 ${expect}`)
  }
  // 终端清算：600 件作物压到末尾，只能按 150 全价 + 250 件 85% + 其余 70%
  const liq = M.liquidationValue(R, cropId, 600, fcHigh, { isCrop: true, keepDays: 2 })
  const expectLiq = 150 * 200 + 250 * 200 * 0.85 + 200 * 200 * 0.7
  ok('终端清算按真实阶梯算', Math.abs(liq.gross - expectLiq) < 1, `gross=${Math.round(liq.gross)} 期望 ${expectLiq}`)
  ok('清算均价低于全价', liq.unitPrice < 200, `单价 ${liq.unitPrice.toFixed(1)}`)

  // 未来到货时刻：手工浇水每阶段把剩余时间折 25%，不能拿「再也不浇水」的 left 当成熟时刻
  {
    const season = R.seasonOf(R.isleDay(now))
    const crop = R.CROPS.find((c) => c.seasons.includes(season))
    const p = { c: crop.id, t: now - 20 * 60, w: 0, g: 0, h: 0 }
    const st = R.cropStage(p, now, false)
    const fcA = [{ at: now, end: now + 3600 }, { at: now + 3600, end: now + 7200 }]
    const arr = M.cropArrivals(R, { plots: [p], tools: { spr: 0 } }, now, fcA)[crop.id]
    // 独立实现：按分钟步进，每进入新阶段就浇水
    const q = { ...p }
    let bruteAt = Infinity
    for (let m = 0; m <= 2000; m++) {
      const tt = now + m * 60
      const s2 = R.cropStage(q, tt, false)
      if (!s2 || s2.stage < 0) break
      if (s2.stage >= 3) { bruteAt = tt; break }
      if (q.w <= s2.stage) { q.g += Math.floor(s2.left * 0.25); q.w++ }
    }
    ok('到货时刻与逐分钟推进一致',
      arr?.[0] && arr[0].at <= bruteAt && bruteAt - arr[0].at < 60,
      `事件式 ${arr?.[0] ? Math.round((arr[0].at - now) / 60) : '-'} 分 / 步进 ${Math.round((bruteAt - now) / 60)} 分`)
    ok('到货时刻早于「不浇水」口径', arr?.[0] && arr[0].at - now < st.left,
      `left=${Math.round(st.left / 60)} 分`)
    // 已成熟的地已经进过 inventory，不能再算一次到货
    const ripe = { c: crop.id, t: now - 800 * 60, w: 0, g: 0, h: 0 }
    ok('已成熟的地不计入到货',
      !(M.cropArrivals(R, { plots: [ripe], tools: { spr: 0 } }, now, fcA)[crop.id] || []).length)
  }
}

console.log('\n[5] 配置')
{
  const c = mergeConfig(DEFAULTS, { npc: { gomokuLevel: 2 }, sell: { days: 5 } })
  ok('深度合并', c.npc.gomokuLevel === 2 && c.npc.gomoku === true && c.sell.days === 5)
  ok('默认五子棋参数', c.npc.gomokuLines === 60 && c.npc.gomokuJitter === 0.5)
}

console.log('\n[6] 重启后的「今日」口径')
{
  const dir = mkdtempSync(join(tmpdir(), 'yuyugu-test-'))
  try {
    const now = Date.parse('2026-11-13T01:00:00+08:00')
    const day = '2026-11-13'
    // 日志：轮次 + 服务端补账（补账行给的是当天累计总额，不是增量）
    writeFileSync(join(dir, `yuyugu-${day}.log`), [
      `${day} 00:10:00 本轮收支：+6,716 / −0（税 0）`,
      `${day} 00:18:00 今日收入按服务端补账：+26,100（日志里是 +6,716）`,
      `${day} 00:45:00 本轮收支：+49,416 / −0（税 0）`,
      `${day} 00:50:00 今日支出按服务端补账：−1,200（日志里是 −0）`,
      `${day} 00:55:00 今日卖货税按服务端补账：900（日志里是 0）`,
      `2026-11-12 23:59:00 本轮收支：+9,702,964 / −7,634,393（税 0）`,   // 昨天的不算
    ].join('\n'))
    const book = todayBookFromLog(dir, now)
    ok('补账行按总额重放', book.earn === 75_516, `earn=${book.earn}`)
    ok('补账支出只升不降', book.spend === 1_200, `spend=${book.spend}`)
    ok('补账税', book.tax === 900, `tax=${book.tax}`)

    // 起点：昨天 23:57 和今天 00:58 里，离今天 0 点更近的是昨天那条
    writeFileSync(join(dir, 'ledger.csv'), [
      'time,coins,stock_value,energy,plots,animals,rod,pick,spr,house',
      '2026-11-12 23:57:26,19309215,10364523,80,8,2,1,1,0,1',
      '2026-11-13 00:58:35,19311095,10653637,80,8,2,1,1,0,1',
    ].join('\n'))
    const s1 = todayStartFromLedger(dir, now)
    ok('起点取离 0 点最近的记录', s1?.startCoins === 19_309_215 && s1?.from === 'yesterday',
      `${s1?.firstTime} / ${s1?.from}`)

    // 反过来：今天 00:01 有记录、昨天 23:00 有记录，应取今天那条
    writeFileSync(join(dir, 'ledger.csv'), [
      'time,coins,stock_value,energy,plots,animals,rod,pick,spr,house',
      '2026-11-12 23:00:00,19000000,10000000,80,8,2,1,1,0,1',
      '2026-11-13 00:01:00,19050000,10100000,80,8,2,1,1,0,1',
    ].join('\n'))
    const s2 = todayStartFromLedger(dir, now)
    ok('今天已有贴近 0 点的记录时取今天', s2?.startCoins === 19_050_000 && s2?.from === 'today',
      `${s2?.firstTime} / ${s2?.from}`)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

console.log('\n[7] 守家战绩与后验混合')
{
  const {
    noteBattleOutcome, getBattleRecord, blendBattleRecord, battleOutcomeOf,
  } = await import('../core/battle.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'yuyugu-rec-'))
  const storePath = join(dir, 'profiles.json')
  try {
    ok('战报胜负解析：win', battleOutcomeOf({ win: true }) === 'win')
    ok('战报胜负解析：result=lose', battleOutcomeOf({ result: 'lose' }) === 'lose')
    ok('战报胜负解析：winner=me', battleOutcomeOf({ winner: 'me' }) === 'win')
    ok('战报胜负解析：无法判断', battleOutcomeOf({}) === null)

    noteBattleOutcome(9001, 'lose', { mode: 'guard', storePath, predicted: { winRate: 0.7, lossRate: 0.2 } })
    noteBattleOutcome(9001, 'win', { mode: 'guard', storePath })
    noteBattleOutcome(9001, 'lose', { mode: 'guard', storePath })
    const rec = getBattleRecord(9001, 'guard', { storePath })
    ok('按 mode 记录 w/d/l', rec?.w === 1 && rec?.d === 0 && rec?.l === 2, `w${rec?.w} d${rec?.d} l${rec?.l}`)
    ok('保存赛前预测', rec?.pred?.win === 0.7 && rec?.pred?.loss === 0.2)
    ok('另一模式互不干扰', getBattleRecord(9001, 'arena', { storePath }) === null)

    // 模拟 80% 胜、10% 平、10% 负；真实 1 胜 2 负；prior=4
    // 期望：win=(0.8×4+1)/7≈0.6，loss=(0.1×4+2)/7≈0.343，draw=0.4/7≈0.057
    const blended = blendBattleRecord(
      { winRateMid: 0.8, lossRateMid: 0.1, drawRate: 0.1 },
      rec, { prior: 4 },
    )
    ok('混合后胜率被经验拉低', blended.winRateMid > 0.59 && blended.winRateMid < 0.61,
      blended.winRateMid.toFixed(3))
    ok('混合后三率归一', Math.abs(blended.winRateMid + blended.lossRateMid + blended.drawRate - 1) < 1e-9)
    ok('保留原始模拟值', blended.simulatedWinRateMid === 0.8)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
