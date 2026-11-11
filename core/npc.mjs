// 52弟小游戏：五子棋求解 + 其他小游戏。
//
// 五子棋：服务端 AI 完全确定（gomokuAI + gomokuReplay 按棋谱复盘），
// 所以本地用同一份规则搜出必胜棋谱再提交是可行的。
// 但 15 路普通/困难档的实际强度很高，求解成功率有限——
// 因此本模块的设计是「尽力求解 + 失败就换局」，绝不提交未经复盘验证的棋谱。
import { randomUUID } from 'node:crypto'
import { solveGomoku, verifyGomoku } from './gomoku.mjs'

/** 打五子棋。返回 { games, wins, coins, items } */
export async function playGomoku(world, cfg, log = () => {}) {
  const R = world.R
  const s = world.state
  const day = R.worldDay(world.now)
  const used = (s.enDay === day ? (s.cnt?.npc || 0) : 0)
  const paid = (s.cnt?.gomokuPaid || 0)
  const paidLeft = Math.max(0, R.GOMOKU_PAID - paid)
  const dailyLeft = Math.max(0, R.NPC.daily - used)
  const level = cfg.npc?.gomokuLevel || 3
  const maxGames = Math.min(cfg.npc?.gomokuMaxGames ?? 10, paidLeft, dailyLeft)
  if (maxGames <= 0) return { games: 0, wins: 0, coins: 0, items: {} }

  let games = 0, wins = 0, coins = 0
  const items = {}
  let fails = 0

  while (games < maxGames && fails < 3) {
    // 开局
    let st
    try {
      const j = await world.act([{ a: 'npc', g: 'gomoku', k: 'start', d: level }], { silent: true })
      st = j.out?.[0]
    } catch (e) { log('五子棋开局失败：' + e.message); break }
    if (!st?.ok || !st.seed) { log('五子棋开局未返回种子'); break }

    const seed = st.seed
    const practice = !!st.practice
    const N = R.GOMOKU_N
    const t0 = Date.now()
    const mv = solveGomoku(R, seed, {
      N, d: level,
      budgetMs: cfg.npc?.gomokuBudgetMs ?? 6000,
      lines: cfg.npc?.gomokuLines ?? 60,
      jitter: cfg.npc?.gomokuJitter ?? 0.5,
    })
    if (!mv || !verifyGomoku(R, seed, mv, { N, d: level })) {
      fails++
      log(`五子棋第 ${games + 1} 局没搜到必胜棋谱（${Date.now() - t0}ms），跳过`)
      // 没有棋谱就不提交 end（提交空棋谱会被判 lose 并消耗次数）
      // 服务端要求必须 end 才能结束这局；这里提交一手合法落子让它输掉，
      // 但那会浪费次数——所以改为直接 start 新的一局（会覆盖 npcG）
      continue
    }

    let end
    try {
      const j = await world.act([{ a: 'npc', g: 'gomoku', k: 'end', mv }], { silent: true })
      end = j.out?.[0]
    } catch (e) { log('五子棋结算失败：' + e.message); break }
    games++
    if (end?.ok && end.res === 'win') {
      wins++
      coins += end.earn || 0
      for (const g of end.got || []) {
        const name = R.ITEM_NAME[g.id] || g.id
        items[name] = (items[name] || 0) + g.n
      }
      if (end.jackpot) log('🎉 五子棋头奖！+' + Math.round(end.earn).toLocaleString('en-US'))
    } else if (!end?.ok) {
      log('五子棋结算失败：' + (end?.msg || '未知'))
      break
    }
  }

  if (games) {
    const itemStr = Object.entries(items).map(([k, n]) => `${k}×${n}`).join(' ')
    log(`五子棋 ${wins}/${games} 胜，+${Math.round(coins).toLocaleString('en-US')} D${itemStr ? '，' + itemStr : ''}`)
  }
  return { games, wins, coins, items }
}

/** 其他小游戏（期望中性，默认不打） */
export async function playOther(world, cfg, log = () => {}) {
  const R = world.R
  const games = []
  if (cfg.npc?.rps) games.push('rps')
  if (cfg.npc?.card) games.push('card')
  if (cfg.npc?.box) games.push('box')
  if (!games.length) return { games: 0 }

  const day = R.worldDay(world.now)
  const s = world.state
  const used = (s.enDay === day ? (s.cnt?.npc || 0) : 0)
  const left = Math.max(0, R.NPC.daily - used)
  let n = 0
  for (let k = 0; k < left; k++) {
    const g = games[k % games.length]
    const action = g === 'box' ? { a: 'npc', g, k: 'start' } : { a: 'npc', g }
    if (g === 'rps') action.m = Math.floor(Math.random() * 3)
    try {
      const j = await world.act([action], { silent: true })
      const o = j.out?.[0]
      if (!o?.ok) break
      n++
    } catch { break }
  }
  if (n) log(`其他小游戏 ${n} 局`)
  return { games: n }
}
