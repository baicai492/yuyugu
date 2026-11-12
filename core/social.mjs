// 串门：帮忙（稳定小收益）与偷菜（高风险高收益）。
//
// 帮忙：每天 10 家，每家 1 次，每次 1 体力，得 200 D + 2 经验，D币日上限 4000。
// 偷菜：每次 5 体力起（每多一处 +1，上限 15），被发现则打一场守家战，
//       输了按市价 1.2 倍赔（单次上限 5000，每日 20000）。
import { randomUUID } from 'node:crypto'
import { updateIsleSchedule, nextUnlock, EXPIRED_GRACE_SEC } from './steal-schedule.mjs'

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
  let cursor = null, seen = 0, kept = 0, pages = 0
  for (let p = 0; p < (st.dirPages ?? 12); p++) {
    let d
    try { d = await neighbors(world, { cursor, limit: 20 }) }
    catch (e) { log('偷菜：读目录失败：' + e.message); break }
    pages++
    for (const o of d.neighbors || []) {
      seen++
      if (o.newbie) continue
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
export async function stealRound(world, cfg, log = () => {}, memo = {}) {
  const st = cfg.social?.steal
  if (!st?.enabled) return { stolen: 0, value: 0 }
  const R = world.R
  const lastScan = memo.stealScanAt || 0
  const every = st.scanEvery ?? 1800

  // 有两种情况要绕过「扫描间隔」：
  //   1. 调度表里某处刚好到解禁时刻（这是精确调度，不能等下一个扫描周期）
  //   2. 调度表里记着的解禁时刻已经过去但还没去偷（刚醒过来，别再过 30 分钟）
  const nx = nextUnlock(memo.stealSchedule || {}, world.now, { leadSec: st.prepLeadSec ?? 8 })
  // 「到点了」必须是「还没过点」才算：nx.at 已经过去时（负数差值）也满足 <= 13，
  // 会让每一轮都打断扫描间隔，配合 nextWake 的 1 秒候选变成几秒一醒的空转。
  const snipeReady = !!nx && nx.at >= world.now - (st.prepLeadSec ?? 8) && nx.at - world.now <= (st.prepLeadSec ?? 8) + 5
  const overdue = Object.values(memo.stealSchedule || {})
    .some((rec) => (rec.upcoming || []).some((u) => u.unlockAt < world.now - 10 && u.unlockAt > world.now - EXPIRED_GRACE_SEC))

  if (world.now - lastScan < every && !snipeReady && !overdue) return { stolen: 0, value: 0 }
  if (snipeReady) log(`偷菜：精确解禁时刻已到，提前打断扫描间隔`)
  else if (overdue && world.now - lastScan < every) log(`偷菜：有已解禁未处理的目标，提前扫描`)

  memo.stealScanAt = world.now
  const targets = await scanStealTargets(world, cfg, log, memo)
  let stolen = 0, value = 0, tried = 0
  // 有目标但一个都偷不了时，说明是体力不够。要说明白，
  // 否则日志里只有「找到 N 家可偷」然后什么都没发生，看不出原因。
  let starved = 0
  for (const tg of targets) {
    if (tried >= (st.visitsPerScan ?? 8)) break
    if (tg.value < (st.minValue ?? 3000)) continue
    const needE = Math.min(tg.energy, st.maxEnergy ?? 15)
    if (world.state.en < needE) { starved++; continue }
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
        log(`偷 ${tg.name}（Lv${tg.level}）被守家鱼打跑：${spots} 处一个没拿到` +
          (res.fine ? `，按市价 1.2 倍赔 ${Math.round(res.fine).toLocaleString('en-US')} D` : '（主人今天罚款已到上限，这次没赔钱）'))
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
    log(`偷菜：${starved} 家可偷但体力不够（当前 ${Math.floor(world.state.en)}，最便宜要 ${cheapest} 点）`)
  }
  return { stolen, value }
}
