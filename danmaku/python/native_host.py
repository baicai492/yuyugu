"""Chrome Native Messaging 宿主：让插件自己把本地识别服务拉起来。

没有它，用户得先双击 danmaku\\启动.bat 才能点「开始托管」——多一步。
有了它，插件里点「开始托管」就自动起服务（Chrome 只允许通过 native host 启进程）。

协议：stdin/stdout 上每条消息是「4 字节小端长度 + UTF-8 JSON」。
本宿主只在扩展调用 runtime.sendNativeMessage 时被 Chrome 拉起，
处理一条消息就退出，所以不需要常驻。

支持的命令：
  {cmd:'launch',   port}  → 起 server.py（已在跑就直接返回 running）
  {cmd:'status',   port}  → 探端口，返回 running / stopped
  {cmd:'shutdown', port}  → 让服务退出（先停托管，再关进程）

致命细节：stdout 是协议通道，任何多余的 print 都会让 Chrome 判定消息损坏。
所以这里所有日志都写文件，绝不 print；出错也只通过 sendMessage 报告。
"""
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # danmaku/
SERVER = os.path.join(HERE, 'server.py')
LOG_DIR = os.path.join(ROOT, 'logs')
PID_FILE = os.path.join(LOG_DIR, 'danmaku.pid')

DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000


# ---------------- Native Messaging 编解码 ----------------
def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack('<I', raw)[0]
    body = sys.stdin.buffer.read(n)
    if len(body) < n:
        return None
    try:
        return json.loads(body.decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        return None


def send_message(obj):
    data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# ---------------- 工具 ----------------
def find_python():
    """优先用装了 opencv/mss 的解释器；本宿主就是它起的，所以自己最可靠。"""
    for p in (sys.executable, r'D:\miniconda\envs\py311\python.exe'):
        if p and os.path.exists(p):
            return p
    return 'python'


def port_open(port, timeout=0.6):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        return s.connect_ex(('127.0.0.1', int(port))) == 0
    finally:
        s.close()


def read_pid():
    try:
        with open(PID_FILE, 'r', encoding='utf-8') as f:
            n = int((f.read() or '').strip())
        return n if n > 0 else 0
    except (OSError, ValueError):
        return 0


def pid_alive(pid):
    if not pid:
        return False
    try:
        # Windows 上 os.kill(pid, 0) 会真的发信号，用 OpenProcess 更安全
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000, False, int(pid))     # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = k32.GetExitCodeProcess(h, ctypes.byref(code))
        k32.CloseHandle(h)
        return bool(ok) and code.value == 259           # STILL_ACTIVE
    except Exception:
        return False


def kill_pid(pid):
    if not pid:
        return
    try:
        subprocess.run(['taskkill', '/PID', str(int(pid)), '/T', '/F'],
                       capture_output=True, creationflags=CREATE_NO_WINDOW, timeout=8)
    except Exception:
        pass


# ---------------- 命令 ----------------
def launch(port):
    port = int(port or 8799)
    if port_open(port):
        return {'ok': True, 'state': 'running', 'msg': '本地识别服务已在运行'}

    # 有 PID 但端口不通（僵死）→ 先杀掉，否则多个进程抢同一个端口
    old = read_pid()
    if old and pid_alive(old):
        kill_pid(old)
        time.sleep(0.6)

    if not os.path.exists(SERVER):
        return {'ok': False, 'msg': '找不到 server.py：' + SERVER}

    os.makedirs(LOG_DIR, exist_ok=True)
    log_path = os.path.join(LOG_DIR, 'danmaku-server.log')
    try:
        log = open(log_path, 'a', encoding='utf-8', errors='replace')
    except OSError as e:
        return {'ok': False, 'msg': '打不开日志文件：%s' % e}

    env = dict(os.environ)
    # 代理会让本地回环请求也被转发，服务自己发 HTTP 时不稳；顺带清掉
    for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        env.pop(k, None)
    env['PYTHONIOENCODING'] = 'utf-8'

    try:
        proc = subprocess.Popen(
            [find_python(), SERVER, '--port', str(port)],
            cwd=HERE,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            env=env,
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
            close_fds=True,
        )
    except Exception as e:                      # noqa: BLE001
        log.close()
        return {'ok': False, 'msg': '启动失败：%s' % e}
    finally:
        try:
            log.close()                          # 子进程已经继承了句柄
        except Exception:
            pass

    try:
        with open(PID_FILE, 'w', encoding='utf-8') as f:
            f.write(str(proc.pid))
    except OSError:
        pass

    # 首次导入 cv2/numpy 约 1~2 秒，给足 15 秒
    for _ in range(30):
        time.sleep(0.5)
        if port_open(port):
            return {'ok': True, 'state': 'started', 'pid': proc.pid,
                    'msg': '本地识别服务已启动'}
        if not pid_alive(proc.pid):
            return {'ok': False, 'msg': '服务启动后立即退出了，请看 logs/danmaku-server.log'}
    return {'ok': False, 'msg': '启动超时（15 秒内端口未就绪），请看 logs/danmaku-server.log'}


def _post(port, path, body, timeout=3.0):
    data = json.dumps(body or {}).encode('utf-8')
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (int(port), path),
                                 data=data, headers={'Content-Type': 'application/json'},
                                 method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status


def shutdown(port):
    port = int(port or 8799)
    if port_open(port):
        try:
            _post(port, '/api/stop', {'why': '服务关闭'})
        except Exception:
            pass
        try:
            _post(port, '/api/exit', {})
        except Exception:
            pass
        time.sleep(0.8)
    if port_open(port):
        pid = read_pid()
        if pid and pid_alive(pid):
            kill_pid(pid)
    try:
        os.remove(PID_FILE)
    except OSError:
        pass
    return {'ok': True, 'state': 'stopped', 'msg': '本地识别服务已退出'}


def status(port):
    port = int(port or 8799)
    up = port_open(port)
    pid = read_pid()
    # 上次异常退出会留下死 PID，别让它冒充「在跑」
    if pid and not pid_alive(pid):
        pid = 0
    return {'ok': True, 'state': 'running' if up else 'stopped', 'pid': pid}


def main():
    # 命令行自检用（安装脚本会调它验证）
    if len(sys.argv) > 2 and sys.argv[1] == '--self-test':
        print(json.dumps(status(sys.argv[2])))
        return
    while True:
        msg = read_message()
        if msg is None:
            break
        port = msg.get('port') or 8799
        cmd = msg.get('cmd')
        try:
            if cmd == 'launch':
                res = launch(port)
            elif cmd == 'status':
                res = status(port)
            elif cmd == 'shutdown':
                res = shutdown(port)
            else:
                res = {'ok': False, 'msg': '未知命令：%s' % cmd}
        except Exception as e:                  # noqa: BLE001
            res = {'ok': False, 'msg': str(e)}
        send_message(res)


if __name__ == '__main__':
    main()
