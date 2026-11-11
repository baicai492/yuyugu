// 52弟 玩具摊的五子棋求解器。
// 服务端 AI 是确定性的（gomokuAI(board, seed, step)，seed 在开局时下发），结算时只按棋谱复盘，
// 所以可以在本地用同一份规则代码模拟 AI 的每一步应手，搜出一条必胜棋谱后再提交。
const N = 11
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]]

// 和服务端 AI 同款的棋形评分，用来给己方候选点排序
function strength(b, x, y, who) {
  let total = 0, threats = 0
  for (const [dx, dy] of DIRS) {
    let n = 1, open = 0
    for (const sg of [-1, 1]) {
      let k = 1
      while (true) {
        const X = x + dx * k * sg, Y = y + dy * k * sg
        if (X < 0 || Y < 0 || X >= N || Y >= N) break
        const v = b[Y * N + X]
        if (v !== who) { if (!v) open++; break }
        n++; k++
      }
    }
    total += n >= 4 ? (open === 2 ? 50000 : open ? 10000 : 0) : n === 3 ? (open === 2 ? 3500 : open ? 250 : 0) : n === 2 ? (open === 2 ? 180 : open ? 30 : 0) : open * 3
    if (n >= 3 && open === 2) threats++
    for (let start = -4; start <= 0; start++) {
      let count = 0, valid = true
      for (let k = start; k < start + 5; k++) {
        const X = x + dx * k, Y = y + dy * k
        if (X < 0 || Y < 0 || X >= N || Y >= N) { valid = false; break }
        const v = k === 0 ? who : b[Y * N + X]
        if (v && v !== who) { valid = false; break }
        if (v === who) count++
      }
      if (valid) total += count === 4 ? 2500 : count === 3 ? 100 : count === 2 ? 8 : 0
    }
  }
  return total + (threats >= 2 ? 12000 : 0)
}

function candidates(b) {
  const out = []
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (b[y * N + x]) continue
    let near = false
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
      const X = x + dx, Y = y + dy
      if (X >= 0 && Y >= 0 && X < N && Y < N && b[Y * N + X]) { near = true; break }
    }
    if (near) out.push([x, y])
  }
  return out
}

// 返回必胜棋谱（玩家落子序列）或 null。R 是站点的规则模块（提供 gomokuAI / gomokuLine / gomokuReplay）。
export function solveGomoku(R, seed, { budget = 40000 } = {}) {
  for (const [width, depth] of [[2, 16], [3, 12], [4, 10], [6, 8]]) {
    const b = new Array(N * N).fill(0), mv = []
    let nodes = 0
    const dfs = (k) => {
      if (k >= depth || nodes > budget) return false
      let cands = k === 0 ? [[5, 5], [4, 4], [5, 4]] : candidates(b)
      const win = cands.find(([x, y]) => R.gomokuLine(b, x, y, 1) >= 5)
      if (win) { mv.push(win); return true }
      cands = cands.map((p) => ({ p, v: strength(b, p[0], p[1], 1) + strength(b, p[0], p[1], 2) * 0.6 })).sort((a, c) => c.v - a.v).slice(0, width).map((x) => x.p)
      for (const [x, y] of cands) {
        nodes++
        b[y * N + x] = 1
        const [ax, ay] = R.gomokuAI(b, seed, k)
        if (b[ay * N + ax]) { b[y * N + x] = 0; continue }
        b[ay * N + ax] = 2
        if (R.gomokuLine(b, ax, ay, 2) < 5) {
          mv.push([x, y])
          if (dfs(k + 1)) return true
          mv.pop()
        }
        b[ay * N + ax] = 0; b[y * N + x] = 0
      }
      return false
    }
    if (dfs(0) && R.gomokuReplay(seed, mv) === 'win') return mv
  }
  return null
}
