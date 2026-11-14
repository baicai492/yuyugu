// 单实例锁：保证同一时刻只有一个进程在巡视小岛。
//
// 为什么需要：GUI 的「重启」是「先 spawn 新进程、再关端口退出旧进程」。
// 新进程起来后会立刻 run()，而旧进程可能还在 tick 里（擂台 30 场要 4 分钟，
// 一次偷菜要 30 秒）。两边同时发 world/act，会用同一个 rev 重复提交：
// 轻则 409 白跑，重则同一笔卖出/买入执行两次，账本和存档互相覆盖。
//
// 做法：tick 开始时写 data/daemon.lock（pid + 时刻），结束时删掉。
// 另一个进程看到锁会被「跳过本轮」——它只是晚几秒，不会有两份写入。
// 崩溃留下的死锁按 pid 是否存活回收（Windows 上 process.kill(pid,0) 同样可用）。
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

/** 进程是否还活着（不发送任何信号） */
export function isPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isSafeInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    // EPERM：进程存在但没权限（不该发生，但按活着处理更安全）
    return e?.code === 'EPERM'
  }
}

/** 读锁；文件不存在/损坏都返回 null */
export function readLock(file) {
  try {
    if (!existsSync(file)) return null
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (!j || !Number.isSafeInteger(Number(j.pid))) return null
    return { pid: Number(j.pid), at: Number(j.at) || 0 }
  } catch { return null }
}

/**
 * 尝试拿锁。
 * @returns {{ok:boolean, holder?:{pid:number,at:number}, reclaimed?:boolean}}
 *   ok=false 时 holder 是仍活着的占用者
 */
export function acquireLock(file, { now = Math.floor(Date.now() / 1000) } = {}) {
  try { mkdirSync(dirname(file), { recursive: true }) } catch {}
  const cur = readLock(file)
  if (cur && cur.pid !== process.pid && isPidAlive(cur.pid)) {
    return { ok: false, holder: cur }
  }
  const reclaimed = Boolean(cur && cur.pid !== process.pid)
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: now }), 'utf8')
    return { ok: true, reclaimed }
  } catch (e) {
    return { ok: false, holder: cur || { pid: 0, at: 0 }, error: e.message }
  }
}

/** 释放锁（只删自己的） */
export function releaseLock(file) {
  try {
    const cur = readLock(file)
    if (cur && cur.pid === process.pid) unlinkSync(file)
  } catch {}
}

export function defaultLockPath(logDir) {
  return resolve(logDir || '.', 'daemon.lock')
}
