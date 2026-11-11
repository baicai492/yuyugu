// 只做一件事：记住本地服务地址，并定期探活以更新图标角标。
const DEFAULT_PORT = 8787

async function getPort() {
  const { port } = await chrome.storage.local.get(['port'])
  return Number(port) || DEFAULT_PORT
}

async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { cache: 'no-store' })
    if (!r.ok) return false
    const j = await r.json()
    return !!j.ok
  } catch { return false }
}

async function refreshBadge() {
  const port = await getPort()
  const alive = await ping(port)
  await chrome.action.setBadgeText({ text: alive ? '' : '×' })
  await chrome.action.setBadgeBackgroundColor({ color: alive ? '#128a7a' : '#c9382c' })
  await chrome.action.setTitle({ title: alive ? '鱼鱼谷托管（已连接）' : '鱼鱼谷托管（主程序未运行）' })
  await chrome.storage.local.set({ alive, checkedAt: Date.now() })
  return alive
}

chrome.runtime.onInstalled.addListener(() => { refreshBadge() })
chrome.runtime.onStartup.addListener(() => { refreshBadge() })
chrome.alarms?.create?.('ping', { periodInMinutes: 0.5 })
chrome.alarms?.onAlarm?.addListener((a) => { if (a.name === 'ping') refreshBadge() })

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'ping') { refreshBadge().then((alive) => sendResponse({ alive })); return true }
})
