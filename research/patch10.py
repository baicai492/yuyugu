def sub(p, pairs):
    s=open(p,encoding='utf-8').read()
    for a,b in pairs:
        assert a in s,(p,a[:60]); s=s.replace(a,b)
    open(p,'w',encoding='utf-8',newline='\n').write(s)
sub('extension/content.js',[("MAX_LOG = 400","MAX_LOG = 1500")])
sub('extension/popup.css',[("--card: #18262210; --card: #19272300; --card: #1a2824;","--card: #1a2824;")])
sub('extension/page.mjs',[
("// ---------- 主循环",
"""// 按服务端数据补今天的账（日志被清空、换浏览器、插件更新前的操作都能补上）：
// 收入 = 赚钱榜里自己今天的累计（已扣税）；税 = 税务流水；支出 = 08:00 结余额税前的余额 + 收入 − 余额税 − 现在的余额。
async function recoverBook(w, memo) {
  const book = memo.book, day = bj().slice(0, 10)
  if (!book || book.day !== day || book.srv) return
  book.srv = true
  const get = async (p) => { const r = await http(p); if (!r.ok) throw new Error(r.json.error || 'HTTP ' + r.status); return r.json }
  const rank = await get('/api/pet/world/rank/earn/day?limit=1'), tax = await get('/api/pet/world/tax')
  const today = (tax.history || []).filter((h) => bj(h.created_at * 1000).slice(0, 10) === day)
  const saleTax = today.filter((h) => h.kind === 'pet-world-sale-tax').reduce((x, h) => x - h.delta, 0)
  const bal = today.find((h) => h.kind === 'pet-world-balance-tax')
  const earn = rank.day === day && rank.mine ? Number(rank.mine.value) || 0 : 0
  const start = store.get('day')
  if (bal) { const coins0 = bal.balance_after - bal.delta; store.set('day', { day, coins: coins0, stock: start?.day === day ? start.stock : Math.round(stockValue(w)) }); book.spend = Math.max(book.spend, coins0 + earn + bal.delta - w.coins) }
  book.earn = Math.max(book.earn, earn); book.tax = Math.max(book.tax, saleTax)
  log(`补账（按服务端数据）：今日收入 ${book.earn.toLocaleString('en-US')}，支出 ${book.spend.toLocaleString('en-US')}，卖货税 ${book.tax.toLocaleString('en-US')}` + (bal ? `，余额税 ${(-bal.delta).toLocaleString('en-US')}` : ''))
}

// ---------- 主循环"""),
("      store.set('memo', memo)\n", "      if (!cfg.dry || once) try { await recoverBook(r.world, memo) } catch (e) { log('补账失败：' + e.message) }\n      store.set('memo', memo)\n"),
("ripeAt: r.ripeAt,","ripeAt: r.ripeAt, mineMax: w.state.mine?.max,"),
])
