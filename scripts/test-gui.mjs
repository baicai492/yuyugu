// 在真实浏览器里加载 GUI 插件，检查 popup 是否正常渲染、能否连上本地服务。
// 用法：node scripts/test-gui.mjs [chromium|msedge] [端口]
import { createRequire } from 'node:module'
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXT = path.join(ROOT, 'gui')
const channel = process.argv[2] || 'msedge'
const port = Number(process.argv[3]) || 8787

function findPlaywright() {
  const candidates = [
    'playwright-core',
    'playwright',
    path.join(process.env.LOCALAPPDATA || '', 'npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright'),
    path.join(process.env.APPDATA || '', 'npm/node_modules/playwright-core'),
  ]
  for (const c of candidates) {
    try { return require(c) } catch {}
  }
  throw new Error('找不到 playwright')
}

const { chromium } = findPlaywright()

// 临时 profile 放项目里（不写 C 盘），跑完在 finally 里删掉
const profile = mkdtempSync(path.join(ROOT, '.tmp-gui-'))
let ctx
try {
  ctx = await chromium.launchPersistentContext(profile, {
    channel,
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  })
  console.log('浏览器已启动（' + channel + '）')

  // 拿到扩展 ID
  let id = null
  for (let i = 0; i < 40 && !id; i++) {
    const workers = ctx.serviceWorkers()
    if (workers.length) {
      const m = /chrome-extension:\/\/([a-z]+)/.exec(workers[0].url())
      id = m?.[1]
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!id) {
    const pages = ctx.pages()
    for (const p of pages) {
      const m = /chrome-extension:\/\/([a-z]+)/.exec(p.url())
      if (m) { id = m[1]; break }
    }
  }
  if (!id) throw new Error('拿不到扩展 ID，插件可能加载失败')
  console.log('扩展 ID：' + id)

  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })

  await page.setViewportSize({ width: 444, height: 720 })
  await page.goto(`chrome-extension://${id}/popup.html`)
  await page.waitForTimeout(3500)
  // 非默认端口（比如指向假服务做 UI 自测）时，先写进 storage 再重新加载
  if (port !== 8787) {
    await page.evaluate((p) => chrome.storage.local.set({ port: p }), port)
    await page.reload()
    await page.waitForTimeout(3500)
  }

  // 读关键元素
  const probe = await page.evaluate(() => ({
    title: document.querySelector('h1')?.textContent,
    state: document.getElementById('linkState')?.textContent,
    dot: document.getElementById('dot')?.className,
    connHidden: document.getElementById('connBox')?.hidden,
    coins: document.getElementById('coins')?.textContent,
    isleTime: document.getElementById('isleTime')?.textContent,
    energy: document.getElementById('energy')?.textContent,
    scale: document.getElementById('scale')?.textContent,
    quotaCount: document.getElementById('quotas')?.children.length,
    statusLine: document.getElementById('statusline')?.textContent,
    tabs: [...document.querySelectorAll('nav.tabs button')].map((b) => b.textContent),
    dayNet: document.getElementById('dayNet')?.textContent,
  }))
  console.log('\n=== 概览页 ===')
  console.log(JSON.stringify(probe, null, 2))

  // 切到市场页
  await page.click('button[data-tab="market"]')
  await page.waitForTimeout(2500)
  const marketProbe = await page.evaluate(() => ({
    forecastCards: document.getElementById('mForecast')?.children.length,
    rows: document.querySelectorAll('#mTable tbody tr').length,
    firstRow: [...(document.querySelectorAll('#mTable tbody tr')[0]?.children || [])].map((td) => td.textContent),
  }))
  console.log('\n=== 市场页 ===')
  console.log(JSON.stringify(marketProbe, null, 2))

  // 切到修仙页
  await page.click('button[data-tab="xian"]')
  await page.waitForTimeout(2500)
  const xianProbe = await page.evaluate(() => {
    const txt = (id) => document.getElementById(id)?.textContent
    const count = (id) => document.querySelectorAll(`#${id} > *`).length
    return {
      realm: txt('xRealm'), stone: txt('xStone'), plotDetail: txt('xPlotDetail'),
      combatRows: count('xCombat'), rootsRows: count('xRoots'),
      stages: count('xStages'), npc: count('xNpc'), recipes: count('xRecipes'),
      crops: count('xCrops'),
      cropsText: txt('xCrops'),
      // 资源统计：材料 / 累计 / 每日 / 首通都要有值（主程序提供 detail.mats、history、daily）
      assets: txt('xAssets'), assetMats: txt('xAssetMats'), assetHist: txt('xAssetHist'),
      assetDaily: txt('xAssetDaily'), assetClears: txt('xAssetClears'),
      assetMatsHint: document.getElementById('xAssetMats')?.title,
      assetDailyHint: document.getElementById('xAssetDaily')?.title,
      // 2.0：宗门贡献 + 委托内容（悬停）
      sect2: txt('x2Sect'), tasks2: txt('x2Tasks'), tasks2Hint: document.getElementById('x2Tasks')?.title,
      combat: txt('xCombat'),
      slotRow: [...document.querySelectorAll('#xCombat .card-row')]
        .map((r) => r.textContent).find((t) => t.startsWith('技能槽')) || null,
      slotHint: [...document.querySelectorAll('#xCombat .card-row')]
        .find((r) => r.textContent.startsWith('技能槽'))?.title || null,
      rootsText: txt('xRoots'),
      stagesText: [...(document.querySelectorAll('#xStages > *') || [])].map((e) => e.textContent),
      npcFirst: document.querySelector('#xNpc > *')?.textContent,
      recipesText: [...(document.querySelectorAll('#xRecipes > *') || [])].map((e) => e.textContent),
    }
  })
  console.log('\n=== 修仙页 ===')
  console.log(JSON.stringify(xianProbe, null, 2))
  await page.screenshot({ path: path.join(ROOT, 'research', 'gui-xian.png'), fullPage: true })

  // 人脉列表的滚动位置必须能保持住：每一轮 1.5 秒的轮询都会重渲染，
  // 以前每次 replaceChildren 都把 scrollTop 打回 0，表现就是「一下拉就锁回去」。
  const scrollProbe = await page.evaluate(async () => {
    const list = document.querySelector('#xNpc > .xlist')
    if (!list) return { ok: false, reason: '找不到人脉列表' }
    const before = { h: list.scrollHeight, vh: list.clientHeight }
    list.scrollTop = 80
    const set = list.scrollTop
    // 等两轮自动刷新（1.5s × 2）
    await new Promise((r) => setTimeout(r, 3400))
    const after = document.querySelector('#xNpc > .xlist')?.scrollTop
    return { ok: after >= 60, set, after, ...before }
  })
  console.log('\n=== 人脉列表滚动保持 ===')
  console.log(JSON.stringify(scrollProbe, null, 2))

  // 切到设置页
  await page.click('button[data-tab="settings"]')
  await page.waitForTimeout(1500)
  const settingsProbe = await page.evaluate(() => ({
    groups: document.querySelectorAll('#settings .grp').length,
    fields: document.querySelectorAll('#settings .field').length,
    titles: [...document.querySelectorAll('#settings .grp h3')].map((h) => h.textContent),
  }))
  console.log('\n=== 设置页 ===')
  console.log(JSON.stringify(settingsProbe, null, 2))

  // 切到日志页
  await page.click('button[data-tab="logs"]')
  await page.waitForTimeout(1500)
  const logProbe = await page.evaluate(() => ({
    lines: document.getElementById('logs')?.children.length,
    last: document.getElementById('logs')?.lastChild?.textContent?.slice(0, 120),
  }))
  console.log('\n=== 日志页 ===')
  console.log(JSON.stringify(logProbe, null, 2))

  await page.screenshot({ path: path.join(ROOT, 'research', 'gui-overview.png') })
  await page.click('button[data-tab="market"]')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(ROOT, 'research', 'gui-market.png') })

  console.log('\n=== 错误 ===')
  console.log(errors.length ? errors.join('\n') : '（无）')
} catch (e) {
  console.error('\n测试失败：' + e.message)
  if (process.env.DEBUG) console.error(e.stack)
  process.exitCode = 1
} finally {
  await ctx?.close()
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
