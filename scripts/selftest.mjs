// 自检：不碰账号，验证核心模块是否正常。
// 用法：node scripts/selftest.mjs
import { loadRules, loadRulesCached } from '../core/rules.mjs'
import { solveGomoku, verifyGomoku, playLine } from '../core/gomoku.mjs'
import * as M from '../core/market.mjs'
import { DEFAULTS, mergeConfig } from '../core/config.mjs'
import { todayBookFromLog, todayStartFromLedger } from '../core/logfile.mjs'
import {
  prepLeadSec, prepActLeadSec, physicalPrepLeadSec, stealGearSwaps,
  snipeStaminaReservation, snipeWindowOpen,
} from '../core/steal-schedule.mjs'
import { probeStealable } from '../core/social.mjs'
import { arcadeRules } from '../core/rules.mjs'
import { solveGame, verifyShots } from '../core/arcade.mjs'
import * as X from '../core/xian-rules.mjs'
import { fromWireXsAction } from '../core/xian.mjs'
import { planXian2Actions } from '../core/xian2.mjs'
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

console.log('\n[偷菜掐点]')
{
  // 提前量：访问耗时 + 余量，换装/补体力各占几个 POST，必须算进去
  ok('提前量基础值', prepLeadSec(1, {}) === 6, `${prepLeadSec(1, {})} 秒`)
  ok('补体力计入提前量', prepLeadSec(1, { prepActSec: 3 }) === 9, `${prepLeadSec(1, { prepActSec: 3 })} 秒`)
  ok('换装计入提前量', prepLeadSec(1, { gearSwaps: 3 }) === 13, `${prepLeadSec(1, { gearSwaps: 3 })} 秒`)

  // actPrep = 剩余 POST 冷却 + minGap + 2×RTT
  ok('不需要补体力时不占提前量', prepActLeadSec({ needPrep: false, remainingPostCdMs: 2000 }) === 0)
  const actPrep = prepActLeadSec({ needPrep: true, remainingPostCdMs: 0, minGapSec: 2.15, rttMs: 600 })
  ok('actPrep = minGap + 2×RTT', Math.abs(actPrep - 3.35) < 1e-9, `${actPrep.toFixed(2)} 秒`)
  const actPrep2 = prepActLeadSec({ needPrep: true, remainingPostCdMs: 1000, minGapSec: 2.15, rttMs: 600 })
  ok('actPrep 叠加剩余冷却', Math.abs(actPrep2 - 4.35) < 1e-9, `${actPrep2.toFixed(2)} 秒`)

  // 三个调用点（engine 唤醒 / social 掐点 / planner nextWake）共用一个提前量
  ok('默认配置要换 3 件装', stealGearSwaps(DEFAULTS) === 3)
  ok('擂台关掉就不换装', stealGearSwaps({ arena: { enabled: false } }) === 0)
  ok('偷菜前换装关掉就不换装', stealGearSwaps({ arena: { enabled: true }, battle: { stealSwap: false } }) === 0)
  const prepSched = { 42: { upcoming: [{ unlockAt: 100, kind: 'plot', i: 0 }] } }
  ok('统一提前量含换装', physicalPrepLeadSec({ schedule: prepSched, now: 0, gearSwaps: 3 }) === 13,
    `${physicalPrepLeadSec({ schedule: prepSched, now: 0, gearSwaps: 3 })} 秒`)
  ok('配置写死时优先用配置值',
    physicalPrepLeadSec({ schedule: prepSched, now: 0, gearSwaps: 3, fixedLeadSec: 5 }) === 5)

  // 解禁前体力预留：需要 7 点（3 处），600 秒自然回复 3 点 → 现在留 4 点
  const now = 100000
  const at = now + 600
  const schedule = {
    42: {
      nextEV: 9000,
      upcoming: [
        { kind: 'plot', i: 0, unlockAt: at, item: 'grape' },
        { kind: 'plot', i: 1, unlockAt: at, item: 'grape' },
        { kind: 'plot', i: 2, unlockAt: at, item: 'grape' },
      ],
    },
  }
  const resv = snipeStaminaReservation(schedule, now, {
    horizonSec: 900, regenSec: 180, energyMax: 200, maxEnergy: 15, energyBase: 5,
  })
  ok('预留体力 = 需要 − 自然回复', resv.floor === 4, `floor=${resv.floor} need=${resv.need}`)
  ok('预留到解禁时刻', resv.until === at && resv.targetId === 42, `until=${resv.until}`)
  const far = snipeStaminaReservation({ 42: { ...schedule[42], upcoming: [{ unlockAt: now + 5000 }] } }, now,
    { horizonSec: 900, regenSec: 180, energyMax: 200 })
  ok('超出视界不解禁的不预留', far.floor === 0, `floor=${far.floor}`)
  const longLead = snipeStaminaReservation({ 42: { ...schedule[42], upcoming: [{ unlockAt: now + 3600 }] } }, now,
    { horizonSec: 7200, regenSec: 180, energyMax: 200 })
  ok('自然回复够时不预留', longLead.floor === 0, `floor=${longLead.floor}`)
  ok('负期望目标不预留', snipeStaminaReservation({ 42: { ...schedule[42], nextEV: 0 } }, now).floor === 0)

  // 窗口判定：lead+4 秒内解禁、或刚解禁 30 秒内
  const soon = { 42: { upcoming: [{ unlockAt: now + 10, kind: 'plot', i: 0 }] } }
  ok('10 秒内解禁算窗口', !!snipeWindowOpen(soon, now, { leadSec: 8 }))
  ok('30 秒后解禁不算窗口',
    !snipeWindowOpen({ 42: { upcoming: [{ unlockAt: now + 30, kind: 'plot', i: 0 }] } }, now, { leadSec: 8 }))
  ok('刚解禁 5 秒仍算窗口',
    !!snipeWindowOpen({ 42: { upcoming: [{ unlockAt: now - 5, kind: 'plot', i: 0 }] } }, now, { leadSec: 8 }))
  ok('解禁已过 60 秒不算窗口',
    !snipeWindowOpen({ 42: { upcoming: [{ unlockAt: now - 60, kind: 'plot', i: 0 }] } }, now, { leadSec: 8 }))

  // 「此刻有货」探测：一次 GET，过滤新手保护和已标记的岛
  const fakeWorld = {
    client: {
      get: async () => ({
        neighbors: [
          { id: 1, name: '甲' },
          { id: 2, name: '乙', newbie: true },
          { id: 3, name: '丙', marked: true },
        ],
      }),
    },
  }
  const found = await probeStealable(fakeWorld, { social: { steal: { skipMarked: true } } })
  ok('可偷探测过滤新手/标记', found.length === 1 && found[0].id === 1, `${found.length} 家`)
  const noFilter = await probeStealable(fakeWorld, {})
  ok('关掉 skipMarked 时保留标记岛', noFilter.length === 2, `${noFilter.length} 家`)
  const errWorld = { client: { get: async () => { throw new Error('boom') } } }
  ok('探测失败当作没有', (await probeStealable(errWorld, {})).length === 0)
}

console.log('\n[新] 游乐馆求解器')
{
  const A = arcadeRules()
  ok('游乐馆规则已加载', !!A?.GAMES && typeof A.replay === 'function')
  if (A?.GAMES) {
    ok('三种游戏都在', ['bounce', 'pool', 'bowl'].every((g) => A.GAMES[g]))
    const seed = 424242
    for (const g of ['pool', 'bowl']) {
      const shots = solveGame(A, g, seed, { solveMs: 8000 })
      const sc = verifyShots(A, g, seed, shots)
      ok(`${g} 解出的棋谱能本地重放`, typeof sc === 'number', `${sc} 分 / ${shots.length} 杆`)
    }
    // bounce 每甩都从 seed 重建，随机数流只有一份，重放必须一致
    const bs = solveGame(A, 'bounce', seed, { solveMs: 8000 })
    ok('bounce 解出的棋谱能本地重放', typeof verifyShots(A, 'bounce', seed, bs) === 'number',
      `${verifyShots(A, 'bounce', seed, bs)} 分`)
  }
}

console.log('\n[新] 修仙 2.0 规划器')
{
  const now = Math.floor(Date.now() / 1000)
  const xs = X.newXs(now)
  xs.tech = 'fire'; xs.techs = ['fire']; xs.en = 100; xs.stone = 800
  xs.bag = { lingcao: 20, jingu: 10, linglan: 6 }
  xs.pills = { huiling: 3 }
  xs.lv = 5; xs.cv = { r: 1, s: 3, xp: 0 }
  for (const p of xs.plots) if (!p.c) p.s = 'soil'
  const world = { state: { xs }, now }
  const memo = {}
  let okN = 0, bad = []
  for (let round = 0; round < 4; round++) {
    const plan = planXian2Actions(world, now, { memo })
    if (!plan.actions.length) break
    for (const wire of plan.actions) {
      const a = fromWireXsAction(wire)
      const r = a ? X.act(world.state.xs, a, now, () => 0.5) : { ok: false, msg: 'bad wire' }
      if (r?.ok) okN++; else bad.push(`${wire.a}:${r?.msg}`)
    }
  }
  ok('四条路径本地结算全成功', bad.length === 0, `${okN} 个动作${bad.length ? '，首个失败 ' + bad[0] : ''}`)
  ok('秘境跑过至少一次', (world.state.xs.rd?.n || 0) > 0, `rd=${JSON.stringify(world.state.xs.rd || {})}`)
  ok('配招已选出 4 个不同技能', Array.isArray(world.state.xs.sl) && new Set(world.state.xs.sl).size === 4,
    JSON.stringify(world.state.xs.sl))
  ok('绝不产生手动斗法', !['xsFight', 'xsWin', 'xsLose', 'xsRoot', 'xsStory'].some((k) => bad.includes(k)))
}

console.log('\n[新] 游乐馆手操让位')
{
  const { World } = await import('../core/world.mjs')
  const { arcadeRound } = await import('../core/arcade.mjs')
  const now = 1794629000
  let posts = 0
  const mkClient = () => ({
    act: async (rev, actions) => {
      posts++
      return { state: { arc: { cur: null, n: {} } }, rev: rev + 1, out: actions.map(() => ({ ok: true })), coins: 0, now }
    },
    post: async () => { posts++; return { result: {} } },
    world: async () => ({ state: { arc: { cur: null, n: {} } }, rev: 1, coins: 0, now }),
    get: async () => ({}),
  })

  const w = new World(mkClient())
  w.now = now

  // 1) 没有手操局
  w.state = { arc: { cur: null } }
  ok('cur=null 时不算手操', w.manualArcade(now).active === false)

  // 2) 正在手操：cur 存在，t 在 10 秒前
  w.state = { arc: { cur: { g: 'pool', seed: 4242, t: now - 10 } } }
  const ma = w.manualArcade(now)
  ok('cur 存在时判定手操中', ma.active && ma.game === 'pool', `剩 ${ma.remainingSec} 秒`)
  ok('剩余时间 = TTL − 已过', ma.remainingSec === 170, `${ma.remainingSec}`)

  // 3) 写入被拦
  let blocked = null
  try { await w.act([{ a: 'water', i: 0 }]) } catch (e) { blocked = e }
  ok('手操中 act() 抛 ManualArcadeError', blocked?.name === 'ManualArcadeError', blocked?.message)
  ok('拦下时一个请求都没发', posts === 0, `posts=${posts}`)

  // 4) 自己的局放行
  w.ourArcade = { g: 'pool', seed: 4242 }
  let passed = true
  try { await w.act([{ a: 'water', i: 0 }]) } catch { passed = false }
  ok('ourArcade 匹配时放行', passed && posts === 1, `posts=${posts}`)
  w.ourArcade = null

  // 5) seed 不匹配（别人的新局）→ 重新拦
  w.state = { arc: { cur: { g: 'pool', seed: 4242, t: now - 10 } } }
  w.ourArcade = { g: 'pool', seed: 9999 }
  blocked = null
  try { await w.act([{ a: 'water', i: 0 }]) } catch (e) { blocked = e }
  ok('ourArcade 不匹配时仍然让位', blocked?.name === 'ManualArcadeError')
  w.ourArcade = null

  // 6) TTL 过期（Esc 退出没发 arcEnd）
  w.state = { arc: { cur: { g: 'bowl', seed: 1, t: now - 200 } } }
  ok('超过 TTL 自动恢复', w.manualArcade(now).active === false)

  // 7) arcadeRound 整轮跳过
  posts = 0
  w.state = { arc: { cur: { g: 'bounce', seed: 7, t: now - 5 }, n: {} } }
  const r = await arcadeRound(w, { arcade: { enabled: true } }, () => {}, {})
  ok('arcadeRound 手操时跳过', r.played === 0 && posts === 0, `posts=${posts}`)
}

console.log('\n[新] 多波次偷菜')
{
  const { updateIsleSchedule, advanceIsleWave } = await import('../core/steal-schedule.mjs')
  const now = 1794629000
  // 一座岛上的地块分批成熟（同一茬 total=600 秒，保护期 1800 秒）。
  // cropStage 用 stub 而不是线上规则：这里验的是「排几波 / 怎么推进」，与作物表无关。
  const stubR = {
    isleDay: () => '2300-01-01',
    weatherOf: () => 0,
    sprinkled: () => false,
    cropStage: (raw, t) => {
      const total = 600
      const el = t - raw.t
      return el >= total
        ? { stage: 3, left: 0, total }
        : { stage: Math.min(2, Math.floor((el / total) * 3)), left: total - el, total }
    },
    b12StealCost: (_s, _t, spots, base) => Math.min(15, base + Math.max(0, spots - 1)),
    BASE_PRICE: { a: 10000 },
    ANIMALS: [],
  }
  const rules = { protect: 1800, perPlot: 2, perPen: 2, energy: 5, energyMax: 15, fineMax: 5000, perSpot: 1 }
  // matureIn 秒后成熟 → 解禁 = 成熟 + 1800
  const plot = (matureIn) => ({ t: now + matureIn - 600, c: 'a', w: 0, g: 0, h: 0 })
  const mkIsle = (matures) => ({
    isle: {
      plots: matures.map(() => ({ c: 'a', stage: 1, left: 45, steal: false, stolen: 0 })),
      barn: [],
    },
    state: { plots: matures.map(plot), barn: [], tools: { spr: 0 } },
  })
  const base = { R: stubR, rules, now, prices: {}, minEV: 3000, energyValue: 300 }

  // 1) 两块地 45 秒后成熟、一块 200 秒后 → 第二波被排进 rec.waves
  {
    const { isle, state } = mkIsle([45, 45, 200])
    const { rec } = updateIsleSchedule({ ...base, isle, state, ownerLeft: 5, maxWaves: 2 })
    ok('第一波取最早的一组', rec.nextAt === now + 45 + 1800, `nextAt=+${rec.nextAt - now}`)
    ok('排了后续一波', rec.waves.length === 1 && rec.waves[0].entries[0].i === 2,
      `waves=${rec.waves.length}`)
    // 偷完第一波 → 第二波提上来
    const more = advanceIsleWave(rec, now + 45 + 1800, { completedAt: rec.nextAt })
    ok('advanceIsleWave 提升第二波', more && rec.nextAt === now + 200 + 1800 && rec.upcoming[0].i === 2,
      `nextAt=+${rec.nextAt - now}`)
    ok('提升后回访时刻不早于 60 秒', rec.checkAt >= now + 45 + 1800 + 60, `checkAt=+${rec.checkAt - now}`)
    ok('最后一波推进后清空', advanceIsleWave(rec, now + 200 + 1800) === false && !rec.upcoming.length)
  }

  // 2) 失败路径：第一波没偷成（被抢 / 体力不够），sweepStaleUnlocks 等价场景
  {
    const { isle, state } = mkIsle([45, 200])
    const { rec } = updateIsleSchedule({ ...base, isle, state, ownerLeft: 5, maxWaves: 2 })
    const more = advanceIsleWave(rec, now + 45 + 1800 + 30)
    ok('第一波错过后仍能推进', more && rec.nextAt === now + 200 + 1800, `nextAt=+${rec.nextAt - now}`)
  }

  // 3) ownerLeft 封顶：今天只能偷 1 次 → 不排后续波
  {
    const { isle, state } = mkIsle([45, 200])
    const r1 = updateIsleSchedule({ ...base, isle, state, ownerLeft: 1, maxWaves: 2 }).rec
    ok('ownerLeft=1 只排一波', r1.waves.length === 0 && r1.nextAt === now + 45 + 1800)
    const r0 = updateIsleSchedule({ ...base, isle, state, ownerLeft: 0, maxWaves: 2 }).rec
    ok('ownerLeft=0 仍保留第一波（不因字段语义变化整家放弃）', r0.waves.length === 0 && r0.nextAt > 0)
  }

  // 4) maxWaves=3 → 三波（两处 45 秒、200 秒、400 秒）
  {
    const { isle, state } = mkIsle([45, 45, 200, 400])
    const { rec } = updateIsleSchedule({ ...base, isle, state, ownerLeft: 9, maxWaves: 3 })
    ok('maxWaves=3 排两波后续', rec.waves.length === 2, `waves=${rec.waves.length}`)
  }

  // 5) 两波间隔小于 waveGapSec 时跳过中间那组（45 秒与 50 秒算同一批）
  {
    const { isle, state } = mkIsle([45, 45, 50, 200])
    const { rec } = updateIsleSchedule({ ...base, isle, state, ownerLeft: 9, maxWaves: 2, waveGapSec: 20 })
    ok('间隔不足的波次被跳过', rec.waves.length === 1 && rec.waves[0].entries[0].i === 3,
      `i=${rec.waves[0]?.entries?.[0]?.i}`)
  }
}

console.log('\n[新] 修仙1.0 · 药材预留（宗门委托 / 送礼）')
{
  const A = await import('../core/xian-rules.mjs')
  const { computeAlchemyHerbTargets, xsDay } = await import('../core/xian.mjs')
  const now = 1794643200
  const d = xsDay(now)
  const base = A.newXs(now)
  Object.assign(base, { lv: 5, tech: 'fire', techs: ['fire'] })

  // 1) 草药类委托：交完之前不能把货卖掉、也不能只种炼丹够用的量
  {
    const a = computeAlchemyHerbTargets(base, now, {})
    const b = computeAlchemyHerbTargets({ ...base, tk: { d, list: [[0, 0]] } }, now, {})
    // TASK_KINDS[0] = 灵草 ×5
    ok('委托需求进种植计划', b.needHerbs.lingcao === a.needHerbs.lingcao + 5,
      `${a.needHerbs.lingcao} → ${b.needHerbs.lingcao}`)
    ok('委托需求进卖药底仓', b.bagReserve.lingcao === a.bagReserve.lingcao + 5,
      `${a.bagReserve.lingcao} → ${b.bagReserve.lingcao}`)
    // 已经交掉的委托不再算需求
    const c = computeAlchemyHerbTargets({ ...base, tk: { d, list: [[0, 1]] } }, now, {})
    ok('已交的委托不再占底仓', c.bagReserve.lingcao === a.bagReserve.lingcao,
      `${c.bagReserve.lingcao}`)
  }

  // 2) 送礼草药：纯现金药材（赤芝/冰莲/雷竹）也要留一株，否则卖光就送不出礼
  {
    const r = computeAlchemyHerbTargets({ ...base, bag: { chizhi: 1 } }, now, {})
    ok('送礼草药进卖药底仓', (r.socialNeeds.chizhi || 0) >= 1 && (r.bagReserve.chizhi || 0) >= 1,
      JSON.stringify(r.socialNeeds))
    // 赠礼判定用的是不含送礼需求的预留；含了就永远送不出手上唯一那一株
    ok('送礼需求不挡赠礼本身', (r.alchemyAndSectReserve.chizhi || 0) === 0,
      String(r.alchemyAndSectReserve.chizhi))
    // 好感已到 300 的不再预留
    const npc = Object.fromEntries(Object.keys(A.CHAPTERS).map((k) => [k, [300, 0, 0, 0]]))
    const r2 = computeAlchemyHerbTargets({ ...base, bag: { chizhi: 1 }, npc }, now, {})
    ok('好感 300 后不再预留', Object.keys(r2.socialNeeds).length === 0, JSON.stringify(r2.socialNeeds))
    // 今天已经送过的不再预留
    const npc2 = Object.fromEntries(Object.keys(A.CHAPTERS).map((k) => [k, [0, 0, 0, d]]))
    const r3 = computeAlchemyHerbTargets({ ...base, bag: { chizhi: 1 }, npc: npc2 }, now, {})
    ok('今天送过的不再预留', Object.keys(r3.socialNeeds).length === 0, JSON.stringify(r3.socialNeeds))
  }

  // 3) 唤醒模型：精确突破就绪 / 手动秘境让位
  {
    const { nextXianWakeSec, normalizeXianOptions } = await import('../core/xian.mjs')
    // 打坐中、s=8、培元丹够、策略允许突破 → 不该干等 MED_MAX（30 分钟），
    // 而要掐「剩余修为 / 每秒增速」算出的那一刻（这里约 1128 秒）。
    const x = A.newXs(now)
    Object.assign(x, {
      v: 1, st: 4, roots: { e: ['fire'], v: [] }, root: 'fire', tech: 'fire', techs: ['fire'],
      lv: 5, en: 100, med: { t: now - 600 }, cv: { r: 0, s: 8, xp: 0 }, pills: { peiyuan: 1 },
      plots: [], plotN: 0, seeds: {}, bag: {}, stone: 0, log: 0,
    })
    const w = { state: { xs: x }, now }
    const at = nextXianWakeSec(w, now, {}, normalizeXianOptions({ enabled: true, breakMode: 'eager' }))
    ok('精确突破就绪会提前唤醒', at - now < 1200 && at - now > 0, `${at - now} 秒`)
    const atManual = nextXianWakeSec(w, now, {}, normalizeXianOptions({ enabled: true, breakMode: 'manual' }))
    ok('manual 策略不提前唤醒', atManual - now === 1201, `${atManual - now} 秒`)

    // 手动秘境：等到 6 小时窗口结束，而不是每几十秒空转一次
    const x2 = { ...x, med: null, rlm: { a: 'bamboo', sd: 1, L: 0, R: 0, c: 1, hp: 30, mx: 60, lt: {}, t: now - 100 } }
    const at2 = nextXianWakeSec({ state: { xs: x2 }, now }, now, {}, normalizeXianOptions({ enabled: true, autoRealm: false }))
    ok('手动秘境让位后按 2 分钟复查', at2 - now === 120, `${at2 - now} 秒`)
  }
}

console.log('\n[新] 修仙2.0 · 秘境只认通关 / 手动让位 / 配招优先')
{
  const A = await import('../core/xian-rules.mjs')
  const { planXian2Actions } = await import('../core/xian2.mjs')
  const { fromWireXsAction } = await import('../core/xian.mjs')
  const now = 1794643200
  const mk = (over = {}) => {
    const x = A.newXs(now)
    Object.assign(x, {
      tech: 'fire', techs: ['fire'], en: 100, stone: 0, lv: 1, st: 4,
      root: 'fire', roots: { e: ['fire'], v: [] }, cv: { r: 0, s: 1, xp: 0 }, ...over,
    })
    return { state: { xs: x }, now }
  }
  // 重放一批动作，记录「本批主动 rin 的秘境」最后是怎么结束的。
  // 旧实现把战败也当成 finished 候选，beam 会主动挑一条打不过首领的路径——
  // 花了 15 灵力 + 一次额度只带回半个背包。这条断言就是钉死这个回归。
  const replayRealms = (world, actions) => {
    const x = world.state.xs
    const out = []
    let cur = null
    for (const wire of actions) {
      const a = fromWireXsAction(wire)
      if (a.a === 'rin') cur = { fromUs: true }
      const r = A.act(x, a, now, () => 0.99)
      if (r?.end) { out.push({ fromUs: Boolean(cur?.fromUs), end: r.end }); cur = null }
      else if (!r?.ok) return out
    }
    return out
  }

  // 1) 主动进入的秘境必须以通关收尾
  {
    const w = mk()
    const p = planXian2Actions(w, now, { memo: {}, realm: true })
    ok('会主动进秘境', p.actions.some((a) => a.a === 'xsRin'), `动作 ${p.actions.length} 条`)
    const rs = replayRealms(w, p.actions)
    ok('主动进入的秘境全部通关（不选打输/撤出的路径）',
      rs.every((r) => !r.fromUs || r.end === 'win'), JSON.stringify(rs))
    ok('至少通关一次', rs.some((r) => r.end === 'win'), JSON.stringify(rs))
  }

  // 2) 已在秘境里且已经打不过 → 必须 rout，绝不能卡 6 小时
  {
    const w = mk({ rlm: { a: 'bamboo', sd: 123, L: 0, R: 1, c: 1, hp: 1, mx: 60, lt: {}, t: now - 100 } })
    const p = planXian2Actions(w, now, { memo: {}, realm: true })
    ok('残血秘境会撤出', p.actions.some((a) => a.a === 'xsRout'), p.actions.map((a) => a.a).join(','))
  }

  // 3) 手动秘境让位：realm=false 且 6 小时内还在走图
  {
    const w = mk({ rlm: { a: 'bamboo', sd: 123, L: 0, R: 1, c: 1, hp: 40, mx: 60, lt: {}, t: now - 100 } })
    const p = planXian2Actions(w, now, { memo: {}, realm: false })
    ok('手动秘境整批让位', p.actions.length === 0 && p.reason === 'manual-realm-in-progress', p.reason)
    const o = mk({ rlm: { a: 'bamboo', sd: 123, L: 0, R: 1, c: 1, hp: 40, mx: 60, lt: {}, t: now - 6 * 3600 - 10 } })
    const p2 = planXian2Actions(o, now, { memo: {}, realm: false })
    ok('超过 6 小时不再算手操', p2.reason !== 'manual-realm-in-progress', p2.reason)
  }

  // 4) 配招排在秘境之前：秘境束搜索要用最新配招
  {
    const p = planXian2Actions(mk(), now, { memo: {}, realm: true })
    const iSlots = p.actions.findIndex((a) => a.a === 'xsSlots')
    const iRin = p.actions.findIndex((a) => a.a === 'xsRin')
    ok('配招在秘境之前', iSlots === -1 || iRin === -1 || iSlots < iRin, `slots=${iSlots} rin=${iRin}`)
  }

  // 5) 斗法 ↔ 胜利类宗门委托联动
  //    叙话每天 30 次会把一批动作额度吃满，这里先把「今天都聊过」填好，
  //    否则测的就不是斗法而是一屏 xsTalk。
  {
    const { xsDay } = await import('../core/xian.mjs')
    const d = xsDay(now)
    const talked = [...Object.keys(A.CHAPTERS), ...A.OLD_NPCS, ...Object.keys(A.NEW_NPCS)]
    const w = mk({ tk: { d, list: [[5, 0]] }, tw: { d, n: 0 }, ch: { d, ids: talked } })
    const p = planXian2Actions(w, now, { memo: {}, realm: false })
    const iLastAb = p.actions.map((a) => a.a).lastIndexOf('xsAb')
    const iTask = p.actions.findIndex((a) => a.a === 'xsTask')
    ok('斗法后有胜利可交', iLastAb >= 0 && iTask > iLastAb, `ab=${iLastAb} task=${iTask}`)
  }

  // 6) 体力 30（低于重打门槛 40）：有胜利委托时仍要重打，没委托时不打
  {
    const { xsDay } = await import('../core/xian.mjs')
    const d = xsDay(now)
    const talked = [...Object.keys(A.CHAPTERS), ...A.OLD_NPCS, ...Object.keys(A.NEW_NPCS)]
    const wonAll = Object.keys(A.NPC_FIGHT)
    const wTask = mk({ tk: { d, list: [[5, 0]] }, tw: { d, n: 0 }, en: 30, dd: { d, w: wonAll }, ch: { d, ids: talked } })
    const pTask = planXian2Actions(wTask, now, { memo: {}, realm: false })
    ok('有胜利委托时体力 30 也重打', pTask.actions.some((a) => a.a === 'xsAb'),
      pTask.actions.map((a) => a.a).join(','))
    const wNo = mk({ tk: { d, list: [[0, 0]] }, tw: { d, n: 0 }, en: 30, dd: { d, w: wonAll }, ch: { d, ids: talked } })
    const pNo = planXian2Actions(wNo, now, { memo: {}, realm: false })
    ok('没有委托、都赢过、体力 30 → 不重打', !pNo.actions.some((a) => a.a === 'xsAb'),
      pNo.actions.map((a) => a.a).join(','))
  }
}

console.log('\n[新] 站宠护理')
{
  const { petDay, levelOfTotal, totalOfState, applyPetDecay, planPetCare } = await import('../core/pet-care.mjs')
  const now = 1794643200

  // 1) 北京时间自然日：UTC 16:00 = 北京次日 00:00
  ok('petDay 按北京时间切日', petDay(Date.UTC(2026, 10, 13, 16, 0, 0) / 1000) === '2026-11-14')
  ok('petDay 切日前一小时仍是当天', petDay(Date.UTC(2026, 10, 13, 15, 0, 0) / 1000) === '2026-11-13')

  // 2) 等级换算：升到 L+1 需要 L×100（线上 levelOf/totalOf 原文）
  ok('Lv1→Lv2 需要 100 经验', levelOfTotal(99).level === 1 && levelOfTotal(100).level === 2)
  ok('Lv2→Lv3 需要 200 经验', levelOfTotal(299).level === 2 && levelOfTotal(300).level === 3)
  ok('levelOfTotal 与 totalOfState 互逆', totalOfState(levelOfTotal(11694)) === 11694,
    `${JSON.stringify(levelOfTotal(11694))}`)

  // 3) 衰减分档：低等级每小时 饱食2/精力1/清洁1；Lv10 以上减半
  {
    const lo = applyPetDecay({ level: 1, hunger: 50, energy: 50, cleanliness: 50, lastTick: now - 36000 }, now)
    ok('Lv1 十小时衰减 20/10/10', lo.hunger === 30 && lo.energy === 40 && lo.cleanliness === 40,
      `${lo.hunger}/${lo.energy}/${lo.cleanliness}`)
    const hi = applyPetDecay({ level: 10, hunger: 50, energy: 50, cleanliness: 50, lastTick: now - 36000 }, now)
    ok('Lv10 十小时衰减 10/5/5', hi.hunger === 40 && hi.energy === 45 && hi.cleanliness === 45,
      `${hi.hunger}/${hi.energy}/${hi.cleanliness}`)
    ok('不足一小时不结算', applyPetDecay({ level: 1, hunger: 50, energy: 50, cleanliness: 50, lastTick: now - 1800 }, now).hunger === 50)
  }

  const mkPet = (over = {}, prog = {}) => ({
    user_id: 'u1',
    revision: 7,
    state: {
      level: 1, xp: 0, hunger: 50, energy: 50, cleanliness: 50, affection: 10,
      lastTick: now, daily: { day: petDay(now), xp: 0, met: false }, ...over,
    },
    progress: { level: 1, xp: 0, day_xp: 0, cap: 1000, total: 0, ...prog },
  })

  // 4) 没有存档
  ok('无存档时返回 ok:false', planPetCare({}, now).ok === false)
  ok('无存档时零动作', planPetCare({}, now).actions.length === 0)

  // 5) 每日上限已满 → 零动作（不能空发请求）
  {
    const p = planPetCare(mkPet({}, { day_xp: 1000, cap: 1000 }), now)
    ok('经验满时零动作', p.ok && p.actions.length === 0 && p.remaining === 0, `actions=${p.actions.length}`)
  }

  // 6) 服务端 day_xp 是权威：本地 daily.xp 落后也不能超发
  {
    const p = planPetCare(mkPet({ daily: { day: petDay(now), xp: 0, met: true } }, { day_xp: 990 }), now)
    ok('按服务端 day_xp 计算剩余额度', p.remaining === 0 && p.xpGained === 10, `gained=${p.xpGained} left=${p.remaining}`)
  }

  // 7) 正常规划：动作合法、三围不越界、经验不超上限、动作数受限
  {
    const p = planPetCare(mkPet(), now, { maxActions: 60 })
    const s = p.state
    ok('动作数不超过 maxActions', p.actions.length <= 60 && p.actions.length > 0, `n=${p.actions.length}`)
    ok('经验不超每日上限', p.dayXpAfter <= p.cap && p.dayXpAfter === p.dayXpBefore + p.xpGained,
      `${p.dayXpBefore}+${p.xpGained}/${p.cap}`)
    ok('三围始终在 0..100', [s.hunger, s.energy, s.cleanliness].every((v) => v >= 0 && v <= 100),
      `${s.hunger}/${s.energy}/${s.cleanliness}`)
    ok('首见只发生一次', p.actions.filter((a) => a.kind === 'meet').length === 1)
    ok('每步经验都在动作表里', p.actions.every((a) => [20, 12, 8, 4].includes(a.xp)), p.actions.map((a) => a.xp).join(','))
    // 合法性：play 需要精力 >=12，feed 需要饱食 <95，rest 需要精力 <95，clean 需要清洁 <95
    let energy = 50, hunger = 50, clean = 50, legal = true
    for (const a of p.actions) {
      if (a.kind === 'play' && energy < 12) legal = false
      if (a.kind === 'feed' && hunger >= 95) legal = false
      if (a.kind === 'rest' && energy >= 95) legal = false
      if (a.kind === 'clean' && clean >= 95) legal = false
      if (a.kind === 'play') { energy = Math.max(0, energy - 10); hunger = Math.max(0, hunger - 4) }
      if (a.kind === 'feed') hunger = Math.min(100, hunger + 18)
      if (a.kind === 'rest') energy = Math.min(100, energy + 22)
      if (a.kind === 'clean') clean = Math.min(100, clean + 28)
    }
    ok('回放的每个动作在当时都合法', legal)
  }

  // 8) 清洁保底：纯经验最大化会让 clean 永远排在最后，脏到 60 以下必须先清一次
  {
    const p = planPetCare(mkPet({ cleanliness: 10 }), now, { maxActions: 60 })
    const firstCare = p.actions.find((a) => a.kind !== 'meet')
    ok('清洁度过低时先清洁', firstCare?.kind === 'clean', `first=${firstCare?.kind}`)
  }
}

console.log('\n[新] HTTP 重试边界')
{
  const { createClient } = await import('../core/http.mjs')
  const realFetch = globalThis.fetch
  const mkRes = (status, body = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  })
  let calls = 0
  const stub = (fn) => { calls = 0; globalThis.fetch = async (...a) => { calls++; return fn(calls, ...a) } }
  const c = createClient({ baseUrl: 'http://x', cookie: 'c', minGap: 0, timeoutMs: 1000 })
  try {
    // 1) 非幂等 + 网络错误：服务端可能已经执行了，绝不能重发
    stub(() => { throw new Error('ECONNRESET') })
    let err = null
    try { await c.post('/api/pet/battle/chest', {}) } catch (e) { err = e }
    ok('非幂等网络失败不重试', calls === 1 && Boolean(err), `calls=${calls}`)

    // 2) 幂等（带 operation UUID）：服务端会去重，可以安全重发
    stub((n) => { if (n === 1) throw new Error('ECONNRESET'); return mkRes(200, { ok: 1 }) })
    const r = await c.post('/api/pet/world/act', { operation: 'u1', actions: [] })
    ok('带 operation 的网络失败会重试', calls === 2 && r.ok === 1, `calls=${calls}`)

    // 3) 非幂等 + 5xx：同样可能已执行
    stub(() => mkRes(500, { error: 'boom' }))
    err = null
    try { await c.post('/api/pet/world/help', {}) } catch (e) { err = e }
    ok('非幂等 5xx 不重试', calls === 1 && err?.message === 'boom', `calls=${calls}`)

    // 4) 429 是服务端明确拒绝（没执行），任何请求都可以退避重试
    stub((n) => (n === 1 ? mkRes(429, { retry: 1 }) : mkRes(200, { ok: 2 })))
    const r2 = await c.post('/api/pet/world/help', {})
    ok('429 对非幂等也重试', calls === 2 && r2.ok === 2, `calls=${calls}`)

    // 5) GET 不受影响
    stub(() => mkRes(200, { ok: 3 }))
    const r3 = await c.get('/api/pet/world')
    ok('GET 正常返回', r3.ok === 3 && calls === 1, `calls=${calls}`)
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('\n[新] 服务端时钟校准')
{
  const { createClient } = await import('../core/http.mjs')
  const realFetch = globalThis.fetch
  const mkJson = (body) => ({ status: 200, ok: true, text: async () => JSON.stringify(body) })
  // skewSec > 0 表示服务端比本机快
  const clientWithSkew = (skewSec) => {
    const c = createClient({ baseUrl: 'http://x', cookie: 'c', minGap: 0, timeoutMs: 1000 })
    globalThis.fetch = async () => mkJson({ now: Math.floor(Date.now() / 1000) + skewSec, ok: 1 })
    return c
  }
  try {
    // 1) 无样本：偏移为 0（不要凭空猜）
    const c0 = createClient({ baseUrl: 'http://x', cookie: 'c', minGap: 0, timeoutMs: 1000 })
    ok('没有样本时偏移为 0', c0.serverOffsetMs === 0, `offset=${c0.serverOffsetMs}`)

    // 2) 服务端比本机快 5 秒：偏移必须为正且量级对（秒截断最多吃掉 999ms）
    const ahead = clientWithSkew(5)
    await ahead.get('/api/pet/world')
    const dAhead = ahead.estimatedServerNowMs() - Date.now()
    ok('服务端快 5 秒时偏移为正且量级对', dAhead > 3800 && dAhead < 5600, `Δ=${Math.round(dAhead)}ms`)

    // 3) 服务端比本机慢 5 秒：偏移为负；取靠近 0 的端点（宁可早醒，不能晚到）
    const behind = clientWithSkew(-5)
    await behind.get('/api/pet/world')
    const dBehind = behind.estimatedServerNowMs() - Date.now()
    ok('服务端慢 5 秒时偏移为负', dBehind < -3800 && dBehind > -5600, `Δ=${Math.round(dBehind)}ms`)

    // 4) 两边基本同步：区间含 0，偏移归零（避免无意义抖动）
    const synced = clientWithSkew(0)
    await synced.get('/api/pet/world')
    ok('本地与服务端同步时偏移归零', synced.serverOffsetMs === 0, `offset=${synced.serverOffsetMs}`)

    // 5) 秒、毫秒两个版本一致
    const s1 = ahead.estimatedServerNowSec()
    const ms1 = Math.floor(ahead.estimatedServerNowMs() / 1000)
    ok('estimatedServerNowSec 与 ms 版本一致', Math.abs(s1 - ms1) <= 1, `sec=${s1} ms=${ms1}`)
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
