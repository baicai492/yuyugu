"""Windows 侧的输入输出：抓屏（mss）和鼠标控制（SetCursorPos + SendInput）。

鼠标走的是操作系统层的真鼠标：SetCursorPos 改变光标位置，Chrome 收到
WM_MOUSEMOVE 后触发 pointermove，游戏里自机就朝指针飞。不是往页面里注入
事件，也不碰游戏状态。

DPI 必须显式声明：否则 mss 抓到的是物理像素，SetCursorPos 用的却是系统
缩放后的逻辑像素，125% 缩放下鼠标会整体偏 20%，机器人直接对着空气操作。
"""
import ctypes
from ctypes import wintypes

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)     # PER_MONITOR_AWARE
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

import mss          # noqa: E402  （必须在设置 DPI 之后导入）
import numpy as np  # noqa: E402

user32 = ctypes.windll.user32

# ---------------- 鼠标 ----------------


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG),
                ('mouseData', wintypes.DWORD), ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.c_void_p)]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD),
                ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD),
                ('dwExtraInfo', ctypes.c_void_p)]


class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = [('uMsg', wintypes.DWORD), ('wParamL', wintypes.WORD), ('wParamH', wintypes.WORD)]


class _INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [('mi', _MOUSEINPUT), ('ki', _KEYBDINPUT), ('hi', _HARDWAREINPUT)]
    _anonymous_ = ('u',)
    _fields_ = [('type', wintypes.DWORD), ('u', _U)]


INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP = 0x0008, 0x0010
KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE = 0x0002, 0x0008


def _send(*inputs):
    n = len(inputs)
    arr = (_INPUT * n)(*inputs)
    user32.SendInput(n, ctypes.byref(arr), ctypes.sizeof(_INPUT))


def cursor_pos():
    p = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(p))
    return (p.x, p.y)


class Mouse:
    """真鼠标。dry=True 时只记录不动手，用来对着真机验证识别效果。"""

    def __init__(self, dry=False):
        self.dry = dry
        self.moves = 0
        self.clicks = 0
        self.last = (None, None)
        self.last_move_t = 0.0

    def move(self, x, y):
        x, y = int(round(x)), int(round(y))
        if self.last == (x, y):
            return False
        self.last = (x, y)
        self.moves += 1
        if not self.dry:
            user32.SetCursorPos(x, y)
        return True

    def right_click(self):
        self.clicks += 1
        if self.dry:
            return
        down = _INPUT(type=INPUT_MOUSE, u=_INPUT._U(mi=_MOUSEINPUT(0, 0, 0, MOUSEEVENTF_RIGHTDOWN, 0, None)))
        up = _INPUT(type=INPUT_MOUSE, u=_INPUT._U(mi=_MOUSEINPUT(0, 0, 0, MOUSEEVENTF_RIGHTUP, 0, None)))
        _send(down, up)

    def key(self, vk):
        """按一个键（vk 是虚拟键码）。游戏里 X 也是放符卡。"""
        if self.dry:
            return
        down = _INPUT(type=INPUT_KEYBOARD, u=_INPUT._U(ki=_KEYBDINPUT(vk, 0, 0, 0, None)))
        up = _INPUT(type=INPUT_KEYBOARD, u=_INPUT._U(ki=_KEYBDINPUT(vk, 0, KEYEVENTF_KEYUP, 0, None)))
        _send(down, up)


# ---------------- 抓屏 ----------------


class Screen:
    """monitor=1 是主显示器；0 表示「所有显示器拼起来」（游戏在副屏时用这个）。"""

    def __init__(self, monitor=1):
        self.sct = mss.mss()
        self.monitor = monitor
        mons = self.sct.monitors
        if monitor < 0 or monitor >= len(mons):
            self.monitor = 1 if len(mons) > 1 else 0
        self.mon = mons[self.monitor]
        self.grabs = 0

    def monitors(self):
        return [dict(m) for m in self.sct.monitors[1:]]

    def bounds(self):
        m = self.mon
        return (m['left'], m['top'], m['width'], m['height'])

    def grab(self, rect=None):
        """rect=(x,y,w,h) 屏幕坐标；不传就抓整个显示器。返回 BGR。"""
        if rect is None:
            mon = self.mon
        else:
            x, y, w, h = [int(round(v)) for v in rect]
            mx, my, mw, mh = self.bounds()
            x0 = max(mx, min(mx + mw - 2, x))
            y0 = max(my, min(my + mh - 2, y))
            w = max(2, min(mw - (x0 - mx), w - (x0 - x)))
            h = max(2, min(mh - (y0 - my), h - (y0 - y)))
            mon = {'left': x0, 'top': y0, 'width': w, 'height': h}
        shot = self.sct.grab(mon)
        self.grabs += 1
        return np.asarray(shot, dtype=np.uint8)[:, :, :3].copy()

    def close(self):
        try:
            self.sct.close()
        except Exception:
            pass
