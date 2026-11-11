// 规则模块加载：直接 import 站点线上那一份 pet-world-rules.js。
// 这是本项目的核心设计——结算公式、价格公式、五子棋 AI 全部逐字一致，不移植、不抄写。
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..')
const CACHE_DIR = resolve(ROOT, 'cache')

let R = null, currentVer = '', loadedAt = 0

/** 从站点页面里取当前版本号（app.js?v=xxxx / pets.js?v=xxxx） */
export async function fetchVersion(baseUrl, cookie) {
  const res = await fetch(baseUrl + '/pets', {
    headers: { cookie, 'user-agent': 'Mozilla/5.0 Chrome/131', referer: baseUrl + '/pets' },
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  return /pets\.js\?v=([0-9a-f]+)/.exec(text)?.[1] || /app\.js\?v=([0-9a-f]+)/.exec(text)?.[1] || ''
}

/** 找缓存里最新的一份规则文件（离线可用，避免每次都要联网） */
export function cachedRulesFile() {
  if (!existsSync(CACHE_DIR)) return null
  const files = readdirSync(CACHE_DIR).filter((f) => /^rules-[0-9a-f]+\.mjs$/.test(f))
    .map((f) => ({ f, t: statSync(resolve(CACHE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return files.length ? resolve(CACHE_DIR, files[0].f) : null
}

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
  return R
}

/** 下载指定版本的规则模块到 cache/ 并 import 它 */
export async function loadRules({ baseUrl = 'https://52dmeme.com', ver, cookie, force = false } = {}) {
  const v = ver || await fetchVersion(baseUrl, cookie || '')
  if (!v) {
    // 拿不到版本号（没 cookie / 网络不通）时退回缓存
    const cached = await loadRulesCached().catch(() => null)
    if (cached) return cached
    throw new Error('取不到站点版本号，且本地没有缓存的规则模块')
  }
  if (R && currentVer === v && !force) return R

  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  const file = resolve(CACHE_DIR, `rules-${v}.mjs`)
  // 缓存超过 1 小时就重新拉，避免站点悄悄改内容而不换版本号
  const stale = !existsSync(file) || Date.now() - statSync(file).mtimeMs > 3600_000
  if (stale) {
    const res = await fetch(`${baseUrl}/pet-world-rules.js?v=${v}`, {
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/131', referer: baseUrl + '/pets' },
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`下载规则模块失败：HTTP ${res.status}`)
    const text = await res.text()
    if (!text.includes('export function applyActions')) throw new Error('规则模块结构变了（缺少 applyActions），需要人工确认')
    writeFileSync(file, text, 'utf8')
  }
  const mod = await import(pathToFileURL(file).href + '?t=' + Date.now())
  if (typeof mod.applyActions !== 'function') throw new Error('规则模块缺少 applyActions')
  R = mod; currentVer = v; loadedAt = Date.now()
  return R
}

export const rules = () => R
export const rulesVersion = () => currentVer
export const rulesLoadedAt = () => loadedAt

/** 用规则模块初始化长夜时钟（每次拿到服务端 clockStart 都要调用） */
export function configureClock(clockStart) {
  if (!R) throw new Error('规则模块尚未加载')
  if (R.b12ClockStart() === clockStart) return
  R.b12ConfigureClock(clockStart)
}
