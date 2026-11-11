// 52弟五子棋：多路线试下的求解器（15 路 × 三档难度）。
//
// 核心事实：服务端 AI 完全确定 —— gomokuAI(board, seed, step, d, N)。
// 给定我的整条落子序列，整局棋就唯一确定了。
//
// 所以策略是「离线把整局棋走完，赢的才提交」：
//   1. 用启发式策略（赢/挡/双四/评分）走完一整局
//   2. 用随机扰动跑多条不同路线
//   3. 任意一条被判胜 → 提交；否则不提交（不浪费计奖局数，直接重开）
//
// 这样我们从不提交会输的棋谱，胜率等于「离线试出胜局的比例」。

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]]
const xy = (i, N) => [i % N, Math.floor(i / N)]

export function makesFive(b, N, i, who) {
  const x = i % N, y = (i - x) / N
  for (const [dx, dy] of DIRS) {
    let n = 1
    for (const sg of [1, -1]) {
      let k = 1
      while (true) {
        const X = x + dx * k * sg, Y = y + dy * k * sg
        if (X < 0 || Y < 0 || X >= N || Y >= N || b[Y * N + X] !== who) break
        n++; k++
      }
    }
    if (n >= 5) return true
  }
  return false
}

function nearEmpty(b, N, radius = 2) {
  const mark = new Uint8Array(N * N)
  let any = false
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!b[y * N + x]) continue
    any = true
    for (let Y = Math.max(0, y - radius); Y <= Math.min(N - 1, y + radius); Y++)
      for (let X = Math.max(0, x - radius); X <= Math.min(N - 1, x + radius); X++) mark[Y * N + X] = 1
  }
  if (!any) return [((N >> 1) * N) + (N >> 1)]
  const out = []
  for (let i = 0; i < N * N; i++) if (mark[i] && !b[i]) out.push(i)
  return out
}

/** 前提 b[i]===who：返回「再落一子就成五」的空点 */
export function fiveTargetsAfter(b, N, i, who) {
  const x = i % N, y = (i - x) / N
  const out = [], seen = new Set()
  for (const [dx, dy] of DIRS) {
    for (let s = -4; s <= 0; s++) {
      let mine = 0, empty = -1, bad = false
      for (let k = s; k < s + 5; k++) {
        const X = x + dx * k, Y = y + dy * k
        if (X < 0 || Y < 0 || X >= N || Y >= N) { bad = true; break }
        const j = Y * N + X, v = b[j]
        if (v === who) mine++
        else if (!v) { if (empty >= 0) { bad = true; break } empty = j }
        else { bad = true; break }
      }
      if (!bad && mine === 4 && empty >= 0 && !seen.has(empty)) { seen.add(empty); out.push(empty) }
    }
  }
  return out
}

/** 落子 i（已置为 who）后的棋形分 */
function shapeScore(b, N, i, who) {
  const x = i % N, y = (i - x) / N
  let score = 0
  for (const [dx, dy] of DIRS) {
    let n = 1, open = 0
    for (const sg of [1, -1]) {
      let k = 1
      while (true) {
        const X = x + dx * k * sg, Y = y + dy * k * sg
        if (X < 0 || Y < 0 || X >= N || Y >= N) break
        const v = b[Y * N + X]
        if (v !== who) { if (!v) open++; break }
        n++; k++
      }
    }
    score += n >= 5 ? 1e9
      : n === 4 ? (open === 2 ? 1e6 : open ? 1e5 : 0)
      : n === 3 ? (open === 2 ? 1e4 : open ? 1e3 : 0)
      : n === 2 ? (open === 2 ? 300 : open ? 50 : 0) : open * 5
  }
  return score
}

const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296 } }

/**
 * 走完整的一局（确定性地），返回 { mv, result }。
 * result: 'win' | 'lose' | 'draw' | 'long'
 * jitter：在评分接近的候选里随机挑，用于跑不同路线。
 */
export function playLine(R, seed, { N = 15, d = 2, jitter = 0, rand = rng(1), maxPlies = 120 } = {}) {
  const b = new Array(N * N).fill(0)
  const mv = []
  const C = N >> 1

  // 我方选点
  const pickMove = (ply) => {
    if (ply === 0 && b.every((v) => !v)) return C * N + C
    const pool = nearEmpty(b, N)

    // 1) 直接赢
    for (const i of pool) {
      if (b[i]) continue
      b[i] = 1
      const w = makesFive(b, N, i, 1)
      b[i] = 0
      if (w) return i
    }
    // 2) 挡对手五连
    const foeFives = []
    for (const i of pool) {
      if (b[i]) continue
      b[i] = 2
      const w = makesFive(b, N, i, 2)
      b[i] = 0
      if (w) foeFives.push(i)
    }
    if (foeFives.length >= 2) return foeFives[0]   // 反正挡不住，随便挡
    if (foeFives.length === 1) return foeFives[0]

    // 3) 评分
    const scored = []
    for (const i of pool) {
      if (b[i]) continue
      b[i] = 1
      const atk = shapeScore(b, N, i, 1)
      const tg = fiveTargetsAfter(b, N, i, 1).length
      b[i] = 0
      b[i] = 2
      const def = shapeScore(b, N, i, 2)
      b[i] = 0
      let v = atk + def * 1.35
      if (tg >= 2) v = 1e12
      else if (tg === 1) v += 3e7
      // 轻微随机：在最优的几个里挑，制造不同路线
      if (jitter > 0) v *= 1 + (rand() - 0.5) * jitter
      scored.push({ i, v })
    }
    scored.sort((p, q) => q.v - p.v)
    return scored[0].i
  }

  for (let ply = 0; ply < maxPlies; ply++) {
    const i = pickMove(ply)
    if (i == null || b[i]) return { mv, result: 'lose' }
    b[i] = 1
    mv.push(xy(i, N))
    if (makesFive(b, N, i, 1)) return { mv, result: 'win' }
    if (b.every(Boolean)) return { mv, result: 'draw' }

    const [ax, ay] = R.gomokuAI(b, seed, ply, d, N)
    if (!(ax >= 0 && ay >= 0 && ax < N && ay < N)) return { mv, result: 'lose' }
    const ai = ay * N + ax
    if (b[ai]) return { mv, result: 'lose' }
    b[ai] = 2
    if (makesFive(b, N, ai, 2)) return { mv, result: 'lose' }
    if (b.every(Boolean)) return { mv, result: 'draw' }
  }
  return { mv, result: 'long' }
}

/**
 * 求解：跑若干条不同路线，任意一条赢就返回其棋谱。
 * opts: { N, d, budgetMs, lines, jitter }
 */
export function solveGomoku(R, seed, opts = {}) {
  const N = opts.N ?? (R.GOMOKU_N || 15)
  const d = opts.d ?? 2
  const budgetMs = opts.budgetMs ?? 6000
  const lines = opts.lines ?? 24
  const deadline = Date.now() + budgetMs
  const baseJitter = opts.jitter ?? 0.35

  let best = null
  for (let k = 0; k < lines; k++) {
    if (Date.now() > deadline) break
    // 第一条不抖动（走纯启发式的最优线），之后逐步加大随机
    const jitter = k === 0 ? 0 : baseJitter * (1 + (k % 3) * 0.5)
    const rand = rng(seed * 31 + k * 7919)
    const r = playLine(R, seed, { N, d, jitter, rand })
    if (r.result === 'win' && verifyGomoku(R, seed, r.mv, { N, d })) {
      if (!best || r.mv.length < best.length) best = r.mv
      break
    }
  }
  return best
}

export function verifyGomoku(R, seed, mv, { N, d } = {}) {
  const n = N ?? (R.GOMOKU_N || 15)
  try { return R.gomokuReplay(seed, mv, d ?? 2, n) === 'win' } catch { return false }
}
