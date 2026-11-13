// 修仙 2.0 规划器自检：造一个存档，连跑几批（和 engine 的 maxBatches 一样），
// 每批都本地结算，验证「计划里的动作服务端都会接受」。
// 用法：node scripts/xian2-selftest.mjs
import * as A from '../core/xian-rules.mjs'
import { fromWireXsAction } from '../core/xian.mjs'
import { planXian2Actions, nextXian2WakeSec, xian2Snapshot } from '../core/xian2.mjs'

const now = Math.floor(Date.now() / 1000)
const xs = A.newXs(now)
xs.tech = 'fire'
xs.techs = ['fire']
xs.en = 100
xs.stone = 800
xs.bag = { lingcao: 20, jingu: 10, linglan: 6, chizhi: 4, binglian: 3 }
xs.pills = { huiling: 3, peiyuan: 2 }
xs.lv = 5
xs.cv = { r: 1, s: 3, xp: 0 }
xs.npc = { '52d': [95, 0, 0, 0], sup: [95, 0, 0, 0], wheat: [90, 0, 0, 0] }
for (const p of xs.plots) if (!p.c) p.s = 'soil'

const world = { state: { xs }, now }
const memo = {}
let totalOk = 0, totalFail = 0
for (let round = 0; round < 6; round++) {
  const plan = planXian2Actions(world, now, { memo })
  if (!plan.actions.length) { console.log(`第 ${round + 1} 轮：无动作（${plan.reason}）`); break }
  let ok = 0, fail = []
  for (const wire of plan.actions) {
    const a = fromWireXsAction(wire)
    let r
    try { r = A.act(world.state.xs, a, now, () => 0.5) } catch (e) { r = { ok: false, msg: e.message } }
    if (r?.ok) ok++
    else fail.push(`${wire.a} → ${r?.msg}`)
  }
  totalOk += ok
  totalFail += fail.length
  const names = {}
  for (const w of plan.actions) names[w.a] = (names[w.a] || 0) + 1
  console.log(`第 ${round + 1} 轮：${ok}/${plan.actions.length} 成功  ${Object.entries(names).map(([k, v]) => k + '×' + v).join(' ')}`)
  for (const f of fail) console.log('   失败', f)
}
console.log(`合计：${totalOk} 成功 / ${totalFail} 失败`)
const x = world.state.xs
console.log('状态：stone', x.stone, 'en', x.en, 'rep', x.rep || 0, 'mat', JSON.stringify(x.mat || {}),
  'pills', JSON.stringify(x.pills), 'slots', JSON.stringify(x.sl))
console.log('秘境：', x.rlm ? `在 ${x.rlm.a} L${x.rlm.L}` : '无', '今日 rd', JSON.stringify(x.rd || {}))
console.log('快照：', JSON.stringify(xian2Snapshot(world)))
console.log('下次唤醒：', nextXian2WakeSec(world, now) - now, '秒后')
