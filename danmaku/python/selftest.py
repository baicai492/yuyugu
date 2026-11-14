"""离线自测：不开浏览器、不需要登录态，把整条链路跑一遍。

    python selftest.py            跑默认 200 秒（虚拟时间）的一局，打印统计
    python selftest.py 400        跑 400 秒
    python selftest.py --dump D   把带标注的画面存到 D 目录，肉眼核对识别结果

它验证四件事：
  1. 场地边框定位出来的矩形和模拟器里画的一致（误差 < 2 逻辑像素）
  2. 子弹检测的漏检/误检率（对照模拟器的真实弹位）
  3. Boss 在场时 HUD 文字带没有被当成子弹
  4. 闭环：引擎真的在躲，统计受击次数与存活时间
"""
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cv2                      # noqa: E402
from sim import SimGame, SimScreen, SimMouse   # noqa: E402
from engine import Engine       # noqa: E402
from vision import (locate_field, crop_field, detect_objects,   # noqa: E402
                    read_boss_hp, FIELD_W, FIELD_H)


def test_locate(rounds=20):
    errs = []
    for i in range(rounds):
        g = SimGame(seed=100 + i, origin=(300 + i * 3, 80 + i * 2))
        g.step(0.5)
        img = g.render()
        f = locate_field(img)
        if f is None:
            print('  ✗ 第 %d 帧没找到场地' % i)
            continue
        errs.append(max(abs(f.x - g.fx), abs(f.y - g.fy),
                        abs(f.w - g.fw), abs(f.h - g.fh)))
    if not errs:
        print('场地定位：全部失败')
        return False
    print('场地定位：%d/%d 成功，最大误差 %.1f 屏幕像素' % (len(errs), rounds, max(errs)))
    return max(errs) <= 4


def test_detect(rounds=40):
    tp = fp = fn = 0
    for i in range(rounds):
        g = SimGame(seed=200 + i)
        for _ in range(int(g.rng.randint(40, 220))):
            g.step(1 / 30)
        img = g.render()
        f = locate_field(img)
        if f is None:
            continue
        crop = crop_field(img, f)
        dets, _, _ = detect_objects(crop, (g.player.x, g.player.y))
        real = np.array([[b.x, b.y] for b in g.bullets], np.float32)
        det = dets[:, :2] if len(dets) else np.zeros((0, 2), np.float32)
        if len(real) and len(det):
            d = np.linalg.norm(real[:, None, :] - det[None, :, :], axis=2)
            tp += int((d.min(axis=1) < 9).sum())
            fn += int((d.min(axis=1) >= 9).sum())
            fp += int((d.min(axis=0) >= 9).sum())
        elif len(real):
            fn += len(real)
        elif len(det):
            fp += len(det)
    tot = tp + fn
    print('子弹检测：命中 %d/%d（%.1f%%），误检 %d（其中含自机子弹/道具/敌机）'
          % (tp, tot, 100.0 * tp / max(1, tot), fp))
    return tp / max(1, tot) > 0.85


def test_boss_hud(warmup=20.0):
    """Boss 在场时 HUD 会往下挪（danmaku.js:266 hy=66/81），白字必须被挖掉。

    2026-11-15 线上那局的「敌弹 205 颗」有一大半是这两行白字：
    识别时把它们当成子弹，整局都在躲空气。

    模拟器的字比真实画布小，白字只碎成一两颗「子弹」，所以不按绝对数量判，
    而是**同一帧跑两遍**：boss=True（按血条挖掉文字带）必须比 boss=False 更少。
    旧代码只挖顶部 30 像素，两遍结果一模一样，这条断言就会失败。
    """
    g = SimGame(seed=301)
    g.player.inv = 1e9          # 没人操作时自机会在 14 秒左右被打光，先开无敌
    while g.t < warmup and not g.ended:
        g.step(1 / 30)
    if not g.boss:
        print('Boss HUD：模拟里没等到 Boss，跳过')
        return True
    img = g.render()
    f = locate_field(img)
    if f is None:
        print('Boss HUD：场地没找到')
        return False
    crop = crop_field(img, f)
    boss, hp = read_boss_hp(crop)
    pl = (g.player.x, g.player.y)

    def band_count(use_boss):
        dets, _, _ = detect_objects(crop, pl, boss=use_boss)
        d = dets[:, :2] if len(dets) else np.zeros((0, 2), np.float32)
        # 「命 xx 符 xx」两行所在的带（BOSS_HUD_Y），只看左半边
        return int(((d[:, 1] >= 54) & (d[:, 1] <= 88) & (d[:, 0] < 214)).sum())

    with_mask = band_count(True)
    without = band_count(False)
    print('Boss HUD：boss=%s 血量 %.0f%%，HUD 带内残留 %d 颗（不挖文字带时 %d 颗）'
          % (boss, hp * 100, with_mask, without))
    return boss and with_mask < without


def test_closed_loop(seconds=200, dump=None, verbose=False, seed=7):
    g = SimGame(seed=seed)
    scr = SimScreen(g)
    mou = SimMouse(g)
    # pipeline 必须关掉：LiveFeed 会把 grab 挪到后台线程，而 SimScreen 每抓一帧
    # 就推进一次模拟（渲染和时钟绑在一起），两个线程同时 grab 等于把时间线搅乱。
    eng = Engine(cfg={'fps': 60, 'dry': False, 'pipeline': False},
                 screen=scr, mouse=mou)
    eng.now = lambda: g.clock
    eng.sleep = lambda s: None
    eng.start()

    frames = int(seconds * 30)
    t0 = time.perf_counter()
    hit_at = []
    last_hits = 0
    pending = []
    for i in range(frames):
        if g.ended:
            break
        eng._tick()
        if eng.state == 'ended':
            break
        if g.hits != last_hits:
            hit_at.append(round(g.t, 1))
            last_hits = g.hits
        if dump and i % 45 == 0:
            img = g.render()
            f = locate_field(img)
            if f is not None:
                crop = crop_field(img, f)
                boss, _ = read_boss_hp(crop)
                dets, lasers, haz = detect_objects(crop, eng.player, boss=boss)
                vis = cv2.resize(crop, (FIELD_W * 2, FIELD_H * 2))
                for x, y, r in dets:
                    cv2.circle(vis, (int(x * 2), int(y * 2)), max(3, int(r * 2)), (0, 255, 0), 1)
                for L in lasers:
                    cv2.line(vis, (int(L['x'] * 2), int(L['y'] * 2)),
                             (int((L['x'] + L['dx'] * L['len']) * 2),
                              int((L['y'] + L['dy'] * L['len']) * 2)), (0, 0, 255), 2)
                for x, y, r in haz:
                    cv2.circle(vis, (int(x * 2), int(y * 2)), int(r * 2), (255, 0, 255), 2)
                px, py = eng.player
                cv2.circle(vis, (int(px * 2), int(py * 2)), 6, (0, 128, 255), 2)
                cv2.imwrite(os.path.join(dump, 'frame-%04d.png' % i), vis)
    wall = time.perf_counter() - t0

    st = eng.status()
    print('\n闭环：模拟 %.1f 秒 / 真实耗时 %.1f 秒（%.1f 倍速），共 %d 帧，%.1f fps'
          % (g.t, wall, g.t / max(1e-6, wall), frames, g.clock / max(1e-6, wall)))
    print('  结果：%s，被击中 %d 次（第 %s 秒），放符卡 %d 张'
          % ({None: '未结束', 'win': '胜', 'lose': '败'}[g.ended], g.hits,
             '、'.join(str(x) for x in hit_at) or '无', mou.clicks))
    print('  结束原因：%s' % (st['message'] or '-'))
    print('  平均每帧 %.1f 毫秒' % (wall * 1000 / max(1, frames)))
    return g.ended == 'win', g.hits, g.t


def main():
    args = sys.argv[1:]
    dump = None
    if '--dump' in args:
        dump = args[args.index('--dump') + 1]
        os.makedirs(dump, exist_ok=True)
    seed = 7
    if '--seed' in args:
        seed = int(args[args.index('--seed') + 1])
    secs = 200.0
    for a in args:
        if a.replace('.', '', 1).isdigit():
            secs = float(a)
    print('=== 1/4 场地定位 ===')
    ok1 = test_locate()
    print('\n=== 2/4 子弹识别 ===')
    ok2 = test_detect()
    print('\n=== 3/4 Boss HUD 掩码 ===')
    ok_boss = test_boss_hud()
    print('\n=== 4/4 闭环走位 ===')
    ok3, hits, t = test_closed_loop(secs, dump, seed=seed)
    print('\n总结：定位%s，识别%s，Boss HUD%s，闭环%s'
          % ('通过' if ok1 else '有问题', '通过' if ok2 else '有问题',
             '通过' if ok_boss else '有问题',
             '通过' if ok3 else '未通关（受击 %d 次，存活 %.0f 秒）' % (hits, t)))


if __name__ == '__main__':
    main()
