p='extension/lib/defaults.mjs'; s=open(p,encoding='utf-8').read()
assert 'loop:' not in s
old="}\nexport function mergeConfig"
new="  loop: { minSleep: 20, maxSleep: 600, maxRounds: 30, postGap: 2.3 },\n}\nexport function mergeConfig"
assert old in s; s=s.replace(old,new)
open(p,'w',encoding='utf-8',newline='\n').write(s)
