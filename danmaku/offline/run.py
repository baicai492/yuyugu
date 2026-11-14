"""离线跑真实斗法：headless Chrome 里是线上那一份 danmaku.js，引擎还是原来那个。

和 selftest.py 的区别：selftest 用的是 sim.py（照截图近似画的），这里用的是
**线上真正的美术和真正的关卡**，只是把「看屏幕」换成从浏览器取帧、
「动鼠标」换成往页面派发 pointermove。识别、跟踪、走位一行没改。

    python run.py                打一局 secret，打印统计
    python run.py demon sword    连着打 demon 和 sword
    python run.py --eval 40      只做识别评测（跑 40 秒，逐帧对真值弹位）
    python run.py --dump D       存标注图，肉眼看识别对不对
"""
import argparse
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PY_DIR = os.path.join(os.path.dirname(HERE), 'python')     # danmaku/python
sys.path.insert(0, HERE)
sys.path.insert(0, PY_DIR)

from bridge_client import Bridge                       # noqa: E402
from engine import Engine                              # noqa: E402
from vision import (locate_field, locate_field_full, crop_field,   # noqa: E402
                    detect_objects, laser_points, read_boss_hp,
                    frame_is_dark, Field, FIELD_W, FIELD_H)


class CastScreen:
    """Screen 的替身：从浏览器 screencast 取最新一帧。

    grab(rect) 的 rect 是屏幕坐标；screencast 给的是整个视口，
    所以裁剪在本地做——和 mss 抓区域不同，这里先拿全屏再切。
    """

    def __init__(self, bridge):
        self.b = bridge
        self.grabs = 0
        self._img = None
        self._seq = 0

    def monitors(self):
        return [{'left': 0, 'top': 0, 'width': 900, 'height': 880}]

    def bounds(self):
        return (0, 0, 900, 880)

    def grab(self, rect=None):
        seq, _w, _h, jpg = self.b.frame()
        img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
        self.grabs += 1
        if img is None:
            return None
        self._img = img
        if rect is None:
            return img
        x, y, w, h = [int(round(v)) for v in rect]
        H, W = img.shape[:2]
        x0 = max(0, x); y0 = max(0, y)
        x1 = min(W, x + w); y1 = min(H, y + h)
        if x1 - x0 < 2 or y1 - y0 < 2:
            return None
        return img[y0:y1, x0:x1]

    def close(self):
        pass


class CastMouse:
    """Mouse 的替身：动指针就是往页面派发 pointermove。"""

    def __init__(self, bridge, dry=False):
        self.b = bridge
        self.dry = dry
        self.moves = 0
        self.clicks = 0
        self.last = (None, None)

    def move(self, x, y):
        x, y = int(round(x)), int(round(y))
        if self.last == (x, y):
            return False
        self.last = (x, y)
        self.moves += 1
        if not self.dry:
            self.b.move(x, y)
        return True

    def right_click(self):
        self.clicks += 1
        if self.dry:
            return
        self.b.right_click()

    def key(self, vk):
        if self.dry:
            return
        self.b.key('x')


PAGE_W, PAGE_H = 900, 880


def open_game(b, stage='secret', lives=3, bombs=2):
    b.open(stage=stage, tech='fire', lives=lives, bombs=bombs, w=PAGE_W, h=PAGE_H)
    t0 = time.time()
    while time.time() - t0 < 40:
        if b.eval('!!window.__dm'):
            break
        time.sleep(0.1)
    else:
        raise RuntimeError('游戏没起来：%s' % b.eval('window.__error'))
    b.start_cast(PAGE_W, PAGE_H, 90)


def true_positions(b):
    """从游戏自己的调试钩子拿真值。"""
    return b.eval('''(() => {
      const d = window.__dm;
      if (!d) return null;
      return {
        t: d.t,
        px: d.P.x, py: d.P.y,
        lives: d.P.lives, bombs: d.P.bombs, inv: d.P.inv, dead: d.P.dead,
        boss: !!d.boss, bossHp: d.boss ? d.boss.hp : 0, bossHp0: d.boss ? d.boss.hp0 : 0,
        bullets: d.bullets.map(b => [Math.round(b.x*10)/10, Math.round(b.y*10)/10, b.r, b.type, b.c]),
        enemies: d.enemies.filter(e => e.t >= 0).map(e => [e.x, e.y, e.size]),
      };
    })()''')


def play(stage='secret', seconds=120, dump=None, seed=None, verbose=True):
    b = Bridge()
    cr = None
    try:
        open_game(b, stage)
        scr = CastScreen(b)
        mou = CastMouse(b)
        # 关掉后台抓屏线程：bridge 是单条 stdin/stdout 通道，多线程调用会串行排队，
        # 反而比直接抓更慢（取帧本身只要十几毫秒）。
        eng = Engine(cfg={'fps': 30, 'dry': False, 'pipeline': False},
                     screen=scr, mouse=mou)
        eng.start()

        t0 = time.time()
        last_lives = None
        hits = []
        frames = 0
        last_note = 0
        while time.time() - t0 < seconds:
            if b.eval("window.__state") == 'done':
                break
            eng._tick()
            frames += 1
            tr = true_positions(b)
            if tr is None:
                break
            if last_lives is not None and tr['lives'] < last_lives:
                hits.append(round(tr['t'], 1))
            last_lives = tr['lives']
            if dump and frames % 30 == 0:
                img = scr._img
                if img is not None:
                    vis = img.copy()
                    for x, y, *_ in tr['bullets']:
                        f = eng.field
                        if f:
                            sx, sy = f.to_screen(x, y)
                            cv2.circle(vis, (int(sx), int(sy)), 4, (0, 255, 0), 1)
                    cv2.imwrite(os.path.join(dump, 'f%05d.png' % frames), vis)
            if verbose and time.time() - last_note > 5:
                last_note = time.time()
                print('  %5.1f 秒  帧 %4d  %.1f fps  弹 %3d  命 %d  符 %d  余量 %.1f'
                      % (tr['t'], frames, eng.fps, eng.bullets,
                         tr['lives'], tr['bombs'], eng.last_clearance), flush=True)

        tr = true_positions(b) or {}
        st = eng.status()
        res = b.eval('window.__state')
        print('\n=== %s ===' % stage)
        print('  结果：%s（游戏内 %s），用时 %.1f 秒'
              % ({'running': '未结束', 'done': '结束'}.get(res, res),
                 (b.eval('window.__result') or {}).get('win') and '胜利' or '未胜利',
                 tr.get('t', 0)))
        print('  真实受击 %d 次（第 %s 秒）  引擎判定受击 %d 次'
              % (len(hits), '、'.join(str(x) for x in hits) or '无', st['hits']))
        print('  引擎：%d 帧，平均 %.1f fps，结束原因「%s」'
              % (frames, frames / max(1e-6, time.time() - t0), st['message'] or '-'))
        print('  游戏结果：%s' % (b.eval('window.__result') or {}))
        return {'stage': stage, 'hits': len(hits), 'hit_at': hits,
                'engine_hits': st['hits'], 'result': b.eval('window.__result')}
    finally:
        if cr:
            cr.close()
        b.close()


def evaluate(stage='secret', seconds=40, dump=None, tol=15.0):
    """识别评测：拿游戏自己的真值弹位逐帧对账。

    sim.py 是「照着线上截图近似画」的，检测率再高也只说明算法在模拟器上成立；
    这里跑的是线上真正的美术和真正的关卡，数字才算数。
    """
    b = Bridge()
    try:
        open_game(b, stage)
        scr = CastScreen(b)
        f = None
        tp = fp = fn = 0
        extra = 0
        tm = 0.0
        frames = 0
        t0 = time.time()
        worst = (0, 0, 0)
        while time.time() - t0 < seconds:
            if b.eval('window.__state') == 'done':
                break
            img = scr.grab(None)
            tr = true_positions(b)
            if img is None or tr is None:
                continue
            if f is None:
                f = locate_field_full(img)
                if f is None:
                    continue
            crop = crop_field(img, f)
            if crop is None:
                continue
            boss, _ = read_boss_hp(crop)
            t1 = time.perf_counter()
            dets, _, _ = detect_objects(crop, (tr['px'], tr['py']), boss=boss)
            tm += time.perf_counter() - t1
            frames += 1

            # 真值裁掉已经飞出画面的（引擎那边 bullets 也会被游戏自己过滤掉）
            real = np.array([[x, y] for x, y, *_ in tr['bullets']
                             if -20 <= x <= FIELD_W + 20 and -20 <= y <= FIELD_H + 20],
                            np.float32) if tr['bullets'] else np.zeros((0, 2), np.float32)
            det = dets[:, :2] if len(dets) else np.zeros((0, 2), np.float32)
            if len(real) and len(det):
                d = np.linalg.norm(real[:, None, :] - det[None, :, :], axis=2)
                tp += int((d.min(axis=1) < tol).sum())
                fn += int((d.min(axis=1) >= tol).sum())
                fp += int((d.min(axis=0) >= tol).sum())
            elif len(real):
                fn += len(real)
            elif len(det):
                fp += len(det)
            n_miss = len(real) - int((np.linalg.norm(
                real[:, None, :] - det[None, :, :], axis=2).min(axis=1) < tol).sum()) \
                if len(real) and len(det) else len(real)
            if n_miss > worst[1]:
                worst = (frames, n_miss, len(real))
            if dump and frames % 20 == 0:
                vis = cv2.resize(crop, (FIELD_W * 2, FIELD_H * 2))
                for x, y, r in dets:
                    cv2.circle(vis, (int(x * 2), int(y * 2)), max(3, int(r * 2)), (0, 255, 0), 1)
                for x, y in real:
                    cv2.circle(vis, (int(x * 2), int(y * 2)), 4, (0, 0, 255), 1)
                px, py = tr['px'], tr['py']
                cv2.circle(vis, (int(px * 2), int(py * 2)), 8, (255, 128, 0), 2)
                cv2.putText(vis, 'f%d real=%d det=%d' % (frames, len(real), len(det)),
                            (8, FIELD_H * 2 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
                cv2.imwrite(os.path.join(dump, 'e%05d.png' % frames), vis)

        tot = tp + fn
        print('\n=== 识别评测（%s，%d 帧，容差 %.0f 逻辑像素）===' % (stage, frames, tol))
        print('  场地上平均每帧 %.1f 颗真值弹' % (tot / max(1, frames)))
        print('  命中 %d/%d（%.1f%%），误检 %d 颗，%d 颗真值弹附近没有检出'
              % (tp, tot, 100.0 * tp / max(1, tot), fp, fn))
        print('  单帧最差：第 %d 帧漏了 %d/%d 颗' % worst)
        print('  detect_objects 平均 %.1f 毫秒/帧' % (tm * 1000 / max(1, frames)))
        return {'frames': frames, 'tp': tp, 'fn': fn, 'fp': fp, 'ms': tm * 1000 / max(1, frames)}
    finally:
        b.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('stages', nargs='*', default=['secret'])
    ap.add_argument('--seconds', type=float, default=120)
    ap.add_argument('--eval', type=float, default=0)
    ap.add_argument('--dump')
    a = ap.parse_args()
    if a.dump:
        os.makedirs(a.dump, exist_ok=True)
    if a.eval:
        for s in a.stages:
            evaluate(s, a.eval, a.dump)
        return
    for s in a.stages:
        play(s, a.seconds, a.dump)


if __name__ == '__main__':
    main()
