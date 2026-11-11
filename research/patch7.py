"""补丁 7：钓鱼时段开始时唤醒；按天记收入 / 支出 / 税并在弹窗显示。"""
def sub(p, pairs):
    s = open(p, encoding='utf-8').read()
    for a, b in pairs:
        assert a in s, (p, a[:60])
        s = s.replace(a, b)
    open(p, 'w', encoding='utf-8', newline='\n').write(s)

sub('extension/lib/strategy.mjs', [
    ("  s.traps.forEach((tr) => { const st = R.trapReady(tr, t, weather === 2); if (!st.n) hit(t + st.left + 2) })\n  return Math.max(cfg.loop.minSleep",
     "  s.traps.forEach((tr) => { const st = R.trapReady(tr, t, weather === 2); if (!st.n) hit(t + st.left + 2) })\n"
     "  // 钓鱼看岛上的小时（现实 10 分钟一格）：还有竿数没用时，每到整点醒一次，最佳时段一开始就下竿\n"
     "  if (cfg.fish.enabled && !R.b12IsLongNight(t) && R.isleCount(s, 'fish', t) < R.WORLD.daily.fish) hit(t + 600 - (R.b12ClockSeconds(t) % 600) + 2)\n"
     "  return Math.max(cfg.loop.minSleep"),
])
sub('extension/lib/core.mjs', [
    ("  let w = await io.world()\n  const start = w.coins",
     "  let w = await io.world()\n  const start = w.coins\n"
     "  // 当天账本：所有提交的动作里服务端确认的收入（已扣税）/ 支出 / 税\n"
     "  const bday = R.worldDay(w.now), book = memo.book?.day === bday ? memo.book : (memo.book = { day: bday, earn: 0, spend: 0, tax: 0 })\n"
     "  const rawAct = io.act\n"
     "  io = { ...io, act: async (rev, actions) => { const r = await rawAct(rev, actions); for (const o of r.out || []) if (o?.ok) { book.earn += o.earn || 0; book.spend += o.spend || 0; book.tax += o.tax || 0 } return r } }"),
])
sub('extension/page.mjs', [
    ("ripeAt: r.ripeAt,", "ripeAt: r.ripeAt, book: memo.book,"),
])
sub('extension/popup.js', [
    ("    if (s.dayStart) { const d = s.coins + (s.stock || 0) - s.dayStart.coins - (s.dayStart.stock || 0); rows.push(['今日净增（D币 + 库存）', [d >= 0 ? 'up' : 'down', (d >= 0 ? '+' : '') + wan(d)]]) }",
     "    const sign = (d) => [d >= 0 ? 'up' : 'down', (d >= 0 ? '+' : '−') + wan(Math.abs(d))]\n"
     "    if (s.book) rows.push(['今日收入（已扣税）', ['up', '+' + wan(s.book.earn)]], ['今日支出', ['down', '−' + wan(s.book.spend)]], ['今日现金盈亏', sign(s.book.earn - s.book.spend)], ['今日卖货税', fmt(s.book.tax)])\n"
     "    if (s.dayStart) { const dc = s.coins - s.dayStart.coins, ds = (s.stock || 0) - (s.dayStart.stock || 0); if (s.book && Math.abs(dc - (s.book.earn - s.book.spend)) > 100) rows.push(['其他 D币 变动（余额税、偷菜罚款、手动操作等）', sign(dc - (s.book.earn - s.book.spend))]); rows.push(['今日库存变化（按现价）', sign(ds)], ['今日净增（D币 + 库存）', sign(dc + ds)]) }"),
])
print('patched7')
