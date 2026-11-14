"""采一批「真实画面 + 游戏真值弹位」，存成 npz，供识别调参用。

    python grab.py secret 60 out.npz    采 60 秒
    python grab.py demon 60 out.npz

存的是已经裁好的场地图（768x1024）+ 该帧真值弹位（逻辑坐标）+ 自机位置
+ 有没有 Boss。调阈值、看标注图都不用再开浏览器。
"""
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'python'))

from bridge_client import Bridge                          # noqa: E402
from vision import locate_field_full, crop_field, read_boss_hp   # noqa: E402
from run import open_game, true_positions, PAGE_W, PAGE_H  # noqa: E402


def grab(stage='secret', seconds=40, out='frames.npz', every=1):
    b = Bridge()
    crops, truths = [], []
    try:
        open_game(b, stage)
        f = None
        t0 = time.time()
        n = 0
        while time.time() - t0 < seconds:
            if b.eval('window.__state') == 'done':
                break
            seq, _w, _h, jpg = b.frame()
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
            crops.append(crop)
            truths.append({
                'bullets': np.array([[x, y, r] for x, y, r in tr['bullets']], np.float32)
                           if tr['bullets'] else np.zeros((0, 3), np.float32),
                'enemies': np.array(tr['enemies'], np.float32) if tr['enemies']
                           else np.zeros((0, 3), np.float32),
                'player': np.array([tr['px'], tr['py']], np.float32),
                'boss': boss,
                't': tr['t'],
            })
            if len(crops) % 40 == 0:
                print('  采了 %d 帧（游戏时间 %.0f 秒）' % (len(crops), tr['t']), flush=True)
        print('共 %d 帧' % len(crops))
    finally:
        b.close()
    np.savez_compressed(out,
                        crops=np.array(crops, np.uint8),
                        **{'g%d' % i: np.array(v, dtype=object) for i, v in enumerate(truths)})
    print('已存 %s（%.1f MB）' % (out, os.path.getsize(out) / 1e6))


if __name__ == '__main__':
    a = sys.argv[1:]
    grab(a[0] if a else 'secret',
         float(a[1]) if len(a) > 1 else 40,
         a[2] if len(a) > 2 else 'frames.npz')
