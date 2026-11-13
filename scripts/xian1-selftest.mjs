// 修仙 1.0 规划器回归测试（对应 2026-11-13 的六处修复）。
//
// 只测「看得到的行为」：主修切换、水壶上限、打水时机。
// 打坐系数 / 木主修加速 / 回灵丹阈值这些是纯函数内部量，靠 line-level 对账
// 和 xian-rules 的逐字引用保证，这里不重复造一遍。
import { newXs } from '../core/xian-rules.mjs'
import { planXianActions, xsDay } from '../core/xian.mjs'

let fail = 0
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++ }

// 2026-11-13 12:00 左右（CST）
const t = Date.UTC(2026, 10, 13, 4, 0, 0) / 1000
const mk = (mut) => {
  const xs = structuredClone(newXs(t))
  xs.st = 4
  xs.roots = { e: ['ice', 'fire', 'water', 'poison', 'wind'], v: [] }
  xs.techs = ['ice', 'fire', 'water', 'poison', 'wind']
  xs.tech = null
  xs.te = 0
  xs.lv = 2
  for (const p of xs.plots) if (p.s === 'soil') { p.c = null; delete p.g; delete p.w }
  xs.bag = {}
  xs.pills = {}
  xs.en = 60
  xs.enAt = t
  xs.stone = 500
  if (mut) mut(xs)
  return { now: t, state: { xs } }
}
const act = (w) => planXianActions(w, t, { enabled: true }).actions

console.log('[修仙1.0] 主修切换')
{
  const eq = act(mk((xs) => { xs.bag = { lingcao: 12, jingu: 4 } })).find((a) => a.a === 'xsEquip')
  ok(eq?.el === 'fire', `马上要起炉时换火主修（实际 ${eq?.el || '无'}）`)
}
{
  const eq = act(mk((xs) => { xs.bag = { lingcao: 12, jingu: 4 }; xs.tech = 'poison'; xs.te = xsDay(t) })).find((a) => a.a === 'xsEquip')
  ok(!eq, `当天已经换过主修就不再换（实际 ${eq?.el || '无'}）`)
}
{
  const eq = act(mk((xs) => {
    xs.en = 4
    xs.plots[0] = { s: 'soil', c: 'leizhu', g: 0, w: t }
    xs.tech = 'ice'
  })).find((a) => a.a === 'xsEquip')
  ok(eq?.el === 'wind', `灵力吃紧时换御风诀（实际 ${eq?.el || '无'}）`)
}
{
  const eq = act(mk((xs) => { xs.tech = 'ice' })).find((a) => a.a === 'xsEquip')
  ok(!eq, `不缺丹药也不缺灵力时不乱换主修（实际 ${eq?.el || '无'}）`)
}

console.log('[修仙1.0] 水壶上限')
{
  const noRefill = !act(mk((xs) => { xs.tech = 'water'; xs.can = 25; xs.te = xsDay(t) })).some((a) => a.a === 'xsRefill')
  ok(noRefill, '水主修 can=25 未满（上限 30），不该打水')
}
{
  const refill = act(mk((xs) => {
    xs.tech = null
    xs.can = 0
    xs.plots[0] = { s: 'soil', c: 'lingcao', g: 1, w: 0 }
    xs.te = xsDay(t)
  })).some((a) => a.a === 'xsRefill')
  ok(refill, '水壶为空且有旱地时应该打水')
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过')
process.exit(fail ? 1 : 0)
