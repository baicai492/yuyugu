// 鱼鱼谷全自动托管。用法：
//   node yuyugu.mjs            持续托管（Ctrl+C 停止）
//   node yuyugu.mjs --once     只巡视一次
//   node yuyugu.mjs --dry      只看计划，不提交任何操作
//   可叠加：--no-invest --no-cargo --no-help --no-npc --no-craft --no-sell
// 配置见 config.json；日志在 logs/。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, existsSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runOnce } from './extension/lib/core.mjs'
import { DEFAULTS, mergeConfig } from './extension/lib/defaults.mjs'

const here = (p) => new URL(p, import.meta.url)
const args = new Set(process.argv.slice(2))
const cfg = mergeConfig(DEFAULTS, JSON.parse(readFileSync(here('./config.json'), 'utf8')))
if (args.has('--dry')) cfg.dry = true
if (args.has('--no-invest')) cfg.invest.enabled = false
if (args.has('--no-cargo')) cfg.cargo.enabled = false
if (args.has('--no-help')) cfg.help.enabled = false
if (args.has('--no-npc')) cfg.npc.enabled = false
if (args.has('--no-craft')) cfg.craft.enabled = false
if (args.has('--no-sell')) cfg.sell.enabled = false
if (args.has('--steal')) cfg.steal.enabled = true
if (args.has('--no-arena')) cfg.arena.enabled = false
const once = args.has('--once') || cfg.dry

mkdirSync(here('./logs/'), { recursive: true })
mkdirSync(here('./cache/'), { recursive: true })
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
function log(msg) {
  const line = bj() + ' ' + msg
  console.log(line)
  try { appendFileSync(here('./logs/yuyugu-' + bj().slice(0, 10) + '.log'), line + '\n') } catch {}
}
const sleep = (sec) => new Promise((ok) => setTimeout(ok, sec * 1000))

class AuthError extends Error {}
const cookie = (() => {
  const raw = readFileSync(here(cfg.cookieFile), 'utf8').trim()
  return raw.includes('=') ? raw : 'sid=' + raw
})()
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
async function http(path, body) {
  const res = await fetch(cfg.baseUrl + path, {
    method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { cookie, 'user-agent': UA, referer: cfg.baseUrl + '/pets', ...(body ? { 'content-type': 'application/json', origin: cfg.baseUrl } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = {}
  try { json = JSON.parse(text) } catch {}
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) throw new AuthError(json.error || '登录已失效（HTTP ' + res.status + '）')
  return { status: res.status, ok: res.ok, json, text }
}

// ---------- 规则模块：直接用站点前后端共用的那份（随站点版本更新，按版本号缓存） ----------
const FORBIDDEN = /\b(import|require|process|fetch|eval|globalThis|XMLHttpRequest|WebSocket|Deno|child_process)\b|Function\s*\(/
let R = null, rulesVer = '', rulesCheckedAt = 0
async function loadRules(force) {
  if (R && !force && Date.now() - rulesCheckedAt < 30 * 60 * 1000) return
  rulesCheckedAt = Date.now()
  try {
    const page = await http('/pets')
    const ver = /pets\.js\?v=([0-9a-f]+)/.exec(page.text)?.[1] || /app\.js\?v=([0-9a-f]+)/.exec(page.text)?.[1]
    if (!ver) throw new Error('页面里找不到版本号')
    if (ver !== rulesVer) {
      const file = here('./cache/rules-' + ver + '.mjs')
      if (!existsSync(file)) {
        const src = (await http('/pet-world-rules.js?v=' + ver)).text
        // 这份代码会在本机 Node 里执行：只接受不含导入 / 网络 / 进程访问的纯计算模块
        if (!/export function applyActions/.test(src) || FORBIDDEN.test(src)) throw new Error('新版规则模块未通过安全检查，继续使用旧版（请人工确认 /pet-world-rules.js）')
        writeFileSync(file, src)
      }
      R = await import(file.href)
      if (rulesVer) log(`站点更新：规则模块 ${rulesVer} → ${ver}`)
      rulesVer = ver
    }
  } catch (e) {
    if (e instanceof AuthError) throw e
    if (R) { log('检查规则更新失败（沿用当前版本）：' + e.message); return }
    const cached = readdirSync(here('./cache/')).filter((f) => /^rules-.*\.mjs$/.test(f)).map((f) => ({ f, m: statSync(here('./cache/' + f)).mtimeMs })).sort((a, b) => b.m - a.m)[0]
    if (!cached) throw e
    log('拉取规则模块失败，使用本地缓存 ' + cached.f + '：' + e.message)
    R = await import(here('./cache/' + cached.f).href); rulesVer = cached.f.slice(6, -4)
  }
}

// ---------- 服务端接口 ----------
let skew = 0, lastPost = 0, last = {}
function accept(j) {
  if (j.clockStart && j.clockStart !== last.clockStart) R.b12ConfigureClock(j.clockStart)
  if (j.now) skew = j.now - Date.now() / 1000
  last = { ...last, ...Object.fromEntries(Object.entries({ state: j.state, rev: j.rev, coins: j.coins, prices: j.prices, clockStart: j.clockStart }).filter(([, v]) => v != null)) }
  return { ...last, now: Math.floor(j.now || Date.now() / 1000 + skew) }
}
const io = {
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
    if (!w.state.gift && !cfg.dry) { // 新号的 100 万新人礼
      const g = await http('/api/pet/world/welcome', { operation: randomUUID() })
      if (g.ok) { log('领取新人礼'); w = accept((await http('/api/pet/world')).json) }
    }
    return w
  },
  async act(rev, actions) {
    const operation = randomUUID() // 重试时复用同一个 operation，服务端据此去重
    for (let tries = 0; ; tries++) {
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
      if (r.json.autoLog?.visits) log('站内管家补算了 ' + r.json.autoLog.visits + ' 轮巡视（建议在游戏里关掉管家，避免和本脚本抢体力、被抽 20% 代卖费）')
      return { out: r.json.out || [], world: accept(r.json) }
    }
  },
  async neighbors(cursor) {
    const r = await http('/api/pet/world/neighbors?limit=20&q=' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
    if (!r.ok) throw new Error(r.json.error || '读取邻居失败')
    return r.json
  },
  async help(id) {
    await sleep(1.2)
    const r = await http('/api/pet/world/help/' + id, { operation: randomUUID() })
    if (!r.ok) throw new Error(r.json.error || '帮忙失败')
    return r.json
  },
}

// ---------- 单实例锁 ----------
const lockFile = here('./cache/run.lock')
if (!cfg.dry) {
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, 'utf8'))
    let alive = false
    try { process.kill(pid, 0); alive = pid !== process.pid } catch {}
    if (alive) { console.error(`已有一个托管进程在运行（PID ${pid}）。两个进程会互相冲突，本次退出。`); process.exit(1) }
  }
  writeFileSync(lockFile, String(process.pid))
  const unlock = () => { try { if (Number(readFileSync(lockFile, 'utf8')) === process.pid) unlinkSync(lockFile) } catch {} }
  process.on('exit', unlock)
  process.on('SIGINT', () => { log('收到停止信号，退出'); process.exit(0) })
}

// ---------- 主循环 ----------
const fmt = (n) => Math.round(n).toLocaleString('en-US')
const stockValue = (w) => Object.entries(w.state.inv || {}).reduce((v, [id, qs]) => v + qs.reduce((x, n, q) => x + n * (Number(w.prices?.[id]) || 0) * R.QUALITY[q], 0), 0)
const memo = {}
let failures = 0, ledgerKey = ''
log(`鱼鱼谷托管启动${cfg.dry ? '（演练模式，不提交）' : ''}：投资 ${cfg.invest.enabled ? '开' : '关'}，货船 ${cfg.cargo.enabled ? '开' : '关'}，52弟 ${cfg.npc.enabled ? '开' : '关'}，串门帮忙 ${cfg.help.enabled ? '开' : '关'}`)
while (true) {
  let wait = 60
  try {
    await loadRules()
    const r = await runOnce(io, R, cfg, log, memo)
    failures = 0; wait = r.sleep
    const w = r.world, key = bj().slice(0, 13)
    if (key !== ledgerKey && !cfg.dry) { // 每小时记一笔账
      ledgerKey = key
      const f = here('./logs/ledger.csv')
      if (!existsSync(f)) writeFileSync(f, 'time,coins,stock_value,energy,plots,animals,rod,pick,spr,house\n')
      appendFileSync(f, [bj(), w.coins, Math.round(stockValue(w)), w.state.en, w.state.plotN, w.state.barn.length, w.state.tools.rod, w.state.tools.pick, w.state.tools.spr, w.state.tools.house].join(',') + '\n')
    }
    if (once) { log(`当前 D币 ${fmt(w.coins)}，库存按现价约 ${fmt(stockValue(w))}，体力 ${w.state.en}/${R.energyMax(w.state)}；持续托管时下次巡视在 ${r.sleep} 秒后`); break }
  } catch (e) {
    if (e instanceof AuthError) { log('❌ ' + e.message + '：请更新 ' + cfg.cookieFile + ' 里的 cookie 后重新启动'); process.exit(2) }
    failures++
    wait = Math.min(600, 30 * failures)
    log(`出错（第 ${failures} 次，${wait} 秒后重试）：${e.message}`)
    if (once) process.exit(1)
  }
  await sleep(wait)
}
