// 站点 HTTP 客户端：统一处理登录态、Origin/Referer、节流、错误分类。
import { readSession } from './session.mjs'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export class AuthError extends Error { constructor(m = '登录已失效，请更新 cookie') { super(m); this.name = 'AuthError' } }
export class ConflictError extends Error { constructor(msg, data) { super(msg); this.name = 'ConflictError'; this.data = data } }
export class RateLimitError extends Error { constructor(m, retry) { super(m); this.name = 'RateLimitError'; this.retry = retry } }

// 服务端按 operation UUID 去重的写接口（重发安全）。
// 其它 POST 即使带了 operation（visit / help / auto / chest / equip…）也不在这里：
// 重复执行会多帮一次忙、多偷一次、多开一个箱子——宁可让这一条失败，等下一轮重来。
const IDEMPOTENT_POST_PATHS = new Set([
  '/api/pet/world/act',
  '/api/pet/battle',
  '/api/pet/battle/buy',
  '/api/pet/battle/enhance',
  '/api/pet/battle/respec',
  '/api/pet/battle/train',
  '/api/pet/state',
])

/**
 * 创建客户端。
 * minGap：两次 POST 的最小间隔（秒）。站点要求 ≥2 秒，这里默认 2.15 留余量。
 */
export function createClient({ baseUrl = 'https://52dmeme.com', cookie, minGap = 2.15, timeoutMs = 30000, dryRun = false } = {}) {
  if (!cookie) cookie = readSession().cookie

  let lastPostAt = 0
  let queueTail = Promise.resolve()
  // 最近一次请求的耗时（毫秒）。掐点偷菜要把它算进提前量：
  // 榜一的 computePhysicalPrepLeadSec 用的是 lastRttMs，我们以前按固定值估，
  // 网络慢的时候会醒得太晚，解禁那一刻还在路上。
  let lastRttMs = 600
  const stats = { get: 0, post: 0, errors: 0, lastError: '', lastOkAt: 0, lastPostAt: 0 }

  // 服务端时钟区间校准：每拿到一次带 now 的回执就收窄一次偏移区间。
  // 单次估计的误差上限是一整个 RTT（服务端是在请求发出到响应读完之间某一刻处理的），
  // 直接写成 serverNow − 本地收到时刻 会系统性偏小 RTT/2，实测能差 1.1 秒——
  // 而偷菜掐点是按秒抢的，晚 1 秒就是「目标数据 0 秒前拿到，0 处」。
  // 多个样本取交集后区间会收敛到几十毫秒。
  let offsetLoMs = null, offsetHiMs = null, lastClockSampleAtMs = 0
  function observeServerSec(serverSec, startMs, endMs) {
    const s = Number(serverSec)
    if (!Number.isFinite(s) || s <= 0) return
    // serverSec = floor(serverTrueMs / 1000) 发生在 t ∈ [startMs, endMs]
    // → s*1000 − endMs ≤ 真实偏移 ≤ s*1000 + 999 − startMs
    const lo = s * 1000 - endMs
    const hi = s * 1000 + 999 - startMs
    if (offsetLoMs == null) { offsetLoMs = lo; offsetHiMs = hi }
    else {
      // 允许本地时钟自身漂移（每小时 ≤ 1.8 秒），否则交集会被漂移锁死
      const elapsed = Math.max(0, endMs - lastClockSampleAtMs)
      const drift = Math.min(250, Math.ceil(elapsed * 0.0005))
      const nlo = Math.max(offsetLoMs - drift, lo)
      const nhi = Math.min(offsetHiMs + drift, hi)
      // 交集空了说明本地时钟跳变过（休眠/校时），重新开始
      if (nlo <= nhi) { offsetLoMs = nlo; offsetHiMs = nhi }
      else { offsetLoMs = lo; offsetHiMs = hi }
    }
    lastClockSampleAtMs = endMs
  }
  function serverOffsetMs() {
    if (offsetLoMs == null) return 0
    // 区间含 0：本地时钟就在误差内；否则取离 0 最近的端点——
    // 宁可早醒等一会儿，也不能晚到（晚到货就没了）。
    if (offsetLoMs <= 0 && 0 <= offsetHiMs) return 0
    const near = 0 < offsetLoMs ? offsetLoMs : offsetHiMs
    return Math.abs(near) <= 120 ? 0 : near
  }

  // POST 串行化：保证同一时刻只有一个 POST 在飞，且间隔 ≥ minGap
  function serialize(fn) {
    const run = queueTail.then(async () => {
      const waitMs = minGap * 1000 - (Date.now() - lastPostAt)
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs))
      try { return await fn() } finally { lastPostAt = Date.now(); stats.lastPostAt = lastPostAt }
    })
    // 即使失败也不能卡住队列
    queueTail = run.then(() => {}, () => {})
    return run
  }

  async function once(path, { method, body, keepalive } = {}) {
    const isPost = method === 'POST'
    const headers = {
      cookie,
      'user-agent': UA,
      referer: baseUrl + '/pets',
      accept: 'application/json, text/plain, */*',
    }
    if (isPost) { headers['content-type'] = 'application/json'; headers.origin = baseUrl }
    const t0 = Date.now()
    try {
      const res = await fetch(baseUrl + path, {
        method, headers, keepalive,
        body: isPost ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      const endMs = Date.now()
      let json = {}
      try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text.slice(0, 500) } }
      // 回执里的 now（秒）是服务端处理请求的时刻。只认合理时间戳范围，
      // 免得把某些接口里同名的布尔/小数值当成时钟。
      if (Number.isFinite(json?.now) && json.now > 1e9) observeServerSec(json.now, t0, endMs)
      return { res, json, text }
    } finally {
      // 失败也记：抢解禁时要按「最近一次真实往返」估提前量，不是理想值。
      const dt = Date.now() - t0
      if (dt > 0 && dt < 30000) lastRttMs = lastRttMs * 0.7 + dt * 0.3
    }
  }

  async function request(path, { method = 'GET', body, retries = 3, keepalive = false } = {}) {
    // 演练模式的最后一道保险丝：即使某个模块漏了 cfg.dry 检查，也写不出去。
    // GET 照常（演练要读世界状态）。
    if (dryRun && method === 'POST') {
      const err = new Error(`演练模式：已拦截写请求 ${path}`)
      err.name = 'DryRunError'
      throw err
    }
    const doOnce = () => once(path, { method, body, keepalive })
    const call = method === 'POST' ? () => serialize(doOnce) : doOnce
    // 重试边界：网络失败和 5xx 都可能意味着「服务端已经执行了，只是回执没回来」。
    // 带 operation UUID 且在白名单里的 POST 服务端会按它去重，重发安全；
    // 其它 POST（visit / help / buy / sell / chest / equip…）重发就是重复帮忙、
    // 重复偷、重复开箱 —— 宁可让这一条失败，等下一轮用最新世界状态重来。
    // 429 是例外：服务端明确拒绝了，没执行，任何请求都可以退避后重试。
    const idempotent = method !== 'POST' ||
      (IDEMPOTENT_POST_PATHS.has(String(path).split('?')[0]) &&
        Boolean(body && typeof body.operation === 'string' && body.operation))

    let lastErr
    for (let attempt = 0; attempt <= retries; attempt++) {
      let out
      try { out = await call() }
      catch (e) {
        lastErr = e
        if (idempotent && attempt < retries) { await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); continue }
        stats.errors++; stats.lastError = e.message
        throw new Error(`请求失败：${e.message}（${path}）`)
      }
      const { res, json } = out
      method === 'POST' ? stats.post++ : stats.get++

      if (res.status === 401) { stats.errors++; throw Object.assign(new AuthError(), { status: 401 }) }
      if (res.status === 403 && /非法来源/.test(json.error || '')) {
        stats.errors++
        throw new Error('站点拒绝了请求来源：POST 必须带 Origin 头（这是程序 bug，不是 cookie 问题）')
      }
      // 409/429 单独成类是为了让调用方能按名字分支，但 status 必须挂上：
      // 调用方（擂台的重试、偷菜的回执状态机）都是按 e.status 判断的，
      // 以前这里没挂，那些分支从来没命中过。
      if (res.status === 409) throw Object.assign(new ConflictError(json.error || '状态冲突（rev 已变）', json), { status: 409 })
      if (res.status === 429) {
        const retry = Number(json.retry) || 2
        if (attempt < retries) { await new Promise((r) => setTimeout(r, retry * 1000 + 200)); continue }
        throw Object.assign(new RateLimitError(`站点限流（429）`, retry), { status: 429 })
      }
      if (res.status >= 500) {
        lastErr = new Error(json.error || `HTTP ${res.status}`)
        if (idempotent && attempt < retries) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue }
        stats.errors++; stats.lastError = lastErr.message
        throw lastErr
      }
      if (!res.ok) {
        stats.errors++
        const msg = json.error || out.text.slice(0, 200) || `HTTP ${res.status}`
        stats.lastError = msg
        throw Object.assign(new Error(msg), { status: res.status, data: json })
      }
      stats.lastOkAt = Date.now()
      return json
    }
    throw lastErr || new Error('请求失败')
  }

  return {
    baseUrl,
    stats,
    // 规则模块热更新要用它重新拉 /pets 页面取版本号（不登录拿不到带 ?v= 的 script 标签）
    get cookie() { return cookie },
    get: (p, o) => request(p, { ...o, method: 'GET' }),
    post: (p, body, o) => request(p, { ...o, method: 'POST', body }),
    // 掐点用：最近一次往返耗时 / 下一次 POST 还要等多久。
    // 榜一的 computePhysicalPrepLeadSec 就是按这两个值算 T_prep：
    //   actPrep = 剩余 act 冷却 + minGap + 2×RTT
    // 用它才能保证「解禁前把口粮吃完、道具买好」，而不是解禁后才排队。
    get lastRttMs() { return lastRttMs },
    // 服务端时钟：毫秒精度的「此刻」估计 + 当前偏移（毫秒）。
    // clockNowMs() 型调用一律走这里，别再拿 Date.now() 直接跟服务端时刻比。
    get serverOffsetMs() { return serverOffsetMs() },
    estimatedServerNowMs: () => Date.now() + serverOffsetMs(),
    estimatedServerNowSec: () => Math.floor((Date.now() + serverOffsetMs()) / 1000),
    getRemainingPostCooldownMs: () => Math.max(0, minGap * 1000 - (Date.now() - lastPostAt)),
    // 世界状态 / 动作
    world: () => request('/api/pet/world'),
    act: (rev, actions, operation) => request('/api/pet/world/act', { method: 'POST', body: { rev, operation, actions } }),
    me: () => request('/api/me'),
  }
}
