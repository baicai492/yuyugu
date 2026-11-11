p='extension/lib/core.mjs'; s=open(p,encoding='utf-8').read()
old="（${e.dry.energy.c.name}）经济作物 ${e.dry.cash.c.name}`)"
new="（${e.food?.c.name || '无'}）经济作物 ${e.cash?.c.name || '无'}`)"
assert old in s; s=s.replace(old,new)
open(p,'w',encoding='utf-8',newline='\n').write(s)
