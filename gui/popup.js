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
let logMode = 'now'          // 'now' 本次运行 / 'hist' 历史 / 'legacy' 旧插件
let histLines = []
let legacyLines = []

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
async function getLogHistory(days) { return api(`/api/logs/history?days=${days}&max=800`) }
async function getLegacyLogs() { return api('/api/logs/legacy?max=800') }
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
  const enabled = !!config?.enabled
  const active = status.running && enabled
  $('enabled').checked = enabled
  $('dry').checked = !!config?.dry
  $('dot').className = 'dot ' + (active ? 'on' : '')
  $('linkState').textContent = active ? '托管中' : (status.running ? '已暂停' : '已连接')
  $('linkState').className = 'pill' + (active ? '' : ' bad')
  if (!w) { $('statusline').textContent = '世界状态尚未就绪'; return }

  const net = status.ledger?.dayNet ?? 0
  $('dayNet').textContent = (net >= 0 ? '+' : '') + fmt(net)
  $('dayNet').className = net >= 0 ? 'up' : 'down'
  $('dayNetSub').textContent = `D币 ${fmt(status.ledger.startCoins)} → ${fmt(w.coins)}`
  $('coins').textContent = fmt(w.coins)
  $('stock').textContent = '库存 ' + fmt(w.stock)
  $('isleTime').textContent = `第 ${w.isleNo} 天 · ${w.season}·${w.weather} · ${String(w.hour).padStart(2, '0')}:00${w.longNight ? ' · 长夜' : ''}`
  // 咖啡可以让体力超过上限，超上限时标注一下，避免看着像 bug
  $('energy').textContent = w.energy > w.energyMax
    ? `${Math.floor(w.energy)} / ${w.energyMax}（超上限）`
    : `${Math.floor(w.energy)} / ${w.energyMax}`
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
  const src = logMode === 'hist' ? histLines : logMode === 'legacy' ? legacyLines : logLines
  box.replaceChildren(...src.slice(-600).map((l) => {
    const div = document.createElement('div')
    if (l.level === 'err') div.className = 'err'
    let t
    if (l.ts) t = l.ts.slice(5)                       // 历史：MM-DD HH:MM:SS
    else if (l.t) t = new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })
    else t = ''
    div.innerHTML = `<span class="time">${t}</span> ${escapeHtml(l.msg)}`
    return div
  }))
  if (atBottom) box.scrollTop = box.scrollHeight
}

async function loadLogHistory() {
  if (!alive) return
  const days = Number($('histDays').value) || 3
  try {
    const j = await getLogHistory(days)
    histLines = j.logs || []
    const inv = j.days || []
    $('histInfo').textContent = inv.length
      ? `${inv.length} 天有记录（${inv[inv.length - 1].day} ~ ${inv[0].day}），共 ${histLines.length} 行`
      : '没有历史日志'
    if (logMode === 'hist') renderLogs()
  } catch (e) {
    $('histInfo').textContent = '读取失败：' + e.message
  }
}

async function loadLegacyLogs() {
  if (!alive) return
  const info = $('legacyInfo')
  info.textContent = '正在读取浏览器里的旧插件记录…'
  try {
    const j = await getLegacyLogs()
    legacyLines = (j.rows || []).map((r) => ({ ts: r.ts, msg: r.msg, level: r.level }))
    if (j.error) {
      info.textContent = j.error
    } else {
      const st = j.active || {}
      info.textContent = `${st.browser || '?'} · ${st.profile || '?'} · ${j.total || 0} 条` +
        `（显示最近 ${legacyLines.length}）` + (j.files ? `，${j.files} 个文件` : '')
    }
    if (logMode === 'legacy') renderLogs()
  } catch (e) {
    info.textContent = '读取失败：' + e.message
  }
}

function setLogMode(mode) {
  logMode = mode
  $('logModeNow').classList.toggle('on', mode === 'now')
  $('logModeHist').classList.toggle('on', mode === 'hist')
  $('logModeLegacy').classList.toggle('on', mode === 'legacy')
  $('histBar').hidden = mode !== 'hist'
  $('legacyBar').hidden = mode !== 'legacy'
  if (mode === 'hist') loadLogHistory().then(() => renderLogs())
  else if (mode === 'legacy') loadLegacyLogs().then(() => renderLogs())
  else renderLogs()
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

  // 用 Native Messaging 拉起主程序（不需要开机自启，也不用敲命令）
  $('btnLaunch').onclick = async () => {
    const hint = $('launchHint')
    const btn = $('btnLaunch')
    btn.disabled = true
    hint.textContent = '正在启动…'
    try {
      port = Number($('port').value) || 8787
      await chrome.storage.local.set({ port })
      const res = await sendNative({ cmd: 'launch', port })
      if (res?.ok) {
        hint.textContent = res.msg || '已启动'
        // 等端口就绪后连接
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 500))
          try { await api('/api/ping'); await connect(); hint.textContent = ''; break }
          catch { if (i === 29) hint.textContent = '已启动但连不上，检查端口 ' + port }
        }
      } else {
        hint.textContent = '启动失败：' + (res?.msg || '宿主没有响应')
      }
    } catch (e) {
      hint.textContent = '无法调用本地宿主：' + e.message +
        '（需要先运行 node scripts/install-host.mjs --ext-id=' + chrome.runtime.id + '）'
    } finally {
      btn.disabled = false
    }
  }

  $('logModeNow').onclick = () => setLogMode('now')
  $('logModeHist').onclick = () => setLogMode('hist')
  $('logModeLegacy').onclick = () => setLogMode('legacy')
  $('histDays').onchange = () => loadLogHistory().then(() => renderLogs())
  $('legacyRefresh').onclick = () => loadLegacyLogs().then(() => renderLogs())
}

/** 调用 Native Messaging 宿主 */
function sendNative(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage('com.baicai492.yuyugu', msg, (res) => {
        const err = chrome.runtime.lastError
        if (err) reject(new Error(err.message))
        else resolve(res)
      })
    } catch (e) { reject(e) }
  })
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
  // 先把界面点亮（按钮要能点），再异步连接，避免未连接时界面长时间不响应
  $('connBox').hidden = false
  connect().catch(() => {})
  startAuto()
}

main()
