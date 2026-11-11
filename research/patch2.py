"""补丁 2：把防偷提示、擂台日常、自动偷菜接进 core / page / yuyugu / popup。"""
def sub(p, pairs):
    s = open(p, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (p, old[:70])
        s = s.replace(old, new)
    open(p, 'w', encoding='utf-8', newline='\n').write(s)

sub('extension/lib/social.mjs', [
    ("  const now = () => Math.floor(Date.now() / 1000 + (w.now - Date.now() / 1000 > 5 || w.now - Date.now() / 1000 < -5 ? w.now - Date.now() / 1000 : 0))",
     "  const now = () => Math.floor(io.now ? io.now() : Date.now() / 1000)"),
])
sub('extension/lib/defaults.mjs', [
    ("steal: { enabled: false, minEV: 3000,", "steal: { enabled: false, minEV: 3000, energyValue: 300,"),
])
sub('extension/lib/core.mjs', [
    ("import { planRound, nextWake } from './strategy.mjs'",
     "import { planRound, nextWake, nextRipe } from './strategy.mjs'\nimport { arenaDaily, stealRound } from './social.mjs'"),
    ("  let w = await io.world()\n  const start = w.coins",
     """  let w = await io.world()
  const start = w.coins
  // 防偷：地里留下了小偷记录 → 之后 24 小时自动续守家道具；设了离线时段也续
  if ((w.state.plots || []).some((p) => p?.sv?.length)) memo.stolenAt = w.now
  const hints = () => ({ guard: cfg.defense.guardItems && (cfg.offline.enabled || w.now - (memo.stolenAt || 0) < 86400) })"""),
    ("    const plan = planRound(R, w, cfg)", "    const plan = planRound(R, { ...w, hints: hints() }, cfg)"),
    ("""    if (cfg.help.enabled && io.neighbors) w = await helpNeighbors(io, R, w, cfg, log, memo)
  }""",
     """    if (cfg.help.enabled && io.neighbors) w = await helpNeighbors(io, R, w, cfg, log, memo)
    try { await arenaDaily(io, R, w, cfg, log, memo) } catch (e) { log('擂台日常出错：' + e.message) }
  }
  let stealAt = 0
  if (!cfg.dry) try { const r = await stealRound(io, R, w, cfg, log, memo); w = r.world; stealAt = r.wakeAt } catch (e) { log('偷菜出错：' + e.message) }"""),
    ("  return { world: w, sleep: nextWake(R, w, cfg), earn, spend }",
     """  let sleep = nextWake(R, w, cfg)
  if (stealAt) sleep = Math.max(5, Math.min(sleep, Math.ceil(stealAt - w.now)))
  return { world: w, sleep, earn, spend, ripeAt: nextRipe(R, w) }"""),
])
api_node = """  async api(path, body) {
    const r = await http('/api' + path, body)
    if (!r.ok) throw Object.assign(new Error(r.json.error || '请求失败（HTTP ' + r.status + '）'), { status: r.status })
    return r.json
  },
  sleep, now: () => Date.now() / 1000 + skew,
"""
sub('yuyugu.mjs', [("const io = {\n  async world() {", "const io = {\n" + api_node + "  async world() {")])
sub('extension/page.mjs', [
    ("  return {\n    async world() {", "  return {\n" + api_node.replace("\n  ", "\n    ").replace("  async api", "    async api", 1).rstrip(' ') + "    async world() {"),
    ("plots: w.state.plotN, animals: w.state.barn.length,", "ripeAt: r.ripeAt, stolenAt: memo.stolenAt || 0, plots: w.state.plotN, animals: w.state.barn.length,"),
])
sub('extension/popup.html', [
    ('      <label><input type="checkbox" data-path="help.enabled" />串门帮忙（实测基本不赚）</label>',
     '''      <label><input type="checkbox" data-path="help.enabled" />串门帮忙（实测基本不赚）</label>
      <label><input type="checkbox" data-path="arena.enabled" />擂台日常（免费拿装备，守家更能打）</label>
      <b>防偷</b>
      <label><input type="checkbox" data-path="defense.guardItems" />被偷后 / 离线时段自动续守家道具（约 2400 D/天）</label>
      <label><input type="checkbox" data-path="offline.enabled" />我每天有固定时段关浏览器</label>
      <label class="num">离线开始（北京时间）<input type="time" data-path="offline.from" /></label>
      <label class="num">离线结束<input type="time" data-path="offline.to" /></label>
      <b>偷菜（默认关）</b>
      <label><input type="checkbox" data-path="steal.enabled" />自动偷菜：盯着别人的地，保护期一过就去</label>
      <label><input type="checkbox" data-path="steal.items" />自动买轻步斗篷和折叠菜篮（3700 D/天）</label>
      <label class="num">一趟期望收益下限（D币）<input type="number" min="0" step="500" data-path="steal.minEV" /></label>'''),
])
sub('extension/popup.js', [
    ("  const n = Number(el.value)\n", "  if (el.type === 'time') return el.value ? save({ [el.dataset.path]: el.value }) : drawConfig()\n  const n = Number(el.value)\n"),
    ("    else if (document.activeElement !== el) el.value = Math.round(v * (Number(el.dataset.scale) || 1) * 100) / 100",
     "    else if (el.type === 'time') el.value = v\n    else if (document.activeElement !== el) el.value = Math.round(v * (Number(el.dataset.scale) || 1) * 100) / 100"),
    ("    if (s.tools) rows.push(",
     "    if (s.ripeAt) rows.push(['下一块地成熟', new Date(s.ripeAt * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '（成熟即收，30 分钟内偷不了）'])\n    if (s.stolenAt) rows.push(['最近被偷', new Date(s.stolenAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })])\n    if (s.tools) rows.push("),
])
print('patched2')
