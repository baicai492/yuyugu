// 站宠护理（/api/pet/state）：喂食 / 玩耍 / 休息 / 清洁 + 每日首见，把每日经验刷到上限。
//
// 为什么值得做：站宠等级就是擂台等级（`/api/pet/battle/home` 的 `me.level` 与
// `progress.level` 同值），每级按 levelGrowth 直接加面板
// （hp +5、atk +0.7、agi +0.5、spd +0.5），并在 16/18/20/25/30/40/50 级解锁新招式
// （rules/pet-battle-rules.json）。守家胜率越高，被偷得越少；擂台也更容易赢。
// 护理不花 D 币、不花小岛体力，只有每日经验上限。
//
// 数值全部取自**线上前端原文**（2026-11-14 复核 /pet-store.js、/pet-state.js），
// 不按参考仓库的旧常数写：对方的 feed +28 饱食 / clean +32 / rest +30 / play +20 心情
// 与现在的站点对不上（线上字段叫 cleanliness，没有 mood，数值也不一样）。
//
//   动作        效果                                        经验
//   feed        饱食 +18，亲密度 +2                            8
//   play        精力 −10，饱食 −4，亲密度 +7                  12
//   rest        精力 +22，饱食 −2                             4
//   clean       清洁 +28，亲密度 +1                            4
//   首见        每天第一次见面                                     20
//   摸摸        每 20 秒 +2（这里不刷，只保留首见）
//   升级        L → L+1 需要 L×100 经验，升级亲密度 +3
//   衰减（每整小时，按等级）：饱食 2×(L≥10?0.5:L≥2?0.9:1)
//                             精力 L≥10?0.5:L≥6?0.8:1
//                             清洁 L≥10?0.5:1
//   每日上限    以服务端 progress.cap 为准（当前账号 1000，不是前端的 300）
//
// 提交协议与前端 flushPet 完全一致：
//   GET  /api/pet/state → { user_id, revision, state, progress }
//   POST /api/pet/state → { user_id, revision, base_total, operation, state }
//   409 = 别的标签页/设备先存了，重新 GET 再规划一次。
import { randomUUID } from 'node:crypto'

/** 护理动作（线上 pet-store.js CARE 原文） */
export const CARE = {
  play: { xp: 12, run: (s) => { s.energy = clamp(s.energy - 10); s.hunger = clamp(s.hunger - 4); s.affection = clamp(s.affection + 7) }, ok: (s) => s.energy >= 12 },
  feed: { xp: 8, run: (s) => { s.hunger = clamp(s.hunger + 18); s.affection = clamp(s.affection + 2) }, ok: (s) => s.hunger < 95 },
  rest: { xp: 4, run: (s) => { s.energy = clamp(s.energy + 22); s.hunger = clamp(s.hunger - 2) }, ok: (s) => s.energy < 95 },
  clean: { xp: 4, run: (s) => { s.cleanliness = clamp(s.cleanliness + 28); s.affection = clamp(s.affection + 1) }, ok: (s) => s.cleanliness < 95 },
}
// 按经验从高到低试：每步都选「当前合法且经验最高」的动作
const CARE_ORDER = ['play', 'feed', 'rest', 'clean']

const MEET_XP = 20
const MAX_LEVEL = 100
const DEFAULT_CAP = 1000

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(Number(v) || 0)))
}

/** 北京时间自然日（与线上 today() 同口径） */
export function petDay(nowSec) {
  return new Date((Number(nowSec) + 8 * 3600) * 1000).toISOString().slice(0, 10)
}

/** 总经验 ↔ 等级（线上 levelOf/totalOf 原文：升到 L+1 需要 L×100） */
export function levelOfTotal(total) {
  let level = 1
  let rest = Math.max(0, Math.floor(Number(total) || 0))
  while (level < MAX_LEVEL && rest >= level * 100) { rest -= level * 100; level++ }
  return { level, xp: level >= MAX_LEVEL ? 0 : rest }
}
export function totalOfState(s) {
  return 50 * (Math.max(1, s.level) - 1) * Math.max(1, s.level) + Math.max(0, Number(s.xp) || 0)
}

/** 按等级每整小时衰减；不足 1 小时的部分保留（和前端 applyDecay 一致） */
export function applyPetDecay(state, nowSec) {
  const s = { ...state }
  const now = Math.floor(Number(nowSec) || 0)
  if (!s.lastTick) s.lastTick = now
  const elapsed = Math.max(0, now - Number(s.lastTick))
  const hours = Math.floor(elapsed / 3600)
  if (hours <= 0) return s
  const lv = Math.max(1, Number(s.level) || 1)
  const rate = {
    hunger: 2 * (lv >= 10 ? 0.5 : lv >= 2 ? 0.9 : 1),
    energy: lv >= 10 ? 0.5 : lv >= 6 ? 0.8 : 1,
    cleanliness: lv >= 10 ? 0.5 : 1,
  }
  const counted = Math.min(48, hours)   // 前端最多只结算 48 小时
  s.hunger = clamp(s.hunger - counted * rate.hunger)
  s.energy = clamp(s.energy - counted * rate.energy)
  s.cleanliness = clamp(s.cleanliness - counted * rate.cleanliness)
  s.lastTick = hours > 48 ? now : Number(s.lastTick) + hours * 3600
  return s
}

/**
 * 规划一次护理。
 *
 * @param petData  GET /api/pet/state 的回执
 * @param nowSec  服务端时间（秒）
 * @param opts.maxActions 单次保存最多做几个护理动作（默认 60，约 500 经验）
 * @returns {{ ok, state, actions, xpGained, cap, dayXpBefore, dayXpAfter, remaining, before, after, reason }}
 */
export function planPetCare(petData, nowSec, { maxActions = 60 } = {}) {
  const raw = petData?.state
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: '还没有站宠存档', actions: [], xpGained: 0 }
  }
  const prog = petData.progress || {}
  const s = applyPetDecay(structuredClone(raw), nowSec)
  const day = petDay(nowSec)
  if (!s.daily || s.daily.day !== day) s.daily = { day, xp: 0, met: false }

  // 服务端的 day_xp 才是权威；本地 daily.xp 只作兜底（可能比服务端新，比如网页还开着）
  const localXp = s.daily.day === day ? Math.max(0, Number(s.daily.xp) || 0) : 0
  const dayXp0 = Math.max(0, Number(prog.day_xp) || 0, localXp)
  // 让本地 daily.xp 与服务端对齐：写回存档时服务端看到的当日累计才是对的
  s.daily = { day, xp: dayXp0, met: s.daily.day === day ? !!s.daily.met : false }
  const cap = Number.isFinite(Number(prog.cap)) && Number(prog.cap) > 0 ? Math.floor(Number(prog.cap)) : DEFAULT_CAP
  const before = {
    level: Math.max(1, Number(s.level) || 1), xp: Math.max(0, Number(s.xp) || 0),
    dayXp: dayXp0, hunger: clamp(s.hunger), energy: clamp(s.energy), cleanliness: clamp(s.cleanliness),
  }
  let remaining = Math.max(0, cap - dayXp0)
  const actions = []

  // 经验入账：与前端 gainXp 同口径（先扣每日上限，再逐级结算）
  const gain = (n) => {
    const add = Math.max(0, Math.min(Math.floor(Number(n) || 0), remaining))
    if (!add) return 0
    remaining -= add
    s.daily.xp = Math.max(0, Number(s.daily.xp) || 0) + add
    s.xp = Math.max(0, Number(s.xp) || 0) + add
    while (s.level < MAX_LEVEL && s.xp >= s.level * 100) {
      s.xp -= s.level * 100
      s.level++
      s.affection = clamp(s.affection + 3)
    }
    return add
  }

  // 每日首见（线上 petInteract 的每日第一次）
  if (!s.daily.met && remaining > 0) {
    s.daily.met = true
    const add = gain(MEET_XP)
    if (add) actions.push({ kind: 'meet', xp: add })
  }

  // 太脏/太饿时先照顾一下（纯经验最大化会让清洁永远排在最后，状态一路掉到 0）
  if (clamp(s.cleanliness) < 60 && remaining > 0 && actions.length < maxActions) {
    CARE.clean.run(s)
    const add = gain(CARE.clean.xp)
    if (add) actions.push({ kind: 'clean', xp: add })
  }

  // 护理动作循环：每步选当前合法且经验最高的那个。
  // guard 防止「动作永远合法但不涨经验」之类的病态循环（理论上到不了）。
  let guard = 0
  while (remaining > 0 && actions.length < maxActions && guard++ < maxActions * 4) {
    const kind = CARE_ORDER.find((k) => CARE[k].ok(s))
    if (!kind) break
    CARE[kind].run(s)
    const add = gain(CARE[kind].xp)
    if (!add) break
    actions.push({ kind, xp: add })
  }

  const xpGained = actions.reduce((a, x) => a + x.xp, 0)
  return {
    ok: true,
    state: s,
    actions,
    xpGained,
    cap,
    dayXpBefore: dayXp0,
    dayXpAfter: dayXp0 + xpGained,
    remaining,
    before,
    after: {
      level: s.level, xp: s.xp, hunger: s.hunger, energy: s.energy, cleanliness: s.cleanliness, affection: s.affection,
    },
  }
}

function summarizeActions(actions) {
  const names = { meet: '首见', feed: '喂食', play: '玩耍', rest: '休息', clean: '清洁' }
  const cnt = {}
  for (const a of actions) cnt[a.kind] = (cnt[a.kind] || 0) + 1
  return Object.entries(cnt).map(([k, n]) => `${names[k] || k}×${n}`).join(' ')
}

/**
 * 执行一轮护理（读 → 规划 → 保存，最多 maxSavesPerTick 次）。
 *
 * 放在擂台之前：升级带来的自由属性点必须先在服务端生效，
 * 紧接着的换装/加点才能算对（参考实现的 syncPetCareFirst 也是这个因果顺序）。
 */
export async function petCareRound(world, cfg, log = () => {}, memo = {}) {
  const pc = cfg.petCare || {}
  if (pc.enabled === false) return { saved: 0, xpGained: 0 }
  world.tickClock?.()
  const now = world.now
  // 两次尝试的最小间隔：经验刷满后不必每轮都 GET 一遍
  if (memo.petCareGapUntil && now < memo.petCareGapUntil) return { saved: 0, xpGained: 0 }

  let saved = 0
  let xpTotal = 0
  const maxSaves = Math.max(1, Math.min(4, Number(pc.maxSavesPerTick) || 2))
  let lastProgress = null

  for (let i = 0; i < maxSaves; i++) {
    let data
    try {
      data = await world.client.get('/api/pet/state')
    } catch (e) {
      log('站宠：读取存档失败：' + e.message)
      break
    }
    world.tickClock?.()
    const plan = planPetCare(data, world.now, { maxActions: pc.maxActionsPerSave ?? 60 })
    if (!plan.ok) {
      memo.petCareGapUntil = world.now + 3600
      break
    }
    if (!plan.actions.length) {
      // 今天已经满了：一天只提示一次
      const key = `pet-full-${petDay(world.now)}`
      if (plan.remaining <= 0 && memo.petCareNote !== key) {
        memo.petCareNote = key
        log(`站宠：今日经验已满（${plan.dayXpBefore}/${plan.cap}），Lv${plan.before.level}` +
          `（饱食 ${plan.before.hunger} / 精力 ${plan.before.energy} / 清洁 ${plan.before.cleanliness}）`)
      }
      memo.pet = { ...(memo.pet || {}), ...plan.before, cap: plan.cap, at: world.now }
      memo.petCareGapUntil = world.now + Math.max(300, Number(pc.retryGapSec) || 900)
      break
    }

    const body = { user_id: data.user_id, revision: data.revision, operation: randomUUID(), state: plan.state }
    // 前端只在拿到过服务端 total 时才带 base_total（服务端据此校验经验增量）
    if (Number.isSafeInteger(data.progress?.total)) body.base_total = data.progress.total

    let res
    try {
      res = await world.client.post('/api/pet/state', body)
    } catch (e) {
      // 409：别的标签页/设备刚存过。重新 GET 再规划一轮。
      if (e?.name === 'ConflictError') { continue }
      log('站宠：保存失败：' + e.message)
      memo.petCareGapUntil = world.now + 900
      break
    }

    const prog = res?.progress || {}
    lastProgress = prog
    saved++
    xpTotal += plan.xpGained
    memo.pet = {
      level: prog.level ?? plan.after.level,
      xp: prog.xp ?? plan.after.xp,
      day: prog.day,
      dayXp: prog.day_xp,
      cap: prog.cap ?? plan.cap,
      hunger: plan.after.hunger,
      energy: plan.after.energy,
      cleanliness: plan.after.cleanliness,
      at: world.now,
    }
    const lvFrom = plan.before.level
    const lvTo = prog.level ?? plan.after.level
    log(`站宠：${summarizeActions(plan.actions)}｜经验 +${plan.xpGained}（今日 ${plan.dayXpAfter}/${plan.cap}）` +
      (lvTo > lvFrom ? `｜升级 Lv${lvFrom} → Lv${lvTo}（+${(lvTo - lvFrom) * 3} 自由点）` : ''))

    // 服务端没把经验记进去（已满 / 被判定无效）：本轮停下，别再空发请求
    const srvBefore = Number(plan.dayXpBefore) || 0
    const srvAfter = Number(prog.day_xp)
    if (Number.isFinite(srvAfter) && srvAfter <= srvBefore) {
      log(`站宠：服务端未计入经验（今日仍 ${srvAfter}/${prog.cap ?? plan.cap}），本轮停止`)
      break
    }
    if (plan.remaining <= 0) break
  }

  if (!saved && lastProgress == null) memo.petCareGapUntil = Math.max(memo.petCareGapUntil || 0, world.now + 600)
  return { saved, xpGained: xpTotal, pet: memo.pet || null }
}
