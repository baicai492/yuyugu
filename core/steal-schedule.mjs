// 偷菜精确解禁调度（以旧版 v1 的「每岛一个到点时刻」为主干）。
//
// 服务端返回的 visit 里同时有两份信息：
//   isle.plots[i] = { c, stage, left, steal, stolen }   —— 这份是给玩家看的
//   state.plots[i] = { c, t, w, g, h }                  —— 这份带着种植时刻 t
//   state.barn[i]  = { k, f, p, m, held, heldAt }       —— 畜栏的完整进度
//
// 成熟时刻是确定的：matureAt = p.t + cropStage(p, now, auto).total
// 解禁时刻 = matureAt + rules.protect（默认 1800 秒）。
//
// 关键点（v2 以前丢掉的能力）：
//   · 已经成熟、但还在保护期的地，也能用 p.t + total 反推出解禁时刻；
//     v2 以前把这一类直接丢弃，只能等下一次「到点扫描」碰运气。
//   · 生长中的地，now + isle.plots[i].left 与上式等价，但用 state 能统一处理。
//   · 畜栏按「第二个产物出现」算（rules.perPen 要求窝里至少有 2 个才可偷），
//     用 animalReady 推算第二个产物的时刻，再叠加保护期。
//
// 调度粒度：每座岛只保留「最早一个期望收益 ≥ minEV 的解禁组」，
// 访问时刻 checkAt = max(now+60, min(nextAt-prep, now+checkEvery))。
// 这样既不会像 v2 那样在全服几百条记录上空转，也不会漏掉同波的其他岛。

/**
 * 解禁时刻过去多久之后就认为「这条记录作废了」。
 *
 * 取值要同时满足两件事：
 *   · 太短 —— 解禁那一刻刚好在扫别的岛，回来记录已经被删，得等下次全量扫描
 *   · 太长 —— 记录一直留着，nextUnlock 反复把它报成「马上解禁」，主循环空转
 * 5 分钟是个折中：足够覆盖一次扫描的耗时，又不至于让唤醒密集到几秒一次。
 */
export const EXPIRED_GRACE_SEC = 300

/**
 * 已经过点多久之后就不再拿它当「唤醒理由」。
 *
 * 这和 EXPIRED_GRACE_SEC 是两件事：
 *   · EXPIRED_GRACE_SEC 决定「记录还留多久」（多久后从表里删掉）
 *   · 这个值决定「还催不催主循环醒来」
 *
 * 线上实测：一条记录解禁后，nextUnlock 连续 300 秒都返回 wakeIn=1，
 * 于是主循环每 1~4 秒醒一次、扫一遍邻居目录——04:47 那次连续空转了两分钟。
 * 解禁瞬间醒来一次就够了；没偷到就是没偷到（目标已被别人偷走、
 * 或守家太强），多醒几次也不会有不同结果。
 * 30 秒足够覆盖「醒来 → 拉状态 → 提交」的延迟。
 */
export const WAKE_GRACE_SEC = 30

/** 默认只看未来多久内的解禁（秒）。更远的等下一轮巡逻重新算，避免表无限膨胀。 */
const DEFAULT_HORIZON_SEC = 7200

/**
 * 一次偷菜的期望收益（移植自旧版 extension/lib/social.mjs 的 inspect().ev）。
 *
 *   ev = (1−被发现) × 货值
 *      + 被发现 × (胜率 × (货值 + 每处多拿 1 个) − 败率 × 罚款)
 *      − 体力 × 机会成本
 *
 * 只看货值会系统性地高估：邻居里一半以上的岛有守家鱼，等级比我们高时
 * 胜率只有 30~50%，输一次按货值 1.2 倍赔（上限 5,000 D）。
 */
export function stealEV(tg, myLevel, energyValue = 300) {
  const spots = Math.max(1, tg.targets?.length || tg.spots || 1)
  const V = tg.value || 0
  const detect = Number.isFinite(tg.detect) ? tg.detect : 0.55
  const clamp01 = (x) => Math.max(0, Math.min(1, x))
  // 有对手档案时用模拟出来的三结局概率；没有就退回旧版的等级差估算。
  // 这里是「有没有守家鱼」的分水岭：没守家时 pWin=1、不会有罚款。
  const hasPosterior = tg.guard && Number.isFinite(tg.pWin) && Number.isFinite(tg.pLoss)
  let pWin, pLoss, pDraw
  if (!tg.guard) {
    pWin = 1; pLoss = 0; pDraw = 0
  } else if (hasPosterior) {
    pWin = clamp01(tg.pWin)
    pLoss = clamp01(tg.pLoss)
    pDraw = clamp01(Number.isFinite(tg.pDraw) ? tg.pDraw : 1 - pWin - pLoss)
    const sum = pWin + pLoss + pDraw
    if (sum > 0) { pWin /= sum; pLoss /= sum; pDraw /= sum }
  } else {
    pWin = Math.max(0.03, Math.min(0.95, 0.5 + ((myLevel || 1) - (tg.level || 1)) * 0.15))
    pLoss = 1 - pWin
    pDraw = 0
  }
  // 打赢：每处**多拿 1 个**（S:1174、S:1209-1227），不是每处再多拿「整批货」。
  // 旧版写 V / spots，等于把「一处全部基础货值」当成 1 个——带菜篮时每处 3 个，
  // 胜利分支直接按 6 个/处结算，payout 翻了一倍。按单件价 × 处数才算对：
  // 线上实测（logs/host-2026-11-13.log:4405）6 处胜利只多拿到 6 个（每处 1 个）。
  const bonus = Number.isFinite(tg.bonus) ? Math.max(0, tg.bonus) : 0
  const fine = Math.min(tg.fineMax || 5000, V * 1.2)
  const energy = Math.min(tg.energy || 5, 15)
  // 平局按「什么都没拿到、也没赔钱」算（保守；服务端平局确实不结算收益）。
  const fightEV = pWin * (V + bonus) + pDraw * 0 - pLoss * fine
  return (1 - detect) * V + detect * fightEV - energy * energyValue
}

const priceOf = (prices, id, R) => Number(prices?.[id]) || Number(R?.BASE_PRICE?.[id]) || 0

/** 畜栏里「第二个产物出现」的时刻；不可偷 / 推算不出来时返回 null。 */
function penUnlockAt(R, raw, now, protect) {
  if (!raw) return null
  const def = R?.ANIMALS?.find?.((a) => a.id === raw.k)
  if (!def || (def.cap || 0) < 2) return null          // 窝上限 1 的（羊、猪）永远偷不走
  let age
  try { age = R.b12AnimalStage(raw, now) } catch { return null }
  if (age?.retired) return null

  const held = Math.min(def.cap, Array.isArray(raw.held) ? raw.held.length : 0)
  // 已经攒够 2 个却还被锁着 → 只可能是在保护期里；等一个保护期再看。
  if (held >= 2) return now + protect

  const days = R.B12_GROW_DAYS?.[raw.k] || 2
  let adultAt = 0
  try {
    adultAt = Number.isSafeInteger(raw.born) ? R.b12AfterActive(raw.born, days * (R.ISLE_SPAN || 14400)) : 0
  } catch { adultAt = 0 }
  let cursor = Math.max(Number(raw.p) || 0, adultAt)
  // 喂一次管 24 小时；超过这个时间还没产出的，状态由岛主下一次喂食决定，算不准。
  const until = Math.min((Number(raw.f) || 0) + 86400, age?.retireAt || Infinity)
  let count = held
  let firstReady = held ? (Number(raw.heldAt) || cursor) : 0
  while (count < 2) {
    let period
    try { period = R.b12AnimalPeriod(raw.k, cursor) } catch { return null }
    if (!(period > 0)) return null
    const end = cursor + period
    if (end > until) return null
    count++
    if (count === 1) firstReady = end
    else return Math.ceil(Math.max(end, firstReady ? firstReady + protect : 0))
    cursor = end
  }
  return null
}

/**
 * 从一次 visit 快照里算出「未来最近的、值得掐的解禁组」，并更新调度表。
 *
 * @param {object} args
 *   isle      visit 返回的 isle
 *   state     visit 返回的 state（对方岛的完整状态，含 plots[].t / barn[]）
 *   rules     visit 返回的 rules
 *   R         线上规则模块（cropStage / sprinkled / animalReady / BASE_PRICE）
 *   now       当前时间（秒，优先用服务端返回的 now）
 *   prev      这座岛之前的调度记录（可为 null）
 *   prices    当前市价表（用于估值）
 *   owner     对方岛主（未用，保留给以后算守家强度）
 *   level     对方等级（守家胜率用）
 *   myLevel   我方擂台等级
 *   guard     对方是否有守家鱼
 *   detect    被发现概率
 *   sack      是否带着折叠菜篮（每处多拿 1 个）
 *   minEV     低于这个期望收益的时刻不掐
 *   energyValue 每点体力的机会成本
 *   groupSpanSec 同一个「瞬间」的容差（秒）
 *   checkEvery 多久至少回访一次（秒）
 *   prepLeadSec 解禁前多少秒回访
 *   horizonSec 只看未来多久内的解禁
 *   ownerLeft   这座岛主今天还能被偷几次（visit 回执的 left.owner；null = 未知）
 *   maxWaves    一座岛最多排几波（默认 2；同一批地分几次成熟时才有用）
 *   waveGapSec  两波之间至少隔多久（秒）
 * @returns {{ rec, upcoming }}
 */
export function updateIsleSchedule({
  isle, state, rules, R, now, prev,
  prices = {}, level = 1, myLevel = 1, guard = false, detect = 0.55, sack = false,
  minEV = 3000, energyValue = 300, groupSpanSec = 2, checkEvery = 1800,
  prepLeadSec = 15, horizonSec = DEFAULT_HORIZON_SEC,
  ownerLeft = null, maxWaves = 2, waveGapSec = 20,
}) {
  const protect = Number(rules?.protect) || 1800
  const perPlot = Number(rules?.perPlot) || 2
  const perPen = Number(rules?.perPen) || 2
  const energyBase = Number(rules?.energy) || 5
  const energyMax = Number(rules?.energyMax) || 15
  const fineMax = Number(rules?.fineMax) || 5000
  const sackAdd = sack ? 1 : 0
  const rec = prev
    ? { ...prev, plots: {}, pens: {} }
    : { plots: {}, pens: {} }
  rec.seenAt = now
  rec.level = level
  rec.guard = guard
  rec.detect = detect
  const candidates = []
  const horizonEnd = now + Math.max(0, Number(horizonSec) || DEFAULT_HORIZON_SEC)

  // 对方岛的天气 / 洒水器决定生长速度；服务端收获时也是用「当前天气」整体重算。
  let rainy = false
  try { rainy = R.weatherOf(R.isleDay(now)) === 1 } catch { /* 规则模块缺失时按不浇水算 */ }

  const plotAuto = (i) => {
    try { return R.sprinkled(state, i) || rainy } catch { return rainy }
  }

  // —— 地块 ——
  ;(isle?.plots || []).forEach((pl, i) => {
    if (!pl) return
    const stolen = Number(pl.stolen) || 0
    if (stolen >= 2) return                       // 已被偷满 2 个，服务端锁死
    if (pl.steal) return                          // 现在就能偷，由 targetsFromIsle 直接处理，不进调度表

    let unlockAt = null
    const raw = state?.plots?.[i]
    if (raw && Number.isFinite(raw.t) && raw.t > 0) {
      try {
        // 服务端给的 state 带种植时刻；成熟时刻 = t + total，解禁 = 成熟 + 保护期。
        // 这一条同时覆盖「生长中」和「已成熟但在保护期」两种情况。
        const st = R.cropStage(raw, now, plotAuto(i))
        if (st.stage >= 0) unlockAt = Math.ceil(raw.t + st.total + protect)
      } catch { /* 退回下面的估算 */ }
    }
    if (unlockAt == null) {
      // 没有 state 时只能按 isle 里的 left 估：生长中 = now+left+protect，
      // 已成熟还在保护期 = now+protect（保守，等下一轮巡逻再修正）。
      const left = Number(pl.left) || 0
      if (pl.stage === 3 || left > 0) unlockAt = Math.ceil(now + left + protect)
    }
    if (unlockAt == null) return
    if (unlockAt <= now + 1 || unlockAt > horizonEnd) return

    const unit = priceOf(prices, pl.c, R)
    // 每块地每茬最多被偷 2 个（S:442、S:476、S:583）；stolen 是这一茬已经被偷走的数量，
    // 剩下能拿的是 perPlot − stolen。旧版一律按 perPlot+sack 估值：
    // stolen=1 的地块高估约 33%，stolen=2 的还会被排进目标（服务端锁死，白跑一趟）。
    const qty = Math.max(0, perPlot - stolen) + sackAdd
    if (qty <= 0) return
    rec.plots[i] = { unlockAt, exact: true, kind: 'plot', i, c: pl.c || '', value: unit * qty, unit, qty }
    candidates.push({ kind: 'plot', i, at: unlockAt, item: pl.c || '', value: unit * qty, unit })
  })

  // —— 畜栏 ——
  ;(isle?.barn || []).forEach((pen, i) => {
    if (!pen) return
    if (pen.steal) return                          // 现在能偷的同样交给 targetsFromIsle
    const raw = state?.barn?.[i]
    const unlockAt = penUnlockAt(R, raw, now, protect)
    if (unlockAt == null || unlockAt <= now + 1 || unlockAt > horizonEnd) return

    const def = R?.ANIMALS?.find?.((a) => a.id === pen.k)
    const unit = priceOf(prices, def?.product, R)
    if (!unit) return
    // 第二个产物一出现，窝里正好 2 个；服务端按 perPen 给（通常也是 2）。
    const value = unit * (Math.max(perPen, 2) + sackAdd)
    rec.pens[i] = { unlockAt, exact: true, kind: 'pen', i, c: pen.k || '', value, unit }
    candidates.push({ kind: 'pen', i, at: unlockAt, item: def.product, value, unit })
  })

  // —— 按时刻分组，挑出 EV 达标的前几波 ——
  //
  // 旧版 v1 的做法：把 60 秒内的解禁并成一组算总 EV，取第一组过线的。
  // 这里用 groupSpanSec（默认 2 秒）——解禁时刻是精确值，差 2 秒以上的
  // 就是两批货，把它们并在一起会推迟第一批。
  //
  // 多波次（v1.4.4 的移植）：同一座岛的作物是分批成熟的，只排第一波的话，
  // 第二批只能在下次巡逻（默认 30 分钟后）才重新发现，通常早就被别人偷了。
  // 所以继续往后找 EV 达标的组，最多 maxWaves 个；两波之间至少隔 waveGapSec
  // （准备 + 提交 + 换装的物理时间，15~20 秒），否则两波的准备窗口会重叠。
  // 波数还受 ownerLeft 限制：服务端按「岛主今天还能被偷几次」封顶。
  candidates.sort((a, b) => a.at - b.at)
  const ownerCap = ownerLeft == null ? 3 : Math.max(0, Math.floor(Number(ownerLeft) || 0))
  // ownerLeft=0 时只排第一波（等同于老行为）：宁可多试一次，也不要因为
  // 这个字段的语义以后变了就把整家岛放弃掉。
  const capWaves = Math.max(1, Math.min(3, Math.floor(maxWaves) || 2, ownerCap || 1))
  const waves = []
  const waveGap = Math.max(0, Number(waveGapSec) || 20)
  for (let k = 0; k < candidates.length && waves.length < capWaves; k++) {
    const at = candidates[k].at
    const group = []
    for (let j = k; j < candidates.length && candidates[j].at <= at + groupSpanSec; j++) group.push(candidates[j])
    k += group.length - 1
    if (waves.length && at < waves[waves.length - 1].at + waveGap) continue
    const value = group.reduce((a, c) => a + c.value, 0)
    const spots = group.length
    // 打赢每处多拿 1 个 → 额外收益 = 各处的单件价之和
    const bonus = group.reduce((a, c) => a + (c.unit || 0), 0)
    // 体力用规则原文的公式（R:200-202）：base + (spots−1)*per − 风声口哨。
    // 旧版把 perSpot 写死成 1 且不减口哨，手动装了口哨时每次多算 1 点。
    let energy
    try {
      energy = R.b12StealCost(state || {}, now, spots, energyBase, Number(rules?.perSpot) || 1, energyMax)
    } catch {
      energy = Math.min(energyMax, energyBase + Math.max(0, spots - 1))
    }
    const ev = stealEV({ value, bonus, targets: group, detect, guard, level, fineMax, energy }, myLevel, energyValue)
    if (ev >= minEV) waves.push({ at, group, ev, value })
  }

  const w0 = waves[0] || null
  rec.nextAt = w0 ? w0.at : 0
  rec.nextGroup = w0 ? w0.group : []
  rec.nextEV = w0 ? w0.ev : 0
  rec.upcoming = w0 ? w0.group.map((c) => ({
    kind: c.kind, i: c.i, unlockAt: c.at, exact: true, item: c.item, unit: c.unit || 0,
  })) : []
  // 后续波次（不含当前这一波）。偷成功后由 advanceIsleWave 逐波提升，
  // 不能像以前那样整段清空——那样第二批成熟时就再也想不起来了。
  rec.waves = waves.slice(1).map((w) => ({
    at: w.at, ev: Math.round(w.ev), value: Math.round(w.value || 0),
    entries: w.group.map((c) => ({
      kind: c.kind, i: c.i, unlockAt: c.at, exact: true, item: c.item, unit: c.unit || 0,
    })),
  }))
  rec.ownerLeft = ownerLeft == null ? null : Math.max(0, Math.floor(Number(ownerLeft) || 0))
  // 回访时刻：
  //   · 有未来目标 → 解禁前 prepLeadSec 秒去（但不早于 60 秒后，也不晚于一个 patrol 周期）
  //   · 没有 → 一个 patrol 周期后再看
  rec.checkAt = rec.nextAt
    ? Math.max(now + 60, Math.min(rec.nextAt - Math.max(2, prepLeadSec || 0), now + checkEvery))
    : now + checkEvery
  return { rec, upcoming: rec.upcoming }
}

/**
 * 这一波偷完之后把下一波提升上来。
 *
 * 旧版在 stealFromTargets 里直接 `rec.upcoming = []`，等于「这座岛以后没有解禁时刻」，
 * 第二批成熟要么等下一次全量巡逻（默认 30 分钟，早被别人抢了），要么被
 * sweepStaleUnlocks 当成过期记录删掉。现在按 waveGap 排好的后续波次留在 rec.waves 里，
 * 这里只做「删掉刚处理完的这一波、把后面的提上来」。
 *
 * @param rec    调度记录
 * @param now    当前时间
 * @param opts.completedAt 刚刚处理完的那一波的解禁时刻（过滤掉比它更早的波）
 * @returns {boolean} 是否还有后续波次
 */
export function advanceIsleWave(rec, now, { completedAt = 0, graceSec = 5 } = {}) {
  if (!rec) return false
  const base = Math.max(Number(now) || 0, Number(completedAt) || 0)
  // 已经到点或过点的后续波次不再等：它们和刚处理完的这一波几乎同时，
  // 再去也只会撞上同一个窗口。留一点余量给「提交刚回来」的延迟。
  const rest = (rec.waves || []).filter((w) => w && Number(w.at) > base - graceSec)
  const next = rest[0] || null
  if (!next) {
    rec.waves = []
    rec.upcoming = []
    rec.nextGroup = []
    rec.nextAt = 0
    rec.nextEV = 0
    rec.checkAt = base + 60
    return false
  }
  rec.waves = rest.slice(1)
  rec.nextAt = Number(next.at) || 0
  rec.nextGroup = (next.entries || []).map((e) => ({
    kind: e.kind, i: e.i, at: e.unlockAt, item: e.item, unit: e.unit, value: 0,
  }))
  rec.nextEV = Number(next.ev) || 0
  rec.upcoming = (next.entries || []).slice()
  rec.checkAt = Math.max(base + 60, rec.nextAt - 15)
  return true
}

/**
 * 从整张调度表里找出「下一个解禁时刻」。
 * 返回 { at, targetId, name, items, leadSec } 或 null。
 *
 * leadSec 是提前量：榜一用 T_prep 提前展开（换装 + 冷却），
 * 我们只需要提前几秒让主循环醒来、拉一次最新世界状态即可。
 */
export function nextUnlock(schedule, now, { leadSec = 8, graceSec = EXPIRED_GRACE_SEC, wakeGraceSec = WAKE_GRACE_SEC } = {}) {
  let best = null
  for (const [id, rec] of Object.entries(schedule || {})) {
    for (const u of rec.upcoming || []) {
      // 已经过了解禁时刻的，只给一小段宽限（wakeGraceSec）用来「刚到点就抢」。
      //
      // 注意这里**不能**用 graceSec（300 秒）：那是「记录保留多久」，
      // 拿它当唤醒宽限会让主循环在解禁后 5 分钟内每 1~4 秒醒一次。
      // 线上 04:47 就是这样空转了两分钟，10 点那段则累积了 230 次假唤醒。
      if (u.unlockAt < now - wakeGraceSec) continue
      if (!best || u.unlockAt < best.at) {
        best = { at: u.unlockAt, targetId: Number(id), item: u.item, exact: u.exact, kind: u.kind }
      }
    }
  }
  if (!best) return null
  // 提前 leadSec 秒醒来，留出拉状态 + 提交的时间。
  // 已经到点（at <= now）时 wakeIn 会是 0 或负数，夹到 1 秒即可——
  // 但这种情况只在 wakeGraceSec 宽限内出现，不会再变成长期空转。
  best.wakeIn = Math.max(1, best.at - now - leadSec)
  return best
}

/**
 * 偷菜狙击的自适应节流上下限（秒）。
 *
 * 为什么要节流：同一时刻可能有多座岛解禁，如果每一条都唤醒主循环，
 * 就成了「醒来 → 扫一遍 → 什么都没偷到 → 退避 → 又被下一条催醒」。
 *
 * 下限从 60 秒降到 10 秒：调度表现在只存「EV 过线的一组」，
 * 不再像 v2 那样把每块「成熟在保护期」的地都记成 15 分钟后解禁，
 * 误唤醒的来源已经消失；10 秒足以避免同一波重复醒，又不会把
 * 60 秒内接踵而至的第二波真目标挡在门外。
 *
 * 偷到就恢复敏锐（10 秒），连续偷不到就逐步放宽到 900 秒——
 * 抢不到的原因（被别人抢先 / 守家太强）不会因为多醒几次而改变。
 */
export const SNIPE_MIN_GAP_SEC = 10
export const SNIPE_MAX_GAP_SEC = 900

/**
 * 「此刻值不值得为偷菜解禁醒一次」——带节流。
 *
 * 和直接调 nextUnlock 的区别：
 *   1. 距上次狙击不足 stealWakeGap 秒 → 不醒（不管有多少条到点）
 *   2. 只认「leadSec + 5 秒内就要解禁」的那一条，未来几个小时的不算
 *
 * @returns 命中的那条 nextUnlock 结果，或 null
 */
export function shouldSnipe(memo, schedule, now, { leadSec = 8, graceSec = WAKE_GRACE_SEC } = {}) {
  const gap = Math.max(SNIPE_MIN_GAP_SEC, memo?.stealWakeGap || SNIPE_MIN_GAP_SEC)
  if (now - (memo?.stealWakeAt || 0) < gap) return null
  const nx = nextUnlock(schedule || {}, now, { leadSec, wakeGraceSec: graceSec })
  if (!nx) return null
  if (nx.at < now - graceSec) return null
  if (nx.at - now > leadSec) return null
  return nx
}

/**
 * 一次狙击结束后回调：偷到了就恢复敏锐，连续没偷到就逐步放宽间隔。
 * got 是这一轮偷到的件数（0 表示白醒一趟）。
 */
export function noteSnipeResult(memo, got) {
  if (!memo) return
  if (got > 0) {
    memo.stealWakeGap = SNIPE_MIN_GAP_SEC
    return
  }
  const cur = Math.max(SNIPE_MIN_GAP_SEC, memo.stealWakeGap || SNIPE_MIN_GAP_SEC)
  memo.stealWakeGap = Math.min(SNIPE_MAX_GAP_SEC, cur * 2)
}

/**
 * 把「同一瞬间解禁」的条目聚成一波。
 *
 * 每座岛只存自己最早的一组，但不同岛的解禁时刻可能只差几秒；
 * 一次把所有同波岛都访问一遍，才能在窗口内抢到更多家。
 *
 * @returns {{ at, targets, isles, wakeIn } | null}
 *   targets  波内所有条目 [{ targetId, kind, i, item, at, exact }]
 *   isles    按岛聚合 [{ targetId, entries }]，按最早解禁排序
 */
export function nextWave(schedule, now, { leadSec = 0, waveSpanSec = 2, graceSec = WAKE_GRACE_SEC } = {}) {
  let base = Infinity
  for (const rec of Object.values(schedule || {})) {
    for (const u of rec?.upcoming || []) {
      if (u.unlockAt < now - graceSec) continue
      if (u.unlockAt < base) base = u.unlockAt
    }
  }
  if (!Number.isFinite(base)) return null

  const targets = []
  for (const [id, rec] of Object.entries(schedule || {})) {
    for (const u of rec?.upcoming || []) {
      // base 已经是最早的那条，比它早的只可能是刚刚过期、被上面跳过的记录
      if (u.unlockAt < base || u.unlockAt > base + waveSpanSec) continue
      targets.push({
        targetId: Number(id), kind: u.kind, i: u.i, item: u.item || '',
        at: u.unlockAt, exact: !!u.exact,
      })
    }
  }
  const byIsle = new Map()
  for (const t of targets) {
    if (!byIsle.has(t.targetId)) byIsle.set(t.targetId, [])
    byIsle.get(t.targetId).push(t)
  }
  const isles = [...byIsle.entries()]
    .map(([targetId, entries]) => ({ targetId, entries }))
    .sort((a, b) => a.entries[0].at - b.entries[0].at)
  return {
    at: base,
    targets,
    isles,
    wakeIn: Math.max(1, base - now - leadSec),
  }
}

/**
 * 提前量 T_prep：解禁前多少秒该醒。
 *
 * 醒来后要先串行访问波内每一家（visitInfo，约 1.5 秒/家）拿最新的
 * steal 标记，访问完最后一家才能开始提交。所以提前量 ≈ 访问耗时
 * 加一次请求间隔的余量：
 *   · 太早——白等，还可能在等待期间被别人抢走
 *   · 太晚——访问完就已经过了窗口
 *
 * 榜一的 computePhysicalPrepLeadSec 还把「准备动作」也算进来：
 *   actPrep  = 剩余 act 冷却 + minGap + 2×RTT   （吃口粮/喝咖啡/买道具）
 *   gearPrep = 剩余 equip 冷却 + 槽位数×1.3 + 2×RTT
 * 以前这里只算了换装、没算吃口粮，于是「醒来 → 补体力（2.15 秒）→ 提交」
 * 必然把第一批货拖到解禁后 2~5 秒；线上 11-13 13:21 那次就是这样丢了 3 处。
 *
 * 上限 30 秒（要换装/提前补体力时跟着放宽）：一波再大也只能先到先得，
 * 跑不完的部分留给下一轮（醒来后按价值排序，高价值的先跑）。
 */
export function prepLeadSec(nIsles, {
  visitSec = 1.5, slackSec = 4, maxSec = 30,
  gearSwaps = 0, gearSwapSec = 2.2,
  // 解禁前补体力的那一个 POST：由调用方按「剩余 POST 冷却 + minGap + 2×RTT」算好传进来。
  prepActSec = 0,
} = {}) {
  const n = Math.max(1, Number(nIsles) || 1)
  // 战前换装是 POST，受 2.15 秒串行间隔约束。把这几秒算进提前量，
  // 否则「换完装已经过了解禁时刻」——掐点偷菜最怕的就是这个。
  const swapSec = Math.max(0, Number(gearSwaps) || 0) * gearSwapSec
  const prepSec = Math.max(0, Number(prepActSec) || 0)
  const extraCap = (swapSec > 0 ? 15 : 0) + (prepSec > 0 ? 10 : 0)
  return Math.min(maxSec + extraCap, Math.max(2, Math.ceil(n * visitSec + slackSec + swapSec + prepSec)))
}

/**
 * 偷菜前要不要换装、换几件。
 *
 * 换装是 POST（每个槽位约 2.2 秒），提前量必须算上；但只有
 * 「擂台开着 + 自动装备 + 偷菜前换装 + 用档案模拟守家」四项同时成立才会换。
 * 三个调用点（engine 唤醒 / social 掐点 / planner nextWake）必须同一口径。
 */
export function stealGearSwaps(cfg) {
  const arena = cfg?.arena || {}
  const battle = cfg?.battle || {}
  return (arena.enabled && arena.autoEquip !== false &&
    battle.stealSwap !== false && battle.guardPosterior !== false) ? 3 : 0
}

/**
 * 掐点唤醒的完整提前量：访问耗时 + 换装 + 解禁前补体力。
 *
 * 唤醒时刻、主循环的 shouldSnipe、以及 stealRound 内部的等待用的是同一个值。
 * 以前三处各算各的（planner 连换装都没算），结果引擎按 8 秒醒来，
 * 换装的 6.6 秒加上去，解禁那一刻还在排队。
 *
 * @param {object} args
 *   schedule     调度表（决定这一波有几家）
 *   now          当前时间（秒）
 *   gearSwaps    这一波要换几件装（0 = 不换）
 *   needPrepAct  解禁前是否需要补体力
 *   remainingPostCdMs 下一个 POST 还要等多久（毫秒）
 *   minGapSec    POST 最小间隔
 *   rttMs        最近往返耗时
 *   fixedLeadSec 配置里写死的提前量（>0 时直接用它）
 */
export function physicalPrepLeadSec({
  schedule = {}, now = 0, gearSwaps = 0,
  needPrepAct = false, remainingPostCdMs = 0, minGapSec = 2.15, rttMs = 600,
  fixedLeadSec = 0, ...leadOpts
} = {}) {
  if (Number(fixedLeadSec) > 0) return Number(fixedLeadSec)
  const prepActSec = prepActLeadSec({ needPrep: needPrepAct, remainingPostCdMs, minGapSec, rttMs })
  return waveLeadSec(schedule, now, { ...leadOpts, gearSwaps, prepActSec })
}

/**
 * 解禁前补体力要预留多久（秒）。移植自榜一的 computePhysicalPrepLeadSec：
 *   剩余 POST 冷却 + minGap + 2×RTT
 * 只在「当前体力不够这一波」时才需要；够了就不占提前量。
 */
export function prepActLeadSec({ needPrep = false, remainingPostCdMs = 0, minGapSec = 2.15, rttMs = 600 } = {}) {
  if (!needPrep) return 0
  const rttSec = Math.max(0.4, Math.min(2.0, Number(rttMs) / 1000))
  return Math.max(0, Number(remainingPostCdMs) / 1000) + Math.max(1.5, Number(minGapSec) || 2.15) + 2 * rttSec
}

/**
 * 为「即将解禁的偷菜」预留体力（榜一 computeImminentSnipeStaminaReservation 的移植）。
 *
 * 为什么需要：以前是临到解禁那一刻才在 stealFromTargets 里现场吃口粮，
 * 一个 POST 2.15 秒，等吃完货已经被抢光（11-13 13:21 实测）。
 * 现在把「到解禁前会缺多少体力」提前算出来，交给规划器的 keep：
 * 钓鱼/挖矿/炸矿不会把体力花到不够偷，解禁那一刻只需要发一个 visit 请求。
 *
 *   need        = min(maxEnergy, max(6, 这一组几处需要的体力))
 *   naturalRegen= floor(距离解禁还有多久 / regen)
 *   floorNow    = clamp(need − naturalRegen, 0, energyMax)
 *
 * 只统计 horizonSec 内、且 rec.nextEV 过线的记录（updateIsleSchedule 已经
 * 把「不值得去的解禁」过滤掉了）。
 *
 * @returns {{ floor:number, until:number, targetId:number|null, unlockAt:number, need:number }}
 *   floor  现在必须保留的体力
 *   until  保留到什么时候（解禁时刻）；没有目标时为 0
 */
export function snipeStaminaReservation(schedule, now, {
  horizonSec = 900, regenSec = 180, energyMax = 200,
  maxEnergy = 15, energyBase = 5,
} = {}) {
  let floor = 0
  let until = 0
  let targetId = null
  let needAtUnlock = 0
  const horizonEnd = now + Math.max(0, Number(horizonSec) || 0)
  for (const [id, rec] of Object.entries(schedule || {})) {
    if (!rec || !(Number(rec.nextEV || 0) > 0)) continue
    const upcoming = (rec.upcoming || []).filter((u) => u && Number.isFinite(u.unlockAt))
    if (!upcoming.length) continue
    // 只认这座岛最早的那一组（updateIsleSchedule 已经把同一组的条目放在一起）。
    const at = Math.min(...upcoming.map((u) => Number(u.unlockAt)))
    const lead = at - now
    if (lead < -10 || lead > horizonEnd - now) continue
    const spots = Math.max(1, upcoming.length)
    const need = Math.min(maxEnergy, Math.max(6, energyBase + Math.max(0, spots - 1)))
    const naturalRegen = lead > 0 ? Math.floor(lead / Math.max(60, regenSec)) : 0
    const floorNow = Math.min(Math.max(0, Number(energyMax) || 200), Math.max(0, need - naturalRegen))
    if (floorNow > floor) {
      floor = floorNow
      until = at
      targetId = Number(id)
      needAtUnlock = need
    } else if (floorNow > 0 && floorNow === floor) {
      until = Math.max(until, at)
    }
  }
  return { floor, until: floor > 0 ? until : 0, targetId, unlockAt: until, need: needAtUnlock }
}

/**
 * 偷菜窗口是否已经打开（榜一 shouldBlockBackgroundWork 的等价物）。
 *
 * 「有目标在 leadSec + 4 秒内解禁」或「刚解禁 30 秒内」都算窗口：
 * 这段时间里不该让五子棋/擂台/帮忙/修仙的 POST 插队——每个 POST 都要
 * 占 2.15 秒，插一个就可能把解禁那一刻的请求推到窗口外。
 */
export function snipeWindowOpen(schedule, now, { leadSec = 8, graceSec = WAKE_GRACE_SEC, extraSec = 4 } = {}) {
  const nx = nextUnlock(schedule || {}, now, { leadSec, wakeGraceSec: graceSec })
  if (!nx) return null
  if (nx.at < now - graceSec) return null
  if (nx.at - now > leadSec + extraSec) return null
  return nx
}

/** 当前这一波该提前几秒醒；没有待解禁记录时返回 fallback */
export function waveLeadSec(schedule, now, { fallback = 8, ...opts } = {}) {
  const wave = nextWave(schedule, now, { ...opts, leadSec: 0 })
  if (!wave) return fallback
  return prepLeadSec(wave.isles.length, opts)
}

/**
 * 汇总调度表，给 GUI / 日志用。
 */
export function scheduleSummary(schedule, now) {
  const rows = []
  for (const [id, rec] of Object.entries(schedule || {})) {
    for (const u of rec.upcoming || []) {
      rows.push({
        targetId: Number(id),
        kind: u.kind,
        i: u.i,
        item: u.item,
        unlockAt: u.unlockAt,
        inSec: Math.max(0, u.unlockAt - now),
        exact: !!u.exact,
      })
    }
  }
  rows.sort((a, b) => a.unlockAt - b.unlockAt)
  return rows
}
