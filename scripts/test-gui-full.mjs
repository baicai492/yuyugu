// 完整 GUI 测试：从「主程序未运行」开始，点按钮拉起，再验证四个页面。
// 用法：node scripts/test-gui-full.mjs [msedge|chromium]
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXT = path.join(ROOT, 'gui')
const channel = process.argv[2] || 'msedge'

const candidates = [
  'playwright-core', 'playwright',
  path.join(process.env.LOCALAPPDATA || '', 'npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright'),
]
let pw = null
for (const c of candidates) { try { pw = require(c); break } catch {} }
if (!pw) throw new Error('找不到 playwright')

const profile = mkdtempSync(path.join(tmpdir(), 'yyg-full-'))
let ctx
const log = (...a) => console.log(...a)

try {
  ctx = await pw.chromium.launchPersistentContext(profile, {
    channel, headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  })
  let id = null
  for (let i = 0; i < 40 && !id; i++) {
    for (const w of ctx.serviceWorkers()) {
      const m = /chrome-extension:\/\/([a-z]+)/.exec(w.url()); if (m) { id = m[1]; break }
    }
    if (!id) await new Promise((r) => setTimeout(r, 500))
  }
  if (!id) throw new Error('拿不到扩展 ID')
  log('扩展 ID：' + id)

  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

  await page.setViewportSize({ width: 444, height: 760 })
  await page.goto(`chrome-extension://${id}/popup.html`)
  await page.waitForTimeout(3000)

  // ---------- 1. 初始：应显示未连接 + 启动按钮 ----------
  let s = await page.evaluate(() => ({
    connVisible: !document.getElementById('connBox').hidden,
    linkState: document.getElementById('linkState').textContent,
    hasLaunchBtn: !!document.getElementById('btnLaunch'),
  }))
  log('\n[1] 初始状态（主程序未运行）')
  log(JSON.stringify(s))

  // ---------- 2. 点「启动主程序」（主程序已在跑就跳过） ----------
  if (s.connVisible) {
    log('\n[2] 点击「启动主程序」…')
    await page.click('#btnLaunch')
    // 最多等 20 秒
    let launched = false
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(500)
      const st = await page.evaluate(() => ({
        connVisible: !document.getElementById('connBox').hidden,
        hint: document.getElementById('launchHint')?.textContent || '',
        linkState: document.getElementById('linkState')?.textContent || '',
      }))
      if (!st.connVisible) { launched = true; log('  ✓ 已连接：' + st.linkState); break }
      if (i % 6 === 5) log('  … ' + (st.hint || '等待中'))
    }
    if (!launched) {
      const hint = await page.evaluate(() => document.getElementById('launchHint')?.textContent)
      log('  ✗ 未能启动：' + hint)
    }
  } else {
    log('\n[2] 主程序已在运行，跳过启动步骤（状态：' + s.linkState + '）')
  }

  // ---------- 3. 概览 ----------
  await page.waitForTimeout(2000)
  s = await page.evaluate(() => ({
    coins: document.getElementById('coins')?.textContent,
    isleTime: document.getElementById('isleTime')?.textContent,
    energy: document.getElementById('energy')?.textContent,
    quotas: document.getElementById('quotas')?.children.length,
    dayNet: document.getElementById('dayNet')?.textContent,
    dayNetSub: document.getElementById('dayNetSub')?.textContent,
    statusLine: document.getElementById('statusline')?.textContent,
    linkState: document.getElementById('linkState')?.textContent,
    earn: document.getElementById('earn')?.textContent,
    spend: document.getElementById('spend')?.textContent,
  }))
  log('\n[3] 概览页')
  log(JSON.stringify(s, null, 2))
  // 「已暂停」只在总开关关掉时才该出现；开关开着时应是「巡视中/托管中」
  log('  状态标签：' + (s.linkState === '已暂停' ? '✗ 开关开着却显示已暂停' : '✓ ' + s.linkState))

  // ---------- 4. 市场页 ----------
  await page.click('button[data-tab="market"]')
  await page.waitForTimeout(2500)
  s = await page.evaluate(() => ({
    forecastCards: document.getElementById('mForecast')?.children.length,
    rows: document.querySelectorAll('#mTable tbody tr').length,
    first: [...(document.querySelectorAll('#mTable tbody tr')[0]?.children || [])].map((x) => x.textContent),
  }))
  log('\n[4] 市场页')
  log(JSON.stringify(s, null, 2))
  await page.screenshot({ path: path.join(ROOT, 'research', 'gui-market.png') })

  // ---------- 5. 设置页 ----------
  await page.click('button[data-tab="settings"]')
  await page.waitForTimeout(1500)
  s = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('#settings .grp')]
    return {
      groups: groups.length,
      fields: document.querySelectorAll('#settings .field').length,
      // 标签必须全是中文，不能出现 enabled / maxPaybackDays 这种英文键名
      titles: groups.map((g) => g.querySelector('h3')?.textContent),
      labels: groups.flatMap((g) => [...g.querySelectorAll('.field label')].map((x) => x.textContent)),
      hints: document.querySelectorAll('#settings .field-hint').length,
      hasStealGroup: groups.some((g) => /偷菜/.test(g.querySelector('h3')?.textContent || '')),
    }
  })
  log('\n[5] 设置页')
  log(JSON.stringify(s, null, 2))
  const badLabels = s.labels.filter((x) => /^[A-Za-z][A-Za-z0-9.]*$/.test(x))
  log('  中文标签：' + (badLabels.length ? '✗ 还有英文 ' + badLabels.join(', ') : '✓ 全部中文'))
  log('  偷菜设置：' + (s.hasStealGroup ? '✓ 有独立分组' : '✗ 找不到'))
  await page.screenshot({ path: path.join(ROOT, 'research', 'gui-settings.png'), fullPage: true })

  // ---------- 6. 日志页：本次 + 历史 ----------
  await page.click('button[data-tab="logs"]')
  await page.waitForTimeout(1200)
  const nowLines = await page.evaluate(() => document.getElementById('logs')?.children.length)
  log('\n[6] 日志页 · 本次运行：' + nowLines + ' 行')

  await page.click('#logModeHist')
  await page.waitForTimeout(2500)
  s = await page.evaluate(() => ({
    histBarVisible: !document.getElementById('histBar').hidden,
    info: document.getElementById('histInfo')?.textContent,
    lines: document.getElementById('logs')?.children.length,
    sample: [...document.querySelectorAll('#logs > div')].slice(-2).map((d) => d.textContent.slice(0, 70)),
  }))
  log('[6] 日志页 · 历史记录')
  log(JSON.stringify(s, null, 2))
  await page.screenshot({ path: path.join(ROOT, 'research', 'gui-logs.png') })

  log('\n[7] JS 错误：' + (errors.length ? '\n  ' + errors.join('\n  ') : '（无）'))
} catch (e) {
  console.error('测试失败：' + e.message)
  if (process.env.DEBUG) console.error(e.stack)
  process.exitCode = 1
} finally {
  await ctx?.close()
}
