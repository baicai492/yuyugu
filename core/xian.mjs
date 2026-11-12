// 大肥鱼修仙记（state.xs）自动托管。
//
// 移植自榜一（research/ref/yuyugu-kernel/execution/xian-cultivation.mjs）的
// planXianActions：先在本地 structuredClone 出来的存档上预演，只有预演成功的
// 动作才会被提交——和服务端结算不一致时不会白提交一次、把状态搞乱。
//
// 一个必须讲清楚的事实：**灵石只在修仙里闭环，不能换成 D 币**。
// 所以这个模块对「赚 D 币」没有直接贡献，它是纯养成。默认关闭（cfg.xian.enabled）。
//
// 节奏上有两件事必须做对，否则收益差一倍：
//   1) 双倍收获：存档里的 x.log 每 +1 一次动作，收获时 log%4===3 才给 2 个。
//      所以收获前要用「严格产出」的动作（浇水/种植/炼丹出炉…）把 log 推到 3。
//   2) 炼丹出炉：BREW_MIN=15 秒，19 秒后出炉稳定拿上品（3 颗）。
//      炼上炉就该在 19 秒后回来，不能等下一次例行巡视。
import {
  BREW_MAX, BREW_MIN, CAN_MAX, COST, EN_MAX, EN_REGEN, FIGHT_DAILY, FUSIONS,
  HERBS, LV_NEED, MED_MAX, MED_MIN, PILL_DAILY, PILLS, PLOTS, REALMS,
  ROOT_GROW, STAGES, STORY_END, TECH_PRICE, TECHS,
  act as xsAct, cvNeed, fuseKey, plotView, rootMult, tick as xsTick,
} from './xian-rules.mjs'

export {
  EN_MAX, PLOTS, REALMS, HERBS, PILLS, TECHS, ROOTS, STORY_END,
} from './xian-rules.mjs'

export const MAX_XS_BATCH = 30
// 客户端炼丹小游戏 18 秒、服务端 BREW_MIN 15 秒；19 秒保证 q=2（上品 3 颗）还留 1 秒误差。
export const BREW_READY_SEC = Math.max(BREW_MIN + 4, 19)

// 这些动作只允许真人点：测灵根、剧情、斗法（斗法是服务端判定的弹幕关卡）。
// 自动化提交它们要么被拒、要么破坏存档，一律不碰。
const FORBIDDEN_XIAN_ACTIONS = new Set(['xsRoot', 'xsStory', 'xsFight', 'xsWin', 'xsLose'])

const HERB_ENTRIES_DESC = Object.entries(HERBS).sort((a, b) => b[1].lv - a[1].lv || b[1].sell - a[1].sell)
const PURE_CASH_HERBS = new Set(
  Object.keys(HERBS).filter((h) => !Object.values(PILLS).some((p) => Object.hasOwn(p.need, h))),
)
const VARIANT_TECH_PRIORITY = ['ice', 'thunder', 'wind', 'lava', 'poison', 'metal', 'water', 'fire', 'earth', 'wood']

export function xsDay(nowSec) {
  return Math.floor((Number(nowSec || 0) + 28800) / 86400)
}

function nextCstMidnightSec(nowSec) {
  return (xsDay(nowSec) + 1) * 86400 - 28800
}

function cstSecondsUntilMidnight(nowSec) {
  return Math.max(0, nextCstMidnightSec(nowSec) - Number(nowSec || 0))
}

/** 内部动作 → 线上协议动作（a: 'water' → 'xsWater'） */
export function toWireXsAction(internalAct) {
  const short = String(internalAct?.a || '')
  const wire = { a: 'xs' + short[0].toUpperCase() + short.slice(1) }
  if (internalAct.i != null) wire.i = internalAct.i
  if (internalAct.herb != null) wire.herb = internalAct.herb
  if (internalAct.n != null) wire.n = internalAct.n
  if (internalAct.el != null) wire.el = internalAct.el
  return wire
}

export function fromWireXsAction(wireAct) {
  const raw = String(wireAct?.a || '')
  if (!raw.startsWith('xs') || raw.length < 3) return null
  const short = raw[2].toLowerCase() + raw.slice(3)
  if (!Object.hasOwn(COST, short)) return null
  const internal = { a: short }
  for (const k of ['i', 'herb', 'n', 'el']) if (wireAct[k] != null) internal[k] = wireAct[k]
  return internal
}

/** 把 config.xian 归一化成规划器要的选项 */
export function normalizeXianOptions(raw = {}) {
  const breakRaw = String(raw?.breakMode || 'smart').trim().toLowerCase()
  const breakMode = ['smart', 'eager', 'manual'].includes(breakRaw) ? breakRaw : 'smart'
  const fuseRaw = String(raw?.fuseTarget || 'auto').trim().toLowerCase()
  const fuseTarget = ['auto', 'ice', 'thunder', 'wind', 'lava', 'poison'].includes(fuseRaw) ? fuseRaw : 'auto'
  const maxRaw = Number(raw?.maxActions ?? raw?.maxActionsPerBatch ?? MAX_XS_BATCH)
  return {
    enabled: Boolean(raw?.enabled),
    breakMode,
    autoFuse: Boolean(raw?.autoFuse),
    fuseTarget,
    maxActionsPerBatch: Number.isFinite(maxRaw)
      ? Math.max(1, Math.min(MAX_XS_BATCH, Math.floor(maxRaw)))
      : MAX_XS_BATCH,
  }
}

/** 提交前自检：禁手动动作、只许 xs*、批次长度不超限 */
export function assertSafeXianBatch(actions, opts) {
  if (!Array.isArray(actions)) throw new Error('修仙批次必须是数组')
  if (actions.length > opts.maxActionsPerBatch) {
    throw new Error(`修仙批次 ${actions.length} 条，超过上限 ${opts.maxActionsPerBatch}`)
  }
  for (const act of actions) {
    const name = String(act?.a || '')
    if (FORBIDDEN_XIAN_ACTIONS.has(name)) throw new Error(`修仙批次里出现了只能手动点的动作：${name}`)
    if (!fromWireXsAction(act)) throw new Error(`修仙批次里混进了非修仙动作：${name}`)
    if (name === 'xsFuse' && !opts.autoFuse) throw new Error('autoFuse 关闭时不允许融合灵根')
    if (name === 'xsBreak' && opts.breakMode === 'manual') throw new Error('breakMode=manual 时不允许自动突破')
  }
}

// ---------- 内部小工具（和榜一同源） ----------

function maxPentagonMatchingCount(baseElements) {
  if (!Array.isArray(baseElements) || baseElements.length < 2) return 0
  let best = 0
  for (let i = 0; i < baseElements.length; i++) {
    for (let j = i + 1; j < baseElements.length; j++) {
      if (!FUSIONS[fuseKey(baseElements[i], baseElements[j])]) continue
      const rest = baseElements.filter((_, idx) => idx !== i && idx !== j)
      best = Math.max(best, 1 + maxPentagonMatchingCount(rest))
    }
  }
  return best
}

/**
 * 选最优融合对：五边形 metal-water-wood-earth-fire 上相邻两条灵根。
 * 四灵根链时优先端点边（还能再融合一次），不要中间边（把后续融合堵死）。
 */
export function selectOptimalFusionPair(roots, fuseTarget = 'auto') {
  const base = Array.isArray(roots?.e) ? roots.e : []
  if (base.length < 2) return null
  const cands = []
  for (let i = 0; i < base.length; i++) {
    for (let j = i + 1; j < base.length; j++) {
      const key = fuseKey(base[i], base[j])
      const f = FUSIONS[key]
      if (!f) continue
      if (fuseTarget !== 'auto' && f.id !== fuseTarget) continue
      const rest = base.filter((_, idx) => idx !== i && idx !== j)
      cands.push({
        key, e1: base[i], e2: base[j], variantId: f.id, variantName: f.name,
        totalReachableFusions: 1 + maxPentagonMatchingCount(rest),
        priorityRank: VARIANT_TECH_PRIORITY.indexOf(f.id),
      })
    }
  }
  if (!cands.length) return null
  cands.sort((a, b) =>
    b.totalReachableFusions - a.totalReachableFusions ||
    (a.priorityRank < 0 ? 99 : a.priorityRank) - (b.priorityRank < 0 ? 99 : b.priorityRank) ||
    a.key.localeCompare(b.key))
  return cands[0]
}

function countInGroundByHerb(x) {
  const counts = {}
  let total = 0
  for (const p of x.plots || []) {
    if (p?.c) { counts[p.c] = (counts[p.c] || 0) + 1; total++ }
  }
  return { counts, total }
}

function countOpenSoilPlots(x) {
  let open = 0, empty = 0
  for (const p of x.plots || []) {
    if (p?.s === 'soil') { open++; if (!p.c) empty++ }
  }
  return { open, empty }
}

function dpUsedToday(x, nowSec) {
  const d = xsDay(nowSec)
  return x.dp?.d === d ? Number(x.dp.n || 0) : 0
}

/**
 * 该不该自动突破。
 * 药园 Lv5 之前优先把培元丹喂给药园（每颗 +40 药园经验），
 * 因为高级药材（雷竹 300 灵石/株）的收益远大于早一天升境界。
 */
function shouldAllowBreakPolicy(x, opts) {
  if (opts.breakMode === 'manual') return false
  const r = Number(x.cv?.r || 0)
  if (r >= REALMS.length - 1) return false
  if (opts.breakMode === 'eager') return true
  if ((x.lv || 1) < 5) {
    if (r > 0) return false
    const rootCount = (x.roots?.e?.length || 0) + (x.roots?.v?.length || 0)
    return Boolean(opts.autoFuse) || (ROOT_GROW[rootCount] || 1) > 1
  }
  return true
}

function computeHeldPeiyuanFloorWhileSubLv5(x, nowSec, opts) {
  if ((x.lv || 1) >= 5) return Infinity
  let hold = 0
  if (shouldAllowBreakPolicy(x, opts) && Number(x.cv?.s || 1) >= 9) {
    hold = Math.max(hold, Number(x.cv?.r || 0) + 1)
  }
  if (opts.autoFuse && Number(x.cv?.r || 0) >= 1 && !(Number(x.fuseCd || 0) > nowSec)) {
    if (selectOptimalFusionPair(x.roots, opts.fuseTarget)) hold = Math.max(hold, 2)
  }
  return hold
}

function computeDesiredPeiyuanStock(x, nowSec, opts) {
  const r = Number(x.cv?.r || 0)
  const breakNeed = r < REALMS.length - 1 ? r + 1 : 0
  if ((x.lv || 1) < 5) return Math.max(6, breakNeed + 3)   // 药园没满级就一直炼
  if (opts.breakMode === 'manual') {
    const pair = selectOptimalFusionPair(x.roots, opts.fuseTarget)
    return Math.max(pair ? 2 : 0, breakNeed)
  }
  const fuseReserve = opts.autoFuse && r >= 1 && selectOptimalFusionPair(x.roots, opts.fuseTarget) ? 2 : 0
  const retryMultiplier = Number(x.cv?.s || 1) >= 8 ? 2 : 1
  return breakNeed * retryMultiplier + fuseReserve
}

function computeAlchemyHerbTargets(x, nowSec, opts) {
  const usedDp = dpUsedToday(x, nowSec)
  const targetHuilingPills = (PILL_DAILY - usedDp) + PILL_DAILY
  const haveHuiling = Number(x.pills?.huiling || 0) + (x.brew?.p === 'huiling' ? 3 : 0)
  const huilingBatches = Math.min(2, Math.max(0, Math.ceil((targetHuilingPills - haveHuiling) / 3)))

  const canGrowLinglan = (x.lv || 1) >= 2
  const desiredPeiyuan = computeDesiredPeiyuanStock(x, nowSec, opts)
  const havePeiyuan = Number(x.pills?.peiyuan || 0) + (x.brew?.p === 'peiyuan' ? 3 : 0)
  const peiyuanBatches = canGrowLinglan
    ? Math.min(2, Math.max(0, Math.ceil((desiredPeiyuan - havePeiyuan) / 3)))
    : 0

  return {
    huilingBatches, peiyuanBatches,
    needHerbs: {
      lingcao: huilingBatches * 3 + peiyuanBatches * 2,
      jingu: huilingBatches * 1,
      linglan: peiyuanBatches * 1,
    },
    bagReserve: {
      lingcao: Math.max(6, huilingBatches * 3 + peiyuanBatches * 2),
      jingu: Math.max(2, huilingBatches * 1),
      linglan: canGrowLinglan ? Math.max(2, peiyuanBatches * 1) : 0,
    },
  }
}

/** 空地种什么：先补丹药原料，够用就种当前解锁的最高级药材 */
function chooseCropForEmptyPlot(x, nowSec, opts) {
  const { counts: inGround, total: totalInGround } = countInGroundByHerb(x)
  const { needHerbs } = computeAlchemyHerbTargets(x, nowSec, opts)
  const canUse = (herbId) => {
    const H = HERBS[herbId]
    if (!H || H.lv > (x.lv || 1)) return false
    return Number(x.seeds?.[herbId] || 0) > 0 || Number(x.stone || 0) >= H.seed
  }
  const projected = (herbId) => Number(x.bag?.[herbId] || 0) + Number(inGround[herbId] || 0)

  if (projected('jingu') < needHerbs.jingu && canUse('jingu')) return 'jingu'
  if (projected('lingcao') < needHerbs.lingcao && canUse('lingcao')) return 'lingcao'
  if ((x.lv || 1) >= 2 && projected('linglan') < needHerbs.linglan && canUse('linglan')) return 'linglan'

  const unlocked = HERB_ENTRIES_DESC.filter(([, H]) => H.lv <= (x.lv || 1))
  const topHerbId = unlocked[0]?.[0] || 'lingcao'
  if (canUse(topHerbId)) return topHerbId

  // 买不起最高级种子时：地里作物太少或灵力快满（再不用就溢出）才降到低一级
  if (totalInGround < 3 || Number(x.en || 0) >= 85) {
    for (const [herbId] of unlocked) if (canUse(herbId)) return herbId
  }
  return null
}

/** 该卖哪种药材：先卖纯现金药材（雷竹/赤芝/冰莲），丹药原料留够底仓 */
function findSellableHerb(x, nowSec, opts) {
  const { bagReserve } = computeAlchemyHerbTargets(x, nowSec, opts)
  for (const [herbId] of HERB_ENTRIES_DESC) {
    const qty = Number(x.bag?.[herbId] || 0)
    if (qty <= 0) continue
    const keep = PURE_CASH_HERBS.has(herbId) ? 0 : Number(bagReserve[herbId] || 0)
    if (qty > keep) return { herb: herbId, sellableQty: qty - keep }
  }
  // 破产兜底：地里没东西、没种子、灵石买不起最便宜的种子 → 有货就卖
  const { total: inGround } = countInGroundByHerb(x)
  const totalSeeds = Object.values(x.seeds || {}).reduce((s, n) => s + Number(n || 0), 0)
  if (inGround === 0 && totalSeeds === 0 && Number(x.stone || 0) < HERBS.lingcao.seed) {
    for (const [herbId] of HERB_ENTRIES_DESC) {
      const qty = Number(x.bag?.[herbId] || 0)
      if (qty > 0) return { herb: herbId, sellableQty: qty }
    }
  }
  return null
}

function computeUpcomingPlotEnergyNeed(x, nowSec, horizonSec = 1800) {
  let need = 0
  for (const p of x.plots || []) {
    if (!p) continue
    if (p.c && p.g >= 3) need += COST.harvest + COST.plant + COST.water
    else if (p.c && p.g < 3 && !p.w) need += COST.water
    else if (p.s === 'soil' && !p.c) need += COST.plant + COST.water
    else if (p.c && p.g < 3 && p.w) {
      const v = plotView(p, nowSec)
      if (v.left <= horizonSec) need += p.g === 2 ? (COST.harvest + COST.plant + COST.water) : COST.water
    }
  }
  const naturalRegenInHorizon = x.en < EN_MAX
    ? Math.floor((Math.max(0, nowSec - Number(x.enAt || nowSec)) + horizonSec) / EN_REGEN)
    : 0
  return Math.max(0, need - naturalRegenInHorizon)
}

function computeSurplusEnergy(x, nowSec) {
  return Number(x.en || 0) - computeUpcomingPlotEnergyNeed(x, nowSec, 1800)
}

function hasBrewIngredients(x, pillId) {
  const P = PILLS[pillId]
  if (!P) return false
  return Object.entries(P.need).every(([h, n]) => Number(x.bag?.[h] || 0) >= n)
}

function findLearnableTech(x) {
  if (!x.roots) return null
  const learned = new Set(x.techs || [])
  const ownedRoots = [...(x.roots.v || []), ...(x.roots.e || [])]
  const ordered = [...ownedRoots].sort((a, b) => {
    const ia = VARIANT_TECH_PRIORITY.indexOf(a)
    const ib = VARIANT_TECH_PRIORITY.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  const unlearned = ordered.filter((el) => TECHS[el] && !learned.has(el))
  if (!unlearned.length) return null

  const { open } = countOpenSoilPlots(x)
  const topHerb = HERB_ENTRIES_DESC.find(([, H]) => H.lv <= (x.lv || 1))?.[1] || HERBS.lingcao
  // 第一部功法只要买得起就学；后续功法等灵石宽裕了再学，别把种子钱花光
  const stoneBuffer = learned.size === 0
    ? Math.max(24, topHerb.seed * 2)
    : Math.max(80, open * Math.min(topHerb.seed, 45))
  return Number(x.stone || 0) >= TECH_PRICE + stoneBuffer ? unlearned[0] : null
}

function shouldEatHuilingNow(x, nowSec, pendingEnergyNeed = 0) {
  if (Number(x.pills?.huiling || 0) < 1) return false
  if (dpUsedToday(x, nowSec) >= PILL_DAILY) return false
  const en = Number(x.en || 0)
  if (en >= EN_MAX) return false
  // en <= 69 时吃不会溢出（+30 ≤ 99），也不打乱 enAt 的自然回复计时
  if (en <= EN_MAX - 31 && (en < pendingEnergyNeed || cstSecondsUntilMidnight(nowSec) <= 4 * 3600)) return true
  // 临近午夜：每日 3 颗的额度不用掉就作废，能补就补
  if (cstSecondsUntilMidnight(nowSec) <= 1500 && en <= EN_MAX - 10) return true
  return false
}

function projectMeditationAfterRise(x, nowSec) {
  if (!x.med) return null
  const d = Math.min(Math.max(0, nowSec - Number(x.med.t || nowSec)), MED_MAX)
  if (d < MED_MIN) return { d, gainCv: 0, s: x.cv.s, xp: x.cv.xp }
  const gainCv = Math.floor((d / 60) * 10 * rootMult(x))
  let s = Number(x.cv?.s || 1)
  let xp = Number(x.cv?.xp || 0) + gainCv
  const r = Number(x.cv?.r || 0)
  while (s < 9 && xp >= cvNeed(r, s)) { xp -= cvNeed(r, s); s++ }
  return { d, gainCv, s, xp }
}

// ---------- 规划 ----------

/**
 * 纯函数：给定世界状态，返回这一批要提交的修仙动作。
 * 全程在 structuredClone 上预演，不修改 world.state。
 *
 * 返回 { enabled, actions, followUpSoon, reason }
 */
export function planXianActions(world, nowSec = Number(world?.now || 0), rawOptions = {}) {
  const opts = normalizeXianOptions(rawOptions)
  if (!opts.enabled) return { enabled: false, actions: [], followUpSoon: false, reason: 'disabled' }

  const t = Math.floor(Number(nowSec || world?.now || 0))
  const rawXs = world?.state?.xs
  // 剧情没过完（st<4）或还没测灵根：前置流程要真人点，托管原地待命
  if (!rawXs?.v || !rawXs.roots || !Array.isArray(rawXs.roots.e) || Number(rawXs.st || 0) < STORY_END) {
    return { enabled: true, actions: [], followUpSoon: false, reason: 'prologue-manual-standby' }
  }
  // 有人在网页端斗法，先别插手
  if (rawXs.fight && t - Number(rawXs.fight.t || 0) < 1800) {
    return { enabled: true, actions: [], followUpSoon: false, reason: 'manual-fight-in-progress' }
  }

  const sim = structuredClone(rawXs)
  xsTick(sim, t)

  const actions = []
  let truncatedByBatchCap = false
  let emittedStochastic = false

  const emit = (internalAct) => {
    if (actions.length >= opts.maxActionsPerBatch) { truncatedByBatchCap = true; return false }
    const res = xsAct(sim, internalAct, t, () => 0.99)
    if (!res?.ok) return false
    actions.push(toWireXsAction(internalAct))
    return true
  }

  const isHoldingMedShieldForBreak = () =>
    Boolean(sim.med) &&
    shouldAllowBreakPolicy(sim, opts) &&
    Number(sim.cv?.s || 1) >= 9 &&
    Number(sim.cv?.xp || 0) >= cvNeed(Number(sim.cv?.r || 0), 9) &&
    Number(sim.pills?.peiyuan || 0) >= Number(sim.cv?.r || 0) + 1

  // 把 sim.log 推到 3 mod 4，且只用「严格产出」的动作（不收获、不打坐），
  // 这样接下来的 harvest 才吃得到双倍。
  const alignLogForDoubleHarvest = (upcomingHarvestCount) => {
    let guard = 0
    while (sim.log % 4 !== 3 && actions.length + 1 < opts.maxActionsPerBatch && guard++ < 6) {
      if (sim.brew && t - Number(sim.brew.t || 0) >= BREW_READY_SEC) {
        if (emit({ a: 'finish', n: 2 })) continue
      }
      if (shouldEatHuilingNow(sim, t, upcomingHarvestCount * (COST.harvest + COST.plant + COST.water))) {
        if (emit({ a: 'use', herb: 'huiling' })) continue
      }
      if ((sim.lv || 1) < 5 && Number(sim.pills?.peiyuan || 0) > computeHeldPeiyuanFloorWhileSubLv5(sim, t, opts)) {
        if (emit({ a: 'use', herb: 'peiyuan' })) continue
      }
      if (!sim.med) {
        if (emit({ a: 'sit' })) continue
      } else if (t - Number(sim.med.t || 0) >= MED_MAX && !isHoldingMedShieldForBreak()) {
        if (emit({ a: 'rise' })) continue
      }

      const dryIdx = sim.plots.findIndex((p) => p?.c && p.g < 3 && !p.w)
      if (dryIdx >= 0 && sim.en >= COST.harvest + COST.water) {
        if (sim.can < 1) { if (emit({ a: 'refill' })) continue }
        else if (emit({ a: 'water', i: dryIdx })) continue
      }

      const emptyIdx = sim.plots.findIndex((p) => p?.s === 'soil' && !p.c)
      if (emptyIdx >= 0 && sim.en >= COST.harvest + COST.plant) {
        const crop = chooseCropForEmptyPlot(sim, t, opts)
        if (crop) {
          if (Number(sim.seeds?.[crop] || 0) < 1 && sim.stone >= HERBS[crop].seed) {
            if (emit({ a: 'buy', herb: crop, n: 1 })) continue
          } else if (Number(sim.seeds?.[crop] || 0) >= 1) {
            if (emit({ a: 'plant', i: emptyIdx, herb: crop })) continue
          }
        }
      }

      const sellCand = findSellableHerb(sim, t, opts)
      if (sellCand) { if (emit({ a: 'sell', herb: sellCand.herb, n: 1 })) continue }

      if (sim.en >= COST.harvest + COST.plant) {
        const nextCrop = chooseCropForEmptyPlot(sim, t, opts)
        if (nextCrop) {
          const { empty } = countOpenSoilPlots(sim)
          if (Number(sim.seeds?.[nextCrop] || 0) < empty + upcomingHarvestCount && sim.stone >= HERBS[nextCrop].seed) {
            if (emit({ a: 'buy', herb: nextCrop, n: 1 })) continue
          }
        }
      }

      const techToLearn = findLearnableTech(sim)
      if (techToLearn) { if (emit({ a: 'learn', el: techToLearn })) continue }

      if (sim.can < CAN_MAX) { if (emit({ a: 'refill' })) continue }
      break
    }
  }

  // 1. 丹炉好了先出炉——除非有一块熟地正等着用这个 log 步长吃双倍
  if (sim.brew && t - Number(sim.brew.t || 0) >= BREW_READY_SEC) {
    const hasRipe = sim.plots.some((p) => p?.c && p.g >= 3)
    if (!hasRipe || sim.log % 4 !== 3) emit({ a: 'finish', n: 2 })
  }

  // 1b. 先炼回灵丹：花 5 灵力换今天多 90 灵力（净 +85），
  //     不先炼的话，浇水/收获会把灵力花到不够起炉（COST.brew=5）。
  if (
    !sim.brew && sim.en >= COST.brew &&
    Number(sim.pills?.huiling || 0) < PILL_DAILY - dpUsedToday(sim, t) &&
    hasBrewIngredients(sim, 'huiling') &&
    (!sim.plots.some((p) => p?.c && p.g >= 3) || sim.log % 4 !== 3)
  ) {
    emit({ a: 'brew', herb: 'huiling' })
  }

  // 2. 收获熟地：贵的先收，并先对齐 log 吃双倍
  const ripeIndices = sim.plots
    .map((p, idx) => (p?.c && p.g >= 3 ? { idx, sell: HERBS[p.c]?.sell || 0 } : null))
    .filter(Boolean)
    .sort((a, b) => b.sell - a.sell || a.idx - b.idx)

  for (let k = 0; k < ripeIndices.length; k++) {
    if (actions.length >= opts.maxActionsPerBatch) { truncatedByBatchCap = true; break }
    const { idx } = ripeIndices[k]
    const p = sim.plots[idx]
    if (!p?.c || p.g < 3) continue
    const remainingRipe = ripeIndices.length - k
    if (sim.en < COST.harvest && shouldEatHuilingNow(sim, t, remainingRipe * 4)) emit({ a: 'use', herb: 'huiling' })
    if (sim.en < COST.harvest) break
    // 对齐要花的步数会超出本批上限时，把这块熟地留给下一批，别牺牲双倍
    const stepsForDouble = (3 - (sim.log % 4) + 4) % 4
    if (stepsForDouble > 0 && actions.length + stepsForDouble + 1 > opts.maxActionsPerBatch) {
      truncatedByBatchCap = true
      break
    }
    alignLogForDoubleHarvest(remainingRipe)
    if (!emit({ a: 'harvest', i: idx })) break
  }

  // 收获之后再看出炉（上面为了双倍故意押后过）
  if (sim.brew && t - Number(sim.brew.t || 0) >= BREW_READY_SEC) emit({ a: 'finish', n: 2 })

  // 起炉：先补今天的回灵丹，药园没满级再炼培元丹
  if (!sim.brew && sim.en >= COST.brew && actions.length < opts.maxActionsPerBatch) {
    const needHuilingToday = Number(sim.pills?.huiling || 0) < PILL_DAILY - dpUsedToday(sim, t)
    if (needHuilingToday && hasBrewIngredients(sim, 'huiling')) emit({ a: 'brew', herb: 'huiling' })
    else if ((sim.lv || 1) < 5 && sim.en >= COST.brew + 4 && hasBrewIngredients(sim, 'peiyuan')) emit({ a: 'brew', herb: 'peiyuan' })
  }

  // 3. 药园没满级时吃培元丹——升级后能种的种子更值钱，要在播种前吃
  while (
    (sim.lv || 1) < 5 &&
    Number(sim.pills?.peiyuan || 0) > computeHeldPeiyuanFloorWhileSubLv5(sim, t, opts) &&
    actions.length < opts.maxActionsPerBatch
  ) {
    if (!emit({ a: 'use', herb: 'peiyuan' })) break
  }

  // 4. 卖多余药材（单次 ≤99），先换成灵石再去买种子
  while (actions.length < opts.maxActionsPerBatch) {
    const sellCand = findSellableHerb(sim, t, opts)
    if (!sellCand) break
    if (!emit({ a: 'sell', herb: sellCand.herb, n: Math.min(99, sellCand.sellableQty) })) break
  }

  // 5. 浇正在长、还没浇水的田（不浇的话生长计时是停的）
  for (let i = 0; i < PLOTS; i++) {
    if (actions.length >= opts.maxActionsPerBatch) { truncatedByBatchCap = true; break }
    const p = sim.plots[i]
    if (!p?.c || p.g >= 3 || p.w) continue
    if (sim.en < COST.water && shouldEatHuilingNow(sim, t, COST.water + 4)) emit({ a: 'use', herb: 'huiling' })
    if (sim.en < COST.water) break
    if (sim.can < 1 && !emit({ a: 'refill' })) break
    emit({ a: 'water', i })
  }

  // 6. 空田播种并顺手浇水
  for (let i = 0; i < PLOTS; i++) {
    if (actions.length >= opts.maxActionsPerBatch) { truncatedByBatchCap = true; break }
    const p = sim.plots[i]
    if (!p || p.s !== 'soil' || p.c) continue
    if (sim.en < COST.plant + COST.water && shouldEatHuilingNow(sim, t, COST.plant + COST.water + 4)) emit({ a: 'use', herb: 'huiling' })
    if (sim.en < COST.plant) break
    const crop = chooseCropForEmptyPlot(sim, t, opts)
    if (!crop) break
    if (Number(sim.seeds?.[crop] || 0) < 1) {
      const remEmpty = sim.plots.slice(i).filter((pl) => pl?.s === 'soil' && !pl.c).length
      const maxBuy = Math.min(10, remEmpty, Math.floor(sim.stone / HERBS[crop].seed))
      if (maxBuy < 1 || !emit({ a: 'buy', herb: crop, n: maxBuy })) break
    }
    if (!emit({ a: 'plant', i, herb: crop })) break
    if (sim.en >= COST.water) {
      if (sim.can < 1) emit({ a: 'refill' })
      if (sim.can >= 1) emit({ a: 'water', i })
    }
  }

  // 7. 晚间补满当天的回灵丹额度（过了午夜额度就作废）
  while (shouldEatHuilingNow(sim, t, 0) && actions.length < opts.maxActionsPerBatch) {
    if (!emit({ a: 'use', herb: 'huiling' })) break
  }

  // 8. 炼丹：药园满级后培元丹不加经验，只在田里没事、灵力有富余时炼
  if (!sim.brew && sim.en >= COST.brew && actions.length < opts.maxActionsPerBatch) {
    const needHuilingToday = Number(sim.pills?.huiling || 0) < PILL_DAILY - dpUsedToday(sim, t)
    const { huilingBatches, peiyuanBatches } = computeAlchemyHerbTargets(sim, t, opts)
    const surplusEn = computeSurplusEnergy(sim, t)
    const allOpenWatered = !sim.plots.some((p) => p?.s === 'soil' && (!p.c || (p.g < 3 && !p.w) || p.g >= 3))

    if (needHuilingToday && hasBrewIngredients(sim, 'huiling')) emit({ a: 'brew', herb: 'huiling' })
    else if (huilingBatches > 0 && hasBrewIngredients(sim, 'huiling') && (allOpenWatered || surplusEn >= COST.brew || sim.en >= 80)) emit({ a: 'brew', herb: 'huiling' })
    else if (peiyuanBatches > 0 && hasBrewIngredients(sim, 'peiyuan') &&
      ((sim.lv || 1) < 5 || (allOpenWatered && (surplusEn >= COST.brew || sim.en >= 60)) || sim.en >= 85)) {
      emit({ a: 'brew', herb: 'peiyuan' })
    }
  }

  // 9. 用富余灵力除草扩地（锄 3 + 种 1 + 浇 1 = 5 灵力）
  //    药园 Lv4 之前地里是快菜，灵力本来就吃紧，只在灵力 >= 92（快溢出）时扩
  while (actions.length + 3 <= opts.maxActionsPerBatch) {
    const hasUnfinishedOpenPlot = sim.plots.some((p) => p?.s === 'soil' && (!p.c || (p.g < 3 && !p.w) || p.g >= 3))
    if (hasUnfinishedOpenPlot) break
    const weedIdx = sim.plots.findIndex((p) => p?.s === 'weed')
    if (weedIdx < 0) break
    const surplusEn = computeSurplusEnergy(sim, t)
    const canExpand = (sim.lv || 1) < 4 ? sim.en >= 92 : (surplusEn >= 8 || sim.en >= 65)
    if (!canExpand) break
    const crop = chooseCropForEmptyPlot(sim, t, opts)
    if (!crop) break
    if (Number(sim.seeds?.[crop] || 0) < 1) {
      if (sim.stone < HERBS[crop].seed) break
      if (!emit({ a: 'buy', herb: crop, n: 1 })) break
    }
    if (!emit({ a: 'hoe', i: weedIdx })) break
    if (!emit({ a: 'plant', i: weedIdx, herb: crop })) break
    if (sim.can < 1) emit({ a: 'refill' })
    if (sim.can >= 1 && sim.en >= COST.water) emit({ a: 'water', i: weedIdx })
  }

  // 10. 学功法（每部 50 灵石）——必须排在融合之前，融合会把基础灵根吃掉
  while (actions.length < opts.maxActionsPerBatch) {
    const techEl = findLearnableTech(sim)
    if (!techEl) break
    if (!emit({ a: 'learn', el: techEl })) break
  }
  if (!sim.tech && Array.isArray(sim.techs) && sim.techs.length > 0 && actions.length < opts.maxActionsPerBatch) {
    const preferred = [...sim.techs].sort((a, b) => {
      const ia = VARIANT_TECH_PRIORITY.indexOf(a)
      const ib = VARIANT_TECH_PRIORITY.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })[0]
    emit({ a: 'equip', el: preferred })
  }

  // 11. 收尾：突破 → 打坐 → 融合
  const allowBreak = shouldAllowBreakPolicy(sim, opts)
  const curR = Number(sim.cv?.r || 0)
  const breakPillsNeed = curR + 1
  const haveBreakPills = Number(sim.pills?.peiyuan || 0) >= breakPillsNeed

  if (allowBreak && haveBreakPills && Number(sim.cv?.s || 1) >= 9 &&
    Number(sim.cv?.xp || 0) >= cvNeed(curR, 9) && actions.length < opts.maxActionsPerBatch) {
    // 修为已经满了：先突破再收功，保住还在打坐里的那次收益
    if (emit({ a: 'break' })) {
      emittedStochastic = true
      if (sim.med && t - Number(sim.med.t || 0) >= MED_MIN + 5 && actions.length + 1 < opts.maxActionsPerBatch) {
        if (emit({ a: 'rise' })) emit({ a: 'sit' })
      } else if (!sim.med && actions.length < opts.maxActionsPerBatch) {
        emit({ a: 'sit' })
      }
    }
  } else if (allowBreak && haveBreakPills && sim.med && t - Number(sim.med.t || 0) >= MED_MIN + 5 &&
    actions.length + 2 <= opts.maxActionsPerBatch) {
    // 这次收功刚好能满：收功立刻突破，避免多打坐一轮
    const proj = projectMeditationAfterRise(sim, t)
    if (proj && proj.s >= 9 && proj.xp >= cvNeed(curR, 9)) {
      if (emit({ a: 'rise' }) && emit({ a: 'break' })) {
        emittedStochastic = true
        if (actions.length < opts.maxActionsPerBatch) emit({ a: 'sit' })
      }
    }
  }

  // 例行打坐循环：30 分钟一收一坐（即使满层也继续攒修为，给突破失败的损耗留缓冲）
  if (!emittedStochastic) {
    if (sim.med && t - Number(sim.med.t || 0) >= MED_MAX && actions.length + 1 <= opts.maxActionsPerBatch) {
      if (emit({ a: 'rise' }) && actions.length < opts.maxActionsPerBatch) emit({ a: 'sit' })
    } else if (!sim.med && actions.length < opts.maxActionsPerBatch) {
      emit({ a: 'sit' })
    }

    // 灵根融合（默认关：融合是不可逆的），只在修为损耗最小的窗口做
    if (opts.autoFuse && Number(sim.cv?.r || 0) >= 1 && !(Number(sim.fuseCd || 0) > t) &&
      Number(sim.pills?.peiyuan || 0) >= 2 && Number(sim.stone || 0) >= 200 &&
      actions.length < opts.maxActionsPerBatch) {
      const pair = selectOptimalFusionPair(sim.roots, opts.fuseTarget)
      if (pair) {
        const learned = new Set(sim.techs || [])
        const lowXpCap = Math.max(15, Math.floor(cvNeed(Number(sim.cv?.r || 0), Number(sim.cv?.s || 1)) * 0.12))
        if (learned.has(pair.e1) && learned.has(pair.e2) && Number(sim.cv?.xp || 0) <= lowXpCap) {
          if (emit({ a: 'fuse', el: pair.key })) emittedStochastic = true
        }
      }
    }
  }

  assertSafeXianBatch(actions, opts)

  return {
    enabled: true,
    actions,
    followUpSoon: Boolean(truncatedByBatchCap || emittedStochastic),
    reason: actions.length > 0 ? 'actions-ready' : 'idle',
  }
}

/**
 * 下一次值得为修仙醒来的时刻（绝对服务端秒）。
 * 只有「炼丹要出炉」「作物长一阶」「灵力回够」「打坐到期」这几件有时限的事才算。
 */
export function nextXianWakeSec(world, nowSec = Number(world?.now || 0), rawOptions = {}, opts0 = null) {
  const opts = opts0 || normalizeXianOptions(rawOptions)
  if (!opts.enabled) return Infinity
  const t = Math.floor(Number(nowSec || world?.now || 0))
  const rawXs = world?.state?.xs
  if (!rawXs?.v || !rawXs.roots || !Array.isArray(rawXs.roots.e) || Number(rawXs.st || 0) < STORY_END) {
    return t + 120
  }
  if (rawXs.fight && t - Number(rawXs.fight.t || 0) < 1800) {
    return Math.min(t + 60, Number(rawXs.fight.t) + 1802)
  }

  const preview = planXianActions(world, t, opts)
  // 现在就有动作 → 把尾批交接时刻放在 3 秒后（大于 2.2 秒的提交间隔）
  if (preview.actions.length > 0) return t + 3

  const sim = structuredClone(rawXs)
  xsTick(sim, t)
  const cands = [nextCstMidnightSec(t) + 3]

  if (sim.brew) {
    const readyAt = Number(sim.brew.t || t) + BREW_READY_SEC
    if (readyAt > t) cands.push(readyAt)
  }

  let waitingOnPlotEnergy = false
  for (const p of sim.plots || []) {
    if (!p) continue
    if (p.c && p.g < 3 && p.w) {
      const stageAt = Number(p.w) + HERBS[p.c].grow + 1
      if (stageAt > t) cands.push(stageAt)
    } else if ((p.c && p.g >= 3) || (p.c && p.g < 3 && !p.w)) {
      waitingOnPlotEnergy = true
    } else if (p.s === 'soil' && !p.c && chooseCropForEmptyPlot(sim, t, opts)) {
      waitingOnPlotEnergy = true
    }
  }

  if (sim.en < EN_MAX) {
    const enBase = Number(sim.enAt || t)
    if (waitingOnPlotEnergy) {
      const nextTick = enBase + EN_REGEN + 1
      cands.push(nextTick > t ? nextTick : t + EN_REGEN)
    }
    const to88 = Math.max(1, 88 - Number(sim.en || 0))
    const nearCapAt = enBase + to88 * EN_REGEN + 1
    if (nearCapAt > t) cands.push(nearCapAt)
  }

  if (sim.med) {
    const medCapAt = Number(sim.med.t || t) + MED_MAX + 1
    if (medCapAt > t) cands.push(medCapAt)
  }

  if (dpUsedToday(sim, t) < PILL_DAILY && Number(sim.pills?.huiling || 0) > 0) {
    const eveningTopUpAt = nextCstMidnightSec(t) - 4 * 3600 + 5
    if (eveningTopUpAt > t) cands.push(eveningTopUpAt)
  }

  return Math.min(...cands.filter((v) => Number.isFinite(v) && v > t))
}

const XS_ACTION_LABELS = {
  xsHoe: '锄地', xsPlant: '播种', xsWater: '浇水', xsHarvest: '收获',
  xsRefill: '打水', xsBuy: '买种子', xsSell: '卖药材', xsBrew: '起炉',
  xsFinish: '出炉', xsUse: '服丹', xsSit: '打坐', xsRise: '收功',
  xsBreak: '突破', xsFuse: '融合灵根', xsLearn: '学功法', xsEquip: '换主修',
}

function summarizeXs(actions) {
  const c = {}
  for (const a of actions) c[XS_ACTION_LABELS[a.a] || a.a] = (c[XS_ACTION_LABELS[a.a] || a.a] || 0) + 1
  return Object.entries(c).map(([k, n]) => `${k}×${n}`).join(' ')
}

/**
 * 跑一轮修仙：规划 → 提交 → 记录下次该醒的时刻。
 *
 * 返回 { ran, actions, plan, nextWakeAt, reason, summary }
 * 注意：world.act 里会把结果写回 world.state（含 xs），所以下一轮预演基于最新存档。
 */
export async function xianRound(world, cfg, log = () => {}, memo = {}) {
  const xc = cfg?.xian || {}
  if (xc.enabled === false) return { ran: false, actions: 0, reason: 'disabled', nextWakeAt: 0 }

  const opts = normalizeXianOptions({ ...xc, enabled: true })
  const t = Math.floor(world.now || 0)
  const first = planXianActions(world, t, opts)

  if (!first.actions.length) {
    memo.xianWakeAt = nextXianWakeSec(world, t, {}, opts)
    memo.xianReason = first.reason
    return { ran: false, actions: 0, reason: first.reason, nextWakeAt: memo.xianWakeAt }
  }

  if (cfg.dry) {
    log(`[演练] 修仙计划：${summarizeXs(first.actions)}`)
    return { ran: false, actions: 0, reason: 'dry', planned: first.actions.length, nextWakeAt: 0 }
  }

  // 一批最多 maxActions 条，剩下的下一批接着做。
  // 为什么不交给下次巡视：炼丹 19 秒要出炉、熟地要抢在双倍位置收，
  // 隔几十秒再来一次就错过窗口了。这里连做几批，每批之间由 http 层自动
  // 保证 ≥2.15 秒间隔。
  const maxBatches = Math.max(1, Math.min(6, xc.maxBatchesPerRound ?? 3))
  let total = 0
  let plan = first
  for (let i = 0; i < maxBatches; i++) {
    if (!plan.actions.length) break
    let res
    try {
      // silent：批量动作的通用日志是「提交 N 条：xsWater×5…」，又长又难读；
      // 这里用 summarizeXs 自己拼一行中文，失败原因单独提示。
      res = await world.act(plan.actions, { silent: true })
    } catch (e) {
      // 409：别处改了世界（网页端/管家）。把错误抛给引擎，下一轮用新快照重规划。
      log(`修仙提交被拒：${e.message}`, 'warn')
      break
    }
    const out = res.out || []
    const ok = out.filter((o) => o?.ok).length
    total += ok
    if (ok) log(`修仙：${summarizeXs(plan.actions)}`)
    const fail = out.filter((o) => o && !o.ok)
    if (fail.length) {
      log(`修仙有 ${fail.length} 个动作未被接受：${fail[0].msg || '未知原因'}（可能站点规则更新了）`, 'warn')
    }
    if (!ok) break
    plan = planXianActions(world, Math.floor(world.now || t), opts)
  }

  memo.xianWakeAt = nextXianWakeSec(world, Math.floor(world.now || t), {}, opts)
  memo.xianReason = plan.reason
  memo.xianLastAt = world.now
  memo.xianLastOk = total
  return { ran: true, actions: total, reason: plan.reason, nextWakeAt: memo.xianWakeAt, summary: summarizeXs(first.actions) }
}

/** 给 GUI 的修仙快照（只读） */
export function xianSnapshot(world, cfg = {}) {
  const x = world?.state?.xs
  const t = Math.floor(world?.now || 0)
  const xc = cfg?.xian || {}
  if (!x) {
    return { exists: false, enabled: Boolean(xc.enabled) }
  }
  const sim = structuredClone(x)
  try { xsTick(sim, t) } catch {}
  const { counts: inGround } = countInGroundByHerb(sim)
  const { open, empty } = countOpenSoilPlots(sim)
  const r = Number(sim.cv?.r || 0)
  const s = Number(sim.cv?.s || 1)
  let mature = 0, growing = 0, dry = 0
  for (const p of sim.plots || []) {
    if (!p?.c) continue
    if (p.g >= 3) mature++
    else { growing++; if (!p.w) dry++ }
  }
  const opts = normalizeXianOptions(xc)
  let nextWake = Infinity
  try { nextWake = nextXianWakeSec(world, t, {}, opts) } catch {}

  // 资源统计：灵石口径的家底 + 每日计量。
  // 灵石换不成 D 币，所以这里的所有估值只用来对比「修仙内部攒了多少」，不并入现金收益。
  const sumQty = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0)
  const sumVal = (o, table, key) => Object.entries(o || {})
    .reduce((a, [k, n]) => a + (Number(n) || 0) * (Number(table[k]?.[key]) || 0), 0)
  const bagQty = sumQty(sim.bag)
  const seedQty = sumQty(sim.seeds)
  const pillQty = sumQty(sim.pills)
  const bagValue = sumVal(sim.bag, HERBS, 'sell')
  const seedValue = sumVal(sim.seeds, HERBS, 'seed')
  const pillValue = sumVal(sim.pills, PILLS, 'sell')
  const groundValue = (sim.plots || []).reduce(
    (a, p) => a + (p?.c && p.g >= 3 ? (Number(HERBS[p.c]?.sell) || 0) : 0), 0)
  const groundQty = mature + growing
  const today = xsDay(t)
  const pillUse = sim.dp?.d === today ? Number(sim.dp.n || 0) : 0
  const fightUse = sim.df?.d === today ? Number(sim.df.n || 0) : 0

  return {
    exists: true,
    enabled: Boolean(xc.enabled),
    autoFuse: opts.autoFuse,
    breakMode: opts.breakMode,
    story: Number(sim.st || 0),
    storyDone: Number(sim.st || 0) >= STORY_END,
    roots: sim.roots ? [...(sim.roots.e || []), ...(sim.roots.v || [])] : [],
    realm: REALMS[r] || REALMS[0],
    realmIndex: r,
    stage: s,
    cvXp: Number(sim.cv?.xp || 0),
    cvNeed: cvNeed(r, s),
    energy: Math.floor(Number(sim.en || 0)),
    energyMax: EN_MAX,
    can: Number(sim.can || 0),
    canMax: CAN_MAX,
    stone: Number(sim.stone || 0),
    gardenLv: Number(sim.lv || 1),
    gardenXp: Number(sim.xp || 0),
    gardenNeed: LV_NEED(Number(sim.lv || 1)),
    plots: { total: PLOTS, open, empty, mature, growing, dry },
    inGround,
    bag: { ...(sim.bag || {}) },
    seeds: { ...(sim.seeds || {}) },
    pills: { ...(sim.pills || {}) },
    // 灵石口径的资源汇总（详细说明见 GUI「资源统计」）：
    // 药材按卖价、种子按买价（成本）、丹药按参考卖价、地里成熟作物按卖价。
    assets: {
      stone: Number(sim.stone || 0),
      bagQty, seedQty, pillQty,
      bagValue, seedValue, pillValue, groundValue,
      groundQty, groundMature: mature,
      total: Number(sim.stone || 0) + bagValue + seedValue + pillValue + groundValue,
    },
    daily: {
      pillUse, pillMax: PILL_DAILY,
      fightUse, fightMax: FIGHT_DAILY,
      cleared: Object.keys(sim.clear || {}).length,
      stageTotal: Object.keys(STAGES).length,
    },
    brew: sim.brew ? { pill: sim.brew.p, readyIn: Math.max(0, Number(sim.brew.t || 0) + BREW_READY_SEC - t) } : null,
    meditate: sim.med ? { elapsed: Math.max(0, t - Number(sim.med.t || 0)), cap: MED_MAX } : null,
    techs: [...(sim.techs || [])],
    mainTech: sim.tech || null,
    nextWakeIn: Number.isFinite(nextWake) ? Math.max(0, Math.round(nextWake - t)) : -1,
    reason: world?.xianReason || '',
    fight: sim.fight ? { stage: sim.fight.s, at: sim.fight.t } : null,
  }
}
