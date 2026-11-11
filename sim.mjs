// 本地模拟器：用站点的规则模块当「服务端」，让托管逻辑在虚拟时间里跑若干天，估算收益、验证策略。
// 用法：node sim.mjs [天数=7] [起始D币=20608229] [--no-invest] [--payback=10] [--quiet]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { runOnce } from './extension/lib/core.mjs'
import { DEFAULTS, mergeConfig } from './extension/lib/defaults.mjs'

const args = process.argv.slice(2), flag = (k) => args.find((a) => a.startsWith('--' + k))
const nums = args.filter((a) => !a.startsWith('--')).map(Number)
const days = nums[0] || 7, startCoins = nums[1] || 20608229
const cfg = mergeConfig(DEFAULTS, JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8')))
if (flag('no-invest')) cfg.invest.enabled = false
if (flag('payback')) cfg.invest.maxPaybackDays = Number(flag('payback').split('=')[1])
if (flag('reserve')) cfg.invest.reserveCoins = Number(flag('reserve').split('=')[1])
if (flag('horizon')) cfg.sell.horizonIsleDays = Number(flag('horizon').split('=')[1])
if (flag('ratio')) cfg.sell.ratio = Number(flag('ratio').split('=')[1])
if (flag('no-cargo')) cfg.cargo.enabled = false
const quiet = !!flag('quiet')

const file = readdirSync(new URL('./cache/', import.meta.url)).filter((f) => /^rules-.*\.mjs$/.test(f)).map((f) => ({ f, m: statSync(new URL('./cache/' + f, import.meta.url)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f
const R = await import(new URL('./cache/' + file, import.meta.url))
const CLOCK = 1794212939
R.b12ConfigureClock(CLOCK)

let now = Date.parse('2026-11-10T15:00:00+08:00') / 1000
const state = R.newWorld(now); state.gift = now; state.b12 = { v: 1, vault: {}, keep: {}, guardVersion: 1, storySeed: 4088739963 }
let coins = startCoins, rev = 1, posts = 0
const book = {}
// 供需：上一个岛日的卖出量（自己卖的 + 假设其他玩家固定卖掉基础库存的一部分）会压低今天的价格
const others = flag('others') ? Number(flag('others').split('=')[1]) : 0.2
const soldBy = {}
const pricesAt = (t) => { const prev = soldBy[R.isleIndex(t) - 1] || {}; return Object.fromEntries(Object.keys(R.BASE_PRICE).map((id) => [id, R.priceOf(id, R.isleDay(t), (prev[id] || 0) + others * R.marketDepth(id))])) }
const snapshot = () => { R.refresh(state, now); return { state: structuredClone(state), rev, coins, prices: pricesAt(now), now } }
const io = {
  world: async () => snapshot(),
  act: async (r, actions) => {
    now += 2.3; posts++
    if (r !== rev) return { conflict: true, world: snapshot() }
    const res = R.applyActions(state, actions, { t: now, day: R.worldDay(now), rand: Math.random, prices: pricesAt(now), coins })
    coins += res.earn - res.spend; rev++
    res.out.forEach((o, k) => { if (o.ok && actions[k].a === 'sell') { const m = (soldBy[R.isleIndex(now)] ||= {}); m[actions[k].id] = (m[actions[k].id] || 0) + (actions[k].n || 1) } })
    res.out.forEach((o, k) => { if (!o.ok) return; const a = actions[k], key = a.a + (a.a === 'sell' || a.a === 'stockBuy' || a.a === 'buy' ? ':' + a.id : a.a === 'npc' ? ':' + a.g : ''); const b = (book[key] ||= { n: 0, earn: 0, spend: 0 }); b.n += a.n || 1; b.earn += o.earn || 0; b.spend += o.spend || 0 })
    return { out: res.out, world: snapshot() }
  },
}

const stockValue = () => Object.entries(state.inv).reduce((v, [id, qs]) => v + qs.reduce((x, n, q) => x + n * (R.BASE_PRICE[id] || 0) * R.QUALITY[q], 0), 0)
const fmt = (n) => Math.round(n).toLocaleString('en-US')
const end = now + days * 86400
let lastDay = R.worldDay(now), dayStart = coins, dayStock = stockValue(), ticks = 0
let taxDay = R.worldDay(now - 8 * 3600), taxPaid = 0
const daily = []
const log = (m) => { if (!quiet) console.log(new Date((now + 8 * 3600) * 1000).toISOString().slice(5, 16).replace('T', ' ') + ' ' + m) }
console.log(`模拟 ${days} 天，起始 ${fmt(coins)} D币，投资 ${cfg.invest.enabled ? '开（回本 ≤ ' + cfg.invest.maxPaybackDays + ' 天）' : '关'}`)
while (now < end) {
  const r = await runOnce(io, R, cfg, log, {})
  ticks++
  now += r.sleep
  // 余额税：每天北京时间 08:00 结算（300 万–1000 万 0.1%，超过 1000 万 0.3%）
  const td = R.worldDay(now - 8 * 3600)
  if (td !== taxDay) { taxDay = td; const tax = R.b12BalanceTax(coins); coins -= tax; taxPaid += tax }
  const d = R.worldDay(now)
  if (d !== lastDay) {
    const sv = stockValue()
    console.log(`[${lastDay}] D币 ${fmt(coins)}（当日 ${coins >= dayStart ? '+' : ''}${fmt(coins - dayStart)}）｜库存按基础价 ${fmt(sv)}（${sv >= dayStock ? '+' : ''}${fmt(sv - dayStock)}）｜地 ${state.plotN} 畜 ${state.barn.length}/${state.barnN} 笼 ${state.traps.length} 竿 ${state.tools.rod} 镐 ${state.tools.pick} 洒 ${state.tools.spr} 屋 ${state.tools.house} 矿层 ${state.mine.max}`)
    daily.push({ day: lastDay, total: coins + sv, season: R.SEASONS[R.seasonOf(R.isleDay(now - 3600))] })
    lastDay = d; dayStart = coins; dayStock = sv
  }
}
console.log(`结束：D币 ${fmt(coins)}，库存按基础价 ${fmt(stockValue())}，合计相对起始 ${fmt(coins + stockValue() - startCoins)}；巡视 ${ticks} 次，提交 ${posts} 次`)
if (flag('book')) for (const [k, b] of Object.entries(book).filter(([, b]) => b.earn || b.spend).sort((x, y) => (y[1].earn - y[1].spend) - (x[1].earn - x[1].spend))) console.log(k.padEnd(22), 'n=' + String(b.n).padStart(6), '收入 ' + fmt(b.earn).padStart(12), '支出 ' + fmt(b.spend).padStart(11))
if (daily.length > 2) { const rows = daily.slice(1).map((x, i) => ({ day: x.day, season: x.season, gain: x.total - daily[i].total })); const g = rows.map((r) => r.gain).sort((a, b) => a - b); console.log('第 2 天起每日净增（D币+库存）：' + rows.map((r) => r.day.slice(5) + r.season + ' ' + (r.gain / 1e4).toFixed(0) + '万').join('，')); console.log(`平均 ${fmt(g.reduce((a, b) => a + b, 0) / g.length)}，中位 ${fmt(g[Math.floor(g.length / 2)])}，最低 ${fmt(g[0])}，最高 ${fmt(g[g.length - 1])}；累计余额税 ${fmt(taxPaid)}`) }
