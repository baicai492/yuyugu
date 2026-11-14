// 离线斗法的浏览器桥：起一个静态站点 + 一个 headless Chrome，通过 stdin/stdout
// 用一行一条 JSON 跟 Python 说话。
//
//   {"op":"open","url":"...","w":1200,"h":900}   ← 起页面
//   {"op":"shot","clip":[x,y,w,h]?}              → {png:"<base64>"}
//   {"op":"move","x":..,"y":..}                  ← 派发 pointermove（页面坐标）
//   {"op":"key","key":"p"}                       ← 派发 keydown/keyup
//   {"op":"eval","js":"..."}                     → {v:...}
//   {"op":"close"}
//
// 为什么是 CDP 而不是 playwright：Node 24 自带 WebSocket，Chrome 本机就有，
// 这条链路零依赖。抓屏走 Page.captureScreenshot —— 和 mss 抓屏幕一样是
// 「把渲染结果变成像素」，只是换成从浏览器里拿。
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';

const ROOT = resolve(import.meta.dirname);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/* ---------------- 静态站点 ---------------- */
function serve() {
  return new Promise((ok) => {
    const srv = createServer(async (req, res) => {
      const u = decodeURIComponent((req.url || '/').split('?')[0]);
      const p = normalize(join(ROOT, u === '/' ? '/index.html' : u));
      if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      try {
        const buf = await readFile(p);
        res.writeHead(200, {
          'Content-Type': MIME[extname(p).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(buf);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port }));
  });
}

/* ---------------- Chrome / CDP ---------------- */
// Chrome 157 起不再往 stderr 打 "DevTools listening on …"，
// 所以改成自己挑一个空闲端口、启动后轮询 /json/version 拿 ws 地址。
function freePort() {
  return new Promise((ok, bad) => {
    const srv = createNetServer();
    srv.on('error', bad);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => ok(p));
    });
  });
}

const CHROME_CANDS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

async function launchChrome() {
  // 用户目录放项目里（不写系统盘），每次一个随机子目录，退出时删掉
  const dir = mkdtempSync(join(ROOT, '_profile-'));
  const port = await freePort();
  const args = [
    '--headless=new',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    '--window-size=1200,900',
    '--user-data-dir=' + dir,
    '--remote-debugging-port=' + port,
    'about:blank',
  ];
  let lastErr = null;
  for (const exe of CHROME_CANDS) {
    try {
      const proc = spawn(exe, args, { stdio: 'ignore', detached: false });
      const wsUrl = await waitDevtools(port, 12000);
      if (wsUrl) return { proc, wsUrl, dir };
      proc.kill();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('启动 Chrome 失败：' + (lastErr ? lastErr.message : '不在已知路径，可用 CHROME_PATH 指定'));
}

async function waitDevtools(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.waiting.has(msg.id)) {
        const { ok, bad } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? bad(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const body = { id, method, params };
    if (sessionId) body.sessionId = sessionId;
    return new Promise((ok, bad) => {
      this.waiting.set(id, { ok, bad });
      this.ws.send(JSON.stringify(body));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  once(method, timeout = 15000) {
    return new Promise((ok, bad) => {
      const timer = setTimeout(() => bad(new Error('等待 ' + method + ' 超时')), timeout);
      this.on(method, (p) => { clearTimeout(timer); ok(p); });
    });
  }
}

/* ---------------- 主流程 ---------------- */
let chrome, cdp, SID, pageUrl, sitePort;

// ---------------- 屏幕流（screencast） ----------------
// captureScreenshot 每次都要「渲染 → 编码 JPEG → base64」，900x880 实测 130ms，
// 比真实抓屏（17ms）还慢，跑出来的帧率会严重失真。
// Page.startScreencast 是浏览器自己推帧：画出新的一帧就发一张 JPEG，
// 收帧方 ack 后它才继续。等于把 mss 的「抓最新一帧」搬到浏览器里，取帧几乎不花时间。
const cast = { on: false, frame: null, seq: 0, sent: 0, acked: 0, w: 0, h: 0 };

function startCast(w, h, quality = 80) {
  cast.on = true;
  cast.frame = null;
  cast.seq = 0;
  cast.w = w;
  cast.h = h;
  cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
    cast.frame = data;
    cast.seq++;
    if (metadata && metadata.deviceWidth) { cast.w = metadata.deviceWidth; cast.h = metadata.deviceHeight; }
    cdp.send('Page.screencastFrameAck', { sessionId }, SID).catch(() => {});
  });
  return cdp.send('Page.startScreencast',
    { format: 'jpeg', quality, maxWidth: w, maxHeight: h, everyNthFrame: 1 }, SID)
    .then(() => ({ w: cast.w, h: cast.h }));
}

async function ensureSite() {
  if (sitePort) return sitePort;
  const s = await serve();
  globalThis.SITE = s;
  sitePort = s.port;
  return sitePort;
}

async function openPage(url, w, h) {
  const port = await ensureSite();
  // 允许传相对路径（/index.html?stage=demon），端口由 bridge 自己拼
  if (url.startsWith('/')) url = 'http://127.0.0.1:' + port + url;
  if (!chrome) {
    chrome = await launchChrome();
    // 从 browser 级 ws 里新建一个 target，拿到它的 session
    const ws = new WebSocket(chrome.wsUrl);
    await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
    cdp = new CDP(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    SID = sessionId;
    cdp.on('Target.detachedFromTarget', () => { SID = null; });
  }
  await cdp.send('Page.enable', {}, SID);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: w, height: h, deviceScaleFactor: 1, mobile: false }, SID);
  await cdp.send('Runtime.enable', {}, SID);
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url }, SID);
  await loaded.catch(() => {});
  pageUrl = url;
}

async function evaluate(js) {
  const r = await cdp.send('Runtime.evaluate',
    { expression: js, returnByValue: true, awaitPromise: true }, SID);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval 失败');
  return r.result.value;
}

async function shot(clip, quality = 85) {
  // JPEG 而不是 PNG：1200x900 的 PNG 编码要 300ms，JPEG 只要 20ms 上下。
  // 这里要的就是「给识别器看的像素」，不需要无损。
  const params = { format: 'jpeg', quality, captureBeyondViewport: false };
  if (clip) {
    params.clip = { x: clip[0], y: clip[1], width: clip[2], height: clip[3], scale: 1 };
  }
  const { data } = await cdp.send('Page.captureScreenshot', params, SID);
  return data;
}

const MOVE_JS = (x, y) => `(() => {
  const cv = document.querySelector('.xs-dm-cv');
  if (!cv) return { ok: false, err: 'no canvas' };
  cv.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true, clientX: ${x}, clientY: ${y}, pointerType: 'mouse',
  }));
  return { ok: true };
})()`;

const KEY_JS = (k) => `(() => {
  for (const t of ['keydown', 'keyup']) {
    window.dispatchEvent(new KeyboardEvent(t, { key: ${JSON.stringify(k)}, bubbles: true }));
  }
  return { ok: true };
})()`;

async function handle(req) {
  switch (req.op) {
    case 'open':
      await openPage(req.url, req.w || 1200, req.h || 900);
      return { ok: true };
    case 'cast':
      return { ok: true, ...(await startCast(req.w || 900, req.h || 880, req.quality)) };
    case 'frame': {
      // 等到比 since 更新的一帧；超时就返回现有的（和 LiveFeed 一个语义）
      const t0 = Date.now();
      while (cast.seq <= (req.since || 0) && Date.now() - t0 < (req.timeoutMs || 400)) {
        await new Promise((r) => setTimeout(r, 2));
      }
      if (!cast.frame) return { ok: false, err: '还没有收到画面（screencast 没开？）' };
      return { ok: true, seq: cast.seq, w: cast.w, h: cast.h, jpg: cast.frame };
    }
    case 'url':
      return { ok: true, v: pageUrl };
    case 'shot':
      return { ok: true, png: await shot(req.clip) };
    case 'move':
      return await evaluate(MOVE_JS(Math.round(req.x), Math.round(req.y)));
    case 'key':
      return await evaluate(KEY_JS(req.key));
    case 'eval':
      return { ok: true, v: await evaluate(req.js) };
    case 'close':
      return { ok: true, stop: true };
    default:
      return { ok: false, err: 'unknown op: ' + req.op };
  }
}

async function main() {
  const rl = createInterface({ input: process.stdin });
  const pending = [];
  rl.on('line', async (line) => {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    try {
      const res = await handle(req);
      process.stdout.write(JSON.stringify({ id: req.id, ...res }) + '\n');
      if (res.stop) setTimeout(() => cleanup(0), 50);
    } catch (e) {
      process.stdout.write(JSON.stringify({ id: req.id, ok: false, err: String(e.message || e) }) + '\n');
    }
  });
  // Python 那边崩了/被 Ctrl-C，stdin 就关了。不接这一条的话 Node 会继续活着，
  // Chrome 也跟着活着，下一轮起新的桥就抢不到资源。
  rl.on('close', () => cleanup(0));
}

function cleanup(code) {
  // Windows 上 proc.kill() 只杀父进程，gpu/renderer 子进程会变成孤儿一直留在
  // 任务管理器里（实测跑几十轮后攒了 300 多个 chrome.exe，把桥都挤崩了）。
  // 用 taskkill /T 连带整棵进程树一起收掉。
  try {
    if (chrome && process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(chrome.proc.pid), '/t', '/f'],
                { stdio: 'ignore' });
    } else if (chrome) {
      chrome.proc.kill();
    }
  } catch {}
  try {
    chrome && rmSync(chrome.dir, {
      recursive: true, force: true, maxRetries: 20, retryDelay: 100,
    });
  } catch {}
  try { globalThis.SITE && globalThis.SITE.srv.close(); } catch {}
  process.exit(code);
}

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
process.on('exit', () => { try { chrome && chrome.proc.kill(); } catch {} });
main();
