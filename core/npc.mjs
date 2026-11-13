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
  if (maxGames <= 0) {
    // 打满了就直接返回，但要留一行说明——否则日志里完全没有五子棋的痕迹，
    // 分不清是「额度用完了」还是「功能挂了/配置关了」。
    // 只在状态变化时打一次，避免每轮刷屏。
    const why = paidLeft <= 0
      ? `今日计奖局数已满（${paid}/${R.GOMOKU_PAID}），等明天重置`
      : `今日 52弟 次数已满（${used}/${R.NPC.daily}）`
    if (world.gomokuIdleReason !== why) {
      world.gomokuIdleReason = why
      log(`五子棋：${why}`)
    }
    return { games: 0, wins: 0, coins: 0, items: {} }
  }
  world.gomokuIdleReason = ''

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
    if (!end?.ok) {
      log('五子棋结算失败：' + (end?.msg || '未知'))
      break
    }
    // 平局不消耗计奖次数（站点规则）。旧版按服务端的 cnt.npc 判断，天然正确；
    // 新版用本地 games 计数，以前把平局也 ++，等于平几局就少打几局。
    if (end.res === 'draw') {
      fails++
      log('五子棋平局，本局不计次数')
      continue
    }
    games++
    if (end.res === 'win') {
      wins++
      coins += end.earn || 0
      for (const g of end.got || []) {
        const name = R.ITEM_NAME[g.id] || g.id
        items[name] = (items[name] || 0) + g.n
      }
      if (end.jackpot) log('🎉 五子棋头奖！+' + Math.round(end.earn).toLocaleString('en-US'))
    }
  }

  if (games) {
    const itemStr = Object.entries(items).map(([k, n]) => `${k}×${n}`).join('  ')
    const avg = wins > 0 ? Math.round(coins / wins) : 0
    log(`五子棋 ${wins}/${games} 胜（难度 ${level}，胜率 ${Math.round(wins / games * 100)}%）` +
      `｜奖励 +${Math.round(coins).toLocaleString('en-US')} D（每胜均 ${avg.toLocaleString('en-US')} D）` +
      (itemStr ? `｜掉落 ${itemStr}` : ''))
  } else if (fails > 0) {
    log(`五子棋：${fails} 次没搜到必胜棋谱，本轮未提交（不交输棋）`)
  }
  return { games, wins, coins, items, fails }
}

/**
 * 其他小游戏（剪刀石头布 / 抽牌 / 盲盒）。
 *
 * 旧注释写「期望中性，默认不打」——这是错的。规则原文 `pay()`（R:795）只在
 * `res==='win'` 时发奖，**输和平都不扣任何东西**（平局连次数都不消耗），
 * 所以每次「计次」的期望 = 胜率 × 单胜奖励，是纯粹的白拿：
 *   - 抽牌胜率 46.8%，每次计次约 2,730 D
 *   - 石头剪刀布胜率 33.2%，每次计次约 2,705 D
 * （2026-11-13 用线上规则 400×200 局实测。）
 *
 * 五子棋前 10 局有 1.5 倍率且近全胜，所以先打五子棋；剩下约 42 次额度
 * 全部拿来抽牌，一天多 10 万 D 上下，零体力零成本。
 */
export async function playOther(world, cfg, log = () => {}) {
  const R = world.R
  // 抽牌平局率最低（1/13），同样的额度需要最少的请求次数，所以优先。
  const order = ['card', 'rps', 'box'].filter((g) => cfg.npc?.[g])
  if (!order.length) return { games: 0, wins: 0, coins: 0, items: {} }

  const dayOf = () => R.worldDay(world.now)
  const leftOf = () => {
    const s = world.state
    const used = (s.enDay === dayOf() ? (s.cnt?.npc || 0) : 0)
    return Math.max(0, R.NPC.daily - used)
  }

  let attempts = 0, wins = 0, coins = 0
  const items = {}
  const tally = (o) => {
    if (!o) return
    attempts++
    if (o.res !== 'win') return
    wins++
    coins += o.earn || 0
    for (const g of o.got || []) {
      const name = R.ITEM_NAME[g.id] || g.id
      items[name] = (items[name] || 0) + g.n
    }
  }

  const g = order[0]
  if (g === 'box') {
    // 盲盒必须 start → 3 次 pick，且 pick 不能选系统已移除的盒子，
    // 只能一步一步读回包（3 个请求一局，所以默认不开）。
    for (let guard = 0; guard < 60 && leftOf() > 0; guard++) {
      let o = (await world.act([{ a: 'npc', g: 'box', k: 'start' }], { silent: true }))?.out?.[0]
      if (!o?.ok) break
      let ok = true
      for (let pick = 0; pick < 3; pick++) {
        const pk = o.box?.pk || [], left = o.box?.left || []
        const i = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((x) => !pk.includes(x) && left.length > 0)
        if (i == null) { ok = false; break }
        o = (await world.act([{ a: 'npc', g: 'box', i }], { silent: true }))?.out?.[0]
        if (!o?.ok) { ok = false; break }
      }
      if (!ok) break
      tally(o)
    }
  } else {
    // 抽牌 / 石头剪刀布：每次互相独立，可以整批提交（服务端按顺序各自取随机数）。
    for (let guard = 0; guard < 20; guard++) {
      const before = leftOf()
      if (before <= 0) break
      const acts = []
      for (let i = 0; i < Math.min(before, R.WORLD.maxActions); i++) {
        acts.push(g === 'rps'
          ? { a: 'npc', g, m: Math.floor(Math.random() * 3) }
          : { a: 'npc', g })
      }
      const outs = (await world.act(acts, { silent: true }))?.out || []
      for (const o of outs) tally(o)
      if (!outs.length || leftOf() >= before) break
    }
  }

  if (attempts) {
    const itemStr = Object.entries(items).map(([k, n]) => `${k}×${n}`).join('  ')
    const name = g === 'card' ? '抽牌' : g === 'rps' ? '石头剪刀布' : '盲盒'
    log(`52弟${name} ${wins}/${attempts} 胜｜奖励 +${Math.round(coins).toLocaleString('en-US')} D` +
      (itemStr ? `｜掉落 ${itemStr}` : ''))
  }
  return { games: attempts, wins, coins, items }
}
