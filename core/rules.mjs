// 规则模块加载：直接 import 站点线上那一份 pet-world-rules.js。
// 这是本项目的核心设计——结算公式、价格公式、五子棋 AI 全部逐字一致，不移植、不抄写。
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..')
const CACHE_DIR = resolve(ROOT, 'cache')

let R = null, currentVer = '', loadedAt = 0
// 当前加载的规则文件内容 hash。站点有可能「悄悄改公式但不换版本号」——
// 只比版本号会一直用旧公式且不报错，所以再按内容 hash 兜一层。
let contentHash = ''
// 上次整份下载做 hash 比对的时间（ms）。版本号没变时每 6 小时才重下一次。
let lastContentCheck = 0
// 游乐馆（弹弹乐 / 鲸鱼桌球 / 鲸鱼保龄）是**独立的** /arcade-rules.js，
// 不在 pet-world-rules.js 的导出里（b12ExtraAction 只是内部调用了同一份代码）。
// 所以这里单独缓存、单独热替换，和主规则同版本号。
let ARC = null, arcVer = ''

const sha1 = (text) => createHash('sha1').update(text).digest('hex')

/** 从站点页面里取当前版本号（app.js?v=xxxx / pets.js?v=xxxx） */
export async function fetchVersion(baseUrl, cookie, { timeoutMs = 15000, tries = 2 } = {}) {
  let lastErr = null
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(baseUrl + '/pets', {
        headers: { cookie, 'user-agent': 'Mozilla/5.0 Chrome/131', referer: baseUrl + '/pets' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await res.text()
      return /pets\.js\?v=([0-9a-f]+)/.exec(text)?.[1] || /app\.js\?v=([0-9a-f]+)/.exec(text)?.[1] || ''
    } catch (e) {
      lastErr = e
      // 第二次尝试前等一秒：站点偶发抽风时，一次 15 秒超时后直接重试往往就通了
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw lastErr
}

/** 找缓存里最新的一份规则文件（离线可用，避免每次都要联网） */
export function cachedRulesFile() {
  if (!existsSync(CACHE_DIR)) return null
  const files = readdirSync(CACHE_DIR).filter((f) => /^rules-[0-9a-f]+\.mjs$/.test(f))
    .map((f) => ({ f, t: statSync(resolve(CACHE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return files.length ? resolve(CACHE_DIR, files[0].f) : null
}

/** 找缓存里最新的一份游乐馆规则文件 */
export function cachedArcadeFile() {
  if (!existsSync(CACHE_DIR)) return null
  const files = readdirSync(CACHE_DIR).filter((f) => /^arcade-[0-9a-f]+\.mjs$/.test(f))
    .map((f) => ({ f, t: statSync(resolve(CACHE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return files.length ? resolve(CACHE_DIR, files[0].f) : null
}

/** 游乐馆规则（离线缓存优先），拿不到就返回 null —— 游乐馆接入不应拖垮主程序 */
export async function loadArcadeRulesCached() {
  if (ARC) return ARC
  const file = cachedArcadeFile()
  if (!file) return null
  const mod = await import(pathToFileURL(file).href)
  if (typeof mod.replay !== 'function' || typeof mod.arcAct !== 'function') return null
  ARC = mod
  arcVer = /arcade-([0-9a-f]+)\.mjs/.exec(file)?.[1] || 'cached'
  return ARC
}

/** 下载/热更新游乐馆规则。失败不抛：调用方拿不到就跳过游乐馆 */
export async function loadArcadeRules({ baseUrl = 'https://52dmeme.com', ver, force = false } = {}) {
  const v = ver || currentVer
  if (!v) return loadArcadeRulesCached()
  if (ARC && arcVer === v && !force) return ARC
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  const file = resolve(CACHE_DIR, `arcade-${v}.mjs`)
  const stale = !existsSync(file) || Date.now() - statSync(file).mtimeMs > 3600_000
  if (stale) {
    try {
      const res = await fetch(`${baseUrl}/arcade-rules.js?v=${v}`, {
        headers: { 'user-agent': 'Mozilla/5.0 Chrome/131', referer: baseUrl + '/pets' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      if (!text.includes('export function replay')) throw new Error('游乐馆规则结构变了（缺少 replay）')
      writeFileSync(file, text, 'utf8')
    } catch {
      return loadArcadeRulesCached()
    }
  }
  const mod = await import(pathToFileURL(file).href + '?t=' + Date.now())
  if (typeof mod.replay !== 'function') throw new Error('游乐馆规则缺少 replay')
  ARC = mod; arcVer = v
  return ARC
}

export const arcadeRules = () => ARC
export const arcadeVersion = () => arcVer

/** 用缓存里的规则文件初始化（不联网） */
export async function loadRulesCached() {
  if (R) return R
  const file = cachedRulesFile()
  if (!file) throw new Error('本地没有缓存的规则模块，请先联网运行一次')
  const mod = await import(pathToFileURL(file).href)
  if (typeof mod.applyActions !== 'function') throw new Error('缓存的规则模块缺少 applyActions')
  R = mod
  currentVer = /rules-([0-9a-f]+)\.mjs/.exec(file)?.[1] || 'cached'
  loadedAt = statSync(file).mtimeMs
  try { contentHash = sha1(readFileSync(file, 'utf8')) } catch {}
  await loadArcadeRulesCached()
  return R
}


/**
 * 用缓存兜底：网络抖动 / 站点抽风时不该让主程序起不来。
 * 规则模块自 63568b46 起内容未变，缓存与线上是同一份。
 */
async function useCacheOrThrow(reason) {
  const cached = await loadRulesCached().catch(() => null)
  if (cached) {
    // 用 stderr 而不是日志文件：此时 Engine 还没建好
    console.warn(`规则模块联网失败（${reason}），先用本地缓存 rules-${currentVer}.mjs 启动；下次巡检会重新检查`)
    return cached
  }
  throw new Error(reason + '，且本地没有缓存的规则模块（需要先联网成功运行一次）')
}

/** 下载指定版本的规则模块到 cache/ 并 import 它 */
export async function loadRules({ baseUrl = 'https://52dmeme.com', ver, cookie, force = false } = {}) {
  let v = ver || ''
  if (!v) {
    // 取不到版本号（没 cookie / 网络不通）时退回缓存。
    // 以前这里只处理「拿到空字符串」，fetch 抛错（超时、DNS、连接被重置）会直接
    // 冒到 main().catch 让进程退出——2026-11-13 00:21 就是这样：GUI 点重启，
    // 新进程拿版本号时 fetch failed，自己退了，旧进程也早就退出了，托管控了 10 分钟。
    try {
      v = await fetchVersion(baseUrl, cookie || '')
    } catch (e) {
      return useCacheOrThrow(`取站点版本号失败：${e.message}`)
    }
  }
  if (!v) return useCacheOrThrow('取不到站点版本号')
  if (R && currentVer === v && !force) return R

  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  const file = resolve(CACHE_DIR, `rules-${v}.mjs`)
  // 缓存超过 1 小时就重新拉，避免站点悄悄改内容而不换版本号
  const stale = !existsSync(file) || Date.now() - statSync(file).mtimeMs > 3600_000
  if (stale) {
    let text
    try {
      const res = await fetch(`${baseUrl}/pet-world-rules.js?v=${v}`, {
        headers: { 'user-agent': 'Mozilla/5.0 Chrome/131', referer: baseUrl + '/pets' },
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      text = await res.text()
    } catch (e) {
      return useCacheOrThrow(`下载规则模块失败：${e.message}`)
    }
    if (!text.includes('export function applyActions')) throw new Error('规则模块结构变了（缺少 applyActions），需要人工确认')
    writeFileSync(file, text, 'utf8')
    lastContentCheck = Date.now()
  }
  const mod = await import(pathToFileURL(file).href + '?t=' + Date.now())
  if (typeof mod.applyActions !== 'function') throw new Error('规则模块缺少 applyActions')
  R = mod; currentVer = v; loadedAt = Date.now()
  try { contentHash = sha1(readFileSync(file, 'utf8')) } catch {}
  // 游乐馆是独立文件；拉不到不影响主流程，缓存里有旧版就先用旧版
  await loadArcadeRules({ baseUrl, ver: v }).catch(() => null)
  return R
}

export const rules = () => R
export const rulesVersion = () => currentVer
export const rulesLoadedAt = () => loadedAt
export const rulesContentHash = () => contentHash

/** 用规则模块初始化长夜时钟（每次拿到服务端 clockStart 都要调用） */
export function configureClock(clockStart) {
  if (!R) throw new Error('规则模块尚未加载')
  if (R.b12ClockStart() === clockStart) return
  R.b12ConfigureClock(clockStart)
}

/**
 * 运行时检查站点规则是否换了版本，变了就重新下载并热替换。
 *
 * 之前 `loadRules` 只在进程启动时调一次，站点夜里更新规则后，
 * 运行中的进程会一直用旧规则算到下次重启为止——而中间可能隔好几天。
 * 后果不是报错，而是「悄悄用错的公式做决策」：
 * 季节判错、价格算错、五子棋 AI 版本对不上，全都不报错，只是收益变低。
 * （今天排查时也踩过类似的坑：本地 cropStage 判番茄枯萎、服务端却允许收获。）
 *
 * 版本号没变也不敢信：站点完全可以改了公式却不换 ?v=。所以每
 * contentIntervalMs（默认 6 小时）把整份规则（~117KB）重下一次比对内容 hash，
 * 变了就同名覆盖缓存并热替换，返回 sameVersion=true 让上层提示。
 *
 * 返回：
 *   { changed, from, to, hash, contentChecked? , sameVersion? }  检查成功
 *   null                                                          取不到版本号/下载失败
 * 注意 null 不等于「没变化」——上层靠它统计连续失败次数并告警。
 * 任何异常都吞掉：规则检查失败不该影响正常托管。
 */
export async function checkRulesUpdate({ baseUrl, cookie, force = false, contentIntervalMs = 6 * 3600_000 } = {}) {
  try {
    const before = currentVer
    const v = await fetchVersion(baseUrl, cookie || '')
    if (!v) return null

    // 版本号变了：整份重下 + 热替换（loadRules 内部会写新文件）
    if (v !== before) {
      // 新模块实例的 b12ClockEpoch 是 0，热替换后必须立刻补喂 clockStart，
      // 否则 isleIndex/seasonOf 会全部算错（本地以为秋天、服务端还是夏天）。
      const epoch = R?.b12ClockStart?.() || 0
      await loadRules({ baseUrl, ver: v, cookie, force: true })
      if (epoch && R?.b12ConfigureClock) {
        try { R.b12ConfigureClock(epoch) } catch {}
      }
      await loadArcadeRules({ baseUrl, ver: currentVer, force: true }).catch(() => null)
      return { changed: currentVer !== before, from: before, to: currentVer, hash: contentHash }
    }

    // 版本号没变：按低频重下整份内容比对 hash
    if (!force && Date.now() - lastContentCheck < contentIntervalMs) {
      return { changed: false, from: before, to: v, hash: contentHash, contentChecked: false }
    }
    let text
    try {
      const res = await fetch(`${baseUrl}/pet-world-rules.js?v=${v}`, {
        headers: { 'user-agent': 'Mozilla/5.0 Chrome/131', referer: baseUrl + '/pets' },
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      text = await res.text()
    } catch {
      return null
    }
    lastContentCheck = Date.now()
    if (!text.includes('export function applyActions')) return null
    const h = sha1(text)
    if (!contentHash || h === contentHash) {
      return { changed: false, from: before, to: v, hash: contentHash || h, contentChecked: true }
    }

    // 同版本号、内容变了：同名覆盖缓存后热替换。
    // loadRules 看到文件刚写过（不到 1 小时）不会再下载，直接用 ?t= 重新 import。
    const oldHash = contentHash
    writeFileSync(resolve(CACHE_DIR, `rules-${v}.mjs`), text, 'utf8')
    const epoch = R?.b12ClockStart?.() || 0
    await loadRules({ baseUrl, ver: v, cookie, force: true })
    if (epoch && R?.b12ConfigureClock) {
      try { R.b12ConfigureClock(epoch) } catch {}
    }
    return {
      changed: true, sameVersion: true, from: before, to: v,
      hash: contentHash, oldHash,
    }
  } catch {
    return null
  }
}
