// 前台 GUI：只跟本地 Python 服务说话，不碰游戏页面。
// 所有识别/走位都在 Python 进程里，这里负责看状态和改设置。
'use strict';

const $ = (id) => document.getElementById(id);
const DEF_PORT = 8799;
let port = DEF_PORT;
let online = false;
let timer = null;
let logs = [];
let lastState = '';

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

function setOnline(v, why) {
  online = v;
  $('dot').className = 'dot' + (v ? ' on' : ' err');
  $('conn').classList.toggle('hide', v);
  if (!v) {
    $('state').textContent = '未连接';
    $('stateSub').textContent = why || '本地服务没起来，或端口不对';
  }
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
$('toggle').addEventListener('click', () => {
  const stopping = $('toggle').classList.contains('stop');
  $('toggle').disabled = true;
  api(stopping ? '/api/stop' : '/api/start', { method: 'POST', body: '{}' })
    .then((st) => { if (st && st.ok !== false) paint(st); })
    .catch(() => setOnline(false))
    .finally(() => { $('toggle').disabled = false; });
});

$('retry').addEventListener('click', () => {
  const v = parseInt($('port').value, 10);
  if (v >= 1024 && v <= 65535) {
    port = v;
    chrome.storage.local.set({ port });
    startPolling();
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

chrome.storage.local.get({ port: DEF_PORT }, (v) => {
  port = v.port || DEF_PORT;
  $('port').value = port;
  chrome.storage.local.set({ port });
  startPolling();
  // 把服务器当前的配置拉到界面上
  api('/api/config').then((r) => { if (r && r.config) paintCfg(r.config); }).catch(() => {});
});
