"""把误检画出来：绿圈=命中真值，红圈=误检（离所有真值弹都 >15 逻辑像素）。

    python diag_fp.py 20 _fp    采 20 帧，标注图存到 _fp/
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
from vision import locate_field_full, crop_field, read_boss_hp, FIELD_W, FIELD_H   # noqa: E402
from run import open_game, true_positions                       # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 20
OUT = sys.argv[2] if len(sys.argv) > 2 else '_fp'
if len(sys.argv) > 3:
    for kv in sys.argv[3:]:
        k, v = kv.split('=')
        setattr(vision, k, float(v))


def main():
    os.makedirs(OUT, exist_ok=True)
    b = Bridge()
    tot_fp = tot_tp = tot_real = 0
    worst = None
    try:
        open_game(b, 'secret')
        f = None
        got = 0
        t0 = time.time()
        while got < N and time.time() - t0 < 150:
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
            boss, _ = read_boss_hp(crop)
            dets, _, _ = vision.detect_objects(crop, (tr['px'], tr['py']), boss=boss)
            real = np.array([[x, y] for x, y, *_ in tr['bullets']], np.float32)
            det = dets[:, :2] if len(dets) else np.zeros((0, 2), np.float32)
            is_tp = np.zeros(len(det), bool)
            if len(det) and len(real):
                d = np.linalg.norm(real[:, None, :] - det[None, :, :], axis=2)
                is_tp = d.min(axis=0) < 22
                tot_tp += int(is_tp.sum())
                tot_real += len(real)
            fp = len(det) - int(is_tp.sum())
            tot_fp += fp

            vis = cv2.resize(crop, (FIELD_W * 2, FIELD_H * 2))
            for i, (x, y) in enumerate(det):
                col = (0, 255, 0) if is_tp[i] else (0, 0, 255)
                cv2.circle(vis, (int(x * 2), int(y * 2)), 6, col, 1)
            for x, y in real:
                cv2.circle(vis, (int(x * 2), int(y * 2)), 2, (255, 255, 255), -1)
            cv2.putText(vis, 'real %d  det %d  tp %d  fp %d'
                        % (len(real), len(det), int(is_tp.sum()), fp),
                        (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.imwrite(os.path.join(OUT, 'f%03d.png' % got), vis)
            if worst is None or fp > worst[0]:
                worst = (fp, got)
        print('共 %d 帧：真值 %d，命中 %d（%.1f%%），误检累计 %d（%.1f 颗/帧）'
              % (got, tot_real, tot_tp, 100 * tot_tp / max(1, tot_real),
                 tot_fp, tot_fp / max(1, got)))
        print('误检最多的一帧：第 %d 帧（%d 颗）' % (worst[1], worst[0]))
    finally:
        b.close()


if __name__ == '__main__':
    main()
