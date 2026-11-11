// 擂台日常 + 自动偷菜。都通过 io.api(path, body) 访问站点（模拟器没有 io.api，这两个模块自动跳过）。
import { energyActions } from './strategy.mjs'

const fmt = (n) => Math.round(n).toLocaleString('en-US')
const wait = (io, sec) => (io.sleep ? io.sleep(sec) : new Promise((ok) => setTimeout(ok, sec * 1000)))

// ---------- 擂台日常（不花 D币）：打最低级的对手拿掉落和宝箱，穿最好的装备，属性点加体质 ----------
// 装备和等级决定守家 / 偷菜时的对战胜负。
export async function arenaDaily(io, R, w, cfg, log, memo) {
  if (!io.api || !cfg.arena.enabled) return
  const day = R.worldDay(w.now), m = memo.arena?.day === day ? memo.arena : (memo.arena = { day, n: 0, done: false })
  if (m.done && m.spent) return
  let g = await io.api('/pet/battle/gear')
  if (!g.adopted) { m.done = m.spent = true; return }
  if (!m.spent) { try { g = await arenaSpend(io, g, cfg, log, m) } catch (e) { log('擂台养成出错：' + e.message); m.spent = true } }
  if (m.done) return
  let fought = 0, drops = []
  if (g.daily.battles < cfg.arena.battles) {
    const ops = ((await io.api('/pet/battle/opponents?limit=20&q=')).opponents || []).filter((o) => o.left > 0).sort((a, b) => a.level - b.level)
    for (let k = 0; k < cfg.arena.perVisit && k < ops.length && g.daily.battles + fought < cfg.arena.battles; k++) {
      if (Date.now() / 1000 - (memo.arenaAt || 0) < 8.5) await wait(io, 8.5)
      try {
        const r = await io.api('/pet/battle', { opponent_id: ops[k].id, operation: crypto.randomUUID() })
        memo.arenaAt = Date.now() / 1000; fought++
        if (r.battle?.drop?.item) drops.push(r.battle.drop.item)
      } catch (e) { if (e.status === 429) { memo.arenaAt = Date.now() / 1000; continue } break }
    }
    if (fought) g = await io.api('/pet/battle/gear')
  }
  for (let k = 0; k < 5 && g.daily.ready; k++) { const r = await io.api('/pet/battle/chest', {}); if (r.got?.item) drops.push(r.got.item + (r.got.pity ? '(保底传说)' : '')); g = r.daily ? r : await io.api('/pet/battle/gear') }
  const cat = Object.fromEntries((g.catalog || []).map((c) => [c.id, c]))
  if (cfg.arena.equip) for (const slot of ['weapon', 'armor', 'charm']) {
    const best = (g.items || []).filter((x) => cat[x.id]?.slot === slot).sort((a, b) => cat[b.id].rarity * (1 + 0.13 * b.enh) - cat[a.id].rarity * (1 + 0.13 * a.enh))[0]
    if (best && g.gear?.[slot]?.id !== best.id) { const r = await io.api('/pet/battle/equip', { slot, item: best.id }); if (r.gear) g = r; log(`擂台：换上 ${cat[best.id].name}${best.enh ? ' +' + best.enh : ''}`) }
  }
  if (cfg.arena.points && g.free > 0) { await io.api('/pet/battle/points', { points: { ...g.points, vit: (g.points.vit || 0) + g.free } }); log(`擂台：${g.free} 点属性加到体质`) }
  if (fought || drops.length) log(`擂台日常：打了 ${fought} 场（今日 ${g.daily.battles}/${cfg.arena.battles}），宝箱 ${g.daily.chest}/${g.daily.chestMax}` + (drops.length ? '，获得 ' + drops.map((id) => cat[id.replace(/\(.*/, '')]?.name || id).join('、') : ''))
  if (g.daily.battles >= cfg.arena.battles && !g.daily.ready) m.done = true
}

// 花 D币 养大肥鱼（只影响守家和偷菜的对战，不直接赚钱）：每天 300 点突破训练（1.35 万）、
// 每个槽位买一件史诗装备（4 万；传说不出售，只能靠宝箱和掉落），已穿的装备每天强化若干级。
async function arenaSpend(io, g, cfg, log, m) {
  const on = cfg.arena.spend === true || (cfg.arena.spend === 'auto' && (cfg.steal.enabled || cfg.offline.enabled))
  if (!on) { m.spent = true; return g }
  const p = g.prices, cat = Object.fromEntries(g.catalog.map((c) => [c.id, c])), op = () => ({ operation: crypto.randomUUID() })
  let budget = cfg.arena.dailyBudget - (m.cost || 0)
  const pay = (c) => { budget -= c; m.cost = (m.cost || 0) + c }
  const notes = []
  for (const xp of [300, 200, 100, 50, 10]) {
    while (p.trainDaily - g.daily.trained >= xp) {
      let c = 0; for (let i = g.daily.trained; i < g.daily.trained + xp; i++) c += (p.trainTiers.find(([upTo]) => i < upTo) || p.trainTiers.at(-1))[1]
      if (c > budget || g.coins - c < cfg.invest.reserveCoins) break
      g = await io.api('/pet/battle/train?xp=' + xp, op()); pay(c); notes.push(`训练 +${xp} 经验`)
    }
  }
  const score = (c) => c.rarity * 100 + (c.stats.atk || 0) * 8 + (c.stats.hp || 0) + (c.stats.def || 0) * 6 + (c.stats.agi || 0) * 3 + (c.stats.spd || 0) * 3
  for (const slot of ['armor', 'weapon', 'charm']) {
    const own = Math.max(0, ...g.items.map((x) => (cat[x.id]?.slot === slot ? cat[x.id].rarity : 0)))
    const pick = g.catalog.filter((c) => c.slot === slot && c.rarity === 3 && p.shop[3]).sort((a, b) => score(b) - score(a))[0]
    if (!pick || own >= 3 || p.shop[3] > budget || g.coins - p.shop[3] < cfg.invest.reserveCoins) continue
    g = await io.api('/pet/battle/buy?item=' + pick.id, op()); pay(p.shop[3]); notes.push('买了' + pick.name)
    const r = await io.api('/pet/battle/equip', { slot, item: pick.id }); if (r.gear) g = r
  }
  for (let k = 0; k < 30; k++) { // 先强化等级最低的那件，三件齐头并进
    const worn = Object.values(g.gear || {}).filter((x) => x && x.enh < 10).sort((a, b) => a.enh - b.enh)[0]
    if (!worn) break
    const c = Math.round(p.enhanceBase[worn.enh] * p.enhanceRarity[cat[worn.id].rarity])
    if (c > budget || g.coins - c < cfg.invest.reserveCoins) break
    g = await io.api('/pet/battle/enhance?item=' + worn.id, op()); pay(c); notes.push(`${cat[worn.id].name} +${worn.enh + 1}`)
  }
  if (notes.length) log(`擂台养成（今日已花 ${fmt(m.cost)} D）：${notes.join('，')}`)
  m.spent = true
  return g
}

// ---------- 自动偷菜 ----------
// 规则（来自服务端 rules）：成熟 30 分钟后可偷；每块地最多被偷 2 次；被发现概率基础 55%（35%–75%），
// 被发现要和守家的大肥鱼打一架：赢了每处多拿 1 个，输了什么都拿不到并按货值 1.2 倍赔钱（最多 5000）。
// 别人的脚本在保护期结束后十几秒内就到，所以要提前算好每块地的可偷时刻、掐点去。
const priceOf = (w, R, id) => Number(w.prices?.[id]) || R.BASE_PRICE[id] || 0

function inspect(R, d, w, cfg, me) {
  const t = d.now, s = d.state, weather = R.weatherOf(R.isleDay(t)), rules = d.rules || {}, protect = rules.protect || 1800
  const sack = R.thiefBuff(w.state, 'sack', t) ? 1 : 0
  let nowV = 0, nowN = 0
  const future = [] // { at, v }
  ;(d.isle?.plots || []).forEach((v, i) => {
    const p = s.plots?.[i]
    if (!v || !p) return
    const unit = priceOf(w, R, p.c)
    if (v.steal) { nowV += unit * (1 + sack); nowN++; return }
    if ((v.stolen || 0) >= (rules.perPlot || 2)) return
    const st = R.cropStage(p, t, R.sprinkled(s, i) || weather === 1)
    if (st.stage < 0) return
    const at = Math.ceil(p.t + st.total + protect)
    if (at > t) future.push({ at, v: unit })
  })
  ;(d.isle?.barn || []).forEach((v, i) => { if (v?.steal) { const a = R.ANIMALS.find((x) => x.id === v.k); nowV += priceOf(w, R, a?.product) * (1 + sack); nowN++ } })
  const detect = R.b12Detection(s, w.state, t, 0)
  const pWin = d.owner?.guard ? Math.max(0.03, Math.min(0.95, 0.5 + ((me?.level || 1) - (d.owner.level || 1)) * 0.15)) : 1
  const ev = (V, n) => {
    if (!n) return 0
    const energy = R.b12StealCost(w.state, t, n, rules.energy || 5, rules.perSpot || 1, rules.energyMax || 15)
    const bonus = V / (1 + sack) // 打赢每处多拿 1 个
    const fine = Math.min(rules.fineMax || 5000, V * 1.2)
    return (1 - detect) * V + detect * (pWin * (V + bonus) - (1 - pWin) * fine) - energy * cfg.steal.energyValue
  }
  // 未来：同一批成熟的地（60 秒内）算一组
  future.sort((a, b) => a.at - b.at)
  const groups = []
  for (const f of future) { const g = groups[groups.length - 1]; if (g && f.at - g.at <= 60) { g.v += f.v * (1 + sack); g.n++; g.at = f.at } else groups.push({ at: f.at, v: f.v * (1 + sack), n: 1 }) }
  return { nowV, nowN, nowEV: ev(nowV, nowN), detect, pWin, next: groups.map((g) => ({ at: g.at, n: g.n, ev: ev(g.v, g.n) })).filter((g) => g.ev >= cfg.steal.minEV)[0] || null }
}

async function strike(io, R, w, cfg, log, id, name) {
  const d = await io.api('/pet/world/visit/' + id)
  const me = await myWhale(io)
  const x = inspect(R, d, w, cfg, me)
  if (!x.nowN || x.nowEV < cfg.steal.minEV) return { w, d, x, done: false }
  const cost = R.b12StealCost(w.state, d.now, x.nowN, d.rules.energy, d.rules.perSpot, d.rules.energyMax)
  if ((d.energy ?? w.state.en) < cost) {
    const acts = energyActions(R, w, cfg, cost, cfg.steal.maxEnergyCost)
    if (!acts) { log(`  想偷 ${name} 但体力不够（需要 ${cost}）`); return { w, d, x, done: false } }
    const res = await io.act(w.rev, acts)
    w = { ...w, ...res.world }
  }
  const r = await io.api('/pet/world/visit/' + id, { operation: crypto.randomUUID(), kind: 'all', i: 0 })
  const res = r.result || {}
  const got = (res.items || []).map(([item, n]) => (R.ITEM_NAME[item] || item) + '×' + n).join(' ')
  log(`偷菜 ${res.owner || name}：${res.outcome === 'win' ? (r.battle ? '被发现但打赢了，' : '没被发现，') + '到手 ' + got + '（约 ' + fmt(res.value || 0) + ' D）' : res.outcome === 'lose' ? '被守家大肥鱼打跑' + (res.fine ? '，赔了 ' + fmt(res.fine) + ' D' : '') : '打平，空手而归'}，体力 -${res.energy ?? cost}`)
  if (r.state) w = { ...w, state: r.state, rev: r.rev ?? w.rev }
  return { w: await io.world(), d: { ...d, isle: r.isle || d.isle }, x, done: true, outcome: res.outcome, value: res.value || 0, fine: res.fine || 0 }
}
let whaleCache = null
async function myWhale(io) { if (!whaleCache || Date.now() - whaleCache.at > 600000) { try { whaleCache = { at: Date.now(), me: (await io.api('/pet/battle/home')).me } } catch { whaleCache = { at: Date.now(), me: null } } } return whaleCache.me }

// 返回 { world, wakeAt }：wakeAt 是下一次该来偷的时刻（unix 秒，0 = 没有）
export async function stealRound(io, R, w, cfg, log, memo) {
  if (!io.api || !cfg.steal.enabled) return { world: w, wakeAt: 0 }
  const S = (memo.steal ||= { dirAt: 0, list: {} })
  const now = () => Math.floor(io.now ? io.now() : Date.now() / 1000)
  const avoid = new Set((cfg.steal.avoid || []).map(Number))
  // 1. 定期扫一遍全服目录：24 小时内活跃、过了新手保护的岛才值得盯
  if (now() - S.dirAt > cfg.steal.dirEvery) {
    let cursor = null, seen = 0
    const keep = {}
    for (let page = 0; page < cfg.steal.dirPages; page++) {
      const d = await io.api('/pet/world/neighbors?limit=20&q=' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
      for (const o of d.neighbors || []) {
        seen++
        if (o.newbie || avoid.has(o.id) || (cfg.steal.skipMarked && o.marked) || now() - o.active > 86400) continue
        keep[o.id] = { ...(S.list[o.id] || { check: 0, at: 0 }), name: o.name, level: o.level }
        if (o.canSteal) keep[o.id].check = 0
      }
      cursor = d.nextCursor
      if (!cursor) break
      await wait(io, 0.6)
    }
    S.list = keep; S.dirAt = now()
    log(`偷菜：目录 ${seen} 座岛，盯 ${Object.keys(keep).length} 座活跃的`)
  }
  // 2. 潜行 / 携带道具（24 小时，只在确实有目标时买）
  const buyItems = async () => {
    if (!cfg.steal.items) return
    const acts = []
    if (!R.b12Effect(w.state, 'stealth', w.now)) acts.push({ a: 'buy', id: 'cloak' })
    if (!R.b12Effect(w.state, 'carry', w.now)) acts.push({ a: 'buy', id: 'sack' })
    if (acts.length) { const res = await io.act(w.rev, acts); w = { ...w, ...res.world }; log('偷菜：买了' + acts.map((a) => R.ITEM_NAME[a.id]).join('、')) }
  }
  // 3. 该看的岛看一眼；能偷就偷，不能偷就记下它的下一个可偷时刻
  const due = Object.entries(S.list).filter(([, v]) => v.check <= now()).sort((a, b) => (a[1].at || 9e15) - (b[1].at || 9e15)).slice(0, cfg.steal.visitsPerScan)
  let total = 0, bought = false
  for (const [id, v] of due) {
    try {
      if (v.at && v.at - now() > 0 && v.at - now() <= cfg.steal.prep + 5) await wait(io, v.at - now() + cfg.steal.lead) // 掐点
      if (!bought && v.at && v.at <= now() + 5) { await buyItems(); bought = true }
      const r = await strike(io, R, w, cfg, log, Number(id), v.name)
      w = r.w
      if (r.done) total += r.value - r.fine
      const x = r.done ? inspect(R, { ...r.d, now: now() }, w, cfg, await myWhale(io)) : r.x
      v.at = x.next?.at || 0
      v.check = v.at ? Math.max(now() + 5, Math.min(v.at - cfg.steal.prep, now() + cfg.steal.recheck)) : now() + cfg.steal.recheck
      if (r.done && r.outcome === 'lose') v.check = Math.max(v.check, now() + 3600) // 打不过的这一小时先不去
    } catch (e) { v.check = now() + 600; if (e.status === 429) { await wait(io, 3) } else log(`  访问 ${v.name} 失败：${e.message}`) }
    await wait(io, 0.7)
  }
  if (total) log(`偷菜本轮净收 约 ${fmt(total)} D`)
  const wakeAt = Math.min(...Object.values(S.list).map((v) => v.check).filter(Boolean), Infinity)
  return { world: w, wakeAt: Number.isFinite(wakeAt) ? wakeAt : 0 }
}
