// 鱼鱼谷托管策略：纯函数，不做网络请求。
// 输入服务端世界快照（state / coins / prices / now），输出本轮要提交的动作（最多 40 个）。
// 所有动作先用站点的规则模块 R.applyActions 在本地副本上预演一遍，只提交预演通过的。
const clone = (x) => structuredClone(x)
const sum = (a) => a.reduce((x, y) => x + y, 0)
const dayAdd = (day, k) => new Date(Date.parse(day) + k * 86400000).toISOString().slice(0, 10)
export const ISLE_PER_DAY = 3.5 // 每天 08:00–22:00 共 14 小时白昼 ÷ 4 小时一个岛日
const ORE_CRAFTS_PER_DAY = 90 // 加工坊里留给矿石类配方的次数（估计值）

// ---------- 行情：价格是确定性随机游走，可以直接算出未来若干岛日的价格 ----------
export function makeMarket(R, prices, t, coins, cfg) {
  const today = R.isleDay(t), H = cfg.sell.horizonIsleDays, cache = new Map()
  const taxRate = coins >= R.B12_TAX.high ? 0.03 : coins >= R.B12_TAX.free ? 0.01 : 0
  const series = (id) => {
    if (cache.has(id)) return cache.get(id)
    const now = Number(prices[id]) || 0, ref = R.priceOf(id, today, 0)
    // 实际价 ÷ 无供给压力的理论价 = 当前供需系数，假设未来几天维持（略保守）
    const ratio = ref > 0 && now > 0 ? Math.max(0.75, Math.min(0.97, now / ref)) : 0.95
    const arr = [now]
    for (let k = 1; k <= H; k++) arr.push(Math.round(R.priceOf(id, dayAdd(today, k), 0) * ratio))
    cache.set(id, arr)
    return arr
  }
  const best = (id) => (R.BASE_PRICE[id] ? Math.max(...series(id)) : 0)
  // 长期资产（动物、工具）不能按这两天的行情高点估值：用基础价 × 长期平均「择时卖出」系数
  const longRun = (id) => (R.BASE_PRICE[id] || 0) * cfg.price.longRun * (1 - taxRate)
  return { today, taxRate, series, best, longRun, now: (id) => Number(prices[id]) || 0, net: (id) => best(id) * (1 - taxRate) }
}

// ---------- 各项活动的期望收益 ----------
export function fishEV(R, rod, hour, season, weather, bait, val) {
  const pool = R.FISH.filter((f) => f.rod <= rod && f.seasons.includes(season) && ((hour >= f.hours[0] && hour < f.hours[1]) || (hour + 24 >= f.hours[0] && hour + 24 < f.hours[1])))
  if (!pool.length) return 0
  const miss = Math.max(0.05, 0.22 - 0.04 * rod - (bait ? 0.08 : 0) - (weather === 1 ? 0.05 : 0))
  const boost = (bait ? 2 : 1) * (weather === 1 ? 1.5 : 1)
  const w = pool.map((f) => f.w * (f.price >= 9000 ? boost : 1)), tw = sum(w)
  const ev = sum(pool.map((f, i) => w[i] * val(f.id))) / tw
  const gold = 0.08 + 0.05 * rod, silver = (1 - gold) * 0.28
  return (1 - miss) * ev * (gold * 1.5 + silver * 1.25 + (1 - gold - silver)) - (bait ? R.SHOP.bait.price : 0)
}
export function oreEV(R, floor, weather, bomb, val) {
  const pool = R.ORES.filter((o) => o.floor <= floor)
  const w = pool.map((o) => o.w * (bomb && o.price >= 7000 ? 1.35 : 1) * (o.price >= 12000 && weather === 3 ? 1.6 : 1) * (1 + (floor - o.floor) / 40))
  return sum(pool.map((o, i) => w[i] * val(o.id))) / sum(w)
}
export const mineHits = (pick) => 1.25 + 0.05 * pick
export const bombHits = (pick) => 6 + 2 * (0.3 + 0.05 * pick)

// ---------- 离线时段（浏览器关着的时间）：这段时间里没人收菜，成熟超过 30 分钟保护期的地会被偷 ----------
export function offlineWindow(cfg, time) { // 返回包含 time 的离线时段 [开始, 结束]（unix 秒），不在离线时段返回 null
  if (!cfg.offline?.enabled) return null
  const parse = (v) => { const [h, m] = String(v).split(':').map(Number); return (h * 60 + (m || 0)) * 60 }
  const from = parse(cfg.offline.from), to = parse(cfg.offline.to)
  if (!(from >= 0) || !(to >= 0) || from === to) return null
  const local = time + 8 * 3600, day0 = Math.floor(local / 86400) * 86400
  for (const d of [day0 - 86400, day0]) { const a = d + from, b = d + (to > from ? to : to + 86400); if (local >= a && local < b) return [a - 8 * 3600, b - 8 * 3600] }
  return null
}

// 一块地现在种下某种作物，逐茬模拟到收完：什么时候熟、浇了几次水、会不会在离线时段里熟（熟了没人收 = 地闲着，
// 超过保护期还会被偷：被偷过的地每次固定只收 1 个）。返回按「每天」折算的产量（分品质）、种子钱和农务体力。
// mode：auto = 洒水器 / 雨天；manual = 每阶段手动浇水（在线才浇得到）；none = 不浇
export function cropCycle(R, cfg, crop, t, mode) {
  const W = R.WORLD, items = [0, 0, 0], times = crop.regrow ? crop.times || 1 : 1
  let time = t, n = 0, waters = 0, opsE = W.cost.plant, stolen = 0, first = 0
  for (let h = 0; h < times; h++) {
    const base = (h > 0 ? crop.regrow * 0.8 : crop.grow) * 60 * 0.8
    let total = base, w = 0
    if (mode === 'auto') { total = base * 0.6; w = 3 }
    else if (mode === 'manual') {
      let g = 0, cur = time
      for (let k = 0; k < 12; k++) {
        total = base - g
        const el = cur - time
        if (el >= total) break
        const stage = Math.min(2, Math.floor((el / total) * 3)), off = offlineWindow(cfg, cur)
        if (!off && w <= stage) { g += Math.floor((total - el) * 0.25); w++; waters++; continue }
        const next = Math.min(stage < 2 ? time + Math.ceil((total * (stage + 1)) / 3) : Infinity, off ? off[1] : Infinity)
        if (!(next < time + total)) break
        cur = Math.max(next, cur + 1)
      }
      total = base - g
    }
    const ripe = time + total, off = offlineWindow(cfg, ripe + 60)
    const at = off ? off[1] : ripe, taken = at - ripe > cfg.defense.protect
    const y = taken ? 1 : 1.3 + 0.08 * w, gold = 0.05 + 0.1 * w, silver = 0.2 + 0.08 * w
    items[0] += y * (1 - gold - silver); items[1] += y * silver; items[2] += y * gold
    if (taken) stolen++
    n++; opsE += W.cost.harvest
    if (!h) first = at - t
    time = at
    if (h + 1 < times && !crop.seasons.includes(R.seasonOf(R.isleDay(time)))) { opsE += W.cost.clear; break }
  }
  opsE += waters * W.cost.water
  const secs = Math.max(1, time - t), perDay = 86400 / secs
  return { n, secs, first, stolen, items: items.map((x) => x * perDay), seed: crop.seed * perDay, energy: opsE * perDay, waters: waters * perDay }
}

// ---------- 种什么：考虑「同种作物每天前 150 个全价、之后 85% / 70%」、加工坊容量和农务体力 ----------
// 把每种作物一天的产量按品质拆开，依次填进最值钱的去向（全价直卖 / 加工 / 85% / 70%），算出总收入；
// 一块新地种某种作物的价值 = 多出来的那部分收入 − 种子 − 农务体力折价。
function cropPlanner(R, s, t, mk, cfg, weather, foodCost) {
  const season = R.seasonOf(R.isleDay(t)), TIERS = R.CROP_TIERS
  const modeOf = (i) => (R.sprinkled(s, i) || weather === 1 ? 'auto' : cfg.farm.water ? 'manual' : 'none')
  const crops = R.CROPS.filter((c) => c.seasons.includes(season)).map((c) => {
    const rs = cfg.craft.enabled ? R.RECIPES.filter((r) => r.price && Object.keys(r.in).length === 1 && r.in[c.id]) : []
    const r = rs.sort((a, b) => mk.net(b.id) / b.in[c.id] - mk.net(a.id) / a.in[c.id])[0]
    return { c, v0: mk.net(c.id), u: r ? mk.net(r.id) / r.in[c.id] : 0, k: r ? r.in[c.id] : 1, cy: { auto: cropCycle(R, cfg, c, t, 'auto'), manual: cropCycle(R, cfg, c, t, 'manual'), none: cropCycle(R, cfg, c, t, 'none') } }
  })
  const byId = Object.fromEntries(crops.map((x) => [x.c.id, x]))
  const prod = {} // 作物 → [普通, 银星, 金星]：计划中的日产量
  const add = (id, mode) => { const x = byId[id]; if (!x) return; const p = (prod[id] ||= [0, 0, 0]); x.cy[mode].items.forEach((n, q) => { p[q] += n }) }
  const crafts = Math.max(0, R.WORLD.daily.craft * ISLE_PER_DAY - (cfg.mine.enabled ? ORE_CRAFTS_PER_DAY : 0))
  const revenue = (x, p, slots) => {
    let ti = 0, tierLeft = TIERS[0][0], craftLeft = slots * x.k, rev = 0, crafted = 0
    for (const q of [2, 1, 0]) {
      let n = p[q]
      while (n > 1e-6) {
        const raw = x.v0 * R.QUALITY[q] * TIERS[ti][1], useCraft = q < 2 && craftLeft > 1e-6 && x.u > raw
        const take = Math.min(n, useCraft ? craftLeft : tierLeft)
        if (useCraft) { rev += take * x.u; craftLeft -= take; crafted += take }
        else { rev += take * raw; tierLeft -= take; if (tierLeft <= 1e-6 && ti < TIERS.length - 1) { ti++; tierLeft = TIERS[ti][0] - TIERS[ti - 1][0] } }
        n -= take
      }
    }
    return { rev, slots: crafted / x.k }
  }
  const slotsFor = (id) => Math.max(0, crafts - sum(crops.filter((x) => x.c.id !== id && prod[x.c.id]).map((x) => revenue(x, prod[x.c.id], crafts).slots)))
  // 一块地（按它的浇水方式）种哪种最好
  const best = (mode) => {
    let top = null
    for (const x of crops) {
      const cy = x.cy[mode], cur = prod[x.c.id] || [0, 0, 0], next = cur.map((n, q) => n + cy.items[q])
      const slots = slotsFor(x.c.id)
      const value = revenue(x, next, slots).rev - revenue(x, cur, slots).rev - cy.seed - cy.energy * foodCost
      if (!top || value > top.value) top = { c: x.c, cy, value, mode }
    }
    return top
  }
  // 口粮：每块地每天净回多少体力（扣掉自己的农务体力）
  const food = (mode) => {
    let top = null
    for (const x of crops) {
      const cy = x.cy[mode], energy = sum(cy.items.map((n, q) => n * x.c.eat * R.QUALITY[q])) - cy.energy
      if (!top || energy > top.energy) top = { c: x.c, cy, energy, mode }
    }
    return top
  }
  return { crops, modeOf, add, best, food }
}

// ---------- 经济快照：这一刻每种活动值多少、体力值多少、该留几块地种口粮 ----------
export function economy(R, s, t, mk, cfg) {
  const day = R.isleDay(t), season = R.seasonOf(day), weather = R.weatherOf(day), hour = R.isleHour(t)
  const val = (id) => mk.net(id), C = R.WORLD.cost, D = R.WORLD.daily
  // 钓鱼：本岛日剩余时段里哪个小时最好
  const fishAt = (h) => { const a = fishEV(R, s.tools.rod, h, season, weather, false, val), b = fishEV(R, s.tools.rod, h, season, weather, true, val); return b > a ? { ev: b, bait: true } : { ev: a, bait: false } }
  const fishNow = fishAt(hour)
  let fishBest = fishNow.ev
  for (let h = hour + 1; h < 24; h++) fishBest = Math.max(fishBest, fishAt(h).ev)
  const floor = Math.max(1, Math.min(s.mine.max, R.PICK_FLOOR[s.tools.pick]))
  const mineEV = oreEV(R, floor, weather, false, val) * mineHits(s.tools.pick)
  const bombEV = oreEV(R, floor, weather, true, val) * bombHits(s.tools.pick) - R.SHOP.bomb.price
  const canDeeper = s.mine.max < R.PICK_FLOOR[s.tools.pick]
  const vpe = { fish: fishBest / C.fish, mine: mineEV / C.mine, bomb: bombEV / C.bomb }

  // 口粮成本 = 一块地拿去种经济作物能赚的钱 ÷ 它种口粮能回的体力；和「种什么」互相依赖，迭代两次
  let foodCost = 200, planner, cash, food
  const defMode = cfg.farm.water ? 'manual' : 'none'
  for (let k = 0; k < 2; k++) {
    planner = cropPlanner(R, s, t, mk, cfg, weather, foodCost)
    // 现有地块（在长的照算，空地按最优填上）之后，再多一块地值多少 = 一块地的边际价值
    s.plots.forEach((p, i) => { if (i >= s.plotN) return; if (p) planner.add(p.c, planner.modeOf(i)); else { const b = planner.best(planner.modeOf(i)); if (b && b.value > 0) planner.add(b.c.id, b.mode) } })
    cash = planner.best(defMode); food = planner.food(defMode)
    foodCost = cash && food && food.energy > 0 ? Math.max(20, Math.min(2000, cash.value / food.energy)) : 9999
  }
  // 体力需求（点 / 天）：值得做的活动 + 农务 − 自然回复
  let isleE = D.craft * 0.6
  if (cfg.fish.enabled && vpe.fish > foodCost * 1.1) isleE += D.fish * C.fish
  if (cfg.mine.enabled && vpe.mine > foodCost * 1.1) isleE += D.mine * C.mine
  if (cfg.mine.bomb && (vpe.bomb > foodCost * 1.1 || canDeeper)) isleE += D.bomb * C.bomb
  const farmE = cash ? s.plotN * cash.cy.energy : 0
  const demand = isleE * ISLE_PER_DAY + farmE - (86400 / R.WORLD.regen) * 0.9
  const foodPlots = food && food.energy > 0 ? Math.max(0, Math.min(s.plotN, Math.ceil(demand / food.energy))) : 0
  return { day, season, weather, hour, val, foodCost, fishNow, fishBest, floor, mineEV, bombEV, canDeeper, vpe, demand, foodPlots, cash, food, planner, newPlanner: () => cropPlanner(R, s, t, mk, cfg, weather, foodCost) }
}

// ---------- 投资：估算每项升级的日增收益，只买回本期够短的 ----------
export function investOptions(R, s, coins, mk, eco, cfg) {
  const W = R.WORLD, lr = (id) => mk.longRun(id), out = []
  const add = (k, act, cost, gain, delay = 0, extra) => { if (cost != null && gain > 0) out.push({ k, act, cost, gain: Math.round(gain), payback: cost / gain + delay, extra }) }
  if (s.plotN < W.plotsMax) { const m = eco.planner.best(eco.planner.modeOf(s.plotN)); if (m) add('开垦第 ' + (s.plotN + 1) + ' 块地', { a: 'expand', k: 'plot' }, W.plotPrice(s.plotN + 1), m.value) }
  // 鱼竿：四季各取最佳时段的期望
  const fishBest = (rod) => sum([0, 1, 2, 3].map((se) => Math.max(...Array.from({ length: 24 }, (_, h) => Math.max(fishEV(R, rod, h, se, 0, false, lr), fishEV(R, rod, h, se, 0, true, lr)))))) / 4
  const rodP = R.upgradePrice(s, 'rod')
  if (rodP != null && cfg.fish.enabled) add('鱼竿 Lv' + (s.tools.rod + 1), { a: 'upgrade', k: 'rod' }, rodP, (fishBest(s.tools.rod + 1) - fishBest(s.tools.rod)) * W.daily.fish * ISLE_PER_DAY)
  const pickP = R.upgradePrice(s, 'pick')
  if (pickP != null && cfg.mine.enabled) {
    const dayOre = (p) => oreEV(R, R.PICK_FLOOR[p], 0, false, lr) * mineHits(p) * W.daily.mine + (cfg.mine.bomb ? oreEV(R, R.PICK_FLOOR[p], 0, true, lr) * bombHits(p) * W.daily.bomb : 0)
    add('镐子 Lv' + (s.tools.pick + 1), { a: 'upgrade', k: 'pick' }, pickP, (dayOre(s.tools.pick + 1) - dayOre(s.tools.pick)) * ISLE_PER_DAY)
  }
  // 洒水器：省下覆盖地块的浇水体力（小屋只加体力上限，脚本从不让体力攒满，不买）
  const sprP = R.upgradePrice(s, 'spr')
  if (sprP != null && cfg.farm.water && eco.cash) {
    const covered = Math.max(0, Math.min(s.plotN, W.sprCover[s.tools.spr + 1]) - W.sprCover[s.tools.spr])
    add('洒水器 Lv' + (s.tools.spr + 1), { a: 'upgrade', k: 'spr' }, sprP, covered * eco.cash.cy.waters * Math.min(eco.foodCost, 600))
  }
  if (s.traps.length < W.trapMax) {
    const avg = sum([0, 1, 2, 3].map((se) => fishEV(R, 1, 12, se, 0, false, lr) / 0.82 / 1.2)) / 4 // 蟹笼只出普通品质、不会跑鱼
    add('蟹笼 #' + (s.traps.length + 1), { a: 'buyTrap' }, W.trapPrice(s.traps.length + 1), avg * (1440 / W.trapEvery) * 1.15)
  }
  // 动物：按「整个成年期净赚 ÷ 总天数」挑最好的一种
  const animal = R.ANIMALS.filter((a) => !(cfg.offline?.enabled && cfg.defense.safeAnimals) || a.cap === 1).map((a) => {
    const adultDays = R.B12_ADULT_DAYS[a.id] / ISLE_PER_DAY, growDays = R.B12_GROW_DAYS[a.id] / ISLE_PER_DAY
    const daily = (1440 / a.every) * lr(a.product) * 1.2 - R.SHOP.feed.price
    return { a, daily, growDays, life: (daily * adultDays - a.price * 0.6) / (adultDays + growDays) }
  }).sort((x, y) => y.life - x.life)[0]
  if (animal && animal.life > 0) {
    if (s.barn.length < s.barnN) add('买' + animal.a.name, { a: 'buyAnimal', k: animal.a.id }, animal.a.price, animal.daily, animal.growDays)
    else if (s.barnN < W.barnMax) add('扩建畜栏到 ' + (s.barnN + 1) + ' 格（含一只' + animal.a.name + '）', { a: 'expand', k: 'barn' }, W.barnPrice(s.barnN + 1) + animal.a.price, animal.daily, animal.growDays, { first: W.barnPrice(s.barnN + 1) })
  }
  return out.sort((a, b) => a.payback - b.payback)
}

// 可以吃的口粮，按「每点体力少卖多少钱」从便宜到贵
function foodList(R, stock, mk) {
  const rows = []
  for (const c of R.CROPS) for (let q = 0; q < 3; q++) {
    const n = stock[c.id]?.[q] || 0
    if (n > 0) { const e = Math.round(c.eat * R.QUALITY[q]); rows.push({ id: c.id, q, e, n, per: Math.max(mk.now(c.id), mk.best(c.id) * 0.9) * R.QUALITY[q] * (1 - mk.taxRate) / e }) }
  }
  return rows.sort((a, b) => a.per - b.per)
}
const stockOf = (state) => {
  const vault = state.b12?.vault || {}, stock = {}
  for (const [id, qs] of Object.entries(state.inv || {})) stock[id] = [0, 1, 2].map((q) => Math.max(0, (qs[q] || 0) - (vault[id]?.[q] || 0)))
  return stock
}

// 给串门偷菜等「规划之外」的开销凑体力：返回要提交的吃 / 喝动作（凑不够返回 null）
export function energyActions(R, world, cfg, need, maxPerE) {
  const s = clone(world.state), t = world.now
  R.refresh(s, t)
  const mk = makeMarket(R, world.prices || {}, t, world.coins, cfg), stock = stockOf(world.state), acts = []
  let en = s.en
  for (const f of foodList(R, stock, mk)) {
    if (f.per > maxPerE) break
    for (let k = 0; k < f.n && en < need && acts.length < 30; k++) { if (en + f.e > R.energyMax(s)) break; acts.push({ a: 'eat', id: f.id, q: f.q }); en += f.e }
    if (en >= need) break
  }
  let coffee = s.cnt.coffee || 0
  while (en < need && cfg.energy.coffee && coffee < R.WORLD.daily.coffee && R.WORLD.coffee.price / R.WORLD.coffee.energy <= maxPerE) { acts.push({ a: 'coffee' }); en += R.WORLD.coffee.energy; coffee++ }
  return en >= need ? acts : null
}

// ---------- 规划一轮动作 ----------
export function planRound(R, world, cfg) {
  const t = world.now, prices = world.prices || {}, W = R.WORLD
  let s = clone(world.state), coins = world.coins
  R.refresh(s, t)
  const mk = makeMarket(R, prices, t, coins, cfg)
  let eco = economy(R, s, t, mk, cfg)
  const acts = [], notes = []
  let bytes = 80, full = false
  const tryAct = (a) => {
    if (full) return null
    const size = JSON.stringify(a).length + 1
    if (acts.length >= W.maxActions || bytes + size > 3700) { full = true; return null }
    const snap = clone(s)
    const r = R.applyActions(s, [a], { t, day: R.worldDay(t), rand: () => 0.5, prices, coins })
    const o = r.out[0]
    if (!o || !o.ok) { s = snap; return null }
    coins += r.earn - r.spend; acts.push(a); bytes += size
    return o
  }
  // 只消耗服务端已确认的库存（本轮预演里「可能收到」的东西不算）
  const stock = stockOf(world.state)
  const have = (id, q = 0) => stock[id]?.[q] || 0
  const total = (id) => sum(stock[id] || [0])
  const reserveCoins = cfg.invest.reserveCoins
  const foods = () => foodList(R, stock, mk)

  // 体力不够就吃口粮（挑「每点体力最便宜」的），再不行喝咖啡
  const energize = (cost, vpe) => {
    while (s.en < cost) {
      const f = foods().find((x) => x.per < vpe * 0.9 && s.en + x.e <= R.energyMax(s))
      if (f) { if (!tryAct({ a: 'eat', id: f.id, q: f.q })) return false; stock[f.id][f.q]--; continue }
      if (cfg.energy.coffee && (s.cnt.coffee || 0) < W.daily.coffee && W.coffee.price / W.coffee.energy < vpe * 0.9 && coins - W.coffee.price >= Math.min(reserveCoins, 50000)) { if (!tryAct({ a: 'coffee' })) return false; continue }
      return false
    }
    return true
  }
  const FARM = 1e9 // 农务几乎不花体力、收益极高（晚收还会被偷），体力不够时无条件吃口粮

  // 1. 各种领取；守家道具到期续上
  if (R.b12GuardRefundQuote(s) > 0) tryAct({ a: 'guardRefund' })
  if ((s.lotto || []).some((tk) => tk.d < R.lottoDrawId(t))) tryAct({ a: 'lottoClaim' })
  const night = R.b12NightView(s, t)
  if (night.claimable) tryAct({ a: 'nightClaim', key: night.key })
  const goals = R.dailyGoals(R.worldDay(t), s)
  goals.forEach((g, k) => { if (g && !s.cnt['goal' + k] && (s.cnt[g.id] || 0) >= g.n) tryAct({ a: 'goal', k }) })
  if (goals.length && !s.cnt.goal4 && goals.every((g, k) => s.cnt['goal' + k])) tryAct({ a: 'goal', k: 4 })
  if (world.hints?.guard) for (const id of [cfg.defense.alert, cfg.defense.combat]) {
    const item = R.GUARD_ITEMS[id]
    if (!item) continue
    const cur = R.b12Effect(s, item.slot, t)
    if ((!cur || (cur.id === id && cur.until - t < 1800)) && coins - item.price >= Math.min(reserveCoins, 20000) && tryAct({ a: 'buy', id })) notes.push(`防偷：${item.name}已续 24 小时（${item.price} D）`)
  }

  // 2. 蟹笼、牧场（产物有 1 个就收：窝里攒到 2 个才会被偷）
  s.traps.forEach((tr, i) => { if (R.trapReady(tr, t, eco.weather === 2).n) tryAct({ a: 'trap', i }) })
  s.barn.forEach((pen, i) => { if (R.animalReady(pen, t).ready && energize(0, FARM)) tryAct({ a: 'collect', i }) })
  if (s.barn.length) {
    const hungry = s.barn.map((pen, i) => (!R.b12AnimalStage(pen, t).retired && t - pen.f >= 8 * 3600 ? i : -1)).filter((i) => i >= 0)
    const lack = hungry.length - (s.inv.feed?.[0] || 0)
    if (lack > 0) tryAct({ a: 'buy', id: 'feed', n: Math.max(12, lack) })
    for (const i of hungry) if (energize(W.cost.feed, FARM)) tryAct({ a: 'feed', i, includeWarehouse: false })
    s.barn.forEach((pen, i) => { if (!R.b12AnimalStage(pen, t).retired && !s.cnt['pet' + i]) tryAct({ a: 'pet', i }) })
    // 退休且收完的动物卖掉腾位置（一轮只卖一只，避免下标错位）
    const old = s.barn.findIndex((pen) => R.b12AnimalStage(pen, t).retired && !R.animalReady(pen, t).ready)
    if (old >= 0) tryAct({ a: 'sellAnimal', i: old })
  }

  // 3. 农田：收、清、浇
  const stolen = []
  s.plots.forEach((p, i) => {
    if (!p) return
    const auto = R.sprinkled(s, i) || eco.weather === 1, st = R.cropStage(p, t, auto)
    if (st.stage === 3) { if (energize(W.cost.harvest, FARM) && tryAct({ a: 'harvest', i }) && p.sv?.length) stolen.push(p.c) }
    else if (st.stage === -1) { if (energize(W.cost.clear, FARM)) tryAct({ a: 'clear', i }) }
  })
  if (stolen.length) notes.push(`⚠ 有 ${stolen.length} 块地在收获前被偷过（${[...new Set(stolen)].map((id) => R.ITEM_NAME[id]).join('、')}），每块少收 1 个`)
  const waterAll = (i) => { // 落下的阶段可以补浇：每浇一次剩余时间 -25%，收获品质和个数按浇水次数算
    for (let k = 0; k < 3; k++) {
      const p = s.plots[i], st = p && R.cropStage(p, t)
      if (!p || !(st.stage >= 0 && st.stage < 3 && p.w <= st.stage) || !energize(W.cost.water, FARM) || !tryAct({ a: 'water', i })) break
    }
  }
  if (cfg.farm.water && eco.weather !== 1) for (let i = 0; i < s.plotN; i++) if (s.plots[i] && !R.sprinkled(s, i)) waterAll(i)

  // 4. 投资（先买回本最快的，买完重算）
  if (cfg.invest.enabled) for (let k = 0; k < 12 && !full; k++) {
    const opt = investOptions(R, s, coins, mk, eco, cfg).find((o) => o.payback <= cfg.invest.maxPaybackDays && coins - o.cost >= reserveCoins)
    if (!opt || !tryAct(opt.act)) break
    notes.push(`投资：${opt.k}，花费 ${opt.extra?.first ?? opt.cost}，预计日增 ${opt.gain}，约 ${opt.payback.toFixed(1)} 天回本`)
    eco = economy(R, s, t, mk, cfg)
  }

  // 5. 播种：口粮库存越少、留的口粮田越多；其余按「多种这一块能多赚多少」逐块挑
  const foodE = sum(foods().map((f) => f.e * f.n))
  const lo = cfg.food.reserveE, hi = Math.max(lo + 1, cfg.food.maxStockE)
  const needFood = Math.ceil(eco.foodPlots * Math.max(0, Math.min(1, 1 - (foodE - lo) / (hi - lo))))
  const planner = eco.newPlanner(), foodCrop = eco.food?.c.id
  let foodGrowing = 0
  s.plots.forEach((p, i) => { // 已经在长的：前 needFood 块口粮作物算口粮，其余计入当天的销售产量
    if (!p || R.cropStage(p, t).stage < 0) return
    if (p.c === foodCrop && foodGrowing < needFood) foodGrowing++
    else planner.add(p.c, planner.modeOf(i))
  })
  s.plots.forEach((p, i) => {
    if (p || i >= s.plotN) return
    const mode = planner.modeOf(i)
    const f = foodGrowing < needFood ? planner.food(mode) : null
    const pick = f && f.energy > 0 ? f : planner.best(mode)
    if (!pick || (pick !== f && !(pick.value > 0))) return
    const seedFree = (s.inv['sd_' + pick.c.id]?.[0] || 0) > 0
    if (!seedFree && coins - pick.c.seed < Math.min(reserveCoins, 20000)) return
    if (!energize(W.cost.plant, FARM)) return
    if (tryAct({ a: 'plant', i, c: pick.c.id, includeWarehouse: false })) {
      if (pick === f) foodGrowing++; else planner.add(pick.c.id, mode)
      if (mode === 'manual') waterAll(i)
    }
  })

  // 6. 用体力换钱：炸矿 / 钓鱼 / 挖矿，按每点体力的收益从高到低
  const left = (k) => W.daily[k] - R.isleCount(s, k, t)
  const boundaryIn = R.b12NextIsleBoundary(t) - t
  const fishOK = eco.fishNow.ev >= eco.fishBest * cfg.fish.windowRatio || (!R.b12IsLongNight(t) && boundaryIn < cfg.fish.deadlineSec)
  const jobs = [
    { k: 'bomb', vpe: eco.canDeeper ? Math.max(eco.vpe.bomb, eco.foodCost * 2) : eco.vpe.bomb, on: cfg.mine.bomb },
    { k: 'fish', vpe: eco.fishNow.ev / W.cost.fish, on: cfg.fish.enabled && fishOK },
    { k: 'mine', vpe: eco.vpe.mine, on: cfg.mine.enabled },
  ].filter((j) => j.on && j.vpe > 0).sort((a, b) => b.vpe - a.vpe)
  // 防偷：40 分钟内要成熟的地，先把收获的体力留出来（没口粮可吃时才需要）
  const ripeSoon = s.plots.filter((p, i) => { if (!p) return false; const st = R.cropStage(p, t, R.sprinkled(s, i) || eco.weather === 1); return st.stage >= 0 && st.stage < 3 && st.left < 2400 }).length
  const keep = Math.max(0, ripeSoon * W.cost.harvest - Math.floor(foodE / 2))
  let regenBudget = Math.floor(Math.max(0, boundaryIn - 600) / W.regen)
  for (const j of jobs) {
    let n = left(j.k)
    if (n <= 0) continue
    if (j.k === 'bomb') {
      const lack = n - (s.inv.bomb?.[0] || 0)
      if (lack > 0 && coins - lack * R.SHOP.bomb.price >= Math.min(reserveCoins, 50000)) tryAct({ a: 'buy', id: 'bomb', n: lack })
      n = Math.min(n, s.inv.bomb?.[0] || 0)
    }
    if (j.k === 'fish' && eco.fishNow.bait) {
      const lack = n - (s.inv.bait?.[0] || 0)
      if (lack > 0 && coins - lack * R.SHOP.bait.price >= Math.min(reserveCoins, 50000)) tryAct({ a: 'buy', id: 'bait', n: Math.min(99, lack) })
    }
    // 挖矿 / 炸矿没有时段限制：换岛日前自然回复够用的那部分不吃口粮，等体力自己回上来（长夜里也不浪费回复）
    const cost = W.cost[j.k], lazyN = j.k === 'fish' ? 0 : Math.min(n, Math.floor(regenBudget / cost))
    regenBudget -= lazyN * cost
    for (; n > 0 && !full; n--) {
      if (n <= lazyN ? s.en < cost + keep : !energize(cost + keep, j.vpe)) break
      const a = j.k === 'fish' ? { a: 'fish', bait: eco.fishNow.bait && (s.inv.bait?.[0] || 0) > 0, includeWarehouse: false } : j.k === 'mine' ? { a: 'mine', f: 99 } : { a: 'bomb', f: 99, includeWarehouse: false }
      if (!tryAct(a)) break
    }
  }

  // 7. 口粮预留：最便宜的口粮先留够，不拿去加工和卖
  const reserved = {}
  if (eco.demand > 0) { let need = cfg.food.reserveE; for (const f of foods()) { if (need <= 0) break; const n = Math.min(f.n, Math.ceil(need / f.e)); (reserved[f.id] ||= [0, 0, 0])[f.q] = n; need -= n * f.e } }
  const free = (id, q) => Math.max(0, have(id, q) - (reserved[id]?.[q] || 0))

  // 8. 加工：成品预期卖价明显高于原料才做；只动普通和银星，金星留着直接卖
  const recipes = R.RECIPES.filter((r) => r.price).map((r) => {
    const input = sum(Object.entries(r.in).map(([id, n]) => mk.best(id) * n))
    return { r, profit: mk.best(r.id) - input, input }
  }).filter((x) => x.profit > x.input * cfg.craft.minMargin).sort((a, b) => b.profit - a.profit)
  if (cfg.craft.enabled) for (const { r, profit } of recipes) {
    while (!full) {
      const n = Math.min(20, left('craft'), ...Object.entries(r.in).map(([id, k]) => Math.floor((free(id, 0) + free(id, 1)) / k)))
      if (n <= 0 || !energize(W.cost.craft * n, profit * (1 - mk.taxRate) / W.cost.craft)) break
      if (!tryAct({ a: 'craft', id: r.id, n, includeWarehouse: false })) break
      for (const [id, k] of Object.entries(r.in)) { let need = k * n; for (let q = 0; q < 3 && need > 0; q++) { const m = Math.min(need, have(id, q)); stock[id][q] -= m; need -= m } }
    }
  }

  // 9. 卖货：当前价接近未来若干岛日的最高价才卖，否则囤着
  // 加工完还凑得齐一份的原料，说明只是被本岛日加工次数卡住了，留到下个岛日
  const craftable = new Set(recipes.filter((x) => Object.entries(x.r.in).every(([id, k]) => free(id, 0) + free(id, 1) >= k)).flatMap((x) => Object.keys(x.r.in)))
  if (cfg.sell.enabled) for (const id of Object.keys(stock)) {
    if (!R.BASE_PRICE[id] || !(mk.now(id) > 0)) continue
    if (mk.now(id) < mk.best(id) * cfg.sell.ratio) continue
    const isCrop = R.CROPS.some((c) => c.id === id)
    for (let q = 2; q >= 0 && !full; q--) {
      let n = free(id, q)
      // 还能加工增值的原料（普通 / 银星）留给加工坊，除非囤得太多
      if (cfg.craft.enabled && craftable.has(id) && q < 2 && total(id) < cfg.craft.hoardMax) continue
      if (isCrop) { const fullLeft = R.cropFullLeft(s, id), sold = s.cnt['sc_' + id] || 0; n = Math.min(n, total(id) > cfg.sell.tier2Above ? Math.max(fullLeft, R.CROP_TIERS[1][0] - sold) : fullLeft) }
      n = Math.min(n, 999)
      if (n > 0 && tryAct({ a: 'sell', id, q, n })) stock[id][q] -= n
    }
  }

  // 10. 货船：按基础价进货。预期能高价卖出的套利；比自己种口粮便宜的菜也买来吃
  let foodHave = foodE
  if (cfg.cargo.enabled) for (const it of R.b12Stock(t, prices)) {
    const n = R.b12StockLeft(s, it, t)
    if (n <= 0 || !R.BASE_PRICE[it.id] || coins - it.price * n < reserveCoins) continue
    const crop = R.CROPS.find((c) => c.id === it.id)
    const arbitrage = mk.net(it.id) > it.price * (1 + cfg.cargo.minMargin)
    const food = crop && eco.demand > 0 && foodHave < cfg.food.maxStockE && it.price / crop.eat < Math.min(eco.foodCost, Math.max(eco.vpe.mine, eco.vpe.fish) * 0.5)
    if ((arbitrage || food) && tryAct({ a: 'stockBuy', id: it.id, n, day: mk.today }) && crop) foodHave += n * crop.eat
  }

  return { actions: acts, notes, eco, coins, state: s }
}

// 下次该什么时候醒：最近的一个「有事可做」的时刻
export function nextWake(R, world, cfg) {
  const s = world.state, t = world.now, weather = R.weatherOf(R.isleDay(t))
  let at = Math.min(t + cfg.loop.maxSleep, R.b12NextIsleBoundary(t) + 3)
  const hit = (x) => { if (x > t && x < at) at = x }
  s.plots.forEach((p, i) => {
    if (!p) return
    const auto = R.sprinkled(s, i) || weather === 1, st = R.cropStage(p, t, auto)
    if (st.stage < 0 || st.stage >= 3) return
    hit(auto || !cfg.farm.water || st.stage === 2 ? p.t + st.total + 2 : p.t + Math.ceil(st.total * (st.stage + 1) / 3) + 2)
  })
  s.barn.forEach((pen) => { const st = R.animalReady(pen, t); if (!st.ready && st.fed && st.stage >= 2 && st.left) hit(t + st.left + 2); hit(pen.f + 8 * 3600 + 2) })
  s.traps.forEach((tr) => { const st = R.trapReady(tr, t, weather === 2); if (!st.n) hit(t + st.left + 2) })
  // 钓鱼看岛上的小时（现实 10 分钟一格）：还有竿数没用时，每到整点醒一次，最佳时段一开始就下竿
  if (cfg.fish.enabled && !R.b12IsLongNight(t) && R.isleCount(s, 'fish', t) < R.WORLD.daily.fish) hit(t + 600 - (R.b12ClockSeconds(t) % 600) + 2)
  return Math.max(cfg.loop.minSleep, Math.ceil(at - t))
}

// 最近一块地成熟的时刻（弹窗里显示「防偷」状态用）；没有在长的作物返回 0
export function nextRipe(R, world) {
  const s = world.state, t = world.now, weather = R.weatherOf(R.isleDay(t))
  let at = 0
  s.plots.forEach((p, i) => { if (!p) return; const st = R.cropStage(p, t, R.sprinkled(s, i) || weather === 1); if (st.stage >= 0 && st.stage < 3 && (!at || t + st.left < at)) at = Math.ceil(t + st.left) })
  return at
}
