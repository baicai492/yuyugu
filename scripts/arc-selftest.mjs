// 游乐馆求解器自检：用固定种子跑三种游戏，打印分数与耗时。
// 用法：node scripts/arc-selftest.mjs [seed]
import * as A from '../cache/arcade-05a5c445.mjs'
import { solveGame, verifyShots } from '../core/arcade.mjs'

const seed = Number(process.argv[2] || 123456789) >>> 0
for (const g of ['pool', 'bowl', 'bounce']) {
  const t0 = Date.now()
  const shots = solveGame(A, g, seed, { solveMs: 20000 })
  const dt = Date.now() - t0
  const local = verifyShots(A, g, seed, shots)
  console.log(`${g}: shots=${shots.length} local=${local} elapsed=${dt}ms`)
  if (local == null) console.log('  !! 本地 replay 失败', JSON.stringify(shots))
}
