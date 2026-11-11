def sub(p, pairs):
    s=open(p,encoding='utf-8').read()
    for a,b in pairs:
        assert a in s,(p,a[:60]); s=s.replace(a,b)
    open(p,'w',encoding='utf-8',newline='\n').write(s)
# 楼层交给服务端取「当前能到的最深层」：同一批里挖到梯子后，后面的镐子接着往下
sub('extension/lib/strategy.mjs',[("{ a: 'mine', f: eco.floor }","{ a: 'mine', f: 99 }"),("{ a: 'bomb', f: eco.floor, includeWarehouse: false }","{ a: 'bomb', f: 99, includeWarehouse: false }")])
sub('extension/lib/defaults.mjs',[("arena: { enabled: true, battles: 30, perVisit: 5, equip: true, points: true },","arena: { enabled: true, battles: 30, perVisit: 5, equip: true, points: true, spend: 'auto', dailyBudget: 150000 }, // spend：花 D币 训练 / 买装备 / 强化。auto = 开了偷菜或离线时段才花")])
sub('extension/lib/social.mjs',[
("  if (m.done) return\n  let g = await io.api('/pet/battle/gear')\n  if (!g.adopted) { m.done = true; return }",
 "  if (m.done && m.spent) return\n  let g = await io.api('/pet/battle/gear')\n  if (!g.adopted) { m.done = m.spent = true; return }\n  if (!m.spent) { try { g = await arenaSpend(io, g, cfg, log, m) } catch (e) { log('擂台养成出错：' + e.message); m.spent = true } }\n  if (m.done) return"),
("// ---------- 自动偷菜 ----------",
"""// 花 D币 养大肥鱼（只影响守家和偷菜的对战，不直接赚钱）：每天 300 点突破训练（1.35 万）、
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

// ---------- 自动偷菜 ----------"""),
])
