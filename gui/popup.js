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
  // 面板上的两个参数就是策略实际用的参数（读写同一份配置），
  // 保证「你看到的建议」和「程序真正照做的」是同一套数。
  const d = Number($('mDays').value) || Number(config?.sell?.horizonDays) || 12
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
  // 三种运行态：working（正在巡视）/ waiting（巡视完，等下次）/ paused（总开关关着）
  const working = status.running && enabled && status.state === 'working'
  const waiting = status.running && enabled && status.state === 'waiting'
  $('enabled').checked = enabled
  $('dry').checked = !!config?.dry
  $('dot').className = 'dot ' + (working || waiting ? 'on' : status.running ? '' : 'err')
  if (!enabled) {
    $('linkState').textContent = status.running ? '已暂停' : '已连接'
    $('linkState').className = 'pill bad'
  } else if (working) {
    $('linkState').textContent = '巡视中'
    $('linkState').className = 'pill'
  } else if (waiting) {
    $('linkState').textContent = '托管中'
    $('linkState').className = 'pill'
  } else {
    $('linkState').textContent = '已连接'
    $('linkState').className = 'pill bad'
  }
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
  if (st === 'paused') bits.push('总开关已关，未在做任何事')
  else if (st === 'working') bits.push(status.step ? `正在${status.step}` : '正在巡视')
  else if (st === 'waiting') bits.push(`第 ${status.round} 轮已完成`)
  else if (st === 'error') bits.push('出错')
  if (waiting && status.nextAt) {
    const left = Math.max(0, Math.round((status.nextAt - Date.now()) / 1000))
    bits.push(left > 90 ? `${Math.round(left / 60)} 分钟后巡视` : `${left} 秒后巡视`)
  }
  if (status.lastError) bits.push('⚠ ' + status.lastError)
  $('statusline').textContent = bits.join(' · ')
}

// ---------- 渲染：市场 ----------
function renderMarket() {
  if (!market) return
  // 面板参数以配置为准（在设置页改过之后切过来也能对上）
  if (config?.sell) {
    if (document.activeElement !== $('mDays')) $('mDays').value = config.sell.horizonDays ?? 12
    if (document.activeElement !== $('mMark')) $('mMark').value = config.sell.markdownPct ?? 6
  }
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
// labels：字段 → 中文含义；hints：字段 → 一句话解释（鼠标悬停可见）
const FIELD_GROUPS = [
  {
    title: '总开关',
    fields: ['enabled', 'dry'],
    labels: { enabled: '启用托管', dry: '演练模式' },
    hints: { enabled: '关掉后主程序仍在运行，但不再做任何动作', dry: '只计算并打印计划，不向站点提交任何动作' },
  },
  {
    title: '投资',
    fields: ['invest.enabled', 'invest.maxPaybackDays', 'invest.reserveCoins'],
    labels: { 'invest.enabled': '自动扩建', 'invest.maxPaybackDays': '回本天数上限', 'invest.reserveCoins': '保留现金' },
    hints: { 'invest.maxPaybackDays': '预计多少天内回本才买（天）', 'invest.reserveCoins': '账上至少留这么多 D 币不动用' },
  },
  {
    title: '农田',
    fields: ['farm.enabled', 'farm.water', 'farm.foodPlots'],
    labels: { 'farm.enabled': '自动种植', 'farm.water': '自动浇水', 'farm.foodPlots': '口粮地数量' },
    hints: { 'farm.foodPlots': '留几块地专门种回体力的作物' },
  },
  {
    title: '体力',
    fields: ['energy.eat', 'energy.coffee'],
    labels: { 'energy.eat': '吃作物回体力', 'energy.coffee': '喝咖啡回体力' },
    hints: { 'energy.coffee': '咖啡 +60 体力且可超过上限，每天 3 杯' },
  },
  {
    title: '钓鱼 / 挖矿',
    fields: ['work.fish', 'work.mine', 'work.bomb', 'work.bait'],
    labels: { 'work.fish': '钓鱼', 'work.mine': '挖矿', 'work.bomb': '炸矿', 'work.bait': '自动用鱼饵' },
    hints: { 'work.bomb': '炸矿消耗炸药，单次收益更高但需要库存里有炸药' },
  },
  {
    title: '卖货',
    fields: ['sell.enabled', 'sell.horizonDays', 'sell.markdownPct', 'sell.respectTiers'],
    labels: { 'sell.enabled': '自动卖货', 'sell.horizonDays': '往后看几个岛日', 'sell.markdownPct': '离峰值几个点就卖', 'sell.respectTiers': '遵守阶梯价' },
    hints: {
      'sell.horizonDays': '在这段时间内找最高价，决定现在卖还是等',
      'sell.markdownPct': '卖线 = 未来峰值 × (1 − 这个百分比)',
      'sell.respectTiers': '超出每日全价额度的部分留到明天卖，避免被压价',
    },
  },
  {
    title: '囤货仓库',
    fields: ['vault.enabled', 'vault.keepPeakAhead'],
    labels: { 'vault.enabled': '启用仓库', 'vault.keepPeakAhead': '峰值在几个岛日内就囤' },
    hints: { 'vault.enabled': '把「等涨更划算」的货锁进仓库，防止被管家低价卖掉' },
  },
  {
    title: '货船',
    fields: ['cargo.enabled', 'cargo.minMargin'],
    labels: { 'cargo.enabled': '自动进货', 'cargo.minMargin': '最低预期利润' },
    hints: { 'cargo.minMargin': '预期能加价多少才买（0.08 = 8%）' },
  },
  {
    title: '52弟 · 五子棋',
    fields: ['npc.enabled', 'npc.gomoku', 'npc.gomokuLevel', 'npc.gomokuBudgetMs'],
    labels: { 'npc.enabled': '启用 52弟', 'npc.gomoku': '打五子棋', 'npc.gomokuLevel': '难度档位', 'npc.gomokuBudgetMs': '每局思考上限' },
    hints: {
      'npc.gomokuLevel': '1 简单×0.8 / 2 普通×1.2 / 3 困难×1.5',
      'npc.gomokuBudgetMs': '超过这个时间还没搜到必胜棋谱就跳过重开（毫秒）',
    },
  },
  {
    title: '擂台',
    fields: ['arena.enabled', 'arena.battles', 'arena.openChests', 'arena.autoEquip'],
    labels: { 'arena.enabled': '打擂台', 'arena.battles': '每天场次', 'arena.openChests': '自动开宝箱', 'arena.autoEquip': '自动换装' },
    hints: { 'arena.battles': '前 30 场有掉落，每场间隔 8.5 秒' },
  },
  {
    title: '串门 · 帮忙',
    fields: ['social.help.enabled', 'social.help.perDay'],
    labels: { 'social.help.enabled': '自动帮忙', 'social.help.perDay': '每天帮几家' },
    hints: { 'social.help.perDay': '每家 1 体力，得 200 D + 2 经验' },
  },
  {
    title: '串门 · 偷菜',
    fields: ['social.steal.enabled', 'social.steal.minValue', 'social.steal.maxEnergy', 'social.steal.visitsPerScan', 'social.steal.scanEvery'],
    labels: {
      'social.steal.enabled': '开启偷菜',
      'social.steal.minValue': '最低目标价值',
      'social.steal.maxEnergy': '单次体力上限',
      'social.steal.visitsPerScan': '每轮去几家',
      'social.steal.scanEvery': '扫描间隔（秒）',
    },
    hints: {
      'social.steal.enabled': '风险高：被发现要打守家战，输了按市价 1.2 倍赔（默认关闭）',
      'social.steal.minValue': '一批货市价低于这个值就不去偷',
      'social.steal.scanEvery': '多久重新扫一遍邻居目录',
    },
  },
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
      lab.textContent = g.labels?.[path] || path.split('.').pop()
      const hint = g.hints?.[path]
      if (hint) { lab.title = hint; lab.classList.add('has-hint') }
      let input
      if (typeof v === 'boolean') {
        input = document.createElement('input')
        input.type = 'checkbox'
        input.checked = v
        input.onchange = () => setPath(config, path, input.checked)
      } else if (typeof v === 'number') {
        input = document.createElement('input')
        input.type = 'number'
        input.step = 'any'
        input.value = v
        input.title = hint || ''
        input.onchange = () => setPath(config, path, Number(input.value))
      } else {
        input = document.createElement('input')
        input.type = 'text'
        input.value = v ?? ''
        input.title = hint || ''
        input.onchange = () => setPath(config, path, input.value)
      }
      row.append(lab, input)
      grp.append(row)
      if (hint) {
        const note = document.createElement('div')
        note.className = 'field-hint'
        note.textContent = hint
        grp.append(note)
      }
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
  // 改了参数就同步写回配置——策略与面板共用一个数，不会各走各的
  $('mDays').onchange = async () => {
    if (config) { setPath(config, 'sell.horizonDays', Number($('mDays').value) || 12); await saveCfg(config).catch(() => {}) }
    await refreshMarket()
  }
  $('mMark').onchange = async () => {
    if (config) { setPath(config, 'sell.markdownPct', Number($('mMark').value) || 0); await saveCfg(config).catch(() => {}) }
    await refreshMarket()
  }

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
    if ($('logAuto').checked) await loadLogs()
    // 概览页要看到「正在做什么」和逐笔收支，1.5 秒刷一次
    if (!$('tab-overview').hidden && alive) await loadStatus()
  }, 1500)
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
