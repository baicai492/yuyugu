// 串门：帮忙（稳定小收益）与偷菜（高风险高收益）。
//
// 帮忙：每天 10 家，每家 1 次，每次 1 体力，得 200 D + 2 经验，D币日上限 4000。
// 偷菜：每次 5 体力起（每多一处 +1，上限 15），被发现则打一场守家战，
//       输了按市价 1.2 倍赔（单次上限 5000，每日 20000）。
import { randomUUID } from 'node:crypto'
import { updateIsleSchedule, nextUnlock } from './steal-schedule.mjs'

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
  if (world.state.en < (g.minEnergy ?? 20)) return { helped: 0, coins: 0 }

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
  const snipeReady = !!nx && nx.at - world.now <= (st.prepLeadSec ?? 8) + 5
  const overdue = Object.values(memo.stealSchedule || {})
    .some((rec) => (rec.upcoming || []).some((u) => u.unlockAt < world.now - 10 && u.unlockAt > world.now - 300))

  if (world.now - lastScan < every && !snipeReady && !overdue) return { stolen: 0, value: 0 }
  if (snipeReady) log(`偷菜：精确解禁时刻已到，提前打断扫描间隔`)
  else if (overdue && world.now - lastScan < every) log(`偷菜：有已解禁未处理的目标，提前扫描`)

  memo.stealScanAt = world.now
  const targets = await scanStealTargets(world, cfg, log, memo)
  let stolen = 0, value = 0, tried = 0
  for (const tg of targets) {
    if (tried >= (st.visitsPerScan ?? 8)) break
    if (tg.value < (st.minValue ?? 3000)) continue
    if (world.state.en < Math.min(tg.energy, st.maxEnergy ?? 15)) break
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
    await sleep(1500)
  }
  if (stolen) log(`本轮偷菜小结：${stolen} 处，${Math.round(value).toLocaleString('en-US')} D（去了 ${tried} 家）`)
  else if (tried) log(`本轮偷菜：去了 ${tried} 家，没有收获`)
  return { stolen, value }
}
