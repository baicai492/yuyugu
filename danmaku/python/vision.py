"""屏幕识别：在屏幕上找到斗法场地，并从中提取自机、敌弹、激光和 Boss 血条。

全部基于像素，不读页面 DOM／不改游戏状态。

坐标约定
--------
* **逻辑坐标**：游戏内部固定 384x512（new4/xs/danmaku.js:5 `const W=384,H=512`）。
* **屏幕坐标**：画布把逻辑场地等比缩放后居中，四周留黑边，最后沿场地边界
  画一圈 #b77732 的棕框（danmaku.js:273）。找到那圈棕框 = 拿到了
  屏幕像素 ↔ 逻辑坐标的完整映射。
* **识别坐标**：把场地裁出来放大到 768x1024（2 倍），小弹也能分成独立连通域。

自机为什么必须挖掉
------------------
自机是 whale-farm 雪碧图，实测颜色 BGR≈(158,96,105)、V 高值能到 226、
S 到 175，和敌弹的阈值区间完全重叠。不挖掉的话机器人会躲自己。
挖掉后靠「轨迹外推」继续跟踪穿过自机区域的子弹（见 track.py）。
"""
import cv2
import numpy as np

FIELD_W, FIELD_H = 384, 512
CAL = 2                       # 识别分辨率倍数
BORDER_BGR = (50, 119, 183)   # #b77732 场地边框

# HUD 在左上角（danmaku.js:266-267），最上面 30 逻辑像素里没有可躲的东西：
# 血条 8..12、名字 y=24，再往下才是场地。整条挖掉，省得把血条当子弹。
HUD_H = 30

# 敌弹阈值。背景美术带两层压暗叠加（0.25 黑 + 0.28 深蓝），再亮的竹林
# 也到不了 V=168 且 S=135；纯白弹（PAL.white #e0e0e0 白核）S 很低，走第二条。
SAT_V, SAT_S = 168, 135
WHITE_V, WHITE_S = 200, 52
# 弹芯阈值：只留最亮的一层。子弹外面有一圈 shadowBlur 光晕，宽阈值会把
# 相邻的子弹糊成一坨；用弹芯定中心和半径，两颗弹就算贴在一起也分得开。
CORE_V, CORE_S, CORE_W = 208, 168, 244
PEAK_MIN = 2.0        # 距离变换的峰值下限（识别坐标像素）

# 连通域过滤（单位都是识别坐标 CAL 倍）
MIN_AREA = 8          # 2x2 以下当噪点
MAX_SIDE = 150        # 单边超过 75 逻辑像素的必不是子弹（大字/横幅）
MIN_FILL = 0.30       # 弹体填充率，刀/菱形约 0.5，圆约 0.78
BIG_SIDE = 180        # 再大就是横幅/对话气泡/Boss 立绘
BIG_H = 150           # 高度阈值放到 75 逻辑像素，让 size 70~84 的敌机不被当成大块
BIG_FILL = 0.12       # 大块必须「实心」；沿边散落的杂点组成的漫天大块不算


class Field:
    """场地在屏幕上的位置，负责两套坐标互转。"""

    __slots__ = ('x', 'y', 'w', 'h', 'sx', 'sy')

    def __init__(self, x, y, w, h):
        self.x, self.y, self.w, self.h = float(x), float(y), float(w), float(h)
        self.sx = w / FIELD_W
        self.sy = h / FIELD_H

    @property
    def scale(self):
        return (self.sx + self.sy) / 2

    def to_screen(self, fx, fy):
        return (self.x + fx * self.sx, self.y + fy * self.sy)

    def to_field(self, px, py):
        return ((px - self.x) / self.sx, (py - self.y) / self.sy)

    def rect(self, pad=0):
        return (int(self.x) - pad, int(self.y) - pad,
                int(self.w) + pad * 2, int(self.h) + pad * 2)

    def camera(self):
        """场地中心的屏幕坐标（视线中心，用来判断窗口有没有被遮挡）。"""
        return (self.x + self.w / 2, self.y + self.h / 2)

    def as_dict(self):
        return {'x': round(self.x, 1), 'y': round(self.y, 1),
                'w': round(self.w, 1), 'h': round(self.h, 1),
                'scale': round(self.scale, 3)}

    def ok(self):
        return self.w >= 120 and self.h >= 160


def _border_mask(img):
    """把棕边框单独抠出来（允许抗锯齿造成的色偏）。

    「每通道差 <= 56」正好就是 inRange 的包络，而且比 numpy 的
    int16 差值和快一个数量级（整屏 10ms → 0.7ms）。
    """
    lo = np.array([max(0, c - 56) for c in BORDER_BGR], np.uint8)
    hi = np.array([min(255, c + 56) for c in BORDER_BGR], np.uint8)
    return cv2.inRange(img, lo, hi)


def locate_field(screen_bgr, hint=None):
    """在整屏（或 hint 附近）里找场地边框。

    hint 是内容脚本量出来的 {x,y,w,h}，只作加速用；找不到也不影响。
    返回 Field 或 None。
    """
    ox = oy = 0
    img = screen_bgr
    if hint:
        try:
            hx, hy, hw, hh = (int(hint['x']), int(hint['y']), int(hint['w']), int(hint['h']))
            pad = 24
            x0 = max(0, hx - pad); y0 = max(0, hy - pad)
            x1 = min(img.shape[1], hx + hw + pad); y1 = min(img.shape[0], hy + hh + pad)
            if x1 - x0 > 200 and y1 - y0 > 200:
                img = img[y0:y1, x0:x1]
                ox, oy = x0, y0
        except (KeyError, TypeError, ValueError):
            img = screen_bgr
            ox = oy = 0

    mask = _border_mask(img)
    # 边框只有 2 逻辑像素粗，缩放后可能刚好断开；横向闭运算把缺口补上
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    want = FIELD_W / FIELD_H
    best, best_score = None, 0.0
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if w < 120 or h < 160:
            continue
        ratio = w / h
        if abs(ratio - want) > 0.18:
            continue
        score = float(w * h) / (1.0 + 6.0 * abs(ratio - want))
        if score > best_score:
            best_score, best = score, (x + ox, y + oy, w, h)
    if best is None:
        return None
    f = Field(*best)
    return f if f.ok() else None


def locate_field_full(screen_bgr, hint=None):
    """先按 hint 找，找不到再扫全屏。"""
    f = locate_field(screen_bgr, hint)
    if f is None and hint is not None:
        f = locate_field(screen_bgr, None)
    return f


def crop_field(screen_bgr, field, cal=CAL):
    """把场地裁出来并放大到 cal 倍，返回 BGR 图（失败返回 None）。"""
    x0, y0 = field.to_screen(0, 0)
    x1, y1 = field.to_screen(FIELD_W, FIELD_H)
    x0 = max(0, int(round(x0))); y0 = max(0, int(round(y0)))
    x1 = min(screen_bgr.shape[1], int(round(x1)))
    y1 = min(screen_bgr.shape[0], int(round(y1)))
    if x1 - x0 < FIELD_W * 0.5 or y1 - y0 < FIELD_H * 0.5:
        return None
    # 场地有一截在屏幕外：裁剪出来的比例就不对了，硬缩放会把弹位算歪，
    # 宁可当这一帧没看见（引擎会先沿用旧矩形、再整屏重找）。
    if abs((x1 - x0) - field.w) > 6 or abs((y1 - y0) - field.h) > 6:
        return None
    sub = screen_bgr[y0:y1, x0:x1]
    if sub.size == 0:
        return None
    return cv2.resize(sub, (FIELD_W * cal, FIELD_H * cal), interpolation=cv2.INTER_AREA)


def _player_mask_rect(player):
    """自机雪碧图实际占的范围（逻辑坐标）：约 30 宽 46 高，中心在 (x, y-6)。"""
    if player is None:
        return None
    px, py = player
    return (px - 21, py - 33, px + 21, py + 21)


def detect_objects(field_img, player=None, cal=CAL):
    """识别一帧里的敌弹、激光和敌机。

    返回 (bullets, lasers, hazards)
      bullets: np.float32 (n,3)  [x, y, r]  逻辑坐标
      lasers:  list of dict      {x,y,dx,dy,len,w}  逻辑坐标
      hazards: np.float32 (m,3)  [x, y, r]  敌机外接圆，逻辑坐标
    """
    hsv = cv2.cvtColor(field_img, cv2.COLOR_BGR2HSV)

    # 宽阈值抓整颗弹（含光晕），用来找激光条和大色块；
    # 严阈值只留弹芯，用来定中心/半径。用 inRange 而不是 numpy 布尔运算：
    # 768x1024 上快一个数量级（8ms → 0.8ms）。
    wide = cv2.bitwise_or(
        cv2.inRange(hsv, (0, SAT_S, SAT_V), (180, 255, 255)),
        cv2.inRange(hsv, (0, 0, WHITE_V), (180, WHITE_S, 255)))
    core = cv2.bitwise_or(
        cv2.inRange(hsv, (0, CORE_S, CORE_V), (180, 255, 255)),
        cv2.inRange(hsv, (0, 0, CORE_W), (180, 45, 255)))

    edge = max(2, int(round(3 * cal)))
    pr = _player_mask_rect(player)
    for m in (wide, core):
        m[:HUD_H * cal, :] = 0              # 顶部 HUD
        m[:edge, :] = 0                     # 场地棕边框（它本身也过阈值）
        m[-edge:, :] = 0
        m[:, :edge] = 0
        m[:, -edge:] = 0
        if pr is not None:                  # 自机本身是亮蓝色的，必须挖掉
            x0, y0, x1, y1 = [int(round(q * cal)) for q in pr]
            m[max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = 0

    n, lab, stats, cent = cv2.connectedComponentsWithStats(wide, 8, cv2.CV_32S)
    if n <= 1:
        return np.zeros((0, 3), np.float32), [], np.zeros((0, 3), np.float32)

    w = stats[:, 2].astype(np.float32)
    h = stats[:, 3].astype(np.float32)
    a = stats[:, 4].astype(np.float32)
    long_side = np.maximum(w, h)
    short_side = np.minimum(w, h)

    # ① 激光：细长条。先挑出来，否则会被当成「大色块」整条抹掉。
    laser_idx = np.nonzero((long_side >= 110) & (short_side <= 26) & (long_side >= short_side * 6))[0]
    lasers = []
    for i in laser_idx:
        x, y, bw, bh, area = stats[i]
        if area < 60:
            continue
        pts = cv2.findNonZero((lab[y:y + bh, x:x + bw] == i).astype(np.uint8))
        if pts is None or len(pts) < 10:
            continue
        (cx, cy), (rw, rh), ang = cv2.minAreaRect(pts.astype(np.float32) + np.float32([x, y]))
        if rw < rh:
            rw, rh = rh, rw
            ang += 90
        lasers.append({'x': cx / cal, 'y': cy / cal,
                       'dx': np.cos(np.radians(ang)), 'dy': np.sin(np.radians(ang)),
                       'len': rw / cal, 'w': rh / cal})

    # ② 大色块（符卡横幅、对话气泡、Boss 立绘）：整块抹掉，
    #    否则里面白色的字会被当成一堆子弹。必须「实心」——沿场边散落的
    #    杂点可能连成一块覆盖全屏的形状，那种块要是参与抹除，整帧的弹芯
    #    就全没了（曾经真的因此一帧都识别不到弹）。
    is_laser = np.zeros(n, bool)
    is_laser[laser_idx] = True
    big = np.nonzero(((w >= BIG_SIDE) | (h >= BIG_H)) & ~is_laser & (a >= 300) &
                     (a >= BIG_FILL * w * h) & (np.arange(n) != 0))[0]
    for i in big:
        x, y, bw, bh, _area = stats[i]
        sub_lab = lab[y:y + bh, x:x + bw]
        sub_core = core[y:y + bh, x:x + bw]
        sub_core[sub_lab == i] = 0           # 只抹这块自己的像素，不碰别人的

    # ③ 敌机：精灵的亮部被打散成几块（实测 en-bat 只有 20% 像素过宽阈），
    #    单块看和弹群没区别，但整只敌机几乎**没有弹芯**（芯比 < 0.1，
    #    而弹群是 0.8+）。按 24 像素邻域把「大块无芯」的碎片并起来，
    #    就是一只敌机的外框。敌机撞人按 size*0.25 判（danmaku.js:177）。
    core_cnt = np.bincount(lab[core > 0].ravel(), minlength=n).astype(np.float32)
    frac = core_cnt / np.maximum(1.0, a)
    plain = ((a >= 55) & (frac < 0.10) & (w >= 5) & (h >= 5) &
             ~is_laser & (np.arange(n) != 0))
    plain[big] = False
    hazards = []
    if plain.any():
        m = np.isin(lab, np.nonzero(plain)[0]).astype(np.uint8)
        k = 25                                  # 合并半径（识别坐标像素）
        m = cv2.dilate(m, np.ones((k, k), np.uint8))
        hn, _hl, hst, _hc = cv2.connectedComponentsWithStats(m, 8, cv2.CV_32S)
        px, py = (player if player is not None else (-999, -999))
        for i in range(1, hn):
            x, y, bw, bh, _area = hst[i]
            sw = (bw - k) / cal                 # 去掉膨胀带来的边
            sh = (bh - k) / cal
            if sw < 12 or sh < 12 or sw > 120 or sh > 120:
                continue
            cx = (x + bw / 2) / cal
            cy = (y + bh / 2) / cal
            if (cx - px) ** 2 + (cy - py) ** 2 < 26.0 ** 2:
                continue                        # 自机雪碧图没挖干净的边角
            hazards.append((cx, cy, max(9.0, min(26.0, 0.28 * max(sw, sh)))))
    hazards = (np.array(hazards, np.float32) if hazards
               else np.zeros((0, 3), np.float32))

    # ④ 弹芯距离变换找峰值：一颗弹一个峰，贴在一起也分得开
    cm = core.astype(np.uint8)
    dist = cv2.distanceTransform(cm, cv2.DIST_L2, 5)
    if dist.size == 0 or float(dist.max()) < PEAK_MIN:
        return np.zeros((0, 3), np.float32), lasers, hazards
    peaks = (dist >= cv2.dilate(dist, np.ones((5, 5), np.uint8)) - 1e-4) & (dist >= PEAK_MIN)
    npk, _plab, pst, pcent = cv2.connectedComponentsWithStats(peaks.astype(np.uint8), 8, cv2.CV_32S)
    out = np.empty((max(0, npk - 1), 3), np.float32)
    k = 0
    for i in range(1, npk):
        cx, cy = pcent[i]
        x, y, bw, bh, _area = pst[i]
        r = float(dist[y:y + bh, x:x + bw].max()) / cal
        if r < 1.6 or r > 34:
            continue
        out[k] = (cx / cal, cy / cal, max(2.5, r))
        k += 1
    return out[:k], lasers, hazards


def laser_points(lasers, margin=3.0, step=24.0):
    """把激光条拆成一串「静止子弹」，直接并进危险集合里。

    局内激光是 700 长的矩形，真正的威胁是它压到自机的那一刻；
    用采样点复用了同一套避弹算法，省得为线段单独写一遍几何。
    """
    pts = []
    for L in lasers:
        r = max(3.0, L['w'] * 0.5 + margin)
        n = int(max(1, min(60, L['len'] / step)))
        for k in range(n + 1):
            t = (k / n) * L['len']
            x = L['x'] + L['dx'] * t
            y = L['y'] + L['dy'] * t
            if -20 <= x <= FIELD_W + 20 and -20 <= y <= FIELD_H + 20:
                pts.append((x, y, 0.0, 0.0, r))
    if not pts:
        return np.zeros((0, 5), np.float32)
    return np.array(pts, np.float32)


def read_boss_hp(field_img, cal=CAL):
    """读 Boss 血条。返回 (有 Boss, 血量比例 0~1)。

    血条画在 (8,6)-(376,12)（danmaku.js:260），有符卡名时粉红 #ff5080，
    普通阶段金黄 #ffd060。没有血条就是没 Boss（或刚清零）。
    """
    y0 = int(8 * cal)
    y1 = int(12 * cal)
    x0 = int(9 * cal)
    x1 = int(375 * cal)
    if y1 <= y0 or x1 <= x0:
        return False, 0.0
    band = field_img[y0:y1, x0:x1]
    if band.size == 0:
        return False, 0.0
    b = band[:, :, 0].astype(np.int16)
    g = band[:, :, 1].astype(np.int16)
    r = band[:, :, 2].astype(np.int16)
    pink = (r > 200) & (g > 45) & (g < 130) & (b > 90) & (b < 190)
    gold = (r > 200) & (g > 160) & (g < 240) & (b > 50) & (b < 150)
    col = (pink | gold).any(axis=0)
    if not col.any():
        return False, 0.0
    last = int(np.nonzero(col)[0].max())
    return True, min(1.0, (last + 1) / col.shape[0])


def frame_is_dark(field_img):
    """整场平均亮度。结束画面会压一层 0.7 的黑幕，用它辅助判断打完了。"""
    small = cv2.resize(field_img, (96, 128), interpolation=cv2.INTER_AREA)
    return float(small.mean())
