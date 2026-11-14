// 游乐馆：弹弹乐 / 鲸鱼桌球 / 鲸鱼保龄。
//
// 设计要点：
//   1. 计分一律用站点自己的 cache/arcade-<ver>.mjs（setup/shoot/step/over/replay），
//      本地模拟与服务端重放逐字一致——这是我们「不移植公式」原则的一部分。
//   2. arcStart 的 seed 由服务端随机生成，所以只能「先开局、拿到 seed、本地求解、
//      再 arcEnd 提交 shots」。不能提前算好棋谱。
//   3. 服务端 arcEnd 会按 shots 确定性重放；MIN_PLAY 秒内结束不计分（次数不退）。
//   4. 不发 D 币，只写 state.arc 与 state.b9Rank（榜单）。价值是「榜一 + 个人纪录」。
//
// 求解器：
//   pool / bowl —— 克隆贪心。状态里没有 RNG（setup 之后 step 不再取随机数），
//                  可以放心克隆分支；实测 1200 / 250（满分）。
//   bounce      —— 每次 settle 会用 w.R 生新道具框，克隆出来的分支会共享同一个
//                  随机数闭包。所以每评估一个候选都从 seed 重建一次前缀状态，
//                  保证每个候选的随机数流都从同一个确定的点开始。耗时略高，但只有 5 甩。

import { arcadeRules } from './rules.mjs'

// 规则原文里 MIN_PLAY 没有 export（cache/arcade-*.mjs 第 130 行），只能照抄。
// 规则热替换后如果站点改了这三个值，会在日志里提示（见 checkMinPlay）。
const MIN_PLAY = { bounce: 5, pool: 6, bowl: 8 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- 求解器 ----------------

function cloneArc(w) {
  const c = { ...w, fish: { ...w.fish }, log: [], events: [] }
  if (w.balls) c.balls = w.balls.map((b) => ({ ...b }))
  if (w.pins) c.pins = w.pins.map((p) => ({ ...p }))
  if (w.frames) c.frames = w.frames.map((f) => (f ? f.slice() : f))
  if (w.items) c.items = w.items.map((i) => ({ ...i }))
  if (w.boxes) c.boxes = w.boxes.map((b) => ({ ...b }))
  if (w.secrets) c.secrets = w.secrets.map((s) => ({ ...s }))
  c.corners = { ...(w.corners || {}) }
  c.wallT = { ...(w.wallT || { x: -9, y: -9 }) }
  return c
}

function stepAll(A, w, cap = 30000) {
  let n = 0
  while (w.moving && n++ < cap) A.step(w)
  return w
}

// pool：a ∈ [-7,7]，p ∈ [0.05,1]；旋转参数不用，固定 0
const POOL_CANDS = (() => {
  const out = []
  for (let a = -7; a <= 7.0001; a += 0.15) {
    for (let p = 0.05; p <= 1.0001; p += 0.04) out.push([+a.toFixed(2), +p.toFixed(2), 0])
  }
  return out
})()

// bowl：a ∈ [-7,7]，p ∈ [0.05,1]，s ∈ [-1,1]（左右旋转打弧线）
const BOWL_CANDS = (() => {
  const out = []
  for (let a = -7; a <= 7.0001; a += 0.5) {
    for (let p = 0.05; p <= 1.0001; p += 0.1) {
      for (const s of [-1, 0, 1]) out.push([+a.toFixed(2), +p.toFixed(2), s])
    }
  }
  return out
})()

const BOUNCE_DIRS = (() => {
  const out = []
  for (let k = 0; k < 16; k++) {
    const t = (k * Math.PI) / 8
    out.push([Math.cos(t), Math.sin(t)])
  }
  return out
})()

function greedyShots(A, g, seed, cands, budgetMs) {
  const start = Date.now()
  let w = A.setup(g, seed, A.BOUNCE_DIMS)
  const shots = []
  const maxShots = g === 'bowl' ? 10 : A.GAMES[g].shots
  while (!A.over(w) && shots.length < maxShots) {
    let best = null
    for (const c of cands) {
      // 时限到了就停：至少要有一个候选，否则这一杆会空过
      if (best && budgetMs && Date.now() - start > budgetMs) break
      const cw = cloneArc(w)
      if (!A.shoot(cw, c)) continue
      stepAll(A, cw)
      if (!best || cw.score > best.score) best = { shot: c, score: cw.score }
    }
    if (!best) break
    if (!A.shoot(w, best.shot)) break
    stepAll(A, w)
    shots.push(best.shot)
  }
  // 万一贪心提前收手（没有合法候选），补默认 shot —— arcEnd 要求整局打完
  while (shots.length < maxShots && !A.over(w)) {
    const d = g === 'pool' ? [0, 0.5, 0] : [0, 0.5, 0]
    if (!A.shoot(w, d)) break
    stepAll(A, w)
    shots.push(d)
  }
  return shots
}

function rebuildBounce(A, seed, shots) {
  const w = A.setup('bounce', seed, A.BOUNCE_DIMS)
  for (const s of shots) {
    if (A.over(w)) break
    if (!A.shoot(w, s)) return null
    stepAll(A, w)
  }
  return w
}

function bounceCands(w) {
  const F = w.F, out = []
  const stepX = 90, stepY = 80
  for (let x = Math.ceil(F.hx) + 20; x <= w.W - F.hx - 20; x += stepX) {
    for (let y = Math.ceil(F.hy) + 20; y <= w.H - F.hy - 20; y += stepY) {
      for (const [dx, dy] of BOUNCE_DIRS) out.push([x, y, +(dx * 1700).toFixed(1), +(dy * 1700).toFixed(1)])
    }
  }
  return out
}

function bounceShots(A, seed, budgetMs) {
  const start = Date.now()
  const kept = []
  const n = A.GAMES.bounce.shots
  for (let k = 0; k < n; k++) {
    const base = rebuildBounce(A, seed, kept)
    if (!base || A.over(base)) break
    const cands = bounceCands(base)
    let best = null
    for (const c of cands) {
      if (best && budgetMs && Date.now() - start > budgetMs) break
      // 每个候选都从种子重建，随机数流才不会互相污染（见文件头说明）。
      // 第 1 甩也要重建：setup 之后 settle 可能调 addBox 消耗 w.R，
      // 同一个 base 被多个候选克隆会让后面的候选看到不同的随机数流。
      const w0 = rebuildBounce(A, seed, kept)
      if (!w0) break
      const cw = cloneArc(w0)
      if (!A.shoot(cw, c)) continue
      stepAll(A, cw)
      const gain = cw.score - w0.score
      if (!best || gain > best.gain) best = { shot: c, gain }
    }
    if (!best) break
    kept.push(best.shot)
  }
  // 补齐到恰好 n 甩：位置取场地中心，速度朝一个斜角
  let w = rebuildBounce(A, seed, kept)
  while (w && kept.length < n) {
    const d = [Math.round(w.W / 2), Math.round(w.H / 2), 1200, 900]
    if (!A.shoot(w, d)) break
    stepAll(A, w)
    kept.push(d)
  }
  return kept
}

/**
 * 把内部候选整理成「服务端日志里会记下的样子」。
 * shoot() 会把坐标/速度量化到 0.001、并把超过上限的速度按比例裁掉，
 * 而 arcEnd 是按 shots 原文重放的——所以提交前必须走一遍同样的规范化，
 * 不能直接交搜索时用的候选数组。
 */
export function canonicalShots(A, g, seed, shots) {
  const w = A.setup(g, seed, A.BOUNCE_DIMS)
  for (const s of shots) {
    if (A.over(w)) break
    if (!A.shoot(w, s)) break
    stepAll(A, w)
  }
  return w.log.map((s) => s.slice())
}

/**
 * 按游戏求一组 shots。返回的数组一定能被服务端 replay 完整重放。
 * budgetMs 只约束搜索时间，超时就返回当前最好的结果。
 */
export function solveGame(A, g, seed, opts = {}) {
  const budgetMs = opts.solveMs ?? 20000
  let shots = []
  if (g === 'pool') shots = greedyShots(A, g, seed, POOL_CANDS, budgetMs)
  else if (g === 'bowl') shots = greedyShots(A, g, seed, BOWL_CANDS, budgetMs)
  else if (g === 'bounce') shots = bounceShots(A, seed, budgetMs)
  return canonicalShots(A, g, seed, shots)
}

// 校验：本地 replay 一遍，和服务端口径一致
export function verifyShots(A, g, seed, shots) {
  try {
    const r = A.replay(g, seed, shots, A.BOUNCE_DIMS)
    return r ? Math.max(0, Math.round(r.score)) : null
  } catch { return null }
}

// ---------------- 日常调度 ----------------

function arcDay(R, now) {
  // 和 arcAct 里的 ctx.day 同口径：自然日（北京时间 0 点换日）
  return R.worldDay(now)
}

/** 某游戏今天还剩几次（读 state.arc.n，跨日自动归零） */
export function arcLeft(R, A, state, g, now) {
  const G = A?.GAMES?.[g]
  if (!G) return 0
  const a = state?.arc
  const used = a && a.d === arcDay(R, now) ? Number(a.n?.[g]) || 0 : 0
  return Math.max(0, G.daily - used)
}

function defaultShots(A, g, seed) {
  const w = A.setup(g, seed, A.BOUNCE_DIMS)
  if (g === 'bounce') {
    const x = Math.round(w.W / 2), y = Math.round(w.H / 2)
    return Array.from({ length: A.GAMES.bounce.shots }, () => [x, y, 1200, 900])
  }
  return Array.from({ length: g === 'bowl' ? 10 : A.GAMES[g].shots }, () => [0, 0.5, 0])
}

/**
 * 跑一批游乐馆。每次巡视最多玩 cfg.arcade.perTick 局，避免把主流程拖太久。
 * 调用方应保证这时不在偷菜掐点窗口里。
 */
export async function arcadeRound(world, cfg, log = () => {}, memo = {}) {
  const A = arcadeRules()
  if (!A?.GAMES) return { played: 0, results: [] }
  const R = world.R
  // 有人在浏览器里手操：整轮跳过。我们的任何 arcStart 都会抢占他的 cur
  // （服务端同一时刻只允许一局），更别说别的写入会让他 arcEnd 409。
  const ma = world.manualArcade?.(world.now, cfg.arcade?.manualTtlSec)
  if (ma?.active && !world.ourArcadeHeld?.()) {
    if (world.arcadeManualNote !== ma.startedAtSec) {
      world.arcadeManualNote = ma.startedAtSec
      log(`游乐馆：检测到手操中的 ${ma.game}（剩 ${ma.remainingSec} 秒），本轮让位`)
    }
    return { played: 0, results: [], standby: ma }
  }
  world.arcadeManualNote = 0
  const order = (cfg.arcade?.games || ['pool', 'bowl', 'bounce']).filter((g) => A.GAMES[g])
  const perTick = Math.max(1, cfg.arcade?.perTick ?? 2)
  const solveMs = cfg.arcade?.solveMs ?? 20000
  const results = []

  for (const g of order) {
    let left = arcLeft(R, A, world.state, g, world.now)
    for (let k = 0; k < left && results.length < perTick; k++) {
      // 计时起点必须是 **arcStart 回执到达本地之后**，不能是发请求之前。
      // 服务端 arcAct 记的是自己的处理时刻 c.t，而我们的 POST 有 2.15 秒串行节流
      // （core/http.mjs minGap），arcStart 可能先在本地排队 2 秒才发出去。
      // 以前 startedAt 取在发请求之前，于是本地「等了 5.8 秒」到服务端只剩 4.5 秒：
      // 弹弹乐 MIN_PLAY=5 全军覆没（2026-11-13 17:43 十连「太快了」），
      // 保龄 MIN_PLAY=8 也随机失败一半。
      let startedAt = 0
      let seed = 0, startOk = false
      try {
        const r1 = await world.act([{ a: 'arcStart', g }], { silent: true })
        const o = (r1.out || [])[0]
        if (!o?.ok) { log(`游乐馆 · ${A.GAMES[g].name}：开局失败 ${o?.msg || '（无回执）'}`); break }
        seed = o.seed
        startedAt = Date.now()
        startOk = true
        // 这局归我们：arcStart → arcEnd 之间 cur 是我们自己的，
        // world.act 的手操让位门控要放行（否则托管会被自己刚开的局挡住）。
        world.ourArcade = { g, seed }
      } catch (e) {
        log(`游乐馆 · ${A.GAMES[g].name}：开局出错 ${e.message}`)
        break
      }
      if (world.manualArcade?.(world.now)?.active && !world.ourArcadeHeld?.()) {
        // 开局回执成功但 state 里的 cur 不是我们的 seed（极小概率的并发手操），
        // 说明有人抢先开了局；此时我们的 arcEnd 会覆盖掉他的局，直接放弃这一局。
        world.ourArcade = null
        log(`游乐馆 · ${A.GAMES[g].name}：cur 已被另一局占用，放弃本轮（不覆盖手操）`, 'warn')
        break
      }

      let shots = []
      let local = null
      try {
        shots = solveGame(A, g, seed, { solveMs })
        local = verifyShots(A, g, seed, shots)
      } catch (e) {
        log(`游乐馆 · ${A.GAMES[g].name}：求解出错 ${e.message}`)
      }
      if (!startOk || !shots?.length || local == null) {
        // 求解失败也要提交一局能重放的默认 shots，别把次数留在半截
        shots = defaultShots(A, g, seed)
        local = verifyShots(A, g, seed, shots)
      }

      // MIN_PLAY：规则原文判定的是 ctx.t − c.t（两次服务端处理时刻之差）。
      // c.t 一定早于本地 startedAt，所以从回执之后等 MIN_PLAY + 1.2 秒，
      // 到服务端那里只会更长，不会被判「太快」。
      const needMs = (MIN_PLAY[g] + 1.2) * 1000
      let counted = null
      let lastFail = ''
      // 「太快了」时服务端并不清 x.cur（arcade-05a5c445.mjs 第 144 行），
      // 说明这一局还能救：等够时间重新 arcEnd 即可，不用白烧次数。
      for (let attempt = 0; attempt < 3; attempt++) {
        const waitMs = needMs - (Date.now() - startedAt)
        if (waitMs > 0) await sleep(waitMs)
        try {
          const r2 = await world.act([{ a: 'arcEnd', g, shots }], { silent: true })
          const o = (r2.out || [])[0]
          if (o?.ok) { counted = o; break }
          lastFail = o?.msg || '（无回执）'
          if (/太快了/.test(lastFail)) {
            if (attempt < 2) log(`游乐馆 · ${A.GAMES[g].name}：服务端判定太快，再等一轮重试`)
            continue
          }
          break
        } catch (e) {
          lastFail = e.message
          break
        }
      }
      // arcEnd 已提交（无论成败），cur 不再属于我们
      world.ourArcade = null
      if (counted) {
        results.push({ g, score: counted.score, best: counted.best, dayBest: counted.dayBest, newBest: !!counted.newBest, left: counted.left })
        log(`游乐馆 · ${A.GAMES[g].name}：${counted.score} 分${counted.newBest ? '（刷新个人纪录）' : ''}｜今日剩 ${counted.left} 次`)
      } else {
        log(`游乐馆 · ${A.GAMES[g].name}：未计分 ${lastFail}`, 'warn')
        // 连着失败多半是规则/时钟对不上，别把剩余次数一轮全烧光
        break
      }
      void local
      void left
    }
  }
  if (results.length) memo.arcadeLastDay = arcDay(R, world.now)
  return { played: results.length, results }
}

/** 给 GUI / 日志看的概况 */
export function arcadeSummary(world) {
  const A = arcadeRules()
  if (!A?.GAMES) return null
  const R = world.R
  const a = world.state?.arc
  const out = {}
  for (const g of Object.keys(A.GAMES)) {
    out[g] = {
      name: A.GAMES[g].name,
      left: arcLeft(R, A, world.state, g, world.now),
      daily: A.GAMES[g].daily,
      best: a?.best?.[g] || 0,
      today: a && a.d === arcDay(R, world.now) ? a.db?.[g] || 0 : 0,
    }
  }
  return out
}
