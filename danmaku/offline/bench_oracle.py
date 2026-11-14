"""用游戏自己的真值弹位喂给跟踪器/走位器，不经过识别。

目的：把「看不看得见」和「躲不躲得掉」拆开。
    python bench_oracle.py secret 60

如果这个也躲不掉，问题在走位；如果这个能活，问题就纯在识别。
"""
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'python'))

from bridge_client import Bridge                     # noqa: E402
from ai import Tracker, Dodger                     # noqa: E402


def main():
    stage = sys.argv[1] if len(sys.argv) > 1 else 'secret'
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 60
    from run import open_game, true_positions, CastMouse

    b = Bridge()
    try:
        open_game(b, stage)
        mou = CastMouse(b)
        trk = Tracker()
        dod = Dodger()
        # 场地在页面里的位置：游戏把 canvas 居中缩放，指针用的是 client 坐标
        rect = b.eval('''(() => {
          const cv = document.querySelector('.xs-dm-cv');
          const r = cv.getBoundingClientRect();
          return {x: r.left, y: r.top, w: r.width, h: r.height};
        })()''')
        sx = rect['w'] / 384.0
        sy = rect['h'] / 512.0
        print('场地 %.0fx%.0f @ (%.0f,%.0f)  缩放 %.3f'
              % (rect['w'], rect['h'], rect['x'], rect['y'], sx))
        t0 = time.time()
        t_last = None
        last_lives = None
        hits = []
        frames = 0
        last_note = 0
        while time.time() - t0 < secs:
            if b.eval('window.__state') == 'done':
                break
            tr = true_positions(b)
            if tr is None:
                break
            now = time.perf_counter()
            dt = 1 / 30.0 if t_last is None else min(0.1, max(0.005, now - t_last))
            t_last = now
            frames += 1
            dets = np.array([[x, y, r] for x, y, r, *_ in tr['bullets']],
                            np.float32) if tr['bullets'] else np.zeros((0, 3), np.float32)
            arr, total, own = trk.update(dets, dt, (tr['px'], tr['py']))
            target, info = dod.decide((tr['px'], tr['py']), arr)
            mou.move(rect['x'] + target[0] * sx, rect['y'] + target[1] * sy)
            if last_lives is not None and tr['lives'] < last_lives:
                hits.append(round(tr['t'], 1))
            last_lives = tr['lives']
            if time.time() - last_note > 10:
                last_note = time.time()
                print('  %5.1f 秒  帧 %4d  弹 %3d  命 %d  余量 %.1f  %s'
                      % (tr['t'], frames, len(dets), tr['lives'],
                         info['clearance'], '放符卡' if info['bomb'] else ''), flush=True)
            time.sleep(max(0, 1 / 30.0 - (time.perf_counter() - now)))
        tr = true_positions(b) or {}
        print('\n=== 真值走位 ===  真实受击 %d 次（第 %s 秒）'
              % (len(hits), '、'.join(str(x) for x in hits) or '无'))
        print('  游戏内 %s' % (b.eval('window.__result') or {}))
    finally:
        b.close()


if __name__ == '__main__':
    main()
