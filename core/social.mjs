// 串门：帮忙（稳定小收益）与偷菜（高风险高收益）。
//
// 帮忙：每天 10 家，每家 1 次，每次 1 体力，得 200 D + 2 经验，D币日上限 4000。
// 偷菜：每次 5 体力起（每多一处 +1，上限 15），被发现则打一场守家战，
//       输了按市价 1.2 倍赔（单次上限 5000，每日 20000）。
import { randomUUID } from 'node:crypto'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wget(world, path) {
  return world.client.get('/api/pet/world/' + path)
}
async function wpost(world, path, body) {
  return world.client.post('/api/pet/world/' + path, body)
}

/** 拉邻居目录（分页） */
export async function neighbors(world, { q = '', cursor = null, limit = 20, marked = false } = {}) {
  const p = new URLSearchParams({ limit: String(limit), q })
  if (cursor) p.set('cursor', cursor)
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
  let pages = 0
  while (helped < perDay - (memo.helpCount || 0) && pages++ < 6) {
    let d
    try { d = await neighbors(world, { cursor, limit: 20 }) } catch (e) { log('读邻居失败：' + e.message); break }
    for (const o of d.neighbors || []) {
      if (memoHelp.has(o.id)) continue
      if (world.state.en < (g.minEnergy ?? 20)) break
      // 需要有可帮的东西（有地或窝）
      if (!(o.plots + o.pens)) continue
      try {
        const res = await helpIsle(world, o.id)
        memoHelp.add(o.id)
        memo.helpCount = (memo.helpCount || 0) + 1
        helped++
        coins += res.coins || 0
        if (res.energy) world.state.en -= res.energy
        if (res.energy != null) world.state.en = Math.max(0, (world.state.en || 0) - 0)
      } catch (e) {
        if (e.status === 409 || /今天帮过|已经帮/.test(e.message)) memoHelp.add(o.id)
        else log(`帮 ${o.name} 失败：${e.message}`)
      }
      await sleep(1200)
      if (helped >= perDay - (memo.helpCount - helped)) break
    }
    cursor = d.nextCursor
    if (!cursor) break
  }
  if (helped) log(`帮忙 ${helped} 家，+${Math.round(coins).toLocaleString('en-US')} D`)
  return { helped, coins }
}

/**
 * 扫目录，找出「现在能偷」的岛：有成熟作物或窝里有产物，且过了保护期、不在新手保护。
 * 返回 [{ id, name, level, guard, targets: [...], value }]
 */
export async function scanStealTargets(world, cfg, log = () => {}) {
  const R = world.R
  const t = world.now
  const out = []
  const pages = cfg.social?.steal?.pages ?? 6
  let cursor = null, scanned = 0
  for (let p = 0; p < pages; p++) {
    let d
    try { d = await neighbors(world, { cursor, limit: 20 }) } catch (e) { log('扫目录失败：' + e.message); break }
    for (const o of d.neighbors || []) {
      scanned++
      if (o.newbie) continue                       // 新手保护
      if (!(o.plots + o.pens)) continue
      let info
      try { info = await visitInfo(world, o.id) } catch { continue }
      const isle = info.isle || {}
      const rules = info.rules || {}
      const protect = rules.protect ?? 1800
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
  log(`扫了 ${scanned} 座岛，找到 ${out.length} 家可偷`)
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
  if (world.now - lastScan < (st.scanEvery ?? 1800)) return { stolen: 0, value: 0 }
  memo.stealScanAt = world.now

  const targets = await scanStealTargets(world, cfg, log)
  let stolen = 0, value = 0, tried = 0
  for (const tg of targets) {
    if (tried >= (st.visitsPerScan ?? 8)) break
    if (tg.value < (st.minValue ?? 3000)) continue
    if (world.state.en < Math.min(tg.energy, st.maxEnergy ?? 15)) break
    tried++
    try {
      const r = await stealIsle(world, tg.id)
      const res = r.result || {}
      if (res.outcome === 'win') {
        stolen += res.spots || 1
        value += (res.items || []).reduce((a, [id, n]) => a + (world.prices[id] || R.BASE_PRICE[id] || 0) * n, 0)
        log(`偷 ${tg.name} 成功：${res.n || 1} 件${res.fine ? '' : ''}`)
      } else if (res.outcome === 'lose') {
        log(`偷 ${tg.name} 失败${res.fine ? `，赔 ${Math.round(res.fine)} D` : '（罚款已达上限）'}`)
      } else {
        log(`偷 ${tg.name} 打平`)
      }
      if (r.energy != null) world.state.en = r.energy
    } catch (e) {
      log(`偷 ${tg.name} 出错：${e.message}`)
    }
    await sleep(1500)
  }
  if (stolen) log(`本轮偷到 ${stolen} 处，约 ${Math.round(value).toLocaleString('en-US')} D`)
  return { stolen, value }
}
