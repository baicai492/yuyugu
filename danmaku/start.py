"""双击这个（或在命令行跑 `python start.py`）就起本地识别服务。

    python start.py               正常模式（会动鼠标）
    python start.py --dry         演练模式：只识别不动鼠标
    python start.py --port 8800   换端口

服务起来以后，在 Chrome 插件里点「开始托管」。
"""
import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(HERE, 'python')
SERVER = os.path.join(PY, 'server.py')


def find_python():
    """优先用装了 opencv/mss 的那个解释器。"""
    cands = [
        r'D:\miniconda\envs\py311\python.exe',
        sys.executable,
    ]
    for p in cands:
        if p and os.path.exists(p):
            return p
    return 'python'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8799)
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--monitor', type=int, default=1, help='1=主屏，0=所有屏幕')
    a = ap.parse_args()

    py = find_python()
    cmd = [py, SERVER, '--port', str(a.port), '--fps', str(a.fps), '--monitor', str(a.monitor)]
    if a.dry:
        cmd.append('--dry')
    print('启动：%s' % ' '.join(cmd), flush=True)
    try:
        raise SystemExit(subprocess.call(cmd, cwd=PY))
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
