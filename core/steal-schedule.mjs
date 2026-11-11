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
      // 成熟了但还不能偷 → 在保护期内。
      // 如果之前记过更早的估计，沿用；否则就是「现在才成熟」或「已经保护了一段时间」，
      // 我们不知道具体进展，只能按最坏情况（还要等满 protect）估计。
      unlockAt = old?.unlockAt != null ? Math.min(old.unlockAt, now + protect) : now + protect
      exact = old?.unlockAt != null
    } else if (readyIn > 0) {
      // 还没成熟 → 成熟时刻是确定的（left），解禁 = 成熟 + 保护期
      unlockAt = now + readyIn + protect
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
export function nextUnlock(schedule, now, { leadSec = 8, graceSec = EXPIRED_GRACE_SEC } = {}) {
  let best = null
  for (const [id, rec] of Object.entries(schedule || {})) {
    for (const u of rec.upcoming || []) {
      // 已经过了解禁时刻的，只给一小小段宽限（graceSec）用来「刚到点就抢」，
      // 超过就当作没赶上——它会由 updateIsleSchedule 在下次访问时重新校准。
      //
      // 这里以前是 now - 30，宽限太长：只要有一条记录过期了没偷到，
      // nextUnlock 就会返回 wakeIn=1 的候选，主循环每几秒醒一次空转，
      // 一直持续到 updateIsleSchedule 把那条约 1 小时后才清掉。
      if (u.unlockAt < now - graceSec) continue
      if (!best || u.unlockAt < best.at) {
        best = { at: u.unlockAt, targetId: Number(id), item: u.item, exact: u.exact, kind: u.kind }
      }
    }
  }
  if (!best) return null
  // 提前 leadSec 秒醒来，留出拉状态 + 提交的时间。
  // 已经到点（at <= now）时 wakeIn 会是 0 或负数，夹到 1 秒即可——
  // 但这种情况只在 graceSec 宽限内出现，不会再变成长期空转。
  best.wakeIn = Math.max(1, best.at - now - leadSec)
  return best
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
