// 自检：不碰账号，验证核心模块是否正常。
// 用法：node scripts/selftest.mjs
import { loadRules, loadRulesCached } from '../core/rules.mjs'
import { solveGomoku, verifyGomoku, playLine } from '../core/gomoku.mjs'
import * as M from '../core/market.mjs'
import { DEFAULTS, mergeConfig } from '../core/config.mjs'

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
}

console.log('\n[5] 配置')
{
  const c = mergeConfig(DEFAULTS, { npc: { gomokuLevel: 2 }, sell: { days: 5 } })
  ok('深度合并', c.npc.gomokuLevel === 2 && c.npc.gomoku === true && c.sell.days === 5)
  ok('默认五子棋参数', c.npc.gomokuLines === 60 && c.npc.gomokuJitter === 0.5)
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
