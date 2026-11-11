import * as R from '../cache/rules-4be1c2b4.mjs'
import { solveGomoku } from '../extension/lib/gomoku.mjs'
let win = 0, total = 200, ms = 0, worst = 0, lens = 0
for (let i = 0; i < total; i++) {
  const seed = 1 + Math.floor(Math.random() * 1e9), t0 = performance.now()
  const mv = solveGomoku(R, seed)
  const dt = performance.now() - t0; ms += dt; worst = Math.max(worst, dt)
  if (mv) { win++; lens += mv.length }
}
console.log(`win ${win}/${total}, avg ${(ms / total).toFixed(1)} ms, worst ${worst.toFixed(0)} ms, avg moves ${(lens / Math.max(1, win)).toFixed(1)}`)
