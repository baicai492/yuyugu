"""和 bridge.mjs 说话的 Python 客户端。

    b = Bridge()
    b.open(stage='secret'),
    png = b.shot()                 # 整页 PNG（bytes）
    b.move(x, y)                   # 页面坐标
    b.eval('window.__dm.t')
    b.close()

bridge 是「屏幕 + 鼠标」的替身：页面渲染出来的像素原样给回来，
Engine 仍然自己找棕框、自己算屏幕坐标；动指针也仍然发屏幕坐标，
由 bridge 派发成页面里的 pointermove —— 和真机 SetCursorPos → WM_MOUSEMOVE
是同一条路径，只是少了操作系统那一层。
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


class Bridge:
    def __init__(self, node='node', verbose=False):
        self.verbose = verbose
        self._seq = 0
        self.proc = subprocess.Popen(
            [node, os.path.join(HERE, 'bridge.mjs')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
            cwd=HERE, text=True, encoding='utf-8', bufsize=1,
        )

    def call(self, op, timeout=60, **kw):
        self._seq += 1
        req = {'id': self._seq, 'op': op}
        req.update(kw)
        line = json.dumps(req, ensure_ascii=False)
        try:
            self.proc.stdin.write(line + '\n')
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError):
            raise RuntimeError('bridge 进程已退出')
        # 读回复是阻塞的（Windows 上 select 不支持管道）。bridge 正常时每条请求
        # 都有且只有一条回复，所以不需要超时轮询；真卡住时 Ctrl+C 退出即可。
        while True:
            out = self.proc.stdout.readline()
            if not out:
                raise RuntimeError('bridge 没有回话（进程可能崩了）')
            try:
                msg = json.loads(out)
            except ValueError:
                if self.verbose:
                    print('[bridge]', out.rstrip())
                continue
            if msg.get('id') != self._seq:
                if self.verbose:
                    print('[bridge] 丢弃乱序回复', msg.get('id'))
                continue
            if not msg.get('ok'):
                raise RuntimeError(msg.get('err') or 'bridge 返回失败')
            return msg

    # ---------------- 便捷接口 ----------------
    def open(self, stage='secret', tech='fire', lives=3, bombs=2,
             w=1200, h=900, xsdebug=True):
        q = 'stage=%s&tech=%s&lives=%d&bombs=%d' % (stage, tech, lives, bombs)
        if xsdebug:
            q += '&xsdebug=1'
        return self.call('open', url='/index.html?' + q, w=w, h=h, timeout=120)

    def shot(self, clip=None):
        import base64
        r = self.call('shot', clip=clip, timeout=120)
        return base64.b64decode(r['png'])

    # ---------------- 屏幕流 ----------------
    def start_cast(self, w=900, h=880, quality=80):
        """打开浏览器推帧。之后 frame() 就是「取最新一帧」，不再花抓屏时间。"""
        import base64
        r = self.call('cast', w=w, h=h, quality=quality, timeout=60)
        self._cast_seq = 0
        return r

    def frame(self, timeout_ms=400):
        """返回 (seq, 宽, 高, jpeg bytes)。seq 比上次新就是新帧。"""
        import base64
        r = self.call('frame', since=getattr(self, '_cast_seq', 0),
                      timeoutMs=timeout_ms, timeout=60)
        self._cast_seq = r['seq']
        return r['seq'], r['w'], r['h'], base64.b64decode(r['jpg'])

    def move(self, x, y):
        return self.call('move', x=float(x), y=float(y))

    def key(self, k):
        return self.call('key', key=k)

    def right_click(self):
        """右键放符卡：页面里是 pointerdown(button=2)。"""
        return self.eval('''(() => {
          const cv = document.querySelector('.xs-dm-cv');
          if (!cv) return { ok: false };
          cv.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, button: 2, buttons: 2, pointerType: 'mouse',
          }));
          return { ok: true };
        })()''')

    def eval(self, js):
        return self.call('eval', js=js)['v']

    def close(self):
        try:
            self.call('close', timeout=5)
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


if __name__ == '__main__':
    b = Bridge(verbose=True)
    try:
        print(b.eval('1+1'))
    finally:
        b.close()
