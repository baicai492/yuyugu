"""按弹种 / 颜色统计检出率，并给出「逐颗弹的局部特征」用于找可分的判据。

    python diag_by_type.py 40 SAT_V=190 SAT_S=50 CORE_V=215 CORE_S=40

对每颗真值弹：找 15 逻辑像素内最近的检出（命中/漏检），
并记录它所在位置的弹芯半径、中心 V、外圈（r+1..r+4）的平均 V。
重点看：漏检集中在哪种弹？误检的局部特征和真弹差在哪？
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

import vision                                                   # noqa: E402
from bridge_client import Bridge                                # noqa: E402
from vision import (locate_field_full, crop_field, read_boss_hp,
                    detect_objects, CAL, FIELD_W, FIELD_H)      # noqa: E402
from run import open_game, true_positions                       # noqa: E402

N_FRAMES = int(sys.argv[1]) if len(sys.argv) > 1 else 40
SKIP = float(os.environ.get('SKIP', 0))     # 到游戏内这么多秒才开始采样
for kv in sys.argv[2:]:
    k, v = kv.split('=')
    setattr(vision, k, float(v))

TOL = 15.0


def ring_stats(hsv, cx, cy, r):
    """以 (cx,cy) 为中心、半径 r 逻辑像素的圆环上的 V/S 统计（识别坐标）。"""
    rr = max(2, int(round(r * CAL)))
    pad = rr + 6
    x0, y0 = int(cx) - pad, int(cy) - pad
    if x0 < 0 or y0 < 0 or x0 + 2 * pad >= hsv.shape[1] or y0 + 2 * pad >= hsv.shape[0]:
        return None
    sub = hsv[y0:y0 + 2 * pad, x0:x0 + 2 * pad]
    yy, xx = np.mgrid[0:2 * pad, 0:2 * pad]
    d = np.hypot(xx - pad, yy - pad)
    inner = d <= rr
    ring = (d > rr + 1) & (d <= rr + 5)
    if not ring.any():
        return None
    core_v = float(sub[:, :, 2][inner].max())
    ring_v = float(sub[:, :, 2][ring].mean())
    ring_vmax = float(np.percentile(sub[:, :, 2][ring], 90))
    return core_v, ring_v, ring_vmax


def main():
    b = Bridge()
    per = defaultdict(lambda: [0, 0])      # (type,color) -> [tp, n]
    tp_feat, fp_feat = [], []
    got = 0
    try:
        open_game(b, 'secret')
        if os.environ.get('INV'):
            # 采样要跑到后期关卡，先给自机开无敌（只读画面，不吃判定）
            b.eval('window.__dm && (window.__dm.P.inv = 1e9)')
            print('自机无敌')
        f = None
        t0 = time.time()
        while got < N_FRAMES and time.time() - t0 < 180:
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
            if tr['t'] < SKIP:
                continue
            got += 1
            boss, _ = read_boss_hp(crop)
            dets, _, _ = detect_objects(crop, (tr['px'], tr['py']), boss=boss)
            hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
            det = dets if len(dets) else np.zeros((0, 3), np.float32)
            real = [bb for bb in tr['bullets']
                    if -20 <= bb[0] <= FIELD_W + 20 and -20 <= bb[1] <= FIELD_H + 20]
            if real and len(det):
                rp = np.array([[bb[0], bb[1]] for bb in real], np.float32)
                d = np.linalg.norm(rp[:, None, :] - det[None, :, :2], axis=2)
                best = d.min(axis=1)
                near = d.argmin(axis=1)
            else:
                best = np.full(len(real), 1e9, np.float32)
                near = np.zeros(len(real), int)
            for i, bb in enumerate(real):
                key = (bb[3], bb[4])
                per[key][1] += 1
                if len(det) and best[i] < TOL:
                    per[key][0] += 1
                    x, y, r = det[near[i]]
                    st = ring_stats(hsv, x * CAL, y * CAL, r)
                    if st:
                        tp_feat.append((r, ) + st)
            # 误检 = 离所有真值弹都 > TOL
            if len(det):
                used = np.zeros(len(det), bool)
                if real:
                    used = d.min(axis=0) < TOL
                for j in range(len(det)):
                    if used[j]:
                        continue
                    x, y, r = det[j]
                    st = ring_stats(hsv, x * CAL, y * CAL, r)
                    if st:
                        fp_feat.append((r, ) + st)

        print('采了 %d 帧' % got)
        print('\n=== 按弹种 / 颜色的检出率 ===')
        print('%-7s %-7s %6s %8s' % ('type', 'color', 'n', '召回'))
        for k in sorted(per, key=lambda k: -per[k][1]):
            tp, n = per[k]
            print('%-7s %-7s %6d %7.1f%%' % (k[0], k[1], n, 100 * tp / max(1, n)))

        print('\n=== 局部特征：真弹命中 vs 误检 ===')
        print('%-10s %6s %8s %8s %8s %8s' % ('', 'n', 'r中位', 'r90%', '环V中位', '环V90%'))
        for name, arr in (('真弹命中', tp_feat), ('误检', fp_feat)):
            if not arr:
                continue
            a = np.array(arr, np.float32)
            print('%-10s %6d %8.1f %8.1f %8.1f %8.1f'
                  % (name, len(a), np.median(a[:, 1]), np.percentile(a[:, 1], 90),
                     np.median(a[:, 2]), np.percentile(a[:, 2], 90)))
        # 按环亮度分档看误检比例
        if tp_feat and fp_feat:
            print('\n=== 按「外圈平均 V」分档，真弹保留率 / 误检保留率 ===')
            t = np.array(tp_feat, np.float32)
            p = np.array(fp_feat, np.float32)
            for th in (60, 80, 100, 120, 140, 160):
                print('  环V < %3d 前 真弹 %5.1f%%  误检 %5.1f%%'
                      % (th, 100 * (t[:, 2] < th).mean(), 100 * (p[:, 2] < th).mean()))
            print('\n=== 按「弹芯半径 r」分档 ===')
            for lo, hi in ((0, 3), (3, 5), (5, 8), (8, 12), (12, 20), (20, 40)):
                print('  r %2d~%-2d 真弹 %5.1f%%  误检 %5.1f%%'
                      % (lo, hi, 100 * ((t[:, 1] >= lo) & (t[:, 1] < hi)).mean(),
                         100 * ((p[:, 1] >= lo) & (p[:, 1] < hi)).mean()))
    finally:
        b.close()


if __name__ == '__main__':
    main()
