// 鱼鱼谷托管 GUI。所有数据来自本地 Node 主程序（http://127.0.0.1:<port>）。
// 插件本身不碰站点，只做展示与配置。

const $ = (id) => document.getElementById(id)
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US')
const wan = (n) => (Math.abs(n) >= 10000 ? (n / 10000).toFixed(1) + ' 万' : fmt(n))
const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(0) + '%'

let port = 8787
let alive = false
let status = null
let market = null
let config = null
let logSince = 0
let logLines = []
let autoTimer = 0

// ---------- 通信 ----------
async function api(path, opts = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  })
  const text = await r.text()
  let json = {}
  try { json = text ? JSON.parse(text) : {} } catch {}
  if (!r.ok) throw Object.assign(new Error(json.error || `HTTP ${r.status}`), { status: r.status, data: json })
  return json
}

async function getStatus() { return api('/api/status') }
async function getMarket() {
  const d = Number($('mDays').value) || 12
  const m = Number($('mMark').value) || 0
  return api(`/api/market?days=${d}&markdown=${m}`)
}
async function getLogs(since) { return api(`/api/logs?since=${since}`) }
async function cmd(c, extra = {}) { return api('/api/command', { method: 'POST', body: JSON.stringify({ cmd: c, ...extra }) }) }
async function saveCfg(cfg) { return api('/api/config', { method: 'POST', body: JSON.stringify({ config: cfg }) }) }

// ---------- 连接 ----------
async function connect() {
  try {
    const p = await api('/api/ping')
    alive = !!p.ok
  } catch { alive = false }
  $('connBox').hidden = alive
  $('dot').className = 'dot ' + (alive ? 'on' : 'err')
  $('linkState').textContent = alive ? '已连接' : '未连接'
  $('linkState').className = 'pill' + (alive ? '' : ' bad')
  if (alive) {
    await Promise.all([loadStatus(), loadLogs(), loadConfig().catch(() => {})])
  }
}

async function loadStatus() {
  try {
    const j = await getStatus()
    status = j.status
    config = j.config
    renderOverview()
    $('ver').textContent = 'v' + (j.version || 1)
  } catch (e) {
    $('statusline').textContent = '读取状态失败：' + e.message
  }
}

async function loadLogs() {
  if (!alive) return
  try {
    const j = await getLogs(logSince)
    for (const l of j.logs || []) { logSince = Math.max(logSince, l.t); logLines.push(l) }
    if (logLines.length > 1500) logLines = logLines.slice(-1500)
    renderLogs()
  } catch {}
}

async function loadConfig() {
  const j = await api('/api/config')
  config = j.config
  renderSettings()
}

// ---------- 渲染：概览 ----------
function renderOverview() {
  if (!status) return
  const w = status.world
  $('enabled').checked = !!config?.enabled
  $('dry').checked = !!config?.dry
  $('dot').className = 'dot ' + (status.running ? 'on' : '')
  $('linkState').textContent = status.running ? '托管中' : '已连接'
  if (!w) { $('statusline').textContent = '世界状态尚未就绪'; return }

  const net = status.ledger?.dayNet ?? 0
  $('dayNet').textContent = (net >= 0 ? '+' : '') + fmt(net)
  $('dayNet').className = net >= 0 ? 'up' : 'down'
  $('dayNetSub').textContent = `D币 ${fmt(status.ledger.startCoins)} → ${fmt(w.coins)}`
  $('coins').textContent = fmt(w.coins)
  $('stock').textContent = '库存 ' + fmt(w.stock)
  $('isleTime').textContent = `第 ${w.isleNo} 天 · ${w.season}·${w.weather} · ${String(w.hour).padStart(2, '0')}:00${w.longNight ? ' · 长夜' : ''}`
  $('energy').textContent = `${Math.floor(w.energy)} / ${w.energyMax}`
  $('scale').textContent = `${w.plots} / ${w.barn}/${w.barnN} / ${w.traps}`
  $('tools').textContent = `竿${w.tools.rod} 镐${w.tools.pick} 洒${w.tools.spr} 屋${w.tools.house} · 矿${w.mineMax}层`

  const q = w.quotas || {}
  const names = { fish: '钓鱼', mine: '挖矿', craft: '加工', bomb: '炸矿', coffee: '咖啡', npc: '52弟', gomokuPaid: '五子棋计奖' }
  $('quotas').replaceChildren(...Object.entries(q).map(([k, v]) => {
    const p = v.max ? Math.min(1, v.used / v.max) : 0
    const el = document.createElement('div')
    el.className = 'quota'
    el.innerHTML = `<div>${names[k] || k} ${v.used}/${v.max}</div><div class="bar"><i style="width:${(p * 100).toFixed(0)}%" class="${p >= 1 ? 'full' : ''}"></i></div>`
    return el
  }))

  $('earn').textContent = '+' + fmt(status.ledger.earn)
  $('spend').textContent = '−' + fmt(status.ledger.spend)
  $('tax').textContent = fmt(status.ledger.tax)

  const st = status.state
  const bits = []
  if (st === 'paused') bits.push('已暂停')
  else if (st === 'running') bits.push(`第 ${status.round} 轮`)
  if (status.nextAt) {
    const left = Math.max(0, Math.round((status.nextAt - Date.now()) / 1000))
    bits.push(`${left} 秒后下次巡视`)
  }
  if (status.lastError) bits.push('⚠ ' + status.lastError)
  $('statusline').textContent = bits.join(' · ')
}

// ---------- 渲染：市场 ----------
function renderMarket() {
  if (!market) return
  $('mForecast').replaceChildren(...(market.forecast || []).map((f) => {
    const el = document.createElement('div')
    el.className = 'fc'
    const ev = (f.events || []).map((e) => `<div class="ev">${e.text}</div>`).join('')
    el.innerHTML = `<b>${f.day.slice(5)}</b><div>${f.season}·${f.weather}</div>${ev}`
    return el
  }))
  const tbody = $('mTable').querySelector('tbody')
  tbody.replaceChildren(...(market.rows || []).slice(0, 60).map((r) => {
    const tr = document.createElement('tr')
    if (r.sellNow) tr.className = 'sell'
    tr.innerHTML =
      `<td>${r.name}</td><td>${r.qty}</td>` +
      `<td class="${r.curPct >= 0 ? 'up' : 'down'}">${pct(r.curPct)}</td>` +
      `<td class="${r.peakPct >= 0 ? 'up' : 'down'}">${pct(r.peakPct)}</td>` +
      `<td>+${r.peakIn}</td><td>${fmt(r.line)}</td>` +
      `<td><span class="tag ${r.sellNow ? 'now' : 'wait'}">${r.sellNow ? '现在卖' : '等峰值'}</span></td>`
    return tr
  }))
}

async function refreshMarket() {
  try {
    const j = await getMarket()
    market = j
    renderMarket()
  } catch (e) {
    $('mForecast').textContent = '读取失败：' + e.message
  }
}

// ---------- 渲染：设置 ----------
const FIELD_GROUPS = [
  { title: '托管', fields: ['enabled', 'dry'] },
  { title: '投资', fields: ['invest.enabled', 'invest.maxPaybackDays', 'invest.reserveCoins'], nums: ['invest.maxPaybackDays', 'invest.reserveCoins'] },
  { title: '农田', fields: ['farm.enabled', 'farm.water', 'farm.foodPlots'], nums: ['farm.foodPlots'] },
  { title: '体力', fields: ['energy.eat', 'energy.coffee'] },
  { title: '钓鱼 / 挖矿', fields: ['work.fish', 'work.mine', 'work.bomb', 'work.bait'] },
  { title: '卖货', fields: ['sell.enabled', 'sell.horizonDays', 'sell.markdownPct', 'sell.respectTiers'], nums: ['sell.horizonDays', 'sell.markdownPct'] },
  { title: '货船', fields: ['cargo.enabled', 'cargo.minMargin'], nums: ['cargo.minMargin'] },
  { title: '52弟', fields: ['npc.enabled', 'npc.gomoku', 'npc.gomokuLevel', 'npc.gomokuBudgetMs'], nums: ['npc.gomokuLevel', 'npc.gomokuBudgetMs'] },
  { title: '擂台', fields: ['arena.enabled', 'arena.battles', 'arena.openChests', 'arena.autoEquip'], nums: ['arena.battles'] },
  { title: '串门', fields: ['social.help.enabled', 'social.steal.enabled'], },
]

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj)
const setPath = (obj, path, v) => {
  const ks = path.split('.')
  let cur = obj
  for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]] ||= {}
  cur[ks[ks.length - 1]] = v
}

function renderSettings() {
  if (!config) return
  const root = $('settings')
  root.replaceChildren(...FIELD_GROUPS.map((g) => {
    const grp = document.createElement('div')
    grp.className = 'grp'
    const h = document.createElement('h3')
    h.textContent = g.title
    grp.append(h)
    for (const path of g.fields) {
      const v = getPath(config, path)
      const row = document.createElement('div')
      row.className = 'field'
      const lab = document.createElement('label')
      lab.textContent = path.split('.').pop()
      let input
      if (typeof v === 'boolean') {
        input = document.createElement('input')
        input.type = 'checkbox'
        input.checked = v
        input.onchange = () => setPath(config, path, input.checked)
      } else if ((g.nums || []).includes(path) || typeof v === 'number') {
        input = document.createElement('input')
        input.type = 'number'
        input.step = 'any'
        input.value = v
        input.onchange = () => setPath(config, path, Number(input.value))
      } else {
        input = document.createElement('input')
        input.type = 'text'
        input.value = v ?? ''
        input.onchange = () => setPath(config, path, input.value)
      }
      row.append(lab, input)
      grp.append(row)
    }
    return grp
  }))
}

// ---------- 渲染：日志 ----------
function renderLogs() {
  const box = $('logs')
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20
  box.replaceChildren(...logLines.slice(-500).map((l) => {
    const div = document.createElement('div')
    if (l.level === 'err') div.className = 'err'
    const t = new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })
    div.innerHTML = `<span class="time">${t}</span> ${escapeHtml(l.msg)}`
    return div
  }))
  if (atBottom) box.scrollTop = box.scrollHeight
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

// ---------- 事件 ----------
function bind() {
  document.querySelectorAll('nav.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('nav.tabs button').forEach((x) => x.classList.toggle('on', x === b))
      document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + b.dataset.tab })
      if (b.dataset.tab === 'market') refreshMarket()
      if (b.dataset.tab === 'settings') loadConfig().catch(() => {})
    }
  })

  $('enabled').onchange = async () => {
    try { await cmd($('enabled').checked ? 'start' : 'stop'); await loadStatus() }
    catch (e) { $('statusline').textContent = e.message }
  }
  $('dry').onchange = async () => {
    try { await cmd('dry', { value: $('dry').checked }); await loadStatus() }
    catch (e) { $('statusline').textContent = e.message }
  }
  $('btnStart').onclick = async () => { try { await cmd('start'); await loadStatus() } catch (e) { $('statusline').textContent = e.message } }
  $('btnStop').onclick = async () => { try { await cmd('stop'); await loadStatus() } catch (e) { $('statusline').textContent = e.message } }
  $('btnOnce').onclick = async () => { try { await cmd('once'); setTimeout(loadStatus, 1500) } catch (e) { $('statusline').textContent = e.message } }

  $('mRefresh').onclick = refreshMarket
  $('mDays').onchange = refreshMarket
  $('mMark').onchange = refreshMarket

  $('cfgSave').onclick = async () => {
    try {
      await saveCfg(config)
      $('cfgStatus').textContent = '已保存'
      await loadStatus()
    } catch (e) { $('cfgStatus').textContent = '保存失败：' + e.message }
  }
  $('cfgReset').onclick = () => loadConfig().catch((e) => { $('cfgStatus').textContent = e.message })

  $('logAuto').onchange = () => { if ($('logAuto').checked) startAuto() }
  $('logClear').onclick = () => { logLines = []; renderLogs() }

  $('reconnect').onclick = async () => {
    port = Number($('port').value) || 8787
    await chrome.storage.local.set({ port })
    logSince = 0; logLines = []
    await connect()
  }
}

function startAuto() {
  clearInterval(autoTimer)
  autoTimer = setInterval(async () => {
    if (!$('logAuto').checked) return
    await loadLogs()
    if (!$('tab-overview').hidden) await loadStatus()
  }, 3000)
}

async function main() {
  const { port: p } = await chrome.storage.local.get(['port'])
  port = Number(p) || 8787
  $('port').value = port
  bind()
  await connect()
  startAuto()
}

main()
