// 本地 HTTP 服务：给 Chrome GUI 插件提供状态、配置、行情与指令。
// 只监听 127.0.0.1，且要求 Origin 白名单 + 可选 token，防止被网页里的脚本乱调。
import { createServer } from 'node:http'
import { saveConfig } from './config.mjs'

const ALLOW_ORIGIN = [
  'chrome-extension://',
  'http://127.0.0.1',
  'http://localhost',
]

function cors(req, res) {
  const origin = req.headers.origin || ''
  if (ALLOW_ORIGIN.some((x) => origin.startsWith(x))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization')
  res.setHeader('Access-Control-Max-Age', '600')
}

function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > 1_000_000) throw new Error('请求体过大')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('请求体不是合法 JSON') }
}

/**
 * 启动服务。
 *   engine  引擎实例
 *   cfg     配置对象（可热改）
 *   port    端口，默认 8787
 *   token   可选：要求请求头 Authorization: Bearer <token>
 */
export function startServer({ engine, cfg, port = 8787, token = '', onConfigChange }) {
  const server = createServer(async (req, res) => {
    cors(req, res)
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname

    // token 校验（设置了才校验）
    if (token) {
      const auth = req.headers.authorization || ''
      if (auth !== 'Bearer ' + token) return send(res, 401, { error: 'token 无效' })
    }

    try {
      // ---------- 状态 ----------
      if (req.method === 'GET' && path === '/api/status') {
        return send(res, 200, {
          ok: true,
          status: engine.statusSnapshot(),
          config: cfg,
          version: 1,
        })
      }

      // ---------- 市场预测 ----------
      if (req.method === 'GET' && path === '/api/market') {
        const days = Number(url.searchParams.get('days')) || undefined
        const markdownPct = url.searchParams.get('markdown') != null ? Number(url.searchParams.get('markdown')) : undefined
        const snap = engine.marketSnapshot({ days, markdownPct })
        if (!snap) return send(res, 503, { error: '世界状态尚未就绪' })
        return send(res, 200, snap)
      }

      // ---------- 日志 ----------
      if (req.method === 'GET' && path === '/api/logs') {
        const since = Number(url.searchParams.get('since')) || 0
        return send(res, 200, { logs: engine.logs.filter((l) => l.t > since) })
      }

      // ---------- 配置 ----------
      if (req.method === 'GET' && path === '/api/config') {
        return send(res, 200, { config: cfg })
      }
      if (req.method === 'POST' && path === '/api/config') {
        const body = await readJson(req)
        const patch = body.config || body
        Object.assign(cfg, deepMerge(cfg, patch))
        if (body.save !== false) saveConfig(cfg)
        onConfigChange?.(cfg)
        return send(res, 200, { ok: true, config: cfg })
      }

      // ---------- 指令 ----------
      if (req.method === 'POST' && path === '/api/command') {
        const body = await readJson(req)
        const cmd = body.cmd
        switch (cmd) {
          case 'start':
            cfg.enabled = true
            engine.log('GUI：启动托管')
            return send(res, 200, { ok: true })
          case 'stop':
            cfg.enabled = false
            engine.log('GUI：暂停托管')
            return send(res, 200, { ok: true })
          case 'dry':
            cfg.dry = !!body.value
            engine.log('GUI：' + (cfg.dry ? '切换到演练模式' : '切换到真实提交'))
            return send(res, 200, { ok: true })
          case 'once':
            engine.log('GUI：手动巡视一次')
            engine.tick().catch((e) => engine.log('手动巡视出错：' + e.message, 'err'))
            return send(res, 200, { ok: true })
          case 'exit':
            engine.log('GUI：退出程序')
            setTimeout(() => process.exit(0), 300)
            return send(res, 200, { ok: true })
          default:
            return send(res, 400, { error: '未知指令：' + cmd })
        }
      }

      // ---------- 单件行情 ----------
      if (req.method === 'GET' && path === '/api/item') {
        const id = url.searchParams.get('id')
        const snap = engine.marketSnapshot()
        if (!snap) return send(res, 503, { error: '世界状态尚未就绪' })
        const series = snap.forecast.map((f) => ({ day: f.day, price: f.prices?.[id] ?? null, low: f.low?.[id] ?? null, high: f.high?.[id] ?? null }))
        const row = snap.rows.find((r) => r.id === id) || null
        return send(res, 200, { id, series, row, supply: snap.supply.items[id] || null })
      }

      // ---------- 健康检查 ----------
      if (path === '/api/ping') return send(res, 200, { ok: true, name: 'yuyugu', version: 1 })

      return send(res, 404, { error: '未知路径：' + path })
    } catch (e) {
      return send(res, 500, { error: e.message })
    }
  })

  server.listen(port, '127.0.0.1', () => {
    engine.log(`本地服务已启动：http://127.0.0.1:${port}`)
  })
  return server
}

function deepMerge(base, patch) {
  const out = {}
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v)
    } else out[k] = v
  }
  return out
}
