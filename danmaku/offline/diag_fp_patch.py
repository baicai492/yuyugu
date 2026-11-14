"""把误检的小块原图裁出来放大，一眼看出它们到底是什么。

    python diag_fp_patch.py 30 _patch SAT_V=190 SAT_S=50 CORE_V=215 CORE_S=40
"""
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'python'))

import vision                                                   # noqa: E402
from bridge_client import Bridge                                # noqa: E402
from vision import locate_field_full, crop_field, read_boss_hp  # noqa: E402
from run import open_game, true_positions                       # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 30
OUT = sys.argv[2] if len(sys.argv) > 2 else '_patch'
for kv in sys.argv[3:]:
    k, v = kv.split('=')
    setattr(vision, k, float(v))

HALF = 24          # 识别像素（12 逻辑像素）


def main():
    os.makedirs(OUT, exist_ok=True)
    b = Bridge()
    saved = 0
    feats = []
    try:
        open_game(b, 'secret')
        f = None
        t0 = time.time()
        n = 0
        while saved < N and time.time() - t0 < 200:
            if b.eval('window.__state') == 'done':
                break
            seq, _w, _h, jpg = b.frame()
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
            n += 1
            boss, _ = read_boss_hp(crop)
            dets, _, _ = vision.detect_objects(crop, (tr['px'], tr['py']), boss=boss)
            if not len(dets):
                continue
            real = np.array([[x, y] for x, y, *_ in tr['bullets']], np.float32)
            d = np.linalg.norm(real[:, None, :] - dets[None, :, :2], axis=2)
            is_tp = d.min(axis=0) < 22
            hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
            for i in np.nonzero(~is_tp)[0]:
                x, y, r = dets[i]
                cx, cy = int(round(x * vision.CAL)), int(round(y * vision.CAL))
                if not (HALF <= cx < crop.shape[1] - HALF and HALF <= cy < crop.shape[0] - HALF):
                    continue
                patch = crop[cy - HALF:cy + HALF, cx - HALF:cx + HALF]
                big = cv2.resize(patch, (HALF * 16, HALF * 16), interpolation=cv2.INTER_NEAREST)
                cv2.imwrite(os.path.join(OUT, 'p%03d.png' % saved), big)
                h = hsv[cy, cx]
                feats.append((r, int(h[0]), int(h[1]), int(h[2])))
                saved += 1
                if saved >= N:
                    break
            if n % 20 == 0 and n:
                time.sleep(0.05)
        print('存了 %d 张误检小块 → %s' % (saved, OUT))
        a = np.array(feats, np.float32)
        if len(a):
            print('误检峰值特征：r 中位 %.1f  H 中位 %d  S 中位 %d  V 中位 %d'
                  % (np.median(a[:, 0]), np.median(a[:, 1]),
                     np.median(a[:, 2]), np.median(a[:, 3])))
    finally:
        b.close()


if __name__ == '__main__':
    main()
