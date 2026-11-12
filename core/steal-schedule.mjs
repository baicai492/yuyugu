// 偷菜精确解禁调度。
//
// 问题：邻居地里的作物成熟后有一段保护期（rules.protect，默认 1800 秒），
// 保护期内偷不了。现在的做法是「到点扫一遍」，运气不好会错过刚解禁的那几块地，
// 白白等下一个扫描周期。
//
// 站点数据里没有「什么时候成熟的」这个时间戳，只有：
//   plots[i] = { c, stage, left, steal, stolen }
//     stage=3  已成熟
//     left     还要多少秒成熟（stage<3 时）
//     steal    现在能不能偷（服务端已经算过保护期）
//     stolen   已经被偷走几个
//
// 所以精确解禁时刻只能靠「我们自己观察到的时间」来推：
//   · 第一次看到「stage=3 且 steal=false 且 stolen=0」→ 它此刻在保护期内，
//     但不知道还剩多久，保守估计 unlockAt = now + protect
//   · 之后每次再看到它还是 steal=false，就往前修正（取更早的那个估计）
//   · 一旦 steal=true，解禁了，记下这次得手/失败
//
// 这与榜一 yuyugu-kernel 的做法一致（execution/snipe-scheduler.mjs）：
//   它同样没有服务端的「成熟时刻」，靠 recordVisitSnapshot 记录观察到的时间，
//   再配合 rule.protect 推算 rawUnlockAt。
// 榜一比我们多做的两件事我们不做：
//   1. 四结局期望（守家胜率 × 罚款）—— 需要对手装备面板，数据拿不到
//   2. 提前 T_prep 秒展开换装 —— 我们没有换装流程，动作提交本身就够快

/**
 * 从一次 visit 快照里读出「即将解禁」的目标，并更新调度表。
 *
 * @param {object} args
 *   isle         visit 返回的 isle
 *   rules        visit 返回的 rules
 *   now          服务端当前时间（秒）
 *   prev         这个岛之前的调度记录（可为 null）
 * @returns {{ rec, upcoming }} rec 是新的记录，upcoming 是 [{kind, i, unlockAt, exact}]
 */
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

export function updateIsleSchedule({ isle, rules, now, prev }) {
  const protect = Number(rules?.protect) || 1800
  const rec = prev ? { ...prev, plots: { ...(prev.plots || {}) }, pens: { ...(prev.pens || {}) } } : { plots: {}, pens: {} }
  rec.seenAt = now
  const upcoming = []

  const note = (kind, idx, entry, { ripe, stealable, readyIn }) => {
    const map = kind === 'plot' ? rec.plots : rec.pens
    const key = String(idx)
    const old = map[key]
    let unlockAt, exact

    if (stealable) {
      // 已经能偷 → 解禁时刻已过，不需要等
      unlockAt = now
      exact = true
    } else if (ripe) {
      // 成熟了但还不能偷 —— 在保护期内。
      //
      // **不记**。线上实测：巡逻看到的成熟地 90% 是 stolen=2（已被偷满 2 个，
      // 服务端直接锁死），剩下的在保护期里的，等它解禁时也早被别人抢光。
      // 靠服务端不给的「成熟时刻」硬猜一个解禁点，猜中了也抢不到，
      // 猜不中就让主循环空转——14:32 的日志里就是每 30 秒醒一次、每次都
      // 「扫了 0 座岛，找到 0 家可偷」。
      // 这一类目标的唯一价值是「现在就能偷」（stealable 分支），已经处理在上面。
      return
    } else if (readyIn > 0) {
      // 还没成熟 → 成熟时刻是确定的（left），解禁 = 成熟 + 保护期。
      // 这是唯一值得掐的时刻：我们能算准它什么时候熟，准点过去。
      //
      // 只记 1 小时内会成熟的：watchlist 53 座岛约 14 分钟轮完一圈，
      // 更远的地巡逻时会被重新算一次，不用提前堆在表里。
      // 以前阈值是 2 小时，53 座岛 × 7 块在长的地 = 380 条记录，
      // 平均每 20 秒有一条到点，把主循环催得团团转（线上 14:32~14:35）。
      const at = now + readyIn + protect
      if (at - now > 3600 + protect) return
      unlockAt = at
      exact = true
    } else {
      return
    }

    map[key] = { unlockAt, exact, kind, i: idx, c: entry.c || entry.k || '', updatedAt: now }
    if (unlockAt > now) upcoming.push({ kind, i: idx, unlockAt, exact, item: entry.c || entry.k || '' })
  }

  ;(isle?.plots || []).forEach((pl, i) => {
    if (!pl) return
    if ((pl.stolen || 0) >= 2) return                 // 这块地今天已经被偷够，没有价值
    const ripe = pl.stage === 3
    note('plot', i, pl, { ripe, stealable: !!pl.steal, readyIn: ripe ? 0 : (pl.left || 0) })
  })

  ;(isle?.barn || []).forEach((pen, i) => {
    if (!pen) return
    // 畜栏：n 是窝里现有产物数量，0 表示还没产出
    const has = (pen.n || 0) > 0
    note('pen', i, pen, { ripe: has, stealable: !!pen.steal, readyIn: 0 })
  })

  // 清掉已经过期的记录。
  //
  // 以前是「解禁超过 1 小时才删」，结果这 1 小时里 nextUnlock 每轮都把它当成
  // 「马上要解禁」报出来，主循环几秒醒一次空转。实际上一次扫描没偷到，
  // 这条记录就该作废了——下次真正扫到这座岛时 note() 会重新算。
  // 留 5 分钟只是为了容忍「解禁那一刻刚好在扫别的岛」。
  for (const map of [rec.plots, rec.pens]) {
    for (const [k, v] of Object.entries(map)) {
      if (v.unlockAt < now - (EXPIRED_GRACE_SEC)) delete map[k]
    }
  }

  upcoming.sort((a, b) => a.unlockAt - b.unlockAt)
  rec.upcoming = upcoming
  return { rec, upcoming }
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
 * 为什么要节流：巡逻一圈 53 座岛会记下几百条「解禁时刻」，平均每 20 秒左右
 * 就有一条到点。如果每一条都唤醒主循环，就成了「醒来 → 扫一遍 → 什么都没偷到
 * → 退避 → 又被下一条催醒」。线上 14:32~14:35 整整刷了 3 分钟这种日志，
 * 一行偷菜收益都没有。
 *
 * 偷到就恢复敏锐（60 秒），连续偷不到就逐步放宽到 900 秒——
 * 抢不到的原因（被别人抢先 / 守家太强）不会因为多醒几次而改变。
 */
export const SNIPE_MIN_GAP_SEC = 60
export const SNIPE_MAX_GAP_SEC = 900

/**
 * 「此刻值不值得为偷菜解禁醒一次」——带节流。
 *
 * 和直接调 nextUnlock 的区别：
 *   1. 距上次狙击不足 stealWakeGap 秒 → 不醒（不管有多少条到点）
 *   2. 只认「leadSec 秒内就要解禁」的那一条，未来几个小时的不算
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
 * 一次巡逻看到的多块地，成熟时刻只差几秒；服务端按「成熟 + 保护期」
 * 算出的解禁时刻也就差几秒。以前 nextUnlock 只返回最早的那一条，
 * 同波的另外几家要等下一轮——而偷菜的窗口只有几十秒，下一轮基本
 * 就轮到别人了。
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
 * 上限 30 秒：一波再大也只能先到先得，跑不完的部分留给下一轮
 * （醒来后按价值排序，高价值的先跑）。
 */
export function prepLeadSec(nIsles, { visitSec = 1.5, slackSec = 4, maxSec = 30 } = {}) {
  const n = Math.max(1, Number(nIsles) || 1)
  return Math.min(maxSec, Math.max(2, Math.ceil(n * visitSec + slackSec)))
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
