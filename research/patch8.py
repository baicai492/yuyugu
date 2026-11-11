def sub(p, pairs):
    s=open(p,encoding='utf-8').read()
    for a,b in pairs:
        assert a in s,(p,a[:60]); s=s.replace(a,b)
    open(p,'w',encoding='utf-8',newline='\n').write(s)
sub('extension/content.js',[
("  const sendConfig = guard(async () => post('config', { cfg: (await chrome.storage.local.get('cfg')).cfg || {} }))",
"""  // 从已保存的日志里把今天的收入 / 支出 / 税加出来，给页面端补账（插件更新前的记录也能算上）
  const num = (re, l) => { const m = re.exec(l); return m ? Number(m[1].replace(/,/g, '')) : 0 }
  const sendSeed = guard(async () => {
    const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10), seed = { day, earn: 0, spend: 0, tax: 0 }
    for (const l of (await chrome.storage.local.get('logs')).logs || []) {
      if (!l.startsWith(day)) continue
      if (/ 第 \d+ 轮：/.test(l)) { seed.earn += num(/｜收入 ([\d,]+)/, l); seed.spend += num(/｜支出 ([\d,]+)/, l); seed.tax += num(/已扣税 ([\d,]+)/, l) }
      else if (/五子棋赢了/.test(l)) seed.earn += num(/：\+([\d,]+) D币/, l)
    }
    post('seed', { seed })
  })
  const sendConfig = guard(async () => { await sendSeed(); post('config', { cfg: (await chrome.storage.local.get('cfg')).cfg || {} }) })"""),
])
sub('extension/page.mjs',[
("  if (d.type === 'config') {", "  if (d.type === 'seed') seed = d.seed\n  else if (d.type === 'config') {"),
("let live = null, forced = false, halted = false", "let live = null, forced = false, halted = false, seed = null"),
("      store.set('memo', memo)\n", "      if (seed && memo.book?.day === seed.day && !memo.book.seeded) { for (const k of ['earn', 'spend', 'tax']) memo.book[k] = Math.max(memo.book[k], seed[k]); memo.book.seeded = true }\n      store.set('memo', memo)\n"),
])
