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
let switching = false       // 正在「拉起主程序 + 开托管」：期间不按 config.enabled 回弹开关
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
    // 修仙页的 2.0 面板与游乐馆数据都在 /api/status 里，顺手渲染（元素隐藏时也安全）
    renderXian2()
    renderArcade()
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
  // 正在自动拉起时别按旧配置把开关弹回去：主程序还没起、config 还是上次的 false，
  // 弹回会让用户以为「点了没反应」，然后重复点。
  if (!switching) $('enabled').checked = enabled
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
  const v = status.vault
  $('vault').textContent = v && !v.error
    ? `Lv${v.lv} · ${v.used}/${v.slots} 格 · 单格 ${fmt(v.unit)}` + (v.lv < 4 ? ` · 升级 ${wan(v.nextCost)}` : '（满级）')
    : '—'
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

  $('earn').textContent = status.ledger.earn ? '+' + fmt(status.ledger.earn) : '0'
  $('spend').textContent = status.ledger.spend ? '−' + fmt(status.ledger.spend) : '0'
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
// 2.0 配招用的技能名（core/xian-rules.mjs 的 skill() 同一张表）
const SPELL_NAMES = {
  bolt: '灵弹', guard: '护体金光',
  fire1: '焚天环', fire2: '流火扇', water1: '千重浪', water2: '镜花水月',
  wood1: '万木春', wood2: '藤缚', metal1: '万剑归宗', metal2: '一线天',
  earth1: '山岳镇', earth2: '流沙', ice1: '千里冰封', ice2: '霜华',
  thunder1: '九天落雷', thunder2: '雷网', wind1: '青岚', wind2: '回风',
  lava1: '地火', lava2: '岩浆潮', poison1: '瘴雾', poison2: '蛊潮',
}
const MAT_NAMES = { xuantie: '玄铁', lingyu: '灵玉', yaodan: '妖丹' }
const FAV_NAMES = ['陌生', '熟识', '好友', '挚友', '知己']
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

// 修仙明细卡片的小工具：一行 label/value（可选 tooltip）
function xRow(label, value, title) {
  const d = document.createElement('div')
  d.className = 'card-row'
  const s = document.createElement('span')
  s.textContent = label
  const b = document.createElement('b')
  b.textContent = value
  d.append(s, b)
  if (title) d.title = title
  return d
}

// 技能槽的悬停明细。4 个槽的具体数值一行放不下，塞进 tooltip；
// 卡片上只保留「技能槽  A → B → C → D」一行，和改造前一致。
// （修仙没有装备系统，能「穿」的只有功法、技能槽和灵根。）
//
// 箭头不是「固定循环」，是优先级：战斗里每 0.1 秒从槽 1 开始找第一个
// 「冷却好且条件满足」的技能放（xian-rules.mjs:262），所以靠前的更常用，
// 槽 4 只在其他三个都冷却时才出场。托管的配招是枚举 24 种排列、
// 逐套模拟战斗挑出来的，所以这个顺序本身就是最优顺序。
function slotHint(slots) {
  if (!(slots || []).length) return ''
  return '按优先级从左到右：每次出手从槽 1 往后找第一个冷却好的技能，靠前的更常用。\n' +
    '（回血类在血量 75% 以上、护盾类在已有护盾时会跳过）\n' +
    '同门切磋和秘境战斗共用这套配招：\n' + slots.map((s) => {
      const nums = []
      if (s.dmg) nums.push(`伤害 ${s.dmg}`)
      if (s.shield) nums.push(`护盾 ${s.shield}`)
      if (s.heal) nums.push(`回血 ${s.heal}`)
      if (s.cd) nums.push(`冷却 ${s.cd}s`)
      if (s.cast) nums.push(`吟唱 ${s.cast}s`)
      return `· ${s.name}（${s.element}）${nums.length ? '　' + nums.join(' · ') : ''}`
    }).join('\n')
}

// 一条明细：lines 是若干行，每行是若干 { text, cls, bold } 片段。
// 用 DOM 拼而不是 innerHTML：存档里的 id 是服务端数据，不该当 HTML 解释。
function xItem(lines) {
  const el = document.createElement('div')
  el.className = 'xitem'
  for (const line of lines) {
    const p = document.createElement('div')
    for (const part of line) {
      if (part?.text == null || part.text === '') continue
      const s = document.createElement('span')
      if (part.cls) s.className = part.cls
      if (part.bold) {
        const b = document.createElement('b')
        b.textContent = part.text
        s.append(b)
      } else s.textContent = part.text
      p.append(s)
    }
    if (p.childNodes.length) el.append(p)
  }
  return el
}

// 修仙资料卡：战力/功法、灵根/融合、试炼、人脉、丹方、地里作物。
// 数据来自 xianSnapshot 的 detail 字段（全部按本地规则算，不额外发请求）。
// 修仙资料卡的缓存键。修仙页每 1.5 秒刷一次，每次重建列表都会把滚动位置
// 打回顶部（用户反馈「人脉一下拉就锁回去」）。detail 是纯展示数据，
// 内容没变就整个跳过重建。minLeft 是「还剩几秒」，每刷新一次都变，
// 但它只影响主卡片那行文字，不该触发列表重建。
let lastDetailKey = ''

function renderXianDetail(D) {
  const ids = ['xCombat', 'xRoots', 'xStages', 'xNpc', 'xRecipes', 'xCrops']
  if (!D) {
    $('xPlotDetail').textContent = '—'
    if (lastDetailKey === '') return
    lastDetailKey = ''
    for (const id of ids) $(id).replaceChildren()
    return
  }
  const key = JSON.stringify(D, (k, v) => (k === 'minLeft' ? undefined : v))
  if (key === lastDetailKey) return
  lastDetailKey = key

  // 真要重建时，也把每个列表的滚动位置带回去（按「父容器 id + 在父里的序号」定位）
  const scrolls = new Map()
  for (const el of document.querySelectorAll('#tab-xian .xlist')) {
    const p = el.parentElement
    if (!p?.id) continue
    scrolls.set(p.id + ':' + [...p.children].indexOf(el), el.scrollTop)
  }

  // ---------- 战力与功法 ----------
  const c = D.combat || {}
  const cv = D.cv || {}
  const combatRows = [
    xRow('战力', Number(c.power || 0).toFixed(2), '（境界 + 层数）× 灵根效率 × 功法倍率，和战斗模拟同一套'),
    xRow('气血', fmt(c.hp || 0)),
    xRow('灵根效率', '×' + (c.rootEffect ?? 1), '单灵根 ×1.5；多灵根 ×1'),
    xRow('修炼倍率', '×' + (c.cultivateMul ?? 1), '根数越少前期越快、越多后期越强；变异灵根每个再 +12%'),
    xRow('打坐加成', '×' + (c.meditateMul ?? 1), '心境越高、结为师父/道侣的人越多，打坐收益越高'),
    xRow('突破成功率', Math.round((c.breakRate ?? 0) * 100) + '%', '失败会掉 30% 修为、心境 −8；心情/气运越高越稳'),
    xRow('心境 / 气运', `${c.mind ?? 0} / ${c.luck ?? 0}`),
    // 突破成功时规则会把本层修为清零（xian-rules.mjs:97 的 c.xp=0），
    // 这是境界提升的代价，不是数据丢了。把规矩写在面板上。
    // 9 层时 layerNeed 就是 breakNeed，不必重复显示「满线」。
    xRow('本层修为', `${fmt(cv.xp ?? 0)} / ${fmt(cv.layerNeed ?? 0)}` +
      (cv.canBreak ? ' · 已满' : (cv.breakNeed !== cv.layerNeed ? `（满线 ${fmt(cv.breakNeed ?? 0)}）` : '')),
      '突破成功后境界 +1、本层修为从 0 重算（站点规则）；超出的部分也会一并清零。满线 = 该境界 9 层的突破线'),
    xRow('突破所需', `培元丹 ×${cv.pillsNeed ?? 0}（现有 ${cv.pillsHave ?? 0}）`,
      '修为到 9 层满线后，突破要吃掉 (境界+1) 颗培元丹'),
    xRow('今日斗法胜场', String(D.duelWins ?? 0)),
    xRow('技能槽', (c.slots || []).map((s) => s.name).join(' → ') || '—', slotHint(c.slots)),
  ]
  const techList = document.createElement('div')
  techList.className = 'xlist'
  for (const t of D.techs || []) {
    const full = t.layer >= t.maxLayer
    techList.append(xItem([
      [
        { text: t.name, bold: true },
        ...(t.main ? [{ text: ' 主修', cls: 'tag' }] : []),
        ...(t.main && D.equipToday ? [{ text: ' 今日已换（明日可再改）', cls: 'dim' }] : []),
        { text: `  ${t.element} · 第 ${t.layer}/${t.maxLayer} 层`, cls: 'dim' },
      ],
      [
        { text: `熟练 ${t.mastery}/${t.nextNeed}`, cls: 'dim' },
        { text: full ? ' · 已满层' : ` · 再 ${t.nextIn} 到下一层`, cls: full ? 'ok' : 'dim' },
        { text: `  ·  被动：${t.buff}`, cls: 'dim' },
      ],
      // 这部功法自带的两个技能（配招就是从所有已学功法的技能里挑 4 个）
      ...((t.spells || []).length
        ? [[{ text: `附带：${t.spells.join(' / ')}`, cls: 'dim' }]]
        : []),
    ]))
  }
  if (!(D.techs || []).length) techList.append(xItem([[{ text: '还没学功法（去藏经阁学一部）', cls: 'dim' }]]))
  $('xCombat').replaceChildren(...combatRows, techList)

  // ---------- 灵根与融合 ----------
  const R = D.roots || {}
  const rootRows = [
    xRow('基础灵根', (R.elements || []).map((e) => e.name).join(' ') || '—'),
    xRow('变异灵根', (R.variants || []).map((e) => e.name).join(' ') || '无'),
    xRow('根数', `${R.count ?? 0} 根`, '融合会减一根，且不可逆'),
    // 融合失败会让灵根震荡，24 小时内不能再试（xian-rules.mjs:101）
    xRow('融合冷却', R.fuseCdIn > 0 ? fmtSec(R.fuseCdIn) + '后可再试' : '无',
      '融合失败会掉 20% 修为并进入 24 小时冷却'),
  ]
  const fuseList = document.createElement('div')
  fuseList.className = 'xlist'
  for (const f of R.fusion || []) {
    fuseList.append(xItem([
      [
        { text: `${f.aName}+${f.bName} → ${f.name}灵根`, bold: true },
        { text: '  成功率 55%', cls: 'dim' },
      ],
      [{
        text: R.fusionReady ? '可融合：需培元丹 ×2 + 灵石 200' : '需筑基之后才能融合（当前未到）',
        cls: R.fusionReady ? 'ok' : 'dim',
      }],
    ]))
  }
  if (!(R.fusion || []).length) fuseList.append(xItem([[{ text: '当前灵根没有可融合的组合', cls: 'dim' }]]))
  $('xRoots').replaceChildren(...rootRows, fuseList)

  // ---------- 试炼 ----------
  const stageList = document.createElement('div')
  stageList.className = 'xlist'
  for (const st of D.stages || []) {
    stageList.append(xItem([
      [
        { text: st.name, bold: true },
        { text: st.cleared ? '  已首通' : '  未通关', cls: st.cleared ? 'ok' : 'dim' },
        { text: `  ${st.needRealm}可进 · 基础 ${st.stone} 灵石`, cls: 'dim' },
        ...(st.canEnter ? [] : [{ text: '  （境界不足）', cls: 'bad' }]),
      ],
      [{ text: '首通给培元丹 ×1；战斗是弹幕小游戏，托管不会提交，只能手动点', cls: 'dim' }],
    ]))
  }
  $('xStages').replaceChildren(stageList)

  // ---------- 人脉 ----------
  const rel = D.relations || []
  const tiers = [0, 0, 0, 0, 0]
  for (const r of rel) tiers[r.tier] = (tiers[r.tier] || 0) + 1
  const npcRows = [
    xRow('已结识', `${rel.length} 位`),
    xRow('好感分布', FAV_NAMES.map((n, i) => `${n} ${tiers[i] || 0}`).join(' · '), '好感：陌生 <100 · 熟识 100 · 好友 300 · 挚友 600 · 知己 900'),
  ]
  const npcList = document.createElement('div')
  npcList.className = 'xlist'
  for (const r of rel) {
    npcList.append(xItem([[
      { text: r.name, bold: true },
      ...(r.title ? [{ text: `  ${r.title}`, cls: 'dim' }] : []),
      { text: `  ${r.tierName} ${r.fav}`, cls: 'dim' },
      ...(r.relName ? [{ text: `  ${r.relName}`, cls: 'ok' }] : []),
      ...(r.chapters ? [{ text: `  往事 ${r.chapters} 章`, cls: 'dim' }] : []),
    ]]))
  }
  if (!rel.length) npcList.append(xItem([[{ text: '还没结识任何人', cls: 'dim' }]]))
  $('xNpc').replaceChildren(...npcRows, npcList)

  // ---------- 丹方 ----------
  const recList = document.createElement('div')
  recList.className = 'xlist'
  for (const p of D.recipes || []) {
    recList.append(xItem([
      [
        { text: p.name, bold: true },
        { text: p.can ? '  材料齐' : '  缺材料', cls: p.can ? 'ok' : 'bad' },
        { text: `  参考卖价 ${p.sell} 灵石`, cls: 'dim' },
      ],
      [{
        text: (p.need || []).map((n) => `${n.name} ${n.have}/${n.need}`).join(' · '),
        cls: 'dim',
      }],
      // 丹药效果（规则里 PILLS.desc）：回灵丹 +30 灵力、每日 3 颗；培元丹 +40 药园经验
      ...(p.desc ? [[{ text: p.desc, cls: 'dim' }]] : []),
    ]))
  }
  $('xRecipes').replaceChildren(recList)

  // ---------- 作物表 ----------
  // 规则常量，不随存档变；净赚 = 卖价 − 种子价（一次收获 1 株，每 4 个动作那次 +1）。
  const cropList = document.createElement('div')
  cropList.className = 'xlist'
  for (const c of D.crops || []) {
    cropList.append(xItem([[
      { text: c.name, bold: true },
      { text: `  种子 ${c.seed} → 卖 ${c.sell}`, cls: 'dim' },
      { text: `  净赚 ${c.profit}`, cls: c.profit > 0 ? 'ok' : 'dim' },
      { text: `  ${fmtSec(c.grow)} · Lv${c.lv} 解锁`, cls: 'dim' },
    ]]))
  }
  $('xCrops').replaceChildren(cropList)

  // ---------- 地里作物（按作物归组） ----------
  const ph = D.plotsByHerb || []
  $('xPlotDetail').textContent = ph.length
    ? ph.map((e) => `${e.name}×${e.count}` +
        (e.mature ? `（熟 ${e.mature}）` : '') +
        (e.dry ? `（待浇 ${e.dry}）` : '') +
        (e.minLeft != null ? `（最早 ${fmtSec(e.minLeft)}）` : '')).join(' · ')
    : '—'

  for (const el of document.querySelectorAll('#tab-xian .xlist')) {
    const p = el.parentElement
    if (!p?.id) continue
    const top = scrolls.get(p.id + ':' + [...p.children].indexOf(el))
    if (top) el.scrollTop = top
  }
}

function renderXian() {
  const x = xian
  const on = !!config?.xian?.enabled
  $('xEnabled').checked = on
  if (!x || !x.exists) {
    $('xStatus').textContent = x?.error ? '读取失败：' + x.error : '读取中…'
    for (const id of ['xRealm', 'xCv', 'xStone', 'xGarden', 'xEnergy', 'xCan', 'xPlots', 'xGround', 'xPlotDetail', 'xBag', 'xBrew', 'xMed', 'xTech', 'xWake',
      'xAssets', 'xAssetHerbs', 'xAssetPills', 'xAssetMats', 'xAssetHist', 'xAssetDaily', 'xAssetClears']) $(id).textContent = '—'
    renderXianDetail(null)   // 会同时清掉资料卡和 lastDetailKey 缓存
    return
  }
  $('xRealm').textContent = `${x.realm}${x.stage ? x.stage + ' 层' : ''}`
  const rootTxt = (x.roots || []).map((r) => nm(ROOT_NAMES, r)).join('')
  $('xCv').textContent = `修为 ${fmt(x.cvXp)}/${fmt(x.cvNeed)}｜${rootTxt || '无灵根'}灵根`
  $('xCv').title = '修为按「本境界本层」计。突破成功后境界 +1、本层修为从 0 重算（站点规则），不是数据丢了；' +
    '所以托管在修为攒满后会立刻突破，避免溢出部分被清零。'
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
    // 概览里的总数是估值（灵石 + 药材 + 种子 + 丹药 + 成熟作物），
    // 顺手把真正能立刻花的灵石数写出来，避免被 ≈ 的大数字误导。
    $('xAssets').textContent = `≈ ${fmt(a.total)} 灵石（实有 ${fmt(a.stone)}）`
    $('xAssets').title = `灵石 ${fmt(a.stone)} + 药材 ${fmt(a.bagValue)} + 种子 ${fmt(a.seedValue)}` +
      ` + 丹药 ${fmt(a.pillValue)}（参考价） + 成熟作物 ${fmt(a.groundValue)}`
    $('xAssetHerbs').textContent = `药材 ${a.bagQty} 件（可卖 ${fmt(a.bagValue)}）· 种子 ${a.seedQty} 包（成本 ${fmt(a.seedValue)}）`
    $('xAssetPills').textContent = `丹药 ${a.pillQty} 颗（参考 ${fmt(a.pillValue)}）· 地里 ${a.groundQty} 株 / 熟 ${a.groundMature}（可收 ${fmt(a.groundValue)}）`
    // 材料（玄铁/灵玉/妖丹）只在秘境掉，没有消耗途径，所以不进家底估值。
    // 2.0 卡片也有一行材料，这里再列一次是为了让「资源统计」自成一张完整清单。
    const mats = x.detail?.mats || {}
    $('xAssetMats').textContent = countList(mats, MAT_NAMES) || '—'
    $('xAssetMats').title = '秘境掉落的材料，等站点的「法宝炼器」开放后才用得上；现在只进不出，不算资产'
    const h = x.history || {}
    // h.actions 缺失说明主程序还是旧版（没重启），别假装是 0 次
    $('xAssetHist').textContent = h.actions == null ? '—' : `收获 ${fmt(h.harvests)} 次 · 动作 ${fmt(h.actions)} 次`
    // log 每成功一个动作 +1，收获时 log%4===3 多给 1 株（xian-rules.mjs:90）。
    $('xAssetHist').title = h.actions == null ? '' : h.bonusIn
      ? `累计值。规则里每 4 个动作的那次收获多给 1 株，再 ${h.bonusIn} 个动作进入双倍窗口`
      : '累计值。规则里每 4 个动作的那次收获多给 1 株，现在收获正好多 1 株'
    const d = x.daily || {}
    $('xAssetDaily').textContent = `${d.pillUse || 0}/${d.pillMax || 0} · ${d.fightUse || 0}/${d.fightMax || 0}` +
      (d.duelPrize ? `｜首胜奖励 ${d.duelPrize} 人` : '')
    $('xAssetDaily').title = '回灵丹每日 3 颗上限（丹毒）· 斗法每日场次上限；同门斗法每人每天只有首胜给灵石' +
      (d.duelPrizeNames?.length ? `\n今日已领：${d.duelPrizeNames.join('、')}` : '')
    $('xAssetClears').textContent = `${d.cleared || 0}/${d.stageTotal || 0} · 剧情 ${x.story || 0}/${x.storyTotal ?? '—'}`
  } else {
    for (const id of ['xAssets', 'xAssetHerbs', 'xAssetPills', 'xAssetMats', 'xAssetHist', 'xAssetDaily', 'xAssetClears']) $(id).textContent = '—'
  }

  // 资料卡：战力/功法、灵根/融合、试炼、人脉、丹方、地里作物
  renderXianDetail(x.detail)

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

// ---------- 渲染：修仙 2.0 与游乐馆（数据在 /api/status 里） ----------
function renderXian2() {
  const s = status?.xian2
  const ids = ['x2Sect', 'x2Stipend', 'x2Tasks', 'x2Talk', 'x2Ev', 'x2Duel', 'x2Realm', 'x2Areas', 'x2Slots', 'x2Mats']
  if (!s || s.error) { for (const id of ids) $(id).textContent = '—'; return }
  $('x2Sect').textContent = `${s.sect || '未入门'} · 心境 ${s.mind} · 气运 ${s.luck} · 声望 ${s.rep} · 贡献 ${s.ctb || 0}`
  $('x2Stipend').textContent = s.stipendDone ? '已领' : '待领'
  const tk = s.tasks || []
  $('x2Tasks').textContent = tk.length ? `${tk.filter((v) => v.done).length}/${tk.length} 已交` : '今天还没刷新'
  $('x2Tasks').title = tk.length
    ? '今日委托：\n' + tk.map((t) => `${t.done ? '✓' : '·'} ${t.label || '委托'}`).join('\n')
    : ''
  $('x2Talk').textContent = `${s.talks || 0}/${s.talksMax || 30} 位`
  const ev = s.ev || {}
  $('x2Ev').textContent = ev.pending
    ? '有事件待选（本轮会处理）'
    : `${ev.n || 0}/${ev.max || 3} 次` + (ev.gapIn > 0 ? ` · ${fmtSec(ev.gapIn)}后可再抽` : '')
  $('x2Duel').textContent = `${s.duels || 0}/${s.duelsMax || 8} 场`
  $('x2Realm').textContent = s.inRealm
    ? `探索中：${s.inRealm.area} 第 ${s.inRealm.floor || 1} 层（气血 ${Math.round(s.inRealm.hp)}/${s.inRealm.mx}）`
    : `${s.realms || 0}/${s.realmsMax || 3} 次`
  const areas = Object.values(s.areas || {})
  $('x2Areas').textContent = areas.length
    ? areas.map((a) => `${a.name}${a.cleared ? '✓' : a.unlocked ? '' : '🔒'}`).join(' · ')
    : '—'
  $('x2Slots').textContent = (s.slots || []).map((id) => nm(SPELL_NAMES, id)).join(' → ') || '默认（主修两式 + 灵弹 + 护体）'
  $('x2Mats').textContent = countList(s.mats, MAT_NAMES) || '—'
  // 材料现在还没有消耗途径：xs3.js 的说明写的是「秘境掉落，下一批『法宝』开放后用来炼器」。
  $('x2Mats').title = '秘境掉落的材料，等站点的「法宝炼器」开放后才用得上；现在只进不出，不算资产'
}

function renderArcade() {
  const a = status?.arcade
  const map = { pool: 'xArcPool', bowl: 'xArcBowl', bounce: 'xArcBounce' }
  for (const [g, id] of Object.entries(map)) {
    const v = a?.[g]
    if (!v) { $(id).textContent = '—'; continue }
    $(id).textContent = `今日剩 ${v.left}/${v.daily} · 今日最好 ${fmt(v.today)} · 个人纪录 ${fmt(v.best)}`
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
      'sell.markdownPct': '未来价折让 %',
      'sell.respectTiers': '遵守阶梯价',
    },
    hints: {
      'sell.horizonDays': '在这段时间内找最高价，决定现在卖还是等',
      'sell.outlookDays': '选作物、钓鱼挖矿、加工、投资都按这段时间的均价估算收益，而不是只看今天的价',
      'sell.markdownPct': '未来岛日的预测价先打这个折扣再和现价比，越大越倾向现在卖（6 ≈ 峰值要高出约 6.4% 才值得等）',
      'sell.respectTiers': '超出每日全价额度的部分留到明天卖，避免被压价',
    },
  },
  {
    title: '囤货仓库',
    fields: ['vault.enabled', 'vault.keepPeakAhead', 'vault.upgrade'],
    labels: { 'vault.enabled': '启用仓库', 'vault.keepPeakAhead': '峰值在几个岛日内就囤', 'vault.upgrade': '格位不够时自动升级' },
    hints: {
      'vault.enabled': '把「等涨更划算」的货锁进仓库，防止被管家低价卖掉',
      'vault.upgrade': '升到 2 级 18 格 / 3 级 22 格 / 4 级 30 格且单格翻倍，价格分别是 8 万 / 30 万 / 100 万 D 币',
    },
  },
  {
    title: '修仙 2.0',
    fields: ['xian2.enabled', 'xian2.realm', 'xian2.maxActions', 'xian2.realmBeam', 'xian2.loadoutMs'],
    labels: {
      'xian2.enabled': '启用修仙 2.0',
      'xian2.realm': '自动探索秘境',
      'xian2.maxActions': '每批最多动作数',
      'xian2.realmBeam': '秘境束搜索宽度',
      'xian2.loadoutMs': '配招搜索上限（毫秒）',
    },
    hints: {
      'xian2.enabled': '人脉叙话、赠礼、往事、机缘、宗门委托、配招、同门斗法、秘境',
      'xian2.realm': '关掉就不进秘境（每次耗灵力 15，每天 3 次；本地预演打得过才进）',
      'xian2.maxActions': '和 1.0 的动作共用一次提交，服务端单批上限 40',
      'xian2.realmBeam': '越大越可能找到高收益路线，但本地算得越慢',
      'xian2.loadoutMs': '枚举技能组合 × 出手顺序做本地模拟的时间上限',
    },
  },
  {
    title: '游乐馆',
    fields: ['arcade.enabled', 'arcade.perTick', 'arcade.solveMs'],
    labels: { 'arcade.enabled': '启用游乐馆', 'arcade.perTick': '每轮最多玩几局', 'arcade.solveMs': '每局求解上限（毫秒）' },
    hints: {
      'arcade.enabled': '弹弹乐 / 鲸鱼桌球 / 鲸鱼保龄，每天各 10 次；只写个人纪录和榜单，不发 D 币',
      'arcade.perTick': '求解要花几秒，每轮少玩几局避免拖慢主流程',
    },
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
    title: '52弟',
    fields: ['npc.enabled', 'npc.gomoku', 'npc.gomokuLevel', 'npc.gomokuBudgetMs', 'npc.card', 'npc.rps', 'npc.box'],
    labels: {
      'npc.enabled': '启用 52弟', 'npc.gomoku': '打五子棋', 'npc.gomokuLevel': '难度档位',
      'npc.gomokuBudgetMs': '每局思考上限', 'npc.card': '剩余额度抽牌', 'npc.rps': '剩余额度猜拳', 'npc.box': '剩余额度盲盒',
    },
    hints: {
      'npc.gomokuLevel': '1 简单×0.8 / 2 普通×1.2 / 3 困难×1.5',
      'npc.gomokuBudgetMs': '超过这个时间还没搜到必胜棋谱就跳过重开（毫秒）',
      'npc.card': '五子棋打完 10 局计奖后，剩下的额度用来抽牌（每次约 2,730 D，零成本）',
      'npc.rps': '抽牌未开时才会用；胜率 33%，每次计次约 2,705 D',
      'npc.box': '3 个请求一局，效率最低，默认关',
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
      if (b.dataset.tab === 'xian') { loadXian(); loadStatus().catch(() => {}) }
      if (b.dataset.tab === 'settings') loadConfig().catch(() => {})
    }
  })

  // 右上角总开关 = 一键开托管。
  //   · 没连上（主程序没在跑）→ 先用 Native Messaging 把它拉起来，再开托管。
  //     这就是原来 connBox 里那个「启动主程序」按钮干的事，现在并进开关里了。
  //   · 已经连上 → 只发 start。
  // 关掉只是暂停托管，不杀进程：杀进程会丢掉正在跑的轮次，也看不到日志；
  // 真要退出/重启进程，用「设置」页的按钮。
  $('enabled').onchange = async () => {
    if (!$('enabled').checked) {
      try { await cmd('stop'); await loadStatus() }
      catch (e) { $('statusline').textContent = e.message }
      return
    }
    if (alive) {
      try { await cmd('start'); await loadStatus() }
      catch (e) { $('statusline').textContent = e.message }
      return
    }
    await startProgram()
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
      // 最多等 60 秒：新进程要先加载规则模块（联网失败会退回缓存，最坏 30 秒）
      // 再拉世界状态；主程序那边还会盯 30 秒，新进程起不来就自己恢复监听。
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 500))
        try { await api('/api/ping'); up = true; break } catch {}
      }
      if (up) {
        await connect()
        $('statusline').textContent = '已重启，加载的是最新代码'
      } else {
        $('statusline').textContent = '重启超过 60 秒没连上，请看 logs/host-*.log'
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

  // 备用入口：和右上角开关走同一条流程（自动拉起失败时还有这个按钮可点）
  $('btnLaunch').onclick = () => { startProgram() }

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

/**
 * 拉起主程序：Native Messaging → 等端口就绪 → 连接 → 打开托管。
 *
 * 右上角总开关和 connBox 的「启动主程序」按钮都走这里。
 * 宿主会自己处理三种情况（native/yuyugu-host.mjs 的 launch）：
 *   · 端口已在监听 → 直接返回 running（不动现有进程）
 *   · 有 PID 但端口不通（进程僵死）→ 杀掉重起
 *   · 没在跑 → 新起一个
 * 所以「启动」和「重启」是同一个入口，不用单独判断。
 */
async function startProgram() {
  const sw = $('enabled')
  const btn = $('btnLaunch')
  const hint = $('launchHint')
  const say = (t) => {
    if (hint && !$('connBox').hidden) hint.textContent = t
    if (t) $('statusline').textContent = t
  }
  switching = true
  sw.disabled = true
  btn.disabled = true
  try {
    port = Number($('port').value) || 8787
    await chrome.storage.local.set({ port })
    say('正在启动主程序…')
    const res = await sendNative({ cmd: 'launch', port })
    if (!res?.ok) { say('启动失败：' + (res?.msg || '宿主没有响应')); return false }
    say(res.msg || '已启动')
    // launch 返回时主程序可能还在加载规则模块（联网失败会退回缓存，最坏 30 秒）
    let up = false
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500))
      try { await api('/api/ping'); up = true; break } catch { /* 还没起来 */ }
    }
    if (!up) { say('已启动但连不上，检查端口 ' + port); return false }
    await connect()
    // 主程序可能是上次 stop 掉的状态，补一次 start 才真的开始托管。
    // start 是幂等的（server.mjs 里只是 cfg.enabled = true），重复发无害。
    try { await cmd('start') } catch {}
    await loadStatus()
    return true
  } catch (e) {
    say('无法自动启动：' + e.message +
      '（需要先运行 node scripts/install-host.mjs --ext-id=' + chrome.runtime.id + '）')
    return false
  } finally {
    switching = false
    sw.disabled = false
    btn.disabled = false
    // 没连上就把开关弹回去，避免「开关开着但其实什么都没发生」。
    // 连上了但拿不到 config（状态请求失败）就保留用户点的状态，别自作主张。
    if (!alive) sw.checked = false
    else if (config) sw.checked = !!config.enabled
  }
}

function startAuto() {
  clearInterval(autoTimer)
  autoTimer = setInterval(async () => {
    if ($('logAuto').checked) await loadLogs()
    // 概览页要看到「正在做什么」和逐笔收支，1.5 秒刷一次
    if (!$('tab-overview').hidden && alive) await loadStatus()
    // 修仙页只在切过去时刷，免得平白多打本地请求
    if (!$('tab-xian').hidden && alive) { await loadXian(); await loadStatus() }
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
