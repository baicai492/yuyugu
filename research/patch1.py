"""一次性补丁：把 strategy.mjs 的作物周期改成逐茬模拟（含离线时段与被偷），并更新默认配置。"""
P = 'extension/lib/strategy.mjs'
s = open(P, encoding='utf-8').read()


def cut(a, b):
    i = s.index(a)
    j = s.index(b, i)
    return i, j


# 1) 常量区
i, j = cut("// 收获品质（普通 / 银星 / 金星）", "// ---------- 行情：")
s = s[:i] + "const ORE_CRAFTS_PER_DAY = 90 // 加工坊里留给矿石类配方的次数（估计值）\n\n" + s[j:]

# 2) cropCycle + 离线工具 → 逐茬模拟
i, j = cut("// 一块地种某种作物：能收几茬", "// ---------- 种什么：考虑")
new_cycle = r'''// ---------- 离线时段（浏览器关着的时间）：这段时间里没人收菜，成熟超过 30 分钟保护期的地会被偷 ----------
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

'''
s = s[:i] + new_cycle + s[j:]

# 3) planner 内部：按品质累计产量
pairs = [
    ("    return { c, v0: mk.net(c.id), u: r ? mk.net(r.id) / r.in[c.id] : 0, k: r ? r.in[c.id] : 1, cy: { auto: cropCycle(R, c, t, 'auto'), manual: cropCycle(R, c, t, 'manual'), none: cropCycle(R, c, t, 'none') } }",
     "    return { c, v0: mk.net(c.id), u: r ? mk.net(r.id) / r.in[c.id] : 0, k: r ? r.in[c.id] : 1, cy: { auto: cropCycle(R, cfg, c, t, 'auto'), manual: cropCycle(R, cfg, c, t, 'manual'), none: cropCycle(R, cfg, c, t, 'none') } }"),
    ("  const prod = {} // 作物 → { wet, none }：计划中的日产量\n  const add = (id, mode, sign = 1) => { const x = byId[id]; if (!x) return; const p = (prod[id] ||= { wet: 0, none: 0 }); p[x.cy[mode].wet ? 'wet' : 'none'] += sign * x.cy[mode].items }",
     "  const prod = {} // 作物 → [普通, 银星, 金星]：计划中的日产量\n  const add = (id, mode) => { const x = byId[id]; if (!x) return; const p = (prod[id] ||= [0, 0, 0]); x.cy[mode].items.forEach((n, q) => { p[q] += n }) }"),
    ("      let n = p.wet * QMIX.wet[q] + p.none * QMIX.none[q]\n", "      let n = p[q]\n"),
    ("  // 一块地（按它的浇水方式）种哪种最好；allow 用来过滤（比如离线保护）\n  const best = (mode, allow = () => true) => {\n    let top = null\n    for (const x of crops) {\n      if (!allow(x.c, x.cy[mode])) continue\n      const cy = x.cy[mode], cur = prod[x.c.id] || { wet: 0, none: 0 }, next = { ...cur }\n      next[cy.wet ? 'wet' : 'none'] += cy.items\n",
     "  // 一块地（按它的浇水方式）种哪种最好\n  const best = (mode) => {\n    let top = null\n    for (const x of crops) {\n      const cy = x.cy[mode], cur = prod[x.c.id] || [0, 0, 0], next = cur.map((n, q) => n + cy.items[q])\n"),
]
for a, b in pairs:
    assert a in s, a[:70]
    s = s.replace(a, b)

i, j = cut("  // 口粮：每块地每天净回多少体力", "  return { crops, modeOf, add, best, food }")
s = s[:i] + '''  // 口粮：每块地每天净回多少体力（扣掉自己的农务体力）
  const food = (mode) => {
    let top = null
    for (const x of crops) {
      const cy = x.cy[mode], energy = sum(cy.items.map((n, q) => n * x.c.eat * R.QUALITY[q])) - cy.energy
      if (!top || energy > top.energy) top = { c: x.c, cy, energy, mode }
    }
    return top
  }
''' + s[j:]

pairs = [
    # 动物：设了离线时段时只养偷不走的（窝上限 1 个）
    ("  const animal = R.ANIMALS.map((a) => {",
     "  const animal = R.ANIMALS.filter((a) => !(cfg.offline?.enabled && cfg.defense.safeAnimals) || a.cap === 1).map((a) => {"),
    # 守家道具：由 core 根据「最近是否被偷 / 是否有离线时段」给提示
    ("  if (cfg.defense.guardItems) for (const id of [cfg.defense.alert, cfg.defense.combat]) {",
     "  if (world.hints?.guard) for (const id of [cfg.defense.alert, cfg.defense.combat]) {"),
    ("""  if (cfg.farm.water && eco.weather !== 1) s.plots.forEach((p, i) => {
    if (!p || R.sprinkled(s, i)) return
    const st = R.cropStage(p, t)
    if (st.stage >= 0 && st.stage < 3 && p.w <= st.stage && energize(W.cost.water, FARM)) tryAct({ a: 'water', i })
  })""",
     """  const waterAll = (i) => { // 落下的阶段可以补浇：每浇一次剩余时间 -25%，收获品质和个数按浇水次数算
    for (let k = 0; k < 3; k++) {
      const p = s.plots[i], st = p && R.cropStage(p, t)
      if (!p || !(st.stage >= 0 && st.stage < 3 && p.w <= st.stage) || !energize(W.cost.water, FARM) || !tryAct({ a: 'water', i })) break
    }
  }
  if (cfg.farm.water && eco.weather !== 1) for (let i = 0; i < s.plotN; i++) if (s.plots[i] && !R.sprinkled(s, i)) waterAll(i)"""),
    ("""  const planner = eco.newPlanner(), foodCrop = eco.food?.c.id
  // 离线保护：只种「每一茬成熟时都有人在线收」的作物（成熟后 30 分钟内别人偷不了）
  const allow = cfg.offline?.enabled ? (c, cy) => cycleSafe(cfg, t, cy) : () => true
""", "  const planner = eco.newPlanner(), foodCrop = eco.food?.c.id\n"),
    ("""  let skipped = 0
  s.plots.forEach((p, i) => {
    if (p || i >= s.plotN) return
    const mode = planner.modeOf(i)
    const f = foodGrowing < needFood ? planner.food(mode, allow) : null
    const pick = f && f.energy > 0 ? f : planner.best(mode, allow)
    if (!pick) { skipped++; return }
    if (pick !== f && !(pick.value > 0)) return""",
     """  s.plots.forEach((p, i) => {
    if (p || i >= s.plotN) return
    const mode = planner.modeOf(i)
    const f = foodGrowing < needFood ? planner.food(mode) : null
    const pick = f && f.energy > 0 ? f : planner.best(mode)
    if (!pick || (pick !== f && !(pick.value > 0))) return"""),
    ("      if (mode === 'manual' && energize(W.cost.water, FARM)) tryAct({ a: 'water', i })\n    }\n  })\n  if (skipped) notes.push(`离线保护：${skipped} 块地暂不播种（现在种什么都会在离线时段里成熟并过保护期）`)\n",
     "      if (mode === 'manual') waterAll(i)\n    }\n  })\n"),
]
for a, b in pairs:
    assert a in s, a[:70]
    s = s.replace(a, b)
left = [k for k in ('QMIX', 'cycleSafe', 'ripeSafe', 'TIME[', 'YIELD[') if k in s]
assert not left, left
open(P, 'w', encoding='utf-8', newline='\n').write(s)

P = 'extension/lib/defaults.mjs'
s = open(P, encoding='utf-8').read()
i = s.index("  // 防偷：")
j = s.index("}\nexport function mergeConfig")
s = s[:i] + '''  // 防偷：成熟即收是主防线（成熟后 30 分钟内别人偷不了）；下面这些是给「没法及时收」的情况兜底
  defense: { guardItems: true, alert: 'guard1', combat: 'guard2', protect: 1800, safeAnimals: true, keepAwake: true },
  offline: { enabled: false, from: '01:00', to: '08:30' }, // 每天浏览器关着的时段（北京时间）：种地计划会避开在这段时间里成熟
  // 擂台日常（不花 D币）：打低级对手拿装备和宝箱、自动穿最好的装备 → 守家和偷菜的对战更能打
  arena: { enabled: true, battles: 30, perVisit: 5, equip: true, points: true },
  // 自动偷菜（默认关）：盯着别人的地，保护期一结束就去偷
  steal: { enabled: false, minEV: 3000, dirEvery: 7200, dirPages: 60, visitsPerScan: 30, recheck: 1800, prep: 15, lead: 1, window: 10, items: true, itemMinV: 6000, maxEnergyCost: 600, skipMarked: true, avoid: [] },
''' + s[j:]
open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('patched')
