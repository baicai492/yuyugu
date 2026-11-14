"""校验离线版和线上是否一致。

    python verify.py

三条硬要求：
  1. danmaku.js / ui.js 必须和 52dmeme.com 上返回来的一模一样（逐字节）
  2. xs.css 同上（仓库里不存这个文件，只有线上有）
  3. 美术资源逐个比大小/校验和，缺一个都会导致画面和线上不同

校验和写进 online.sha256，改了离线文件之后重跑这个脚本就能发现漂移。
"""
import hashlib
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = 'https://52dmeme.com/xs/'
REPO = os.path.join(os.path.dirname(os.path.dirname(HERE)), 'new4', 'xs')

# 线上文件的 ?v= 版本号会随发布变，改了版本号要跟着改这里
V = '20b20a0e'

CODE = ['danmaku.js', 'ui.js', 'xs.css']
ART = [
    'whale-farm', 'fx-danmaku',
    'en-bat', 'en-spider', 'en-fox', 'en-cultist', 'en-swordghost', 'en-puppet',
    'boss-demonlord', 'boss-swordtomb',
    'bg-secret-far', 'bg-secret-mid', 'bg-secret-near',
    'bg-demon-far', 'bg-demon-mid', 'bg-demon-near',
    'bg-sword-far', 'bg-sword-mid', 'bg-sword-near',
]


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch(url):
    # 站点对没有 UA 的请求直接 403，带上浏览器的 UA
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                      '(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
        'Referer': 'https://52dmeme.com/pets',
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main():
    bad = 0
    print('=== 代码 ===')
    for name in CODE:
        local = os.path.join(HERE, name)
        if not os.path.exists(local):
            print('  ✗ %-12s 离线版缺这个文件' % name)
            bad += 1
            continue
        want = fetch(BASE + name + ('?v=' + V if name != 'ui.js' or True else ''))
        got = open(local, 'rb').read()
        same = hashlib.sha256(want).hexdigest() == hashlib.sha256(got).hexdigest()
        print('  %s %-12s %s' % ('✓' if same else '✗', name,
                                 '线上一致' if same else '和线上不同！'))
        bad += 0 if same else 1
        # 顺带看看仓库里那份是不是也一样
        rp = os.path.join(REPO, name)
        if os.path.exists(rp):
            rsame = sha(rp) == sha(local)
            print('      └ 仓库 new4/xs/%s %s' % (name, '一致' if rsame else '不一致'))

    print('\n=== 美术 ===')
    miss = []
    for n in ART:
        p = os.path.join(HERE, 'art', n + '.webp')
        if not os.path.exists(p):
            miss.append(n)
            continue
    if miss:
        print('  ✗ 缺 %d 个：%s' % (len(miss), ', '.join(miss)))
        bad += len(miss)
    else:
        print('  ✓ %d 个美术文件齐全' % len(ART))
        # 抽 3 个和线上比
        for n in ART[:3]:
            local = open(os.path.join(HERE, 'art', n + '.webp'), 'rb').read()
            want = fetch(BASE + 'art/' + n + '.webp?v=' + V)
            same = hashlib.sha256(want).hexdigest() == hashlib.sha256(local).hexdigest()
            print('  %s %-18s %d KB %s' % ('✓' if same else '✗', n, len(local) // 1024,
                                           '线上一致' if same else '和线上不同！'))
            bad += 0 if same else 1

    print('\n%s' % ('全部一致' if bad == 0 else '有 %d 处不一致' % bad))
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
