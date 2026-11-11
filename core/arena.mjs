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
 * 擂台日常：打满有掉落的场次、开宝箱、换装、加点。
 * 每场之间必须间隔 8 秒（服务端限制），这里用 8.5 秒留余量。
 */
export async function arenaDaily(world, cfg, log = () => {}, { onBattle } = {}) {
  const a = cfg.arena || {}
  if (!a.enabled) return { battles: 0 }

  let gear
  try { gear = await arenaGear(world) } catch (e) { log('擂台读取失败：' + e.message); return { battles: 0 } }

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
  const need = Math.max(0, (a.battles ?? 30) - today)
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

  // 训练（花钱买经验，默认关）
  if (a.train && (a.trainBudget || 0) > 0) {
    try {
      gear = await arenaGear(world)
      const left = Math.max(0, (gear.prices?.trainDaily || 300) - (gear.daily?.trained || 0))
      let budget = a.trainBudget
      const tiers = gear.prices?.trainTiers || [[100, 30], [200, 45], [300, 60]]
      let done = gear.daily?.trained || 0
      for (const [upTo, price] of tiers) {
        const can = Math.min(left, upTo - done)
        if (can <= 0) continue
        const cost = can * price
        if (cost > budget) continue
        try {
          await api(world, `/api/pet/battle/train?xp=${can}`, { operation: randomUUID() })
          budget -= cost; done += can
          log(`突破训练 +${can} 经验（${cost} D）`)
        } catch (e) { log('训练失败：' + e.message); break }
      }
    } catch (e) { log('训练读取失败：' + e.message) }
  }

  return { battles }
}
