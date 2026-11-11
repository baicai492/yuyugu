"""把 pet-isle.js 里真正的业务逻辑行挑出来（跳过绘图/动画），用于逐行通读。

不抽样：只要一行里出现动作、接口、规则常量、面板入口，就打印出来；
连续行会合并显示，间隔用 ... 标记，方便对照原文行号。
"""
import io
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

PATH = sys.argv[1] if len(sys.argv) > 1 else 'live/pet-isle.js'
START = int(sys.argv[2]) if len(sys.argv) > 2 else 0
END = int(sys.argv[3]) if len(sys.argv) > 3 else 10 ** 9

PATTERN = re.compile(
    r"actNow|push\(|R\.(WORLD|AUTO|NPC|SCRATCH|LOTTO|b12|GOAL|RECIPES|CROPS|ANIMALS|FISH|ORES|SHOP|QUALITY|ITEM_NAME|BASE_PRICE)"
    r"|\{\s*a:\s*'|openAuto|openMenu|choresMenu|foodMenu|autoConfig|autoLog|MAILBOX|'goal'|warehouse|nightClaim|storyRead"
    r"|fetch\('/api|/api/pet"
)

lines = open(PATH, encoding='utf-8').read().split('\n')
prev = -2
for i, line in enumerate(lines):
    if not (START <= i + 1 <= END):
        continue
    if PATTERN.search(line):
        if i != prev + 1:
            print('        ...')
        print('%4d| %s' % (i + 1, line[:900]))
        prev = i
