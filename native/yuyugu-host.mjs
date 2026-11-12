#!/usr/bin/env node
// Chrome Native Messaging 宿主：由浏览器在需要时拉起，负责启动/停止 Node 主程序。
//
// Chrome 的协议：stdin/stdout 上每条消息是「4 字节小端长度 + UTF-8 JSON」。
// 我们支持的请求：
//   { cmd: 'launch', port: 8787 }   → 启动 yuyugu2.mjs（若已运行则直接返回 running）
//   { cmd: 'shutdown' }             → 请求主程序退出
//   { cmd: 'status' }               → 检查是否在跑
//
// 主程序以「分离进程」启动，宿主退出后它继续运行。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, openSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const MAIN = resolve(ROOT, 'yuyugu2.mjs')
const PID_FILE = resolve(ROOT, 'logs', 'yuyugu.pid')

// ---------- Native Messaging 编解码 ----------
function readMessage() {
  return new Promise((resolveMsg, reject) => {
    let buf = Buffer.alloc(0)
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 4) return
      const len = buf.readUInt32LE(0)
      if (buf.length < 4 + len) return
      const body = buf.subarray(4, 4 + len).toString('utf8')
      process.stdin.off('data', onData)
      try { resolveMsg(JSON.parse(body)) } catch (e) { reject(e) }
    }
    process.stdin.on('data', onData)
    process.stdin.on('end', () => resolveMsg(null))
  })
}

function sendMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(json.length, 0)
  process.stdout.write(Buffer.concat([head, json]))
}

// ---------- 探活 ----------
function pingPort(port) {
  return new Promise((ok) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => { sock.destroy(); ok(true) })
    sock.on('error', () => ok(false))
    sock.setTimeout(800, () => { sock.destroy(); ok(false) })
  })
}

function readPid() {
  try {
    const n = Number(readFileSync(PID_FILE, 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch { return 0 }
}

function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function launch(port = 8787) {
  if (await pingPort(port)) return { ok: true, state: 'running', msg: '主程序已在运行' }

  // 已经有进程但不响应 → 先杀掉
  const oldPid = readPid()
  if (oldPid && alive(oldPid)) {
    try { process.kill(oldPid) } catch {}
    await new Promise((r) => setTimeout(r, 600))
  }

  if (!existsSync(MAIN)) return { ok: false, msg: '找不到 yuyugu2.mjs：' + MAIN }
  const logDir = resolve(ROOT, 'logs')
  // 用本地日期（toISOString 是 UTC，北京时间 0–8 点会写成前一天，排查时找不到）
  const out = openSync(resolve(logDir, `host-${new Date().toLocaleDateString('sv-SE')}.log`), 'a')

  const child = spawn(process.execPath, [MAIN, `--port=${port}`, '--no-console'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
  child.unref()
  writeFileSync(PID_FILE, String(child.pid), 'utf8')

  // 等它起来（最多 15 秒）
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await pingPort(port)) return { ok: true, state: 'started', pid: child.pid, msg: '主程序已启动' }
    if (!alive(child.pid)) return { ok: false, msg: '主程序启动后立即退出了，请看 logs/host-*.log' }
  }
  return { ok: false, msg: '启动超时（15 秒内端口未就绪）' }
}

async function shutdown(port = 8787) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: 'exit' }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {}
  await new Promise((r) => setTimeout(r, 800))
  const pid = readPid()
  if (pid && alive(pid)) { try { process.kill(pid) } catch {} }
  return { ok: true, msg: '已停止' }
}

async function status(port = 8787) {
  const up = await pingPort(port)
  return { ok: true, state: up ? 'running' : 'stopped', pid: readPid() }
}

// ---------- 主循环 ----------
async function main() {
  // 一次性模式：命令行调用（安装脚本用它验证）
  if (process.argv[2] === '--self-test') {
    const r = await status(Number(process.argv[3]) || 8787)
    console.log(JSON.stringify(r))
    return
  }
  while (true) {
    const msg = await readMessage()
    if (!msg) break
    const port = Number(msg.port) || 8787
    let res
    try {
      if (msg.cmd === 'launch') res = await launch(port)
      else if (msg.cmd === 'shutdown') res = await shutdown(port)
      else if (msg.cmd === 'status') res = await status(port)
      else res = { ok: false, msg: '未知命令：' + msg.cmd }
    } catch (e) {
      res = { ok: false, msg: e.message }
    }
    sendMessage(res)
  }
}

main().catch((e) => {
  try { sendMessage({ ok: false, msg: e.message }) } catch {}
  process.exit(1)
})
