// 站点 HTTP 客户端：统一处理登录态、Origin/Referer、节流、错误分类。
import { readSession } from './session.mjs'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export class AuthError extends Error { constructor(m = '登录已失效，请更新 cookie') { super(m); this.name = 'AuthError' } }
export class ConflictError extends Error { constructor(msg, data) { super(msg); this.name = 'ConflictError'; this.data = data } }
export class RateLimitError extends Error { constructor(m, retry) { super(m); this.name = 'RateLimitError'; this.retry = retry } }

/**
 * 创建客户端。
 * minGap：两次 POST 的最小间隔（秒）。站点要求 ≥2 秒，这里默认 2.15 留余量。
 */
export function createClient({ baseUrl = 'https://52dmeme.com', cookie, minGap = 2.15, timeoutMs = 30000 } = {}) {
  if (!cookie) cookie = readSession().cookie

  let lastPostAt = 0
  let queueTail = Promise.resolve()
  const stats = { get: 0, post: 0, errors: 0, lastError: '', lastOkAt: 0, lastPostAt: 0 }

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
    const res = await fetch(baseUrl + path, {
      method, headers, keepalive,
      body: isPost ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json = {}
    try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text.slice(0, 500) } }
    return { res, json, text }
  }

  async function request(path, { method = 'GET', body, retries = 3, keepalive = false } = {}) {
    const doOnce = () => once(path, { method, body, keepalive })
    const call = method === 'POST' ? () => serialize(doOnce) : doOnce

    let lastErr
    for (let attempt = 0; attempt <= retries; attempt++) {
      let out
      try { out = await call() }
      catch (e) {
        lastErr = e
        if (attempt < retries) { await new Promise((r) => setTimeout(r, 500 * (attempt + 1))); continue }
        stats.errors++; stats.lastError = e.message
        throw new Error(`请求失败：${e.message}（${path}）`)
      }
      const { res, json } = out
      method === 'POST' ? stats.post++ : stats.get++

      if (res.status === 401) { stats.errors++; throw new AuthError() }
      if (res.status === 403 && /非法来源/.test(json.error || '')) {
        stats.errors++
        throw new Error('站点拒绝了请求来源：POST 必须带 Origin 头（这是程序 bug，不是 cookie 问题）')
      }
      if (res.status === 409) throw new ConflictError(json.error || '状态冲突（rev 已变）', json)
      if (res.status === 429) {
        const retry = Number(json.retry) || 2
        if (attempt < retries) { await new Promise((r) => setTimeout(r, retry * 1000 + 200)); continue }
        throw new RateLimitError(`站点限流（429）`, retry)
      }
      if (res.status >= 500) {
        lastErr = new Error(json.error || `HTTP ${res.status}`)
        if (attempt < retries) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue }
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
    get: (p, o) => request(p, { ...o, method: 'GET' }),
    post: (p, body, o) => request(p, { ...o, method: 'POST', body }),
    // 世界状态 / 动作
    world: () => request('/api/pet/world'),
    act: (rev, actions, operation) => request('/api/pet/world/act', { method: 'POST', body: { rev, operation, actions } }),
    me: () => request('/api/me'),
  }
}
