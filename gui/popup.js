// 鱼鱼谷托管 GUI。所有数据来自本地 Node 主程序（http://127.0.0.1:<port>）。
// 插件本身不碰站点，只做展示与配置。

const $ = (id) => document.getElementById(id)
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US')
const wan = (n) => (Math.abs(n) >= 10000 ? (n / 10000).toFixed(1) + ' 万' : fmt(n))
const pct = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(0) + '%'
// 带正负号的万位缩写（旧版 signed + wan 的组合），用于「现金 +120.3 万」这类短标注
const signedWan = (n) => (n === 0 ? '0' : (n > 0 ? '+' : '−') + wan(Math.abs(n)))
// 余额税（规则 B12_TAX）：300 万以内免，300~1000 万的部分 0.1%，1000 万以上的部分 0.3%
const balanceTax = (coins) => {
  const excess = Math.max(0, (Number(coins) || 0) - 3000000)
  const low = Math.min(excess, 7000000)
  const high = Math.max(0, excess - 7000000)
  return (low * 1 + high * 3) / 1000
}

let port = 8787
let alive = false
let restarting = false      // 正在重启的 1~2 秒空窗：期间的网络错误不写状态栏
let status = null
let market = null
let xian = null
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
async function getXian() { return api('/api/xian') }
async function getLogs(since) { return api(`/api/logs?since=${since}`) }async function getLogHistory(days) { return api(`/api/logs/history?days=${days}&max=800`) }
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
    $('ver').textContent = 'v' + (j.version || 2)
  } catch (e) {
    // 重启空窗、进程刚退出都会走到这里。进行中的重启不算故障；
    // 其它情况才报，并且下一次读取成功时由 renderOverview 覆盖掉。
    if (!restarting) $('statusline').textContent = '读取状态失败：' + e.message
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
  // 旧版把当日净增拆成「现金变动 / 库存变动」，只给一个合计数看不出钱压在哪：
  // 现金涨了但库存也涨，说明货还没卖出去，不是策略失灵。
  const led = status.ledger || {}
  const dCash = (w.coins || 0) - (led.startCoins || 0)
  const dStock = (w.stock || 0) - (led.startStock || 0)
  $('dayNetSub').textContent =
    `现金 ${signedWan(dCash)} · 库存 ${signedWan(dStock)}` +
    `（起 ${fmt(led.startCoins)} → ${fmt(w.coins)}）`
  $('coins').textContent = fmt(w.coins)
  $('stock').textContent = '库存 ' + fmt(w.stock)
  $('isleTime').textContent = `第 ${w.isleNo} 天 · ${w.season}·${w.weather} · ${String(w.hour).padStart(2, '0')}:00${w.longNight ? ' · 长夜' : ''}`
  // 防偷：下一块地什么时候熟、上次被偷是多久前
  $('ripeAt').textContent = w.nextRipeAt
    ? new Date(w.nextRipeAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '没有在长的作物'
  if (w.stolenAgo >= 0) {
    const m = Math.round(w.stolenAgo / 60)
    $('stolenAt').textContent = m < 60 ? `${m} 分钟前` : `${(m / 60).toFixed(1)} 小时前`
    $('stolenAt').className = 'down'
  } else {
    $('stolenAt').textContent = '这次运行没有发现'
    $('stolenAt').className = 'muted'
  }
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
  // 现金盈亏 = 收入 − 支出；差额（余额税、罚款、手动买卖等）单独列一行，
  // 否则「收入 − 支出」和实际余额对不上时看不出原因。
  const cashFlow = (status.ledger.earn || 0) - (status.ledger.spend || 0)
  const other = dCash - cashFlow
  $('cashNet').textContent = signedWan(dCash)
  $('cashNet').className = dCash >= 0 ? 'up' : 'down'
  $('stockNet').textContent = signedWan(dStock)
  $('stockNet').className = dStock >= 0 ? 'up' : 'down'
  const otherRow = $('otherRow')
  if (Math.abs(other) > 100) {
    otherRow.hidden = false
    $('other').textContent = signedWan(other)
    $('other').className = other >= 0 ? 'up' : 'down'
    // 余额税是这一行的大头：300 万以内免，300~1000 万的部分 0.1%，
    // 1000 万以上的部分 0.3%，每个岛日扣一次（规则 B12_TAX）。
    // 直接写在 tooltip 里，免得看到「−7.9 万」以为哪里亏了。
    otherRow.title = `余额税：300 万以内免，300~1000 万部分 0.1%，1000 万以上部分 0.3%，每个岛日扣一次。\n` +
      `按当前余额 ${fmt(w.coins)}，每次约 ${fmt(balanceTax(w.coins))} D` +
      (status.world?.nextIsleAt ? `（下一岛日 ${new Date(status.world.nextIsleAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）` : '')
  } else {
    otherRow.hidden = true
  }

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
      `<td><span class="tag ${r.sellNow ? 'now' : 'wait'}">${r.sellNow ? `今日卖 ${r.todayQty}` : '等峰值'}</span></td>`
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

// ---------- 渲染：修仙 ----------
// 修仙的规则常量在 Node 侧（core/xian-rules.mjs），GUI 只做展示，
// 这里的小字典必须和那边保持一致；对不上时最坏情况是显示 id，不影响决策。
const HERB_NAMES = { lingcao: '灵草', jingu: '金菇', linglan: '铃兰', binglian: '冰莲', chizhi: '赤芝', leizhu: '雷竹' }
const PILL_NAMES = { huiling: '回灵丹', peiyuan: '培元丹' }
const ROOT_NAMES = { metal: '金', wood: '木', water: '水', fire: '火', earth: '土', ice: '冰', thunder: '雷', wind: '风', lava: '熔', poison: '毒' }
const TECH_NAMES = {
  fire: '流火诀', water: '沧澜诀', wood: '青木诀', metal: '庚金剑诀', earth: '厚土诀', ice: '玄冰诀',
  thunder: '紫霄雷法', wind: '御风诀', lava: '熔岩诀', poison: '万毒经',
}
const nm = (map, id) => map[id] || id
const fmtSec = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0))
  if (n < 60) return `${n} 秒`
  if (n < 3600) return `${Math.floor(n / 60)} 分 ${n % 60} 秒`
  return `${Math.floor(n / 3600)} 小时 ${Math.floor((n % 3600) / 60)} 分`
}
const countList = (obj, map) => Object.entries(obj || {})
  .filter(([, n]) => Number(n) > 0)
  .map(([id, n]) => `${nm(map, id)}×${n}`)
  .join(' ')

function renderXian() {
  const x = xian
  const on = !!config?.xian?.enabled
  $('xEnabled').checked = on
  if (!x || !x.exists) {
    $('xStatus').textContent = x?.error ? '读取失败：' + x.error : '读取中…'
    for (const id of ['xRealm', 'xCv', 'xStone', 'xGarden', 'xEnergy', 'xCan', 'xPlots', 'xGround', 'xBag', 'xBrew', 'xMed', 'xTech', 'xWake',
      'xAssets', 'xAssetHerbs', 'xAssetPills', 'xAssetDaily', 'xAssetClears']) $(id).textContent = '—'
    return
  }
  $('xRealm').textContent = `${x.realm}${x.stage ? x.stage + ' 层' : ''}`
  const rootTxt = (x.roots || []).map((r) => nm(ROOT_NAMES, r)).join('')
  $('xCv').textContent = `修为 ${fmt(x.cvXp)}/${fmt(x.cvNeed)}｜${rootTxt || '无灵根'}灵根`
  $('xStone').textContent = fmt(x.stone)
  $('xGarden').textContent = `药园 Lv${x.gardenLv} · ${fmt(x.gardenXp)}/${fmt(x.gardenNeed)}`
  $('xEnergy').textContent = `${x.energy}/${x.energyMax}`
  $('xCan').textContent = `${x.can}/${x.canMax}`
  const p = x.plots || {}
  $('xPlots').textContent = `已开 ${p.open}/${p.total} · 空地 ${p.empty} · 成熟 ${p.mature}` +
    (p.growing ? ` · 生长 ${p.growing}${p.dry ? `（待浇 ${p.dry}）` : ''}` : '')
  $('xGround').textContent = countList(x.inGround, HERB_NAMES) || '—'
  const bagBits = []
  const bag = countList(x.bag, HERB_NAMES)
  const seeds = countList(x.seeds, HERB_NAMES)
  const pills = countList(x.pills, PILL_NAMES)
  if (bag) bagBits.push(bag)
  if (seeds) bagBits.push('种子 ' + seeds)
  if (pills) bagBits.push(pills)
  $('xBag').textContent = bagBits.join('｜') || '—'
  $('xBrew').textContent = x.brew
    ? `${nm(PILL_NAMES, x.brew.pill)} · ${fmtSec(x.brew.readyIn)}后出炉`
    : '空闲'
  $('xMed').textContent = x.meditate ? `已打坐 ${fmtSec(x.meditate.elapsed)} / ${fmtSec(x.meditate.cap)}` : '没在打坐'
  const techs = (x.techs || []).map((el) => nm(TECH_NAMES, el) + (el === x.mainTech ? '（主修）' : ''))
  $('xTech').textContent = techs.join(' · ') || '未学'
  $('xWake').textContent = !on ? '—（未启用）' : (x.nextWakeIn < 0 ? '—' : fmtSec(x.nextWakeIn))

  // 资源统计：灵石换不成 D 币，所以这一块只按「灵石口径」估值，和现金收益无关。
  const a = x.assets
  if (a) {
    $('xAssets').textContent = '≈ ' + fmt(a.total) + ' 灵石'
    $('xAssets').title = `灵石 ${fmt(a.stone)} + 药材 ${fmt(a.bagValue)} + 种子 ${fmt(a.seedValue)}` +
      ` + 丹药 ${fmt(a.pillValue)}（参考价） + 成熟作物 ${fmt(a.groundValue)}`
    $('xAssetHerbs').textContent = `药材 ${a.bagQty} 件（可卖 ${fmt(a.bagValue)}）· 种子 ${a.seedQty} 包（成本 ${fmt(a.seedValue)}）`
    $('xAssetPills').textContent = `丹药 ${a.pillQty} 颗（参考 ${fmt(a.pillValue)}）· 地里 ${a.groundQty} 株 / 熟 ${a.groundMature}（可收 ${fmt(a.groundValue)}）`
    const d = x.daily || {}
    $('xAssetDaily').textContent = `${d.pillUse || 0}/${d.pillMax || 0} · ${d.fightUse || 0}/${d.fightMax || 0}`
    $('xAssetClears').textContent = `${d.cleared || 0}/${d.stageTotal || 0}`
  } else {
    for (const id of ['xAssets', 'xAssetHerbs', 'xAssetPills', 'xAssetDaily', 'xAssetClears']) $(id).textContent = '—'
  }

  // 控件回填（避免用户刚点完又被轮询覆盖时跳回去）
  if (document.activeElement !== $('xBreak') && config?.xian?.breakMode && $('xBreak').value !== config.xian.breakMode) {
    $('xBreak').value = config.xian.breakMode
  }
  $('xFuse').checked = !!config?.xian?.autoFuse

  if (!x.storyDone) $('xStatus').textContent = '剧情还没过完（测灵根、剧情要真人点），托管在待命'
  else if (x.fight) $('xStatus').textContent = '网页端正在斗法，托管暂时不插手'
  else if (!on) $('xStatus').textContent = '已关闭：不会提交任何修仙动作'
  else $('xStatus').textContent = ''
}

async function loadXian() {
  try {
    const j = await getXian()
    xian = j.xian
    if (config?.xian && j.enabled != null) config.xian.enabled = !!j.enabled
    renderXian()
  } catch (e) {
    xian = { exists: false, error: e.message }
    renderXian()
  }
}

async function saveXianCfg(mut) {
  if (!config) return
  config.xian = config.xian || {}
  mut(config.xian)
  try {
    await saveCfg(config)
    $('xStatus').textContent = '已保存'
    await loadXian()
  } catch (e) {
    $('xStatus').textContent = '保存失败：' + e.message
  }
}


// ---------- 渲染：设置 ----------
// labels：字段 → 中文含义；hints：字段 → 一句话解释（鼠标悬停可见）
// 三态开关（旧版 popup 的「花 D币 养大肥鱼」）：值可能是布尔，也可能是字符串 'auto'，
// 所以下拉框的 value 用 JSON 编码，读回来再解析，避免 "true" 被当成字符串。
const SPEND_OPTS = [['开了偷菜或离线时才花', 'auto'], ['总是', true], ['从不', false]]
const POINTS_OPTS = [['自动（按面板断点）', 'auto'], ['全加力量', 'atk'], ['全体质', 'vit'], ['全敏捷', 'agi'], ['全速度', 'spd']]

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
    fields: ['sell.enabled', 'sell.horizonDays', 'sell.outlookDays', 'sell.markdownPct', 'sell.respectTiers'],
    labels: {
      'sell.enabled': '自动卖货',
      'sell.horizonDays': '往后看几个岛日',
      'sell.outlookDays': '估值用几天均价',
      'sell.markdownPct': '离峰值几个点就卖',
      'sell.respectTiers': '遵守阶梯价',
    },
    hints: {
      'sell.horizonDays': '在这段时间内找最高价，决定现在卖还是等',
      'sell.outlookDays': '选作物、钓鱼挖矿、加工、投资都按这段时间的均价估算收益，而不是只看今天的价',
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
    title: '加工',
    fields: ['craft.enabled', 'craft.minMargin', 'craft.maxPerRound'],
    labels: { 'craft.enabled': '自动加工', 'craft.minMargin': '最低利润率', 'craft.maxPerRound': '每轮最多做几份' },
    hints: {
      'craft.enabled': '成品预期卖价明显高于原料才做（旧版插件也有这一项）',
      'craft.minMargin': '利润低于这个比例就不加工（0.05 = 5%）',
    },
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
    title: '防偷',
    fields: ['defense.guardItems', 'offline.enabled', 'offline.from', 'offline.to'],
    labels: {
      'defense.guardItems': '自动续守家道具',
      'offline.enabled': '有固定离线时段（种地避开）',
      'offline.from': '离线开始（北京时）',
      'offline.to': '离线结束（北京时）',
    },
    hints: {
      'defense.guardItems': '被偷后 24 小时内、或设了离线时段时，续潮铃和贝壳护具（约 2400 D/天）',
      'offline.enabled': '这段时间没人收菜，成熟后超过 30 分钟保护期会被偷，所以种地会避开让它在这段时间成熟',
      'offline.from': '格式 HH:MM，例如 01:00',
    },
  },
  {
    title: '擂台',
    fields: ['arena.enabled', 'arena.battles', 'arena.openChests', 'arena.autoEquip', 'arena.spend', 'arena.dailyBudget'],
    labels: {
      'arena.enabled': '打擂台',
      'arena.battles': '每天场次',
      'arena.openChests': '自动开宝箱',
      'arena.autoEquip': '自动换装',
      'arena.spend': '花 D币 养大肥鱼',
      'arena.dailyBudget': '每日养成上限（D币）',
    },
    hints: {
      'arena.battles': '前 30 场有掉落，每场间隔 8.5 秒',
      'arena.spend': '训练、买史诗装备、强化；只影响守家和偷菜的对战胜负，不直接赚钱',
      'arena.dailyBudget': '训练 + 买装 + 强化合计每天最多花这么多',
    },
    selects: { 'arena.spend': SPEND_OPTS },
  },
  {
    title: '擂台 · 战斗策略',
    fields: ['arena.pointsPlan', 'battle.tacticalSwap', 'battle.stealSwap', 'battle.guardPosterior'],
    labels: {
      'arena.pointsPlan': '加点方案',
      'battle.tacticalSwap': '擂台战前换装',
      'battle.stealSwap': '偷菜战前换装',
      'battle.guardPosterior': '用对手档案模拟胜率',
    },
    hints: {
      'arena.pointsPlan': '自动 = 按攻击断点加点，零速必暴武器先补速度；也可强制全堆一项',
      'battle.tacticalSwap': '每场按对手面板模拟，换装显著提高胜率才换，打完自动穿回静止装',
      'battle.stealSwap': '需要上面的「自动换装」开着；换装时间已计入掐点提前量',
      'battle.guardPosterior': '关掉就退回「0.5 + 等级差×0.15」的旧胜率公式',
    },
    selects: { 'arena.pointsPlan': POINTS_OPTS },
  },
  {
    title: '串门 · 帮忙',
    fields: ['social.help.enabled', 'social.help.perDay', 'social.help.minEnergy'],
    labels: { 'social.help.enabled': '自动帮忙', 'social.help.perDay': '每天帮几家', 'social.help.minEnergy': '低于这点体力就不帮' },
    hints: {
      'social.help.perDay': '每家 1 体力，得 200 D + 2 经验',
      'social.help.minEnergy': '帮忙是性价比最高的事（1 体力换 200 D），门槛别设太高',
    },
  },
  {
    title: '串门 · 偷菜',
    fields: ['social.steal.enabled', 'social.steal.minValue', 'social.steal.minEV', 'social.steal.maxEnergy', 'social.steal.visitsPerScan', 'social.steal.scanEvery', 'social.steal.useCloak', 'social.steal.useSack'],
    labels: {
      'social.steal.enabled': '开启偷菜',
      'social.steal.minValue': '最低目标价值',
      'social.steal.minEV': '一趟期望收益下限',
      'social.steal.maxEnergy': '单次体力上限',
      'social.steal.visitsPerScan': '每轮去几家',
      'social.steal.scanEvery': '扫描间隔（秒）',
      'social.steal.useCloak': '买轻步斗篷',
      'social.steal.useSack': '买折叠菜篮',
    },
    hints: {
      'social.steal.enabled': '风险高：被发现要打守家战，输了按市价 1.2 倍赔（默认关闭）',
      'social.steal.minValue': '一批货市价低于这个值就不去偷',
      'social.steal.minEV': '扣掉体力机会成本和被发现风险后，净期望低于这个值就不去',
      'social.steal.scanEvery': '多久重新扫一遍邻居目录',
      'social.steal.useCloak': '被发现率 −10 个百分点，24 小时有效',
      'social.steal.useSack': '每处多拿 1 个，24 小时有效',
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
      const opts = g.selects?.[path]
      if (opts) {
        // 三态开关：value 用 JSON 编码，才能区分 true / false / 'auto'
        input = document.createElement('select')
        for (const [label, val] of opts) {
          const o = document.createElement('option')
          o.textContent = label
          o.value = JSON.stringify(val)
          input.append(o)
        }
        input.value = JSON.stringify(v)
        input.onchange = () => setPath(config, path, JSON.parse(input.value))
      } else if (typeof v === 'boolean') {
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
// 对齐旧版 Chrome 插件的观感：按内容分级着色 + 跨天插日期行 + <time> 标签。
// 旧版这三处让长日志一眼能扫出「赚了 / 亏了 / 出错了 / 投资擂台偷菜」，
// 重写 v2 时只留了一个 .err，读起来很费劲。
function logClass(msg) {
  if (/出错|失败|⚠|❌|被偷|打跑|赔了|余额不足|登录已失效/.test(msg)) return 'bad'
  if (/^投资|^擂台|^偷菜：|^偷菜 |防偷|^五子棋|^帮忙/.test(msg)) return 'info'
  if (/收入|赢了|到手|\+[\d,]+ D|本次巡视.*\+/.test(msg)) return 'good'
  return ''
}

function renderLogs() {
  const box = $('logs')
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20
  const src = logMode === 'hist' ? histLines : logMode === 'legacy' ? legacyLines : logLines
  const out = []
  let lastDay = ''
  for (const l of src.slice(-600)) {
    // 时间戳：历史日志是 "MM-DD HH:MM:SS" 字符串，实时日志是毫秒
    let day = '', clock = ''
    if (l.ts) { day = l.ts.slice(0, 10); clock = l.ts.slice(11, 19) }
    else if (l.t) {
      const d = new Date(l.t)
      day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      clock = d.toLocaleTimeString('zh-CN', { hour12: false })
    }
    // 跨天插一行居中的日期，长日志里翻起来有段落感
    if (day && day !== lastDay) {
      lastDay = day
      const dp = document.createElement('p')
      dp.className = 'day'
      dp.textContent = day
      out.push(dp)
    }
    const p = document.createElement('p')
    const cls = l.level === 'err' ? 'bad' : logClass(l.msg || '')
    if (cls) p.className = cls
    const t = document.createElement('time')
    t.textContent = clock
    // createTextNode 本身就是转义安全的，不能再套 escapeHtml（会变成 &lt; 显示出来）
    p.append(t, document.createTextNode(l.msg || ''))
    out.push(p)
  }
  if (!out.length) {
    const p = document.createElement('p')
    p.textContent = '还没有日志。'
    out.push(p)
  }
  box.replaceChildren(...out)
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
      if (b.dataset.tab === 'xian') loadXian()
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

  // 重启：主程序会 spawn 一个新进程再自杀，所以这里必然先看到连接断开，
  // 然后轮询 ping 直到新进程起来，再重新连接。
  $('btnRestart').onclick = async () => {
    const btn = $('btnRestart')
    btn.disabled = true
    $('statusline').textContent = '正在重启主程序…'
    // 旧进程退出到新进程监听之间有几百毫秒到两秒的空窗。
    // 这期间任何请求都会连接被拒（TypeError: Failed to fetch）：
    //   · alive = false        → 自动刷新不再发起新请求
    //   · restarting = true    → 点击前就已经在飞的请求失败后不写状态栏
    // 两者缺一不可，否则状态栏会被「读取状态失败」盖掉，看着像重启失败。
    alive = false
    restarting = true
    try {
      try { await cmd('restart') } catch { /* 旧进程可能来不及回包就退出了，忽略 */ }
      logSince = 0; logLines = []
      let up = false
      for (let i = 0; i < 40; i++) {          // 最多等 20 秒
        await new Promise((r) => setTimeout(r, 500))
        try { await api('/api/ping'); up = true; break } catch {}
      }
      if (up) {
        await connect()
        $('statusline').textContent = '已重启，加载的是最新代码'
      } else {
        $('statusline').textContent = '重启后 20 秒内没连上，请看 logs/host-*.log'
      }
    } finally {
      restarting = false
      btn.disabled = false
    }
  }

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

  // 修仙面板：开关和策略都直接写回配置（和「设置」页共用同一份 config）
  $('xRefresh').onclick = () => loadXian()
  $('xOnce').onclick = async () => {
    try { await cmd('once'); $('xStatus').textContent = '已请求巡视'; setTimeout(loadXian, 3000) }
    catch (e) { $('xStatus').textContent = e.message }
  }
  $('xEnabled').onchange = () => saveXianCfg((x) => { x.enabled = $('xEnabled').checked })
  $('xBreak').onchange = () => saveXianCfg((x) => { x.breakMode = $('xBreak').value })
  $('xFuse').onchange = () => saveXianCfg((x) => { x.autoFuse = $('xFuse').checked })

  $('cfgSave').onclick = async () => {    try {
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
    // 修仙页只在切过去时刷，免得平白多打本地请求
    if (!$('tab-xian').hidden && alive) await loadXian()
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
