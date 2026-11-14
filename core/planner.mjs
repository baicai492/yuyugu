// 规划器：输入世界快照，输出本轮要提交的动作。
// 纯函数，不做网络请求；所有决策先在规则的本地副本上预演一遍。
//
// 设计原则：
//   1. 先做「确定性正收益」的事（收获、收产物、喂食、收蟹笼、领奖、夜潮）
//   2. 再花体力做「单位体力收益最高」的事（钓/挖/炸），直到体力或额度用尽
//   3. 卖货只在价格接近未来峰值时做，并尊重阶梯价与累进税
//   4. 投资只看回本周期
import * as M from './market.mjs'
import { planVault, planVaultUpgrade, vaultCapacity } from './warehouse.mjs'
import { nextUnlock, physicalPrepLeadSec, stealGearSwaps, SNIPE_MIN_GAP_SEC } from './steal-schedule.mjs'
import { allocateStamina } from './stamina-dp.mjs'

const clone = (x) => structuredClone(x)
const fmt = (n) => Math.round(n).toLocaleString('en-US')

/**
 * 多久没喂就算「饿」。
 *
 * 规则里真正的断产出点是 24 小时（animalReady 的 `fed = t - a.f < 86400`），
 * 8 小时只是「下次喂食的最早时刻」（R:632 的拒绝条件），不是需求。
 * 留 4 小时缓冲 → 20 小时喂一次；按 8 小时喂会白花 2/3 的饲料和体力。
 *
 * 这个值必须和唤醒器（engine.watchOnce、本文件 nextWake）共用：
 * 曾经 planner 改 20 小时、唤醒器还写 8 小时，于是喂食后 8~20 小时这段
 * 每一轮都「畜栏要处理 → 醒 → 什么都不做 → 退避 300 秒」，
 * 线上 2026-11-14 一个上午刷了 735 次。
 */
export const ANIMAL_FEED_SEC = 20 * 3600

/**
 * 一自然日有几个岛日。
 *
 * 长夜时钟只在 08:00–22:00 这 14 小时里走（规则的 b12ActiveSeconds，
 * R:1179-1182；b12ClockSeconds 就是用它累计的），夜里原地冻结。
 * 所以是 14h/ISLE_SPAN = 3.5 个岛日，不是 24h/ISLE_SPAN = 6。
 * 实测日志也吻合：岛时 08:12→08:21→08:30 每 10 分钟走 1 点，而 00:30 和
 * 08:02 都停在「0 点」——夜里没过。
 * 服务端没配时钟（b12ClockStart() 为 0）时才按真实时间算。
 */
export function isleDaysPerDay(R) {
  const span = R.ISLE_SPAN || 14400
  return (R.b12ClockStart?.() ? 14 * 3600 : 86400) / span
}

/**
 * 把「N 个岛日的岛钟时长」折成现实秒数。
 * 规则自己的 b12AfterActive 就是干这个的（跳过 22:00–08:00），直接复用，
 * 免得手工算「一天 14 小时」时踩到边界。
 */
export function isleSpanToReal(R, t, isleSec) {
  try {
    if (R.b12ClockStart?.() && R.b12AfterActive) {
      const at = R.b12AfterActive(t, Math.max(0, isleSec))
      if (Number.isFinite(at)) return at
    }
  } catch { /* 超出 1000 次循环上限就退回线性 */ }
  return t + Math.max(0, isleSec)
}

/** 体力/精力相关：找出最便宜的补体力方式 */
export function foodChoices(R, s, prices) {
  const room = Math.max(0, R.energyMax(s) - s.en)
  const out = []
  for (const c of R.CROPS) {
    const qs = s.inv?.[c.id] || []
    for (let q = 0; q < 3; q++) {
      const n = R.b12Available(s, c.id, q)
      if (n <= 0) continue
      // full = 这一份本身的回复量；restore = 现在吃下去实际能回多少（受 room 截断）。
      //
      // 旧版在这里直接 `if (restore <= 0) continue`，体力一满 room=0 就整条过滤掉，
      // foodChoices 返回空数组。下游拿它算「库存折多少体力」「每点体力多少口粮钱」，
      // 于是满体力时库存成本全变成 0 / 兜底 300 —— 口粮堆着几千点还是把地全种上口粮。
      // 现在满体力也把条目留下（restore=0），用 full 算库存与单价。
      const full = Math.round(c.eat * R.QUALITY[q])
      if (full <= 0) continue
      const restore = Math.min(room, full)
      const unit = Math.round((prices[c.id] || 0) * R.QUALITY[q])
      out.push({ id: c.id, q, n, full, restore, unit, costPerEnergy: unit / full })
    }
  }
  // 潮汐饭团：每天最多吃 2 个（R.B12_SNACK.daily），不是「有多少能吃多少」。
  // n 保留真实库存（折算口粮当量要用），limit 才是今天还能吃的份数，
  // energyActions / 口粮榨取都按 limit 走。旧版只判了「今天没吃满」，然后
  // 把整仓 n 都塞进池子，吃第三个起全被服务端拒绝，白占一轮动作名额。
  const snack = R.b12Available(s, 'tide_snack', 0)
  const snackLeft = Math.max(0, R.B12_SNACK.daily - (s.cnt?.tide_snack || 0))
  if (snack > 0 && snackLeft > 0) {
    const full = R.B12_SNACK.energy
    out.push({
      id: 'tide_snack', q: 0, n: snack, limit: Math.min(snack, snackLeft), full,
      restore: Math.min(full, room), unit: R.B12_SNACK.price, costPerEnergy: R.B12_SNACK.price / full,
    })
  }
  out.sort((a, b) => a.costPerEnergy - b.costPerEnergy)
  return out
}

/**
 * 为「规划之外」的开销凑体力（移植自旧版 extension/lib/strategy.mjs 的 energyActions）。
 *
 * 为什么需要：钓鱼/挖矿/炸矿是「体力换钱」的连续决策，规划器会算每点体力
 * 值不值；但偷菜、帮忙这类**带截止时间**的动作不是。偷菜要掐着保护期解禁
 * 那一刻去，那一下体力被钓鱼花光了，这趟就白来，下一块地要再等半小时。
 * 旧版的处理是：需要时现场吃口粮/喝咖啡补到够，只要每点体力的成本
 * 不超过 maxPerE（偷菜默认 600 D/点）——偷一批货通常值几千 D，花几百 D
 * 买体力去抢是稳赚的。
 *
 * 新版重写时整段丢了，只剩一条「体力 < 5 就跳过」的硬门槛，
 * 于是体力常年被钓鱼吃干，偷菜的额度一整天都是 0（线上 11-12 全天只偷到 1 处）。
 *
 * @param need      要凑到多少体力
 * @param maxPerE   每点体力最多花多少 D（口粮按卖价折算机会成本）
 * @returns 要提交的吃/喝动作数组；凑不够返回 null
 */
export function energyActions(R, state, prices, { need, maxPerE, cfg = {}, coins = Infinity } = {}) {
  const acts = []
  const max = R.energyMax(state)
  let en = state.en
  // 口粮池：按「每点体力成本」从便宜到贵。left 记剩余可吃的份数，
  // 因为同一份口粮吃完一口就要扣一件（foodChoices 不知道我们吃了多少）。
  // 有日限的（潮汐饭团）按 limit 截断，不然会排出今天注定失败的吃法。
  const pool = foodChoices(R, state, prices).map((f) => ({ ...f, left: Math.min(f.n, f.limit ?? f.n) }))
  let guard = 0
  while (en < need && guard++ < 50) {
    const room = Math.max(0, max - en)
    let progressed = false
    if (room > 0) {
      for (const f of pool) {
        if (f.left <= 0) continue
        if (f.costPerEnergy > maxPerE) break      // 已排序，后面更贵
        // 按当前缺口动态截断：吃之前 room 可能已经被前面几口吃小了
        const restore = Math.min(room, f.full ?? f.restore)
        if (restore <= 0) continue
        acts.push({ a: 'eat', id: f.id, q: f.q })
        f.left--
        en = Math.min(max, en + restore)
        progressed = true
        break
      }
    }
    if (progressed) continue
    // 体力满了但还不够 need：只有咖啡能突破上限（每天限量）
    const coffee = R.WORLD.coffee || {}
    const coffeeLeft = (R.WORLD.daily?.coffee || 0) - (state.cnt?.coffee || 0)
    const perE = (coffee.price || 0) / Math.max(1, coffee.energy || 1)
    if (coffeeLeft <= 0 || cfg.energy?.coffee === false || !(coffee.energy > 0)) break
    if (perE > maxPerE) break
    if (coins - (coffee.price || 0) < Math.min(cfg.invest?.reserveCoins || 0, 50000)) break
    acts.push({ a: 'coffee' })
    en += coffee.energy
    coins -= coffee.price || 0
  }
  return en >= need ? acts : null
}

/**
 * 每点体力拿去钓鱼/挖矿/炸矿能赚多少（D/点）。
 *
 * 这是「种地」决策里最容易被忽略的一项：一块地每岛日要吃 30 多点体力
 * （种植 2 + 收获 1×次数 + 浇水若干），这些体力本来可以拿去做别的。
 * 以前 makeCropPlanner 把体力按「口粮采购价」（小麦 ~143 D/点）折钱，
 * 严重低估：线上实测钓鱼每点体力 3,400+ D，是口粮价的 24 倍。
 * 按 143 算，玉米每块地每岛日「净赚 8.8 万」；按钓鱼机会成本算，
 * 实际是「净亏 1.7 万」——24 块地全种满，体力被农务吃干，
 * 钓鱼额度一整天 0/80，而钓鱼才是收益最高的事。
 *
 * 只在还有额度时才算：额度刷完的活不能算机会成本，否则会得出
 * 「今天什么都别干」的结论。
 */
export function workValuePerEnergy(R, s, t, prices, cfg) {
  const W = R.WORLD
  const iq = s.iq?.d === R.isleIndex(t) ? s.iq : {}
  const left = (k, max) => Math.max(0, (max || 0) - (iq[k] || 0))
  const useBait = cfg.work?.bait && (s.inv?.bait?.[0] || 0) > 0
  let best = 0
  if (cfg.work?.fish && left('fish', W.daily.fish) > 0) {
    const ev = fishEV(R, s, t, prices, useBait)
    if (ev > 0) best = Math.max(best, ev / (W.cost.fish || 1))
  }
  if (cfg.work?.mine && left('mine', W.daily.mine) >= 3) {
    // mineEV 返回的已经是「每次挥镐的期望收益」（内部乘过命中期望 1.25+0.05*pick），
    // 这里不能再除一次——旧版除完等于只算「命中那一下」的收益：
    // pick 2 的每点体力从 824 压到 610（低估 26%），pick 2/3/4 的边际值完全相同。
    const ev = mineEV(R, s, prices, false, t)
    if (ev > 0) best = Math.max(best, ev / (W.cost.mine || 1))
  }
  if (cfg.work?.bomb && left('bomb', W.daily.bomb) > 0 && (s.inv?.bomb?.[0] || 0) > 0) {
    const ev = mineEV(R, s, prices, true, t)
    if (ev > 0) best = Math.max(best, ev / (W.cost.bomb || 1))
  }
  return best
}

/** 钓鱼的期望收益（每点体力） */
export function fishEV(R, s, t, prices, useBait) {
  const pool = R.fishPool(s, t)
  if (!pool.length) return 0
  const weather = R.weatherOf(R.isleDay(t))
  const miss = Math.max(0.05, 0.22 - 0.04 * s.tools.rod - (useBait ? 0.08 : 0) - (weather === 1 ? 0.05 : 0))
  const boost = (useBait ? 2 : 1) * (weather === 1 ? 1.5 : 1)
  const w = pool.map((f) => f.w * (f.price >= 9000 ? boost : 1))
  const sum = w.reduce((a, b) => a + b, 0)
  let ev = 0
  pool.forEach((f, i) => { ev += (w[i] / sum) * (prices[f.id] || f.price) })
  const gold = 0.08 + 0.05 * s.tools.rod
  const quality = gold * 1.5 + (1 - gold) * (0.28 * 1.25 + 0.72)
  const baitCost = useBait ? (R.SHOP.bait?.price || 400) : 0
  return (1 - miss) * quality * ev - baitCost
}

/** 挖矿的期望收益 */
export function mineEV(R, s, prices, useBomb, t = Date.now() / 1000) {
  const floor = Math.min(s.mine.max, R.PICK_FLOOR[s.tools.pick])
  // 风暴天（weather===3）高价矿出现概率 ×1.6（旧版 oreEV）
  const weather = R.weatherOf(R.isleDay(t))
  const storm = (o) => (o.price >= 12000 && weather === 3 ? 1.6 : 1)
  const pool = R.ORES.filter((o) => o.floor <= floor)
  const w = pool.map((o) => o.w * storm(o) * (1 + (floor - o.floor) / 40))
  const sum = w.reduce((a, b) => a + b, 0)
  let ev = 0
  pool.forEach((o, i) => { ev += (w[i] / sum) * (prices[o.id] || o.price) })
  if (useBomb) {
    const bombPool = R.ORES.filter((o) => o.floor <= floor)
    const bw = bombPool.map((o) => o.w * storm(o) * (o.price >= 7000 ? 1.35 : 1) * (1 + (floor - o.floor) / 40))
    const bsum = bw.reduce((a, b) => a + b, 0)
    let bev = 0
    bombPool.forEach((o, i) => { bev += (bw[i] / bsum) * (prices[o.id] || o.price) })
    const hits = 6 + 2 * (0.3 + 0.05 * (s.tools.pick || 1))
    return bev * hits - (R.SHOP.bomb?.price || 2500)
  }
  return ev * (1.25 + 0.05 * s.tools.pick)
}

/**
 * 离线时段：这段时间没人收菜，成熟超过保护期的地会被偷。
 * 返回包含 time 的离线区间 [开始, 结束]（unix 秒），不在离线时段返回 null。
 * 手机关着 / 不托管的时间段，种地计划要避开让它在这段时间里成熟。
 */
export function offlineWindow(cfg, time) {
  if (!cfg.offline?.enabled) return null
  const parse = (v) => { const [h, m] = String(v).split(':').map(Number); return (h * 60 + (m || 0)) * 60 }
  const from = parse(cfg.offline.from), to = parse(cfg.offline.to)
  if (!(from >= 0) || !(to >= 0) || from === to) return null
  const local = time + 8 * 3600, day0 = Math.floor(local / 86400) * 86400
  for (const d of [day0 - 86400, day0]) {
    const a = d + from, b = d + (to > from ? to : to + 86400)
    if (local >= a && local < b) return [a - 8 * 3600, b - 8 * 3600]
  }
  return null
}

/** 最近一块地成熟的时刻（弹窗显示「防偷」状态用）；没有在长的作物返回 0 */
export function nextRipe(R, world, cfg = {}) {
  const s = world.state, t = world.now, weather = R.weatherOf(R.isleDay(t))
  let at = 0
  for (let i = 0; i < (s.plotN || 0); i++) {
    const p = s.plots?.[i]
    if (!p) continue
    const st = R.cropStage(p, t, R.sprinkled(s, i) || weather === 1)
    if (st.stage >= 0 && st.stage < 3 && (!at || t + st.left < at)) at = Math.ceil(t + st.left)
  }
  return at
}

/**
 * 这块地现在种下去，成熟时刻会不会落在离线时段里？
 * 落在里面的话，成熟后没人收，超过保护期就被偷（被偷过的地每次只收 1 个）。
 * 返回 true 表示「该换一种成熟更快/更慢的作物」。只在离线时段开启时检查。
 */
export function ripensWhileOffline(cfg, now, growSec, regrow = 0, auto = false) {
  if (!cfg.offline?.enabled) return false
  // 和 R.cropStage（cache/rules-05a5c445.mjs:472-478）逐字一致。
  // 刚种下去的地是 {t:now, g:0, h:0}：
  //   · 首茬用 grow 不是 regrow（regrow 只在 p.h>0 的复茬用）；
  //   · 岛日时代（p.t >= ISLE_LAUNCH）一律 ×0.8——新种的一定是；
  //   · 洒水器覆盖或雨天再 ×0.6。
  // 旧版拿 regrow 顶首茬、两个系数都没乘：复茬作物偏 −17%~+4%，单茬作物一律高估 25%，
  // 而且洒水器地块把成熟时刻算晚了，正好会漏掉「实际会落在离线时段」的那些。
  const total = (growSec || 0) * 60 * 0.8 * (auto ? 0.6 : 1)
  const ripeAt = now + total
  return !!offlineWindow(cfg, ripeAt + 60)
}

/** 作物成熟时间（秒） */
export function cropReadyIn(R, s, p, t) {
  const st = R.cropStage(p, t, R.sprinkled(s, s.plots.indexOf(p)) || R.weatherOf(R.isleDay(t)) === 1)
  return st.stage === 3 ? 0 : Math.max(0, st.left)
}

/**
 * 逐块种植规划器：决定「下一块空地种什么」。
 *
 * 为什么不能一次性选「当季最赚的作物」然后全种上：
 *   1. 阶梯价——同一作物每岛日卖过 150 个后掉到 85%，又过 400 掉到 70%。
 *      24 块地全种番茄，后一半产量只能按 70% 卖，实际均值远低于按全价算的估值。
 *   2. 加工坊容量——每岛日只有 40 次加工，某些作物加工后增值更多，
 *      但加工名额被先种下去的作物吃掉，后面的作物就不能再按加工价估值。
 *
 * 做法（和旧版一致）：维护一张「已经规划了哪些作物、每岛日各品质产出多少」的表，
 * 每加一块地就试一遍所有当季作物，取「加这一块能多赚多少」最大的那个。
 * 加进去之后再规划下一块，所以后面的决策知道前面已经占掉了多少阶梯和加工名额。
 *
 * 返回 { pick(mode, foodMode) → {crop, value} | null }
 *   mode      —— 这块地的浇水方式（auto/manual/none）
 *   foodMode  —— 传入时优先按「回体力最多」挑口粮作物
 */
export function makeCropPlanner(R, s, t, prices, cfg, weather, foodCost = 300) {
  const season = R.seasonOf(R.isleDay(t))
  const TIERS = R.CROP_TIERS || [[150, 1], [400, 0.85], [Infinity, 0.7]]
  const QUALITY = R.QUALITY || [1, 1.25, 1.5]
  const modeOf = (i) => (R.sprinkled(s, i) || weather === 1 ? 'auto' : (cfg.farm?.water ? 'manual' : 'none'))

  /**
   * 逐茬模拟这块地：什么时候熟、浇了几次水、会不会在离线时段里熟（熟了没人收，
   * 超过保护期还会被偷——被偷过的地这次固定只收 1 个）。
   * 返回按「每岛日」折算的产量（分品质）、种子钱和农务体力。
   * 和旧版 cropCycle 同源：固定浇水次数是近似，逐阶段模拟才能算准
   * 复茬作物第二茬起会不会跨季、会不会撞上离线时段。
   */
  const cycleOf = (c, mode) => {
    const W = R.WORLD
    const times = c.regrow ? (c.times || 1) : 1
    const items = [0, 0, 0]
    let time = t, n = 0, waters = 0, opsE = W.cost.plant, stolen = 0, first = 0
    for (let h = 0; h < times; h++) {
      const base = (h > 0 ? c.regrow * 0.8 : c.grow) * 60 * 0.8   // 岛日时钟比现实快 0.8
      let total = base, w = 0
      if (mode === 'auto') { total = base * 0.6; w = 3 }
      else if (mode === 'manual') {
        // 每个生长阶段一开始就浇一次，每次把**剩余**时间缩短 25%。
        // 离线时段里浇不到水，所以这段时间只能按自然速度走。
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
      const at = off ? off[1] : ripe, taken = at - ripe > (cfg.defense?.protect ?? 1800)
      const y = taken ? 1 : 1.3 + 0.08 * w
      const gold = 0.05 + 0.1 * w, silver = 0.2 + 0.08 * w
      items[0] += y * (1 - gold - silver); items[1] += y * silver; items[2] += y * gold
      if (taken) stolen++
      n++; opsE += W.cost.harvest
      if (!h) first = at - t
      time = at
      // 复茬作物跨过换季就枯死，得清地重种（后面的茬次也不再产出了）
      if (h + 1 < times && !c.seasons.includes(R.seasonOf(R.isleDay(time)))) { opsE += W.cost.clear || 0; break }
    }
    opsE += waters * W.cost.water
    const secs = Math.max(1, time - t), perDay = 86400 / secs
    return {
      n, secs, first, stolen, waters: waters * perDay,
      items: items.map((x) => x * perDay),
      // 种子只买一次：复茬是收完再长，不重新播种（以前乘 times 会严重高估复茬成本）
      seed: c.seed * perDay,
      energy: opsE * perDay,
    }
  }

  const crops = R.CROPS.filter((c) => c.seasons.includes(season)).map((c) => {
    // 单原料配方：加工能增值就用加工价（普通/银星），金星直接卖。
    //
    // 已知近似：多原料配方（田园沙拉 turnip+carrot、南瓜派 pumpkin+egg）没算进来。
    // 它需要同时知道辅料的供给和价格，而辅料本身也是要排产的作物，属于全局优化；
    // 硬塞一个「辅料按市价扣」的估计会让加工名额在两种作物之间来回抢，实测更难收敛。
    // 影响面：胡萝卜和南瓜的估值偏低，但它们仍有单原料替代（南瓜派除外），
    // 不会把本来该种的作物排除掉——只是排序靠后。
    const rec = cfg.craft?.enabled
      ? R.RECIPES.filter((r) => r.price && Object.keys(r.in).length === 1 && r.in[c.id])
        .sort((a, b) => ((prices[b.id] || b.price) / b.in[c.id]) - ((prices[a.id] || a.price) / a.in[c.id]))[0]
      : null
    return { c, v0: prices[c.id] || c.price, u: rec ? (prices[rec.id] || rec.price) / rec.in[c.id] : 0, k: rec ? rec.in[c.id] : 1 }
  })
  const byId = Object.fromEntries(crops.map((x) => [x.c.id, x]))
  const prod = {}   // 作物 → 已经规划进去的 [普通, 银星, 金星] 每岛日产量

  const craftedSlots = () => Object.entries(prod).reduce((a, [id, p]) => {
    const x = byId[id]
    // 只算普通(0)和银星(1)：revenue() 里 `useCraft = q < 2`，金星是直接卖的
    // （加工成成品不区分品质，金星拿去加工反而亏）。旧版三个品质全加进来，
    // 占用的加工名额被高估——洒水器地金星多，后面的作物会更早被判「没名额」。
    return a + (x?.u > 0 ? (p[0] + p[1]) / (x.k || 1) : 0)
  }, 0)

  /** 给定产量和可用加工名额，按「加工优先、再按阶梯」算出能卖多少钱 */
  const revenue = (x, p, craftCap) => {
    let ti = 0, tierLeft = TIERS[0][0], craftLeft = craftCap * (x.k || 1), rev = 0, used = 0
    for (const q of [2, 1, 0]) {
      let n = p[q]
      while (n > 1e-6) {
        const raw = x.v0 * QUALITY[q] * TIERS[ti][1]
        const useCraft = q < 2 && craftLeft > 1e-6 && x.u > raw
        const take = Math.min(n, useCraft ? craftLeft : tierLeft)
        if (useCraft) { rev += take * x.u; craftLeft -= take; used += take / (x.k || 1) } else {
          rev += take * raw; tierLeft -= take
          if (tierLeft <= 1e-6 && ti < TIERS.length - 1) { ti++; tierLeft = TIERS[ti][0] - TIERS[ti - 1][0] }
        }
        n -= take
      }
    }
    return { rev, used }
  }

  // 加工坊每天的名额：约 3.5 个岛日 × 每岛日 40 次，挖矿类配方还要占掉一部分
  const craftTotal = (R.WORLD.daily.craft || 40) * 3.5 - (cfg.work?.mine ? 90 : 0)
  const craftCapOf = (id) => {
    const mine = byId[id]?.u > 0 ? (prod[id] || []).reduce((a, n) => a + n, 0) / (byId[id].k || 1) : 0
    const others = craftedSlots() - mine
    return Math.max(0, craftTotal - others)
  }

  return {
    modeOf,
    /** 这块空地种什么最赚。foodMode=true 时按「净回体力最多」挑 */
    pick(mode, foodMode = false) {
      let top = null
      for (const x of crops) {
        const cy = cycleOf(x.c, mode)
        if (foodMode) {
          const energy = cy.items.reduce((a, n, q) => a + n * x.c.eat * QUALITY[q], 0) - cy.energy
          if (!top || energy > top.value) top = { crop: x.c, cy, value: energy }
          continue
        }
        const cur = prod[x.c.id] || [0, 0, 0]
        const next = cur.map((n, q) => n + cy.items[q])
        const cap = craftCapOf(x.c.id)
        // 农务体力按口粮价折钱：这点体力本来可以拿去钓鱼/挖矿
        const value = revenue(x, next, cap).rev - revenue(x, cur, cap).rev - cy.seed - cy.energy * foodCost
        if (!top || value > top.value) top = { crop: x.c, cy, value }
      }
      return top
    },
    /** 记账：这块地已经种下去了，后面的决策要扣掉它占的阶梯和加工名额 */
    add(id, mode) {
      const x = byId[id]
      if (!x) return
      const cy = cycleOf(x.c, mode)
      const p = (prod[id] ||= [0, 0, 0])
      cy.items.forEach((n, q) => { p[q] += n })
    },
    prod,
  }
}


/** 选当季最赚的作物（按每分钟净收益估） */
export function bestCropFor(R, season, prices) {
  const list = R.CROPS.filter((c) => c.seasons.includes(season))
  if (!list.length) return null
  let best = null, bestV = -Infinity
  for (const c of list) {
    const price = prices[c.id] || c.price
    const perMin = (price * (1 + 0.54) * 1.285 - c.seed) / c.grow
    // 复茬作物按总产量摊
    const total = c.regrow ? c.times : 1
    const minutes = c.grow + (c.regrow || 0) * (total - 1)
    const v = (price * 1.54 * 1.285 * total - c.seed) / minutes
    if (v > bestV) { bestV = v; best = c }
  }
  return best
}

/**
 * 决策依据快照：把「每点体力能干出多少」这类判断摆到日志里。
 * 旧版这行信息量最大——不看它根本不知道为什么程序选了钓鱼而不是挖矿。
 */
export function decisionSnapshot(R, s, t, prices, expPrices, cfg) {
  const fmt = (n) => Math.round(n).toLocaleString('en-US')
  const season = R.seasonOf(R.isleDay(t))
  const useBait = cfg.work?.bait && (s.inv.bait?.[0] || 0) > 0
  // 体力超上限时 room=0，旧版 foodChoices 会返回空数组——现在它保留条目
  // （restore 被钳到 0，但 full / unit / costPerEnergy 都是准的），这里直接用。
  const food = foodChoices(R, s, prices)
  const foodCost = Math.round(food[0]?.costPerEnergy ?? 0)
  const foodName = food[0] ? (R.ITEM_NAME?.[food[0].id] || food[0].id) : ''

  const perE = (v, cost) => (v > 0 ? Math.round(v / cost) : 0)
  const fish = cfg.work?.fish ? perE(fishEV(R, s, t, expPrices, useBait), R.WORLD.cost.fish) : 0
  const mine = cfg.work?.mine ? perE(mineEV(R, s, expPrices, false, t), R.WORLD.cost.mine) : 0
  const bomb = cfg.work?.bomb ? perE(mineEV(R, s, expPrices, true, t), R.WORLD.cost.bomb) : 0

  // 本岛日还剩下多少额度。日志里必须写清楚——「每点体力收益 炸矿 2,952」
  // 和「这个岛日已经炸满 10 次了」是两回事，只打前者会让人以为程序一直在炸矿。
  const quotaLeft = (k) => {
    const iq = s.iq
    const used = (iq && iq.d === R.isleIndex(t)) ? (iq[k] || 0) : 0
    return Math.max(0, (R.WORLD.daily[k] || 0) - used)
  }
  const quota = { fish: quotaLeft('fish'), mine: quotaLeft('mine'), bomb: quotaLeft('bomb'), craft: quotaLeft('craft') }
  // 所有「花体力换钱」的活都没额度了 → 这个岛日已经没事可做，只能等换岛日
  const allWorkDone = quota.fish <= 0 && quota.mine <= 0 && quota.bomb <= 0

  // 当前地里种得最多的作物 / 口粮地
  const plantCount = {}
  let empty = 0
  for (let i = 0; i < s.plotN; i++) {
    const p = s.plots[i]
    if (!p) { empty++; continue }
    plantCount[p.c] = (plantCount[p.c] || 0) + 1
  }
  const topCrop = Object.entries(plantCount).sort((a, b) => b[1] - a[1])[0]
  const best = bestCropFor(R, season, expPrices)

  const jobs = [['钓鱼', fish], ['挖矿', mine], ['炸矿', bomb]].filter(([, v]) => v > 0)
  jobs.sort((a, b) => b[1] - a[1])

  return {
    season: R.SEASONS[season], weather: R.WEATHERS[R.weatherOf(R.isleDay(t))], hour: R.isleHour(t),
    fish, mine, bomb, foodCost, foodName, quota, allWorkDone,
    bestJob: jobs[0]?.[0] || '无',
    // 赚的还不够口粮钱 → 不值得干
    worthWorking: jobs.length ? jobs[0][1] > foodCost * (cfg.work?.minValueRatio ?? 1.2) : false,
    empty, topCrop: topCrop ? `${R.ITEM_NAME?.[topCrop[0]] || topCrop[0]}×${topCrop[1]}` : '无',
    bestCrop: best?.name || '无',
    foodPlots: cfg.farm?.foodPlots ?? 0,
    plotN: s.plotN,
  }
}

/**
 * 主规划：返回 { actions, summary }
 */
export function planRound(world, cfg, log = () => {}, opts = {}) {
  const R = world.R
  const t = world.now
  const s = clone(world.state)
  const prices = world.prices
  // 产出型决策（选作物 / 钓鱼 / 挖矿 / 加工 / 投资）用「未来几个岛日均价」而不是今天的价。
  // 这些产出不会当天卖掉，按当天价挑活会系统性选错。
  let expPrices = prices
  try {
    expPrices = M.expectedPrices(R, t, prices, {
      outlook: cfg.sell?.outlookDays ?? 3,
      external: world.externalSoldRatio || {},
    })
  } catch {}
  const actions = []
  const summary = []
  const MAX = R.WORLD.maxActions
  // 跨轮记忆（引擎传进来）：只用来抑制重复日志，不参与任何决策。
  const memo = opts.memo || {}

  let coins = world.coins
  // 被服务端拒绝过的动作类型：本轮不再尝试，避免像旧版那样刷 20 多次无效请求
  const blocked = new Set()
  /**
   * 这个失败是不是「本轮再试也没用」。
   *
   * 关键区分：额度用完 / 季节不对 / 已满 —— 封禁整类，别再刷请求。
   * 但「体力不足」绝对不能封禁：吃口粮、喝咖啡、或者后面体力回复之后
   * 同一类动作还能成功。以前把「不足」也算进去，导致体力 0 时收割失败一次，
   * 整轮的 harvest 全被封死——地里庄稼熟着收不了，正是被偷的直接原因。
   */
  const isPermanentFail = (msg) =>
    /额度|已经钓了|已经挖了|忙不过来|用完|不是这个季节|已经最大|今天帮过|已经帮/.test(msg)
  const push = (a) => {
    if (actions.length >= MAX) return false
    const key = a.a + (a.a === 'plant' ? ':' + a.c : '')
    if (blocked.has(key) || blocked.has(a.a)) return false
    const r = R.applyActions(s, [a], { t, day: R.worldDay(t), prices, coins, rand: () => 0.5 })
    const o = r.out[0]
    if (!o?.ok) {
      const msg = o?.msg || ''
      if (isPermanentFail(msg)) {
        blocked.add(key); blocked.add(a.a)
      }
      return false
    }
    coins += (o.earn || 0) - (o.spend || 0)
    actions.push(a)
    return true
  }

  const budget = () => Math.max(0, coins - (cfg.invest?.reserveCoins || 0))

  // ---------- 1. 领奖类（零成本） ----------
  const night = R.b12NightView(s, t)
  if (night.claimable) push({ a: 'nightClaim', key: night.key })
  const refund = R.b12GuardRefundQuote(s)
  if (refund > 0) push({ a: 'guardRefund' })

  // 彩票兑奖：开奖结果由服务端提供，本地并不知道中没中，
  // 所以只要手里有「已过开奖日」的票就申请兑一次，中不中由服务端判定。
  // 旧版就是这么做的——放在最前面，因为它是纯收益且零成本。
  {
    const draw = R.lottoDrawId(t)
    const expired = (s.lotto || []).filter((tk) => tk.d < draw).length
    if (expired > 0) {
      if (push({ a: 'lottoClaim' })) summary.push(`彩票兑奖 ${expired} 张`)
    }
  }

  // 防偷守家道具：地里出现过小偷记录后的 24 小时内，或设了离线时段时，
  // 续上「潮铃」（发现率 +10%）和「贝壳护具」（守家生命 +8%）。
  // 这两件是花小钱防大损：一次被偷损失往往上万，道具只要 800/1600。
  if (cfg.defense?.guardItems !== false) {
    // 地里留下小偷记录（p.sv）说明最近被偷过，之后 24 小时都值得续道具
    const stolenRecently = (s.plots || []).some((p) => p?.sv?.length)
    if (stolenRecently) world.stolenAt = t
    const want = cfg.offline?.enabled || (t - (world.stolenAt || 0) < 86400)
    if (want) {
      for (const id of [cfg.defense?.alert ?? 'guard1', cfg.defense?.combat ?? 'guard2']) {
        const item = R.GUARD_ITEMS?.[id]
        if (!item) continue
        const cur = R.b12Effect(s, item.slot, t)
        // 已有同槽位效果且还没快到期的，不重复买
        if (cur && cur.id === id && cur.until - t > 1800) continue
        if (coins - item.price < 20000) continue
        if (push({ a: 'buy', id })) summary.push(`防偷：${item.name}续 24 小时（${fmt(item.price)}）`)
      }
    }
  }

  const goals = R.dailyGoals(R.worldDay(t), s)
  for (let k = 0; k < 4; k++) {
    if (!s.cnt['goal' + k] && (s.cnt[goals[k]?.id] || 0) >= goals[k]?.n) push({ a: 'goal', k })
  }
  if (!s.cnt.goal4 && [0, 1, 2, 3].every((k) => s.cnt['goal' + k])) push({ a: 'goal', k: 4 })

  // ---------- 2. 收割 / 收产物 / 收蟹笼（成熟即收，防偷） ----------
  const weather = R.weatherOf(R.isleDay(t))
  let harvested = 0, collected = 0, trapped = 0
  const stolenParcels = []

  /**
   * 确保体力够做下一件事：不够就先吃口粮（挑最便宜的），再不行喝咖啡。
   *
   * 旧版每个农务动作前都会调 energize(cost, FARM)，重写时漏了。
   * 后果很严重：体力 0 时地熟了收不了，watchOnce 每 20 秒报一次
   * 「2 块地成熟了」→ 醒来 → 还是收不了 → 再睡，整夜死循环，
   * 而地里庄稼就那么熟着被偷。
   *
   * 农务（收/种/浇）的价值远高于口粮成本（晚收会被偷），所以这里
   * 不看「每点体力收益」，只要有口粮就吃。
   */
  const ensureEnergy = (cost, { defer = true } = {}) => {
    if (!(cost > 0)) return true
    let guard = 0
    while (s.en < cost && guard++ < 30) {
      // Just-In-Time：只差 1 点、且下一滴自然回复很快到账时，等它自己回，不吃口粮。
      // 榜一 v1.2.0 的做法（phase10 Case C）：当「等自然回复」比「吃一份口粮」便宜时就等。
      // 算一下：一块地空着 3 分钟的机会成本 ≈ 一天收益的 1/480，不到 2 D；
      // 而一口最便宜的口粮也要几百 D。所以差最后 1 点时等，明显划算。
      //
      // defer=false 用于收割：熟地多放一秒就多一秒被偷的风险，宁可吃口粮。
      if (defer && cost - s.en === 1) {
        const regenSec = R.WORLD.regen || 180
        const phase = Number(s.enT || s.now || t)
        const nextDrop = phase + (Math.floor(Math.max(0, (t - phase) / regenSec)) + 1) * regenSec
        // 下一滴在 1 个回复周期内到账（正常情况恒成立）→ 值得等，这一轮先不做
        if (nextDrop - t <= regenSec + 2) return false
      }
      // 口粮优先；体力已满时吃下去不会回体力，只能等自然回复
      const food = foodChoices(R, s, prices)[0]
      if (food && s.en < R.energyMax(s)) {
        if (!push({ a: 'eat', id: food.id, q: food.q })) break
        continue
      }
      // 咖啡可以突破上限，但每天只有 3 次，且要留足现金
      const coffeeLeft = (R.WORLD.daily.coffee || 0) - (s.cnt?.coffee || 0)
      if (coffeeLeft > 0 && cfg.energy?.coffee !== false && coins - R.WORLD.coffee.price >= Math.min(cfg.invest?.reserveCoins || 0, 50000)) {
        if (!push({ a: 'coffee' })) break
        continue
      }
      break
    }
    return s.en >= cost
  }

  for (let i = 0; i < s.plotN; i++) {
    const p = s.plots[i]
    if (!p) continue
    const auto = R.sprinkled(s, i) || weather === 1
    const st = R.cropStage(p, t, auto)
    if (st.stage === 3) {
      // 熟了必须先补体力再收：收不了的话下一轮巡检又会报「地熟了」，
      // 醒来还是收不了，整夜空转，作物就那么在树上被偷。
      if (ensureEnergy(R.WORLD.cost.harvest || 1, { defer: false }) && push({ a: 'harvest', i })) {
        harvested++
        // p.sv 是小偷记录：收获前被偷过，这块地这次只收得到 1 个
        if (p.sv?.length) stolenParcels.push(p.c)
      }
    } else if (st.stage === -1) {
      if (ensureEnergy(R.WORLD.cost.clear || 1)) push({ a: 'clear', i })
    }
  }
  if (stolenParcels.length) {
    const names = [...new Set(stolenParcels)].map((id) => R.ITEM_NAME?.[id] || id).join('、')
    summary.push(`⚠ ${stolenParcels.length} 块地在收获前被偷过（${names}），每块少收 1 个`)
    world.stolenAt = t
  }
  for (let i = 0; i < s.barn.length; i++) {
    const st = R.animalReady(s.barn[i], t)
    // 收产物不花体力（规则里没有 cost.collect），直接收
    if (st.ready) { if (push({ a: 'collect', i })) collected++ }
  }
  for (let i = 0; i < s.traps.length; i++) {
    const st = R.trapReady(s.traps[i], t, weather === 2)
    if (st.n) { if (push({ a: 'trap', i })) trapped++ }
  }
  if (harvested) summary.push(`收获 ${harvested} 块地`)
  if (collected) summary.push(`收产物 ${collected} 窝`)
  if (trapped) summary.push(`收蟹笼 ${trapped} 个`)

  // ---------- 3. 牧场：喂食 / 摸摸 / 补饲料 / 卖退休的 ----------
  const nowTs = t
  let fed = 0, petted = 0
  const hungry = []
  for (let i = 0; i < s.barn.length; i++) {
    const pen = s.barn[i]
    const stage = R.b12AnimalStage(pen, t)
    if (stage.retired) continue
    // 8 小时只是「下次喂食的最早时间」（R:632 的拒绝条件），真正会断产出的是 24 小时
    // （animalReady 里 `fed = t - a.f < 86400`）。
    // 旧版按 8 小时喂一次，等于每天多喂两次：每只 3×150 = 450 D 饲料，
    // 其中 300 D 是白花的，还多耗 2 点体力——心情（每次 +8）早就满了。
    // 留 4 小时缓冲，20 小时喂一次。
    if (t - pen.f >= ANIMAL_FEED_SEC) hungry.push(i)
    if (!s.cnt['pet' + i]) { if (push({ a: 'pet', i })) petted++ }
  }
  if (hungry.length) {
    const have = s.inv.feed?.[0] || 0
    const lack = hungry.length - have
    if (lack > 0) {
      const n = Math.min(99, lack + 5)
      if (coins >= (R.SHOP.feed.price * n)) push({ a: 'buy', id: 'feed', n })
    }
    // 喂食要 1 点体力：体力为 0 时服务端直接拒绝，白占动作名额，
    // 而且下一轮还是 0 —— 整夜一只都喂不上，动物一直饿着不产出。
    for (const i of hungry) {
      if (ensureEnergy(R.WORLD.cost.feed || 1) && push({ a: 'feed', i })) fed++
    }
  }
  if (fed) summary.push(`喂食 ${fed} 只`)
  if (petted) summary.push(`摸摸 ${petted} 只`)

  // 退休（产完最后一轮）的动物必须卖掉腾位置，否则永远占着畜栏。
  // 旧版有一轮只卖一只的写法，重写 v2 时漏了——`if (stage.retired) continue`
  // 直接把它跳过，于是畜栏满了以后再也买不了新动物。
  // 先收完最后一轮产物再卖（animalReady 还有货就先别卖）。
  //
  // **必须在喂食之后**：push({a:'sellAnimal'}) 会本地预演并把这只从 s.barn 里删掉，
  // 之后再用 hungry 里的下标就会错位——把饲料喂给隔壁格子，甚至越界。
  {
    const dead = s.barn.findIndex((pen) => {
      const st = R.b12AnimalStage(pen, t)
      return st.retired && !R.animalReady(pen, t).ready
    })
    if (dead >= 0) {
      // 名字要在 push 之前取：push 会本地预演，s.barn 里这只已经没了
      const deadName = R.ANIMALS?.find((a) => a.id === s.barn[dead]?.k)?.name || '动物'
      if (push({ a: 'sellAnimal', i: dead })) summary.push(`卖掉退休的${deadName}，腾出畜栏`)
    }
  }

  // ---------- 4. 浇水（没有洒水器的地） ----------
  if (cfg.farm?.water && weather !== 1) {
    let watered = 0
    for (let i = 0; i < s.plotN; i++) {
      const p = s.plots[i]
      if (!p || R.sprinkled(s, i)) continue
      const st = R.cropStage(p, t)
      if (st.stage >= 0 && st.stage < 3 && p.w <= st.stage) {
        // 浇水同样要 1 点体力，先补再浇（否则整夜一桶水都打不上）
        if (ensureEnergy(R.WORLD.cost.water || 1) && push({ a: 'water', i })) watered++
      }
    }
    if (watered) summary.push(`浇水 ${watered} 块`)
  }

  // ---------- 5. 补种（逐块挑，考虑阶梯价和加工坊容量） ----------
  if (cfg.farm?.enabled) {
    const season = R.seasonOf(R.isleDay(t))
    const foodCost = foodChoices(R, s, prices)[0]?.costPerEnergy ?? 300
    // 这里传的是**体力的机会成本**，不是口粮采购价：
    // 一块地每岛日吃掉 30 多点体力，这些体力本可以拿去钓鱼（3,400+ D/点）。
    // 用口粮价（~143）折钱会让所有作物都显得稳赚，24 块地全种满，
    // 钓鱼反而一竿下不去。详见 workValuePerEnergy 的注释。
    // 产出估值用「未来几天均价」（作物会囤到峰值卖），口粮成本仍用当前价（马上要吃）。
    const soilCost = Math.max(foodCost, workValuePerEnergy(R, s, t, expPrices, cfg))
    const planner = makeCropPlanner(R, s, t, expPrices, cfg, weather, soilCost)

    // --- 口粮地该留几块：旧版是**算**出来的，不是拍脑袋定死的 ---
    //
    // 体力账：所有工作额度要吃的体力 + 农务体力 − 自然回复 = 每 24 小时的缺口，
    // 再除以「一块口粮地每 24 小时净回多少体力」。
    // 线上硬编码 4 块时 24 块地全拿来种口粮都填不满：钓鱼 80×4、挖矿 100×3、
    // 炸矿 10×6 加起来 680 点/岛日 = 4,080 点/天，自然回复只有 480 点，
    // 4 块番茄地净产约 1,900 点 —— 缺口 1,700 点全在啃库存，迟早吃空。
    //
    // cfg.farm.foodPlots 变成**下限**：用户显式设了就至少种这么多。
    const defMode = (s.plotN > 0 && (R.sprinkled(s, 0) || weather === 1)) ? 'auto'
      : (s.plots.find(Boolean) ? planner.modeOf(s.plots.findIndex(Boolean)) : (cfg.farm?.water ? 'manual' : 'none'))
    const foodPick = planner.pick(defMode, true)
    const cashPick = planner.pick(defMode, false)
    const perPlotEnergy = foodPick?.value || 0
    let needTotal = cfg.farm.foodPlots || 0
    if (perPlotEnergy > 1) {
      const W = R.WORLD
      const workE = (cfg.work?.fish ? (W.daily.fish || 0) * (W.cost.fish || 0) : 0) +
        (cfg.work?.mine ? (W.daily.mine || 0) * (W.cost.mine || 0) : 0) +
        (cfg.work?.bomb ? (W.daily.bomb || 0) * (W.cost.bomb || 0) : 0)
      // 一自然日有几个岛日：长夜时钟只走 08:00–22:00，所以是 3.5 个（见 isleDaysPerDay）。
      // 旧版按 86400/ISLE_SPAN 算成 6 个，工作体力需求被高估 71%：
      // 钓鱼 80×4 + 挖矿 100×3 + 炸矿 10×6 = 680 点/岛日，乘 6 是 4,080 点/天，
      // 自然回复才 480 点 —— 口粮地从正确的 6 块被推到 12 块，占掉一半能卖钱的地。
      const islePerDay = isleDaysPerDay(R)
      const farmE = (s.plotN || 0) * (cashPick?.cy?.energy || 0)
      const regenPerDay = 86400 / (W.regen || 180)
      const demand = workE * islePerDay + farmE - regenPerDay * 0.9
      needTotal = Math.max(needTotal, Math.ceil(Math.max(0, demand) / perPlotEnergy))
    }
    needTotal = Math.min(needTotal, s.plotN || needTotal)

    // 口粮库存越充足，要种的口粮地越少（旧版 economy() 的插值）：
    //   库存 ≤ reserveE     → 按满额种（缺口全补）
    //   库存 ≥ reserveEnergy → 只保留下限 foodPlots
    // 没有这一层的话，库存攒满也照样种 10 块口粮地，白白占掉能卖钱的地。
    {
      const lo = cfg.energy?.reserveE ?? 600
      const hi = Math.max(lo + 1, cfg.energy?.reserveEnergy ?? 2500)
      // 库存折算体力要用 full（整份），不是 restore（被当前缺口截断的）。
      const stockE = foodChoices(R, s, prices).reduce((a, f) => a + f.n * (f.full ?? f.restore), 0)
      const ratio = Math.max(0, Math.min(1, 1 - (stockE - lo) / (hi - lo)))
      needTotal = Math.max(cfg.farm.foodPlots || 0, Math.ceil(needTotal * ratio))
    }

    // --- 已经在长的作物先分类：前 needTotal 块口粮作物算口粮，其余计入销售产量 ---
    //
    // 旧版就是这么分的，v2 把这一层丢了——所有在长的都 planner.add()，
    // 于是「要吃掉的口粮」被当成「今天能卖的货」计了收入。
    // 后果：planner 觉得番茄特别赚 → 继续种番茄 → 但那些番茄全被吃掉，
    // 卖货清单上又挂着它们 → 真的卖掉一部分 → 口粮库存塌方。
    const foodCropId = foodPick?.crop?.id
    let foodGrowing = 0
    for (let i = 0; i < s.plotN; i++) {
      const p = s.plots[i]
      if (!p) continue
      const st = R.cropStage(p, t, R.sprinkled(s, i) || weather === 1)
      if (st.stage < 0) continue
      // 已经在长的口粮作物占用口粮名额，不算「可卖的产量」
      if (p.c === foodCropId && foodGrowing < needTotal) { foodGrowing++; continue }
      planner.add(p.c, planner.modeOf(i))
    }

    const empty = []
    for (let i = 0; i < s.plotN; i++) if (!s.plots[i]) empty.push(i)
    if (empty.length) {
      // 指定了偏好作物就用它，否则逐块挑
      const prefer = cfg.farm.preferCrop
        ? R.CROPS.find((c) => c.id === cfg.farm.preferCrop && c.seasons.includes(season))
        : null
      // 还要种几块口粮：总数减去已经在长的
      const foodCount = Math.min(empty.length, Math.max(0, needTotal - foodGrowing))
      const plantedNames = {}
      let planted = 0, skippedOffline = 0, failedPlant = 0
      empty.forEach((i, idx) => {
        const mode = planner.modeOf(i)
        const wantFood = idx < foodCount
        let pick = prefer
          ? { crop: prefer, value: 1 }
          : planner.pick(mode, wantFood)
        if (!pick || (!wantFood && !(pick.value > 0))) return
        // 离线时段避让：成熟时刻落在没人收菜的时段里就会被偷，换一种或干脆空着
        if (!wantFood && cfg.offline?.enabled && ripensWhileOffline(cfg, t, pick.crop.grow, pick.crop.regrow, mode === 'auto')) {
          const alt = planner.pick(mode, false)
          if (!alt || alt.crop.id === pick.crop.id) { skippedOffline++; return }
          pick = alt
        }
        // 种植要 2 点体力，不够就是失败——这跟「判断不划算主动留空」是两回事。
        //
        // 空地必须尽快补种（榜一 v1.2.0 的「harvest-replant continuity」）：
        // 一块地空着，这一茬就少收；而我们以前只在**收割**前补体力（ensureEnergy），
        // 种植这一段是饿着的——体力被收割吃干后，补种就一直失败，
        // 线上日志里反复出现「还有 N 块空地：体力不够种，下轮再来」，
        // 下一轮又会先被收割占掉体力，于是空地一拖就是几个岛日。
        //
        // 只有 pick 已经判定为「有正收益」（或口粮地）时才走到这里，
        // 所以吃口粮换取这 2 点体力是算得过来的。
        const plantCost = R.WORLD.cost.plant || 2
        if (s.en < plantCost && !ensureEnergy(plantCost)) { failedPlant++; return }
        if (!push({ a: 'plant', i, c: pick.crop.id })) { failedPlant++; return }
        planted++
        plantedNames[pick.crop.name] = (plantedNames[pick.crop.name] || 0) + 1
        planner.add(pick.crop.id, mode)
        // 手动浇水的地：种下后立刻浇一次（旧版 waterAll(i)）。
        // 不浇的话要等下一轮巡视，白白少一次浇水——品质和成熟时间都跟着差。
        // 种完那 2 点体力已经花掉了，这里要再补 1 点才浇得动（否则一直失败）。
        if (mode === 'manual' && ensureEnergy(R.WORLD.cost.water || 1)) push({ a: 'water', i })
      })
      if (planted) {
        const parts = Object.entries(plantedNames).map(([n, k]) => `${n}×${k}`).join('、')
        summary.push(`补种 ${planted} 块（${parts}${foodCount ? `，其中口粮 ${Math.min(foodCount, planted)} 块` : ''}）`)
      }
      if (skippedOffline) summary.push(`  离线避让：${skippedOffline} 块先空着（种什么都赶在离线时段成熟）`)
      // 主动留空的地要说清原因，否则日志里「24 块只种 4 块」看起来像 bug
      const heldEmpty = empty.length - planted - skippedOffline - failedPlant
      if (failedPlant) summary.push(`  还有 ${failedPlant} 块空地：体力不够种（每块要 ${R.WORLD.cost.plant || 2} 点），等体力回复后补种`)
      if (heldEmpty > 0 && !prefer) {
        summary.push(`  留空 ${heldEmpty} 块：一块地每岛日要吃 30 多点体力，` +
          `这些体力拿去钓/挖/炸能赚 ${fmt(soilCost)} D/点，种地回不了本`)
      }
    }
  }

  // ---------- 6. 投资（只买 5 天内回本的） ----------
  if (cfg.invest?.enabled && opts.allowInvest !== false) {
    const inv = planInvestments(R, s, expPrices, coins, cfg, t)
    // 单次规划最多买 maxPerRound 项。所有候选都是同一时刻估出来的，
    // 一次全买等于把同一个判断重复下注；分开到后续巡视，规则变了还能停手。
    const maxInv = Math.max(1, cfg.invest?.maxPerRound ?? 1)
    let invested = 0
    for (const it of inv) {
      if (invested >= maxInv) break
      if (coins < it.cost + (cfg.invest.reserveCoins || 0)) continue
      if (push(it.action)) {
        invested++
        summary.push(`投资：${it.name}（${fmt(it.cost)}，约 ${it.payback.toFixed(1)} 天回本）`)
      }
    }
  }

  // ---------- 7. 加工：候选交给体力背包 ----------
  //
  // 加工同样是「花体力换毛利」，必须和钓鱼/挖矿/炸矿竞争同一份体力。
  // 以前是先无条件加工、再把剩下的体力交给背包——毛利低的配方会白白抢走
  // 钓鱼的体力。现在这里只算「当前库存能支撑几件」并登记成背包候选，
  // 由第 8 段的 DP 按单位体力收益统一挑选。
  //
  // 配方链（金锭 → 钻石王冠）在这里递归展开成「基础材料需求 + 工序数」，
  // 和榜一的做法一致。不展开的话第一轮永远看不到王冠：它的原料金锭库存是 0，
  // 会被低毛利配方先把加工额度吃满，王冠得等下一轮才做得出来。
  // 一件王冠算 2 点体力、2 件加工额度（先做金锭再做王冠）；
  // 库存里已有的中间品会先被用掉，那批只算 1 点体力、1 件额度。
  let craftUnits = []
  if (cfg.craft?.enabled) {
    const W = R.WORLD
    const left = W.daily.craft - ((s.iq?.d === R.isleIndex(t) ? s.iq.craft : 0) || 0)
    const maxRound = Math.min(Math.max(0, left), cfg.craft.maxPerRound || 20)
    const haveQ = (id, q) => R.b12Available(s, id, q)
    // 只用普通(0)和银星(1)做原料，金星(2)留着直接卖。
    // 旧版就是这么做的，重写 v2 时漏了：金星单价 ×1.5，
    // 加工成成品反而亏（成品不区分品质，一份成品只值一份价钱）。
    // 另外还要扣掉「口粮预留」——那部分是要吃的，不能拿去加工，
    // 否则体力回不上来，地里的庄稼就收不了。
    //
    // 留多少：cfg.energy.reserveE（旧版的「口粮底线」，默认 600 点体力当量）。
    // 以前这里用的是 reserveEnergy（2500）——那是「攒到这个数就不再买」的上限，
    // 不是「必须留」的底线。拿上限当底线会把几乎所有口粮锁死，
    // 加工坊反而没原料可用。
    const foodReserve = {}
    {
      let need = cfg.energy?.reserveE ?? 600
      for (const f of foodChoices(R, s, prices)) {
        if (need <= 0) break
        // 必须用 full 而不是 restore：restore 被「当前还能吃多少」截断，
        // 体力一满就是 0，`Math.max(1, 0)` 会让 take=600，把库存全锁成口粮。
        const per = Math.max(1, f.full ?? f.restore)
        const take = Math.min(f.n, Math.ceil(need / per))
        ;(foodReserve[f.id] ||= [0, 0, 0])[f.q] = take
        need -= take * per
      }
    }
    const freeQ = (id, q) => Math.max(0, haveQ(id, q) - (foodReserve[id]?.[q] || 0))
    const have = (id) => freeQ(id, 0) + freeQ(id, 1)
    // 原料的机会成本要按「实际会扣掉哪个品质」算。
    //
    // 服务端扣料是从 q0 开始、用完再扣 q1（R:773 的 for q=0..2 + invTake），
    // 而 we 只拿 q0/q1 做原料（金星留着卖，见 have()）。洒水器地 w=3 时
    // 银星概率 0.44、普通只有 0.21 —— 也就是说池子里大半是银星，
    // 旧版一律按 `prices[id]`（普通价）记账，加工利润被高估 15~20%。
    const matPrice = (id) => {
      const n0 = freeQ(id, 0), n1 = freeQ(id, 1), tot = n0 + n1
      const p0 = prices[id] || 0
      if (tot <= 0) return p0
      return (n0 * p0 + n1 * p0 * (R.QUALITY?.[1] ?? 1.25)) / tot
    }
    // 原料按现价算（今天就要消耗掉），产品按未来均价算（做好要囤到峰值才卖）
    const recipeById = new Map(R.RECIPES.map((r) => [r.id, r]))
    // expand：把配方展开成每件成品的「基础材料需求 + 工序数 + 工序顺序」。
    // 工序顺序是基础 → 成品，提交时照这个顺序做。
    const expand = (r, depth = 0) => {
      let cost = 0
      let steps = 1
      const need = {}
      const plan = []
      for (const [id, k] of Object.entries(r.in)) {
        const sub = depth < 3 ? recipeById.get(id) : null
        if (sub) {
          const b = expand(sub, depth + 1)
          cost += b.cost * k
          steps += b.steps * k
          for (const [bid, bk] of Object.entries(b.need)) need[bid] = (need[bid] || 0) + bk * k
          for (const st of b.plan) plan.push({ id: st.id, n: st.n * k })
        } else {
          cost += matPrice(id) * k
          need[id] = (need[id] || 0) + k
        }
      }
      plan.push({ id: r.id, n: 1 })
      return { cost, steps, need, plan }
    }
    // 按「每点体力的毛利」排序：配方链要花多道工序，只比绝对毛利会高估它。
    const ranked = R.RECIPES.filter((r) => r.price).map((r) => {
      const b = expand(r)
      const salePrice = expPrices[r.id] || prices[r.id] || r.price
      return { r, margin: salePrice - b.cost, steps: b.steps, need: b.need, plan: b.plan }
    }).filter((x) => x.margin > 0).sort((a, b) => b.margin / b.steps - a.margin / a.steps)
    // 虚拟扣库存：同一批材料不能同时算给两个配方。
    const virt = {}
    const haveV = (id) => Math.max(0, have(id) - (virt[id] || 0))
    // 中间品（金锭这类本身也是加工品的东西）：库存够就直接用，不必再造。
    const craftable = new Set(R.RECIPES.map((r) => r.id))
    const addUnit = (r, gain, cost, plan, variant) => craftUnits.push({
      key: 'craft:' + r.id + ':' + variant,
      craftId: r.id,
      variant,
      name: r.name,
      cost,
      gain,
      plan,
      act: { a: 'craft', id: r.id, n: 1 },
    })
    // quota 按「件数」计（站点额度就是这么扣的）：王冠一件要占 2 件额度。
    let quota = 0
    for (const e of ranked) {
      if (quota >= maxRound) break
      const capByQuota = Math.floor((maxRound - quota) / e.steps)
      const subs = Object.entries(e.r.in).filter(([id]) => craftable.has(id))
      // 批次 A：库存里已有的中间品直接用（1 点体力、1 件额度）。
      let nStock = 0
      if (subs.length) {
        const capByStock = Math.min(...subs.map(([id, k]) => Math.floor(haveV(id) / k)))
        const raws = Object.entries(e.r.in).filter(([id]) => !craftable.has(id))
        const capByRaw = raws.length
          ? Math.min(...raws.map(([id, k]) => Math.floor(haveV(id) / k)))
          : capByQuota
        nStock = Math.max(0, Math.min(capByQuota, capByStock, capByRaw))
      }
      if (nStock > 0) {
        // 中间品（金锭这类）都是 q0，按市价算机会成本即可；
        // 原始原料按实际会扣的品质加权（见 matPrice）。
        const costNow = Object.entries(e.r.in)
          .reduce((a, [id, k]) => a + (craftable.has(id) ? (prices[id] || 0) : matPrice(id)) * k, 0)
        const marginNow = (expPrices[e.r.id] || prices[e.r.id] || e.r.price) - costNow
        // 中间品按市场价计机会成本后仍不赚钱 → 这批不做，额度让给下面自造的那批。
        if (marginNow > 0) {
          for (const [id, k] of Object.entries(e.r.in)) virt[id] = (virt[id] || 0) + k * nStock
          quota += nStock
          for (let i = 0; i < nStock; i++) addUnit(e.r, marginNow, W.cost.craft || 1, [{ id: e.r.id, n: 1 }], 'stock')
        } else nStock = 0
      }
      // 批次 B：余下的自己造中间品（工序数与基础材料都按全链算）。
      const capByMat = Math.min(
        ...Object.entries(e.need).map(([id, k]) => Math.floor(haveV(id) / k)),
      )
      const n = Math.max(0, Math.min(capByQuota - nStock, capByMat))
      if (n <= 0) continue
      for (const [id, k] of Object.entries(e.need)) virt[id] = (virt[id] || 0) + k * n
      quota += n * e.steps
      for (let i = 0; i < n; i++) addUnit(e.r, e.margin, (W.cost.craft || 1) * e.steps, e.plan, 'chain')
    }
  }

  // ---------- 8. 花体力做最高收益的事（钓/挖/炸/加工） ----------
  //
  // 三处「往后看一眼」的判断：
  //   keep   —— 马上要熟的地，先把收获体力留出来，别全花在钓鱼上
  //   fishOK —— 钓鱼有时段，低谷期不钓，等最佳时段
  //   背包   —— 钓鱼/挖矿/炸矿/加工的单位收益不同、额度与现金约束不同，
  //             用有界背包一次求出最优组合（见 core/stamina-dp.mjs），
  //             再和口粮成本曲线比一次，决定吃多少口粮。
  if (cfg.work) {
    const W = R.WORLD
    // 口粮是立刻消耗掉的，按现价算成本
    const eatCost = foodChoices(R, s, prices)[0]?.costPerEnergy ?? 300
    const reserve = Math.max(0, cfg.energy?.minEnergyToLeave ?? 0)

    // --- 收获体力预留 ---
    //
    // 这是「防偷」的核心，但预留的窗口不能取太长。
    //
    // 旧口径是「keepWindow（40 分钟）内所有要熟的地」，注释里写的是
    // 「体力全花在钓鱼上，之后陆续成熟的地一块块熟着没体力收——必被偷」。
    // 那个 bug 的真实原因是 **keep 被口粮冲抵成了 0**，不是窗口取小了，
    // 所以口径改成 40 分钟后问题并没解决，反而引入了新的死锁：
    // 线上 24 块番茄错峰成熟，40 分钟内总有 24 块要熟 → keep=24，
    // 而吃一个口粮只回 12 点，`en + 12 − 24 < 4` 永远不成立，
    // 第 8 段一次也走不到钓鱼——实测一整天钓鱼额度 0/80。
    //
    // 正确的窗口是「这一竿花掉的体力要多久才能靠自然回复补回来」：
    // 花 4 点要回 720 秒，只需要预留这 720 秒内会熟的地。
    // 再往后的靠自然回复 + ensureEnergy 现场吃口粮来兜，不需要提前锁体力。
    const regen = W.regen || 180
    const workCost = Math.max(W.cost.fish || 0, W.cost.mine || 0, W.cost.bomb || 0)
    const keepWindow = Math.max(workCost, 1) * regen
    const ripeSoon = []
    let matureCount = 0
    for (let i = 0; i < s.plotN; i++) {
      const p = s.plots[i]
      if (!p) continue
      const auto = R.sprinkled(s, i) || weather === 1
      const st = R.cropStage(p, t, auto)
      // 已经熟的（stage 3）这一轮就会被收掉，由 ensureEnergy 处理，不用预留
      if (st.stage === 3) { matureCount++; continue }
      if (st.stage >= 0 && st.left < keepWindow) ripeSoon.push(i)
    }
    // 每块要熟的地预留 1 点收割体力。
    //
    // 这里**不**用「库存口粮」来打折。以前写的是
    //   keep = needForRipe - floor(foodEnergy / 2)
    // 实测被算成 0：刚收完 3 块地，库存折合 78 点体力，减半后 39 远大于
    // 要预留的 3 点，keep 直接归零。于是 100 点体力全砸进钓鱼，
    // 剩 3 块 48 秒后熟，一块都没体力收。
    // 口粮当保险可以，当账面上的「已覆盖」不行——它随时可能被卖掉、
    // 被加工吃掉，或者在别的动作里消耗掉。
    //
    // 上限取体力上限的一半：地再多也不能把体力全锁死，否则钓/挖/炸没法做。
    // 每块要熟的地不但要留收割的 1 点，还要留补种的 2 点
    // （榜一 v1.2.0 的 harvest-replant continuity：收完立刻补种，地不能空着）。
    // 以前只留收割的 1 点，收完地体力见底，补种又得现吃口粮，
    // 中间空出来的那段时间就是纯损失——线上日志里反复出现
    // 「还有 N 块空地：体力不够种（每块要 2 点），下轮再来」。
    const replantCost = cfg.farm?.enabled ? (W.cost.plant || 2) : 0
    const needForRipe = ripeSoon.length * ((W.cost.harvest || 1) + replantCost)
    // 上限取体力上限的 60%（默认 140 → 84）：24 块地 × 3 点 = 72 能完整覆盖一波，
    // 又不至于把体力全锁死——旧版 keep=24 那次因为口粮抵扣写成 0 才饿死钓鱼，
    // 但反过来把上限开到 100% 同样会让钓/挖/炸一滴都分不到。
    const keepRipe = Math.min(needForRipe, Math.floor(R.energyMax(s) * 0.6))
    // 解禁前要预留的偷菜体力（engine 按 snipeStaminaReservation 算好传进来）。
    // 它和「成熟待收」的 keep 是同一本账：都是「现在不能花掉的体力」。
    // 重叠部分不能再加一遍，所以取 max 而不是相加。
    const snipeReserve = Math.max(0, Math.min(R.energyMax(s), Math.floor(Number(opts.snipeReserve) || 0)))
    const keep = Math.max(keepRipe, snipeReserve)

    // --- 补货：炸弹和鱼饵 ---
    //
    // 旧版每次巡视都会把这两样补到够用的量，重写 v2 时整段丢了。
    // 后果很直接：
    //   · 鱼饵让高价鱼出现权重 ×2、脱钩率 -8 个百分点（见 fishEV 的 boost/miss），
    //     不带饵的期望收益几乎腰斩——线上日志里「钓鱼 2,440/体力」是裸钓的数。
    //   · 炸弹用光（每天 10 个）就再也炸不了矿，10 次额度直接烂掉。
    // 两样都远便宜于它们带来的收益（炸弹 2,500 D、饵 400 D/个），
    // 所以只要能付得起就补满。
    {
      const cap = Math.min(cfg.invest?.reserveCoins || 0, 50000)
      const leftOf = (k, max) => Math.max(0, (max || 0) - ((s.iq?.d === R.isleIndex(t) ? s.iq[k] : 0) || 0))
      if (cfg.work.bomb) {
        const lack = leftOf('bomb', W.daily.bomb) - (s.inv.bomb?.[0] || 0)
        const price = R.SHOP.bomb?.price || 0
        if (lack > 0 && price > 0 && coins - lack * price >= cap) {
          if (push({ a: 'buy', id: 'bomb', n: lack })) summary.push(`买炸弹 ×${lack}（${fmt(lack * price)}）`)
        }
      }
      if (cfg.work.fish && cfg.work.bait) {
        const lack = Math.min(99, leftOf('fish', W.daily.fish)) - (s.inv.bait?.[0] || 0)
        const price = R.SHOP.bait?.price || 0
        if (lack > 0 && price > 0 && coins - lack * price >= cap) {
          if (push({ a: 'buy', id: 'bait', n: lack })) summary.push(`买鱼饵 ×${lack}（${fmt(lack * price)}）`)
        }
      }
    }

    // --- 钓鱼时段窗口 ---
    // 岛上的「小时」是现实 10 分钟一格，鱼分时段出没。当前时段收益远低于今天最好的时段时，
    // 先把竿数留着，等窗口。但快到换岛日边界（额度即将重置）时要清掉，别浪费。
    const boundaryIn = R.b12NextIsleBoundary(t) - t
    // 比较各时段的相对好坏时用「同一个价格基准」（现价），只看鱼种分布的差异。
    // 用 expPrices 会把「不同岛日价格不同」也算进去，导致同一批鱼换个时段就跨过阈值。
    const fishNowEV = cfg.work.fish ? fishEV(R, s, t, prices, false) : 0
    // 基准取「本岛日剩下的时段」里最好的，不是未来 24 小时。
    // 用全天做基准的话，一旦最好的时段已经过去，这天就再也不钓了
    // （实测出现过比值 86% 一直等、整个岛日一竿没下的情况）。
    // 旧版也是用「本岛日剩余时段」算的 fishBest。
    let fishBestEV = fishNowEV
    {
      // 只探「本岛日边界之前」的时段：跨过边界就是另一个岛日，
      // 天气可能变、季节可能变、鱼价也可能被重置，拿它当基准会得出
      // 「当前时段永远不如未来某刻」的结论，于是一竿不下。
      const hourSpan = R.ISLE_SPAN / 24
      const maxSteps = Math.max(0, Math.floor((boundaryIn - 1) / hourSpan))
      for (let h = 1; h <= Math.min(23, maxSteps); h++) {
        const probe = t + h * hourSpan
        if (R.isleIndex(probe) !== R.isleIndex(t)) break      // 保险：绝不跨岛日
        const ev = fishEV(R, s, probe, prices, false)
        if (ev > fishBestEV) fishBestEV = ev
      }
    }
    const windowRatio = cfg.work.windowRatio ?? 0.97
    const deadlineSec = cfg.work.deadlineSec ?? 1200
    // 窗口只在「体力足够吃完当天额度」时才有意义。
    //
    // 它的本意是「低谷期别把额度浪费掉，留给高峰」。但如果体力根本吃不满额度，
    // 等着就是纯亏：额度随岛日作废，而省下的体力只会在上限里溢出浪费。
    // 线上实测：晴天的岛日里 00-05 点比值 88%、06-11 点 85%，
    // 阈值 93% 把前 12 个岛小时全判成「等最佳」——半个岛日一竿不下，
    // 而剩 80 次额度需要 320 点体力，自然回复一整个岛日只有 80 点，永远吃不满。
    const fishUsed = (s.iq?.d === R.isleIndex(t) ? s.iq.fish : 0) || 0
    const fishLeftQ = Math.max(0, (W.daily.fish || 0) - fishUsed)
    const regenLeft = Math.floor(Math.max(0, boundaryIn) / regen)
    const canFinishQuota = s.en + regenLeft >= fishLeftQ * (W.cost.fish || 4)
    // 长夜（22:00–08:00）岛钟暂停、额度不刷新，但**体力照常按现实时间回复**，
    // 站点规则也不禁止下竿（同一时段挖矿一直在正常跑，额度照样扣）。
    // 以前这里整个长夜禁钓，10 小时白回约 200 点体力全在上限里溢出，
    // 面板上「钓鱼 0/80」一整天不动就是这么来的。
    // 长夜里鱼池按冻结的岛钟选鱼，不是最优时段，但体力本来就是白来的。
    const fishOK =
      (fishNowEV >= fishBestEV * windowRatio || boundaryIn < deadlineSec || !canFinishQuota)

    // --- 体力分配：有界背包 + 跨时段 Bellman（移植自榜一） ---
    //
    // 旧版是贪心：按 D/体力 排序、能付就做、够不着就退而求其次。边界上会选错——
    // 体力 5 点时先做 3 点的挖矿，4 点的钓鱼就永远差 1 点，而正确解可能是
    // 少挖一次换成钓鱼。榜一把所有「体力换钱」的活展开成单位物品做背包：
    //   · 钓鱼：分「库存鱼饵」「无鱼饵」两档收益（带饵贵鱼权重 ×2、脱钩率 −8 个点）；
    //   · 挖矿：额度封顶；
    //   · 炸矿：额度、炸弹库存、矿层封顶；
    //   · 加工：按配方毛利，受加工额度与原料库存封顶（候选由第 7 段生成）。
    //
    // 背包之上还有一层 Bellman（榜一的 evalWholeIsleObjective）：体力不是
    // 「这一轮的钱」，而是「到岛日边界前能花掉多少 + 剩下的会带到下一岛日」。
    // 现有体力能做的活本轮就做（免费资源，不做会在上限里溢出）；额外吃口粮
    // 补出来的部分，则按整岛日额度 + 未来自然回复 + 下一岛日工价一起定价。
    const iqUsed = (k) => ((s.iq?.d === R.isleIndex(t) ? s.iq[k] : 0) || 0)
    const fishLeft = cfg.work.fish && fishOK ? Math.max(0, W.daily.fish - iqUsed('fish')) : 0
    const mineLeft = cfg.work.mine ? Math.max(0, W.daily.mine - iqUsed('mine')) : 0
    const bombLeft = cfg.work.bomb ? Math.max(0, W.daily.bomb - iqUsed('bomb')) : 0
    const haveBait = Math.max(0, Math.floor(s.inv?.bait?.[0] || 0))
    const haveBomb = Math.max(0, Math.floor(s.inv?.bomb?.[0] || 0))
    const pickFloor = Math.min(s.mine.max, R.PICK_FLOOR[s.tools.pick])
    const mineVal = mineLeft > 0 ? mineEV(R, s, expPrices, false, t) : 0
    const canDeeper = s.mine.max < R.PICK_FLOOR[s.tools.pick]
    // 炸矿只吃「炸药 + 6 点体力」，不吃挖矿额度：规则里 `s.cnt.mine += 6` 只是统计，
    // 不写 iq.mine（R:783）。旧版加了 mineLeft>=6 的门槛，挖矿额度剩 <6 时一次不炸，
    // 一天最多 10 次（约 11 万 D）被白白放弃。
    let bombVal = bombLeft > 0 && haveBomb > 0 ? mineEV(R, s, expPrices, true, t) : 0
    // 镐子还能到更深的层时，炸矿的价值至少按「口粮成本 ×2」算：
    // 下潜解锁的新矿层是长期收益，不能因为当下这层矿不值钱就永远不下去。
    if (bombVal > 0 && canDeeper) bombVal = Math.max(bombVal, (W.cost.bomb || 1) * (eatCost || 0) * 2)
    const fishValBait = fishLeft > 0 && cfg.work.bait ? fishEV(R, s, t, expPrices, true) : 0
    const fishValNoBait = fishLeft > 0 ? fishEV(R, s, t, expPrices, false) : 0
    // 单位体力的毛收益要明显高于口粮成本才值得排进背包（旧版同一条门槛）。
    // 背包会自己比较「做」和「等自然回复」，但「连现有体力也不该浪费在这上面」
    // 需要这条下限——否则矿价低谷时会用免费体力去做几乎不赚钱的活。
    const minV = eatCost * (cfg.work.minValueRatio ?? 1.2)

    const units = [...craftUnits]
    if (fishLeft > 0) {
      // 带饵只在「真能提高期望收益」时才用：库存饵是免费的，但 fishEV 里
      // 仍按 400 D/个扣成本，所以低价鱼池时带饵反而更差，这时不用饵。
      let nBait = (cfg.work.bait && haveBait > 0 && fishValBait > fishValNoBait)
        ? Math.min(fishLeft, haveBait) : 0
      if (nBait > 0 && !(fishValBait / W.cost.fish > minV)) nBait = 0
      if (nBait > 0) {
        for (let i = 0; i < nBait; i++) units.push({ key: 'fish-bait', cost: W.cost.fish, gain: fishValBait, act: { a: 'fish', bait: true } })
      }
      const nNo = fishLeft - nBait
      if (nNo > 0 && fishValNoBait / W.cost.fish > minV) {
        for (let i = 0; i < nNo; i++) units.push({ key: 'fish', cost: W.cost.fish, gain: fishValNoBait, act: { a: 'fish', bait: false } })
      }
    }
    if (mineLeft > 0 && mineVal / W.cost.mine > minV) {
      for (let i = 0; i < mineLeft; i++) units.push({ key: 'mine', cost: W.cost.mine, gain: mineVal, act: { a: 'mine', f: pickFloor } })
    }
    if (bombLeft > 0 && bombVal / W.cost.bomb > minV) {
      const n = Math.min(bombLeft, haveBomb)
      for (let i = 0; i < n; i++) units.push({ key: 'bomb', cost: W.cost.bomb, gain: bombVal, act: { a: 'bomb', f: pickFloor } })
    }

    // 口粮成本曲线：costAt[d] = 额外提供 d 点体力最少要花多少 D（按最便宜的顺序吃）。
    //
    // 注意这里按「额外点数」而不是「补到多少体力」建表：体力上限只限制
    // **当前值**，不限制**累计消耗**。一堆活可以边花边吃——体力降到 12 时
    // 吃一份回到 24，继续干活。所以总预算 = 现有体力 + 全部口粮能提供的点数。
    // 以前按「先吃到上限」建模，满体力时最多只能规划 160−keep 点体力，
    // 反而比旧贪心（边花边吃，能多干 2~3 件）做得少。
    const enNow = Math.floor(s.en)
    // 体力上限附近的口粮本来要先吃几口才腾得出空间，但整轮规划算的是
    // 「边花边吃」能榨出多少体力——所以这里一律用未截断的 full。
    // 以前靠 `Object.create(s); probe.en = -1e9` 来绕过截断，
    // 现在 foodChoices 自带 full，不用再造假状态了。
    const src = []
    for (const f of foodChoices(R, s, prices)) {
      const per = f.full ?? f.restore
      if (!(per > 0)) continue
      const usable = Math.min(f.n, f.limit ?? f.n)
      for (let k = 0; k < usable; k++) src.push({ restore: per, unit: f.unit, act: { a: 'eat', id: f.id, q: f.q } })
    }
    const coffee = R.WORLD.coffee || {}
    const coffeeLeft = Math.max(0, (R.WORLD.daily?.coffee || 0) - (s.cnt?.coffee || 0))
    if (cfg.energy?.coffee !== false && coffeeLeft > 0 && (coffee.price || 0) > 0 && (coffee.energy || 0) > 0) {
      const cashLeft = Math.max(0, coins - Math.min(cfg.invest?.reserveCoins || 0, 50000))
      const nCup = Math.min(coffeeLeft, Math.floor(cashLeft / coffee.price))
      for (let k = 0; k < nCup; k++) src.push({ restore: coffee.energy, unit: coffee.price, act: { a: 'coffee' } })
    }
    src.sort((a, b) => a.unit / a.restore - b.unit / b.restore)
    let maxEat = 0
    for (const f of src) maxEat += f.restore
    const costAt = new Float64Array(maxEat + 1).fill(Infinity)
    // cntAt[d]：提供 d 点要消耗几份（口粮/咖啡）。一份 = 一条动作，
    // 而一轮最多 40 条动作（R.WORLD.maxActions），所以选体力上限时
    // 必须把「吃/喝」占掉的槽位算进去，否则会规划出提交不完的组合。
    const cntAt = new Int32Array(maxEat + 1).fill(1 << 20)
    costAt[0] = 0
    cntAt[0] = 0
    {
      let covered = 0
      let cost = 0
      let cnt = 0
      for (const f of src) {
        const from = covered
        covered += f.restore
        cost += f.unit
        cnt++
        for (let d = from + 1; d <= covered; d++) {
          costAt[d] = cost
          cntAt[d] = cnt
        }
      }
    }

    const totalWorkCost = units.reduce((a, u) => a + u.cost, 0)
    const cashCap = Math.max(0, coins - Math.min(cfg.invest?.reserveCoins || 0, 50000))
    const availEn = Math.max(0, enNow - keep)
    const enCap = Math.max(0, Math.min(totalWorkCost, enNow + maxEat - keep))
    const dp = allocateStamina(units, { enCap, cashCap })
    // 选 e 时同时检查动作槽位：DP 的一件活 = 一条动作，吃一份口粮也是
    // 一条动作。旧贪心先按 40 条上限停手，DP 不知道这个上限，会算出
    // 「吃 12 份、钓 26 竿」这种被截断的方案，反而比吃 9 份钓 29 竿差。
    // DP 里的一件活 = 一条动作；但同一配方的加工可以合并成一条
    //（服务端 n ≤ 20）。槽位估算必须按合并后的条数算，
    // 否则 20 件加工会被当成 20 条动作，白白放弃本来放得下的组合。
    const actCountOf = (sel) => {
      const byCraft = new Map()
      let n = 0
      for (const u of sel) {
        if (u.craftId) {
          const k = u.craftId + ':' + u.variant
          const g = byCraft.get(k) || { n: 0, steps: u.plan?.length || 1 }
          g.n++
          byCraft.set(k, g)
        } else n++
      }
      for (const g of byCraft.values()) n += Math.ceil(g.n / 20) * g.steps
      return n
    }
    const slotLeft = Math.max(0, MAX - actions.length)
    // ---------- Bellman：把体力摊到整个岛日估值（移植自榜一 evalWholeIsleObjective） ----------
    //
    // 只按「手上的体力」求背包最大值会犯两个错：
    //   · 现在不花，到岛日边界的自然回复会钳在体力上限里白白蒸发；
    //   · 吃口粮补出来的体力，若超出本岛日剩余额度能消化的量，只值
    //     「下一个岛日最好的活」，不该按今天的边际收益估价。
    // 榜一的解法是两条背包曲线：一条按「本轮可达体力」（ksLocal），一条按
    // 「整岛日剩余额度 × 体力成本」（ksIsle），再把两者拼起来求值：
    //   本岛日能花的 = 本轮已花的 e + 到边界前还能回复的量（受上限钳制）；
    //   到边界时剩下的存量 = 结束余量 + 回复（封顶上限），扣掉本岛日实际
    //   做掉的量，剩下的才按下一岛日工价计入。
    // 于是「现在吃口粮」只有在「未来回复做不完额度」时才划算——白来的回复
    // 优先于花钱的口粮，这正是旧两段式 if 想表达却表达不准的东西。
    const enMax = R.energyMax(s)
    const coffeeCpe = (coffee.price || 15000) / Math.max(1, coffee.energy || 60)
    // 下一个岛日的边际体力价值 = 下一岛日最好的单位收益，且不超过咖啡单价
    //（超过就该明天直接喝咖啡，今天囤体力没有额外价值）。
    const nextIsleValuePerEn = (() => {
      let best = 0
      if (fishLeft > 0) best = Math.max(best, fishValNoBait / W.cost.fish)
      if (mineLeft > 0) best = Math.max(best, mineVal / W.cost.mine)
      if (bombLeft > 0) best = Math.max(best, bombVal / W.cost.bomb)
      for (const u of craftUnits) best = Math.max(best, u.gain / u.cost)
      return Math.min(best, coffeeCpe)
    })()
    // 整岛日能消化的体力：本轮可用 + 可吃的 + 到边界前的自然回复。
    const isleCapEn = Math.max(0, Math.min(totalWorkCost, enNow + maxEat + Math.max(0, regenLeft) - keep))
    const dpIsle = isleCapEn > dp.E ? allocateStamina(units, { enCap: isleCapEn, cashCap }) : dp
    // 本轮花 e 点、补 d 点体力之后，本岛日能兑现的总价值。
    //
    // 这里有两个「体力池」要分清：
    //   · 本岛日能花的 = 已经花的 e + 到边界前能回复的量（回复受上限钳制）；
    //   · 到边界时身上剩下的 = 本轮结束余量 + 回复（封顶上限），扣掉本岛日
    //     实际做掉的那些，剩下的才会带到下一个岛日。
    // 早期版本把「回复量」直接塞进 carry（cov − 额度），等于把同一批回复
    // 既算成今天的活、又算成明天的钱——体力 0、额度只有 13 下时，程序会
    // 推出「吃口粮划算」而去买一份根本做不了几下的口粮。改成按边界存量
    // 算 carry 之后，回复够用的场景自然回到「等它自己回」。
    const isleValue = (e, d) => {
      const leftAfter = Math.max(0, enNow + Math.max(0, d) - e)
      const futureUsable = Math.min(Math.max(0, regenLeft), Math.max(0, enMax - leftAfter))
      const used = Math.min(dpIsle.E, e + futureUsable)
      const stockAtBoundary = Math.min(enMax, leftAfter + Math.max(0, regenLeft))
      const carry = Math.max(0, stockAtBoundary - used)
      return dpIsle.bestAtMost[used] + carry * nextIsleValuePerEn
    }
    // 基底：体力是免费的、还会在体力上限里溢出，所以现有体力能做的活
    // 本轮就做掉（早做早完成）。这一步不看 Bellman，和榜一的 ksLocal
    // 一样，先把「本轮可达体力」的收益钉成基线；Bellman 只用来判断
    // 「额外吃口粮/喝咖啡补出来的体力」值不值。
    let bestE = 0
    for (let e = Math.min(availEn, dp.E); e >= 0; e--) {
      if (actCountOf(dp.reconstructAt(e)) > slotLeft) continue
      bestE = e
      break
    }
    // 升级判定：baseVal 已经把「到边界前的自然回复也能做活」算进去了，
    // 所以未来回复够用时增量约为 0，不会花钱买口粮；只有回复做不完
    // 剩余额度（或现在做比留到明天更值）时，补体力才有正增量。
    const baseVal = isleValue(bestE, 0)
    let bestGain = 0
    for (let e = bestE + 1; e <= dp.E; e++) {
      const d = Math.max(0, e + keep - enNow)
      if (d > maxEat) continue
      const fc = costAt[d]
      if (!Number.isFinite(fc)) continue
      if (actCountOf(dp.reconstructAt(e)) + cntAt[d] > slotLeft) continue
      const net = isleValue(e, d) - baseVal - fc
      if (net > bestGain + 1e-6) {
        bestGain = net
        bestE = e
      }
    }
    // 按背包选出的组合提交，**边花边吃**：体力降到不够时就地吃一份口粮/喝咖啡。
    // 不能「先吃后花」——体力上限卡着，满体力时一口也吃不进去。
    // src 已按每点成本排好序，指针只往前走，和 costAt 的估算口径一致。
    // 单件失败（缺炸弹/矿层不够）只丢这一件，不像旧版把整类活一起否掉。
    let srcIdx = 0
    const ensureEn = (need) => {
      while (s.en < need && srcIdx < src.length) {
        if (!push({ ...src[srcIdx].act })) break
        srcIdx++
      }
      return s.en >= need
    }
    const chosen = dp.reconstructAt(bestE)
    for (let i = 0; i < chosen.length; i++) {
      const it = chosen[i]
      if (it.craftId) {
        // 同一配方的加工合并成一条动作（服务端单条最多 20 件）。
        // 配方链按 plan 的工序顺序执行：先做中间品，再做成品。
        let j = i
        while (j < chosen.length && chosen[j].craftId === it.craftId && chosen[j].variant === it.variant) j++
        const k = j - i
        const unitCost = R.WORLD.cost.craft || 1
        const steps = new Map()
        for (const st of it.plan) steps.set(st.id, 0)
        for (let x = 0; x < k; x++) for (const st of it.plan) steps.set(st.id, steps.get(st.id) + st.n)
        let stalled = false
        let done = 0
        for (const [id, total] of steps) {
          let rest = total
          while (rest > 0) {
            if (!ensureEn(unitCost)) { stalled = true; break }
            const batch = Math.min(20, Math.floor(s.en / unitCost), rest)
            if (batch <= 0 || !push({ a: 'craft', id, n: batch })) { stalled = true; break }
            rest -= batch
            if (id === it.craftId) done += batch
          }
          if (stalled) break
        }
        if (done > 0) summary.push(`加工 ${it.name}×${done}（毛利 ${fmt(it.gain * done)}）`)
        i = j - 1
        if (stalled) break
        continue
      }
      if (!ensureEn(it.cost)) break
      if (!push({ ...it.act })) break
    }
  }

  // ---------- 8.5 囤货仓库：把「等峰值更划算」的货锁起来 ----------
  if (cfg.vault?.enabled) {
    let locked = 0
    // rawInv 是「本轮开始前」的库存（world.state 没被预演过）：
    // 囤货数量不能超过服务端此刻真正的库存，否则整条动作被拒。
    for (const a of planVault(R, {
      now: t, state: s, coins, prices,
      rawInv: world.state?.inv, externalSoldRatio: world.externalSoldRatio,
    }, cfg)) {
      if (push(a)) locked++
    }
    if (locked) summary.push(`囤货仓库调整 ${locked} 项`)
    // 撞墙才升级：只扩容量、不产收益，和「投资」共用一次巡视一次的预算。
    if (cfg.vault.upgrade && opts.allowInvest !== false) {
      const before = vaultCapacity(R, s).lv
      const up = planVaultUpgrade(R, { state: s, coins }, cfg)
      if (up && push(up)) summary.push(`囤货仓库升到 ${before + 1} 级（扩容）`)
    }
  }

  // ---------- 9. 卖货（择时） ----------
  if (cfg.sell?.enabled) {
    // 口粮预留（旧版有，v2 漏了）：
    // 卖货只看「价格到没到峰值」，不看「这些货是接下来要吃的」。
    // 线上实测：玉米 ×111 在 36% 峰值被判「该卖」——111 个玉米是 1,554 点体力，
    // 而整个库存的口粮当量才 2,278 点。卖掉一半，体力 0 时就没东西可吃，
    // 地熟了也收不了（被偷）。
    //
    // 留的底线用 cfg.energy.reserveE（旧版 food.reserveE，默认 600 点）。
    // 按「每点体力最便宜」的口粮顺序留，和吃的时候顺序一致。
    const foodKeep = {}
    {
      let need = cfg.energy?.reserveE ?? 600
      for (const f of foodChoices(R, s, prices)) {
        if (need <= 0) break
        // 同 foodReserve：满体力时 restore=0，用 max(1, restore) 会把整仓锁死
        const per = Math.max(1, f.full ?? f.restore)
        const take = Math.min(f.n, Math.ceil(need / per))
        ;(foodKeep[f.id] ||= [0, 0, 0])[f.q] = take
        need -= take * per
      }
    }
    const sellable = (id, q) => Math.max(0, R.b12Available(s, id, q) - (foodKeep[id]?.[q] || 0))
    const plan = M.sellPlan(R, t, { ...world, state: s, coins }, {
      days: cfg.sell.horizonDays || 12,
      markdownPct: cfg.sell.markdownPct ?? 6,
      external: world.externalSoldRatio || {},
    })
    // 加工原料保留：现在卖出去就再也凑不齐一份加工原料的普通/银星货，先留着。
    // 前提是加工坊本岛日确实还会加工（额度没用完、原料齐了），否则留着就是压库存。
    // 囤得太多（超过 hoardMax）说明加工消化不掉，那就照卖。
    const hoardMax = cfg.craft?.hoardMax ?? 240
    const craftLeft = R.WORLD.daily.craft - ((s.iq?.d === R.isleIndex(t) ? s.iq.craft : 0) || 0)
    const craftable = new Set()
    if (cfg.craft?.enabled && craftLeft > 0) {
      for (const rec of R.RECIPES) {
        if (!rec.price) continue
        const okAll = Object.entries(rec.in).every(([id, k]) => R.b12Available(s, id, 0) + R.b12Available(s, id, 1) >= k)
        if (okAll) for (const id of Object.keys(rec.in)) craftable.add(id)
      }
    }
    const totalOf = (id) => [0, 1, 2].reduce((a, q) => a + (s.inv?.[id]?.[q] || 0), 0)

    const sells = []
    for (const r of plan.rows) {
      if (!r.sellNow) continue
      // 跨期分配已经算好「今天卖几件」：今天全价额度、未来峰值、6% 折让
      // 都在 allocateSale 里逐件权衡过了，这里不再做二元判断。
      let n = Math.min(r.qty, r.todayQty ?? 0)
      if (n <= 0) continue
      if (cfg.sell.respectTiers && r.isCrop) {
        // allocateSale 已按今天的剩余阶梯算过上限，这里只是兜底：
        // 库存积压太多（超过 tier2Above）时允许连第二档（85%）一起清，
        // 否则每天产量远大于全价额度，库存永远清不掉。
        const full = R.cropFullLeft(s, r.id)
        const sold = s.cnt?.['sc_' + r.id] || 0
        const tier2 = Math.max(full, (R.CROP_TIERS?.[1]?.[0] ?? 400) - sold)
        const over2 = totalOf(r.id) > (cfg.sell.tier2Above ?? 450)
        // 第三档（70%）是最后的泄洪口。产量长期压过二档额度时库存只会越堆越多，
        // 钱全压在货里 —— 卖掉 70% 也比烂在仓库强。
        // 超过 tier3Above（约 2 天的二档量）就放开阶梯上限，让 allocateSale
        // 自己权衡卖到第几档。旧版最高只放到二档边界，第三档一个都卖不出去。
        const over3 = totalOf(r.id) > (cfg.sell.tier3Above ?? 900)
        if (!over3) n = Math.min(n, over2 ? Math.max(0, tier2) : (full > 0 ? full : 0))
        if (n <= 0) continue
      }
      sells.push({ ...r, n })
    }
    let sold = 0, soldUnits = 0, soldGross = 0
    const soldNames = []
    const hoarded = []
    for (const r of sells.slice(0, cfg.sell.maxSellPerRound || 40)) {
      let units = 0
      // 按品质从高到低卖
      for (let q = 2; q >= 0 && r.n > 0; q--) {
        // 普通/银星原料留给加工坊，除非已经囤太多
        if (q < 2 && craftable.has(r.id) && totalOf(r.id) < hoardMax) {
          if (!hoarded.includes(r.name)) hoarded.push(r.name)
          continue
        }
        const have = sellable(r.id, q)
        if (have <= 0) continue
        const take = Math.min(999, have, r.n)
        if (push({ a: 'sell', id: r.id, q, n: take })) { r.n -= take; sold++; units += take }
      }
      if (units > 0) {
        soldUnits += units
        soldGross += r.cur * units
        const pctTxt = `${r.curPct >= 0 ? '+' : ''}${(r.curPct * 100).toFixed(0)}%`
        soldNames.push(`${r.name}×${units}（现价${pctTxt}${r.peakIn > 0 ? `，峰值在 ${r.peakIn} 个岛日后` : '，已在峰值'}）`)
      }
    }
    if (hoarded.length) summary.push(`  留作加工原料不卖：${hoarded.slice(0, 5).join('、')}`)
    if (sold) {
      summary.push(`卖出 ${sold} 格 / ${soldUnits} 件，约 ${fmt(soldGross)} D`)
      for (const s2 of soldNames.slice(0, 8)) summary.push(`  · ${s2}`)
    }
    // 没卖但值得等：也记一笔，方便判断策略是否合理。
    // 用「逐件最优分配」的总收入（税后），而不是「峰值日全卖」——
    // 后者被单日全价额度撑得虚高，会系统性地高估等待的价值。
    const waiting = plan.rows.filter((r) => !r.sellNow && r.gain > 0).slice(0, 3)
    // 这几行以前每轮都打一遍（11-13 一天 127 行），把真正有用的日志淹了。
    // 同样的货、同样的峰值日，只在内容变化时或半小时后再说一次；
    // 签名只取「物品种类/件数/峰值岛日」，不取金额——价格每岛日都在动，
    // 带金额去重等于每轮都算「变了」。
    const waitSig = waiting.map((r) => `${r.id}:${r.qty}:${r.peakIn}`).join(',')
    const quiet = waiting.length > 0 && memo.sellWaitSig === waitSig &&
      t - (memo.sellWaitAt || 0) < 1800
    if (waiting.length && !quiet) {
      memo.sellWaitSig = waitSig
      memo.sellWaitAt = t
    }
    if (!quiet) for (const r of waiting) {
      const extra = (r.allocNet || 0) - r.netNow
      // 有未来到货就标出来：这是「为什么不能再等」的直接理由——
      // 明后天成熟的货会占掉同一天的全价/85% 额度。
      const soon = r.soonQty > 0
        ? `；未来 ${r.soonIn} 个岛日内还有 ${Math.round(r.soonQty)} 件成熟（已占档期）`
        : ''
      summary.push(`  · ${r.name}×${r.qty} 暂不卖：最优岛日 +${r.peakIn}，` +
        `逐件分配税后约 ${fmt(r.allocNet)} D` +
        `（比现在 ${extra >= 0 ? '+' : ''}${fmt(extra)}；期末清算兜底 ${fmt(r.netIfWait)}${soon}）`)
    }
  }

  // ---------- 10. 货船进货 ----------
  //
  // 两种买法，旧版都有：
  //   套利  —— 基础价买入，预期未来高价卖出
  //   口粮  —— 比自己种口粮还便宜的作物，买来直接吃（回体力）
  // 口粮这一条以前漏了：自己种地要占种子钱、农务体力、占地，货船上的便宜菜往往更划算。
  if (cfg.cargo?.enabled) {
    const stock = R.b12Stock(t, prices)
    let bought = 0
    const eatCost = foodChoices(R, s, prices)[0]?.costPerEnergy ?? 300
    // 口粮库存折成体力，攒够了就不再买。
    //
    // 不能用 foodChoices() 求和：它的 restore 被「当前还能吃多少」的 room 截断
    // （core/planner.mjs:26 的 Math.min(room, ...)），体力一满就返回空数组，
    // 于是 foodEnergy 恒为 0——库存里明明躺着几千点口粮，还是每种菜买满 24 个。
    const stockEnergy = (() => {
      let e = 0
      for (const c of R.CROPS) {
        if (!(c.eat > 0)) continue
        for (let q = 0; q < 3; q++) {
          const n = R.b12Available(s, c.id, q)
          if (n > 0) e += n * Math.round(c.eat * (R.QUALITY?.[q] ?? 1))
        }
      }
      const snack = R.b12Available(s, 'tide_snack', 0)
      if (snack > 0) e += snack * R.B12_SNACK.energy
      return e
    })()
    let foodEnergy = stockEnergy
    const foodCap = cfg.energy?.reserveEnergy ?? 2500
    for (const it of stock) {
      if (bought >= (cfg.cargo.maxItems || 12)) break
      const left = R.b12StockLeft(s, it, t)
      if (left <= 0) continue
      const crop = R.CROPS.find((c) => c.id === it.id)
      // 未来能卖出的最高价
      const fc = M.forecastPrices(R, t, prices, { days: 6, external: world.externalSoldRatio || {} })
      const peak = Math.max(...fc.map((f) => f.price[it.id] || 0))
      const margin = peak / it.price - 1
      const arbitrage = margin >= (cfg.cargo.minMargin || 0.08)
      // 口粮：每点体力比现有口粮更便宜，且库存还没攒够
      const perEnergy = crop && crop.eat > 0 ? it.price / crop.eat : Infinity
      const asFood = crop && foodEnergy < foodCap && perEnergy < eatCost * 0.9
      if (!arbitrage && !asFood) continue
      // 预算不够一个就跳过：旧版用 Math.max(1, …) 兜底，会在 coins 只比
      // reserve 多一点点时硬买一个把余额压到 reserve 以下（12 种货各一个）。
      const n = Math.min(left, it.limit, Math.floor((coins - (cfg.cargo.reserveCoins || 0)) / it.price))
      if (n <= 0) continue
      if (push({ a: 'stockBuy', id: it.id, n, day: R.isleDay(t) })) {
        bought++
        if (arbitrage) summary.push(`货船进 ${it.name}×${n}（套利，预期 +${(margin * 100).toFixed(0)}%）`)
        else { summary.push(`货船进 ${it.name}×${n}（当口粮：${Math.round(perEnergy)} D/体力，库存口粮 ${Math.round(eatCost)} D/体力）`); foodEnergy += n * crop.eat }
      }
    }
  }

  return { actions, summary, coinsAfter: coins }
}

/**
 * 投资建议：只买预计 N 天内回本的。
 *
 * 每一项的日收益都从规则模块推，不用硬编码常数——以前鱼竿写死「30 万 × 等级」，
 * 换个季节、换个鱼价就完全是错的，会误导成「先升鱼竿」。
 *
 * 长期资产按「基础价 × longRun 系数」估值，不用未来几天的行情高点：
 * 动物要养几十天，工具要用很久，拿两天的价格峰值算回本期会极端乐观。
 */
export function planInvestments(R, s, prices, coins, cfg, t) {
  const W = R.WORLD
  const out = []
  // 回本上限是硬阈值，不随现金放宽。
  //
  // 2026-11-12 线上试过「闲置 ≥500 万时放宽到 30 天」，结果 3 分钟内
  // 连买 6 轮畜栏 + 6 只猪，共 414 万。回本期是用当前产出/价格估的，
  // 站点一改规则估算就可能整体失效，期限越长风险越大；5 天以内
  // 即使规则小幅变化也还有纠错余地。
  const maxPayback = cfg.invest?.maxPaybackDays || 5
  // 长期平均的「择时卖出」系数：基础价的 1.3 倍，再扣税
  const longRunFactor = cfg.price?.longRun ?? 1.3
  const taxRate = coins >= R.B12_TAX.high ? 0.03 : coins >= R.B12_TAX.free ? 0.01 : 0
  const lr = (id) => (R.BASE_PRICE[id] || prices[id] || 0) * longRunFactor * (1 - taxRate)
  // 长期资产（工具、地块、动物）按「长期均价」估值，不看当天行情：
  // 拿今天的暴涨价去算回本期，会把明明要三年回本的工具当成三天回本（旧版 mk.longRun）。
  const lrPrices = {}
  for (const id of Object.keys(R.BASE_PRICE || {})) lrPrices[id] = lr(id)

  const add = (name, action, cost, dailyGain, delayDays = 0, extra) => {
    if (cost == null || !(dailyGain > 0)) return
    // delayDays：资产从买到开始产生收益要等多久（动物有生长期）
    const payback = cost / dailyGain + delayDays
    if (payback > maxPayback) return
    out.push({ name, action, cost, dailyGain, payback, extra })
  }
  const ISLE_PER_DAY = isleDaysPerDay(R)   // 3.5：长夜时钟只走 08:00–22:00

  // ---------- 地块：多种一块能多收多少 ----------
  if (s.plotN < Math.min(W.plotsMax, cfg.invest?.maxPlot ?? 24)) {
    const price = W.plotPrice(s.plotN + 1)
    const weather = R.weatherOf(R.isleDay(t))
    // 用真正的种植规划器算边际价值：它会扣掉阶梯价、加工名额和农务体力，
    // 比「当作全价卖」的粗估更接近实收（旧版 investOptions 用的就是 planner.best()）。
    try {
      const foodCost = foodChoices(R, s, prices)[0]?.costPerEnergy ?? 300
      const soilCost = Math.max(foodCost, workValuePerEnergy(R, s, t, lrPrices, cfg))
      const cp = makeCropPlanner(R, s, t, lrPrices, cfg, weather, soilCost)
      // 先把已经在长的作物记进去，新地才是「第 N+1 块」的真实边际
      for (let i = 0; i < s.plotN; i++) {
        const p = s.plots[i]
        if (!p) continue
        if (R.cropStage(p, t, R.sprinkled(s, i) || weather === 1).stage < 0) continue
        cp.add(p.c, cp.modeOf(i))
      }
      // 新地块可能已经在洒水器覆盖范围内（sprCover 覆盖的是「前 N 块」，R:17），
      // 那样它是自动浇水，农务体力比手动地低得多。旧版一律按 manual 估，
      // 洒水器等级越高，扩地回本被低估得越多（每块每茬少算 2~3 点浇水体力）。
      const newMode = R.sprinkled(s, s.plotN) || weather === 1 ? 'auto'
        : (cfg.farm?.water ? 'manual' : 'none')
      const m = cp.pick(newMode, false)
      if (m && m.value > 0) add(`开垦第 ${s.plotN + 1} 块地`, { a: 'expand', k: 'plot' }, price, m.value)
    } catch { /* 算不出来就不投这项 */ }
  }

  // ---------- 鱼竿：四季 × 全天取最好的时段，看升级能多赚多少 ----------
  if (s.tools.rod < (cfg.invest?.maxRod ?? 4) && cfg.work?.fish) {
    const rodPrice = R.upgradePrice(s, 'rod')
    // 四季 × 全天找出「每竿平均收益」最高的时段，取四季平均。
    // 同一个 t 往前推季节，用虚拟时刻让 fishPool 选到对应季节的鱼。
    //
    // 注意推进要用 isleSpanToReal：一个季节是 12 个**岛日**（R.ISLE_SEASON_DAYS），
    // 岛日只在 08:00–22:00 走，所以 12 岛日 ≈ 3.43 真实日。
    // 旧版写 `se * 12 * ISLE_PER_DAY * ISLE_SPAN`，等于推 12*3.5 个岛日的真实秒数（7 天），
    // 每个 se 都多走一个季节，「四季平均」实际取到的是季节 +0/+2/+4/+6，两个冬天。
    const SEASON_DAYS = R.ISLE_SEASON_DAYS || 12
    const fishBest = (rodLv) => {
      const s2 = { ...s, tools: { ...s.tools, rod: rodLv } }
      let sum = 0
      for (let se = 0; se < 4; se++) {
        const base = isleSpanToReal(R, t, se * SEASON_DAYS * R.ISLE_SPAN)
        let best = 0
        for (let h = 0; h < 24; h++) {
          // 岛上小时同样可能落在冻结段里，用规则自己的推进函数跳过夜间
          const probe = isleSpanToReal(R, base, h * (R.ISLE_SPAN / 24))
          // 开不开饵料都试一遍，取更大的那个
          const ev = Math.max(fishEV(R, s2, probe, lrPrices, false), fishEV(R, s2, probe, lrPrices, true))
          if (ev > best) best = ev
        }
        sum += best
      }
      return sum / 4
    }
    const gain = fishBest(s.tools.rod + 1) - fishBest(s.tools.rod)
    // 不能按「钓满每日额度」算：80 竿 × 4 体力 = 320 点，一天总量才约 480 点，
    // 还要分给挖矿、收获、种植。按「体力预算里实际能分给钓鱼的份额」折一下。
    const dayE = 86400 / (R.WORLD.regen || 180)              // 自然回复 + 初始满体力 ≈ 每天多少点
    const fishShare = Math.min(1, dayE * (cfg.invest?.fishEnergyShare ?? 0.4) / (R.WORLD.daily.fish * (R.WORLD.cost.fish || 4)))
    const rodsPerDay = R.WORLD.daily.fish * ISLE_PER_DAY * fishShare
    if (rodPrice != null) add(`鱼竿 Lv${s.tools.rod + 1}`, { a: 'upgrade', k: 'rod' }, rodPrice, gain * rodsPerDay)
  }

  // ---------- 镐子：下潜层数变深，能挖到更值钱的矿 ----------
  if (s.tools.pick < (cfg.invest?.maxPick ?? 4) && cfg.work?.mine) {
    const pickPrice = R.upgradePrice(s, 'pick')
    // 升级后 s.mine.max 会**自己爬上来**：在最深层挖有 25% 概率发现梯子、
    // 炸矿 60%（R:762-763、R:789），梯子不用买。
    //
    // 旧版这里只换了 tools.pick，没动 mine.max，于是
    // min(s.mine.max, PICK_FLOOR[pick]) 两边都等于当前 max —— 增量恒为 0，
    // 镐子被算成「不赚钱」（pick3 显示 16.99 天回本其实是拿 bomb 的 NaN 凑的）。
    //
    // 现在按「先花 climb 镐在新地板上挖、剩下的额度按新地板算」：
    // 爬一层期望 4 镐，爬升期间收益仍按旧地板，比直接假设一升级就到新层诚实。
    const oreAt = (floor, pick) => {
      const st = { ...s, mine: { ...s.mine, max: Math.max(1, floor) }, tools: { ...s.tools, pick } }
      const per = mineEV(R, st, lrPrices, false, t)
      const bomb = cfg.work?.bomb ? mineEV(R, st, lrPrices, true, t) : 0
      return { per, bomb }
    }
    const dayOre = (pick) => {
      const nowFloor = Math.min(Math.max(1, s.mine.max || 1), R.PICK_FLOOR[pick] || 1)
      const capFloor = Math.max(nowFloor, R.PICK_FLOOR[pick] || nowFloor)
      const steps = capFloor - nowFloor
      const climb = Math.min(R.WORLD.daily.mine, steps * 4)
      const lo = oreAt(nowFloor, pick), hi = oreAt(capFloor, pick)
      return lo.per * climb + hi.per * Math.max(0, R.WORLD.daily.mine - climb) +
        hi.bomb * (R.WORLD.daily.bomb || 0)
    }
    if (pickPrice != null) add(`镐子 Lv${s.tools.pick + 1}`, { a: 'upgrade', k: 'pick' }, pickPrice, (dayOre(s.tools.pick + 1) - dayOre(s.tools.pick)) * ISLE_PER_DAY)
  }

  // ---------- 洒水器：省下覆盖地块的浇水体力 ----------
  if (s.tools.spr < (cfg.invest?.maxSpr ?? 3) && cfg.farm?.water) {
    const sprPrice = R.upgradePrice(s, 'spr')
    if (sprPrice != null) {
      const covered = Math.max(0, Math.min(s.plotN, W.sprCover[s.tools.spr + 1]) - W.sprCover[s.tools.spr])
      // 每块地每茬要浇 2~3 次水，每次 1 点体力，体力按口粮价折钱
      const foodCost = foodChoices(R, s, prices)[0]?.costPerEnergy ?? 300
      add(`洒水器 Lv${s.tools.spr + 1}`, { a: 'upgrade', k: 'spr' }, sprPrice, covered * 2.5 * Math.min(foodCost, 600) * ISLE_PER_DAY)
    }
  }

  // ---------- 蟹笼：抓的是鱼池里的鱼（鱼竿 Lv1 能钓到的那些） ----------
  if (s.traps.length < W.trapMax) {
    const trapPrice = W.trapPrice(s.traps.length + 1)
    // 服务端的 a==='trap' 分支直接 pickWeighted(fishPool(s, ctx.t, 1), …)（R:708-713）：
    // 蟹笼产物就是「rod ≤ 1 的鱼」按 w 加权抽，和鱼竿等级、饵料都无关。
    // 旧版读 R.TRAP_PRODUCTS（规则里根本没有这个键）后回退到 1,500 的常数，
    // 而四个季节的 rod-1 池加权均价在 1,900~2,300 之间 —— 回本被高估 26~30%。
    //
    // 收笼时刻不固定，所以按「四季 × 全天」96 个采样点取加权均价，别拿当前这一小时当全年。
    const SEASON_DAYS2 = R.ISLE_SEASON_DAYS || 12
    let sum = 0, cnt = 0
    for (let se = 0; se < 4; se++) {
      const base = isleSpanToReal(R, t, se * SEASON_DAYS2 * R.ISLE_SPAN)
      for (let h = 0; h < 24; h++) {
        const tt = isleSpanToReal(R, base, h * (R.ISLE_SPAN / 24))
        const pool = R.fishPool ? R.fishPool(s, tt, 1) : []
        if (!pool.length) continue
        const wsum = pool.reduce((a, f) => a + f.w, 0) || 1
        sum += pool.reduce((a, f) => a + lr(f.id) * f.w, 0) / wsum
        cnt++
      }
    }
    const productVal = cnt ? sum / cnt : 1500
    // 每天 8 个：trapEvery=180 分钟、trapCap=4，3 小时出 1 个 / 12 小时满，
    // 不论收多勤都是 8 个/天（雨天只加速不超 cap，所以旧版的 ×1.15 是白送）。
    add(`第 ${s.traps.length + 1} 个蟹笼`, { a: 'buyTrap' }, trapPrice, productVal * (1440 / W.trapEvery))
  }

  // ---------- 动物：整个成年期净赚 ÷ 总天数，挑最好的一种 ----------
  // 离线时段开着时不买「一格多只」的动物（旧版 defense.safeAnimals）：
  // 离线期间产出的畜产品没人收，占格多的品种损失更大。
  //
  // 品质按心情算（规则 b12AnimalQuality，R:1599-1602）：我们是**手动提交**，
  // ctx.auto=false，服务端按 pen.m 出品质（R:675），不是管家代收的全 q0。
  // 每天摸 +6、喂 +8、收 −2，稳态心情就是 100：
  //   gold = min(0.45, 100/250) = 0.4，silver = min(0.8, 100/120) = 0.8
  //   → 平均品质系数 = 0.4×1.5 + 0.6×0.8×1.25 + 0.6×0.2×1 = 1.32
  // 旧版固定 ×1.2，低估约 9%，而且还拿不准是哪个口径。
  const mood = 100
  const goldP = Math.min(0.45, mood / 250)
  const silverP = Math.min(0.8, mood / 120)
  const ANIMAL_Q = goldP * R.QUALITY[2] + (1 - goldP) * silverP * R.QUALITY[1] +
    (1 - goldP) * (1 - silverP) * R.QUALITY[0]
  const animalRanked = R.ANIMALS
    .filter((a) => !(cfg.offline?.enabled && cfg.defense?.safeAnimals) || a.cap === 1)
    .map((a) => {
      const adultDays = (R.B12_ADULT_DAYS?.[a.id] ?? 24) / ISLE_PER_DAY
      const growDays = (R.B12_GROW_DAYS?.[a.id] ?? 2) / ISLE_PER_DAY
      const daily = (1440 / a.every) * lr(a.product) * ANIMAL_Q - (R.SHOP.feed?.price ?? 300)
      // 退役时只能卖回本钱的 40%（站点规则 sellAnimal: price × 0.4），
      // 净成本 60%，摊到整个成年期。add() 的 dailyGain 必须用扣完摊销的净值，
      // 旧版传的是毛 daily —— 等于把每只动物都当成「永不退役」，回本期普遍偏短。
      const netDaily = daily - (a.price * 0.6) / adultDays
      const life = (daily * adultDays - a.price * 0.6) / (adultDays + growDays)
      return { a, daily, netDaily, growDays, life, adultDays }
    })
    .sort((x, y) => y.life - x.life)

  // 不只看第一名：第一名回本期超过 maxPayback 时，第二名/第三名可能仍然划算。
  // 旧版 sort 完直接取 [0]，一旦当前最优品种不达标就**一只都不买**——
  // 默认配置下（离线避让开着时只剩 cap=1 的品种）经常是这种情况。
  for (const rank of animalRanked) {
    if (!(rank.life > 0)) continue
    const before = out.length
    if (s.barn.length < s.barnN) {
      // 有空位：直接买这一只
      add(`买${rank.a.name}`, { a: 'buyAnimal', k: rank.a.id }, rank.a.price, rank.netDaily, rank.growDays)
    } else if (s.barnN < Math.min(W.barnMax, cfg.invest?.maxBarn ?? 8)) {
      // 没空位：扩建一格，连动物一起算
      const barnPrice = W.barnPrice(s.barnN + 1)
      add(`扩畜栏 + ${rank.a.name}`, { a: 'expand', k: 'barn' }, barnPrice + rank.a.price, rank.netDaily, rank.growDays, { first: barnPrice })
    }
    if (out.length > before) break   // 买到一只就不再往下试
  }

  // ---------- 小屋：只加体力上限 ----------
  //
  // 每级 +20 体力上限。以前默认不买，理由是「脚本从不让体力攒满」——
  // 但线上日志显示恰恰相反：体力长期卡在 0/100（连续 231 次），
  // 24 块待收的地只能每 180 秒收一块，一轮要 72 分钟，
  // 期间陆续成熟的地全在树上等着被偷。上限本身就是瓶颈。
  //
  // 收益按「多出来的 20 点体力拿去钓鱼能多赚多少」估：
  // 一天的体力总量是固定的（86400/180 ≈ 480 点），但上限决定了
  // 「能不能一次攒够、一口气干完一轮」，等于减少了成熟→收割的延迟。
  // 保守只按「每天多白嫖 20 点」即 480 点里多出来的 1/24 算。
  if (s.tools.house < Math.min(W.houseMax, cfg.invest?.maxHouse ?? 0)) {
    const housePrice = R.upgradePrice(s, 'house')
    const perEnergy = cfg.work.fish ? fishEV(R, s, t, prices, false) / (W.cost.fish || 4) : 0
    // 每点体力至少值 600 D（低于这个数就说明钓鱼/挖矿都不划算，那也不该扩）
    const dailyGain = 20 * Math.max(600, perEnergy)
    if (housePrice != null) add(`小屋 Lv${s.tools.house + 1}`, { a: 'upgrade', k: 'house' }, housePrice, dailyGain)
  }

  out.sort((a, b) => a.payback - b.payback)
  return out
}

/** 下一次该醒来的时刻（秒） */
export function nextWake(world, cfg, memo = {}) {
  const R = world.R
  const t = world.now
  const s = world.state
  const cands = []
  const backoffCands = []      // 退避候选单独放，免得被 maxSleep 截断（见函数末尾）
  const push = (sec) => { if (sec != null && sec >= 0 && Number.isFinite(sec)) cands.push(Math.max(1, Math.ceil(sec))) }
  const pushBackoff = (sec) => {
    if (sec == null || !(sec >= 0) || !Number.isFinite(sec)) return
    const v = Math.max(1, Math.ceil(sec))
    cands.push(v); backoffCands.push(v)
  }

  const weather = R.weatherOf(R.isleDay(t))
  // 作物成熟
  //
  // 已经熟的（stage 3）只有在「体力收得动」时才值得立刻醒。
  // 体力 0 又没口粮时 push(1) 会让主循环每几秒醒一次，
  // 醒来还是收不了，整夜空转（截图里那种刷屏日志）。
  // 这种时候交给体力回复候选去安排唤醒。
  let hasRipe = false
  for (let i = 0; i < s.plotN; i++) {
    const p = s.plots[i]
    if (!p) continue
    const auto = R.sprinkled(s, i) || weather === 1
    const st = R.cropStage(p, t, auto)
    if (st.stage === 3) hasRipe = true
    else if (st.stage >= 0) {
      push(st.left)
      // 手动浇水的地：下一个生长阶段一开始就该浇水（旧版 nextWake）。
      // 只在成熟时才醒会让每次浇水都晚一拍，金银星比例跟着掉。
      if (!auto && cfg.farm?.water && st.stage < 2 && st.total > 0) {
        const stageAt = p.t + Math.ceil(st.total * (st.stage + 1) / 3) + 2
        push(stageAt - t)
      }
    }
  }
  if (hasRipe) {
    const canHarvest = s.en >= (R.WORLD.cost.harvest || 1)
    // 口粮能补上也算「收得动」。注意这里的价格要用 world.prices——
    // nextWake 作用域里没有 prices 局部变量，以前写成 foodChoices(R, s, prices)
    // 会抛 ReferenceError，被 catch 吞掉后 canEat 永远是 false，
    // 于是体力 0 时「有熟地」完全不算事，nextWake 给 108 秒，
    // 而 watchOnce 又报「地熟了」——两边打架，日志刷屏。
    let canEat = false
    if (!canHarvest) {
      try { canEat = cfg.energy?.eat !== false && foodChoices(R, s, world.prices).length > 0 } catch {}
    }
    if (canHarvest || canEat) push(1)
  }
  // 浇水阶段
  if (cfg.farm?.water && weather !== 1) {
    for (let i = 0; i < s.plotN; i++) {
      const p = s.plots[i]
      if (!p || R.sprinkled(s, i)) continue
      const st = R.cropStage(p, t)
      if (st.stage >= 0 && st.stage < 3 && p.w <= st.stage) push(1)
    }
  }
  // 动物产出 / 喂食
  for (const pen of s.barn) {
    const st = R.animalReady(pen, t)
    if (st.ready) push(1)
    if (!st.retired && t - pen.f >= ANIMAL_FEED_SEC) push(1)
    // 下一件产物的到达时刻（榜一「事件桶」里最容易漏掉的一个）。
    //
    // animalReady 返回的 nextP 是循环结束后的 cursor——即「最后一件产物完成的时刻」，
    // 不是「下一件产出的时刻」。真正的下一件在 cursor + period。
    // 窝满时 nextP = max(cursor, until)，此时停产，只能等我们收走。
    // 只按「窝里有货」唤醒会导致：产出一件→收走→再等下一件，
    // 中间窝要是满了就白停一段时间。
    if (!st.retired && st.n < (st.def?.cap || 1)) {
      const period = st.period || 0
      const nextAt = (st.nextP || t) + period
      // 直接用精确的 nextP + period，不再截断到 180 秒。
      // b12AnimalPeriod 返回的是真实秒数（season/weather 系数最多 ±4%），
      // cursor 也是真实时刻，两者相加就是下一件产物的到点时刻。
      // 以前截到 180 秒是担心 nextP 不精确，代价是 8 只动物每 3 分钟醒一次
      // （线上 2026-11-14 一上午 997 轮巡视，绝大多数是这种空醒）。
      // 就算算早了，醒来看到没货也只是空一轮；算晚了最多晚收几分钟，
      // 窝里还远没到 cap（鸡 4 小时一件、cap 3），不会停产。
      if (nextAt > t) push(nextAt - t)
    }
  }
  // 蟹笼
  for (const tr of s.traps) {
    const st = R.trapReady(tr, t, weather === 2)
    if (st.n) push(1)
  }
  // 体力回复（榜一的做法：体力见底时醒在「下一滴体力到账」的那一刻，而不是干等）
  //
  // 服务端 refresh()：s.enT 是回复周期的相位起点，
  //   下一滴体力在 enT + regen 处到账，之后每隔 regen 到账 1 点。
  // 旧写法是「按当前体力回满所需时间」算（(max-en)*180），
  // 那等于要求「回满才值得醒」，但钓鱼一次只要 4 点体力——
  // 现在有 1 点就能干活，等到回满完全是浪费。
  const maxEn = R.energyMax(s)
  if (s.en < maxEn) {
    const regen = R.WORLD.regen || 180
    const phase = Number(s.enT || s.now || t)
    // 下一滴体力的到账时刻：enT 之后第 (floor((t-enT)/regen)+1) 个 regen 点。
    // 例：enT=179 秒前、regen=180 → 下一滴在 1 秒后（不是 181 秒后）。
    let nextDrop = phase + (Math.floor(Math.max(0, (t - phase) / regen)) + 1) * regen
    if (nextDrop < t) nextDrop = t + 1
    const waitSec = Math.max(1, nextDrop - t)
    // 门槛用「有收益的活」里最便宜的那个（钓鱼 4），不能用 harvest/water 的 1 点——
    // 那两件事随时都能做，拿它当门槛等于永远不触发。
    const jobs = [R.WORLD.cost.fish ?? 4, R.WORLD.cost.mine ?? 3, R.WORLD.cost.bomb ?? 6].filter((x) => x > 0)
    const cheapest = jobs.length ? Math.min(...jobs) : 4
    if (s.en < cheapest) push(waitSec)                     // 一点有收益的活都干不了 → 醒在下一滴
    else if (s.en < cheapest * 2) push(waitSec + regen)    // 只够干一次 → 攒两滴再醒
    // 体力充足时不加这个候选：趟趟醒反而是浪费请求
  }
  // 换岛日（价格/额度刷新）
  push(R.b12NextIsleBoundary(t) - t)
  // 自然日 0 点（北京时间）：每日额度全部清零
  //   钓鱼 80 / 挖矿 100 / 加工 80 / 炸矿 10 / 咖啡 3 / 五子棋计奖 10 / 擂台掉落 30
  //   以及作物阶梯价计数 sc_<crop>、npc 计数
  // 之前只看岛日边界，导致 0 点后额度刷新了却可能一直等到 maxSleep 才醒。
  {
    const local = t + 8 * 3600                        // 转成北京时间的秒数
    const sinceMidnight = ((local % 86400) + 86400) % 86400
    const toMidnight = 86400 - sinceMidnight
    if (toMidnight > 0) push(toMidnight)
    // 长夜 22:00 开始 / 08:00 结束：夜潮小礼在这两个时刻刷新
    // （b12NightView 的 key 就取自 22:00 那天的日期，过了 08:00 就不能再领）
    const H = 3600
    const toNight = 22 * H - sinceMidnight                    // 距今晚 22:00
    if (toNight > 0) push(toNight)
    else {
      const toMorning = 8 * H - sinceMidnight                 // 还在长夜里，等 08:00 收尾
      if (toMorning > 0) push(toMorning)
    }
  }
  // 钓鱼时段的起止（榜一的做法：hours 的进入/退出时刻都是规划节点）
  //
  // 以前只看 f.hours[0]（鱼种出现），不看 f.hours[1]（鱼种离开）。
  // 结果是好鱼种到点走了，我们没醒；或者最后一个小时该抢收时在睡。
  // 现在起止都算，且用 %24 处理跨天时段（鱿鱼 [18,30] 的退出是次日 6 点）。
  //
  // 长夜里岛钟冻结（isleHour 基于 b12ClockSeconds，只累计 8:00–22:00），
  // 时段根本不会变化，唤醒也没意义，交给 22:00/08:00 的候选。
  if (cfg.work?.fish && !R.b12IsLongNight(t)) {
    const h = R.isleHour(t)
    const hourSpan = R.ISLE_SPAN / 24             // 一个岛上小时 = 现实 600 秒
    for (const f of R.FISH) {
      if (f.rod > s.tools.rod) continue
      for (const edge of [f.hours[0] % 24, f.hours[1] % 24]) {
        if (edge === 0) continue                  // [0,24] 全天开放，没有变化时刻
        const dh = (edge - h + 24) % 24
        if (dh === 0) continue                    // 正处在变化的那一格，整点唤醒会处理
        push(dh * hourSpan)
      }
    }
    // 整点唤醒：鱼池按「岛上小时」换（现实 10 分钟一格），
    // 还有竿数没用完时，每个整点醒一次，好时段一开始就下竿。
    // 只看「时段开始」不够——鱼种会在整点整点地进出，错过一格要再等一整个岛日。
    const fishLeft = R.WORLD.daily.fish - ((s.iq?.d === R.isleIndex(t) ? s.iq.fish : 0) || 0)
    if (fishLeft > 0 && !R.b12IsLongNight(t)) {
      const clock = R.b12ClockSeconds(t)
      const span = R.ISLE_SPAN / 24              // 一个岛上小时 = 现实 600 秒
      const toNextHour = span - (clock % span)
      if (toNextHour > 0) push(toNextHour + 2)
    }
  }

  // ---------- 每日额度没做完：缩短间隔（wake 参数由调用方传入） ----------
  // 这些事不受「作物成熟」等物理事件驱动，只要还有额度就该去做，
  // 否则会一直落到 maxSleep，白白空转。
  const day = R.worldDay(t)
  const dayLeft = Math.max(1, R.b12NextIsleBoundary(t) - t)
  const w = cfg.wake || {}

  // 退避是「全局」的：帮忙连续几轮没进展、或五子棋连续解不出棋谱，
  // 都说明**当前没有什么值得马上回来做的事**。这时如果只让出问题的那一个模块退避，
  // 其余模块仍会每 60 秒把整体唤醒一次，退避就白做了。
  // 所以：任何一个模块连续卡住，就把所有「额度驱动」的间隔一起放宽。
  const stallThreshold = w.stallThreshold ?? 3
  const stalling = (memo.helpStall || 0) >= stallThreshold || (memo.gomokuStall || 0) >= stallThreshold
  const idleWaitSec = Math.min(w.idleStall ?? 900, dayLeft)

  // 记录「还有没有值得马上回来做的事」。全都没有时，就一路睡到换岛日——
  // 凌晨把额度刷完之后，以前会每 1~2 分钟醒一次、每次发一堆请求，
  // 纯粹空转（实测 01:13 到 08:00 全是无效巡视）。
  let hasPending = false

  // 帮忙：每天 N 家，还有剩就尽快
  if (cfg.social?.help?.enabled) {
    const done = (memo.helpDay === day ? (memo.helpCount || 0) : 0)
    const need = (cfg.social.help.perDay ?? 10) - done
    if (need > 0 && s.en >= (cfg.social.help.minEnergy ?? 20)) {
      hasPending = true
      if (stalling) pushBackoff(idleWaitSec)
      else push(w.help ?? 60)
    }
  }

  // 五子棋：每天前 N 局计奖，没打完就尽快
  if (cfg.npc?.enabled && cfg.npc.gomoku) {
    const used = (s.enDay === day ? (s.cnt?.npc || 0) : 0)
    const paid = s.cnt?.gomokuPaid || 0
    const left = Math.min((cfg.npc.gomokuMaxGames ?? 10) - paid, R.NPC.daily - used)
    if (left > 0) {
      hasPending = true
      if (stalling) pushBackoff(idleWaitSec)
      else push(w.gomoku ?? 60)
    }
  }

  // 擂台：每天 N 场有掉落，没打完就尽快
  //
  // 今日已打场次不在 world.state 里（站点放在 /battle/gear 的 gear.daily.battles），
  // 而 nextWake 是纯函数不能发请求，所以读 engine 缓存进 memo 的值。
  // 没有缓存（比如刚启动还没打过）时按「没打完」处理，保守一点。
  if (cfg.arena?.enabled) {
    const maxB = cfg.arena.battles ?? 30
    const today = (memo.arenaDay === day ? (memo.arenaToday ?? 0) : 0)
    if (today < maxB) {
      hasPending = true
      if (stalling) pushBackoff(idleWaitSec)
      else push(w.arena ?? 300)
    }
  }

  // 花体力换钱的活（钓/挖/炸）：还有额度就该去做。
  // 这三项以前完全没进候选集，导致「体力满满但额度已用完」时，
  // 判断不出「其实没事可做」，还是按 maxSleep/额度驱动空转。
  {
    const iqLeft = (k) => {
      const iq = s.iq
      const used = (iq && iq.d === R.isleIndex(t)) ? (iq[k] || 0) : 0
      return Math.max(0, (R.WORLD.daily[k] || 0) - used)
    }
    const workLeft = (cfg.work?.fish ? iqLeft('fish') : 0) +
      // 矿洞没层可挖（s.mine.max=0）时 mineEV 是 0，规划器不会选挖矿。
      // 这里也不能把它算成「有事可做」，否则就是每 60 秒醒一次、什么都不干。
      (cfg.work?.mine && (s.mine?.max || 0) > 0 ? iqLeft('mine') : 0) +
      (cfg.work?.bomb ? iqLeft('bomb') : 0)
    if (workLeft > 0 && s.en >= Math.min(R.WORLD.cost.fish ?? 4, R.WORLD.cost.mine ?? 3, R.WORLD.cost.bomb ?? 6)) {
      hasPending = true
      if (stalling) pushBackoff(idleWaitSec)
      else push(w.work ?? 60)
    }
  }

  // 当季田里还有空地可种 / 有熟了的没收 → 也算有事可做
  for (let i = 0; i < s.plotN; i++) {
    const p = s.plots[i]
    if (!p) { if (cfg.farm?.enabled) hasPending = true; continue }
    const st = R.cropStage(p, t, R.sprinkled(s, i) || weather === 1)
    if (st.stage === 3) hasPending = true
  }

  // 偷菜：扫描间隔到了就该去（不加这个会一直等 maxSleep，实际扫描被拖慢）
  //
  // 体力门槛不能只看「现在有 5 点」：体力被钓鱼/挖矿花光是常态，
  // 而 stealRound 会现场吃口粮补上来（旧版 energyActions 的做法）。
  // 只有「没口粮可补」时才算真没事可做。写成硬门槛 s.en >= 5 的后果是
  // 体力常年 0~3，偷菜额度一整天都是 0（线上 11-12 全天只偷到 1 处）。
  if (cfg.social?.steal?.enabled) {
    const stealE = 5
    const canSteal = s.en >= stealE || !!energyActions(R, s, world.prices, {
      need: stealE, maxPerE: cfg.social.steal.maxEnergyCost ?? 600, cfg, coins: world.coins,
    })
    if (canSteal) {
      const last = memo.stealScanAt || 0
      const every = cfg.social.steal.scanEvery ?? 1800
      const left = Math.max(0, every - (t - last))

      // 精确解禁调度：把「某块地/某个畜栏什么时候能偷」也算进唤醒时刻。
      // 这是到点扫描做不到的——成熟后要过 protect(1800 秒) 才能偷，
      // 到点扫描很容易每次都差几分钟，永远偷不到刚解禁的那批。
      //
      // 但要加自适应节流：巡逻一圈会记下几百条解禁时刻，平均 20 秒有一条到点，
      // 不节流就是「1 秒后醒 → 什么都没偷到 → 再 1 秒后醒」。
      // 偷到过 60 秒一次，连续白醒翻倍到 15 分钟（见 steal-schedule.mjs）。
      const gap = Math.max(SNIPE_MIN_GAP_SEC, memo.stealWakeGap || SNIPE_MIN_GAP_SEC)
      const wakeReady = t - (memo.stealWakeAt || 0) >= gap
      const nx = wakeReady
        ? nextUnlock(memo.stealSchedule || {}, t, {
          // 提前量必须和 engine 的 shouldSnipe 用同一个口径：换装 + 解禁前
          // 补体力都是 POST，不然「引擎按 8 秒醒、换完装已经过了窗口」。
          leadSec: physicalPrepLeadSec({
            schedule: memo.stealSchedule || {},
            now: t,
            gearSwaps: stealGearSwaps(cfg),
            needPrepAct: s.en < Math.min(cfg.social.steal.maxEnergy ?? 15, 15),
            remainingPostCdMs: world.client?.getRemainingPostCooldownMs?.() || 0,
            minGapSec: cfg.minGap ?? 2.15,
            rttMs: world.client?.lastRttMs || 600,
            fixedLeadSec: cfg.social.steal.prepLeadSec || 0,
          }),
        })
        : null
      if (nx) {
        // 解禁时刻比下次扫描更早 → 按解禁时刻醒来
        push(Math.min(left > 0 ? left : 5, nx.wakeIn))
      } else if (left > 0) {
        push(left)
      }
      // 没有解禁记录、扫描间隔也过了（left<=0）时不推候选：
      // 以前这里写 push(5)，含义是「扫描间隔到了就该去」，
      // 但 stealScanAt 为 0（刚重启）时 left 是负数，于是每次推送 5 秒，
      // 造成「5 秒醒一次」的死循环。
    }
  }

  // 兜底：没有更早的事件时也别睡太久
  //
  // 上限的算法要小心：退避（helpStall / gomokuStall）本来是想「这次别再来烦」，
  // 但如果无脑 Math.min(...cands, maxSleep)，退避值会被截回 120 秒，等于没做。
  //
  // 做法：退避候选单独记一个集合 backoffCands。
  // 如果最终选中的就是某个退避候选，就允许睡到退避上限；
  // 否则（说明有别的事更早）按正常 maxSleep 走。
  const maxSleep = cfg.loop?.maxSleep || 120
  const backoffCap = cfg.loop?.maxSleepForBackoff ?? 1800
  const raw = cands.length ? Math.min(...cands) : maxSleep
  // 选中的值若与某个退避候选相等（说明是它赢的），就套退避上限
  const wonByBackoff = backoffCands.length && raw === Math.min(...backoffCands)

  // 什么都没得做（额度全刷完、没有熟的地、没有空位可种，也没有物理事件在等）：
  // 睡到换岛日，但封顶 idleSleepCap。
  //
  // 为什么不能直接睡满 dayLeft：等待期虽然是只读巡检，但它同时负责发现
  // 「被偷了」「有突发」。睡 6 小时不醒，就等于放弃了这层保护。
  // 30 分钟醒一次，一晚从 ~300 轮请求降到 ~14 轮，够用了。
  //
  // 关键：raw 可能已经是「205 秒后有一块地要熟」这种事件驱动的短等待。
  // 以前这里直接 return cap，把该事件丢了——线上实测 11:51 明明
  // 205 秒后要熟一块，却睡了 1800 秒，熟地晾在那儿等被偷。
  // 所以只在 raw 真的很大（没什么近期待办）时才拉长到 cap：
  // 取 min(cap, raw)，即「有近事件就按事件，没有才睡满 cap」。
  if (!hasPending && raw >= maxSleep) {
    const cap = w.idleSleepCap ?? 1800
    const tillBoundary = Math.max(maxSleep, Math.min(cap, Math.ceil(dayLeft)))
    return Math.min(raw, tillBoundary)
  }
  return Math.min(raw, wonByBackoff ? backoffCap : maxSleep)
}
