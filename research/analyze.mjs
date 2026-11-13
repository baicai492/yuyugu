// 用站点规则模块系统计算各项数值，输出 Markdown 表格（research/analysis-tables.md）。
import { writeFileSync } from 'node:fs'
import * as R from '../cache/rules-05a5c445.mjs'
import { fishEV, oreEV, mineHits, bombHits, ISLE_PER_DAY } from '../extension/lib/strategy.mjs'
R.b12ConfigureClock(1794212939)
const W = R.WORLD, out = [], P = (s = '') => out.push(s)
const NOW0 = Math.floor(Date.now() / 1000)
P(`<!-- 生成于 ${new Date().toISOString()}，规则版本 05a5c445，岛日基准 ${R.isleDay(NOW0)} -->`)
const f0 = (n) => Math.round(n).toLocaleString('en-US'), f1 = (n) => n.toFixed(1), f2 = (n) => n.toFixed(2)
const base = (id) => R.BASE_PRICE[id] || 0
const table = (head, rows) => { P('| ' + head.join(' | ') + ' |'); P('|' + head.map(() => ' --- ').join('|') + '|'); for (const r of rows) P('| ' + r.join(' | ') + ' |'); P() }

// ---------- 作物 ----------
P('## 作物（基础价，地块全天不停种，成熟即收）'); P()
const qAvg = (w) => { const g = 0.05 + 0.1 * w, s = 0.2 + 0.08 * w; return g * 1.5 + s * 1.25 + (1 - g - s) }
const yieldN = (w) => 1.3 + 0.08 * w
const cropRow = (c, mode) => { // mode: dry 不浇水 / water 每阶段手动浇 / spr 洒水器
  const tf = mode === 'dry' ? 1 : mode === 'water' ? 0.58 : 0.6, w = mode === 'dry' ? 0 : 3
  const first = c.grow * 60 * 0.8 * tf, again = (c.regrow || 0) * 0.8 * 60 * 0.8 * tf, n = c.times || 1
  const secs = first + again * (n - 1), items = n * yieldN(w)
  const energy = W.cost.plant + n * W.cost.harvest + (mode === 'water' ? 3 * n : 0)
  return { secs, items, cash: (items * c.price * qAvg(w) - c.seed) / secs * 86400, eat: (items * c.eat * qAvg(w) - energy) / secs * 86400, perItemDay: items / secs * 86400 }
}
table(['作物', '季节', '种子', '基础价', '回体力', '首茬/复茬(分)', '茬数', '浇满水整轮(分)', '日净收益/块', '日净体力/块(当口粮)', '洒水器日净收益/块', '不浇水日净收益/块', '日产量/块'],
  R.CROPS.map((c) => { const a = cropRow(c, 'water'), b = cropRow(c, 'spr'), d = cropRow(c, 'dry'); return [c.name, c.seasons.map((s) => R.SEASONS[s]).join(''), c.seed, f0(c.price), c.eat, c.grow + '/' + (c.regrow || '-'), c.times || 1, f0(a.secs / 60), f0(a.cash), f0(a.eat), f0(b.cash), f0(d.cash), f1(a.perItemDay)] }))
P('说明：新种下的作物生长时间 ×0.8（11-07 时间流）；每阶段浇一次水让剩余时间 −25%，三阶段都浇约等于总时间 ×0.58；洒水器 / 雨天固定 ×0.6 且按浇满算品质。'); P()
P('浇水对品质和产量的影响：'); P()
table(['浇水次数', '金星概率', '银星概率', '平均售价倍率', '每次收获个数(期望)', '被偷后个数'], [0, 1, 2, 3].map((w) => [w, f0((0.05 + 0.1 * w) * 100) + '%', f0((0.2 + 0.08 * w) * 100) + '%', f2(qAvg(w)), f2(yieldN(w)), '1.00']))
for (let s = 0; s < 4; s++) { const rows = R.CROPS.filter((c) => c.seasons.includes(s)).map((c) => ({ c, r: cropRow(c, 'water') })); P(`- **${R.SEASONS[s]}季**：赚钱排序 ${rows.slice().sort((a, b) => b.r.cash - a.r.cash).map((x) => x.c.name + ' ' + f0(x.r.cash)).join(' > ')}；口粮排序 ${rows.slice().sort((a, b) => b.r.eat - a.r.eat).map((x) => x.c.name + ' ' + f0(x.r.eat) + '点').slice(0, 3).join(' > ')}`) }
P()

// ---------- 动物 ----------
P('## 动物'); P()
table(['动物', '价格', '产物/基础价', '产出间隔(分)', '窝上限', '成长(岛日)', '成年期(岛日/现实天)', '日产值(约)', '回本(天,含成长)', '一生净赚', '能被偷吗'],
  R.ANIMALS.map((a) => { const adult = R.B12_ADULT_DAYS[a.id], grow = R.B12_GROW_DAYS[a.id], daily = 1440 / a.every * a.productPrice * 1.2 - 150; const adultDays = adult / ISLE_PER_DAY
    return [a.name, f0(a.price), a.productName + ' ' + f0(a.productPrice), a.every, a.cap, grow, adult + ' / ' + f1(adultDays), f0(daily), f1(a.price / daily + grow / ISLE_PER_DAY), f0(daily * adultDays - a.price * 0.6), a.cap >= 2 ? '攒到 2 个起可偷' : '不能（窝里最多 1 个）'] }))
P('喂一次管 24 小时（饲料 150 D），退休后按买价 40% 卖出。畜栏第 n 格扩建价 8 万 × n（3–8 格共 264 万）。'); P()

// ---------- 钓鱼 ----------
P('## 钓鱼（每竿期望，基础价，取该季最佳时段）'); P()
const bestFish = (rod, se, weather) => { let best = { ev: -1 }; for (let h = 0; h < 24; h++) for (const bait of [false, true]) { const ev = fishEV(R, rod, h, se, weather, bait, base); if (ev > best.ev) best = { ev, h, bait } } return best }
const hoursOf = (rod, se, weather, b) => { const hs = []; for (let h = 0; h < 24; h++) if (Math.max(fishEV(R, rod, h, se, weather, false, base), fishEV(R, rod, h, se, weather, true, base)) >= b.ev * 0.97) hs.push(h); return hs.length === 24 ? '全天' : hs[0] + '–' + (hs[hs.length - 1] + 1) + ' 点' }
table(['季节', ...[1, 2, 3, 4].map((r) => '鱼竿 Lv' + r + '（晴）'), '鱼竿 Lv4（雨）', 'Lv4 最佳时段', 'Lv4 用鱼饵？'],
  [0, 1, 2, 3].map((se) => { const b4 = bestFish(4, se, 0); return [R.SEASONS[se], ...[1, 2, 3, 4].map((r) => f0(bestFish(r, se, 0).ev)), f0(bestFish(4, se, 1).ev), hoursOf(4, se, 0, b4), b4.bait ? '用' : '不用'] }))
P(`每岛日 ${W.daily.fish} 竿、每竿 ${W.cost.fish} 体力。岛上 1 小时 = 现实 10 分钟。`); P()
table(['鱼', '基础价', '权重', '需要鱼竿', '季节', '时段(岛上小时)'], R.FISH.map((f) => [f.name, f0(f.price), f.w, 'Lv' + f.rod, f.seasons.map((s) => R.SEASONS[s]).join(''), f.hours[0] === 0 && f.hours[1] === 24 ? '全天' : f.hours[0] + '–' + (f.hours[1] % 24)]))

// ---------- 挖矿 ----------
P('## 挖矿 / 炸矿（每次期望，基础价）'); P()
const floors = [1, 6, 8, 12, 15, 16, 20, 24, 25, 30]
table(['层数', '每块矿石期望', ...[1, 2, 3, 4].map((p) => '镐 Lv' + p + ' 每镐'), '炸矿每块', '镐 Lv4 每次炸矿(净)'], floors.map((f) => [f, f0(oreEV(R, f, 0, false, base)), ...[1, 2, 3, 4].map((p) => (f <= R.PICK_FLOOR[p] ? f0(oreEV(R, f, 0, false, base) * mineHits(p)) : '—')), f0(oreEV(R, f, 0, true, base)), f0(oreEV(R, f, 0, true, base) * bombHits(4) - R.SHOP.bomb.price)]))
let bestF = 1, bestV = 0; for (let f = 1; f <= 30; f++) { const v = oreEV(R, f, 0, false, base); if (v > bestV) { bestV = v; bestF = f } }
P(`最值钱的层：第 ${bestF} 层（每块 ${f0(bestV)}）。逐层：${Array.from({ length: 30 }, (_, i) => (i + 1) + ':' + f0(oreEV(R, i + 1, 0, false, base))).join(' ')}`); P()
P(`镐子可达层数 Lv1–4 = ${R.PICK_FLOOR.slice(1).join(' / ')}。雪天宝石权重 ×1.6：第 30 层每块 ${f0(oreEV(R, 30, 3, false, base))}。每岛日 ${W.daily.mine} 镐（3 体力）+ ${W.daily.bomb} 次炸矿（6 体力，炸药 ${R.SHOP.bomb.price} D）。`); P()
table(['矿石', '基础价', '权重', '最浅层'], R.ORES.map((o) => [o.name, f0(o.price), o.w, o.floor]))

// ---------- 加工 ----------
P('## 加工坊（基础价）'); P()
table(['成品', '配方', '成品价', '原料价合计', '增值', '增值率'], R.RECIPES.filter((r) => r.price).map((r) => { const input = Object.entries(r.in).reduce((x, [id, n]) => x + base(id) * n, 0); return [r.name, Object.entries(r.in).map(([id, n]) => R.ITEM_NAME[id] + '×' + n).join(' + '), f0(r.price), f0(input), f0(r.price - input), f0((r.price / input - 1) * 100) + '%'] }))
P(`每岛日 ${W.daily.craft} 次、每次 1 体力。成品和原料的行情各自独立波动，是否加工要看两边的预测价。`); P()

// ---------- 行情 ----------
P('## 行情波动（往后 98 个岛日 = 28 天，不含供需压价）'); P()
const t0 = Math.floor(Date.now() / 1000), day0 = R.isleDay(t0), dayAdd = (d, k) => new Date(Date.parse(d) + k * 86400000).toISOString().slice(0, 10)
const N = 98, ids = Object.keys(R.BASE_PRICE)
const series = Object.fromEntries(ids.map((id) => [id, Array.from({ length: N }, (_, k) => R.priceOf(id, dayAdd(day0, k), 0) / base(id))]))
const stat = (a) => { const s = a.slice().sort((x, y) => x - y), m = a.reduce((x, y) => x + y, 0) / a.length; return { min: s[0], p25: s[Math.floor(a.length * 0.25)], med: s[Math.floor(a.length / 2)], p75: s[Math.floor(a.length * 0.75)], max: s[a.length - 1], mean: m } }
const timing = (a, H) => { let x = 0, n = 0; for (let i = 0; i + H < a.length; i++) { x += Math.max(...a.slice(i, i + H + 1)); n++ } return x / n }
const groups = { 作物: R.CROPS.map((c) => c.id), 畜产: R.ANIMALS.map((a) => a.product), 鱼: R.FISH.map((f) => f.id), 矿石: R.ORES.map((o) => o.id), 加工品: R.RECIPES.filter((r) => r.price).map((r) => r.id) }
table(['类别', '最低', '25%', '中位', '75%', '最高', '平均', '等 3 岛日内最高', '等 7 岛日内最高', '等 14 岛日内最高'], Object.entries(groups).map(([g, list]) => { const all = list.flatMap((id) => series[id]), s = stat(all), tm = (H) => list.reduce((x, id) => x + timing(series[id], H), 0) / list.length; return [g, ...[s.min, s.p25, s.med, s.p75, s.max, s.mean].map((x) => '×' + f2(x)), ...[3, 7, 14].map((H) => '×' + f2(tm(H)) + '（+' + f0((tm(H) / s.mean - 1) * 100) + '%）')] }))
P('读法：「等 7 岛日内最高」表示任意时刻拿到货后，在接下来 7 个岛日（2 天）里挑最高价卖，平均能卖到基础价的多少倍。'); P()
const adj = ids.map((id) => { const a = series[id]; let x = 0; for (let i = 1; i < a.length; i++) x += Math.abs(a[i] / a[i - 1] - 1); return x / (a.length - 1) })
P(`相邻两个岛日的价格平均变动 ${f1(adj.reduce((x, y) => x + y, 0) / adj.length * 100)}%；98 个岛日里同一物品「最高价 ÷ 最低价」平均为 ${f2(ids.reduce((x, id) => x + Math.max(...series[id]) / Math.min(...series[id]), 0) / ids.length)} 倍。`); P()

P('## 未来 21 个岛日（6 天）的季节、天气和商会事件'); P()
const rows = []
for (let k = 0; k < 21; k++) { const d = dayAdd(day0, k), ev = R.marketEvents(d); const movers = ids.map((id) => ({ id, f: series[id][k] })).sort((a, b) => b.f - a.f)
  rows.push([Date.parse(d) / 86400000 - R.isleIndex(R.ISLE_LAUNCH) + 1, R.SEASONS[R.seasonOf(d)], R.WEATHERS[R.weatherOf(d)], ev.map((e) => e.text + '（×' + e.m + '）').join('；'), movers.slice(0, 3).map((m) => R.ITEM_NAME[m.id] + '×' + f2(m.f)).join(' '), movers.slice(-2).map((m) => R.ITEM_NAME[m.id] + '×' + f2(m.f)).join(' ')]) }
table(['岛日', '季', '天气', '商会事件', '最贵的三样', '最便宜的两样'], rows)

// ---------- 升级 ----------
P('## 一次性投入'); P()
const plotCost = Array.from({ length: W.plotsMax - W.plotsStart }, (_, i) => W.plotPrice(W.plotsStart + 1 + i)).reduce((a, b) => a + b, 0), barnCost = Array.from({ length: W.barnMax - W.barnStart }, (_, i) => W.barnPrice(W.barnStart + 1 + i)).reduce((a, b) => a + b, 0)
table(['项目', '价格', '作用'], [
  ['地块 7–24', f0(plotCost) + '（第 n 块 1 万 × n）', '每块地每天 10–20 万（看季节）'],
  ['鱼竿 Lv2/3/4', W.tools.rod.slice(1).map(f0).join(' / '), '解锁三文鱼鱿鱼 / 金枪鱼河豚 / 迷你鲸，跑鱼率 −4%/级，金星率 +5%/级'],
  ['镐子 Lv2/3/4', W.tools.pick.slice(1).map(f0).join(' / '), '可达 16 / 24 / 30 层，双倍矿概率 +5%/级'],
  ['洒水器 Lv1/2/3', W.tools.spr.map(f0).join(' / '), '前 8 / 16 / 24 块地自动浇水（省体力）'],
  ['小屋 Lv1–5', W.housePrice.map(f0).join(' / '), '体力上限每级 +20'],
  ['蟹笼 ×4', [1, 2, 3, 4].map((n) => f0(W.trapPrice(n))).join(' / '), '每 3 小时 1 条普通小鱼，攒 4 条；风天翻倍'],
  ['畜栏 3–8 格', f0(barnCost) + '（第 n 格 8 万 × n）', '每格多养一只'],
])
writeFileSync(new URL('./analysis-tables.md', import.meta.url), out.join('\n'))
console.log(out.join('\n'))
