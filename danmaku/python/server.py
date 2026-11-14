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
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from engine import Engine, VERSION        # noqa: E402

PORT = 8799
MAX_BODY = 1 << 20

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

    def log_message(self, fmt, *args):   # 别把每个请求都打到控制台
        pass

    # ---------------- 工具 ----------------
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
                st = self.engine.status()
                return self._send(200, {'ok': True, 'app': 'danmaku', 'version': VERSION,
                                        'state': st['state'], 'running': st['running']})
            if path == '/api/status':
                return self._send(200, self.engine.status())
            if path == '/api/config':
                return self._send(200, {'ok': True, 'config': self.engine.cfg})
            if path == '/api/logs':
                st = self.engine.status()
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
                return self._send(200, self.engine.status())
            if path == '/api/stop':
                self.engine.stop(str(body.get('why') or ''))
                return self._send(200, self.engine.status())
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
            return self._send(404, {'ok': False, 'error': 'not found'})
        except Exception as e:                       # noqa: BLE001
            traceback.print_exc()
            return self._send(500, {'ok': False, 'error': str(e)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=PORT)
    ap.add_argument('--dry', action='store_true', help='只识别不动鼠标')
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--monitor', type=int, default=1,
                    help='1=主屏，0=所有屏幕拼起来（游戏在副屏时用 0）')
    args = ap.parse_args()

    eng = Engine(cfg={'dry': args.dry, 'fps': args.fps, 'monitor': args.monitor})
    Handler.engine = eng
    eng.start_thread()

    httpd = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    httpd.daemon_threads = True
    print('弹幕托管服务已启动：http://127.0.0.1:%d  （%s）'
          % (args.port, '演练模式，不动鼠标' if args.dry else '实弹模式'), flush=True)
    print('按 Ctrl+C 退出', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n正在退出…', flush=True)
    finally:
        eng.shutdown()
        httpd.server_close()


if __name__ == '__main__':
    main()
