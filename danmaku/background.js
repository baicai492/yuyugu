// Service worker：图标角标 + 转发 Native Messaging 调用。
//
// 为什么宿主调用要放在这里而不是 popup：sendNativeMessage 是一次性的
// （Chrome 起宿主进程 → 发一条消息 → 收回复 → 杀掉它）。如果放在 popup 里，
// 用户点完「开始托管」顺手关掉面板，连接一断 Chrome 可能连宿主一起杀掉，
// Python 服务就起不来了。service worker 在处理 onMessage 期间是保活的。
'use strict';

const DEF_PORT = 8799;
const HOST_NAME = 'com.baicai492.danmaku';
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

/* ---------------- Native Messaging ---------------- */
function hostCall(cmd, p) {
  return new Promise((resolve) => {
    if (!chrome.runtime.sendNativeMessage) {
      resolve({ ok: false, code: 'no-native', msg: '这个浏览器不支持 nativeMessaging' });
      return;
    }
    try {
      chrome.runtime.sendNativeMessage(HOST_NAME, { cmd, port: p }, (res) => {
        // 宿主没注册 / 清单 allowed_origins 对不上，都会走这里
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, code: 'no-host', msg: err.message || 'Native host 未安装' });
          return;
        }
        resolve(res && typeof res === 'object' ? res : { ok: false, msg: '宿主没有回话' });
      });
    } catch (e) {
      resolve({ ok: false, code: 'no-host', msg: String((e && e.message) || e) });
    }
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'host') return undefined;
  hostCall(msg.cmd, msg.port || port).then(sendResponse);
  return true;                     // 异步回应，别让通道提前关闭
});

chrome.runtime.onInstalled.addListener(refresh);
chrome.alarms?.create('tick', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener(refresh);
chrome.action.onClicked?.addListener(refresh);
