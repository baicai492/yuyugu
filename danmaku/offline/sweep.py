"""阈值扫描：在真实画面上跑完整 detect_objects，比不同阈值组合的最终检出率。

    python sweep.py secret 40

评价口径和 run.py --eval 一样：检出中心离真值弹 < 15 逻辑像素算命中。
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


def collect(seconds=40, every=2):
    b = Bridge()
    frames = []
    try:
        open_game(b, 'secret')
        f = None
        t0 = time.time()
        n = 0
        while time.time() - t0 < seconds:
            if b.eval('window.__state') == 'done':
                break
            _seq, _w, _h, jpg = b.frame()
            img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
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
            n += 1
            if n % every:
                continue
            boss, _ = read_boss_hp(crop)
            real = np.array([[x, y] for x, y, *_ in tr['bullets']], np.float32) \
                if tr['bullets'] else np.zeros((0, 2), np.float32)
            frames.append((crop, real, (tr['px'], tr['py']), boss))
        print('采到 %d 帧，真值弹 %d 颗\n'
              % (len(frames), sum(len(f[1]) for f in frames)))
    finally:
        b.close()
    return frames


def score(frames, tol=15.0):
    tp = fp = fn = 0
    ms = 0.0
    for crop, real, player, boss in frames:
        t1 = time.perf_counter()
        dets, _, _ = vision.detect_objects(crop, player, boss=boss)
        ms += time.perf_counter() - t1
        det = dets[:, :2] if len(dets) else np.zeros((0, 2), np.float32)
        if len(real) and len(det):
            d = np.linalg.norm(real[:, None, :] - det[None, :, :], axis=2)
            tp += int((d.min(axis=1) < tol).sum())
            fn += int((d.min(axis=1) >= tol).sum())
            fp += int((d.min(axis=0) >= tol).sum())
        elif len(real):
            fn += len(real)
        else:
            fp += len(det)
    return tp, fn, fp, tp / max(1, tp + fn), ms * 1000 / max(1, len(frames))


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 40
    frames = collect(secs)
    if not frames:
        return
    saved = {k: getattr(vision, k) for k in
             ('SAT_V', 'SAT_S', 'WHITE_V', 'WHITE_S', 'CORE_V', 'CORE_S', 'CORE_W',
              'PEAK_MIN', 'MIN_R')}
    print('%-58s %7s %7s %7s %6s' % ('阈值组合', '命中率', '漏检', '误检', 'ms'))
    tp, fn, fp, rate, ms = score(frames)
    print('%-58s %6.1f%% %7d %7d %6.1f' % ('现状 168/135, 芯 208/168', rate * 100, fn, fp, ms))

    combos = [
        ('SAT 190/50  芯 215/40', dict(SAT_V=190, SAT_S=50, CORE_V=215, CORE_S=40)),
        ('SAT 190/50  芯 230/40', dict(SAT_V=190, SAT_S=50, CORE_V=230, CORE_S=40)),
        ('SAT 190/50  芯 240/40', dict(SAT_V=190, SAT_S=50, CORE_V=240, CORE_S=40)),
        ('SAT 190/50  芯 245/40', dict(SAT_V=190, SAT_S=50, CORE_V=245, CORE_S=40)),
        ('SAT 190/50  芯 250/40', dict(SAT_V=190, SAT_S=50, CORE_V=250, CORE_S=40)),
        ('SAT 190/50  芯 245/60', dict(SAT_V=190, SAT_S=50, CORE_V=245, CORE_S=60)),
        ('SAT 190/50  芯 245/40 白芯 250/45',
         dict(SAT_V=190, SAT_S=50, CORE_V=245, CORE_S=40, CORE_W=250)),
    ]
    for name, kw in combos:
        for k, v in saved.items():
            setattr(vision, k, v)
        for k, v in kw.items():
            setattr(vision, k, v)
        tp, fn, fp, rate, ms = score(frames)
        print('%-58s %6.1f%% %7d %7d %6.1f' % (name, rate * 100, fn, fp, ms))
    for k, v in saved.items():
        setattr(vision, k, v)


if __name__ == '__main__':
    main()
