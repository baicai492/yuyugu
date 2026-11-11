// 鱼鱼谷托管 · 页面端主逻辑。由 content.js 以 <script type="module"> 注入到站点页面里运行：
// 请求和站点自己的前端完全同源（自动带登录态和 Origin），规则模块直接用站点当前线上的那一份。
import { runOnce } from './lib/core.mjs'
import { DEFAULTS, mergeConfig } from './lib/defaults.mjs'

const OUT = 'yyg-page', IN = 'yyg-ext'
const post = (type, data = {}) => window.postMessage({ src: OUT, type, ...data }, location.origin)
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
const log = (msg) => { const line = bj() + ' ' + msg; console.log('[鱼鱼谷托管] ' + msg); post('log', { line }) }
class AuthError extends Error {}
class Stopped extends Error {}

// 后台标签页的 setTimeout 会被浏览器压到每分钟一次，Worker 里的定时器不受影响
const timer = (() => {
  try {
    const w = new Worker(URL.createObjectURL(new Blob(['onmessage=(e)=>setTimeout(()=>postMessage(e.data.id),e.data.ms)'], { type: 'text/javascript' })))
    const waits = new Map()
    let seq = 0
    w.onmessage = (e) => { const ok = waits.get(e.data); waits.delete(e.data); ok?.() }
    return (ms) => new Promise((ok) => { const id = ++seq; waits.set(id, ok); w.postMessage({ id, ms }) })
  } catch { return (ms) => new Promise((ok) => setTimeout(ok, ms)) }
})()
const sleep = (sec) => Promise.race([timer(Math.max(0, sec) * 1000), new Promise((ok) => setTimeout(ok, Math.max(0, sec) * 1000 + 70000))])

// ---------- 配置与指令（来自插件弹窗，经 content.js 转发） ----------
let live = null, forced = false, halted = false, seed = null
const wakers = new Set()
const wake = () => { for (const f of wakers) f(); wakers.clear() }
let gotConfig
const firstConfig = new Promise((ok) => { gotConfig = ok })
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.src !== IN) return
  const d = e.data
  if (d.type === 'seed') seed = d.seed
  else if (d.type === 'config') { live = mergeConfig(DEFAULTS, d.cfg); gotConfig(); wake() }
  else if (d.type === 'cmd' && d.cmd === 'run') { forced = true; wake() }
  else if (d.type === 'dead') { halted = true; wake() } // 插件被停用 / 重新加载：旧实例必须停下
})

// ---------- 状态上报 ----------
let status = { state: 'starting' }
function report(patch) { status = { ...status, ...patch, at: Date.now() }; post('status', { status }) }
async function nap(sec) {
  const until = Date.now() + sec * 1000
  let woke = false
  const poked = new Promise((ok) => wakers.add(() => { woke = true; ok() }))
  while (!woke && Date.now() < until) { report({}); await Promise.race([sleep(Math.min(30, (until - Date.now()) / 1000)), poked]) }
}

// ---------- 站点接口 ----------
async function http(path, body) {
  const res = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(30000), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  if (res.type === 'opaqueredirect' || res.status === 401) throw new AuthError('登录已失效，请在本站重新登录')
  const text = await res.text()
  let json = {}
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, ok: res.ok, json, text }
}

let R = null, rulesVer = '', rulesCheckedAt = 0
async function loadRules() {
  if (R && Date.now() - rulesCheckedAt < 30 * 60 * 1000) return
  rulesCheckedAt = Date.now()
  let ver = ''
  try { const page = await http('/pets'); ver = /pets\.js\?v=([0-9a-f]+)/.exec(page.text)?.[1] || /app\.js\?v=([0-9a-f]+)/.exec(page.text)?.[1] || '' } catch (e) { if (e instanceof AuthError) throw e }
  if (!ver) ver = /[?&]v=([0-9a-f]+)/.exec(document.querySelector('script[src*="app.js"]')?.src || '')?.[1] || ''
  if (!ver) { if (R) return; throw new Error('找不到站点版本号，无法加载规则模块') }
  if (ver === rulesVer) return
  const mod = await import(location.origin + '/pet-world-rules.js?v=' + ver)
  if (typeof mod.applyActions !== 'function') throw new Error('规则模块结构变了，托管暂停（需要更新插件）')
  if (rulesVer) log(`站点更新：规则模块 ${rulesVer} → ${ver}`)
  R = mod; rulesVer = ver
}

const stockValue = (w) => Object.entries(w.state.inv || {}).reduce((v, [id, qs]) => v + qs.reduce((x, n, q) => x + n * (Number(w.prices?.[id]) || 0) * R.QUALITY[q], 0), 0)
const store = { get: (k) => { try { return JSON.parse(localStorage.getItem('yyg:' + k)) } catch { return null } }, set: (k, v) => { try { localStorage.setItem('yyg:' + k, JSON.stringify(v)) } catch {} } }
let skew = 0, lastPost = 0, last = {}
function accept(j) {
  if (j.clockStart && j.clockStart !== last.clockStart) R.b12ConfigureClock(j.clockStart)
  if (j.now) skew = j.now - Date.now() / 1000
  last = { ...last, ...Object.fromEntries(Object.entries({ state: j.state, rev: j.rev, coins: j.coins, prices: j.prices, clockStart: j.clockStart }).filter(([, v]) => v != null)) }
  return { ...last, now: Math.floor(j.now || Date.now() / 1000 + skew) }
}
const checkStop = () => { if (halted || !(live.enabled || forced)) throw new Stopped() }
function makeIo(cfg) {
  return {
    async api(path, body) {
      const r = await http('/api' + path, body)
      if (!r.ok) throw Object.assign(new Error(r.json.error || '请求失败（HTTP ' + r.status + '）'), { status: r.status })
      return r.json
    },
    sleep, now: () => Date.now() / 1000 + skew,
    async world() {
      const r = await http('/api/pet/world')
      if (!r.ok) throw new Error(r.json.error || '小岛加载失败（HTTP ' + r.status + '）')
      let w = accept(r.json)
      if (!w.state.gift && !cfg.dry) {
        const g = await http('/api/pet/world/welcome', { operation: crypto.randomUUID() })
        if (g.ok) { log('领取新人礼'); w = accept((await http('/api/pet/world')).json) }
      }
      const day = bj().slice(0, 10)
      if (store.get('day')?.day !== day) store.set('day', { day, coins: w.coins, stock: Math.round(stockValue(w)) })
      return w
    },
    async act(rev, actions) {
      const operation = crypto.randomUUID() // 重试时复用同一个 operation，服务端据此去重
      for (let tries = 0; ; tries++) {
        checkStop()
        const wait = lastPost + cfg.loop.postGap - Date.now() / 1000
        if (wait > 0) await sleep(wait)
        lastPost = Date.now() / 1000
        let r
        try { r = await http('/api/pet/world/act', { rev, operation, actions }) } catch (e) {
          if (e instanceof AuthError || tries >= 3) throw e
          await sleep(5); continue
        }
        if (r.status === 429 && tries < 6) { await sleep((r.json.retry || 2) + 0.3); continue }
        if (r.status === 409) return { conflict: true, world: accept(r.json) }
        if (!r.ok) throw new Error((r.json.error || '提交失败') + '（HTTP ' + r.status + '）')
        if (r.json.autoLog?.visits) log('站内管家补算了 ' + r.json.autoLog.visits + ' 轮巡视（建议在游戏里关掉管家，避免和托管抢体力、被抽 20% 代卖费）')
        return { out: r.json.out || [], world: accept(r.json) }
      }
    },
    async neighbors(cursor) {
      const r = await http('/api/pet/world/neighbors?limit=20&q=' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
      if (!r.ok) throw new Error(r.json.error || '读取邻居失败')
      return r.json
    },
    async help(id) {
      checkStop()
      await sleep(1.2)
      const r = await http('/api/pet/world/help/' + id, { operation: crypto.randomUUID() })
      if (!r.ok) throw new Error(r.json.error || '帮忙失败')
      return r.json
    },
  }
}

// 按服务端数据补今天的账（日志被清空、换浏览器、插件更新前的操作都能补上）：
// 收入 = 赚钱榜里自己今天的累计（已扣税）；税 = 税务流水；支出 = 08:00 结余额税前的余额 + 收入 − 余额税 − 现在的余额。
async function recoverBook(w, memo) {
  const book = memo.book, day = bj().slice(0, 10)
  if (!book || book.day !== day || book.srv) return
  book.srv = true
  const get = async (p) => { const r = await http(p); if (!r.ok) throw new Error(r.json.error || 'HTTP ' + r.status); return r.json }
  const rank = await get('/api/pet/world/rank/earn/day?limit=1'), tax = await get('/api/pet/world/tax')
  const today = (tax.history || []).filter((h) => bj(h.created_at * 1000).slice(0, 10) === day)
  const saleTax = today.filter((h) => h.kind === 'pet-world-sale-tax').reduce((x, h) => x - h.delta, 0)
  const bal = today.find((h) => h.kind === 'pet-world-balance-tax')
  const earn = rank.day === day && rank.mine ? Number(rank.mine.value) || 0 : 0
  const start = store.get('day')
  if (bal) { const coins0 = bal.balance_after - bal.delta; store.set('day', { day, coins: coins0, stock: start?.day === day ? start.stock : Math.round(stockValue(w)) }); book.spend = Math.max(book.spend, coins0 + earn + bal.delta - w.coins) }
  book.earn = Math.max(book.earn, earn); book.tax = Math.max(book.tax, saleTax)
  log(`补账（按服务端数据）：今日收入 ${book.earn.toLocaleString('en-US')}，支出 ${book.spend.toLocaleString('en-US')}，卖货税 ${book.tax.toLocaleString('en-US')}` + (bal ? `，余额税 ${(-bal.delta).toLocaleString('en-US')}` : ''))
}

// ---------- 主循环（同一浏览器里只让一个标签页跑：用 Web Locks 抢占，持锁的页面也不会被冻结） ----------
async function loop() {
  const memo = store.get('memo') || {}
  let failures = 0
  log('托管就绪（本标签页负责运行）')
  while (!halted) {
    if (!live.enabled && !forced) {
      // 暂停时不操作，只读一次状态并按服务端数据补账，弹窗里照样能看到今天的收支
      try {
        await loadRules()
        const w = await makeIo({ ...live, dry: true }).world(), t = w.now, day = R.isleDay(t), today = bj().slice(0, 10)
        if (memo.book?.day !== today) memo.book = { day: today, earn: 0, spend: 0, tax: 0 }
        await recoverBook(w, memo); store.set('memo', memo)
        report({ ver: rulesVer, coins: w.coins, stock: Math.round(stockValue(w)), en: w.state.en, enMax: R.energyMax(w.state), isleNo: R.isleDayNo(t), season: R.SEASONS[R.seasonOf(day)], weather: R.WEATHERS[R.weatherOf(day)], night: R.b12IsLongNight(t), mineMax: w.state.mine?.max, book: memo.book, plots: w.state.plotN, animals: w.state.barn.length, tools: w.state.tools, dayStart: store.get('day') })
      } catch (e) { if (!(e instanceof AuthError)) console.warn('[鱼鱼谷托管] 读取状态失败', e) }
      report({ state: 'paused', msg: '', nextAt: 0 }); await nap(600); continue
    }
    let wait = 60
    const cfg = structuredClone(live), once = forced && !live.enabled
    try {
      report({ state: 'running', msg: '', nextAt: 0 })
      await loadRules()
      const r = await runOnce(makeIo(cfg), R, cfg, log, memo)
      if (seed && memo.book?.day === seed.day && !memo.book.seeded) { for (const k of ['earn', 'spend', 'tax']) memo.book[k] = Math.max(memo.book[k], seed[k]); memo.book.seeded = true }
      try { await recoverBook(r.world, memo) } catch (e) { log('补账失败：' + e.message) }
      store.set('memo', memo)
      failures = 0; wait = r.sleep
      const w = r.world, t = w.now, day = R.isleDay(t), stock = Math.round(stockValue(w)), start = store.get('day')
      report({ state: 'sleeping', msg: '', ver: rulesVer, coins: w.coins, stock, en: w.state.en, enMax: R.energyMax(w.state), isleNo: R.isleDayNo(t), season: R.SEASONS[R.seasonOf(day)], weather: R.WEATHERS[R.weatherOf(day)], night: R.b12IsLongNight(t),
        ripeAt: r.ripeAt, mineMax: w.state.mine?.max, book: memo.book, stolenAt: memo.stolenAt || 0, plots: w.state.plotN, animals: w.state.barn.length, tools: w.state.tools, dayStart: start, nextAt: Date.now() + wait * 1000 })
      const hour = bj().slice(0, 13)
      if (!cfg.dry && store.get('hour') !== hour) { store.set('hour', hour); post('ledger', { row: { t: bj().slice(0, 16), coins: w.coins, stock } }) }
    } catch (e) {
      if (e instanceof Stopped) { log('已暂停'); wait = 0 }
      else if (e instanceof AuthError) { wait = 300; log('❌ ' + e.message); report({ state: 'auth', msg: e.message, nextAt: Date.now() + wait * 1000 }) }
      else { failures++; wait = Math.min(600, 30 * failures); log(`出错（第 ${failures} 次，${wait} 秒后重试）：${e.message}`); report({ state: 'error', msg: e.message, nextAt: Date.now() + wait * 1000 }) }
    }
    forced = false
    if (once) continue
    await nap(wait)
  }
}

if (!window.__yygRunner) {
  window.__yygRunner = true
  ;(async () => {
    post('ready')
    await firstConfig
    try { if (navigator.locks) await navigator.locks.request('yyg-runner', () => loop()); else await loop() }
    finally { window.__yygRunner = false } // 插件重新加载后，新注入的实例可以接手
  })()
}
