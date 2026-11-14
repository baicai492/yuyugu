// 内容脚本：只做一件事 —— 盯着「斗法」画布，把它的屏幕位置报给本地 Python 服务。
//
// 图像识别本身不依赖这个上报（Python 会自己在屏幕上找那圈棕色边框），
// 上报只是让首次定位少扫一块，顺便让插件知道「现在有斗法画面」。
// 所以坐标算个大概就行：算错了 Python 会退回全屏扫描。
(function () {
  'use strict';

  const DEF_PORT = 8799;
  let port = DEF_PORT;
  let last = null;          // 上一次上报的矩形，用来去抖
  let lastAt = 0;
  let reported = false;     // 当前是否已经报过「找到了」

  chrome.storage.local.get({ port: DEF_PORT }, (v) => {
    if (v && v.port) port = v.port;
  });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.port && ch.port.newValue) port = ch.port.newValue;
  });

  function canvasRect() {
    const cv = document.querySelector('.xs-dm-cv');
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    if (r.width < 160 || r.height < 200) return null;
    // 视口左上角在屏幕上的位置（Chrome 只在上边有工具栏）。都按 CSS 像素
    // 上报，dpr 单独带上，由 Python 那边换算成物理像素。
    const chromeH = Math.max(0, window.outerHeight - window.innerHeight);
    const chromeW = Math.max(0, window.outerWidth - window.innerWidth);
    return {
      x: window.screenX + chromeW / 2 + r.left,
      y: window.screenY + chromeH + r.top,
      w: r.width,
      h: r.height,
      dpr: window.devicePixelRatio || 1,
    };
  }

  function post(rect) {
    const body = JSON.stringify(rect || { found: false });
    fetch('http://127.0.0.1:' + port + '/api/hint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {});
  }

  function tick() {
    const rect = canvasRect();
    const now = Date.now();
    if (!rect) {
      if (reported) { post(null); reported = false; last = null; }
      return;
    }
    reported = true;
    const moved = !last || Math.abs(rect.x - last.x) > 2 || Math.abs(rect.y - last.y) > 2
      || Math.abs(rect.w - last.w) > 2 || Math.abs(rect.h - last.h) > 2;
    if (moved || now - lastAt > 3000) {
      last = rect;
      lastAt = now;
      post(rect);
    }
  }

  setInterval(tick, 700);
  tick();
})();
