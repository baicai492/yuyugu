"""主循环：抓屏 → 识别 → 决策 → 动鼠标。

状态机
------
idle      没在托管
searching 托管中，正在屏幕上找斗法场地
running   正在打
ended     这一局打完了（场地消失 / Boss 血条消失且场上有段时间没子弹）
error     抓屏失败之类

一局打完不会自动点「再来一局」——那属于操作游戏 UI，不在本程序范围。
"""
import threading
import time
from collections import deque

import numpy as np

from ai import Tracker, Dodger, clamp_player, PLAYER_SPEED
from io_win import Screen, Mouse, cursor_pos, LiveFeed
from vision import (Field, FIELD_W, FIELD_H,
                    locate_field, locate_field_full, crop_field,
                    detect_objects, detect_near, laser_points,
                    read_boss_hp, frame_is_dark, CAL)

VERSION = '0.2.1'

# 判受击：自机雪碧图连续消失多久算死了一次。
#
# 规则里死亡动画 0.8 秒完全不画自机（danmaku.js:244 的 if(!P.dead)），
# 而复活后的 2.5 秒无敌期里雪碧图是按 20 Hz 闪烁的（每 50 毫秒亮/暗一次）。
# 所以「消失」必须按**持续时间**判，不能按「连续几帧」：
#   30 fps 下 6 帧只有 0.2 秒，闪烁就能骗过去；
#   8 fps 下 0.8 秒的死亡刚好 6 帧，判据看起来又是对的。
# 2026-11-15 线上那局只有 3 条命却报了 6 次受击，就是这么来的。
HIT_ABSENT_SEC = 0.6


def _whale_pixels(img, player, cal=CAL):
    """数自机区域里的「鲸鱼色」像素，并给出质心。返回 (像素数, (x,y) 或 None)。

    质心比自机中心高 6 像素（雪碧图按 (P.x, P.y-6) 画），扣回来就是 P。
    """
    px, py = player
    x0 = int((px - 23) * cal); x1 = int((px + 23) * cal)
    y0 = int((py - 35) * cal); y1 = int((py + 22) * cal)
    x0 = max(0, x0); y0 = max(0, y0)
    x1 = min(img.shape[1], x1); y1 = min(img.shape[0], y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return 0, None
    sub = img[y0:y1, x0:x1]
    b = sub[:, :, 0].astype(np.int16)
    g = sub[:, :, 1].astype(np.int16)
    r = sub[:, :, 2].astype(np.int16)
    m = (b > g + 25) & (b > r + 12) & (b > 80)
    cnt = int(m.sum())
    if cnt < 12:
        return cnt, None
    ys, xs = np.nonzero(m)
    return cnt, ((xs.mean() + x0) / cal, (ys.mean() + y0) / cal + 6.0)


class Engine:
    def __init__(self, cfg=None, screen=None, mouse=None):
        self.cfg = {
            'fps': 30,              # 目标循环频率
            'horizon': 0.45,        # 走位预判时长（秒）
            'bomb': True,           # 允许自动放符卡
            'bomb_clearance': 3.0,  # 余量低于这个就放符卡
            'dry': False,           # 只识别不动鼠标
            'monitor': 1,           # 0=全部显示器
            'reaction': 1.0,        # 0.5=更灵敏 2=更稳（放大安全余量）
            'pipeline': True,       # 抓屏放后台线程（启动时决定；离线模拟必须关掉）
        }
        if cfg:
            self.cfg.update({k: v for k, v in cfg.items() if k in self.cfg})

        self.screen = screen or Screen(self.cfg['monitor'])
        self.mouse = mouse or Mouse(dry=self.cfg['dry'])
        # 抓屏是最慢的一步（区域 657x866 实测 17ms），放后台和识别并行。
        self.feed = LiveFeed(self.screen) if self.cfg['pipeline'] else None
        self.tracker = Tracker()
        self.dodger = Dodger(horizon=self.cfg['horizon'])
        self.dodger.bomb_clearance = self.cfg['bomb_clearance']

        self.lock = threading.RLock()
        # 时间/睡眠走可替换的函数：离线模拟时换成虚拟时钟，跑得比真机快几十倍
        self.now = time.time
        self.sleep = time.sleep
        self.logs = deque(maxlen=400)
        self._stop = threading.Event()
        self._thread = None

        self.running = False
        self.state = 'idle'
        self.message = ''
        self.field = None
        self.hint = None             # 内容脚本量出来的场地矩形（加速定位）
        self.player = (FIELD_W / 2, FIELD_H - 60)
        self.hits = 0
        self.bombs = 2
        self.bullets = 0
        self.own = 0
        self.boss = False
        self.hp = 0.0
        self.fps = 0.0
        self.frames = 0
        self.t_start = 0.0
        self.t_end = 0.0
        self.last_clearance = 999.0
        self.las = 0
        self.haz = 0
        self._prev_enemy = 0
        self._empty_since = None     # 自机开始「看不见」的时刻
        self._no_boss = 0
        self._no_bullets = 0
        self._seen_boss = False
        self._lost = 0
        self._relost = 0
        self._last_bomb = 0.0
        self._hit_lock = 0.0
        self._pending = None
        self.whale = 0
        self.wpos = None
        self._t_last = 0.0
        self._fps_ema = 0.0
        self._haz_cache = np.zeros((0, 3), np.float32)

    # ---------------- 日志 / 状态 ----------------
    def log(self, msg, level='info'):
        with self.lock:
            self.logs.append({'t': self.now(), 'msg': str(msg), 'level': level})
        print(('[干] ' if self.cfg['dry'] else '') + msg, flush=True)

    def status(self):
        with self.lock:
            return {
                'ok': True,
                'version': VERSION,
                'running': self.running,
                'state': self.state,
                'message': self.message,
                'fps': round(self.fps, 1),
                'bullets': self.bullets,
                'own': self.own,
                'lasers': self.las,
                'hazards': self.haz,
                'boss': self.boss,
                'hp': round(self.hp, 3),
                'player': [round(self.player[0], 1), round(self.player[1], 1)],
                'whale': self.whale,
                'elapsed': round((self.t_end or self.now()) - self.t_start, 1) if self.t_start else 0,
                'hits': self.hits,
                'bombs': self.bombs,
                'clearance': round(self.last_clearance, 1),
                'field': self.field.as_dict() if self.field else None,
                'frames': self.frames,
                'dry': self.cfg['dry'],
                'logs': list(self.logs)[-80:],
            }

    # ---------------- 控制 ----------------
    def start(self):
        with self.lock:
            if self.running and self.state in ('running', 'searching'):
                return
            self.running = True
            self.state = 'searching'
            self.message = ''
            self.field = None
            self.player = (FIELD_W / 2, FIELD_H - 60)
            self.hits = 0
            self.bombs = 2
            self.t_start = self.now()
            self.t_end = 0.0
            self.frames = 0
            self._prev_enemy = 0
            self._empty_since = None
            self._no_boss = 0
            self._no_bullets = 0
            self._seen_boss = False
            self._lost = 0
            self._relost = 0
            self._last_bomb = 0.0
            self._hit_lock = 0.0
            self._pending = None
            self._t_last = self.now()
            self._haz_cache = np.zeros((0, 3), np.float32)
            self.tracker.reset()
        if self.feed is not None:
            self.feed.arm()
        self.log('开始托管：等待斗法画面…')

    def stop(self, why=''):
        with self.lock:
            self.running = False
            self.state = 'idle'
            self.message = why
            # 计时必须在停止这一刻冻住：否则 status 的 elapsed 会一直用 now()
            # 往前推，面板上看起来像「停了还在计时」。
            if self.t_start and not self.t_end:
                self.t_end = self.now()
        if self.feed is not None:
            self.feed.disarm()
        self.log('停止托管' + ('（' + why + '）' if why else ''))

    def set_hint(self, rect):
        """内容脚本上报的场地矩形（屏幕坐标），只用来缩小首次定位的搜索范围。"""
        try:
            r = {k: float(rect[k]) for k in ('x', 'y', 'w', 'h')}
        except (KeyError, TypeError, ValueError):
            return
        if r['w'] > 100 and r['h'] > 100:
            self.hint = r

    def set_config(self, patch):
        with self.lock:
            for k, v in (patch or {}).items():
                if k in self.cfg:
                    self.cfg[k] = v
            if 'dry' in (patch or {}):
                self.mouse.dry = bool(self.cfg['dry'])
            if 'horizon' in (patch or {}):
                self.dodger.horizon = float(self.cfg['horizon'])
            if 'bomb_clearance' in (patch or {}):
                self.dodger.bomb_clearance = float(self.cfg['bomb_clearance'])
            if 'reaction' in (patch or {}):
                self.dodger.margin = 2.5 * float(self.cfg['reaction'])
        return dict(self.cfg)

    def start_thread(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name='engine', daemon=True)
        self._thread.start()

    def shutdown(self):
        self._stop.set()
        self._thread and self._thread.join(timeout=2.0)
        # 抓屏线程要在 Screen 之前停：它每一轮都拿着同一个 mss 实例在 grab，
        # 先关 Screen 会让后台线程在 close 过的 mss 上继续调用。
        if self.feed is not None:
            self.feed.close()
        self.screen.close()

    # ---------------- 主循环 ----------------
    def _loop(self):
        while not self._stop.is_set():
            if not self.running or self.state == 'ended':
                self.sleep(0.05)
                continue
            target = 1.0 / max(5, int(self.cfg['fps']))   # 允许运行时改帧率
            t0 = time.perf_counter()
            try:
                self._tick()
            except Exception as e:      # 单帧出错不该让整个托管死掉
                self.message = str(e)
                self.log('巡视出错：%s' % e, 'err')
                self.sleep(0.2)
            dt = time.perf_counter() - t0
            self._fps_ema = 0.9 * self._fps_ema + 0.1 * (1.0 / max(1e-3, dt))
            self.fps = self._fps_ema
            remain = target - dt
            if remain > 0:
                self.sleep(remain)

    def _tick(self):
        now = self.now()
        dt = min(0.1, max(0.005, now - self._t_last)) if self._t_last else 1 / 30
        self._t_last = now

        # 0) 推自机位置：上一帧设的指针，游戏在这一帧里已经照着走过了。
        #    这一步必须放在识别之前，否则推算位置永远比真正的位置超前
        #    一帧（300 px/s × 1/30 ≈ 10 像素），挖空区和走位都会偏。
        self._advance_player(dt)

        # 1) 定位场地
        field, crop = self._grab_field()
        if field is None:
            self._lost += 1
            # 连着几帧找不到，先彻底放手，下一帧整屏重找（窗口可能被拖走了）
            if self._lost == 6:
                self.field = None
            if self.state == 'running' and self._lost > 60:
                self._finish('斗法画面消失')
            elif self.state == 'searching' and now - self.t_start > 180:
                self.stop('两分钟没找到斗法画面')
            else:
                self.sleep(0.08)
            return
        self._lost = 0
        self.field = field
        if self.state == 'searching':
            self.state = 'running'
            self.log('找到斗法场地：%.0fx%.0f @ (%.0f,%.0f)' % (field.w, field.h, field.x, field.y))

        # 2) 识别 + 跟踪
        #    先把 Boss 血条读出来：HUD 的位置跟着 Boss 在不在变（danmaku.js:266），
        #    识别时要把对应的文字带挖掉，否则 Boss 在场时会平白多出几十颗「子弹」。
        boss, hp = read_boss_hp(crop)
        want_haz = self.frames % 3 == 0
        dets, lasers, hazards = detect_objects(crop, self.player, boss=boss,
                                               want_hazards=want_haz)
        # 近身补检：全局阈值为了压背景误检卡得严，自机周围这一圈放宽一点
        # （见 vision.detect_near）。两边都检出来的弹会产生两条轨迹，
        # 所以离主检出 4 像素以内的补检结果丢掉。
        extra = detect_near(crop, self.player)
        if len(extra):
            if len(dets):
                dm = np.linalg.norm(extra[:, None, :2] - dets[None, :, :2],
                                    axis=2).min(axis=1)
                extra = extra[dm > 4.0]
            if len(extra):
                dets = np.concatenate([dets, extra], axis=0) if len(dets) else extra
        if want_haz:
            self._haz_cache = hazards
        else:
            hazards = self._haz_cache
        arr, total, own = self.tracker.update(dets, dt, self.player)
        enemy = len(arr)
        lpts = laser_points(lasers)
        if len(hazards):
            # 敌机是「静止障碍」：不进跟踪器（精灵每帧换形，轨迹会乱），
            # 每帧现算位置直接并进危险集合。
            hz = np.empty((len(hazards), 5), np.float32)
            hz[:, :2] = hazards[:, :2]
            hz[:, 2:4] = 0.0
            hz[:, 4] = hazards[:, 2]
            arr = np.concatenate([arr, hz], axis=0) if len(arr) else hz
        if len(lpts):
            arr = np.concatenate([arr, lpts], axis=0) if len(arr) else lpts

        # 3) 受击：自机雪碧图在场上持续消失。
        #
        #    判据是「持续时间」而不是「连续几帧」，理由见 HIT_ABSENT_SEC。
        #    雪碧图消失的三种情况：死亡动画（0.8 秒，完全不画）、复活后的无敌
        #    闪烁（20 Hz，每次 50 毫秒）、Boss 换阶段的短暂清屏。只有第一种
        #    长到能过 0.6 秒的阈值。
        whale, wpos = _whale_pixels(crop, self.player)
        self.whale = whale
        self.wpos = wpos
        if whale >= 120 and wpos is not None:
            dx = wpos[0] - self.player[0]
            dy = wpos[1] - self.player[1]
            if abs(dx) < 70 and abs(dy) < 70:      # 质心纠偏，防止推算漂移
                self.player = (self.player[0] + dx * 0.5, self.player[1] + dy * 0.5)
        if whale < 25:
            if self._empty_since is None:
                self._empty_since = now
            elif now > self._hit_lock and now - self._empty_since >= HIT_ABSENT_SEC:
                self._on_hit('自机被击中', now)
        else:
            self._empty_since = None

        # 4) 走位
        target, info = self.dodger.decide(self.player, arr)
        self.last_clearance = info['clearance']
        self._drive(target)

        # 5) 符卡
        if info['bomb'] and self.cfg['bomb'] and self.bombs > 0 and now - self._last_bomb > 1.6:
            self.mouse.right_click()
            self.bombs -= 1
            self._last_bomb = now
            self.log('放符卡（余量 %.1f 像素）' % self.last_clearance, 'warn')
            self.tracker.reset()
            enemy = 0

        # 6) 结束判定
        #    Boss 换阶段会清屏（danmaku.js 里 clearBullets），所以「没子弹」
        #    只有在 Boss 血条也没了之后才算数，否则每个阶段都会误判一次。
        self._no_boss = self._no_boss + 1 if not boss else 0
        self._no_bullets = self._no_bullets + 1 if enemy <= 1 else 0
        if boss:
            self._seen_boss = True
            self._no_bullets = 0
        if self._seen_boss and self._no_boss > 90:
            self._finish('Boss 血条消失')
        elif (not boss) and self._no_bullets > 150 and frame_is_dark(crop) < 26:
            self._finish('画面变暗且长时间没有子弹')

        with self.lock:
            self.field = field
            self.bullets = enemy
            self.own = own
            self.las = len(lasers)
            self.haz = len(hazards)
            self.boss = boss
            self.hp = hp
            self.frames += 1
            self._prev_enemy = enemy

    def _grab(self, rect):
        """抓一帧：有后台抓屏线程就用它的最新帧，否则直接抓。"""
        if self.feed is not None:
            return self.feed.grab(rect)
        return self.screen.grab(rect)

    def _grab_field(self):
        """抓一帧并把场地裁出来。返回 (Field, 识别图) 或 (None, None)。"""
        # 先把 self.field 取到本地：UI 线程随时可能 start() 把它清成 None，
        # 每处都重新读一次 self.field 就有在两次读之间变成 None 的窗口。
        cur = self.field
        if cur is None:
            img = self._grab(None)                # 整屏找
            if img is None:
                return None, None
            f = locate_field_full(img, self.hint)
            if f is None:
                return None, None
            crop = crop_field(img, f)
            return (f, crop) if crop is not None else (None, None)
        pad = 10
        # 抓取矩形要夹在屏幕内：浏览器窗口顶到屏幕边缘时，pad 会把矩形推到画面外，
        # 抓回来的图就少了那一条，crop_field 会判定「场地被裁掉一截」直接返回 None，
        # 于是每帧都白跑一遍识别（场地贴边很常见，窗口最大化就是这样）。
        x, y, w, h = cur.rect(pad)
        bx, by, bw, bh = self.screen.bounds()
        x0 = max(bx, x); y0 = max(by, y)
        x1 = min(bx + bw, x + w); y1 = min(by + bh, y + h)
        if x1 - x0 < 60 or y1 - y0 < 60:
            return None, None
        img = self._grab((x0, y0, x1 - x0, y1 - y0))
        if img is None:
            return None, None
        # 场地在这张裁剪图里的位置（夹紧之后才是准的）
        lx, ly = cur.x - x0, cur.y - y0
        # 在裁剪图里重新定位：窗口被拖动/缩放时自动跟上。
        # 单帧找不到就沿用上一帧的矩形（边框可能被自机/弹幕压住）；
        # 连着 12 帧都找不到说明窗口真的动了，清掉让下一帧整屏重找。
        f2 = locate_field(img, {'x': lx, 'y': ly, 'w': cur.w, 'h': cur.h})
        if f2 is None:
            self._relost += 1
            if self._relost > 12:
                # 这里绝不能先 self.field = None 再用 self.field.x：
                # 2026-11-15 线上就是这么抛的
                # 'NoneType' object has no attribute 'x'，那一帧识别/走位全跳过。
                self._relost = 0
                self.field = None
                return None, None
            crop = crop_field(img, Field(lx, ly, cur.w, cur.h))
            return (cur, crop) if crop is not None else (None, None)
        self._relost = 0
        f2 = Field(f2.x + x0, f2.y + y0, f2.w, f2.h)
        crop = crop_field(img, Field(f2.x - x0, f2.y - y0, f2.w, f2.h))
        # crop 可能是 None（场地被屏幕边缘截掉一截）。这时不能把 None 传下去，
        # 否则 read_boss_hp(None) 会在这里抛 TypeError，整帧识别/走位全跳过。
        return (f2, crop) if crop is not None else (None, None)

    def _advance_player(self, dt):
        """按游戏规则把自机朝「上一帧设的指针」推进一步（danmaku.js:164）。"""
        tgt = self._pending
        if tgt is None:
            return
        px, py = self.player
        dx, dy = tgt[0] - px, tgt[1] - py
        d = (dx * dx + dy * dy) ** 0.5
        if d > 0.5:
            k = min(d, PLAYER_SPEED * dt)
            px += dx / d * k
            py += dy / d * k
        self.player = clamp_player(px, py)

    def _drive(self, target):
        """把指针移到目标点。位置推算在下一次 _advance_player 里做。"""
        fx, fy = clamp_player(*target)
        self._pending = (fx, fy)
        f = self.field
        if f is None:              # 场地刚被 UI 线程清掉，这一帧不动鼠标
            return
        if not self.cfg['dry']:
            self.mouse.move(*f.to_screen(fx, fy))

    def _on_hit(self, why, now=None):
        now = self.now() if now is None else now
        self.hits += 1
        self.bombs = max(self.bombs, 2)     # danmaku.js:225 复活后符卡补满到 2
        self.player = (FIELD_W / 2, FIELD_H - 50)
        self._pending = None               # 别把死亡前的走位目标继续外推
        self._empty_since = None
        self._prev_enemy = 0
        # 复活后 2.5 秒无敌（danmaku.js:166），这段时间里雪碧图 20 Hz 闪烁。
        # 锁 3.2 秒：判受击本身要等 0.6 秒，加起来才盖得住无敌期，
        # 否则闪烁会被当成第二次、第三次死亡。
        self._hit_lock = now + 3.2
        self.tracker.reset()
        self.log('%s，自机回到中下方（第 %d 次）' % (why, self.hits), 'warn')

    def _finish(self, why):
        if self.state == 'ended':
            return
        with self.lock:
            self.state = 'ended'
            self.t_end = self.now()
            self.message = why
        self.log('本局结束：%s（用时 %.0f 秒，被击中 %d 次）'
                 % (why, self.t_end - self.t_start, self.hits))
