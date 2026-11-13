// 52dmeme 的登录会话。cookie 文件里就是一行 `sid=...`。
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..')

// 默认读项目根目录的 cookie.txt（不进 git，见 .gitignore）。
// 以前默认是仓库外的 ../messages/cookie.txt，项目搬走或单独拷给别人就跑不起来。
export function readSession(file = process.env.YYG_COOKIE || resolve(ROOT, 'cookie.txt')) {
  if (!existsSync(file)) throw new Error(`找不到 cookie 文件：${file}`)
  const raw = readFileSync(file, 'utf8').trim()
  if (!raw) throw new Error('cookie 文件是空的')
  // 允许整行 cookie、也允许只填 sid 的值
  const cookie = /(^|;\s*)sid=/.test(raw) ? raw : `sid=${raw}`
  const sid = /sid=([0-9a-f]+)/.exec(cookie)?.[1]
  if (!sid) throw new Error('cookie 里没有 sid')
  return { cookie, sid, file }
}
