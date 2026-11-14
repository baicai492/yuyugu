"""离线模拟器：把 new4/xs/danmaku.js 的核心动力学搬过来，用来在没有浏览器、
没有登录态的情况下反复验证「识别 → 跟踪 → 走位」这条链路。

它只模仿和**安全**有关的部分：自机移动、自动射击、敌弹运动、受击判定、
Boss 血条、激光。美术是拿 cv2 近似画的（发光弹体、鲸鱼自机、深色背景），
刻意保留了真实截图里那些会干扰识别的元素（自机亮蓝色、HUD 白字、
Boss 血条、横幅大字、竹林绿背景）。

用法见 selftest.py。注意：它是测试台，不是「线上一定能赢」的证明。
"""
import math
import numpy as np
import cv2

FIELD_W, FIELD_H = 384, 512
TAU = math.pi * 2

PAL = {
    'red': ((64, 64, 255), (208, 208, 255)),
    'orange': ((48, 154, 255), (192, 230, 255)),
    'yellow': ((64, 224, 255), (208, 251, 255)),
    'green': ((112, 224, 80), (224, 255, 216)),
    'cyan': ((255, 224, 64), (250, 248, 216)),
    'blue': ((255, 112, 64), (255, 226, 216)),
    'purple': ((255, 80, 176), (255, 220, 240)),
    'pink': ((192, 96, 255), (242, 224, 255)),
    'white': ((224, 224, 224), (255, 255, 255)),
}
# 绘制尺寸 = SIZE + 6（danmaku.js 的贴图是 (w+6)x(h+6)）
SIZE = {'rice': (12, 6, 3), 'orb': (10, 10, 4), 'big': (28, 28, 11),
        'star': (14, 14, 4.5), 'knife': (20, 7, 3), 'talis': (14, 9, 3.5),
        'fly': (16, 14, 4), 'heart': (16, 16, 5), 'ice': (18, 6, 2.5),
        'small': (7, 7, 2.5)}

PLAYER_SPEED, SLOW_SPEED = 300.0, 130.0


class Bullet:
    __slots__ = ('x', 'y', 'a', 'sp', 'acc', 'min', 'max', 'w', 'g', 'r', 't',
                 'bounce', 'split', 'dead', 'type', 'c', 're', 'reSp', 'reDone')

    def __init__(self, x, y, a, sp, type='rice', c='red', **kw):
        self.x, self.y, self.a, self.sp = x, y, a, sp
        self.type, self.c = type, c
        self.acc = kw.get('acc', 0.0)
        self.min = kw.get('min', 0.0)
        self.max = kw.get('max', 600.0)
        self.w = kw.get('w', 0.0)
        self.g = kw.get('g', 0.0)
        self.r = SIZE[type][2]
        self.t = 0.0
        self.bounce = kw.get('bounce', 0)
        self.split = kw.get('split')
        self.dead = False
        self.re = kw.get('re', 0.0)
        self.reSp = kw.get('reSp', 150.0)
        self.reDone = False


class Player:
    def __init__(self):
        self.x, self.y = FIELD_W / 2, FIELD_H - 60
        self.lives = 3
        self.bombs = 2
        self.inv = 2.0
        self.dead = 0.0
        self.power = 1.0
        self.graze = 0
        self.score = 0
        self.shot_cd = 0.0


class SimGame:
    """一局简化版斗法。step(dt) 推进，render() 出画面。"""

    def __init__(self, screen=(1280, 800), field_px=(456, 608), origin=(410, 96), seed=7):
        self.sw, self.sh = screen
        self.fx, self.fy = origin
        self.fw, self.fh = field_px
        self.s = self.fw / FIELD_W                     # 屏幕像素/逻辑像素
        self.rng = np.random.RandomState(seed)
        self.clock = 0.0
        self.t = 0.0
        self.player = Player()
        self.pointer = None                            # 逻辑坐标；None=不动
        self.slow = False
        self.bullets = []
        self.shots = []
        self.lasers = []
        self.items = []
        self.enemies = []
        self.boss = None
        self.boss_hp = 1.0
        self.hits = 0
        self.deaths = 0
        self.captures = 0
        self.bomb_t = 0.0
        self.banner = 0.0
        self.phase_hit = False
        self.ended = None
        self.waves = self._script()
        self.bg = self._make_bg()

    # ---------------- 关卡脚本 ----------------
    def _script(self):
        return [
            (1.0, lambda: [self._enemy(x, 80 + i * 10, 'bat') for i, x in enumerate([60, 110, 160, 220, 270, 320])]),
            (8.0, lambda: [self._enemy(x, 110, 'spider') for x in (96, 192, 288)]),
            (18.0, lambda: self._start_boss()),
        ]

    def _enemy(self, x, y, kind):
        self.enemies.append({'x': x, 'y': y, 'kind': kind, 't': 0.0,
                             'cd': {'a': 0.6}, 'size': 56 if kind == 'bat' else 70,
                             'hp': 6.0 if kind == 'bat' else 40.0, 'flash': 0.0})
        return None

    def _start_boss(self):
        self.boss = {'x': FIELD_W / 2, 'y': 110, 't': 0.0, 'phase': 0, 'hp': 900, 'hp0': 900,
                     'ptime': 26.0, 'size': 96, 'cd': {}}
        self.boss_hp = 1.0
        self.banner = 1.4

    def _next_phase(self):
        b = self.boss
        if b is None:
            return
        if b['hp'] <= 0 and not self.phase_hit:
            self.captures += 1
        b['phase'] += 1
        if b['phase'] >= 3:
            self.boss = None
            self.bullets = []
            self.boss_hp = 0.0
            self.ended = 'win'
            return
        b['hp'] = b['hp0'] = (900, 1100, 1300)[b['phase']]
        b['ptime'] = (26.0, 40.0, 45.0)[b['phase']]
        b['t'] = 0.0
        self.phase_hit = False
        self.banner = 1.4
        self.bullets = []
        self.lasers = []

    # ---------------- 出手 ----------------
    def _bullet(self, **kw):
        self.bullets.append(Bullet(**kw))

    def _ring(self, x, y, n, sp, type, c, off=0.0):
        for i in range(n):
            self._bullet(x=x, y=y, a=off + i * TAU / n, sp=sp, type=type, c=c)

    def _fan(self, x, y, a, n, spread, sp, type, c):
        for i in range(n):
            k = 0 if n == 1 else (i / (n - 1) - 0.5)
            self._bullet(x=x, y=y, a=a + k * spread * 2, sp=sp, type=type, c=c)

    def _aim(self, e):
        return math.atan2(self.player.y - e['y'], self.player.x - e['x'])

    def _spiral(self, e, arms, rot, sp, type, c):
        for i in range(arms):
            self._bullet(x=e['x'], y=e['y'], a=e['t'] * rot + i * TAU / arms, sp=sp, type=type, c=c)

    def _every(self, e, k, iv, fn):
        e['cd'][k] = e['cd'].get(k, iv * 0.5)
        if e['cd'][k] <= 0:
            e['cd'][k] += iv
            fn()

    # ---------------- 推进 ----------------
    def step(self, dt):
        if self.ended:
            return
        dt = min(1.0 / 30.0, dt)
        self.t += dt
        while self.waves and self.t >= self.waves[0][0]:
            self.waves.pop(0)[1]()
        self._step_player(dt)
        self._step_shots(dt)
        self._step_enemies(dt)
        self._step_boss(dt)
        self._step_bullets(dt)
        self._step_lasers(dt)
        self._step_bomb(dt)
        if self.banner > 0:
            self.banner -= dt

    def _step_player(self, dt):
        P = self.player
        spd = SLOW_SPEED if self.slow else PLAYER_SPEED
        if P.dead > 0:
            P.dead -= dt
            if P.dead <= 0:
                P.dead = 0.0
                P.x, P.y = FIELD_W / 2, FIELD_H - 50
                P.inv = 2.5
            return
        if self.pointer is not None:
            tx, ty = self.pointer
            dx, dy = tx - P.x, ty - P.y
            d = math.hypot(dx, dy)
            if d > 0.5:
                k = min(d, spd * dt)
                P.x += dx / d * k
                P.y += dy / d * k
        P.x = min(FIELD_W - 8, max(8, P.x))
        P.y = min(FIELD_H - 10, max(16, P.y))
        P.inv = max(0.0, P.inv - dt)

        # 自动射击（火属性：5 发扇形）
        P.shot_cd -= dt
        if P.shot_cd <= 0:
            P.shot_cd = 0.07
            for i in range(5):
                k = i / 4 - 0.5
                self.shots.append({'x': P.x + k * 8, 'y': P.y - 12,
                                   'a': -math.pi / 2 + k * 0.5, 'sp': 560, 't': 'rice', 'c': 'orange'})

    def _step_shots(self, dt):
        """自机子弹：打 Boss、打敌机（danmaku.js:180 的方框判定）。"""
        out = []
        b = self.boss
        for s in self.shots:
            s['x'] += math.cos(s['a']) * s['sp'] * dt
            s['y'] += math.sin(s['a']) * s['sp'] * dt
            hit = False
            for e in self.enemies:
                if abs(s['x'] - e['x']) < e['size'] * 0.35 and abs(s['y'] - e['y']) < e['size'] * 0.35:
                    e['hp'] -= 1.0
                    e['flash'] = 0.06
                    hit = True
                    break
            if hit:
                continue
            if b and abs(s['x'] - b['x']) < b['size'] * 0.3 and abs(s['y'] - b['y']) < b['size'] * 0.35:
                b['hp'] -= 1.0
                continue
            if -20 < s['y'] and -20 < s['x'] < FIELD_W + 20:
                out.append(s)
        self.shots = out
        if b:
            self.boss_hp = max(0.0, b['hp'] / b['hp0'])

    def _step_enemies(self, dt):
        for e in self.enemies:
            e['t'] += dt
            e['y'] += 18 * dt
            e['flash'] = max(0.0, e['flash'] - dt)
            for k in list(e['cd']):
                e['cd'][k] -= dt
            if e['cd'].get('a', 9) <= 0:
                e['cd']['a'] = 0.8 if e['kind'] == 'bat' else 0.9
                if e['kind'] == 'bat':
                    self._fan(e['x'], e['y'], self._aim(e), 3, 0.25, 150, 'rice', 'red')
                else:
                    self._ring(e['x'], e['y'], 14, 110, 'orb', 'green')
        for e in self.enemies:
            P = self.player
            if not P.dead and not P.inv and math.hypot(e['x'] - P.x, e['y'] - P.y) < e['size'] * 0.25:
                self._hit()
        # 血条清零的敌机消失（danmaku.js:176-178：死了就不再参与接触判定）
        self.enemies = [e for e in self.enemies if e['hp'] > 0 and e['y'] < FIELD_H + 60]

    def _step_boss(self, dt):
        b = self.boss
        if not b:
            return
        P = self.player
        b['t'] += dt
        b['ptime'] -= dt
        ph = b['phase']
        if ph == 0:
            self._every(b, 'a', 0.9, lambda: (
                self._fan(b['x'], b['y'], self._aim(b), 7, 0.9, 160, 'orb', 'red'),
                self._ring(b['x'], b['y'], 20, 95, 'rice', 'orange', b['t'])))
        elif ph == 1:
            self._every(b, 'a', 0.14, lambda: self._spiral(b, 3, 2.3, 130, 'rice', 'pink'))
            self._every(b, 'b', 1.4, lambda: self._fan(b['x'], b['y'], self._aim(b), 5, 0.35, 200, 'orb', 'red'))
        else:
            self._every(b, 'a', 0.06, lambda: self._spiral(b, 4, 1.7, 120, 'orb', 'purple'))
            self._every(b, 'b', 2.0, lambda: self.lasers.append(
                {'x': 40 + self.rng.randint(5) * 70, 'y': 30, 'a': math.pi / 2, 'len': 520, 'w': 7.0, 't': 0.0}))
        if b['hp'] <= 0 or b['ptime'] <= 0:
            self._next_phase()

    def _step_bullets(self, dt):
        P = self.player
        out = []
        for b in self.bullets:
            b.t += dt
            if b.re and not b.reDone and b.t >= b.re:
                b.reDone = True
                b.a = math.atan2(P.y - b.y, P.x - b.x)
                b.sp, b.acc = b.reSp, 0.0
            b.sp = max(b.min, min(b.max, b.sp + b.acc * dt))
            b.a += b.w * dt
            if b.g:
                vx, vy = math.cos(b.a) * b.sp, math.sin(b.a) * b.sp + b.g * dt
                b.a, b.sp = math.atan2(vy, vx), math.hypot(vx, vy)
            b.x += math.cos(b.a) * b.sp * dt
            b.y += math.sin(b.a) * b.sp * dt
            if b.bounce > 0 and (b.x < 4 or b.x > FIELD_W - 4):
                b.a = math.pi - b.a
                b.x = min(FIELD_W - 4, max(4, b.x))
                b.bounce -= 1
            if b.split and b.t >= b.split['t']:
                b.dead = True
                n = b.split['n']
                for i in range(n):
                    self._bullet(x=b.x, y=b.y, a=i * TAU / n, sp=b.split['sp'],
                                 type=b.split['type'], c=b.split['c'])
            if not P.dead and not self.ended:
                d = math.hypot(b.x - P.x, b.y - P.y)
                if d < b.r + 2.2 and not P.inv:
                    self._hit()
                elif d < b.r + 16:
                    P.graze += 1
                    P.score += 50
            if (not b.dead) and -40 < b.x < FIELD_W + 40 and -60 < b.y < FIELD_H + 40 and b.t < 20:
                out.append(b)
        self.bullets = out

    def _step_lasers(self, dt):
        out = []
        P = self.player
        for L in self.lasers:
            L['t'] += dt
            if L['t'] > 0.1 and not P.dead and not P.inv:
                dx, dy = P.x - L['x'], P.y - L['y']
                along = dx * math.cos(L['a']) + dy * math.sin(L['a'])
                perp = abs(-dx * math.sin(L['a']) + dy * math.cos(L['a']))
                if 0 < along < L['len'] and perp < L['w'] * 0.5:
                    self._hit()
            if L['t'] < 1.2:
                out.append(L)
        self.lasers = out

    def _step_bomb(self, dt):
        if self.bomb_t <= 0:
            return
        self.bomb_t -= dt
        self.bullets = []
        self.lasers = []
        for e in self.enemies:
            e['hp'] -= dt * 60.0          # danmaku.js:200 符卡持续烧敌机
            e['flash'] = 0.05

    def bomb(self):
        P = self.player
        if P.bombs <= 0 or P.dead or self.ended or self.bomb_t > 0:
            return
        P.bombs -= 1
        P.inv = max(P.inv, 3.4)
        self.bomb_t = 3.0
        self.phase_hit = True

    def _hit(self):
        P = self.player
        if P.inv or P.dead or self.bomb_t > 0 or self.ended:
            return
        P.lives -= 1
        P.power = max(1.0, P.power - 0.5)
        self.phase_hit = True
        self.bullets = []
        self.lasers = []
        self.hits += 1
        if P.lives < 0:
            P.lives = 0
            self.ended = 'lose'
            self.deaths += 1
        else:
            P.dead = 0.8
            P.bombs = max(P.bombs, 2)

    # ---------------- 渲染 ----------------
    def _make_bg(self):
        """竹林风的深色背景：故意留一些中亮度的绿色，考验识别阈值。"""
        bg = np.zeros((FIELD_H, FIELD_W, 3), np.uint8)
        bg[:] = (12, 7, 5)                                   # BGR ≈ #05070c
        for i in range(40):
            x = self.rng.randint(-20, FIELD_W + 20)
            w = self.rng.randint(10, 40)
            shade = self.rng.randint(30, 70)
            cv2.ellipse(bg, (x, self.rng.randint(0, FIELD_H)), (w, w * 2),
                        0, 0, 360, (shade // 2, shade, shade // 2), -1)
        return cv2.addWeighted(bg, 1.0, np.zeros_like(bg), 0, -18)

    def render(self):
        s = self.s
        img = np.full((self.sh, self.sw, 3), 26, np.uint8)       # 页面底色
        cv2.rectangle(img, (40, 30), (self.sw - 40, self.sh - 30), (38, 36, 34), -1)

        field = cv2.resize(self.bg, (int(self.fw), int(self.fh)), interpolation=cv2.INTER_LINEAR)
        glow = np.zeros((int(self.fh), int(self.fw), 3), np.float32)
        base = field.astype(np.float32)

        def P(x, y):
            return (int(round(x * s)), int(round(y * s)))

        def dot(x, y, rw, rh, ang, col, core, g=1.0, scale=1.0):
            c = P(x, y)
            axes = (max(1, int(rw * s / 2 * scale)), max(1, int(rh * s / 2 * scale)))
            cv2.ellipse(glow, c, axes, ang, 0, 360, col, -1)
            cv2.ellipse(base, c, axes, ang, 0, 360, col, -1)
            cv2.ellipse(base, c, (max(1, axes[0] * 2 // 3), max(1, axes[1] * 2 // 3)),
                        ang, 0, 360, core, -1)

        # 自机子弹（alpha 0.75）
        for sh in self.shots:
            w, h, _ = SIZE[sh['t']]
            dot(sh['x'], sh['y'], w + 6, h + 6, math.degrees(sh['a']),
                tuple(v * 0.75 for v in PAL[sh['c']][0]), tuple(v * 0.75 for v in PAL[sh['c']][1]))

        # 敌人：照着真实贴图的亮度分布画 —— 暗身体 + 一圈亮边。
        # 实测 en-bat 只有约 20% 像素过宽阈值、几乎没有弹芯，
        # 这样画才能检验「无芯大块 = 敌机」这条识别规则。
        for e in self.enemies:
            c = P(e['x'], e['y'])
            r = int(e['size'] * s * 0.42)
            ry = int(r * 0.8)
            rim = 3 if e['flash'] > 0 else (205, 105, 235)
            cv2.ellipse(base, c, (r, ry), 0, 0, 360, (70, 45, 120), -1)
            cv2.ellipse(base, c, (r, ry), 0, 0, 360, rim, max(2, int(r * 0.22)))
            cv2.ellipse(base, c, (int(r * 0.35), int(r * 0.3)), 0, 0, 360, (80, 50, 130), -1)

        # Boss（大立绘：b 站识别会当成大色块整块抹掉）
        if self.boss:
            c = P(self.boss['x'], self.boss['y'])
            r = int(self.boss['size'] * s * 0.5)
            cv2.ellipse(base, c, (r, r), 0, 0, 360, (150, 60, 200), -1)
            cv2.ellipse(base, c, (int(r * .6), int(r * .6)), 0, 0, 360, (200, 120, 240), -1)

        # 敌弹
        for b in self.bullets:
            w, h, _ = SIZE[b.type]
            ang = 0 if b.type in ('orb', 'big', 'small') else math.degrees(b.a)
            dot(b.x, b.y, w + 6, h + 6, ang, PAL[b.c][0], PAL[b.c][1])

        # 激光
        for L in self.lasers:
            x0, y0 = P(L['x'], L['y'])
            x1 = int(x0 + math.cos(L['a']) * L['len'] * s)
            y1 = int(y0 + math.sin(L['a']) * L['len'] * s)
            cv2.line(base, (x0, y0), (x1, y1), (190, 90, 255), max(2, int(L['w'] * s)))
            cv2.line(base, (x0, y0), (x1, y1), (255, 255, 255), max(1, int(L['w'] * s * 0.35)))

        # 自机（鲸鱼：中等饱和的蓝紫色，正是会干扰识别的那一类）
        pl = self.player
        if pl.dead <= 0 and not (pl.inv > 0 and int(self.t * 20) % 2):
            c = P(pl.x, pl.y - 6)
            cv2.ellipse(base, c, (int(15 * s), int(23 * s)), 0, 0, 360, (158, 96, 105), -1)
            cv2.ellipse(base, c, (int(9 * s), int(15 * s)), 0, 0, 360, (226, 175, 190), -1)

        # 发光合成
        gl = cv2.GaussianBlur(glow, (0, 0), max(1.0, 2.4 * s))
        base = np.clip(base + gl * 0.55, 0, 255).astype(np.uint8)

        # HUD / 血条
        if self.boss:
            cv2.rectangle(base, P(8, 6), P(376, 12), (30, 30, 30), -1)
            cv2.rectangle(base, P(8, 6), P(8 + 368 * self.boss_hp, 12),
                          (128, 80, 255) if self.boss['phase'] else (96, 208, 255), -1)
            hy = 66
        else:
            hy = 16
        txt = '命 %s  符 %s' % ('v' * pl.lives, 'o' * pl.bombs)
        cv2.putText(base, txt, P(8, hy), cv2.FONT_HERSHEY_SIMPLEX, 0.42 * s, (240, 240, 240), 1)
        cv2.putText(base, 'x %.2f  n %d  s %d' % (pl.power, pl.graze, pl.score),
                    P(8, hy + 15), cv2.FONT_HERSHEY_SIMPLEX, 0.42 * s, (240, 240, 240), 1)

        if self.banner > 0:
            cv2.rectangle(base, P(0, 215), P(FIELD_W, 255), (80, 30, 160), -1)
            cv2.putText(base, 'SPELL CARD', P(110, 244), cv2.FONT_HERSHEY_SIMPLEX,
                        0.9 * s, (255, 255, 255), 2)

        fimg = base
        if self.ended == 'lose':
            fimg = (fimg * 0.3).astype(np.uint8)
            cv2.putText(fimg, 'LOSE', P(120, 260), cv2.FONT_HERSHEY_SIMPLEX, 1.6 * s, (255, 255, 255), 3)
        elif self.ended == 'win':
            fimg = (fimg * 0.3).astype(np.uint8)
            cv2.putText(fimg, 'WIN', P(140, 260), cv2.FONT_HERSHEY_SIMPLEX, 1.6 * s, (255, 255, 255), 3)

        img[self.fy:self.fy + self.fh, self.fx:self.fx + self.fw] = fimg
        # 场地边框（#b77732，和游戏一模一样）
        cv2.rectangle(img, (self.fx, self.fy), (self.fx + self.fw, self.fy + self.fh), (50, 119, 183), 2)
        return img


# ---------------- 给 Engine 用的适配器 ----------------

class SimScreen:
    def __init__(self, game):
        self.game = game
        self.frame = game.render()
        self.grabs = 0

    def bounds(self):
        return (0, 0, self.game.sw, self.game.sh)

    def monitors(self):
        return [{'left': 0, 'top': 0, 'width': self.game.sw, 'height': self.game.sh}]

    def grab(self, rect=None):
        self.game.step(1.0 / 30.0)
        self.game.clock += 1.0 / 30.0
        self.frame = self.game.render()
        self.grabs += 1
        if rect is None:
            return self.frame.copy()
        x, y, w, h = [int(round(v)) for v in rect]
        x = max(0, min(self.game.sw - 2, x))
        y = max(0, min(self.game.sh - 2, y))
        w = max(2, min(self.game.sw - x, w))
        h = max(2, min(self.game.sh - y, h))
        return self.frame[y:y + h, x:x + w].copy()

    def close(self):
        pass


class SimMouse:
    def __init__(self, game):
        self.game = game
        self.dry = False
        self.moves = 0
        self.clicks = 0
        self.pos = (-1, -1)

    def move(self, x, y):
        self.moves += 1
        self.pos = (x, y)
        g = self.game
        fx = (x - g.fx) / g.s
        fy = (y - g.fy) / g.s
        g.pointer = (min(FIELD_W - 8, max(8, fx)), min(FIELD_H - 10, max(16, fy)))
        return True

    def right_click(self):
        self.clicks += 1
        self.game.bomb()

    def key(self, vk):
        self.game.bomb()
