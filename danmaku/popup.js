// 前台 GUI：只跟本地 Python 服务说话，不碰游戏页面。
// 所有识别/走位都在 Python 进程里，这里负责看状态和改设置。
//
// 本地服务没起来时，点「开始托管」会通过 Native Messaging 让宿主进程把它
// 拉起来，不用再手动双击 启动.bat。宿主没注册时（只在第一次需要），面板
// 会展开安装说明和本扩展的 ID。
'use strict';

const $ = (id) => document.getElementById(id);
const DEF_PORT = 8799;
let port = DEF_PORT;
let online = false;
let timer = null;
let logs = [];
let lastState = '';
let launching = false;      // 正在拉服务：期间别让轮询把提示语冲掉

// 在插件里用 chrome.storage；直接用浏览器打开 popup.html 调试时退回 localStorage
const hasChromeStore = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const hasChromeMsg = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage;
const EXT_ID = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || '';

function loadPrefs(cb) {
  if (hasChromeStore) chrome.storage.local.get({ port: DEF_PORT }, (v) => cb(v.port || DEF_PORT));
  else cb(parseInt(localStorage.getItem('dm_port'), 10) || DEF_PORT);
}
function savePrefs(v) {
  if (hasChromeStore) chrome.storage.local.set(v);
  else Object.keys(v).forEach((k) => localStorage.setItem('dm_' + k, v[k]));
}

const STATE_TXT = {
  idle: '待机',
  searching: '找斗法画面…',
  running: '托管中',
  ended: '本局结束',
  error: '出错',
};

function api(path, opt) {
  return fetch(`http://127.0.0.1:${port}${path}`, Object.assign({
    headers: { 'Content-Type': 'application/json' },
  }, opt)).then((r) => r.json());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function setOnline(v, why) {
  online = v;
  $('dot').className = 'dot' + (v ? ' on' : ' err');
  $('conn').classList.toggle('hide', v);
  if (!v) {
    $('state').textContent = '未连接';
    $('stateSub').textContent = why || '本地服务没起来，或端口不对';
  }
}

function setConnMsg(text) {
  $('connMsg').textContent = text;
}

/* ---------------- 自动拉起本地服务 ---------------- */
function ping(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const done = (v) => { clearTimeout(t); resolve(v); };
    const t = setTimeout(() => { try { ctl && ctl.abort(); } catch { /* 已结束 */ } done(false); }, timeoutMs);
    fetch(`http://127.0.0.1:${port}/api/ping`,
      ctl ? { cache: 'no-store', signal: ctl.signal } : { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => done(!!j && j.ok === true))
      .catch(() => done(false));
  });
}

// 交给 background 去调宿主：popup 一关，这里的连接就断了，
// 而 sendNativeMessage 断开会连宿主进程一起被 Chrome 收掉。
function hostCall(cmd, tries = 2) {
  return new Promise((resolve) => {
    if (!hasChromeMsg) {
      resolve({ ok: false, code: 'no-native', msg: '请从 chrome://extensions 里打开这个面板' });
      return;
    }
    const attempt = (left) => {
      try {
        chrome.runtime.sendMessage({ type: 'host', cmd, port }, (res) => {
          const err = chrome.runtime.lastError;
          // service worker 刚被唤醒时可能还没挂上 onMessage，重试一次
          if (err && left > 1) { setTimeout(() => attempt(left - 1), 250); return; }
          if (err) { resolve({ ok: false, code: 'no-host', msg: err.message }); return; }
          resolve(res && typeof res === 'object' ? res : { ok: false, msg: '后台没有回话' });
        });
      } catch (e) {
        resolve({ ok: false, code: 'no-host', msg: String((e && e.message) || e) });
      }
    };
    attempt(tries);
  });
}

/**
 * 确保本地服务在线：能连上就直接用，连不上就让宿主起一个。
 * @returns {{ok:boolean, started?:boolean, msg?:string, code?:string}}
 */
async function ensureServer() {
  if (await ping()) return { ok: true, started: false };

  launching = true;
  setConnMsg('正在启动本地识别服务…（首次要加载 cv2，约 2 秒）');
  let res;
  try {
    res = await hostCall('launch');
  } finally {
    launching = false;
  }

  if (!res || res.ok === false) {
    return { ok: false, code: res?.code || 'host', msg: res?.msg || '自动启动失败' };
  }
  // 宿主已经等到端口通了，这里再兜一下（它探活的是 TCP，ping 走的是 HTTP）
  for (let i = 0; i < 24; i++) {
    if (await ping(800)) return { ok: true, started: true };
    await sleep(250);
  }
  return { ok: false, code: 'timeout', msg: '服务进程起来了，但端口一直没有响应' };
}

function showStartError(r) {
  setOnline(false);
  const help = r.code === 'no-host' || r.code === 'no-native';
  $('connHelp').classList.toggle('hide', !help);
  if (help) {
    setConnMsg(EXT_ID
      ? '自动启动要先注册一次 Native 宿主，按下面这行跑一次就好。'
      : '自动启动要先注册一次 Native 宿主，按下面的说明做。');
    $('stateSub').textContent = '没找到 Native 宿主（' + (r.msg || '未安装') + '）';
  } else {
    setConnMsg('自动启动没成功：' + (r.msg || '未知原因'));
    $('stateSub').textContent = useManualHint(r.msg);
  }
}

function useManualHint(msg) {
  return (msg || '') + '　（也可以手动双击 danmaku\\启动.bat 先起服务）';
}

function fmtTime(s) {
  if (!s) return '—';
  const m = Math.floor(s / 60);
  return m ? `${m} 分 ${Math.round(s % 60)} 秒` : `${Math.round(s)} 秒`;
}

function paint(st) {
  const s = st.state;
  $('state').textContent = s === 'running'
    ? (st.dry ? '托管中（演练）' : '托管中')
    : (STATE_TXT[s] || s);
  $('stateSub').textContent = st.message || (st.boss ? 'Boss 战中' : (st.running ? '巡视中' : '等你去开一局'));
  $('dot').className = 'dot' + (s === 'running' ? ' busy' : s === 'ended' ? ' err' : ' on');

  const running = !!st.running && s !== 'ended';
  $('toggle').textContent = running ? '停止' : '开始托管';
  $('toggle').classList.toggle('stop', running);

  $('kBullets').textContent = st.bullets ?? 0;
  $('kHaz').textContent = st.hazards ?? 0;
  $('kLas').textContent = st.lasers ?? 0;
  $('kClr').textContent = st.clearance > 900 ? '∞' : (st.clearance ?? '—');
  $('kHits').textContent = st.hits ?? 0;
  $('kBombs').textContent = st.bombs ?? 0;
  $('kBoss').textContent = st.boss ? `血条 ${Math.round((st.hp || 0) * 100)}%` : '—';
  $('hpFill').style.width = `${Math.round((st.hp || 0) * 100)}%`;
  $('kFps').textContent = st.fps ? `${st.fps.toFixed(1)} fps` : '—';
  $('kTime').textContent = `${fmtTime(st.elapsed)} / ${st.frames || 0}`;
  $('kField').textContent = st.field
    ? `${Math.round(st.field.w)}×${Math.round(st.field.h)} @ ${Math.round(st.field.x)},${Math.round(st.field.y)}`
    : '未找到';

  if (Array.isArray(st.logs)) logs = st.logs;
  paintLogs();

  if (s !== lastState) {
    lastState = s;
    if (s === 'ended' && st.message) $('stateSub').textContent = st.message;
  }
}

function paintLogs() {
  const box = $('logs');
  if (!logs.length) {
    box.innerHTML = '<li class="empty">还没有日志</li>';
    return;
  }
  const rows = logs.slice(-60).reverse();
  box.innerHTML = rows.map((l) => {
    const d = new Date((l.t || 0) * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const cls = l.level === 'warn' || l.level === 'err' ? l.level : '';
    return `<li><span class="t">${hh}:${mm}:${ss}</span><span class="${cls}">${esc(l.msg)}</span></li>`;
  }).join('');
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function poll() {
  if (launching) return;            // 拉起过程中别覆盖提示语
  api('/api/status').then((st) => {
    if (!st || st.ok !== true) throw new Error('bad status');
    if (!online) setOnline(true);
    paint(st);
  }).catch(() => {
    if (online || $('conn').classList.contains('hide')) setOnline(false);
    $('dot').className = 'dot err';
  });
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(poll, 800);
  poll();
}

// ---------------- 交互 ----------------
$('toggle').addEventListener('click', async () => {
  const stopping = $('toggle').classList.contains('stop');
  $('toggle').disabled = true;
  try {
    if (stopping) {
      const st = await api('/api/stop', { method: 'POST', body: '{}' });
      if (st && st.ok !== false) paint(st);
      return;
    }
    // 开始：服务不在就先让宿主拉起来，再点它自己的开始
    const r = await ensureServer();
    if (!r.ok) { showStartError(r); return; }
    const st = await api('/api/start', { method: 'POST', body: '{}' });
    if (st && st.ok !== false) {
      $('connHelp').classList.add('hide');
      setOnline(true);
      paint(st);
    }
  } catch {
    setOnline(false, '本地服务没响应，点「重连」再试');
  } finally {
    $('toggle').disabled = false;
  }
});

$('retry').addEventListener('click', async () => {
  const v = parseInt($('port').value, 10);
  if (!(v >= 1024 && v <= 65535)) return;
  port = v;
  savePrefs({ port });
  $('retry').disabled = true;
  try {
    const r = await ensureServer();
    if (!r.ok) showStartError(r);
    else startPolling();
  } finally {
    $('retry').disabled = false;
  }
});

$('clearLogs').addEventListener('click', () => {
  logs = [];
  paintLogs();
});

function pushCfg(patch) {
  api('/api/config', { method: 'POST', body: JSON.stringify(patch) })
    .then((r) => { if (r && r.config) paintCfg(r.config); })
    .catch(() => setOnline(false));
}

function paintCfg(c) {
  $('cfgDry').checked = !!c.dry;
  $('cfgBomb').checked = !!c.bomb;
  $('cfgHorizon').value = String(c.horizon);
  $('cfgReaction').value = String(c.reaction);
  $('cfgFps').value = String(c.fps);
}

$('cfgDry').addEventListener('change', (e) => pushCfg({ dry: e.target.checked }));
$('cfgBomb').addEventListener('change', (e) => pushCfg({ bomb: e.target.checked }));
$('cfgHorizon').addEventListener('change', (e) => pushCfg({ horizon: parseFloat(e.target.value) }));
$('cfgReaction').addEventListener('change', (e) => pushCfg({ reaction: parseFloat(e.target.value) }));
$('cfgFps').addEventListener('change', (e) => pushCfg({ fps: parseInt(e.target.value, 10) }));

// 安装说明里要带上本扩展的 ID（未打包加载时由目录决定，复制过去即可）
$('extId').textContent = EXT_ID || '（从 chrome://extensions 里看）';
$('installCmd').textContent =
  `python python\\install_host.py --ext-id=${EXT_ID || '<把上面的ID粘过来>'}`;

loadPrefs((v) => {
  port = v;
  $('port').value = port;
  savePrefs({ port });
  startPolling();
  // 把服务器当前的配置拉到界面上
  api('/api/config').then((r) => { if (r && r.config) paintCfg(r.config); }).catch(() => {});
});
