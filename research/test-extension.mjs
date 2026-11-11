// 在真实浏览器里加载插件，注入登录 cookie，用演练模式跑一轮，读回插件存储里的状态和日志。
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.LOCALAPPDATA + '/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core')
const ext = path.resolve('extension'), channel = process.argv[2] || 'msedge', patch = JSON.parse(process.argv[3] || '{"enabled":true,"dry":true}')
const sid = readFileSync('../messages/cookie.txt', 'utf8').trim().replace(/^sid=/, '')
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'yyg-')), { channel, headless: false, args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`] })
await ctx.addCookies([{ name: 'sid', value: sid, domain: '52dmeme.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }])
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null)
if (!sw) { console.log('插件没有加载（该浏览器不支持 --load-extension）'); await ctx.close(); process.exit(3) }
console.log('插件已加载', sw.url())
const page = await ctx.newPage()
page.on('console', (m) => { if (/鱼鱼谷|yyg|Error/i.test(m.text())) console.log('  [page]', m.text().slice(0, 300)) })
page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
await page.goto('https://52dmeme.com/pets', { waitUntil: 'domcontentloaded' })
await sw.evaluate((cfg) => chrome.storage.local.set({ cfg }), patch)
const wait = Number(process.argv[4] || 25)
await new Promise((ok) => setTimeout(ok, wait * 1000))
const st = await sw.evaluate(() => chrome.storage.local.get(['status', 'logs', 'cfg', 'keepTab']))
console.log('status', JSON.stringify(st.status))
console.log('logs:\n' + (st.logs || []).map((l) => '  ' + l.slice(0, 260)).join('\n'))
console.log('badge', await sw.evaluate(() => chrome.action.getBadgeText({})))
// 弹窗页面能否正常渲染
const pop = await ctx.newPage()
pop.on('pageerror', (e) => console.log('  [popup error]', e.message))
await pop.goto(sw.url().replace('background.js', 'popup.html'))
await pop.waitForTimeout(1500)
console.log('popup state:', await pop.locator('#state').innerText(), '| stats:', (await pop.locator('#tab-home').innerText()).replace(/\n/g, ' ').slice(0, 300))
await pop.setViewportSize({ width: 444, height: 700 }); await pop.screenshot({ path: 'research/popup.png', fullPage: true }); await pop.click('[data-tab=settings]'); await pop.screenshot({ path: 'research/popup-settings.png', fullPage: true }); await pop.click('[data-tab=logs]'); await pop.screenshot({ path: 'research/popup-logs.png', fullPage: true })
await sw.evaluate(() => chrome.storage.local.set({ cfg: { enabled: false } }))
await ctx.close()
