def sub(p, pairs):
    s=open(p,encoding='utf-8').read()
    for a,b in pairs:
        assert a in s,(p,a[:60]); s=s.replace(a,b)
    open(p,'w',encoding='utf-8',newline='\n').write(s)
sub('extension/page.mjs',[
("    if (!live.enabled && !forced) { report({ state: 'paused', msg: '', nextAt: 0 }); await nap(3600); continue }",
"""    if (!live.enabled && !forced) {
      // 暂停时不操作，只读一次状态并按服务端数据补账，弹窗里照样能看到今天的收支
      try {
        await loadRules()
        const w = await makeIo({ ...live, dry: true }).world(), t = w.now, day = R.isleDay(t), today = bj().slice(0, 10)
        if (memo.book?.day !== today) memo.book = { day: today, earn: 0, spend: 0, tax: 0 }
        await recoverBook(w, memo); store.set('memo', memo)
        report({ ver: rulesVer, coins: w.coins, stock: Math.round(stockValue(w)), en: w.state.en, enMax: R.energyMax(w.state), isleNo: R.isleDayNo(t), season: R.SEASONS[R.seasonOf(day)], weather: R.WEATHERS[R.weatherOf(day)], night: R.b12IsLongNight(t), mineMax: w.state.mine?.max, book: memo.book, plots: w.state.plotN, animals: w.state.barn.length, tools: w.state.tools, dayStart: store.get('day') })
      } catch (e) { if (!(e instanceof AuthError)) console.warn('[鱼鱼谷托管] 读取状态失败', e) }
      report({ state: 'paused', msg: '', nextAt: 0 }); await nap(600); continue
    }"""),
])
sub('extension/popup.js',[
("  if (confirmed || cfg.dry || !cfg.invest.enabled) return save({ enabled: true })",
 "  // 岛已经升级过（地块 / 工具不是初始值）就不再提示\n  const built = status && (status.plots > 6 || status.tools?.rod > 1 || status.tools?.pick > 1)\n  if (confirmed || built || cfg.dry || !cfg.invest.enabled) return save({ enabled: true })"),
])
