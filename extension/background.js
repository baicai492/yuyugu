// 后台 service worker：托管逻辑跑在站点标签页里，这里只负责「保活」和角标。
// 托管开着但没有任何页面在上报心跳时，开一个固定的后台标签页（或刷新它）。
const SITE = 'https://52dmeme.com', STALE_MS = 150 * 1000

async function keeper() {
  const { cfg = {}, status, keepTab } = await chrome.storage.local.get(['cfg', 'status', 'keepTab'])
  await badge(cfg, status)
  if (!cfg.enabled || cfg.autoTab === false) return
  if (status?.at && Date.now() - status.at < STALE_MS) return
  let tab = null
  if (keepTab) { try { tab = await chrome.tabs.get(keepTab) } catch {} }
  if (tab && tab.url?.startsWith(SITE)) { await chrome.tabs.reload(tab.id); return }
  tab = await chrome.tabs.create({ url: SITE + '/pets', active: false, pinned: true })
  try { await chrome.tabs.update(tab.id, { autoDiscardable: false }) } catch {}
  await chrome.storage.local.set({ keepTab: tab.id })
}

async function badge(cfg, status) {
  const stale = !status?.at || Date.now() - status.at > STALE_MS
  const [text, color] = !cfg?.enabled ? ['', '#888888'] : stale ? ['…', '#888888'] : status.state === 'auth' || status.state === 'error' ? ['!', '#d93025'] : cfg.dry ? ['演', '#b06000'] : ['ON', '#188038']
  await chrome.action.setBadgeText({ text })
  await chrome.action.setBadgeBackgroundColor({ color })
}

const arm = () => chrome.alarms.create('keeper', { periodInMinutes: 1 })
chrome.runtime.onInstalled.addListener(() => { arm(); keeper() })
chrome.runtime.onStartup.addListener(() => { arm(); keeper() })
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'keeper') keeper() })
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.cfg) keeper()
  else if (changes.status) chrome.storage.local.get('cfg').then(({ cfg }) => badge(cfg, changes.status.newValue))
})
