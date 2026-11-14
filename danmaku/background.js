// Service worker：只负责图标角标，别的都在 popup 和本地 Python 里。
'use strict';

const DEF_PORT = 8799;
let port = DEF_PORT;

chrome.storage.local.get({ port: DEF_PORT }, (v) => {
  if (v && v.port) port = v.port;
});
chrome.storage.onChanged.addListener((ch) => {
  if (ch.port && ch.port.newValue) port = ch.port.newValue;
});

function badge(text, color) {
  chrome.action.setBadgeText({ text: text || '' });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

async function refresh() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { cache: 'no-store' });
    const st = await r.json();
    if (st.state === 'running') badge(st.dry ? '演' : '跑', '#b77732');
    else if (st.state === 'ended') badge('完', '#2b7a58');
    else badge('待', '#7a6a58');
  } catch {
    badge('', null);
  }
}

chrome.runtime.onInstalled.addListener(refresh);
chrome.alarms?.create('tick', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener(refresh);
chrome.action.onClicked?.addListener(refresh);
