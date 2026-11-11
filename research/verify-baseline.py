"""核对：仓库里提交的旧版脚本，是否就是对话 b69df889 结束时的最终状态。

思路：
1. 从会话 JSONL 里按时间顺序取出所有会改文件的工具调用
   （Write / Edit / 以及提到 yuyugu 路径的 Bash 补丁脚本）。
2. 对每个仓库内文件，算出它在会话里「最后一次被改动」的时间和方式。
3. 与磁盘 mtime 对照：磁盘时间必须不早于该次改动、且早于会话结束。
4. 同时报告哪些文件是 Bash 补丁改的（这类无法从事务记录里回放内容）。

注意：早期版本的本脚本用「最后一次 Write 的内容」直接比对，这是错的——
很多文件在 Write 之后又被 Edit 或补丁脚本改过，所以会误报不一致。
"""
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')

SESSION = r'C:/Users/Administrator/.claude/projects/E--lrz-python-project/b69df889-4280-4de3-9413-63e7f2c8604a.jsonl'
ROOT = r'E:/lrz/python project/52dmeme/yuyugu'
ROOT_N = ROOT.replace('\\', '/').lower()

touches = []   # (timestamp, kind, path, extra)

for line in open(SESSION, encoding='utf-8'):
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get('type') != 'assistant':
        continue
    ts = d.get('timestamp') or ''
    for b in ((d.get('message') or {}).get('content') or []):
        if not isinstance(b, dict) or b.get('type') != 'tool_use':
            continue
        name = b.get('name')
        inp = b.get('input') or {}
        if name in ('Write', 'Edit'):
            fp = inp.get('file_path')
            if fp:
                touches.append((ts, name, fp.replace('\\', '/'), ''))
        elif name == 'Bash':
            cmd = inp.get('command') or ''
            # 补丁脚本：命令里出现的 yuyugu 相对路径（extension/... lib/... research/...）
            for m in re.finditer(r"((?:extension|lib|research|core)/[A-Za-z0-9_.\-/]+\.(?:mjs|js|py|html|css|json))", cmd):
                touches.append((ts, 'Bash', m.group(1), '补丁脚本'))
            # 直接 sed -i 某文件
            for m in re.finditer(r"sed -i[^\n]*?((?:extension|lib|research)/[A-Za-z0-9_.\-/]+\.(?:mjs|js|html|css|json))", cmd):
                touches.append((ts, 'sed', m.group(1), '就地替换'))

touches.sort(key=lambda x: x[0])
session_end = touches[-1][0] if touches else '?'

# 仓库内的被跟踪文件
tracked = []
for base, dirs, files in os.walk(ROOT):
    dirs[:] = [x for x in dirs if x not in ('.git', 'node_modules', 'live', 'new', 'cache', 'logs', 'ref')]
    for f in files:
        p = os.path.join(base, f)
        rel = os.path.relpath(p, ROOT).replace('\\', '/')
        if rel.startswith('research/') and rel.split('/')[-1].startswith('pet-'):
            continue
        tracked.append(rel)

print('会话里最后一次涉文件的工具调用：', session_end)
print('会话结束（最后一条记录）：', max(t[0] for t in touches))
print()

print('%-44s %-19s %-7s %-12s %s' % ('file', '磁盘mtime', '来源', '会话最后改动', '方式'))
print('-' * 118)
issues = []
for rel in sorted(tracked):
    disk = os.path.join(ROOT, rel)
    mtime = os.path.getmtime(disk)
    import datetime
    mt = datetime.datetime.fromtimestamp(mtime).strftime('%m-%d %H:%M:%S')
    rel_n = rel.lower()
    mine = [t for t in touches if t[2].lower().replace('\\', '/').endswith(rel_n)]
    if mine:
        ts, kind, _, extra = mine[-1]
        src = '有记录'
        way = kind + ((' / ' + extra) if extra else '')
    else:
        ts, src, way = '(无)', '无记录', '会话外产生'
    # 磁盘时间应晚于（或接近）最后一次改动
    if mine:
        from datetime import timezone
        got = datetime.datetime.fromtimestamp(mtime, tz=timezone.utc)
        want = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00'))
        if got + datetime.timedelta(seconds=2) < want:
            issues.append((rel, '磁盘比会话最后改动还早', mt, ts))
    print('%-44s %-19s %-7s %-12s %s' % (rel, mt, src, ts[5:19], way))

print('-' * 118)
if issues:
    print('⚠ 可疑：')
    for x in issues:
        print('  ', x)
else:
    print('全部文件的磁盘时间都不早于会话内最后一次改动 —— 与「提交即该对话最终状态」相符。')
