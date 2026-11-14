"""近身窗口（自机 120 逻辑像素内）单独放宽阈值值不值？

对同一批帧，比较不同弹芯阈值在「近身窗口内」的召回和误检。
    python diag_near.py 60 SAT_V=190 SAT_S=50
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
from vision import (locate_field_full, crop_field, read_boss_hp,
                    detect_objects, CAL, FIELD_W, FIELD_H)      # noqa: E402
from run import open_game, true_positions                       # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 60
for kv in sys.argv[2:]:
    k, v = kv.split('=')
    setattr(vision, k, float(v))

R = 120.0        # 近身窗口半径（逻辑像素）


def main():
    frames = []
    b = Bridge()
    try:
        open_game(b, 'secret')
        if os.environ.get('INV'):
            b.eval('window.__dm && (window.__dm.P.inv = 1e9)')
        f = None
        t0 = time.time()
        got = 0
        while got < N and time.time() - t0 < 200:
            if b.eval('window.__state') == 'done':
                break
            seq, w, h, jpg = b.frame()
            img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
            tr = true_positions(b)
            if img is None or tr is None or not tr['bullets']:
                time.sleep(0.01)
                continue
            if f is None:
                f = locate_field_full(img)
                if f is None:
                    continue
            crop = crop_field(img, f)
            if crop is None:
                continue
            p = np.array([tr['px'], tr['py']], np.float32)
            real = np.array([[x, y] for x, y, *_ in tr['bullets']], np.float32)
            near = real[np.linalg.norm(real - p, axis=1) < R]
            if not len(near):
                continue
            got += 1
            boss, _ = read_boss_hp(crop)
            frames.append((crop, p, near, boss))
        print('采到 %d 帧（含近身弹）' % len(frames))
    finally:
        b.close()

    saved = {k: getattr(vision, k) for k in ('CORE_V', 'CORE_S', 'CORE_W', 'PEAK_MIN', 'MIN_R')}
    print('%-34s %8s %8s %8s' % ('弹芯阈值', '近身召回', '窗口误检/帧', '总误检/帧'))
    for cv_, cs_, mr_ in ((240, 40, 1.6), (230, 40, 1.6), (225, 35, 1.6),
                          (215, 35, 1.6), (225, 35, 1.2), (215, 30, 1.2)):
        for k, v in saved.items():
            setattr(vision, k, v)
        vision.CORE_V, vision.CORE_S, vision.MIN_R = cv_, cs_, mr_
        tp = nr = fp = fpn = 0
        for crop, p, near, boss in frames:
            dets, _, _ = detect_objects(crop, p, boss=boss, want_hazards=False)
            d = dets[:, :2] if len(dets) else np.zeros((0, 2), np.float32)
            if len(d):
                dd = np.linalg.norm(near[:, None, :] - d[None, :, :], axis=2)
                tp += int((dd.min(axis=1) < 22).sum())
                inwin = np.linalg.norm(d - p, axis=1) < R
                fpn += int((dd.min(axis=0)[inwin] >= 22).sum())
                fp += int((dd.min(axis=0) >= 22).sum())
            nr += len(near)
        print('%-34s %7.0f%% %9.1f %10.1f'
              % ('芯 %d/%d MIN_R %.1f' % (cv_, cs_, mr_),
                 100.0 * tp / max(1, nr), fpn / max(1, len(frames)),
                 fp / max(1, len(frames))))
    for k, v in saved.items():
        setattr(vision, k, v)


if __name__ == '__main__':
    main()
