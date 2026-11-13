// 擂台：每日挑战、开宝箱、静止防守装、加点、可选训练。
//
// 榜单第一名的方案在这里落地：装备不再按「攻×3」拍脑袋挑，而是
// 用 battle.mjs 的实战评分与加点断点；每场擂台还会按对手面板
// 做一次蒙特卡洛模拟，只有显著提高胜率时才临时换装，打完立刻穿回静止装。
// 擂台本身不直接产 D 币，但它决定偷菜/守家的胜负，而偷菜是当前最大的
// 未开发收益项——所以这里的养成值得认真做。
import { randomUUID } from 'node:crypto'
import {
  planGearAndPoints,
  scoreGearItem,
  executeWithTacticalLoadout,
  recordBattleSnapshot,
  noteBattleOutcome,
  battleOutcomeOf,
  syncHomeHistoryProfiles,
  syncGuardLogProfiles,
  defaultProfileStorePath,
  defaultLockRoot,
} from './battle.mjs'

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

/** 按流派分配属性点（提交绝对点数）——兼容旧配置 pointsPlan='atk' 等 */
export function pointsFor(gear, plan = 'atk') {
  const free = gear.free || 0
  const p = { ...(gear.points || { str: 0, agi: 0, spd: 0, vit: 0 }) }
  if (free <= 0) return p
  const add = { atk: { str: 1 }, vit: { vit: 1 }, agi: { agi: 1 }, spd: { spd: 1 } }[plan] || { str: 1 }
  for (const [k, n] of Object.entries(add)) p[k] = (p[k] || 0) + free * n
  return p
}

/**
 * 穿戴「静止防守装」+ 分配自由点。
 *
 * 换装会改变面板，面板又会影响加点决策（比如零速必暴武器要先补速度），
 * 所以这里最多迭代 3 轮：换 → 重拉 → 再算点 → 再换，直到不再变化。
 * 以前只做一轮、且加点全堆一项属性，实战胜率比榜单第一低不少。
 */
export async function applyRestingLoadout(world, cfg, gear, log = () => {}, { rounds = 3 } = {}) {
  const a = cfg.arena || {}
  const wantPlan = a.pointsPlan || 'auto'
  let g = gear
  let changed = 0
  let lastPoints = null

  for (let round = 0; round < rounds; round++) {
    let did = false
    const plan = planGearAndPoints(g)

    if (a.autoEquip) {
      for (const e of plan.equip) {
        if (g.gear?.[e.slot]?.id === e.item) continue
        try {
          const r = await api(world, '/api/pet/battle/equip', { slot: e.slot, item: e.item })
          log(`擂台换装：${e.slot} → ${e.name}（实战评分 ${e.score}）`)
          g = (r?.gear || (r?.catalog ? r : g))
          changed++
          did = true
        } catch (err) {
          log(`换装失败（${e.slot} → ${e.name}）：${err.message}`)
        }
      }
    }

    if (a.autoPoints) {
      const want = wantPlan === 'auto' ? planGearAndPoints(g).points : pointsFor(g, wantPlan)
      const cur = g.points || {}
      if (JSON.stringify(want) !== JSON.stringify(cur)) {
        try {
          await api(world, '/api/pet/battle/points', { points: want })
          lastPoints = want
          log(`擂台加点：str ${want.str} / vit ${want.vit} / agi ${want.agi} / spd ${want.spd}`)
          changed++
          did = true
        } catch (err) {
          log('加点失败：' + err.message)
        }
      }
    }

    if (!did) break
    try { g = await arenaGear(world) } catch { break }
  }
  return { gear: g, changed, points: lastPoints }
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
 * 每天突破训练、每个槽位补一件史诗装备、已穿的装备强化到 +10。
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
  // 挑哪件用 battle.mjs 的实战评分：护符被动（复活/吸血/反击）
  // 和武器技能都算进去，旧版只看面板会买错。
  const score = (c) => scoreGearItem(c, 0)
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
 * 打一场擂台：战前按对手换装 → 提交 → 无论胜负把静止装穿回来。
 * 换装是 POST（2.15 秒节流），一场最多换 3 个槽，耗时仍小于擂台
 * 本身的 8.5 秒间隔，不会拖慢节奏。对手没有档案时不换装，直接打。
 */
async function fightOne(world, cfg, opponent, { storePath, lockRoot, accountKey }) {
  const equipSlotFn = async (slot, item) => {
    try {
      const body = await api(world, '/api/pet/battle/equip', { slot, item })
      return { status: 200, body }
    } catch (e) {
      return { status: e.status ?? 0 }
    }
  }
  return executeWithTacticalLoadout({
    accountKey,
    lockRoot,
    opponentId: opponent.id,
    mode: 'arena',
    knownOpponentLevel: opponent.level || null,
    storePath,
    getGearFn: () => arenaGear(world),
    equipSlotFn,
    actionFn: () => api(world, '/api/pet/battle', { opponent_id: opponent.id, operation: randomUUID() }),
    trials: cfg.battle?.trials ?? 800,
    minGain: cfg.battle?.minGain ?? 0.005,
    zThreshold: cfg.battle?.zThreshold ?? 2.0,
  })
}

/**
 * 擂台日常：打满有掉落的场次、开宝箱、穿静止装、加点、同步战报档案。
 * 每场之间必须间隔 8 秒（服务端限制），这里用 8.5 秒留余量。
 */
export async function arenaDaily(world, cfg, log = () => {}, { onBattle, memo } = {}) {
  const a = cfg.arena || {}
  if (!a.enabled) return { battles: 0 }

  const b = cfg.battle || {}
  const storePath = b.profileStore || defaultProfileStorePath()
  const lockRoot = b.lockRoot || defaultLockRoot()
  const accountKey = b.accountKey || 'main'

  let gear
  try { gear = await arenaGear(world) } catch (e) { log('擂台读取失败：' + e.message); return { battles: 0 } }

  // 先花钱养成（训练/买装/强化），再按养成后的面板穿装备、加点
  // 花掉的 D 要往上带：这些接口不走 world.act，响应里也没有 earn/spend，
  // 不显式记账就会在 GUI 上变成「其他变动」（2026-11-13 训练 13,500 +
  // 买装 5,720 全被算成不明去向）。equip/points/chest 都不花钱。
  let spend = 0
  try {
    const sp = await arenaSpend(world, cfg, gear, memo, log)
    if (sp.gear) gear = sp.gear
    if (sp.cost) { spend += sp.cost; gear = await arenaGear(world) }
  } catch (e) { log('擂台养成出错：' + e.message) }

  try {
    const rl = await applyRestingLoadout(world, cfg, gear, log)
    if (rl.gear) gear = rl.gear
    if (rl.changed) gear = await arenaGear(world)
  } catch (e) { log('静止装/加点出错：' + e.message) }
  if (memo) { memo.battleGear = gear; memo.battleGearAt = Date.now(); memo.battleLevel = gear.level || memo.battleLevel }

  let battles = 0
  let wins = 0
  let losses = 0
  let draws = 0
  // 打对手，直到拿满当天掉落场次
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
    const tactical = b.tacticalSwap !== false && a.autoEquip !== false
    let idx = 0
    let equipFails = 0
    for (let k = 0; k < need && opponents.length; k++) {
      const o = opponents[idx++ % opponents.length]
      try {
        let r
        let decision = null
        if (tactical) {
          const res = await fightOne(world, cfg, o, { storePath, lockRoot, accountKey })
          decision = res.decision
          r = res.result
          if (!r?.battle) {
            // 战前换装失败时宁可跳过这一场，也不穿着错误的装备去打。
            equipFails++
            log(`擂台跳过：战前换装失败（${res.preEquipError || res.restoreError || '未提交'}）`)
            if (equipFails >= 3) { log('擂台：连续换装失败，本轮停止'); break }
            await sleep(1000)
            k--
            continue
          }
          if (decision?.switched) {
            log(`擂台换装：对手 ${decision.oppName || o.name}（Lv${decision.oppLevel || o.level}）` +
              ` 模拟胜率 ${Math.round((decision.winRate || 0) * 100)}%（静止装 ${Math.round((decision.defaultWinRate || 0) * 100)}%）` +
              `｜换 ${decision.switchedSlots.join('/')}`)
          }
        } else {
          r = await api(world, '/api/pet/battle', { opponent_id: o.id, operation: randomUUID() })
        }
        equipFails = 0
        if (r.battle) {
          battles++
          // 服务端战报里带胜负，统计一下胜率
          const outcome = battleOutcomeOf(r.battle)
          if (outcome === 'win') wins++
          else if (outcome === 'lose') losses++
          else if (outcome === 'draw') draws++
          // 战报就是对手档案的直接来源：双方的面板、技能、装备都在里面。
          try { recordBattleSnapshot(r.battle, 'arena', { storePath }) } catch {}
          // 真实战绩按 mode=arena 记一笔，并附上赛前模拟的三率。
          // 榜一也不因此改变选对手策略，只用于复盘「模拟是否偏乐观」，
          // 以及给以后的后验混合提供样本。
          if (outcome) {
            try {
              noteBattleOutcome(o.id, outcome, {
                mode: 'arena',
                storePath,
                predicted: Number.isFinite(decision?.winRate)
                  ? { winRate: decision.winRate, drawRate: Math.max(0, 1 - decision.winRate - (decision.lossRate || 0)), lossRate: decision.lossRate || 0 }
                  : null,
                atSec: world.now,
              })
            } catch {}
          }
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
      const decided = wins + losses
      log(`擂台打 ${battles} 场（本次 ${need} 场）` +
        (decided ? `｜胜 ${wins} 负 ${losses}${draws ? ` 平 ${draws}` : ''}（胜率 ${Math.round(wins / decided * 100)}%）` : ''))
    }
  }

  // 开宝箱
  if (a.openChests) {
    try {
      gear = await arenaGear(world)
      await openChests(world, gear, log)
    } catch {}
  }

  // 增量同步战报：擂台 history（双方面板）+ 守家日志（来袭者面板）。
  // 都按 lastId 增量，平时只多两个 GET；第一次运行会补几场历史。
  if (b.profileSync !== false) {
    try {
      const home = await arenaHome(world)
      const hn = await syncHomeHistoryProfiles(world.client, home, accountKey, {
        storePath, maxFetch: b.homeSyncMax ?? 6,
      })
      let gn = 0
      if (b.guardSync !== false) {
        gn = await syncGuardLogProfiles(world.client, accountKey, { storePath, maxFetch: b.guardSyncMax ?? 8 })
      }
      if (hn || gn) log(`战报档案：同步 ${hn} 条擂台 / ${gn} 条守家`)
    } catch (e) {
      log('战报同步失败：' + e.message)
    }
  }

  // 训练/买装/强化已经挪到开头的 arenaSpend：那里有每日预算和 reserveCoins 保护，
  // 而且必须在打对手之前完成，否则本轮的胜负还是按旧面板算的。

  // today / maxBattles 一起返回：这两个数只在这里拿得到（要发 /battle/gear 请求），
  // nextWake 是纯函数不能发请求，只能靠调用方把它们缓存进 memo。
  // level 给偷菜用（对手档案缺失时退回等级差估算）。
  return { battles, spend, today: gear.daily?.battles ?? 0, maxBattles: a.battles ?? 30, day: world.R.worldDay(world.now), level: gear.level || 1 }
}
