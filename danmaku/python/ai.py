"""多帧跟踪与走位决策。

跟踪
----
每帧拿到的只是一堆「亮点」，要变成「子弹 → 速度」才能预判。用最近邻贪心
关联：预测位置与检测位置的距离在门限内就认为是同一颗。穿过自机挖空区域的
子弹会暂时「消失」，此时不删轨迹，靠速度外推继续走（否则最危险的那几百
毫秒正好瞎了）。

走位
----
自机是「朝鼠标指针匀速飞」的（danmaku.js:164 每帧最多走 spd*dt）。所以
控制量就是指针位置：把指针放到哪，自机就沿直线飞过去。决策时枚举一圈候选
落点，在每个候选上沿飞行路径模拟 0.45 秒，取「全程离所有子弹最近距离」
最大的那个。都不安全就叫符卡（符卡会把全屏子弹清掉）。
"""
import numpy as np

from vision import FIELD_W, FIELD_H

PLAYER_SPEED = 300.0      # danmaku.js:161 常速 300 逻辑像素/秒
SLOW_SPEED = 130.0        # 按住左键 130，本程序不用（慢速反而更难躲）
PX_MIN_X, PX_MAX_X = 8.0, FIELD_W - 8.0
PX_MIN_Y, PX_MAX_Y = 16.0, FIELD_H - 10.0

# 背景噪声过滤：真弹最慢也有 60 逻辑像素/秒（danmaku.js 里 sp 最小 40 且很快
# 加速），背景美术的视差滚动只有 14~30。所以「从出生起就没快过」的轨迹是背景。
# 注意判据是**历史的快帧数**而不是当前速度：剑符的木/金弹会悬停 0.7~1 秒
# （danmaku.js:192 stickY），它们停住之前飞得很快，计过数；而背景亮点永远慢。
# 只按当前速度过滤会把悬停弹一起删掉，那就是送死。
# 只看「最大速度」也不行：背景点有一帧抖动被算成 90 px/s，它就永远洗不白了。
STATIC_SPD = 60.0             # 逻辑像素/秒
STATIC_AGE = 8                # 至少跟踪这么多帧（≈0.3 秒）才下结论
STATIC_HITS = 3               # 其中至少这么多帧快于此速度
BG_R = 7.0                    # 判成背景的点：新检出离它这么近就直接忽略
BG_TTL = 90                   # 背景点没有新检出后还记这么多帧（≈3 秒）


def clamp_player(x, y):
    return (min(PX_MAX_X, max(PX_MIN_X, x)), min(PX_MAX_Y, max(PX_MIN_Y, y)))


class Track:
    __slots__ = ('x', 'y', 'vx', 'vy', 'r', 'age', 'miss', 'own', 'sx', 'sy', 'fast')

    def __init__(self, x, y, r, own=False, sx=None, sy=None):
        self.x, self.y, self.vx, self.vy = x, y, 0.0, 0.0
        self.r = r
        self.age = 0
        self.miss = 0
        self.own = own
        self.fast = 0
        self.sx, self.sy = (x if sx is None else sx), (y if sy is None else sy)


class Tracker:
    def __init__(self, gate=26.0):
        self.gate = gate
        self.tracks = []
        self.bg = []          # [x, y, ttl]：被判成背景亮点的位置
        self.c_bg_skip = 0    # 诊断：被背景黑名单拦下的新检出数
        self.c_bg_drop = 0    # 诊断：被判成背景删掉的轨迹数
        self.own_count = 0

    def reset(self):
        self.tracks = []
        self.bg = []
        self.c_bg_skip = 0
        self.c_bg_drop = 0

    def _is_bg(self, x, y):
        """这个位置是不是背景亮点。是的话顺手更新它的位置（背景会缓慢视差）。"""
        best = None
        best_d = BG_R * BG_R
        for e in self.bg:
            d = (e[0] - x) ** 2 + (e[1] - y) ** 2
            if d <= best_d:
                best, best_d = e, d
        if best is None:
            return False
        best[0], best[1], best[2] = x, y, BG_TTL
        return True

    def _age_bg(self):
        if self.bg:
            for e in self.bg:
                e[2] -= 1
            self.bg = [e for e in self.bg if e[2] > 0]

    def update(self, dets, dt, player=None):
        """dets: (n,3) [x,y,r]；返回 (danger 数组 (m,5), 全部轨迹数, 自身弹数)。"""
        tr = self.tracks
        dets = np.asarray(dets, np.float32) if len(dets) else np.zeros((0, 3), np.float32)
        dt = max(1e-3, float(dt))
        gate = max(self.gate, 900.0 * dt)   # 自机弹最高 820 px/s

        matched = np.zeros(len(tr), bool)
        used = np.zeros(len(dets), bool)

        if tr and len(dets):
            pred = np.array([[t.x + t.vx * dt, t.y + t.vy * dt] for t in tr], np.float32)
            d = np.linalg.norm(pred[:, None, :] - dets[None, :, :2], axis=2)
            # 贪心：全局最近的先配。子弹数量 < 400，一次 argsort 足够快。
            order = np.argsort(d, axis=None)
            for k in order:
                i, j = int(k // d.shape[1]), int(k % d.shape[1])
                if d[i, j] > gate:
                    break
                if matched[i] or used[j]:
                    continue
                t = tr[i]
                nx, ny = float(dets[j, 0]), float(dets[j, 1])
                vx = (nx - t.x) / dt
                vy = (ny - t.y) / dt
                # 运动学门限：单帧速度不该突变。没有这一条，自机子弹（向上
                # 560 px/s）会抢走旁边敌弹的检测，两条轨迹的速度一起变成瞎猜，
                # 预判就指到错误的方向上——实测一次受击就是这么来的。
                if t.age >= 2:
                    dv = ((vx - t.vx) ** 2 + (vy - t.vy) ** 2) ** 0.5
                    if dv > max(300.0, 5.0 * (t.vx * t.vx + t.vy * t.vy) ** 0.5):
                        continue
                matched[i] = True
                used[j] = True
                # 平滑：新速度给多一点，但保留历史，免得单帧抖动带偏预判
                t.vx = 0.6 * vx + 0.4 * t.vx
                t.vy = 0.6 * vy + 0.4 * t.vy
                if (vx * vx + vy * vy) ** 0.5 > STATIC_SPD:
                    t.fast += 1
                t.x, t.y = nx, ny
                t.r = 0.7 * t.r + 0.3 * float(dets[j, 2])
                t.age += 1
                t.miss = 0

        # 没配上的：外推一帧继续走，连续丢太多才删
        keep = []
        for i, t in enumerate(tr):
            if matched[i]:
                keep.append(t)
                continue
            t.x += t.vx * dt
            t.y += t.vy * dt
            t.age += 1
            t.miss += 1
            # 自机挖空区里的子弹本来就看不到，允许多丢几帧
            near_player = player is not None and \
                (t.x - player[0]) ** 2 + (t.y - player[1]) ** 2 < 80.0 ** 2
            if t.miss <= (14 if near_player else 3) and -60 < t.x < FIELD_W + 60 and -80 < t.y < FIELD_H + 60:
                keep.append(t)
        self.tracks = keep

        # 新出现的（先问一下背景黑名单：被判成背景的位置每帧都会再被检出，
        # 如果不管它，刚刚删掉的轨迹下一帧就原样长回来）
        for j in range(len(dets)):
            if used[j]:
                continue
            x, y = float(dets[j, 0]), float(dets[j, 1])
            if self._is_bg(x, y):
                self.c_bg_skip += 1
                continue
            self.tracks.append(Track(x, y, float(dets[j, 2])))

        # 背景美术的亮点（樱花、灯笼、瀑布水花…）每帧都在同一个位置被检出，
        # 追踪几帧后速度接近 0。它们不是威胁，却会把走位的余量图搅乱——
        # 实测误检多于真弹 4 倍时自机会被「不存在的墙」逼着撞上真弹。
        dead = [t for t in self.tracks
                if t.age >= STATIC_AGE and t.fast < STATIC_HITS]
        if dead:
            self.tracks = [t for t in self.tracks
                           if not (t.age >= STATIC_AGE and t.fast < STATIC_HITS)]
            for t in dead:
                self.bg.append([t.x, t.y, BG_TTL])
            self.c_bg_drop += len(dead)
        self._age_bg()

        # 自机子弹标记。判据必须严 —— 标错了就等于把一颗敌弹从危险集合里
        # 永久删掉（曾经有一条绿色的环弹因为一帧速度抖动被标成「自己」，
        #   然后从正上方落下来把自机打死了）。
        #
        # 主判据是方向：自机弹 380~820 px/s 向上，敌弹最快 240（回旋弹重新
        # 发射 300~320，且都是朝下方的自机飞）。所以「向上快过 350」的必是自己人。
        #
        # 以前只按「出生时离自机近」认，在 15 fps 下这条几乎全失效：一条轨迹
        # 断掉重建时弹已经飞出一百多像素，永远认不回来。实测 60~90 颗自机弹
        # 全被当成敌弹，走位被自己的弹幕逼得到处乱撞。
        own = 0
        for t in self.tracks:
            if t.own:
                own += 1
                continue
            if t.age >= 1 and t.vy < -350.0:
                t.own = True
                own += 1
                continue
            if t.age <= 8 and t.age >= 1 and player is not None:
                dx, dy = t.sx - player[0], t.sy - player[1]
                if abs(dx) < 46 and -70 < dy < 16 and t.vy < -300:
                    t.own = True
                    own += 1
        self.own_count = own

        n = len(self.tracks)
        if n == 0:
            return np.zeros((0, 5), np.float32), 0, 0
        arr = np.empty((n, 5), np.float32)
        k = 0
        for t in self.tracks:
            if t.own:
                continue
            arr[k] = (t.x, t.y, t.vx, t.vy, t.r)
            k += 1
        return arr[:k], len(self.tracks), own


class Dodger:
    """枚举候选落点，挑「未来 0.45 秒里离所有子弹最远」的那个。"""

    def __init__(self, speed=PLAYER_SPEED, horizon=0.45, step=1 / 30,
                 angles=24, radii=(18.0, 36.0, 56.0), margin=2.5):
        self.speed = speed
        self.horizon = horizon
        self.step = step
        self.angles = angles
        self.radii = radii
        self.margin = margin
        self.bomb_clearance = 3.0     # 最好的一条路也只剩这么点余量，就叫符卡
        self.last_dir = np.array([0.0, -1.0], np.float32)

    def _candidates(self, p):
        ang = np.arange(self.angles) * (2 * np.pi / self.angles)
        d = np.stack([np.cos(ang), np.sin(ang)], axis=1).astype(np.float32)
        cs = [p[None, :]]
        for r in self.radii:
            cs.append(p[None, :] + d * r)
        C = np.concatenate(cs, axis=0)
        C[:, 0] = np.clip(C[:, 0], PX_MIN_X + 2, PX_MAX_X - 2)
        C[:, 1] = np.clip(C[:, 1], PX_MIN_Y + 2, PX_MAX_Y - 2)
        # 去掉重复点（贴边裁剪后会出现）
        _, first = np.unique(np.round(C, 1), axis=0, return_index=True)
        return C[np.sort(first)]

    def decide(self, p, arr):
        """返回 (目标点 (x,y), 信息 dict)。"""
        p = np.asarray(p, np.float32)
        C = self._candidates(p)
        if len(arr) == 0:
            # 没危险：站位回到中下部，别贴边也别顶到天花板
            return self.idle_target(p), {'clearance': 999.0, 'bomb': False, 'cands': len(C)}

        pos = arr[:, 0:2]
        vel = arr[:, 2:4]
        # 识别出来的 r 是「弹芯半径」，比游戏真正用来判定的 r 略小：
        # 稻弹判定 3（SIZE 表）而芯的峰值只有 2.5~3，大玉判定 11 而芯 8~10。
        # 老算法 arr.r*0.75+2.5 在 r=3 时只有 4.75，比判定半径 5.2 还小，
        # 等于贴着判定圈走。改成「芯半径 + 固定余量」，保证比判定圈多出 1~2 像素。
        rad = np.maximum(5.0, arr[:, 4] + self.margin + 1.0)

        ts = np.arange(0.0, self.horizon + 1e-6, self.step).astype(np.float32)
        K = len(ts)
        bp = pos[None, :, :] + vel[None, :, :] * ts[:, None, None]     # (K,N,2)

        vec = C - p[None, :]                                           # (M,2)
        dist = np.linalg.norm(vec, axis=1)                             # (M,)
        unit = vec / np.maximum(dist, 1e-3)[:, None]
        move = np.minimum(self.speed * ts[:, None], dist[None, :])     # (K,M)

        # 每个候选沿飞行路径的最小余量（不是逐帧最大值的最大——那样会把
        # 「目的地安全但路上撞弹」的选择留下来）
        clr = np.full(len(C), 1e9, np.float32)
        for k in range(K):
            pp = p[None, :] + unit * move[k][:, None]                  # (M,2)
            dd = np.linalg.norm(pp[:, None, :] - bp[k][None, :, :], axis=2)   # (M,N)
            clr = np.minimum(clr, (dd - rad[None, :]).min(axis=1))
        score = clr + self._bias(C)
        best_i = int(np.argmax(score))

        target = C[best_i]
        step_vec = target - p
        n = np.linalg.norm(step_vec)
        if n > 1e-3:
            self.last_dir = step_vec / n
        info = {
            'clearance': round(float(clr[best_i]), 2),
            'bomb': bool(clr[best_i] < self.bomb_clearance),
            'cands': len(C),
        }
        return (float(target[0]), float(target[1])), info

    def _bias(self, C):
        """给候选点加分/扣分：贴边扣、偏离中轴扣、顶到上半场扣。"""
        b = np.zeros(len(C), np.float32)
        edge = np.minimum(np.minimum(C[:, 0] - PX_MIN_X, PX_MAX_X - C[:, 0]),
                          np.minimum(C[:, 1] - PX_MIN_Y, PX_MAX_Y - C[:, 1]))
        b -= np.maximum(0, 18.0 - edge) * 0.9
        b -= np.abs(C[:, 0] - FIELD_W / 2) * 0.006
        b -= np.maximum(0, 230.0 - C[:, 1]) * 0.05
        return b

    def idle_target(self, p):
        """没有威胁时的站位：中下部（离 Boss 远、离底边有缓冲）。"""
        return (FIELD_W / 2 + (p[0] - FIELD_W / 2) * 0.6, FIELD_H - 90.0)
