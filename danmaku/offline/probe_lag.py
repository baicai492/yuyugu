"""抓到的画面到底落后游戏多少？用游戏自己的 t 量。

做法：读 t1 → 取一帧画面 → 立刻再读 t2。若抓帧是实时的，t2≈t1；
若画面是缓存里的旧帧，画面对应的时刻会比 t2 早，看不出来——所以换个测法：
连续取帧，每帧都读一次 t，看「同一帧的编号 seq」和 t 的对应关系。

    python probe_lag.py
"""
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'python'))

from bridge_client import Bridge            # noqa: E402
from run import open_game, true_positions   # noqa: E402


def main():
    b = Bridge()
    try:
        open_game(b, 'secret')
        time.sleep(8)          # 等第一批弹出来
        rows = []
        for _ in range(40):
            t0 = time.perf_counter()
            r = b.frame()
            t1 = time.perf_counter()
            tr = true_positions(b)
            t2 = time.perf_counter()
            rows.append((r['seq'], tr['t'], len(tr['bullets']),
                         (t1 - t0) * 1000, (t2 - t1) * 1000))
            time.sleep(0.03)
        seq = [r[0] for r in rows]
        gap = [seq[i + 1] - seq[i] for i in range(len(seq) - 1)]
        print('取帧耗时中位 %.1f ms，读真值 %.1f ms'
              % (np.median([r[3] for r in rows]), np.median([r[4] for r in rows])))
        print('相邻两次取帧的 seq 差：中位 %d，最小 %d，最大 %d'
              % (int(np.median(gap)), min(gap), max(gap)))
        print('这段时间里游戏 t 从 %.2f 走到 %.2f（%.2f 秒，%d 帧）'
              % (rows[0][1], rows[-1][1], rows[-1][1] - rows[0][1], len(rows)))
        print('\nseq 与弹数的对应：')
        for s, t, n, a, c in rows[:20]:
            print('  seq %4d  t=%6.2f  弹 %3d' % (s, t, n))
        # 同一 seq 出现多次 = 画面根本没更新
        uniq = len(set(seq))
        print('\n%d 次取帧只拿到 %d 个不同的 seq' % (len(rows), uniq))
    finally:
        b.close()


if __name__ == '__main__':
    main()
