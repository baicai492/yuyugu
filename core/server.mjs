// 本地 HTTP 服务：给 Chrome GUI 插件提供状态、配置、行情与指令。
// 只监听 127.0.0.1，且要求 Origin 白名单 + 可选 token，防止被网页里的脚本乱调。
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { openSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveConfig } from './config.mjs'
import { readLogHistory, logInventory, findLegacyExtensionStores, readLegacyDir } from './logfile.mjs'

// 主程序版本号：GUI 标题栏显示为 v<版本>。
// 这套是 v2（Node 主程序 + Chrome 仅 GUI）。加战斗内核那次误升到 3，已改回。
export const VERSION = 2

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

/** 端口是否已经有人监听（重启交棒时判断新进程有没有起来） */
function portUp(port) {
  return new Promise((ok) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => { sock.destroy(); ok(true) })
    sock.on('error', () => ok(false))
    sock.setTimeout(800, () => { sock.destroy(); ok(false) })
  })
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
          version: VERSION,
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

      // ---------- 修仙 ----------
      // 灵石只在修仙内部闭环、换不成 D 币，所以单独一个面板，不和市场收益混在一起。
      if (req.method === 'GET' && path === '/api/xian') {
        const snap = engine.xianView()
        if (!snap) return send(res, 503, { error: '世界状态尚未就绪' })
        return send(res, 200, { ok: true, xian: snap, enabled: Boolean(cfg.xian?.enabled) })
      }

      // ---------- 日志（本次运行） ----------
      if (req.method === 'GET' && path === '/api/logs') {
        const since = Number(url.searchParams.get('since')) || 0
        return send(res, 200, { logs: engine.logs.filter((l) => l.t > since) })
      }

      // ---------- 日志（历史，从磁盘读） ----------
      if (req.method === 'GET' && path === '/api/logs/history') {
        const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days')) || 3))
        const maxLines = Math.max(50, Math.min(5000, Number(url.searchParams.get('max')) || 800))
        const dir = engine.logDir
        return send(res, 200, {
          days: logInventory(dir),
          logs: readLogHistory(dir, { days, maxLines }),
        })
      }

      // ---------- 旧插件（v1 Chrome 扩展）的浏览器内历史日志 ----------
      if (req.method === 'GET' && path === '/api/logs/legacy') {
        const cfgNow = engine.cfg
        const extId = cfgNow.log?.legacyExtensionId
        if (!extId) return send(res, 200, { stores: [], rows: [], error: '未配置旧插件扩展 ID' })
        const manual = cfgNow.log?.legacyStoreDir
        const stores = manual
          ? [{ browser: '手动指定', profile: '-', dir: manual, size: 0 }]
          : findLegacyExtensionStores(extId)
        if (!stores.length) {
          return send(res, 200, { stores: [], rows: [], error: `没在浏览器里找到插件 ${extId} 的存储（可能已卸载，或换过 profile）` })
        }
        const maxLines = Math.max(50, Math.min(5000, Number(url.searchParams.get('max')) || 800))
        const st = stores[0]                       // 取最大的那份
        const r = readLegacyDir(st.dir, { maxLines })
        return send(res, 200, {
          stores,
          active: st,
          rows: r.rows,
          total: r.total,
          files: r.files,
          error: r.error || '',
        })
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
            // 写回 config.json：GUI 的开关现在是「电源开关」语义（右上角一打开就拉起主程序
            // 并开托管）。不落盘的话，主程序下次重启会按文件里的旧值恢复，
            // 用户明明关掉了却又自己开起来。
            saveConfig(cfg)
            engine.log('GUI：启动托管')
            return send(res, 200, { ok: true })
          case 'stop':
            cfg.enabled = false
            saveConfig(cfg)
            engine.log('GUI：暂停托管')
            return send(res, 200, { ok: true })
          case 'dry':
            cfg.dry = !!body.value
            engine.log('GUI：' + (cfg.dry ? '切换到演练模式' : '切换到真实提交'))
            return send(res, 200, { ok: true })
          case 'once':
            engine.log('GUI：手动巡视一次')
            // 正在巡视时不要去撞车（会和定时巡视抢 rev，产生 409），
            // 只标记「尽快醒来」；空闲时会立刻打断等待。
            if (engine.busy) return send(res, 200, { ok: true, msg: '正在巡视，本轮结束后会立刻再来一轮' })
            if (engine.running) { engine.requestTick(); return send(res, 200, { ok: true, msg: '已唤醒，马上开始' }) }
            engine.tick().catch((e) => engine.log('手动巡视出错：' + e.message, 'err'))
            return send(res, 200, { ok: true })
          case 'exit':
            engine.log('GUI：退出程序')
            setTimeout(() => process.exit(0), 300)
            return send(res, 200, { ok: true })
          case 'restart': {
            // 改了代码必须重启进程才生效。这里直接「换一个自己」：
            // 先把回包发出去，再 spawn 一个脱离的新进程，然后自己退出。
            // 不用 Native Messaging，省掉端口时序与宿主是否安装的干扰。
            engine.log('GUI：重启主程序（加载最新代码）')
            send(res, 200, { ok: true, msg: '正在重启，3 秒后自动重连' })
            const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
            const main = resolve(root, 'yuyugu2.mjs')
            // 带上原来的启动参数，但去掉会让新进程只跑一轮就退出的 --once
            const args = process.argv.slice(2).filter((a) => a !== '--once')

            // 新进程起不来时不能「老的已经退了、新的也没了」——2026-11-13 00:21
            // 就是这样：新进程加载规则模块时 fetch failed 直接退出，旧进程 500ms
            // 后也已经自杀，托管彻底停了 10 分钟（GUI 只提示「20 秒内没连上」）。
            // 现在的做法：交棒后盯着端口，新进程没接过去就把自己重新监听、继续跑旧代码。
            const revive = () => {
              try {
                // close() 之后 Server 对象可以重新 listen（同一闭包里的 server 引用仍然有效，
                // 这样下一次「重启」点下去关掉的也还是这个对象）
                server.listen(port, '127.0.0.1', () => {
                  engine.log(`重启失败，旧进程已恢复监听：http://127.0.0.1:${port}`, 'err')
                })
              } catch (e) {
                engine.log('旧进程重新监听失败：' + e.message, 'err')
                process.exit(1)
              }
            }
            const handoff = () => {
              let child = null
              try {
                // 本地日期：toISOString 是 UTC，北京时间 0–8 点会写成前一天
                const out = openSync(resolve(root, 'logs', `host-${new Date().toLocaleDateString('sv-SE')}.log`), 'a')
                child = spawn(process.execPath, [main, ...args], {
                  cwd: root, detached: true, stdio: ['ignore', out, out], windowsHide: true,
                })
                child.unref()
                writeFileSync(resolve(root, 'logs', 'yuyugu.pid'), String(child.pid), 'utf8')
              } catch (e) {
                engine.log('重启失败：' + e.message, 'err')
                return revive()
              }
              // 等新进程把端口接过去。规则模块联网失败现在会退回缓存（见 core/rules.mjs），
              // 但世界状态拉取失败之类的启动错误仍可能让子进程退出，所以这里必须盯着。
              const t0 = Date.now()
              const check = async () => {
                if (await portUp(port)) return process.exit(0)   // 交棒成功
                if (child.exitCode !== null || child.signalCode !== null) {
                  engine.log('重启失败：新进程启动后退出（见 logs/host-*.log），旧进程继续运行', 'err')
                  return revive()
                }
                if (Date.now() - t0 > 30000) {
                  engine.log('重启失败：新进程 30 秒内没接管端口，旧进程继续运行', 'err')
                  try { process.kill(child.pid) } catch {}
                  return revive()
                }
                setTimeout(check, 400)
              }
              setTimeout(check, 400)
            }

            // 必须等回包真正写出去再退出，否则 GUI 看到的是「连接被重置」，
            // 分不清是重启成功还是崩溃了。
            setTimeout(() => {
              // 先放开端口，让新进程能立刻 bind —— 否则它会撞 EADDRINUSE。
              // closeAllConnections 让 close 回调立刻触发，不然 GUI 的 keep-alive 会拖住交棒。
              try { server.closeAllConnections?.() } catch {}
              try { server.close(handoff) } catch { handoff() }
            }, 500)
            return
          }
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
      if (path === '/api/ping') return send(res, 200, { ok: true, name: 'yuyugu', version: VERSION })

      return send(res, 404, { error: '未知路径：' + path })
    } catch (e) {
      return send(res, 500, { error: e.message })
    }
  })

  // listen 可能因为「上一个进程刚重启、端口还在 TIME_WAIT」而失败，
  // 重试几次再放弃。第一次失败不打印，避免重启时日志里出现吓人的报错。
  let tries = 0
  const tryListen = () => {
    server.listen(port, '127.0.0.1', () => {
      engine.log(`本地服务已启动：http://127.0.0.1:${port}`)
    })
  }
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries++ < 5) {
      setTimeout(tryListen, 300)
      return
    }
    engine.log(`本地服务启动失败：${e.message}`, 'err')
    // 端口被别人占着还继续托管 = 两个实例同时提交动作，世界状态会互相覆盖
    // （实测一次重启留下两个进程，日志里两条「托管启动」，动作重复提交）。
    // 宁可这次不跑，也不能双写。
    try { engine.savePersist?.() } catch {}
    engine.log('已退出：同一个端口只允许一个托管实例（用 --port= 换端口，或先停掉旧进程）', 'err')
    process.exit(1)
  })
  tryListen()
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
