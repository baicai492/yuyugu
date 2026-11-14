"""本地 HTTP 服务：浏览器插件的后台。只监听 127.0.0.1，不对外。

    python server.py              默认端口 8799
    python server.py --dry        只识别不动鼠标（安全演练）
    python server.py --port 8800

插件每秒钟拉一次 /api/status 刷新界面；用户在 popup 里点「开始托管」
就 POST /api/start。真正的抓屏 / 识别 / 动鼠标全在这个进程里。
"""
import argparse
import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from engine import Engine, VERSION        # noqa: E402

PORT = 8799
MAX_BODY = 1 << 20
# 宿主（native_host.py）拉起时写，退出时清；手动双击 启动.bat 起的不写
PID_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        'logs', 'danmaku.pid')

# 插件是 https://52dmeme.com 的页面，访问 http://127.0.0.1 属于跨源，
# 必须放开 CORS；反正只监听回环地址，外面连不进来。
# Allow-Private-Network 是 Chrome 的「公网页面访问内网」预检要求，
# 少了它内容脚本（上报场地矩形）会被浏览器直接拦掉。
CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '86400',
}


class Handler(BaseHTTPRequestHandler):
    server_version = 'DanmakuBot/' + VERSION
    engine = None                     # 由 main() 填
    httpd = None                      # 由 main() 填，/api/exit 用
    managed = False                   # 由宿主拉起 = True：停止托管时连进程一起退

    def log_message(self, fmt, *args):   # 别把每个请求都打到控制台
        pass

    # ---------------- 工具 ----------------
    def _status(self):
        st = self.engine.status()
        st['managed'] = bool(self.managed)
        return st

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        for k, v in CORS.items():
            self.send_header(k, v)
        if code != 204:
            self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if code == 204:
            return
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _body(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return {}
        if n <= 0 or n > MAX_BODY:
            return {}
        try:
            raw = self.rfile.read(n)
            obj = json.loads(raw.decode('utf-8'))
            return obj if isinstance(obj, dict) else {}
        except (ValueError, UnicodeDecodeError):
            return {}

    # ---------------- 路由 ----------------
    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        path = self.path.split('?', 1)[0].rstrip('/') or '/'
        try:
            if path in ('/', '/api/ping'):
                st = self._status()
                return self._send(200, {'ok': True, 'app': 'danmaku', 'version': VERSION,
                                        'state': st['state'], 'running': st['running'],
                                        'managed': st['managed']})
            if path == '/api/status':
                return self._send(200, self._status())
            if path == '/api/config':
                return self._send(200, {'ok': True, 'config': self.engine.cfg})
            if path == '/api/logs':
                st = self._status()
                return self._send(200, {'ok': True, 'logs': st['logs']})
            return self._send(404, {'ok': False, 'error': 'not found'})
        except Exception as e:                       # noqa: BLE001
            traceback.print_exc()
            return self._send(500, {'ok': False, 'error': str(e)})

    def do_POST(self):
        path = self.path.split('?', 1)[0].rstrip('/') or '/'
        body = self._body()
        try:
            if path == '/api/start':
                if 'dry' in body:
                    self.engine.set_config({'dry': bool(body['dry'])})
                self.engine.start()
                return self._send(200, self._status())
            if path == '/api/stop':
                self.engine.stop(str(body.get('why') or ''))
                return self._send(200, self._status())
            if path == '/api/config':
                cfg = self.engine.set_config(body)
                return self._send(200, {'ok': True, 'config': cfg})
            if path == '/api/hint':
                # 内容脚本报的是 CSS 像素；Python 这边（SetProcessDpiAwareness）
                # 全用物理像素，所以按 dpr 换算。算不准也没关系，取不到场地
                # 时会退回全屏扫描。
                dpr = float(body.get('dpr') or 1.0)
                if body.get('found') is False:
                    return self._send(200, {'ok': True, 'hint': self.engine.hint})
                rect = {'x': body.get('x', 0) * dpr, 'y': body.get('y', 0) * dpr,
                        'w': body.get('w', 0) * dpr, 'h': body.get('h', 0) * dpr}
                self.engine.set_hint(rect)
                return self._send(200, {'ok': True, 'hint': self.engine.hint})
            if path == '/api/fps':
                self.engine.set_config({'fps': body.get('fps', 30)})
                return self._send(200, {'ok': True, 'config': self.engine.cfg})
            if path == '/api/exit':
                # native host 的 shutdown 用：先回话，再在别的线程里关服务器，
                # 否则 shutdown() 会等当前这个请求处理完，卡在这里。
                self._send(200, {'ok': True, 'msg': '正在退出'})
                threading.Thread(target=self._exit, daemon=True).start()
                return None
            return self._send(404, {'ok': False, 'error': 'not found'})
        except Exception as e:                       # noqa: BLE001
            traceback.print_exc()
            return self._send(500, {'ok': False, 'error': str(e)})

    def _exit(self):
        # 鼠标必须松开，不然光标会被卡在「按住移动」的状态
        try:
            self.engine.stop('服务退出')
        except Exception:                            # noqa: BLE001
            pass
        try:
            self.httpd.shutdown()
        except Exception:                            # noqa: BLE001
            pass


def _clean_pid_file():
    """只有 PID 文件里写的是自己才删：别的实例可能刚接管。"""
    try:
        with open(PID_FILE, 'r', encoding='utf-8') as f:
            mine = int((f.read() or '').strip()) == os.getpid()
        if mine:
            os.remove(PID_FILE)
    except (OSError, ValueError):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=PORT)
    ap.add_argument('--dry', action='store_true', help='只识别不动鼠标')
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--monitor', type=int, default=1,
                    help='1=主屏，0=所有屏幕拼起来（游戏在副屏时用 0）')
    ap.add_argument('--managed', action='store_true',
                    help='由插件宿主拉起：停止托管时连本进程一起退出')
    args = ap.parse_args()

    eng = Engine(cfg={'dry': args.dry, 'fps': args.fps, 'monitor': args.monitor})
    Handler.engine = eng
    Handler.managed = bool(args.managed)
    eng.start_thread()

    httpd = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    httpd.daemon_threads = True
    Handler.httpd = httpd
    print('弹幕托管服务已启动：http://127.0.0.1:%d  （%s%s）'
          % (args.port, '演练模式，不动鼠标' if args.dry else '实弹模式',
             '，插件托管' if args.managed else '，手动启动'), flush=True)
    print('按 Ctrl+C 退出', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n正在退出…', flush=True)
    finally:
        eng.shutdown()
        httpd.server_close()
        _clean_pid_file()


if __name__ == '__main__':
    main()
