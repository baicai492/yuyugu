"""画面差分能不能把弹幕从背景里分出来。

背景是静态/慢速视差滚动的（远/中/近三层 14~30 逻辑像素/秒），
子弹是 60~260 逻辑像素/秒。两帧相减，静态美术的灯、花、瀑布应该互相抵消，
只剩下会动的东西。

这里只测可行性：真值弹位置上的差分强度 vs 随机背景位置的差分强度。
"""
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'python'))

from bridge_client import Bridge                                   # noqa: E402
from vision import locate_field_full, crop_field, FIELD_W, FIELD_H, CAL   # noqa: E402
from run import open_game, true_positions                          # noqa: E402


def main(n=60):
    b = Bridge()
    hit = []      # 每颗真值弹：差分窗口内的最大灰度
    bg = []       # 随机背景点
    try:
        open_game(b, 'secret')
        f = None
        prev = None
        got = 0
        t0 = time.time()
        while got < n and time.time() - t0 < 180:
            if b.eval('window.__state') == 'done':
                break
            _seq, _w, _h, jpg = b.frame()
            img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
            tr = true_positions(b)
            if img is None or tr is None:
                time.sleep(0.02)
                continue
            if f is None:
                f = locate_field_full(img)
                if f is None:
                    continue
            crop = crop_field(img, f)
            if crop is None:
                prev = None
                continue
            cur = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY).astype(np.int16)
            if prev is None or not tr['bullets']:
                prev = cur
                time.sleep(0.01)
                continue
            diff = np.abs(cur - prev).astype(np.uint8)
            prev = cur
            # 背景是暗的、弹是亮的：只有「变亮的」才算候选
            up = np.clip(cur - cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY).astype(np.int16) * 0, 0, 255)
            got += 1
            for x, y, *_ in tr['bullets']:
                cx, cy = int(round(x * CAL)), int(round(y * CAL))
                if not (10 <= cx < crop.shape[1] - 10 and 10 <= cy < crop.shape[0] - 10):
                    continue
                win = diff[cy - 10:cy + 11, cx - 10:cx + 11]
                hit.append(int(win.max()))
            for _ in range(30):
                bx = np.random.randint(10, crop.shape[1] - 10)
                by = np.random.randint(int(120 * CAL), crop.shape[0] - 10)
                bg.append(int(diff[by - 10:by + 11, bx - 10:bx + 11].max()))
        h = np.array(hit)
        g = np.array(bg)
        print('采了 %d 帧差分，%d 颗真值弹' % (got, len(h)))
        print('\n真值弹位置上的「帧间最大差值」分位数：')
        for q in (1, 5, 10, 25, 50, 75, 90, 99):
            print('  %2d%% = %3d' % (q, np.percentile(h, q)))
        print('\n随机背景位置：')
        for q in (50, 75, 90, 95, 99, 99.9):
            print('  %4.1f%% = %3d' % (q, np.percentile(g, q)))
        print('\n按阈值算「弹被看见 / 背景被误检」：')
        for th in (8, 12, 16, 20, 25, 30, 40):
            print('  diff>=%2d  弹 %5.1f%%  背景 %5.2f%%'
                  % (th, 100 * (h >= th).mean(), 100 * (g >= th).mean()))
    finally:
        b.close()


if __name__ == '__main__':
    main()
