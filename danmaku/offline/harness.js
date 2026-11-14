// 离线跑真实的 danmaku.js：只替换「进游戏之前的世界」——不走小岛、不走接口，
// 直接 playDanmaku。关卡、贴图、HUD、判定全部是线上那一份，一个字节都没改。
//
// URL 参数：
//   stage=secret|demon|sword   关卡（默认 secret）
//   tech=fire|water|...        功法（只影响自机子弹外观和符卡特效）
//   lives=3 bombs=2            命数与符卡
//   xsdebug=1                  打开游戏自带的调试钩子 window.__dm（真值：弹位/自机/Boss）
//
// 页面里不写任何测试逻辑：真值来自 danmaku.js:277 自己的 __dm。
import { playDanmaku } from './danmaku.js';

const q = new URLSearchParams(location.search);
const stage = q.get('stage') || 'secret';
const tech = q.get('tech') || 'fire';
const lives = +(q.get('lives') || 3);
const bombs = +(q.get('bombs') || 2);
const base = new URL('./', location.href).href;

// 线上 game.js 用的是 engine.js 的 loadImage，这里只需要等图片 onload
const loadImage = (src) => new Promise((resolve, reject) => {
  const im = new Image();
  im.onload = () => resolve(im);
  im.onerror = () => reject(new Error('图片加载失败: ' + src));
  im.src = src;
});

window.__state = 'loading';
window.__error = null;
playDanmaku(document.getElementById('host'), {
  art: base + 'art/',
  stage, tech, power: 1, loadImage,
  spellNames: [], minTime: 0, lives, bombs,
}).then((r) => { window.__result = r; window.__state = 'done'; })
  .catch((e) => { window.__error = String((e && e.message) || e); window.__state = 'error'; });
