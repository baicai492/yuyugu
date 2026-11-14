"""按弹种诊断颜色：每种弹（红/橙/粉/白…）在画面上到底是什么颜色。

取样窗口放宽到 ±10 识别像素（±5 逻辑像素）再取最亮像素，
避免「真值和画面差一两帧，窗口里全是背景」。
"""
import os
import sys
import time
from collections import defaultdict

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'python'))

from bridge_client import Bridge                                   # noqa: E402
from vision import locate_field_full, crop_field, FIELD_W, FIELD_H, CAL   # noqa: E402
from run import open_game, true_positions                          # noqa: E402

N_FRAMES = int(sys.argv[1]) if len(sys.argv) > 1 else 40
HALF = 10          # 识别坐标像素


def main():
    b = Bridge()
    per = defaultdict(list)        # (type,color) -> [HSV...]
    bg = []
    off = []
    try:
        open_game(b, 'secret')
        f = None
        got = 0
        t0 = time.time()
        while got < N_FRAMES and time.time() - t0 < 120:
            if b.eval('window.__state') == 'done':
                break
            _seq, _w, _h, jpg = b.frame()
            img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
            tr = true_positions(b)
            if img is None or tr is None or not tr['bullets']:
                time.sleep(0.02)
                continue
            if f is None:
                f = locate_field_full(img)
                if f is None:
                    continue
            crop = crop_field(img, f)
            if crop is None:
                continue
            got += 1
            hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
            for x, y, _r, ty, co in tr['bullets']:
                cx, cy = int(round(x * CAL)), int(round(y * CAL))
                if not (HALF <= cx < crop.shape[1] - HALF and HALF <= cy < crop.shape[0] - HALF):
                    continue
                win = hsv[cy - HALF:cy + HALF + 1, cx - HALF:cx + HALF + 1].reshape(-1, 3)
                per[(ty, co)].append(win[int(np.argmax(win[:, 2]))])
                # 顺带看：真值弹位在画面上到底偏了多远（找最亮像素的相对位置）
                v = win[:, 2].reshape(2 * HALF + 1, 2 * HALF + 1)
                yy, xx = np.unravel_index(int(np.argmax(v)), v.shape)
                off.append((xx - HALF, yy - HALF))
            for _ in range(40):
                bx = np.random.randint(4, crop.shape[1] - 4)
                by = np.random.randint(int(60 * CAL), crop.shape[0] - 4)
                bg.append(hsv[by, bx])
        print('采了 %d 帧' % got)

        print('\n=== 每种弹的弹心颜色（中位数）===')
        print('%-6s %-6s %5s %6s %6s %6s' % ('type', 'color', 'n', 'H', 'S', 'V'))
        for k in sorted(per, key=lambda k: -len(per[k])):
            a = np.array(per[k], np.int32)
            print('%-6s %-6s %5d %6d %6d %6d'
                  % (k[0], k[1], len(a), *np.median(a, axis=0).astype(int)))

        allb = np.array([p for v in per.values() for p in v], np.int32)
        g = np.array(bg, np.int32)
        print('\n=== 全体弹 vs 背景 ===')
        for i, n in enumerate('HSV'):
            print('  %s 弹 中位=%3d 5%%=%3d 95%%=%3d | 背景 中位=%3d 95%%=%3d 99.9%%=%3d'
                  % (n, np.median(allb[:, i]), np.percentile(allb[:, i], 5),
                     np.percentile(allb[:, i], 95), np.median(g[:, i]),
                     np.percentile(g[:, i], 95), np.percentile(g[:, i], 99.9)))

        o = np.array(off, np.int32)
        print('\n=== 真值弹位 vs 画面最亮点 的相对位置（识别像素）===')
        print('  中位偏移 (%.1f, %.1f)，绝对偏移 90%%=%.1f' % (
            np.median(o[:, 0]), np.median(o[:, 1]),
            np.percentile(np.hypot(o[:, 0], o[:, 1]), 90)))

        print('\n=== 候选阈值评分（覆盖率 - 加权误中率）===')
        print('  %-22s %8s %8s' % ('阈值', '弹覆盖', '背景误中'))
        for v_th, s_th in [(150, 120), (160, 110), (168, 135), (170, 90), (175, 70),
                           (180, 60), (190, 50), (200, 0)]:
            hit = 100 * ((allb[:, 2] >= v_th) & (allb[:, 1] >= s_th)).mean()
            fpr = 100 * ((g[:, 2] >= v_th) & (g[:, 1] >= s_th)).mean()
            print('  V>=%3d & S>=%3d      %7.1f%% %7.2f%%' % (v_th, s_th, hit, fpr))
    finally:
        b.close()


if __name__ == '__main__':
    main()
