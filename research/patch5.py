def sub(p, pairs):
    s=open(p,encoding='utf-8').read()
    for a,b in pairs:
        assert a in s,(p,a[:60]); s=s.replace(a,b)
    open(p,'w',encoding='utf-8',newline='\n').write(s)
sub('yuyugu.mjs',[("if (args.has('--no-sell')) cfg.sell.enabled = false","if (args.has('--no-sell')) cfg.sell.enabled = false\nif (args.has('--steal')) cfg.steal.enabled = true\nif (args.has('--no-arena')) cfg.arena.enabled = false")])
sub('extension/popup.js',[("rows.push(['最近被偷',","rows.push(['最近一次发现被偷',")])
