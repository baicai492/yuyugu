// 串门：帮忙（稳定小收益）与偷菜（高风险高收益）。
//
// 帮忙：每天 10 家，每家 1 次，每次 1 体力，得 200 D + 2 经验，D币日上限 4000。
// 偷菜：每次 5 体力起（每多一处 +1，上限 15），被发现则打一场守家战，
//       输了按市价 1.2 倍赔（单次上限 5000，每日 20000）。
import { randomUUID } from 'node:crypto'
import { updateIsleSchedule, nextUnlock, EXPIRED_GRACE_SEC, WAKE_GRACE_SEC, SNIPE_MIN_GAP_SEC } from './steal-schedule.mjs'
import { energyActions } from './planner.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wget(world, path) {
  return world.client.get('/api/pet/world/' + path)
}
async function wpost(world, path, body) {
  return world.client.post('/api/pet/world/' + path, body)
}

/** 拉邻居目录（分页） */
export async function neighbors(world, { q = '', cursor = null, limit = 20, marked = false, stealable = false } = {}) {
  const p = new URLSearchParams({ limit: String(limit), q })
  if (cursor) p.set('cursor', cursor)
  // a4a62d77 新增：stealable=1 只返回「列表生成时可偷」的岛，省掉大量无效访问
  if (stealable) p.set('stealable', '1')
  return wget(world, (marked ? 'neighbors/marked' : 'neighbors') + '?' + p)
}

/** 拉某座岛的状态 */
export async function visitInfo(world, id) { return wget(world, 'visit/' + id) }

/**
 * 帮忙：去某座岛一键帮忙。
 * 返回 { coins, xp, energy, aff, done }
 */
export async function helpIsle(world, id) {
  const r = await wpost(world, 'help/' + id, { operation: randomUUID() })
  if (r.state) world.accept({ state: r.state })
  return r.result || {}
}

/**
 * 帮忙日常：扫目录、挑「能帮的」去帮，直到用满当天额度。
 * 每天 10 家、每家 1 次；同一家今天帮过就跳过。
 */
export async function helpDaily(world, cfg, log = () => {}, memo = {}) {
  const g = cfg.social?.help
  if (!g?.enabled) return { helped: 0, coins: 0 }
  const R = world.R
  const day = R.worldDay(world.now)
  if (memo.helpDay !== day) { memo.helpDay = day; memo.helpedIds = new Set(); memo.helpCount = 0 }
  const memoHelp = memo.helpedIds || (memo.helpedIds = new Set())

  let helped = 0, coins = 0
  const perDay = g.perDay ?? 10
  if ((memo.helpCount || 0) >= perDay) return { helped: 0, coins: 0 }
  // 体力不够就先攒。但**必须说一声**：以前这里直接 return，
  // 日志里完全看不出帮忙停摆的原因，只能看到偷菜那一行，
  // 让人以为帮忙根本没被调用（实测今天停在 5/10 家，29 次静默跳过）。
  const needE = g.minEnergy ?? 20
  if (world.state.en < needE) {
    const last = memo.helpWaitLogged
    // 只在体力档次变化时打一次，别每轮刷屏
    if (last !== `${memo.helpCount}|${Math.floor(world.state.en)}`) {
      memo.helpWaitLogged = `${memo.helpCount}|${Math.floor(world.state.en)}`
      log(`帮忙：等体力（当前 ${Math.floor(world.state.en)}，要 ${needE} 才动手）` +
        `，今日 ${memo.helpCount || 0}/${perDay}`)
    }
    return { helped: 0, coins: 0 }
  }

  let cursor = null
  let pages = 0, scanned = 0, skippedNewbie = 0, tried = 0
  const need = () => perDay - (memo.helpCount || 0)
  while (helped < need() && pages++ < (g.maxPages ?? 8)) {
    let d
    try { d = await neighbors(world, { cursor, limit: 20 }) } catch (e) { log('读邻居失败：' + e.message); break }
    for (const o of d.neighbors || []) {
      scanned++
      if (helped >= need()) break
      if (memoHelp.has(o.id)) continue
      if (world.state.en < (g.minEnergy ?? 20)) break
      if (o.newbie) { skippedNewbie++; continue }        // 新手 24 小时内不可互动
      // 关键：能不能帮，以服务端的 canHelp 为准。
      // 旧代码用 `if (!(o.plots + o.pens)) continue` ——
      // 但列表里的 plots/pens 表示「当前有可偷/可采的东西」，不是「能帮忙」。
      // 实测 120 个邻居里 canHelp=true 的有 118 个，而 plots+pens>0 的只有 2 个，
      // 也就是说 116 个能帮的岛被那句判断全部跳过了。
      const canHelp = o.canHelp !== undefined ? !!o.canHelp : true
      if (!canHelp) continue
      tried++
      try {
        const res = await helpIsle(world, o.id)
        memoHelp.add(o.id)
        memo.helpCount = (memo.helpCount || 0) + 1
        helped++
        coins += res.coins || 0
        if (res.energy != null) world.state.en = Math.max(0, (world.state.en || 0) - res.energy)
        // 每家一行明细（旧版格式）：干了什么、拿多少、亲密度、花多少体力
        const did = Object.entries(res.done || {}).map(([k, n]) => `${k}×${n}`).join(' ') || '帮了一把'
        log(`  帮 ${res.owner || o.name} 干活：${did}，+${Math.round(res.coins || 0).toLocaleString('en-US')} D` +
          `${res.aff != null ? `，亲密度 ${res.aff}` : ''}${res.energy != null ? `，体力 -${res.energy}` : ''}`)
      } catch (e) {
        // 今天帮过 / 已达上限 → 记为已处理，别再试
        if (e.status === 409 || /今天帮过|已经帮|上限|额度/.test(e.message)) memoHelp.add(o.id)
        else log(`帮 ${o.name} 失败：${e.message}`)
      }
      await sleep(1200)
    }
    cursor = d.nextCursor
    if (!cursor) break
  }
  if (helped) {
    log(`帮忙 ${helped} 家，+${Math.round(coins).toLocaleString('en-US')} D（今日累计 ${memo.helpCount || 0}/${perDay}）`)
  } else {
    log(`帮忙：扫了 ${pages} 页 ${scanned} 家（尝试 ${tried} 家` +
      `${skippedNewbie ? `，跳过新手 ${skippedNewbie}` : ''}）没帮到，今日 ${memo.helpCount || 0}/${perDay}，稍后再试`)
  }
  return { helped, coins }
}

/**
 * 从一次 visit 响应里抽出「现在能偷」的目标和估值。
 * scanStealTargets 和 watchRound 共用，保证两边口径一致。
 */
function targetsFromIsle(R, world, isle, rules) {
  const targets = []
  let value = 0
  ;(isle.plots || []).forEach((pl, i) => {
    if (!pl?.steal) return
    // 保护期：成熟后一段时间内不可偷。服务端已用 steal 标记，直接信它。
    targets.push({ kind: 'plot', i })
    value += (world.prices[pl.c] || R.BASE_PRICE[pl.c] || 0) * (rules.perPlot || 2)
  })
  ;(isle.barn || []).forEach((pen, i) => {
    if (!pen?.steal) return
    targets.push({ kind: 'pen', i })
    const def = R.ANIMALS.find((a) => a.id === pen.k)
    value += (world.prices[def?.product] || def?.productPrice || 0) * (rules.perPen || 2)
  })
  return { targets, value }
}

/**
 * 扫目录，找出「现在能偷」的岛：有成熟作物或窝里有产物，且过了保护期、不在新手保护。
 * 同时把每座岛的「即将解禁」时刻记进 memo.stealSchedule，供 nextWake 精确唤醒。
 * 返回 [{ id, name, level, guard, targets: [...], value }]
 */
export async function scanStealTargets(world, cfg, log = () => {}, memo = {}) {
  const R = world.R
  const t = world.now
  const out = []
  const schedule = memo.stealSchedule || (memo.stealSchedule = {})
  let upcomingCount = 0
  const pages = cfg.social?.steal?.pages ?? 6
  let cursor = null, scanned = 0, skipped = 0
  // 是否成功用上了「只看可偷」筛选。必须声明在循环外——循环末尾的日志要用它。
  let usedFilter = true
  for (let p = 0; p < pages; p++) {
    let d
    // 站点 a4a62d77 起支持只列可偷的岛；列表是「生成时」的快照，抵达后仍需核对
    try { d = await neighbors(world, { cursor, limit: 20, stealable: true }) }
    catch (e) {
      // 老版本站点不支持这个参数，退回全量扫描
      usedFilter = false
      try { d = await neighbors(world, { cursor, limit: 20 }) } catch (e2) { log('扫目录失败：' + e2.message); break }
    }
    for (const o of d.neighbors || []) {
      scanned++
      if (o.newbie) { skipped++; continue }        // 新手保护（创建后 24 小时）
      if (!(o.plots + o.pens)) { skipped++; continue }
      // 用了可偷筛选时，服务端已经保证有目标，可以省掉一次访问；
      // 但为了拿到准确的目标与体力消耗，仍然读一次详情（它同时给出 rules）。
      let info
      try { info = await visitInfo(world, o.id) } catch { skipped++; continue }
      const isle = info.isle || {}
      const rules = info.rules || {}

      // 更新这座岛的解禁调度表（记录「还要多久成熟 / 保护期还剩多久」）
      try {
        const prev = schedule[o.id] || null
        const { rec, upcoming } = updateIsleSchedule({ isle, rules, now: t, prev })
        schedule[o.id] = rec
        upcomingCount += upcoming.length
      } catch { /* 调度只是优化，算不出来不影响正常扫描 */ }

      const { targets, value } = targetsFromIsle(R, world, isle, rules)
      if (!targets.length) continue
      out.push({
        id: o.id, name: o.name, level: o.level || 1, guard: !!info.owner?.guard,
        targets, value,
        // 被发现概率：守家道具 +%，我们的轻步斗篷 −%。旧版 inspect() 用它算 EV。
        detect: R.b12Detection(info.state || {}, world.state, t, 0),
        fineMax: rules.fineMax || 5000,
        energy: Math.min(rules.energyMax || 15, (rules.energy || 5) + Math.max(0, targets.length - 1)),
      })
    }
    cursor = d.nextCursor
    if (!cursor) break
  }
  out.sort((a, b) => (b.value / Math.max(1, b.energy)) - (a.value / Math.max(1, a.energy)))
  log(`扫了 ${scanned} 座岛${skipped ? `（跳过 ${skipped} 座）` : ''}，找到 ${out.length} 家可偷` +
    (usedFilter ? '（用了可偷筛选）' : ''))
  // 提示「还有多少处正在保护期、什么时候解禁」——这是旧的到点扫描完全看不到的信息
  if (upcomingCount > 0) {
    const nx = nextUnlock(schedule, t)
    log(`  ${upcomingCount} 处正在生长/保护期` +
      (nx ? `，最近一处 ${nx.item} 在 ${Math.round(nx.at - t)} 秒后解禁${nx.exact ? '（时刻确定）' : '（估计）'}` : ''))
  }
  // 把候选按性价比列出来，方便判断为什么去/不去某一家
  for (const tg of out.slice(0, 6)) {
    log(`  ${tg.name}（Lv${tg.level}${tg.guard ? '·有守家' : ''}）` +
      `${tg.targets.length} 处，估 ${Math.round(tg.value).toLocaleString('en-US')} D，耗 ${tg.energy} 体力` +
      `（每体力 ${Math.round(tg.value / Math.max(1, tg.energy)).toLocaleString('en-US')} D）`)
  }
  if (out.length > 6) log(`  …还有 ${out.length - 6} 家`)
  return out
}

/**
 * 清掉已经到点、却一直没偷成的解禁记录。
 *
 * 判据是「解禁时刻已经过去 leadSec 秒以上」。到了这个点还没偷到，只有两种可能：
 *   · 目标已经被偷满（stolen 到 2）或被别人抢走
 *   · 我们体力不够 / 被守家打跑
 * 两种情况下再留着这条记录都只会让主循环反复「到点醒来 → 扫一遍 → 什么都没做」。
 * 下次真正扫到那座岛时，updateIsleSchedule 会按最新状态重新算出解禁时刻。
 */
function sweepStaleUnlocks(schedule, now, leadSec = 8) {
  for (const [id, rec] of Object.entries(schedule || {})) {
    const list = rec?.upcoming
    if (!Array.isArray(list) || !list.length) continue
    const keep = list.filter((u) => u.unlockAt > now - leadSec)
    if (keep.length !== list.length) {
      rec.upcoming = keep
      if (!keep.length && !Object.keys(rec.plots || {}).length && !Object.keys(rec.pens || {}).length) {
        delete schedule[id]
      }
    }
  }
}

/**
 * 重建「值得盯」的岛列表（watchlist）。
 *
 * 为什么要这张表：服务端的「可偷」筛选只告诉我们**此刻**谁能偷。
 * 线上实测 970 座邻居里成熟的地有 410 块、可偷的 0 块——
 * 每块地一茬最多被偷 2 个（stolen 到 2 就锁死），好地早就被别人扫干净了。
 * 想抢到就只能**掐着解禁那一刻**去，而解禁时刻只有访问过才知道
 * （visit 返回每块地的 left，成熟 + 保护期 = 解禁）。
 * 所以必须提前把活跃的岛看一遍、把解禁时刻记进 stealSchedule，交给 nextWake 掐点。
 *
 * 旧版 v1 也是这么做的：每 2 小时扫一遍全服目录，维护一份「盯」的名单。
 */
export async function refreshWatchList(world, cfg, log = () => {}, memo = {}) {
  const st = cfg.social?.steal
  if (!st) return memo.stealWatch || {}
  const now = world.now
  const every = st.dirEvery ?? 7200
  if (memo.stealWatch && now - (memo.stealWatchAt || 0) < every) return memo.stealWatch

  const watch = {}
  const avoid = new Set((st.avoid || []).map(Number))   // 手动排除的岛
  let cursor = null, seen = 0, kept = 0, pages = 0
  for (let p = 0; p < (st.dirPages ?? 12); p++) {
    let d
    try { d = await neighbors(world, { cursor, limit: 20 }) }
    catch (e) { log('偷菜：读目录失败：' + e.message); break }
    pages++
    for (const o of d.neighbors || []) {
      seen++
      if (o.newbie) continue
      if (avoid.has(o.id)) continue
      // 被自己标记过的岛跳过（旧版 skipMarked；站点有 marked 字段时才生效）
      if (st.skipMarked && o.marked) continue
      const act = Number(o.active) || 0
      // 深页全是早就没人玩的 Lv1 空岛（active 缺失）。至少要 24 小时内活跃过。
      if (!act || now - act > 86400) continue
      watch[o.id] = { name: o.name, level: o.level || 1 }
      kept++
    }
    cursor = d.nextCursor
    if (!cursor) break
    await sleep(600)
  }
  memo.stealWatch = watch
  memo.stealWatchAt = now
  log(`偷菜：目录 ${pages} 页 ${seen} 座岛，盯 ${kept} 座 24 小时内活跃的`)
  return watch
}

/**
 * 逐个访问 watchlist 里的岛，把每块地的解禁时刻记进调度表。
 *
 * 轮转着看：已经有「将来解禁时刻」的岛跳过（交给 nextWake 掐点），
 * 优先看没记录 / 记录已过期的。每轮看 visitsPerScan 家。
 * 返回这一轮顺带发现的「现在就能偷」的目标。
 */
export async function watchRound(world, cfg, log = () => {}, memo = {}) {
  const st = cfg.social?.steal
  const R = world.R
  const now = world.now
  // 巡逻是「顺手」做的，不该每轮巡视都花 10 秒在这上面。
  // 两分钟一批，53 座活跃岛 7 分钟轮完一圈，够掐解禁时刻了。
  const every = st.watchEvery ?? 120
  if (now - (memo.stealWatchRoundAt || 0) < every) return []
  memo.stealWatchRoundAt = now
  const watch = memo.stealWatch || {}
  const ids = Object.keys(watch)
  if (!ids.length) return []
  const schedule = memo.stealSchedule || (memo.stealSchedule = {})
  const per = st.visitsPerScan ?? 12
  const maxAge = st.checkEvery ?? 3600   // 多久没看过就值得再看一眼

  // 轮转起点：保证每个岛都有机会被看到，不会永远只看前几家
  const start = (memo.stealWatchIdx || 0) % ids.length
  const picked = []
  for (let k = 0; k < ids.length && picked.length < per; k++) {
    const idx = (start + k) % ids.length
    const id = ids[idx]
    const rec = schedule[id]
    const future = (rec?.upcoming || []).some((u) => u.unlockAt > now + 30)
    // 有将来解禁时刻，且最近看过了 → 交给掐点，不用重复访问
    if (future && rec?.seenAt && now - rec.seenAt < maxAge) continue
    picked.push({ id: Number(id), name: watch[id].name, level: watch[id].level })
  }
  memo.stealWatchIdx = (start + picked.length) % ids.length

  const out = []
  let ripeSeen = 0, exhausted = 0
  for (const o of picked) {
    let info
    try { info = await visitInfo(world, o.id) } catch { continue }
    const isle = info.isle || {}
    const rules = info.rules || {}
    try {
      const { rec } = updateIsleSchedule({ isle, rules, now, prev: schedule[o.id] || null })
      schedule[o.id] = rec
    } catch { /* 调度失败不影响下面的偷 */ }
    // 统计用：成熟但偷不了的地，说明已经被偷满或还在保护期
    for (const pl of isle.plots || []) {
      if (!pl || pl.stage !== 3) continue
      if (pl.steal) continue
      if ((pl.stolen || 0) >= 2) exhausted++
      else ripeSeen++
    }
    const { targets, value } = targetsFromIsle(R, world, isle, rules)
    if (targets.length) {
      out.push({
        id: o.id, name: o.name, level: o.level || 1, guard: !!info.owner?.guard,
        targets, value,
        detect: R.b12Detection(info.state || {}, world.state, now, 0),
        fineMax: rules.fineMax || 5000,
        energy: Math.min(rules.energyMax || 15, (rules.energy || 5) + Math.max(0, targets.length - 1)),
      })
    }
    await sleep(900)
  }
  if (picked.length) {
    log(`偷菜：看了 ${picked.length} 座岛` +
      (out.length ? `，${out.length} 家现在能偷` : '') +
      (ripeSeen ? `｜${ripeSeen} 块成熟在保护期` : '') +
      (exhausted ? `｜${exhausted} 块已被偷满` : ''))
  }
  return out
}

/** 偷菜道具：轻步斗篷（被发现率 −10 个百分点）+ 折叠菜篮（每处多拿 1 个）。
 *  旧版每次真要去偷之前都会补这两样；新版漏了，配置项成了死代码。 */
export async function ensureThiefItems(world, cfg, log = () => {}) {
  const st = cfg.social?.steal
  if (!st) return
  const R = world.R
  const t = world.now
  const want = []
  if (st.useCloak && !R.b12Effect(world.state, 'stealth', t)) want.push('cloak')
  if (st.useSack && !R.b12Effect(world.state, 'carry', t)) want.push('sack')
  if (!want.length) return
  const reserve = Math.min(cfg.invest?.reserveCoins || 0, 50000)
  const acts = []
  let cost = 0
  for (const id of want) {
    const price = R.THIEF_ITEMS?.[id]?.price || 0
    if (!price) continue
    if (world.coins - cost - price < reserve) continue
    acts.push({ a: 'buy', id })
    cost += price
  }
  if (!acts.length) return
  try {
    const r = await world.act(acts, { silent: true })
    const ok = (r.out || []).filter((o) => o?.ok).length
    if (ok) log(`偷菜：买了${want.map((id) => R.THIEF_ITEMS?.[id]?.name || id).join('、')}（${Math.round(cost).toLocaleString('en-US')} D，24 小时有效）`)
  } catch (e) { log('偷菜：买道具失败：' + e.message) }
}

/** 偷一家（一批全偷） */
export async function stealIsle(world, id) {
  const r = await wpost(world, 'visit/' + id, { operation: randomUUID(), kind: 'all', i: 0 })
  if (r.state) world.accept({ state: r.state })
  return r
}

/**
 * 偷菜一轮：扫描 → 按价值/体力比排序 → 挨个偷。
 * 默认关闭；开启前请确认擂台等级能打过守家鱼。
 */
/**
 * 从调度表里取出「现在到点」的几家，供掐点偷菜直接访问。
 *
 * 为什么需要它：偷菜的价值全在「解禁那一刻」。可偷筛选返回的都是别人
 * 已经漏掉的，真正的好货解禁几秒内就被抢走。线上 2026-11-12 一整天
 * 记下 250 处待解禁、实际偷到 0 件——不是没掐点，是掐到点之后还先扫
 * 一遍目录（40~50 页、上千座岛）再访问十几家邻居，等轮到发包时早过了。
 *
 * 榜一 snipe-scheduler 提前用 T_prep 算好准备时间，醒来直接对目标发包；
 * 我们至少做到：掐点这一轮只访问调度表里到点的那几家。
 */
function nearestUnlockTargets(schedule, watch, now, leadSec, limit = 3) {
  const rows = []
  for (const [id, rec] of Object.entries(schedule || {})) {
    for (const u of rec?.upcoming || []) {
      // 太早的不算（还没到准备窗口），太晚的不算（已经放弃）
      if (u.unlockAt < now - WAKE_GRACE_SEC) continue
      if (u.unlockAt > now + leadSec + 5) continue
      rows.push({ id: Number(id), at: u.unlockAt })
    }
  }
  rows.sort((a, b) => a.at - b.at)
  const seen = new Set(), out = []
  for (const r of rows) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    const w = watch?.[r.id] || {}
    out.push({ targetId: r.id, name: w.name || `岛 ${r.id}`, level: w.level || 1, at: r.at })
    if (out.length >= limit) break
  }
  return out
}

export async function stealRound(world, cfg, log = () => {}, memo = {}) {
  const st = cfg.social?.steal
  if (!st?.enabled) return { stolen: 0, value: 0 }
  const R = world.R
  const lastScan = memo.stealScanAt || 0
  const every = st.scanEvery ?? 1800
  const leadSec = st.prepLeadSec ?? 8

  // 先把「已经处理过 / 已经失效」的解禁记录清掉，再判断要不要绕过扫描间隔。
  //
  // 这一步是这次「每 5 秒输出一次『有已解禁未处理的目标，提前扫描』」的真正解法。
  // 线上日志（2026-11-12 14:07）是这么循环的：
  //   1. 调度表里有 433 条记录（watchRound 巡逻时把「成熟在保护期」的地
  //      全记成 900 秒后解禁，53 座岛 × 平均 8 块）
  //   2. 时间到 → nextWake 给 1 秒 → 主循环立刻醒
  //   3. stealRound 看到 overdue（过期 10 秒以上、300 秒宽限内）→ 绕过扫描间隔去扫
  //   4. 扫描用 stealable=1 筛选，服务端返回 0 家 → 一个岛都没访问
  //      → 那些记录一条都不会被 updateIsleSchedule 更新 → 还留在表里
  //   5. 回到 2，无限循环
  //
  // 关键：一次扫描都没偷到就说明这条记录已经没用了（被偷满 / 已被别人抢走 /
  // 守家打不过）。留着它只会让主循环反复空转。所以过期即弃，
  // 下次真正扫到那座岛时 updateIsleSchedule 会重新算。
  sweepStaleUnlocks(memo.stealSchedule, world.now, leadSec)

  // 体力不够偷任何一家时，先看「能不能补上」，补不上才整轮跳过。
  //
  // 偷菜最便宜也要 rules.energy（服务端常量 5 点）体力。这里的判断以前是
  // 一条硬门槛「en < 5 就整轮跳过」——那是错的：体力被钓鱼/挖矿花光之后，
  // 明明有口粮也照样跳过，于是一整天的偷菜额度都是 0（11-12 全天只偷到 1 处）。
  // 旧版 extension/lib/strategy.mjs 的 energyActions 就是干这个的：
  // 现场吃口粮把体力补到够，只要每点体力的成本不超过 steal.maxEnergyCost。
  //
  // 注意：这里**不**立刻补。扫描（访问岛屿）本身不花体力，先看这一轮有没有
  // 值得偷的目标，有的话在 stealFromTargets 里按那个目标实际需要的体力补，
  // 避免「为了扫一圈先吃掉一份口粮」。
  const minStealE = 5
  const maxPerE = st.maxEnergyCost ?? 600
  if (world.state.en < minStealE) {
    const acts = energyActions(R, world.state, world.prices, {
      need: minStealE, maxPerE, cfg, coins: world.coins,
    })
    if (!acts?.length) {
      const key = `${world.worldDay || ''}:${Math.floor(world.state.en)}`
      if (memo.stealLowEnergyNoted !== key) {
        memo.stealLowEnergyNoted = key
        log(`偷菜：体力不足（${Math.floor(world.state.en)} < ${minStealE}），口粮也补不上，这一轮跳过`)
      }
      return { stolen: 0, value: 0 }
    }
    memo.stealLowEnergyNoted = ''
  }

  // 「解禁时刻到了」必须同时满足两件事才算数：
  //   1. 节流窗口已过 —— 巡逻一圈会记下几百条解禁时刻，平均每 20 秒有一条到点。
  //      不加节流的话每一轮都会判定「有精确时刻」，绕过 scanEvery 全量扫描，
  //      而每次都是「扫了 8 座岛，找到 0 家可偷」。线上 14:32~14:35 刷了 3 分钟。
  //      偷到过就 60 秒一次，连续白醒就翻倍到 15 分钟（见 steal-schedule.mjs）。
  //   2. 这条记录还没过点（nx.at >= now − leadSec）—— 用 <= 单向判断会让
  //      过去很久的记录也算命中，配合 nextWake 的 1 秒候选变成几秒一醒。
  const gap = Math.max(SNIPE_MIN_GAP_SEC, memo.stealWakeGap || SNIPE_MIN_GAP_SEC)
  const wakeReady = world.now - (memo.stealWakeAt || 0) >= gap
  const nx = nextUnlock(memo.stealSchedule || {}, world.now, { leadSec })
  const snipeReady = wakeReady && !!nx && nx.at >= world.now - leadSec && nx.at - world.now <= leadSec + 5
  // 宽限必须和 nextUnlock 的 WAKE_GRACE_SEC 一致。
  // 用 EXPIRED_GRACE_SEC（300 秒）会变成：解禁后 300 秒内每一轮都绕过扫描间隔，
  // 而 nextWake 只在前 30 秒里催醒——中间的 270 秒就成了「醒了就扫、扫了也没用」。
  const overdue = wakeReady && Object.values(memo.stealSchedule || {})
    .some((rec) => (rec.upcoming || []).some((u) => u.unlockAt < world.now - 10 && u.unlockAt > world.now - WAKE_GRACE_SEC))

  if (world.now - lastScan < every && !snipeReady && !overdue) {
    // 还没到全量扫描的时候，但可以顺手巡逻几家 watchlist：
    // 服务端的「可偷」筛选只看得到「此刻已经被别人漏掉的」，
    // 真正的好货是解禁瞬间就被抢的，必须提前记下解禁时刻才能掐到。
    await refreshWatchList(world, cfg, log, memo)
    const watchTargets = await watchRound(world, cfg, log, memo)
    if (!watchTargets.length) return { stolen: 0, value: 0 }
    return await stealFromTargets(world, cfg, log, memo, watchTargets)
  }
  // 到点（snipeReady）或已过点还在宽限内（overdue）都走快速路径。
  //
  // overdue 以前会「绕过扫描间隔做全量扫描」——一次几十秒，扫完目标早没了，
  // 而且下一次解禁照样被拖过去。过点的记录只有两种结局：货被抢光，
  // 或者我们体力/胜率不够；两种情况都只需要去目标岛确认一下，不需要扫全服。
  if (snipeReady || overdue) {
    if (snipeReady) {
      memo.stealWakeAt = world.now
      memo.stealWakePending = true
    }
    // 掐点这一轮**不扫目录**。以前这里只打一行日志就继续往下走，
    // 于是「醒来 → refreshWatchList 拉 40~50 页目录 → watchRound 访问
    // 12 家（每家 sleep 900ms）→ 才开始偷」，几十秒过去了，
    // 解禁的货早被别人抢光。线上 2026-11-12 记下 250 处待解禁、偷到 0 件。
    const cands = nearestUnlockTargets(memo.stealSchedule, memo.stealWatch, world.now, leadSec, 3)
    if (cands.length) {
      log(`偷菜：${snipeReady ? '解禁时刻到了' : '有已解禁未处理的目标'}，直接抢 ${cands.length} 家（不扫目录）`)
      const out = []
      for (const c of cands) {
        let info
        try { info = await visitInfo(world, c.targetId) } catch { continue }
        const isle = info.isle || {}
        const rules = info.rules || {}
        try {
          const { rec } = updateIsleSchedule({ isle, rules, now: world.now, prev: memo.stealSchedule[c.targetId] || null })
          memo.stealSchedule[c.targetId] = rec
        } catch { /* 调度只是优化，算不出来不影响正常偷 */ }
        const { targets, value } = targetsFromIsle(R, world, isle, rules)
        if (!targets.length) continue
        out.push({
          id: c.targetId, name: c.name, level: c.level || 1, guard: !!info.owner?.guard,
          targets, value,
          detect: R.b12Detection(info.state || {}, world.state, world.now, 0),
          fineMax: rules.fineMax || 5000,
          energy: Math.min(rules.energyMax || 15, (rules.energy || 5) + Math.max(0, targets.length - 1)),
        })
      }
      if (out.length) return await stealFromTargets(world, cfg, log, memo, out)
      // 到点了但货已经没了（被抢 / 被偷满）。把这些过时记录清掉，
      // 否则下一轮还是 overdue，主循环会被它反复催醒。
      for (const c of cands) {
        const rec = memo.stealSchedule?.[c.targetId]
        if (rec) rec.upcoming = (rec.upcoming || []).filter((u) => u.unlockAt > world.now)
      }
      return { stolen: 0, value: 0 }
    }
    // 没有可去的候选（记录刚好被 sweep 清掉）→ 落回正常流程
  }

  memo.stealScanAt = world.now
  // 先进 watchlist 看一批：它们带着「成熟 + 保护期」算出来的精确解禁时刻，
  // 是拿到「刚好解禁那几块地」的唯一途径；顺便也能捞到此刻就能偷的。
  await refreshWatchList(world, cfg, log, memo)
  const watched = await watchRound(world, cfg, log, memo)
  const scanned = await scanStealTargets(world, cfg, log, memo)
  const seen = new Set(watched.map((x) => x.id))
  const targets = [...watched, ...scanned.filter((x) => !seen.has(x.id))]
  return await stealFromTargets(world, cfg, log, memo, targets)
}

/**
 * 一次偷菜的期望收益（移植自旧版 extension/lib/social.mjs 的 inspect().ev）。
 *
 *   ev = (1−被发现) × 货值
 *      + 被发现 × (胜率 × (货值 + 每处多拿 1 个) − 败率 × 罚款)
 *      − 体力 × 机会成本
 *
 * 只看货值会系统性地高估：邻居里一半以上的岛有守家鱼，等级比我们高时
 * 胜率只有 30~50%，输一次按货值 1.2 倍赔（上限 5,000 D）。
 * 一批 5,000 D 的货，期望可能只有 1,000 出头——扣掉体力成本就是亏的。
 */
function stealEV(tg, myLevel, energyValue) {
  const spots = Math.max(1, tg.targets?.length || 1)
  const V = tg.value || 0
  const detect = Number.isFinite(tg.detect) ? tg.detect : 0.55
  const pWin = tg.guard
    ? Math.max(0.03, Math.min(0.95, 0.5 + ((myLevel || 1) - (tg.level || 1)) * 0.15))
    : 1
  const bonus = V / spots                     // 打赢：每处多拿 1 个
  const fine = Math.min(tg.fineMax || 5000, V * 1.2)
  const energy = Math.min(tg.energy || 5, 15)
  return (1 - detect) * V + detect * (pWin * (V + bonus) - (1 - pWin) * fine) - energy * energyValue
}

/** 挨个偷。抽出来是因为「巡逻发现的」和「全量扫描发现的」走同一套逻辑。 */
async function stealFromTargets(world, cfg, log, memo, targets) {
  const st = cfg.social?.steal
  const R = world.R
  let stolen = 0, value = 0, tried = 0
  // 有目标但一个都偷不了时，说明是体力不够。要说明白，
  // 否则日志里只有「找到 N 家可偷」然后什么都没发生，看不出原因。
  let starved = 0
  // 我的等级：决定守家战的胜率（旧版 myWhale 缓存 10 分钟）。
  // arenaDaily 每轮都会跑，等级写在 memo.arenaLevel 里；没有就当 1 级（保守）。
  const myLevel = memo.arenaLevel || 1
  const energyValue = st.energyValue ?? 300
  // 真要去偷之前把道具补齐：轻步斗篷（被发现率 −10 个百分点）、
  // 折叠菜篮（每处多拿 1 个）。旧版有这一步，新版漏了。
  // 体力不够但能靠口粮补上的也算「值得」——偷菜本身会现场补体力。
  const canPay = (needE) => world.state.en >= needE || !!energyActions(R, world.state, world.prices, {
    need: needE, maxPerE: st.maxEnergyCost ?? 600, cfg, coins: world.coins,
  })
  const worth = targets.some((t) => stealEV(t, myLevel, energyValue) >= (st.minEV ?? st.minValue ?? 3000) && canPay(Math.min(t.energy, st.maxEnergy ?? 15)))
  if (worth) await ensureThiefItems(world, cfg, log)
  let skippedEV = 0
  for (const tg of targets) {
    if (tried >= (st.visitsPerScan ?? 8)) break
    const needE = Math.min(tg.energy, st.maxEnergy ?? 15)
    // 打输过的岛一小时不去（旧版：v.check = max(v.check, now+3600)）。
    // 守家鱼的强度不会因为我们多去几次而改变，反复去只是反复赔罚款。
    const loseAt = memo.stealLoseAt?.[tg.id] || 0
    if (world.now - loseAt < 3600) continue
    // 期望收益（旧版 inspect() 的 ev）：货值 × 不被发现的概率 + 被发现后的
    // 「打赢多得 1 个 / 打输按 1.2 倍赔款」的期望 − 体力机会成本。
    // 只比货值是不够的——守家比我们强时，去一趟就是白送罚金。
    const ev = stealEV(tg, myLevel, energyValue)
    if (ev < (st.minEV ?? st.minValue ?? 3000)) { skippedEV++; continue }
    // 体力不够这一家：现场补。这是旧版 energyActions 的用法——
    // 偷菜是掐着解禁时刻的机会，错过这次这块地要再等半小时保护期，
    // 而补体力只要几十上百 D。上限 steal.maxEnergyCost 防止口粮太贵时倒亏。
    if (world.state.en < needE) {
      const acts = energyActions(R, world.state, world.prices, {
        need: needE, maxPerE: st.maxEnergyCost ?? 600, cfg, coins: world.coins,
      })
      if (!acts?.length) { starved++; continue }
      try {
        const beforeE = Math.floor(world.state.en)
        const r = await world.act(acts, { silent: true })
        const ok = (r.out || []).filter((o) => o?.ok).length
        if (ok) log(`  偷 ${tg.name} 体力不够（${beforeE} < ${needE}），吃口粮补到 ${Math.floor(world.state.en)}（花 ${Math.round(r.spend || 0).toLocaleString('en-US')} D）`)
      } catch (e) { log(`  偷 ${tg.name} 补体力失败：${e.message}`) }
      if (world.state.en < needE) { starved++; continue }
    }
    tried++
    try {
      const r = await stealIsle(world, tg.id)
      const res = r.result || {}
      const unitOf = (id) => world.prices[id] || R.BASE_PRICE[id] || 0
      const nameOf = (id) => R.ITEM_NAME?.[id] || id

      if (res.outcome === 'win') {
        // 服务端返回 res.items = [[id, n], ...]，可能不止一种货
        const items = res.items?.length ? res.items : (res.item ? [[res.item, res.n || 1]] : [])
        const spots = res.spots || targets.length || 1
        let thisValue = 0
        for (const [id, n] of items) thisValue += unitOf(id) * n
        stolen += spots
        value += thisValue

        // 明细：偷了谁、几处、每样东西多少件、单价、合计
        const detail = items.map(([id, n]) => {
          const u = unitOf(id)
          return `${nameOf(id)}×${n}（${Math.round(u).toLocaleString('en-US')} D/个 = ${Math.round(u * n).toLocaleString('en-US')} D）`
        }).join('　')
        log(`偷 ${tg.name}（Lv${tg.level}${tg.guard ? '·有守家' : ''}）成功：扫 ${spots} 处 → ${detail || `共 ${res.n || 1} 件`}｜合计 ${Math.round(thisValue).toLocaleString('en-US')} D`)
        if (r.battle) {
          const b = r.battle
          const win = b.win ?? b.result === 'win' ?? res.outcome === 'win'
          log(`  守家战${win ? '打赢了' : '打完'}：${b.log?.slice?.(-1)?.[0] || ''}${res.xp ? `，+${res.xp} 擂台经验` : ''}`.trim())
        }
      } else if (res.outcome === 'lose') {
        const spots = res.spots || 1
        // 打不过的岛一小时不再去（旧版：v.check = max(v.check, now + 3600)）。
        // 守家鱼的强度不会因为我们多去几次而改变，反复去只是反复赔罚款。
        ;(memo.stealLoseAt ||= {})[tg.id] = world.now
        log(`偷 ${tg.name}（Lv${tg.level}）被守家鱼打跑：${spots} 处一个没拿到` +
          (res.fine ? `，按市价 1.2 倍赔 ${Math.round(res.fine).toLocaleString('en-US')} D` : '（主人今天罚款已到上限，这次没赔钱）') +
          '，这座岛一小时内不再去')
      } else {
        log(`偷 ${tg.name}（Lv${tg.level}）打平：${res.spots || 1} 处，谁也没占便宜`)
      }
      if (r.energy != null) {
        const spent = (world.state.en || 0) - r.energy
        log(`  体力 ${Math.round(world.state.en)} → ${r.energy}${spent > 0 ? `（−${Math.round(spent)}）` : ''}`)
        world.state.en = r.energy
      }
    } catch (e) {
      log(`偷 ${tg.name} 出错：${e.message}`)
    }
    // 这座岛已经处理过了：把它的解禁记录从调度表里删掉。
    // 不删的话，那个「解禁时刻」还留在表里，nextWake 会一直把它当成
    // 「马上要解禁」来唤醒，造成几秒一次的循环唤醒。
    // 下次真正扫到这座岛时 updateIsleSchedule 会重新算出新的解禁点。
    if (memo.stealSchedule && memo.stealSchedule[tg.id]) {
      const rec = memo.stealSchedule[tg.id]
      rec.upcoming = (rec.upcoming || []).filter((u) => !tg.targets?.some((x) => x.kind === u.kind && x.i === u.i))
    }
    await sleep(1500)
  }
  if (stolen) log(`本轮偷菜小结：${stolen} 处，${Math.round(value).toLocaleString('en-US')} D（去了 ${tried} 家）`)
  else if (tried) log(`本轮偷菜：去了 ${tried} 家，没有收获`)
  else if (starved) {
    const costs = targets
      .filter((t) => t.value >= (st.minValue ?? 3000))
      .map((t) => Math.min(t.energy, st.maxEnergy ?? 15))
    const cheapest = costs.length ? Math.min(...costs) : (st.maxEnergy ?? 15)
    log(`偷菜：${starved} 家可偷但体力不够（当前 ${Math.floor(world.state.en)}，最便宜要 ${cheapest} 点，` +
      `口粮补不上或每点超过 ${st.maxEnergyCost ?? 600} D）`)
  } else if (skippedEV) {
    log(`偷菜：${skippedEV} 家有货但期望收益不够（发现率/守家胜率/体力成本折算后 < ${st.minValue ?? 3000} D），不去`)
  }
  return { stolen, value }
}
