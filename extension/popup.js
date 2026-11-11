import { DEFAULTS, mergeConfig } from './lib/defaults.mjs'

const SITE = 'https://52dmeme.com', STALE_MS = 150 * 1000
const $ = (id) => document.getElementById(id)
const fmt = (n) => Math.round(n).toLocaleString('en-US')
const wan = (n) => (Math.abs(n) >= 10000 ? (n / 10000).toFixed(1) + ' 万' : fmt(n))
const signed = (d) => (d >= 0 ? '+' : '−') + wan(Math.abs(d))
const get = (o, path) => path.split('.').reduce((x, k) => x?.[k], o)
const set = (o, path, v) => { const ks = path.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = x[k] ||= {}; x[ks.at(-1)] = v }
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const SPEND = { on: true, off: false, auto: 'auto' }, spendKey = (v) => (v === true ? 'on' : v === false ? 'off' : 'auto')

let raw = {}, cfg = structuredClone(DEFAULTS), status = null
async function save(patch) {
  for (const [path, v] of Object.entries(patch)) set(raw, path, v)
  cfg = mergeConfig(DEFAULTS, raw)
  await chrome.storage.local.set({ cfg: raw })
  drawConfig(); drawStatus()
}

function drawConfig() {
  $('enabled').checked = !!cfg.enabled
  for (const el of document.querySelectorAll('[data-path]')) {
    const v = get(cfg, el.dataset.path)
    if (el.type === 'checkbox') el.checked = !!v
    else if (el.tagName === 'SELECT') el.value = spendKey(v)
    else if (el.type === 'time') el.value = v
    else if (document.activeElement !== el) el.value = Math.round(v * (Number(el.dataset.scale) || 1) * 100) / 100
  }
}

const STATE = { starting: '启动中…', running: '正在巡视…', sleeping: '托管中', paused: '已暂停', auth: '登录已失效', error: '出错，稍后自动重试' }
const put = (id, text, cls) => { const el = $(id); el.textContent = text; el.className = cls || '' }
function rows(id, list) {
  $(id).replaceChildren(...list.flatMap(([k, v, cls, sum]) => [node('dt', sum ? 'sum' : '', k), node('dd', (cls || '') + (sum ? ' sum' : ''), v)]))
}
function drawStatus() {
  const pill = $('state'), s = status
  const stale = !s?.at || Date.now() - s.at > STALE_MS
  if (stale) {
    pill.textContent = cfg.enabled ? '没有正在运行的站点标签页' + (cfg.autoTab ? '，一分钟内自动打开' : '') : '未开启'
    pill.className = 'pill ' + (cfg.enabled ? 'bad' : 'off')
  } else {
    const left = s.nextAt ? Math.max(0, Math.round((s.nextAt - Date.now()) / 1000)) : 0
    pill.textContent = (STATE[s.state] || s.state) + (cfg.dry && s.state !== 'paused' ? '（演练）' : '') + (s.msg ? '：' + s.msg : '') + (left && s.state !== 'paused' ? ` · ${left >= 60 ? Math.floor(left / 60) + ' 分 ' : ''}${left % 60} 秒后巡视` : '')
    pill.className = 'pill ' + (s.state === 'auth' || s.state === 'error' ? 'bad' : s.state === 'paused' ? 'off' : 'on')
  }
  pill.title = pill.textContent
  if (s?.coins == null) return
  const b = s.book || { earn: 0, spend: 0, tax: 0 }, cash = b.earn - b.spend
  const dc = s.dayStart ? s.coins - s.dayStart.coins : cash, ds = s.dayStart ? (s.stock || 0) - (s.dayStart.stock || 0) : 0, other = dc - cash
  put('net', signed(dc + ds), dc + ds >= 0 ? 'up' : 'down')
  put('net-cash', signed(dc), dc >= 0 ? 'up' : 'down')
  put('net-stock', signed(ds), ds >= 0 ? 'up' : 'down')
  put('coins', wan(s.coins)); $('coins').title = fmt(s.coins)
  put('stock', wan(s.stock || 0)); $('stock').title = fmt(s.stock || 0)
  put('energy', `${s.en} / ${s.enMax}`)
  $('energy-bar').style.width = Math.min(100, (s.en / s.enMax) * 100) + '%'
  const pnl = [['收入（已扣税）', '+' + fmt(b.earn), 'up'], ['支出（种子、进货、投资等）', '−' + fmt(b.spend), 'down'], ['其中卖货税', fmt(b.tax)]]
  if (Math.abs(other) > 100) pnl.push(['其他变动（余额税、罚款、手动操作等）', signed(other), other >= 0 ? 'up' : 'down'])
  pnl.push(['现金盈亏', signed(dc), dc >= 0 ? 'up' : 'down', true])
  rows('pnl', pnl)
  const t = s.tools || {}
  $('chips').replaceChildren(...[`第 ${s.isleNo} 岛日`, s.season + '季', s.weather + (s.night ? ' · 长夜' : ''), `地 ${s.plots}`, `动物 ${s.animals}`, `鱼竿 ${t.rod}`, `镐子 ${t.pick}`, `洒水器 ${t.spr}`, ...(s.mineMax ? [`矿洞 ${s.mineMax} 层`] : [])].map((x) => node('span', '', x)))
  const isle = []
  if (s.ripeAt) isle.push(['下一块地成熟（成熟即收）', new Date(s.ripeAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })])
  if (s.stolenAt) isle.push(['最近一次发现被偷', new Date(s.stolenAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }), 'down'])
  rows('isle', isle)
}

function drawLogs(logs = []) {
  const box = $('logs'), atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 12
  const out = []
  let day = ''
  for (const l of logs.slice(-300)) {
    if (l.slice(0, 10) !== day) { day = l.slice(0, 10); out.push(node('p', 'day', day)) }
    const text = l.slice(20), p = node('p', /出错|失败|⚠|❌|被偷|打跑|赔了/.test(text) ? 'bad' : /^投资|^擂台|^偷菜：|防偷/.test(text) ? 'info' : /收入|赢了|到手|\+[\d,]+ D/.test(text) ? 'good' : '')
    p.append(node('time', '', l.slice(11, 19)), text)
    out.push(p)
  }
  box.replaceChildren(...(out.length ? out : [node('p', '', '还没有日志。')]))
  if (atEnd) box.scrollTop = box.scrollHeight
}

// ---------- 事件 ----------
for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => {
  for (const t of document.querySelectorAll('[data-tab]')) { const on = t === tab; t.setAttribute('aria-selected', String(on)); $('tab-' + t.dataset.tab).hidden = !on }
  if (tab.dataset.tab === 'logs') $('logs').scrollTop = $('logs').scrollHeight
})
$('enabled').addEventListener('change', async (e) => {
  if (!e.target.checked) return save({ enabled: false })
  const { confirmed } = await chrome.storage.local.get('confirmed')
  // 岛已经升级过（地块 / 工具不是初始值）就不再提示
  const built = status && (status.plots > 6 || status.tools?.rod > 1 || status.tools?.pick > 1)
  if (confirmed || built || cfg.dry || !cfg.invest.enabled) return save({ enabled: true })
  e.target.checked = false
  $('confirm-days').textContent = cfg.invest.maxPaybackDays
  $('confirm-reserve').textContent = wan(cfg.invest.reserveCoins)
  $('confirm').hidden = false
})
const confirmWith = (patch) => async () => { $('confirm').hidden = true; await chrome.storage.local.set({ confirmed: true }); await save({ enabled: true, ...patch }) }
$('confirm-yes').addEventListener('click', confirmWith({}))
$('confirm-noinvest').addEventListener('click', confirmWith({ 'invest.enabled': false }))
$('confirm-cancel').addEventListener('click', () => { $('confirm').hidden = true })
for (const el of document.querySelectorAll('[data-path]')) el.addEventListener('change', () => {
  if (el.type === 'checkbox') return save({ [el.dataset.path]: el.checked })
  if (el.tagName === 'SELECT') return save({ [el.dataset.path]: SPEND[el.value] })
  if (el.type === 'time') return el.value ? save({ [el.dataset.path]: el.value }) : drawConfig()
  const n = Number(el.value)
  if (!Number.isFinite(n) || el.value === '') return drawConfig()
  save({ [el.dataset.path]: Math.max(Number(el.min) || 0, Math.min(el.max ? Number(el.max) : Infinity, n)) / (Number(el.dataset.scale) || 1) })
})
$('open').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: SITE + '/*' })
  if (tabs[0]) { await chrome.tabs.update(tabs[0].id, { active: true }); await chrome.windows.update(tabs[0].windowId, { focused: true }) }
  else await chrome.tabs.create({ url: SITE + '/pets' })
})
$('run').addEventListener('click', async () => {
  if (!status?.at || Date.now() - status.at > STALE_MS) { await chrome.tabs.create({ url: SITE + '/pets', active: false }); await new Promise((ok) => setTimeout(ok, 4000)) }
  await chrome.storage.local.set({ cmd: { name: 'run', t: Date.now() } })
})
$('clear').addEventListener('click', () => { chrome.storage.local.remove('logs'); drawLogs([]) })
$('export').addEventListener('click', async () => {
  const { ledger = [] } = await chrome.storage.local.get('ledger')
  const csv = 'time,coins,stock_value\n' + ledger.map((r) => [r.t, r.coins, r.stock].join(',')).join('\n') + '\n'
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = 'yuyugu-ledger.csv'; a.click()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.status) { status = changes.status.newValue; drawStatus() }
  if (changes.logs) drawLogs(changes.logs.newValue)
  if (changes.cfg) { raw = changes.cfg.newValue || {}; cfg = mergeConfig(DEFAULTS, raw); drawConfig(); drawStatus() }
})
const init = await chrome.storage.local.get(['cfg', 'status', 'logs'])
raw = init.cfg || {}; cfg = mergeConfig(DEFAULTS, raw); status = init.status || null
drawConfig(); drawStatus(); drawLogs(init.logs)
setInterval(drawStatus, 1000)
