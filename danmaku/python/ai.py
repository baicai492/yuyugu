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


def clamp_player(x, y):
    return (min(PX_MAX_X, max(PX_MIN_X, x)), min(PX_MAX_Y, max(PX_MIN_Y, y)))


class Track:
    __slots__ = ('x', 'y', 'vx', 'vy', 'r', 'age', 'miss', 'own', 'sx', 'sy')

    def __init__(self, x, y, r, own=False, sx=None, sy=None):
        self.x, self.y, self.vx, self.vy = x, y, 0.0, 0.0
        self.r = r
        self.age = 0
        self.miss = 0
        self.own = own
        self.sx, self.sy = (x if sx is None else sx), (y if sy is None else sy)


class Tracker:
    def __init__(self, gate=26.0):
        self.gate = gate
        self.tracks = []
        self.own_count = 0

    def reset(self):
        self.tracks = []

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
                matched[i] = True
                used[j] = True
                t = tr[i]
                nx, ny = float(dets[j, 0]), float(dets[j, 1])
                vx = (nx - t.x) / dt
                vy = (ny - t.y) / dt
                # 平滑：新速度给多一点，但保留历史，免得单帧抖动带偏预判
                t.vx = 0.6 * vx + 0.4 * t.vx
                t.vy = 0.6 * vy + 0.4 * t.vy
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

        # 新出现的
        for j in range(len(dets)):
            if used[j]:
                continue
            x, y = float(dets[j, 0]), float(dets[j, 1])
            self.tracks.append(Track(x, y, float(dets[j, 2])))

        # 自机子弹标记：从自机附近冒出来、而且向上飞
        own = 0
        for t in self.tracks:
            if t.own:
                own += 1
                continue
            if t.age >= 1 and player is not None:
                near = (t.sx - player[0]) ** 2 + (t.sy - player[1]) ** 2 < 140.0 ** 2
                if near and t.vy < -80:
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
        rad = np.maximum(4.0, arr[:, 4] * 0.75 + self.margin)

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
