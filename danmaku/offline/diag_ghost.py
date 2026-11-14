"""找到「真值没有弹但识别出一大堆」的帧，把轨迹位置画出来存图。

    python diag_ghost.py [秒数]
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
from vision import locate_field_full, crop_field, read_boss_hp, CAL   # noqa: E402
from run import open_game, true_positions                       # noqa: E402
from ai import Tracker                                          # noqa: E402

for kv in sys.argv[2:]:
    k, v = kv.split('=')
    setattr(vision, k, float(v))

SECS = float(sys.argv[1]) if len(sys.argv) > 1 else 14


def main():
    b = Bridge()
    saved = 0
    try:
        open_game(b, 'secret')
        f = None
        trk = Tracker()
        t_last = None
        t0 = time.time()
        while time.time() - t0 < SECS and saved < 3:
            if b.eval('window.__state') == 'done':
                break
            seq, w, h, jpg = b.frame()
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
            now = time.perf_counter()
            dt = 1 / 30.0 if t_last is None else min(0.2, max(0.005, now - t_last))
            t_last = now
            boss, _ = read_boss_hp(crop)
            dets, _las, _haz = vision.detect_objects(crop, (tr['px'], tr['py']), boss=boss)
            arr, total, own = trk.update(dets, dt, (tr['px'], tr['py']))
            nreal = len(tr['bullets'])
            if nreal <= 1 and len(arr) > 40:
                vis = cv2.resize(crop, (vision.FIELD_W * 2, vision.FIELD_H * 2))
                for t in trk.tracks:
                    col = (0, 255, 255) if t.own else (0, 0, 255)
                    cv2.circle(vis, (int(t.x * 2), int(t.y * 2)), 4, col, 1)
                cv2.putText(vis, 't=%.1f real=%d tracks=%d own=%d bg=%d'
                            % (tr['t'], nreal, len(trk.tracks), own, len(trk.bg)),
                            (6, 700), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
                cv2.imwrite('_ghost%d.png' % saved, vis)
                saved += 1
                print('存了 _ghost%d.png  t=%.1f 真值 %d 轨迹 %d 自机弹 %d 背景 %d'
                      % (saved - 1, tr['t'], nreal, len(trk.tracks), own, len(trk.bg)))
            time.sleep(0.01)
    finally:
        b.close()


if __name__ == '__main__':
    main()
