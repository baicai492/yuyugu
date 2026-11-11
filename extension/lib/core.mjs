// 一次完整的托管巡视：反复「规划 → 提交 → 用服务端结果重新规划」，再玩 52弟 的五子棋、去邻居家帮忙。
// io 是抽象的服务端接口（真实站点或本地模拟器都实现它），所以同一套逻辑可以先在模拟器里跑。
import { planRound, nextWake, nextRipe } from './strategy.mjs'
import { arenaDaily, stealRound } from './social.mjs'
import { solveGomoku } from './gomoku.mjs'

const fmt = (n) => Math.round(n).toLocaleString('en-US')

function summarize(R, actions, out) {
  const cnt = {}, got = {}, fails = {}
  let earn = 0, spend = 0, tax = 0
  out.forEach((o, k) => {
    const a = actions[k]?.a || '?'
    if (!o?.ok) { const m = a + '：' + (o?.msg || '失败'); fails[m] = (fails[m] || 0) + 1; return }
    cnt[a] = (cnt[a] || 0) + 1
    earn += o.earn || 0; spend += o.spend || 0; tax += o.tax || 0
    for (const g of o.got || []) { const key = (R.ITEM_NAME[g.id] || g.id) + (g.q ? '★'.repeat(g.q) : ''); got[key] = (got[key] || 0) + g.n }
  })
  return { cnt, got, fails, earn, spend, tax }
}
const kv = (o) => Object.entries(o).map(([k, v]) => k + '×' + v).join(' ')

export async function runOnce(io, R, cfg, log, memo = {}) {
  let w = await io.world()
  const start = w.coins
  // 当天账本：所有提交的动作里服务端确认的收入（已扣税）/ 支出 / 税
  const bday = R.worldDay(w.now), book = memo.book?.day === bday ? memo.book : (memo.book = { day: bday, earn: 0, spend: 0, tax: 0 })
  const rawAct = io.act
  io = { ...io, act: async (rev, actions) => { const r = await rawAct(rev, actions); for (const o of r.out || []) if (o?.ok) { book.earn += o.earn || 0; book.spend += o.spend || 0; book.tax += o.tax || 0 } return r } }
  // 防偷：地里留下了小偷记录 → 之后 24 小时自动续守家道具；设了离线时段也续
  if ((w.state.plots || []).some((p) => p?.sv?.length)) memo.stolenAt = w.now
  const hints = () => ({ guard: cfg.defense.guardItems && (cfg.offline.enabled || w.now - (memo.stolenAt || 0) < 86400) })
  let earn = 0, spend = 0
  for (let round = 0; round < cfg.loop.maxRounds; round++) {
    const plan = planRound(R, { ...w, hints: hints() }, cfg)
    for (const n of plan.notes) log(n)
    if (round === 0 && (plan.actions.length || cfg.dry)) {
      const e = plan.eco
      log(`岛日 ${R.isleDayNo(w.now)}（${R.SEASONS[e.season]}·${R.WEATHERS[e.weather]}·${e.hour} 点）D币 ${fmt(w.coins)} 体力 ${w.state.en}/${R.energyMax(w.state)}｜每点体力：钓鱼 ${fmt(e.fishNow.ev / R.WORLD.cost.fish)}（今日最佳 ${fmt(e.vpe.fish)}）挖矿 ${fmt(e.vpe.mine)} 炸矿 ${fmt(e.vpe.bomb)} 口粮成本 ${fmt(e.foodCost)}｜口粮田 ${e.foodPlots}/${w.state.plotN}（${e.food?.c.name || '无'}）经济作物 ${e.cash?.c.name || '无'}`)
    }
    if (!plan.actions.length) break
    if (cfg.dry) { log('[演练] 本轮计划：' + kv(plan.actions.reduce((m, a) => ((m[a.a] = (m[a.a] || 0) + 1), m), {}))); log('[演练] ' + JSON.stringify(plan.actions).slice(0, 1500)); break }
    const res = await io.act(w.rev, plan.actions)
    if (res.conflict) { log('小岛状态在别处变了，按最新状态重新规划'); w = { ...w, ...res.world }; continue }
    w = { ...w, ...res.world }
    const sm = summarize(R, plan.actions, res.out || [])
    earn += sm.earn; spend += sm.spend
    log(`第 ${round + 1} 轮：${kv(sm.cnt) || '无成功动作'}` + (sm.earn ? `｜收入 ${fmt(sm.earn)}` : '') + (sm.tax ? `（已扣税 ${fmt(sm.tax)}）` : '') + (sm.spend ? `｜支出 ${fmt(sm.spend)}` : '') + (Object.keys(sm.got).length ? `｜获得 ${kv(sm.got)}` : ''))
    for (const [m, n] of Object.entries(sm.fails)) log(`  未成功 ${n} 次 → ${m}`)
    if (!Object.keys(sm.cnt).length) break
  }
  if (!cfg.dry) {
    if (cfg.npc.enabled) w = await playNpc(io, R, w, cfg, log)
    if (cfg.help.enabled && io.neighbors) w = await helpNeighbors(io, R, w, cfg, log, memo)
    try { await arenaDaily(io, R, w, cfg, log, memo) } catch (e) { log('擂台日常出错：' + e.message) }
  }
  let stealAt = 0
  if (!cfg.dry) try { const r = await stealRound(io, R, w, cfg, log, memo); w = r.world; stealAt = r.wakeAt } catch (e) { log('偷菜出错：' + e.message) }
  if (w.coins !== start) log(`本次巡视 D币 ${fmt(start)} → ${fmt(w.coins)}（${w.coins >= start ? '+' : ''}${fmt(w.coins - start)}）`)
  let sleep = nextWake(R, w, cfg)
  if (stealAt) sleep = Math.max(5, Math.min(sleep, Math.ceil(stealAt - w.now)))
  return { world: w, sleep, earn, spend, ripeAt: nextRipe(R, w) }
}

// 52弟 玩具摊：每天 52 局，平局不计次数。五子棋赢了奖励 ×1.5，而且能本地算出必胜棋谱。
async function playNpc(io, R, w, cfg, log) {
  // 每日计数在北京时间 0 点清零；快照还停在昨天时按 0 算
  const used = () => (w.state.enDay === R.worldDay(w.now) ? w.state.cnt?.npc || 0 : 0)
  if (used() >= R.NPC.daily) return w
  let seed = null, wins = 0, coins = 0, items = {}, tries = 0
  const startAct = { a: 'npc', g: 'gomoku', k: 'start' }
  while (tries++ < cfg.npc.maxPerVisit * 2 && wins < cfg.npc.maxPerVisit) {
    const actions = []
    const mv = seed != null ? solveGomoku(R, seed) : null
    if (mv) actions.push({ a: 'npc', g: 'gomoku', k: 'end', mv })
    const last = mv && used() + 1 >= R.NPC.daily
    if (!last) actions.push(startAct)
    const res = await io.act(w.rev, actions)
    w = { ...w, ...res.world }
    if (res.conflict) { seed = null; continue }
    const out = res.out || []
    if (mv) {
      const o = out[0]
      if (o?.ok && o.res === 'win') { wins++; coins += o.earn || 0; for (const g of o.got || []) { const k = R.ITEM_NAME[g.id] || g.id; items[k] = (items[k] || 0) + g.n }; if (o.jackpot) log('🎉 52弟 头奖！+' + fmt(o.earn)) }
      else if (!o?.ok) log('  五子棋结算未成功：' + (o?.msg || '未知'))
    }
    const st = out[out.length - 1]
    if (last) break
    if (!st?.ok || st.seed == null) { if (st?.msg && !/玩累了/.test(st.msg)) log('  52弟 开局失败：' + st.msg); break }
    seed = st.seed
  }
  if (wins) log(`52弟 五子棋赢了 ${wins} 局：+${fmt(coins)} D币` + (Object.keys(items).length ? '，' + kv(items) : '') + `（今日 ${used()}/${R.NPC.daily}）`)
  return w
}

// 串门帮忙：每天 10 家、每家 1 次，给少量 D币 和亲密度
async function helpNeighbors(io, R, w, cfg, log, memo) {
  const day = R.worldDay(w.now)
  if (memo.helpDay === day) return w
  if (w.state.en < cfg.help.minEnergy) return w
  let done = 0, coins = 0, cursor = null, stop = false
  for (let page = 0; page < cfg.help.maxPages && !stop; page++) {
    let d
    try { d = await io.neighbors(cursor) } catch (e) { log('  读取邻居失败：' + e.message); return w }
    for (const o of d.neighbors || []) {
      if (!o.canHelp) continue
      try {
        const r = await io.help(o.id)
        const res = r.result || {}
        done++; coins += res.coins || 0
        log(`  帮 ${res.owner || o.name} 干活：${kv(res.done || {}) || '帮了一把'}，+${fmt(res.coins || 0)} D币，亲密度 ${res.aff ?? '?'}，体力 -${res.energy ?? '?'}`)
        if (r.help && !r.help.left?.today) { stop = true; break }
        if ((r.energy ?? 99) < cfg.help.minEnergy) { stop = true; memo.helpPartial = true; break }
      } catch (e) {
        if (/今天|上限|次数/.test(e.message)) { stop = true; break }
        if (/体力/.test(e.message)) { log('  体力不够，稍后再帮忙'); return await io.world() }
      }
      if (done >= cfg.help.perDay) { stop = true; break }
    }
    cursor = d.nextCursor
    if (!cursor) break
  }
  memo.helpDay = day
  if (done) log(`串门帮忙 ${done} 家，共 +${fmt(coins)} D币`)
  return done ? await io.world() : w
}
