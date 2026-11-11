// 内容脚本：把 page.mjs 注入站点页面，并在页面与插件存储之间转发消息。
// 页面端负责全部游戏逻辑；这里只做桥接：配置 / 指令下发，状态 / 日志 / 账本落到 chrome.storage.local。
(() => {
  if (window.top !== window || window.__yygBridge) return
  window.__yygBridge = true
  const OUT = 'yyg-ext', IN = 'yyg-page', MAX_LOG = 1500, MAX_LEDGER = 24 * 60
  const post = (type, data = {}) => window.postMessage({ src: OUT, type, ...data }, location.origin)
  const alive = () => { try { return !!chrome.runtime?.id } catch { return false } }
  // 插件被重新加载 / 停用后，旧内容脚本的 chrome.* 全部失效：通知页面端停下，避免没人管的托管继续跑
  const guard = (fn) => (...a) => { if (!alive()) { post('dead'); return } try { return fn(...a) } catch { post('dead') } }

  let logs = null, logTimer = 0, pending = []
  const flushLogs = guard(async () => {
    logTimer = 0
    if (!logs) logs = (await chrome.storage.local.get('logs')).logs || []
    logs.push(...pending); pending = []
    if (logs.length > MAX_LOG) logs = logs.slice(-MAX_LOG)
    await chrome.storage.local.set({ logs })
  })
  // 从已保存的日志里把今天的收入 / 支出 / 税加出来，给页面端补账（插件更新前的记录也能算上）
  const num = (re, l) => { const m = re.exec(l); return m ? Number(m[1].replace(/,/g, '')) : 0 }
  const sendSeed = guard(async () => {
    const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10), seed = { day, earn: 0, spend: 0, tax: 0 }
    for (const l of (await chrome.storage.local.get('logs')).logs || []) {
      if (!l.startsWith(day)) continue
      if (/ 第 \d+ 轮：/.test(l)) { seed.earn += num(/｜收入 ([\d,]+)/, l); seed.spend += num(/｜支出 ([\d,]+)/, l); seed.tax += num(/已扣税 ([\d,]+)/, l) }
      else if (/五子棋赢了/.test(l)) seed.earn += num(/：\+([\d,]+) D币/, l)
    }
    post('seed', { seed })
  })
  const sendConfig = guard(async () => { await sendSeed(); post('config', { cfg: (await chrome.storage.local.get('cfg')).cfg || {} }) })

  window.addEventListener('message', guard((e) => {
    if (e.source !== window || e.data?.src !== IN) return
    const d = e.data
    if (d.type === 'ready') sendConfig()
    else if (d.type === 'status') chrome.storage.local.set({ status: d.status })
    else if (d.type === 'log') { pending.push(d.line); if (!logTimer) logTimer = setTimeout(flushLogs, 400) }
    else if (d.type === 'ledger') chrome.storage.local.get('ledger').then((s) => chrome.storage.local.set({ ledger: [...(s.ledger || []), d.row].slice(-MAX_LEDGER) }))
  }))
  chrome.storage.onChanged.addListener(guard((changes, area) => {
    if (area !== 'local') return
    if (changes.cfg) sendConfig()
    if (changes.cmd?.newValue) post('cmd', { cmd: changes.cmd.newValue.name })
    if (changes.logs && !changes.logs.newValue) logs = [] // 弹窗里点了「清空日志」
  }))

  const s = document.createElement('script')
  s.type = 'module'
  s.src = chrome.runtime.getURL('page.mjs') + '?t=' + Date.now() // 带时间戳：插件重新加载后同一页面里能重新执行
  s.onload = () => s.remove()
  ;(document.head || document.documentElement).append(s)
})()
