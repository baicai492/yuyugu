// nextWake 的「没事可做就长睡」单测。
//
// 背景：线上实测凌晨 01:13 就把当天所有额度刷完了（钓 80 / 挖 100 / 炸 10 /
// 加工 80 全满），之后到 08:00 换岛日之前无事可做，却每 5 秒~2 分钟醒一次，
// 每次发好几个请求，纯空转一整夜。
//
// 三条要守住的行为：
//   1. 额度全用完 + 帮忙/五子棋/擂台都做完 → 长睡到 idleSleepCap（不是 120）
//   2. 还有任何一件事没做完 → 按各自的短间隔唤醒
//   3. 不能睡过换岛日边界
import { loadRulesCached } from '../core/rules.mjs'
import { nextWake } from '../core/planner.mjs'
import { loadConfig } from '../core/config.mjs'

const R = await loadRulesCached()
const cfg = loadConfig()
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? '  ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${label}${extra ? '  ' + extra : ''}`) }
}

const now = Math.floor(Date.now() / 1000)
const day = R.worldDay(now)
const prices = {}
for (const c of R.CROPS) prices[c.id] = c.price
for (const f of R.FISH) prices[f.id] = f.price
for (const o of R.ORES) prices[o.id] = o.price

/** 造一个「额度可指定」的世界。默认全部额度已用完（线上那种凌晨状态） */
function mkWorld({ iq = {}, en = 90, plots = [], cnt = {} } = {}) {
  const plotN = Math.max(6, plots.length)
  const state = {
    en, enT: now, enDay: day,
    plotN,
    plots: [...plots, ...Array(plotN - plots.length).fill(null)],
    barn: [], barnN: 0, traps: [],
    tools: { rod: 4, pick: 4, spr: 3, house: 5 },
    cnt: { gomokuPaid: 10, npc: 10, ...cnt },
    inv: {},
    // 默认：所有生产额度都用完了
    iq: { d: R.isleIndex(now), fish: 80, mine: 100, bomb: 10, craft: 80, ...iq },
    mine: { max: 10 },
    earn: { day, amt: 0 },
    b12: { v: 1, vault: {}, keep: {}, effects: {} },
  }
  const w = { R, now, state, coins: 50_000_000, prices, externalSoldRatio: {}, dry: false }
  Object.defineProperty(w, 'isleDay', { get() { return R.isleDay(this.now) } })
  return w
}

// 让「帮忙」和「擂台」都做完
const allDone = { stealScanAt: now, helpDay: day, helpCount: 99, arenaDay: day, arenaToday: 99 }

// 只留生产类额度驱动，排除帮忙/五子棋/擂台/偷菜的干扰
const workOnly = structuredClone(cfg)
workOnly.social.help.enabled = false
workOnly.npc.gomoku = false
workOnly.arena.enabled = false
workOnly.social.steal.enabled = false

const cap = cfg.wake?.idleSleepCap ?? 1800

console.log(`\n[1] 全部做完 → 长睡（cap=${cap}）`)
{
  // 地全种满、没有熟的、没有空的
  const growing = R.CROPS.find((c) => c.seasons.includes(R.seasonOf(R.isleDay(now))))
  const plots = Array(6).fill(null).map(() => ({ c: growing.id, t: now, w: 3, g: 0, y: 0, sv: [] }))
  const w = mkWorld({ plots })
  const nap = nextWake(w, workOnly, allDone)
  ok(nap === cap, `额度全空 + 地都在长 → ${cap} 秒`, `got=${nap}`)
  ok(nap > (workOnly.loop?.maxSleep ?? 120), '不会退回到 maxSleep 的短间隔', `maxSleep=${workOnly.loop?.maxSleep}`)
}

console.log('\n[2] 换岛日边界比 cap 更近 → 睡到边界')
{
  const growing = R.CROPS.find((c) => c.seasons.includes(R.seasonOf(R.isleDay(now))))
  const plots = Array(6).fill(null).map(() => ({ c: growing.id, t: now, w: 3, g: 0, y: 0, sv: [] }))
  const w = mkWorld({ plots })
  const dayLeft = R.b12NextIsleBoundary(now) - now
  const nap = nextWake(w, workOnly, allDone)
  ok(nap <= Math.max(cap, dayLeft), '不超过 cap 也不超过边界', `nap=${nap} dayLeft=${Math.round(dayLeft)}`)
}

console.log('\n[3] 还有生产额度 → 短间隔')
{
  const growing = R.CROPS.find((c) => c.seasons.includes(R.seasonOf(R.isleDay(now))))
  const plots = Array(6).fill(null).map(() => ({ c: growing.id, t: now, w: 3, g: 0, y: 0, sv: [] }))
  for (const [k, label] of [['fish', '钓鱼'], ['mine', '挖矿'], ['bomb', '炸矿']]) {
    // 把这一类额度留出来（用 0 次）
    const w = mkWorld({ plots, iq: { [k]: 0 } })
    const nap = nextWake(w, workOnly, allDone)
    ok(nap < cap, `${label}还有额度 → 短间隔`, `got=${nap}`)
  }
}

console.log('\n[4] 有空地可种 → 不算「没事可做」')
{
  const w = mkWorld({ plots: [] })   // 6 块空地
  const nap = nextWake(w, workOnly, allDone)
  ok(nap < cap, '有空位就还要回来种', `got=${nap}`)
}

console.log('\n[5] 有熟了没收的地 → 不算「没事可做」')
{
  // 必须是当季作物，否则 cropStage 返回 -1（枯萎），不是「成熟」
  const season = R.seasonOf(R.isleDay(now))
  const growing = R.CROPS.find((c) => c.seasons.includes(season) && !c.regrow)
  // 种下足够久，且浇水打满 g，保证 stage=3
  const plots = Array(6).fill(null).map(() => ({
    c: growing.id, t: now - Math.ceil(growing.grow * 60 * 0.8) - 60, w: 3, g: 99999, y: 0, sv: [],
  }))
  const w = mkWorld({ plots })
  const st = R.cropStage(plots[0], now, true)
  ok(st.stage === 3, '构造出的地块确实成熟了', `stage=${st.stage}`)
  const nap = nextWake(w, workOnly, allDone)
  ok(nap < cap, '有熟的就要赶紧收（防偷）', `got=${nap}`)
}

console.log('\n[6] 帮忙还没做完 → 不算「没事可做」')
{
  const growing = R.CROPS.find((c) => c.seasons.includes(R.seasonOf(R.isleDay(now))))
  const plots = Array(6).fill(null).map(() => ({ c: growing.id, t: now, w: 3, g: 0, y: 0, sv: [] }))
  const w = mkWorld({ plots })
  // 用完整 cfg（帮忙开着），但帮忙只做了 3/10，且体力够
  const nap = nextWake(w, cfg, { ...allDone, helpCount: 3 })
  ok(nap < cap, '帮忙还有额度 → 短间隔', `got=${nap}`)
}

console.log('\n[7] 体力 0 但有口粮 + 有熟地 → 必须立刻醒（不能卡住）')
{
  // 这条覆盖一个真实 bug：nextWake 里写成了 foodChoices(R, s, prices)，
  // 而 nextWake 作用域里没有 prices（只有 world.prices），抛 ReferenceError
  // 被 catch 吞掉 → canEat 永远 false → 体力 0 时「有熟地」不当回事，
  // 而 watchOnce 又按另一套逻辑报「地熟了」，两边打架，日志每几秒刷一条。
  const season = R.seasonOf(R.isleDay(now))
  const growing = R.CROPS.find((c) => c.seasons.includes(season) && !c.regrow)
  const plots = Array(6).fill(null).map(() => ({
    c: growing.id, t: now - Math.ceil(growing.grow * 60 * 0.8) - 60, w: 3, g: 99999, y: 0, sv: [],
  }))
  // 体力 0，但库存有大量可吃的当季作物
  const w = mkWorld({ plots, en: 0 })
  w.state.inv[growing.id] = [999, 0, 0]
  const nap = nextWake(w, workOnly, allDone)
  ok(nap <= 5, '体力 0 + 有口粮 + 有熟地 → 立刻醒', `got=${nap}`)

  // 同样的场景但完全没有口粮 → 收不了，不该立刻醒（等体力回复）
  const w2 = mkWorld({ plots, en: 0 })
  const nap2 = nextWake(w2, workOnly, allDone)
  ok(nap2 > 5, '体力 0 且无口粮 → 等体力回复，不空转', `got=${nap2}`)
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
