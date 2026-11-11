"""从 Chrome 扩展的 LevelDB 存储里，把旧版鱼鱼谷插件的运行日志抠出来。

LevelDB 的 .log 文件是「写入日志」格式：每条记录前面有一个 varint 长度（分块，
带 checksum/类型字节），后面跟键值。这里不实现完整的 LevelDB 解析，
而是用「按可打印字符切分 + 抽取 JSON」的方式把文本捞出来——足够用了。
"""
import io
import json
import re
import sys
import os

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

SRC = sys.argv[1] if len(sys.argv) > 1 else None
if not SRC:
    base = os.path.expandvars(r'%LOCALAPPDATA%/Google/Chrome/User Data/Profile 1/Local Extension Settings/memccobjoffkjbdfciconoaedglmfmbl')
    SRC = os.path.join(base, '000003.log')

print('数据源：', SRC)
data = open(SRC, 'rb').read()
print('大小：%.1f MB' % (len(data) / 1024 / 1024))

# 抽出所有看起来像日志行的东西：`2026-11-11 12:34:56 内容`
time_re = re.compile(rb'(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})')
lines = []
for m in time_re.finditer(data):
    start = m.start()
    end = data.find(b'\x00', start)
    if end < 0 or end - start > 4000:
        end = min(start + 400, len(data))
    chunk = data[start:end]
    try:
        text = chunk.decode('utf-8')
    except UnicodeDecodeError:
        try:
            text = chunk.decode('utf-8', 'ignore')
        except Exception:
            continue
    text = re.sub(r'[\x00-\x1f]', '', text).strip()
    if len(text) < 20:
        continue
    # 去掉可能粘在后面的二进制噪声：只保留到最后一个合理的字符
    text = re.sub(r'[�]+.*$', '', text)
    lines.append((m.group(1).decode(), text))

print('抽到 %d 条带时间的记录' % len(lines))

# 去重（LevelDB 里同一 key 会反复出现）
seen = set()
uniq = []
for t, text in lines:
    key = text[:200]
    if key in seen:
        continue
    seen.add(key)
    uniq.append((t, text))
print('去重后 %d 条' % len(uniq))
uniq.sort(key=lambda x: x[0])

# 输出
out = os.path.join(os.path.dirname(__file__), 'ext-logs-raw.txt')
with open(out, 'w', encoding='utf-8') as f:
    for t, text in uniq:
        f.write(text + '\n')
print('已写入', out)

print('\n=== 时间范围 ===')
if uniq:
    print('最早：', uniq[0][0])
    print('最晚：', uniq[-1][0])

print('\n=== 前 25 条 ===')
for t, text in uniq[:25]:
    print('  ', text[:190])

print('\n=== 后 25 条 ===')
for t, text in uniq[-25:]:
    print('  ', text[:190])
