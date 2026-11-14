"""在真实游戏上跑闭环，并允许命令行改识别常量。

    python bench.py secret 60                      现状
    python bench.py secret 60 SAT_V=195 SAT_S=45   改阈值再跑

输出：真实受击次数（来自游戏自己的 P.lives）、引擎判定受击、帧率、用时。
"""
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'python'))

import vision                                     # noqa: E402
from bridge_client import Bridge                  # noqa: E402
from engine import Engine                         # noqa: E402


def main():
    stage = sys.argv[1] if len(sys.argv) > 1 else 'secret'
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 60
    for kv in sys.argv[3:]:
        k, v = kv.split('=')
        setattr(vision, k, float(v))
    from run import open_game, true_positions, CastScreen, CastMouse, PAGE_W, PAGE_H

    b = Bridge()
    try:
        open_game(b, stage)
        scr = CastScreen(b)
        mou = CastMouse(b)
        eng = Engine(cfg={'fps': 30, 'dry': False, 'pipeline': False},
                     screen=scr, mouse=mou)
        eng.start()
        t0 = time.time()
        last_lives = None
        hits = []
        frames = 0
        last_note = 0
        _state = {}
        feats_tp = []
        feats_fp = []
        fp_vy = []
        patch_dir = os.environ.get('BENCH_PATCH')
        if patch_dir:
            os.makedirs(patch_dir, exist_ok=True)
        while time.time() - t0 < secs:
            if b.eval('window.__state') == 'done':
                break
            try:
                eng._tick()
            except Exception as e:      # 游戏结束时画布会被移除，收尾就好
                print('  引擎退出：%s' % e)
                break
            frames += 1
            tr = true_positions(b)
            if tr is None:
                break
            if last_lives is not None and tr['lives'] < last_lives:
                hits.append(round(tr['t'], 1))
            last_lives = tr['lives']
            # 危险集合的成色：有多少条轨迹真的对应一颗弹
            real = np.array([[x, y] for x, y, *_ in tr['bullets']], np.float32) \
                if tr['bullets'] else np.zeros((0, 2), np.float32)
            det = np.array([[t.x, t.y] for t in eng.tracker.tracks if not t.own],
                           np.float32)
            if len(det) and len(real):
                dd = np.linalg.norm(real[:, None, :] - det[None, :, :], axis=2)
                # 容差放大到 22：抓到的画面比真值晚一帧（40~80 毫秒），
                # 240 px/s 的弹在这段时间里已经飞了 10~20 像素，
                # 用 15 会把真弹算成假弹。
                is_tp = dd.min(axis=0) < 22
                good = int(is_tp.sum())
                found = int((dd.min(axis=1) < 22).sum())
            else:
                good = 0
                found = 0
                is_tp = np.zeros(len(det), bool)
            track_arr = [t for t in eng.tracker.tracks if not t.own]
            for i, t in enumerate(track_arr):
                feat = (float(np.hypot(t.vx, t.vy)), float(t.r), float(t.age))
                (feats_tp if is_tp[i] else feats_fp).append(feat)
                if not is_tp[i]:
                    fp_vy.append(float(t.vy))
                # 想看误检长什么样：BENCH_PATCH=_dir，随机存若干块
                if patch_dir and not is_tp[i] and t.age >= 8 and np.random.rand() < 0.03:
                    img = scr._img
                    if img is not None and eng.field is not None:
                        sx, sy = eng.field.to_screen(t.x, t.y)
                        ix, iy = int(sx), int(sy)
                        if 26 < ix < img.shape[1] - 26 and 26 < iy < img.shape[0] - 26:
                            p = img[iy - 26:iy + 26, ix - 26:ix + 26]
                            if p.size:
                                cv2.imwrite(os.path.join(patch_dir, 't%03d.png' % len(os.listdir(patch_dir))),
                                            cv2.resize(p, (416, 416), interpolation=cv2.INTER_NEAREST))
            _state['tp'] = _state.get('tp', 0) + found
            _state['fp'] = _state.get('fp', 0) + (len(det) - good)
            _state['real'] = _state.get('real', 0) + len(real)
            _state['nf'] = _state.get('nf', 0) + 1
            # 近身 120 逻辑像素内的召回：这才是真正决定生死的指标
            p = np.array([tr['px'], tr['py']], np.float32)
            near = real[np.linalg.norm(real - p, axis=1) < 120] if len(real) else real
            if len(near):
                dn = np.linalg.norm(near[:, None, :] - det[None, :, :], axis=2) \
                    if len(det) else np.full((len(near), 1), 1e9)
                _state['ntp'] = _state.get('ntp', 0) + int((dn.min(axis=1) < 22).sum())
                _state['nreal'] = _state.get('nreal', 0) + len(near)

            if time.time() - last_note > 10:
                last_note = time.time()
                nf = max(1, _state['nf'])
                print('  %5.1f 秒  %.1f fps  真值弹 %3d  危险集合 %3d（命中 %3d）'
                      '  召回 %.0f%%  假/帧 %.1f  命 %d  轨迹 %d 背景 %d'
                      '（拦 %d / 删 %d）  近身召回 %.0f%%  激光 %d 敌机 %d'
                      % (tr['t'], frames / (time.time() - t0), len(real), len(det), found,
                         100.0 * _state['tp'] / max(1, _state['real']),
                         _state['fp'] / nf, tr['lives'],
                         len(eng.tracker.tracks), len(eng.tracker.bg),
                         eng.tracker.c_bg_skip, eng.tracker.c_bg_drop,
                         100.0 * _state.get('ntp', 0) / max(1, _state.get('nreal', 0)),
                         eng.las, eng.haz), flush=True)
                _state.update(tp=0, fp=0, real=0, nf=0, ntp=0, nreal=0)
        tr = true_positions(b) or {}
        st = eng.status()
        dur = frames / max(1e-6, time.time() - t0)
        print('\n=== %s ===  真实受击 %d 次（第 %s 秒）  引擎判定 %d 次'
              % (stage, len(hits), '、'.join(str(x) for x in hits) or '无', st['hits']))
        for name, arr in (('真弹', feats_tp), ('假弹', feats_fp)):
            if not arr:
                continue
            a = np.array(arr, np.float32)
            q = lambda j, p: np.percentile(a[:, j], p)
            print('  %s n=%d  速度 25/50/75%%=%.0f/%.0f/%.0f  r 50/90%%=%.1f/%.1f  '
                  'age 50/90%%=%.0f/%.0f'
                  % (name, len(a), q(0, 25), q(0, 50), q(0, 75),
                     q(1, 50), q(1, 90), q(2, 50), q(2, 90)))
        if fp_vy:
            v = np.array(fp_vy, np.float32)
            print('  假弹按 vy 分：向上快(<-350) %d 条（自机弹没认出来！）  '
                  '静止(|vy|<60) %d 条  其余 %d 条'
                  % (int((v < -350).sum()), int((np.abs(v) < 60).sum()),
                     int(((v >= -350) & (np.abs(v) >= 60)).sum())))
        try:
            res = b.eval('window.__result') or {}
        except Exception:
            res = '(页面已关)'
        print('  游戏内 %s，用时 %.1f 秒，引擎 %d 帧 %.1f fps'
              % (res, tr.get('t', 0), frames, dur))
        return len(hits)
    finally:
        b.close()


if __name__ == '__main__':
    main()
