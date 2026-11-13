// 大肥鱼修仙记 2.0（state.xs）自动托管。
//
// 1.0 的种田/炼丹/打坐由 core/xian.mjs 的 planXianActions 负责；本模块只管
// 2.0 新增的八块：人脉（talk/gift/chap）、机缘（evroll/evpick）、宗门（tasks/task/
// stipend）、配招（slots）、自动对战（ab）、秘境（rin/rgo/rbuy/rout）。
//
// 为什么能「先算再提交」：
//   · ab 的战斗种子 = hseed(日, 对手, 当日第几场, 灵石, 修为)，全部是本地已知量；
//   · 秘境的整张地图与每一场战斗也都由 hseed 决定（rlmMap / mobFighter / sim）；
//   所以这两块可以**逐场预演**，只提交「打得赢、收益最高」的那条路径。
//   唯二不确定的是 evroll 与 tasks —— 服务端 rand 生成，只能先提交再看结果。
//
// 安全边界：绝不提交 xsFight / xsWin / xsLose（弹幕手动斗法），
// 也绝不给 rgo 传 n=1（那会进入手动斗法并写 xsFight）。

import * as A from './xian-rules.mjs'
import { assertSafeXianBatch, toWireXsAction, xsDay } from './xian.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 效果估值（全部折算成「灵石当量」）。数值只是相对排序用，不追求绝对准确。
const VAL = {
  stone: 0.5, cv: 1, luck: 8, mind: 1, fav: 2, rep: 1, en: 0.6,
  peiyuan: 30, huiling: 10, otherPill: 15, herb: 6, seed: 6, mat: 15,
}
const PILL_VAL = (id) => (id === 'peiyuan' ? VAL.peiyuan : id === 'huiling' ? VAL.huiling : VAL.otherPill)

function effectValue(e) {
  if (!e) return 0
  let v = 0
  if (e.cv) v += e.cv * VAL.cv
  if (e.stone) v += e.stone * VAL.stone
  if (e.luck) v += e.luck * VAL.luck
  if (e.mind) v += e.mind * VAL.mind
  if (e.fav) v += e.fav * VAL.fav
  if (e.favOf) for (const n of Object.values(e.favOf)) v += n * VAL.fav
  if (e.rep) v += e.rep * VAL.rep
  if (e.en) v += e.en * VAL.en
  for (const [id, n] of Object.entries(e.pill || {})) v += n * PILL_VAL(id)
  for (const n of Object.values(e.herb || {})) v += n * VAL.herb
  for (const n of Object.values(e.seed || {})) v += n * VAL.seed
  if (e.rel) v += 20
  return v
}

function bagValue(x) {
  let v = (x.stone || 0) * VAL.stone + (x.cv?.xp || 0) * VAL.cv
  v += (x.mind || 50) * VAL.mind + (x.luck || 0) * VAL.luck + (x.rep || 0) * VAL.rep
  for (const [id, n] of Object.entries(x.pills || {})) v += n * PILL_VAL(id)
  for (const [id, n] of Object.entries(x.bag || {})) v += n * VAL.herb
  for (const [id, n] of Object.entries(x.mat || {})) v += n * VAL.mat
  for (const [id, n] of Object.entries(x.seeds || {})) v += n * VAL.seed
  // 好感和关系也是资产（和 effectValue 同一口径：好感 2/点、关系 20/层）。
  // 往事的选项常常只给 fav/rel 不给物资，不折进来就会一律判成「没收益」而永远不选，
  // 章节推进跟着卡死。
  for (const row of Object.values(x.npc || {})) {
    v += Number(row?.[0] || 0) * VAL.fav + Number(row?.[1] || 0) * 20
  }
  return v
}

function lootValue(lt) {
  if (!lt) return 0
  let v = (lt.st || 0) * VAL.stone
  for (const n of Object.values(lt.h || {})) v += n * VAL.herb
  for (const [id, n] of Object.entries(lt.p || {})) v += n * PILL_VAL(id)
  for (const n of Object.values(lt.m || {})) v += n * VAL.mat
  return v
}

const npcList = () => [...A.OLD_NPCS, ...Object.keys(A.NEW_NPCS)]
const favOf = (x, id) => Number(x.npc?.[id]?.[0] || 0)
const relOf = (x, id) => Number(x.npc?.[id]?.[1] || 0)
const chapDone = (x, id) => Number(x.npc?.[id]?.[2] || 0)

// ---------------- 配招 ----------------

/** 用确定性 sim 给「技能组合 × 出手顺序」打分，选期望最高的 4 技能槽 */
function chooseLoadout(x, opts) {
  const skills = A.skillsOf(x)
  const uniq = [...new Set(skills)]
  if (uniq.length < 4 || !x.tech) return null

  // 对手样本：所有同门里按等级取中位附近的几个 + 最高层的精英怪
  const opps = []
  try {
    const list = Object.entries(A.NPC_FIGHT).map(([id, [el, lv]]) => A.npcFighter(id)).filter(Boolean)
    list.sort((a, b) => a.hp - b.hp)
    for (const i of [0, Math.floor(list.length / 3), Math.floor((2 * list.length) / 3), list.length - 1]) {
      if (list[i]) opps.push(list[i])
    }
    const area = Object.keys(A.AREAS).filter((k) => (x.cv?.r || 0) >= A.AREAS[k].need).pop()
    if (area) {
      const a = A.AREAS[area]
      // MOBS 里根本没有 'elite' 这个键（AREAS 只维护普通怪和 boss），
      // 以前写 mobFighter(area, 'elite', …) 会抛 TypeError，而它和 boss 取样
      // 在同一个 try 里，连 boss 样本一起被吞掉——配招搜索等于从来没见过的秘境敌人。
      opps.push(A.mobFighter(area, a.mobs[0], 1.4, 777))
      opps.push(A.mobFighter(area, a.boss, 1.7, 778))
    }
  } catch { /* 拿不到样本就用空集 */ }
  if (!opps.length) return null

  const me0 = A.meFighter(x, 1)
  const score = (slots) => {
    let s = 0
    for (const op of opps) {
      const me = { ...me0, sl: slots }
      const r = A.sim(me, op, 12345)
      s += (r.w ? 100 : 0) + Math.max(0, 40 - Math.abs(r.hp[0] - r.hp[1]) / 10)
    }
    return s
  }

  const t0 = Date.now()
  let best = null
  const combos = []
  if (uniq.length <= 6) {
    // C(n,4)：直接枚举
    for (let a = 0; a < uniq.length; a++)
      for (let b = a + 1; b < uniq.length; b++)
        for (let c = b + 1; c < uniq.length; c++)
          for (let d = c + 1; d < uniq.length; d++) combos.push([uniq[a], uniq[b], uniq[c], uniq[d]])
  } else {
    // 技能太多时先按「单体时对样本的贡献」粗排，取前 6 再做组合
    const solo = uniq.map((s) => ({ s, v: score([s, 'bolt', 'guard', uniq.find((u) => u !== s) || s]) }))
    solo.sort((p, q) => q.v - p.v)
    const top = solo.slice(0, Math.min(6, solo.length)).map((p) => p.s)
    for (let a = 0; a < top.length; a++)
      for (let b = a + 1; b < top.length; b++)
        for (let c = b + 1; c < top.length; c++) {
          const rest = top.filter((_, i) => i !== a && i !== b && i !== c)
          for (const d of rest) combos.push([top[a], top[b], top[c], d])
        }
  }

  const perms = (arr) => {
    if (arr.length <= 1) return [arr]
    const out = []
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
      for (const p of perms(rest)) out.push([arr[i], ...p])
    }
    return out
  }

  for (const c of combos) {
    if (best && Date.now() - t0 > (opts.loadoutMs ?? 900)) break
    for (const p of perms(c)) {
      const v = score(p)
      if (!best || v > best.v) best = { v, slots: p }
    }
  }
  return best?.slots || null
}

// ---------------- 秘境 ----------------

function planRealm(A_, x, now, opts) {
  // 已在秘境里：直接续；否则先选一处进（优先没通关过的、越靠后越好）
  let acts = []
  let sim
  const hadRlm = Boolean(x.rlm)
  if (hadRlm) {
    sim = structuredClone(x)
  } else {
    const d = xsDay(now)
    if (x.rd?.d === d && (x.rd.n || 0) >= A.RLM_DAILY) return null
    if ((x.en || 0) < A.RLM_EN) return null
    if (!x.tech) return null
    const areas = Object.keys(A.AREAS).filter((k) => (x.cv?.r || 0) >= A.AREAS[k].need)
    if (!areas.length) return null
    areas.sort((p, q) => ((x.rc?.[q] ? 0 : 1) - (x.rc?.[p] ? 0 : 1)) || (A.AREAS[q].k - A.AREAS[p].k))
    const area = areas[0]
    sim = structuredClone(x)
    const r = A.act(sim, { a: 'rin', herb: area }, now, () => 0.99)
    if (!r?.ok || !sim.rlm) return null
    acts.push({ a: 'rin', herb: area })
  }

  const base = bagValue(sim)
  const start = { x: sim, acts, val: 0 }
  let beam = [start]
  const finished = []
  for (let step = 0; step < 18; step++) {
    const next = []
    for (const st of beam) {
      const z = st.x.rlm
      if (!z) { finished.push(st); continue }
      const cands = [{ rout: true }, ...A.rlmNext(A.rlmMap(z.sd), z).map((n) => ({ i: n.c }))]
      // 行商节点：气血低于七成时买一包回春散（25 灵石回一半血）。
      // 这笔永远划算——多撑过一个战斗节点就多几十灵石和材料。
      // 玄铁/灵玉（80 灵石换一份材料）按相对价值是亏的，不买。
      if (z.R >= 0 && z.hp < z.mx * 0.7 && (st.x.stone || 0) >= 25) {
        const m = A.rlmMap(z.sd)
        const node = m[z.L]?.[z.R]?.find((n) => n.c === z.c)
        if (node?.k === 'shop' && !(z.bought || []).includes(`${z.L}.${z.R}.0`)) cands.push({ buy: 0 })
      }
      for (const c of cands) {
        const cw = structuredClone(st.x)
        const act = c.rout ? { a: 'rout' } : c.buy != null ? { a: 'rbuy', i: c.buy } : { a: 'rgo', i: c.i }
        const r = A.act(cw, act, now, () => 0.99)
        if (!r?.ok) continue
        const na = [...st.acts, act]
        const zz = cw.rlm
        const val = bagValue(cw) - base +
          (zz ? lootValue(zz.lt) + 40 * Math.max(0, zz.hp / Math.max(1, zz.mx)) : 0)
        const node = { x: cw, acts: na, val }
        if (!zz) finished.push(node)
        else next.push(node)
      }
    }
    if (!next.length) break
    next.sort((p, q) => q.val - p.val)
    beam = next.slice(0, Math.max(1, opts.beam ?? 6))
  }
  const all = [...finished, ...beam].sort((p, q) => q.val - p.val)
  const best = all[0]
  if (!best) return null
  // 开局那一步没得到任何收益、还立刻撤出 → 这趟不划算，别浪费次数。
  // 但「本来就在秘境里」的情况必须把 rout 发出去：否则那个存档会一直卡着
  // （6 小时内进不了别的秘境），还会让唤醒时间一直很短。
  if (!hadRlm && best.acts.length <= 2 && best.val < 30) return null
  return best.acts
}

// ---------------- 主规划 ----------------

/**
 * 规划一批 2.0 动作。返回内部动作（已转成线上 xsXxx 形式）。
 * 只在本地预演成功（或明确要提交给服务端判定）的动作才会出现在结果里。
 */
export function planXian2Actions(world, now, opts = {}) {
  const raw = world?.state?.xs
  if (!raw) return { actions: [], reason: 'no-xs-state' }
  const t = Math.floor(now || world.now || 0)
  // 有人在网页端斗法（xsFight 落盘后 30 分钟内）：1.0 的 planXianActions 有这道闸，
  // 2.0 以前漏了——会一边有人在打弹幕，一边自动拉秘境/对战把状态搅乱。
  if (raw.fight && t - Number(raw.fight.t || 0) < 1800) {
    return { actions: [], reason: 'manual-fight-in-progress' }
  }
  const sim = structuredClone(raw)
  try { A.tick(sim, t) } catch { }
  const d = xsDay(t)
  const acts = []
  const maxN = Math.max(1, Math.min(30, opts.maxActionsPerBatch ?? 30))
  const emit = (a) => {
    if (acts.length >= maxN) return false
    let r
    try { r = A.act(sim, a, t, () => 0.99) } catch { return false }
    if (!r?.ok) return false
    acts.push(toWireXsAction(a))
    // act3 的返回值里有战斗/秘境细节，这里只用于本地推进 sim
    return true
  }
  // 服务端随机的动作（tasks / evroll）也走 emit：本地用固定 rand 预演一遍，
  // 只为把 x.log、灵石等推进到和服务端一致；真实结果以服务端回执为准。

  // 1) 俸禄：白拿
  emit({ a: 'stipend' })

  // 2) 宗门委托：列表每天随机，先提交一次拿到列表。
  //    本地用固定 rand 走一遍只为把 x.log / 灵石消耗推进到和服务端一致——
  //    秘籍/对战的种子都用到 x.log 与 x.stone，差一步整条路径就错位。
  let tasksJustRolled = false
  if (!(sim.tk?.d === d) && acts.length < maxN) {
    if (emit({ a: 'tasks' })) tasksJustRolled = true
  }

  // 3) 交委托（本地能判断的条件都先预演）。刚刷新出来的列表服务端可能不同，
  //    这一轮不交，等下一批拿到真实列表再说。
  if (!tasksJustRolled && sim.tk?.d === d && Array.isArray(sim.tk.list)) {
    sim.tk.list.forEach((it, n) => {
      if (!it || it[1]) return
      emit({ a: 'task', n })
    })
  }

  // 4) 秘境：能量花在收益最高的地方，放在对战之前
  if (opts.realm !== false) {
    for (let round = 0; round < 3; round++) {
      const before = acts.length
      const runActs = planRealm(A, sim, t, opts)
      if (!runActs?.length) break
      // 把整条路径重放到 acts/sim 上（planRealm 已经在副本上验证过）
      let okAll = true
      for (const a of runActs) {
        if (!emit(a)) { okAll = false; break }
      }
      if (!okAll) break
      if (acts.length === before) break
    }
  }

  // 5) 人脉：先把 30 次叙话用满（优先需要推好感的往事角色）
  {
    const talked = sim.ch?.d === d ? sim.ch.ids : []
    const needFav = Object.entries(A.CHAPTERS)
      .filter(([id]) => chapDone(sim, id) < (A.CHAPTERS[id]?.length || 0))
      .map(([id]) => id)
    const order = [...new Set([...needFav, ...npcList()])]
    for (const id of order) {
      if (talked.includes(id)) continue
      if (acts.length >= maxN) break
      if (!emit({ a: 'talk', el: id })) break
    }
  }

  // 6) 赠礼：只送对方喜欢的（+40），而且留够自家用的余量
  {
    for (const id of Object.keys(A.CHAPTERS)) {
      if (acts.length >= maxN) break
      const liked = A.PREF[id]?.[0] || []
      for (const k of liked) {
        const isPill = !!A.PILLS[k]
        const have = isPill ? (sim.pills?.[k] || 0) : (sim.bag?.[k] || 0)
        if (have < (isPill ? 2 : 3)) continue
        if (emit({ a: 'gift', el: id, herb: k })) break
      }
    }
  }

  // 7) 往事：按顺序推进，两个选项本地各模拟一次，取估值高的
  {
    for (const [id, chapters] of Object.entries(A.CHAPTERS)) {
      if (acts.length >= maxN) break
      const n = chapDone(sim, id)
      const c = chapters[n]
      if (!c) continue
      if (favOf(sim, id) < (c.need?.fav || 0)) continue
      if ((sim.cv?.r || 0) < (c.need?.r || 0)) continue
      let best = null
      for (let i = 0; i < 2; i++) {
        const cw = structuredClone(sim)
        const r = A.act(cw, { a: 'chap', el: id, n, i }, t, () => 0.99)
        if (!r?.ok) continue
        const v = bagValue(cw) - bagValue(sim)
        if (!best || v > best.v) best = { v, i }
      }
      if (best && best.v > 0) emit({ a: 'chap', el: id, n, i: best.i })
    }
  }

  // 8) 配招：学习到的技能变了才重算（比较昂贵）
  {
    const key = `${sim.tech}|${(sim.techs || []).join(',')}`
    const cur = Array.isArray(sim.sl) ? sim.sl.join(',') : ''
    const memoOk = opts.memo?.xian2SlotKey === key && opts.memo?.xian2SlotVal === cur
    if (sim.tech && !memoOk && acts.length < maxN) {
      const best = chooseLoadout(sim, opts)
      if (best && best.join(',') !== cur) {
        emit({ a: 'slots', herb: best.join(',') })
      }
      if (opts.memo) {
        opts.memo.xian2SlotKey = key
        opts.memo.xian2SlotVal = Array.isArray(sim.sl) ? sim.sl.join(',') : cur
      }
    }
  }

  // 9) 自动对战：只打「预演能赢」的（输一场 10 灵力只换 3 好感，不值）
  {
    let n = sim.df?.d === d ? (sim.df.n || 0) : 0
    const wonToday = sim.dd?.d === d ? (sim.dd.w || []) : []
    const all = Object.entries(A.NPC_FIGHT)
      .map(([id]) => ({ id, f: A.npcFighter(id) }))
      .filter((c) => c.f)
      // 先打「今天还没赢过」的：第一胜给灵石。
      // 赢过的不是没收益：规则里再赢一次仍然 +3 好感、+1 功法熟练
      //（熟练推进 techLayer，层数直接加战力），所以次数没用完就继续打——
      // 旧版把已胜的永久排除，8 场额度通常只用到 3~4 场。
      .sort((p, q) => (wonToday.includes(p.id) ? 1 : 0) - (wonToday.includes(q.id) ? 1 : 0) || p.f.hp - q.f.hp)
    for (const c of all) {
      if (n >= A.FIGHT_DAILY) break
      if (acts.length >= maxN) break
      if ((sim.en || 0) < 10) break
      // 再赢一次只有 +3 好感 +1 熟练，性价比低于种地/钓鱼；体力不宽裕时让给 1.0。
      // 首胜有灵石，不受这道门槛限制。
      if (wonToday.includes(c.id) && (sim.en || 0) < 40) continue
      // 先克隆预演一次，确认能赢再真的 emit
      const cw = structuredClone(sim)
      const r = A.act(cw, { a: 'ab', el: c.id }, t, () => 0.99)
      if (!r?.ok || !r.fight?.w) continue
      if (!emit({ a: 'ab', el: c.id })) break
      n++
    }
  }

  // 10) 机缘：已抽到就选最优选项；没抽过且冷却好了就抽
  {
    const ev = sim.ev
    if (ev?.cur && t - ev.cur.t <= 1800) {
      const E = A.EVENTS.find((e) => e.id === ev.cur.id)
      if (E) {
        const luck = A.xsLuck(sim)
        let roll = (ev.cur.r ?? 0.5) - luck / 400
        let best = null
        E.opt.forEach((o, i) => {
          if (o.need?.r && (sim.cv?.r || 0) < o.need.r) return
          if (o.cost) {
            if (o.cost.stone && (sim.stone || 0) < o.cost.stone) return
            let short = false
            for (const [k, v] of Object.entries(o.cost.pill || {})) if ((sim.pills?.[k] || 0) < v) short = true
            for (const [k, v] of Object.entries(o.cost.herb || {})) if ((sim.bag?.[k] || 0) < v) short = true
            if (short) return
          }
          let acc = roll, k = 0
          for (; k < o.rolls.length - 1; k++) { acc -= o.rolls[k][0]; if (acc < 0) break }
          const eff = o.rolls[k]?.[1] || {}
          let v = effectValue(eff)
          if (o.cost?.stone) v -= o.cost.stone * VAL.stone
          for (const [pk, pv] of Object.entries(o.cost?.pill || {})) v -= pv * PILL_VAL(pk)
          for (const [hk, hv] of Object.entries(o.cost?.herb || {})) v -= hv * VAL.herb
          if (!best || v > best.v) best = { v, i }
        })
        if (best && best.v > -5) emit({ a: 'evpick', i: best.i })
      }
    } else if ((ev?.d !== d || (ev?.n || 0) < A.EV_DAILY) && t - (ev?.d === d ? (ev.last || 0) : 0) >= A.EV_GAP && acts.length < maxN) {
      // 服务端随机，抽到什么只能等回执；本地按固定 rand 预演只为推进 x.log。
      // last 按自然日归零：规则里跨日会把 ev 整个重置成 {d,n:0,last:0,cur:null}
      // （xian-rules.mjs:212），拿昨天的 last 会让「刚过 0 点」白等一个冷却。
      emit({ a: 'evroll' })
    }
  }

  const reason = acts.length ? 'planned' : 'idle'
  return { actions: acts.slice(0, maxN), reason }
}

/** 下一次值得回来的时刻（秒）；没有就返回 Infinity */
export function nextXian2WakeSec(world, now) {
  const x = world?.state?.xs
  if (!x) return Infinity
  const t = Math.floor(now || world.now || 0)
  const d = xsDay(t)
  const cands = []

  // 机缘：手上有未决的事件就尽快选；否则等冷却好了再抽
  if (x.ev?.cur && t - x.ev.cur.t <= 1800) cands.push(t + 15)
  else if (x.ev?.d !== d || (x.ev?.n || 0) < A.EV_DAILY) {
    const at = (x.ev?.d === d ? (x.ev.last || 0) : 0) + A.EV_GAP
    cands.push(at <= t ? t + 20 : at)
  }

  // 秘境：在里面就尽快继续；否则等灵力回到够一次
  if (x.rlm) cands.push(t + 20)
  else if (x.tech) {
    const left = x.rd?.d === d ? A.RLM_DAILY - (x.rd.n || 0) : A.RLM_DAILY
    if (left > 0) {
      const need = Math.max(0, A.RLM_EN - (x.en || 0))
      // 灵力是「每隔 RG 秒 +1」，起点是 enAt（上次结算时刻），不是 now。
      // 写成 t + need*RG 会把已经走了的那半格丢掉，每次都晚醒半格到一格。
      if (need > 0) {
        const rg = A.EN_REGEN * (x.tech === 'wind' ? 0.75 : 1)
        const at = Number(x.enAt || t) + need * rg
        cands.push(at > t ? at : t + 20)
      } else cands.push(t + 20)
    }
  }

  // 斗法：今天还有名额且灵力不够时，等灵力回到 10
  const duels = x.df?.d === d ? (x.df.n || 0) : 0
  if (duels < A.FIGHT_DAILY && (x.en || 0) < A.FIGHT_COST) {
    const rg = A.EN_REGEN * (x.tech === 'wind' ? 0.75 : 1)
    const at = Number(x.enAt || t) + (A.FIGHT_COST - (x.en || 0)) * rg
    cands.push(at > t ? at : t + 20)
  }

  const next = cands.length ? Math.min(...cands) : Infinity
  return Number.isFinite(next) ? Math.max(t + 10, next) : Infinity
}

/**
 * 跑一轮修仙 2.0。和 xianRound 一样：连做几批，每批之后用新状态重规划。
 * 返回 { ran, actions, reason, nextWakeAt }
 */
export async function xian2Round(world, cfg, log = () => {}, memo = {}) {
  const xc = cfg?.xian || {}
  const x2 = cfg?.xian2 || {}
  if (xc.enabled === false || x2.enabled === false) return { ran: false, actions: 0, reason: 'disabled' }
  const opts = {
    maxActionsPerBatch: Math.max(1, Math.min(30, x2.maxActions ?? xc.maxActions ?? 24)),
    beam: x2.realmBeam ?? 6,
    loadoutMs: x2.loadoutMs ?? 900,
    realm: x2.realm !== false,
    memo,
  }
  const first = planXian2Actions(world, world.now, opts)
  if (!first.actions.length) {
    // 算出来的唤醒点很近但这一轮一个动作都排不出来（比如秘境预演判定不值），
    // 说明「看起来有活其实干不了」——把唤醒推后，避免每 20 秒空转一次。
    let at = nextXian2WakeSec(world, world.now)
    if (Number.isFinite(at) && at - world.now < 60) at = world.now + 300
    memo.xian2WakeAt = at
    memo.xian2Reason = first.reason
    return { ran: false, actions: 0, reason: first.reason, nextWakeAt: memo.xian2WakeAt }
  }
  if (cfg.dry) {
    log(`[演练] 修仙2.0计划：${first.actions.map((a) => a.a).join('、')}`)
    return { ran: false, actions: 0, reason: 'dry', planned: first.actions.length }
  }

  const maxBatches = Math.max(1, Math.min(5, x2.maxBatchesPerRound ?? 3))
  let total = 0
  let plan = first
  let okNames = []
  // 提交前过一遍和 1.0 同一道闸：禁手动斗法、只许 xs*、长度不超限、融合/突破的开关。
  // 2.0 的动作来源多（束搜索 + 逐个 emit），加一道独立校验比信任上游便宜得多。
  const guard = {
    maxActionsPerBatch: opts.maxActionsPerBatch,
    autoFuse: Boolean(xc.autoFuse),
    breakMode: xc.breakMode || 'smart',
  }
  for (let i = 0; i < maxBatches; i++) {
    if (!plan.actions.length) break
    let res
    try {
      assertSafeXianBatch(plan.actions, guard)
      res = await world.act(plan.actions, { silent: true })
    } catch (e) {
      log(`修仙2.0提交被拒：${e.message}`, 'warn')
      break
    }
    const out = res.out || []
    const ok = out.filter((o) => o?.ok)
    total += ok.length
    okNames = ok.map((o) => o.a || '')
    if (ok.length) {
      const names = {}
      for (const o of ok) names[o.a] = (names[o.a] || 0) + 1
      log(`修仙2.0：${Object.entries(names).map(([k, v]) => `${k}×${v}`).join(' ')}`)
      // 秘境/对战的收益在回执里，单独报一句
      for (const o of ok) {
        if (o.end) log(`  秘境：${o.msg || (o.end === 'win' ? '通关' : '撤出')}`)
        else if (o.fight && o.a === 'xsAb') log(`  斗法：${o.msg || ''}`)
        else if (o.a === 'xsStipend' || o.a === 'xsTask') log(`  ${o.msg || ''}`)
      }
    }
    const fail = out.filter((o) => o && !o.ok)
    if (fail.length) log(`修仙2.0有 ${fail.length} 个动作未被接受：${fail[0].msg || '未知原因'}`, 'warn')
    // 有随机动作（evroll/tasks）时后续计划依赖服务端结果，必须重规划
    plan = planXian2Actions(world, world.now, opts)
  }

  memo.xian2WakeAt = nextXian2WakeSec(world, world.now)
  if (total === 0) {
    // 提交了但全被拒：多半是规则/状态不同步，别马上回来重试
    const t = world.now
    if (Number.isFinite(memo.xian2WakeAt) && memo.xian2WakeAt - t < 120) memo.xian2WakeAt = t + 600
  }
  memo.xian2Reason = plan.reason
  memo.xian2LastAt = world.now
  memo.xian2LastOk = total
  return { ran: true, actions: total, reason: plan.reason, nextWakeAt: memo.xian2WakeAt, names: okNames }
}

/** GUI 用快照 */
export function xian2Snapshot(world) {
  const x = world?.state?.xs
  if (!x) return null
  const t = Math.floor(world?.now || 0)
  const d = xsDay(t)
  const areas = {}
  for (const [k, a] of Object.entries(A.AREAS)) {
    areas[k] = { name: a.n, unlocked: (x.cv?.r || 0) >= a.need, cleared: Boolean(x.rc?.[k]) }
  }
  return {
    mind: x.mind ?? 50,
    luck: x.luck ?? 0,
    rep: x.rep || 0,
    ctb: x.ctb || 0,
    sect: A.SECT_RANK[A.sectRank(x)]?.[1] || '',
    stipendDone: x.sp === d,
    tasks: x.tk?.d === d ? (x.tk.list || []).map((v) => ({ done: !!v[1] })) : [],
    talks: x.ch?.d === d ? (x.ch.ids || []).length : 0,
    // 规则里写死的上限是 30，但全服只有 29 个 NPC——显示 29/30 会让人以为
    // 「还差一个没做」，其实是当天全部叙完了。按实际人数封顶。
    talksMax: Math.min(30, npcList().length),
    // 机缘：今日已抽次数 / 上限，以及「有事件没选」的状态（GUI 要提示用户/显示待决）
    ev: {
      n: x.ev?.d === d ? x.ev.n || 0 : 0,
      max: A.EV_DAILY,
      pending: Boolean(x.ev?.cur && t - x.ev.cur.t <= 1800),
      gapIn: Math.max(0, (x.ev?.d === d ? x.ev.last || 0 : 0) + A.EV_GAP - t),
    },
    duels: x.df?.d === d ? x.df.n || 0 : 0,
    duelsMax: A.FIGHT_DAILY,
    realms: x.rd?.d === d ? x.rd.n || 0 : 0,
    realmsMax: A.RLM_DAILY,
    inRealm: x.rlm ? { area: A.AREAS[x.rlm.a]?.n || x.rlm.a, hp: x.rlm.hp, mx: x.rlm.mx } : null,
    areas,
    mats: x.mat || {},
    slots: Array.isArray(x.sl) ? x.sl.slice() : null,
  }
}
