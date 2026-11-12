// 擂台：每日挑战、开宝箱、自动换装、加点、可选训练。
// 擂台只影响守家/偷菜胜率，不直接影响 D币收益（除宝箱装备）。
// 但它决定「偷菜能不能赢」，而偷菜是当前最大的未开发收益项。
import { randomUUID } from 'node:crypto'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(world, path, body) {
  // 擂台的接口前缀是 /api/pet/battle，不走 /api/pet/world/act
  const c = world.client
  if (body === undefined) return c.get(path)
  return c.post(path, body)
}

/** 拉擂台首页 / 装备页 */
export async function arenaHome(world) { return api(world, '/api/pet/battle/home') }
export async function arenaGear(world) { return api(world, '/api/pet/battle/gear') }

/** 按流派分配属性点（提交绝对点数） */
export function pointsFor(gear, plan = 'atk') {
  const free = gear.free || 0
  const p = { ...(gear.points || { str: 0, agi: 0, spd: 0, vit: 0 }) }
  if (free <= 0) return p
  const add = { atk: { str: 1 }, vit: { vit: 1 }, agi: { agi: 1 }, spd: { spd: 1 } }[plan] || { str: 1 }
  for (const [k, n] of Object.entries(add)) p[k] = (p[k] || 0) + free * n
  return p
}

/** 给装备打分（面板 × 30% × 强化） —— 只用于挑最优三件 */
function gearScore(item) {
  if (!item) return -1
  const k = 0.30 * (1 + 0.04 * (item.enh || 0))
  const st = item.stats || {}
  return (st.atk || 0) * 3 + (st.hp || 0) * 0.15 + (st.def || 0) * 2
    + (st.agi || 0) * 2.5 + (st.spd || 0) * 1.5
}

/** 自动穿最好的装备 */
export async function autoEquip(world, gear, log = () => {}) {
  const catalog = gear.catalog || []
  const owned = new Set((gear.items || []).map((x) => x.id))
  let changed = 0
  for (const slot of ['weapon', 'armor', 'charm']) {
    const cur = gear.gear?.[slot]
    const candidates = catalog.filter((it) => it.slot === slot && owned.has(it.id))
    if (!candidates.length) continue
    const best = candidates.sort((a, b) => gearScore(b) - gearScore(a))[0]
    if (cur && cur.id === best.id) continue
    try {
      await api(world, '/api/pet/battle/equip', { slot, item: best.id })
      log(`擂台换装：${slot} → ${best.name}`)
      changed++
    } catch (e) { log(`换装失败（${slot}）：${e.message}`) }
  }
  return changed
}

/** 开可用的宝箱 */
export async function openChests(world, gear, log = () => {}) {
  const d = gear.daily || {}
  let left = Math.max(0, (d.chestMax || 5) - (d.chest || 0))
  let opened = 0
  while (left-- > 0) {
    try {
      const r = await api(world, '/api/pet/battle/chest', {})
      const got = r.got
      if (got?.item) {
        log(`宝箱：${got.item.name || got.item}${got.upgraded ? '（已有，强化 +1）' : ''}${got.pity ? '（保底传说）' : ''}`)
        opened++
      } else break
    } catch (e) { break }
  }
  return opened
}

/**
 * 花 D币 养大肥鱼（只影响守家和偷菜时的对战，不直接赚钱）。
 * 旧版 arenaSpend：每天突破训练、每个槽位补一件史诗装备、已穿的装备强化到 +10。
 * spend='auto' 时只有「偷菜开着 / 离线时段里会被偷」才花——否则这些钱赚不回来。
 * memo 里记今天已花多少，跨轮/跨重启都不会重复超预算。
 */
export async function arenaSpend(world, cfg, gear, memo, log = () => {}) {
  const a = cfg.arena || {}
  const R = world.R
  const day = R?.worldDay?.(world.now) ?? ''
  if (memo && memo.arenaCostDay !== day) { memo.arenaCostDay = day; memo.arenaCost = 0 }
  const on = a.spend === true || a.train === true ||
    (a.spend === 'auto' && (cfg.social?.steal?.enabled || cfg.offline?.enabled))
  if (!on || !gear?.prices) return { gear, cost: 0 }
  // 养成每天只做一次（旧版 m.spent）：后面每轮都重试只会白发请求
  if (memo?.arenaSpendDay === day) return { gear, cost: 0 }
  if (memo) memo.arenaSpendDay = day

  const p = gear.prices
  const cat = Object.fromEntries((gear.catalog || []).map((c) => [c.id, c]))
  const op = () => ({ operation: randomUUID() })
  const reserve = cfg.invest?.reserveCoins ?? 0
  let g = gear, spent = 0
  const budget0 = Math.max(0, (a.dailyBudget ?? 150000) - (memo?.arenaCost || 0))
  let budget = budget0
  const notes = []
  const pay = (c) => { budget -= c; spent += c }
  const coinOf = () => (g.coins ?? world.coins ?? 0)
  const keep = (r) => { if (r?.gear) g = r.gear; else if (r?.daily) g = r }
  const fmt = (n) => Math.round(n).toLocaleString('en-US')

  // 1) 突破训练：从大额档开始（旧版顺序 300/200/100/50/10）
  for (const xp of [300, 200, 100, 50, 10]) {
    for (let guard = 0; guard < 20; guard++) {
      const trained = g.daily?.trained || 0
      if ((p.trainDaily || 0) - trained < xp) break
      let c = 0
      for (let i = trained; i < trained + xp; i++) {
        const tier = (p.trainTiers || []).find(([upTo]) => i < upTo) || (p.trainTiers || []).at(-1)
        c += tier ? tier[1] : 0
      }
      if (!(c > 0) || c > budget || coinOf() - c < reserve) break
      try {
        keep(await api(world, `/api/pet/battle/train?xp=${xp}`, op()))
        pay(c); notes.push(`训练 +${xp}`)
      } catch { break }
    }
  }

  // 2) 每个槽位补一件史诗（rarity 3）。传说不出售，只能靠宝箱/掉落。
  const score = (c) => (c.rarity || 0) * 100 + (c.stats?.atk || 0) * 8 + (c.stats?.hp || 0)
    + (c.stats?.def || 0) * 6 + (c.stats?.agi || 0) * 3 + (c.stats?.spd || 0) * 3
  const shopPrice = p.shop?.[3]
  for (const slot of ['armor', 'weapon', 'charm']) {
    const own = Math.max(0, ...(g.items || []).map((x) => (cat[x.id]?.slot === slot ? cat[x.id].rarity || 0 : 0)))
    const pick = (g.catalog || []).filter((c) => c.slot === slot && c.rarity === 3)
      .sort((x, y) => score(y) - score(x))[0]
    if (!pick || own >= 3 || !(shopPrice > 0)) continue
    if (shopPrice > budget || coinOf() - shopPrice < reserve) continue
    try {
      keep(await api(world, `/api/pet/battle/buy?item=${pick.id}`, op()))
      pay(shopPrice); notes.push(`买${pick.name}`)
      keep(await api(world, '/api/pet/battle/equip', { slot, item: pick.id }))
    } catch { /* 买失败就跳过这个槽位 */ }
  }

  // 3) 强化：三件齐头并进，先强化等级最低的那件，直到 +10
  for (let k = 0; k < 30; k++) {
    const worn = Object.values(g.gear || {}).filter((x) => x && (x.enh || 0) < 10)
      .sort((x, y) => (x.enh || 0) - (y.enh || 0))[0]
    if (!worn) break
    const rarity = cat[worn.id]?.rarity ?? 1
    const c = Math.round((p.enhanceBase?.[worn.enh || 0] || 0) * (p.enhanceRarity?.[rarity] || 1))
    if (!(c > 0) || c > budget || coinOf() - c < reserve) break
    try {
      keep(await api(world, `/api/pet/battle/enhance?item=${worn.id}`, op()))
      pay(c); notes.push(`${cat[worn.id]?.name || worn.id} +${(worn.enh || 0) + 1}`)
    } catch { break }
  }

  if (spent) {
    if (memo) memo.arenaCost = (memo.arenaCost || 0) + spent
    log(`擂台养成（今日已花 ${fmt(memo?.arenaCost || spent)} D / 上限 ${fmt(a.dailyBudget ?? 150000)}）：${notes.join('，')}`)
  }
  return { gear: g, cost: spent }
}

/**
 * 擂台日常：打满有掉落的场次、开宝箱、换装、加点。
 * 每场之间必须间隔 8 秒（服务端限制），这里用 8.5 秒留余量。
 */
export async function arenaDaily(world, cfg, log = () => {}, { onBattle, memo } = {}) {
  const a = cfg.arena || {}
  if (!a.enabled) return { battles: 0 }

  let gear
  try { gear = await arenaGear(world) } catch (e) { log('擂台读取失败：' + e.message); return { battles: 0 } }

  // 先花钱养成（训练/买装/强化），再按养成后的面板穿装备、加点
  try {
    const sp = await arenaSpend(world, cfg, gear, memo, log)
    if (sp.gear) gear = sp.gear
    if (sp.cost) gear = await arenaGear(world)
  } catch (e) { log('擂台养成出错：' + e.message) }

  let battles = 0
  if (a.autoEquip) await autoEquip(world, gear, log)
  if (a.autoPoints) {
    const want = pointsFor(gear, a.pointsPlan || 'atk')
    const cur = gear.points || {}
    if (JSON.stringify(want) !== JSON.stringify(cur)) {
      try { await api(world, '/api/pet/battle/points', { points: want }); log(`擂台加点：${JSON.stringify(want)}`) }
      catch (e) { log('加点失败：' + e.message) }
    }
  }

  // 打对手，直到拿满当天掉落场次
  const drops = gear.daily?.drops ?? 30
  const today = gear.daily?.battles ?? 0
  // 分成几批打（旧版 perVisit）：一次打 30 场要 4 分钟，期间不能巡检/偷菜。
  const left = Math.max(0, (a.battles ?? 30) - today)
  const need = a.perVisit > 0 ? Math.min(left, a.perVisit) : left
  // 场次打满时以前是整段静默跳过，日志里连「今天打过擂台」都看不到，
  // 分不清是额度用完还是功能没跑。状态变化时说明一次。
  if (need <= 0 && world.arenaIdleReason !== today) {
    world.arenaIdleReason = today
    log(`擂台：今日场次已满（${today}/${a.battles ?? 30}），只做换装/开箱/加点`)
  } else if (need > 0) {
    world.arenaIdleReason = 0
  }
  if (need > 0) {
    let opponents = []
    // 站点 a4a62d77 起支持 minLevel/maxLevel 筛选。先只取比我低 5 级以内的，
    // 打不过再放开——低等级对手胜率高，掉落只看场次不看等级。
    const myLevel = gear.level || 1
    const queries = [
      `minLevel=1&maxLevel=${Math.max(1, myLevel - 1)}`,
      `minLevel=1&maxLevel=${Math.min(100, myLevel + 3)}`,
      `minLevel=1&maxLevel=100`,
    ]
    for (const qs of queries) {
      try {
        const r = await api(world, `/api/pet/battle/opponents?limit=20&q=&${qs}`)
        opponents = (r.opponents || []).filter((o) => (o.fought || 0) < 5)
        if (opponents.length) { log(`擂台对手：等级筛选 ${qs}，共 ${opponents.length} 个`); break }
      } catch (e) {
        // 老版本不支持等级筛选时，退回不带参数的查询
        try {
          const r = await api(world, '/api/pet/battle/opponents?limit=20&q=')
          opponents = r.opponents || []
          if (opponents.length) break
        } catch (e2) { log('读取对手失败：' + e2.message); break }
      }
    }

    // 优先打等级低的、今天打得少的
    opponents.sort((x, y) => (x.level || 99) - (y.level || 99) || (x.fought || 0) - (y.fought || 0))
    let idx = 0, wins = 0, losses = 0
    for (let k = 0; k < need && opponents.length; k++) {
      const o = opponents[idx++ % opponents.length]
      try {
        const r = await api(world, '/api/pet/battle', { opponent_id: o.id, operation: randomUUID() })
        if (r.battle) {
          battles++
          // 服务端战报里带胜负，统计一下胜率
          const w = r.battle.win ?? r.battle.result === 'win' ?? r.battle.winner === 'me'
          if (w === true) wins++
          else if (w === false) losses++
        }
        if (r.gear) gear = r.gear
        onBattle?.(battles, need)
      } catch (e) {
        if (e.status === 429) { await sleep(3000); k--; continue }
        log('擂台挑战失败：' + e.message)
        break
      }
      if (k < need - 1) await sleep(8500)
    }
    if (battles) {
      const known = wins + losses
      log(`擂台打 ${battles} 场（本次 ${need} 场）` +
        (known ? `｜胜 ${wins} 负 ${losses}（胜率 ${Math.round(wins / known * 100)}%）` : ''))
    }
  }

  // 开宝箱
  if (a.openChests) {
    try {
      gear = await arenaGear(world)
      await openChests(world, gear, log)
    } catch {}
  }

  // 训练/买装/强化已经挪到开头的 arenaSpend：那里有每日预算和 reserveCoins 保护，
  // 而且必须在打对手之前完成，否则本轮的胜负还是按旧面板算的。

  // today / maxBattles 一起返回：这两个数只在这里拿得到（要发 /battle/gear 请求），
  // nextWake 是纯函数不能发请求，只能靠调用方把它们缓存进 memo。
  // level 给偷菜用：守家战胜率 = 0.5 + (我的等级 − 对方等级) × 0.15（旧版公式）。
  return { battles, today: gear.daily?.battles ?? 0, maxBattles: a.battles ?? 30, day: world.R.worldDay(world.now), level: gear.level || 1 }
}
