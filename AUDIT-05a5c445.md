# 全模块审计（2026-11-13，站点 05a5c445 / 修仙 20b20a0e）

这份文档回答一个问题：**鱼鱼谷 + 修仙的每一个前端模块、每一个协议动作，是不是都被完整分析过、
并且明确知道了「接了没有、为什么」？**

不是「之前分析过所以跳过」，而是本轮重新把线上文件全量拉下来逐个数。三份规则文件用登录态
cookie 重新下载后与本地缓存 `diff` 逐字节一致（2026-11-13 17:4x）：

| 文件 | 线上大小 | 本地 |
|---|---|---|
| `/pet-world-rules.js?v=05a5c445` | 116,876 B | `cache/rules-05a5c445.mjs` ✅ 逐字节 |
| `/arcade-rules.js?v=05a5c445` | 15,693 B | `cache/arcade-05a5c445.mjs` ✅ 逐字节 |
| `/xs/rules.js?v=20b20a0e` | 43,177 B | `cache/xsrules-20b20a0e.mjs` ✅ 逐字节 |

入口链：`/pets`（HTML）→ `/app.js?v=05a5c445`（站点主程序）→ 动态 `import('/pets.js?v=05a5c445')`
→ 小岛各模块；修仙走 `/xs/entry.js?v=20b20a0e` → `xs/game.js`。

---

## 一、前端模块全清单（33 个，全部逐个读过）

「托管」一栏说明这个模块里的**协议动作**由谁处理；纯渲染模块没有动作，自然不需要托管。

### 鱼鱼谷 · 小岛（05a5c445）

| 模块 | 大小 | 作用 | 托管 |
|---|---:|---|---|
| `pets.js` | 31 KB | 入口路由：挂载小岛 / 修仙 / 擂台 / 游乐馆 | 入口，无动作 |
| `pet-isle.js` | 143 KB | 小岛主循环：种/收/浇/扩地/饲养/钓鱼/挖矿/炸矿/陷阱/每日目标/升级 | `planner.mjs` + `engine.mjs` ✅ |
| `pet-isle-ui.js` | 57 KB | 集市/背包/说明/菜单/仓库/纪事的滑出面板 | `planner.mjs`、`warehouse.mjs` ✅（`storyRead` 除外，见三） |
| `pet-isle-visit.js` | 10 KB | 串门、守家日志、拜访 | `social.mjs` ✅ |
| `pet-isle-fun.js` | 22 KB | 52弟玩具摊（剪刀石头布/抽牌/五子棋/盲盒）+ 鱼彩 | `npc.mjs` ✅；彩票 ❌ 见三 |
| `pet-isle-scratch.js` | 7 KB | 刮刮乐银色涂层 | ❌ 见三（返奖率 74%） |
| `pet-isle-food.js` | 5 KB | 食物面板与旅行口粮 | `planner.mjs`（`eat`/`coffee`）✅ |
| `pet-isle-rank.js` | 3 KB | 排行榜面板 | 只读 ✅ |
| `pet-isle-art.js` | 43 KB | 像素美术（运行时绘制） | 纯渲染 |
| `pet-arena.js` | 34 KB | 擂台回放：场景/打击停顿/连击/终结慢动作 | 渲染；协议在 `arena.mjs` ✅ |
| `pet-arena-ui.js` | 7 KB | 擂台面板 | 渲染 ✅ |
| `pet-battle.js` | 36 KB | 战斗界面与战报 | 渲染；决策在 `battle.mjs` ✅ |
| `pet-store.js` | 24 KB | 站宠存档、等级、每日经验上限 | 只读 ✅ |
| `pet-state.js` | 1 KB | 站宠状态默认值/校验 | 只读 |
| `pet-player.js` | 13 KB | 视频 / 序列帧 / Spine 播放器 | 纯渲染 |
| `pet-float.js` | 36 KB | 摸鱼小窗（页面右下角悬浮小岛） | 纯渲染 |
| `pet-fullscreen.js` | 1.5 KB | 全屏挂载 | 纯渲染 |
| `pet-whale-friends.js` | 1 KB | 鲸鱼好友按钮状态 | 只读 |
| `pet-refund.js` | 8 KB | 「一键回收」（2026-11-04 当天有效，已过期） | 无需 ✅ |
| `pet-world-rules.js` | 117 KB | **规则本体** | 直接 import ✅ |
| `isle-arcade.js` | 27 KB | 游乐馆：弹弹乐 / 鲸鱼桌球 / 鲸鱼保龄 | `arcade.mjs` ✅ |
| `arcade-rules.js` | 16 KB | **游乐馆规则** | 直接 import ✅ |
| `isle-warehouse.js` | 14 KB | 囤货仓库内景：货架/冷库/地面货位、行情、提醒、自动出售 | `warehouse.mjs` ✅（`whAlert`/`whOrder` 见三） |

### 大肥鱼修仙记（20b20a0e）

| 模块 | 大小 | 作用 | 托管 |
|---|---:|---|---|
| `xs/entry.js` | 1 KB | 从「星🐟谷」菜单进入修仙 | 入口 |
| `xs/game.js` | 33 KB | 场景、行走、NPC、对话、HUD、快捷栏、切图、灵药园 | `xian.mjs` ✅ |
| `xs/engine.js` | 6.6 KB | 引擎核心：循环、输入、相机、图集动画、格子地图与碰撞 | 纯渲染 |
| `xs/farm.js` | 3.4 KB | 灵药园田块绘制与动作特效 | 渲染；协议在 `xian.mjs` ✅ |
| `xs/alchemy.js` | 4.4 KB | 炼丹守火候小游戏 | `xian.mjs`（`brew` 直接结算）✅ |
| `xs/danmaku.js` | 40 KB | 弹幕斗法（纵版 STG，鼠标操作） | ❌ 手动专属，见三 |
| `xs/ui.js` | 8 KB | 对话框、HUD、快捷栏、背包格、浮字 | 纯渲染 |
| `xs/story.js` | 4.7 KB | 序章「商会来信」+ 测灵根 | ❌ 必须真人，见三 |
| `xs/content.js` | 4.6 KB | 人物与台词 | 只读 |
| `xs/content2.js` | 7.3 KB | 2.0 的 8 位新人物与台词 | 只读 |
| `xs/net.js` | 2.9 KB | 存档同步（2.2 秒合批 → `/api/pet/world/act`） | `world.act` ✅ |
| `xs/rules.js` | 43 KB | **修仙规则本体** | 直接 import ✅ |
| `xs/xs2.js` | 11 KB | 2.0（一）界面：人脉/机缘/宗门 | `xian2.mjs` ✅ |
| `xs/xs3.js` | 20 KB | 2.0（二）界面：配招/观气/对战/秘境 | `xian2.mjs` ✅（`peek` 见三） |

---

## 二、协议动作全清单

### 鱼鱼谷（规则里 `a === '...'` 的 35 个分支）

```
arcEnd arcStart bomb buy buyAnimal buyTrap clear coffee collect craft eat expand
feed fish goal guardRefund harvest lotto lottoClaim mine nightClaim npc pet
plant scratch sell sellAnimal stockBuy storyRead trap upgrade warehouse water
whAlert whOrder whUp
```

托管覆盖 **30 个**，未接 5 个（`lotto` / `scratch` / `storyRead` / `whAlert` / `whOrder`），
理由见第三节。

> 注：`whOrder` 是 b26Action 里的分支，写法是 `a!=='whUp'&&a!=='whOrder'&&a!=='whAlert'`，
> 所以用 `a ===` 扫不出来，已单独核对。

### 修仙（规则里 36 个）

```
ab break brew buy chap equip evpick evroll fight finish fuse gift harvest hoe
learn lose peek plant rbuy refill rgo rin rise root rout sell sit slots stipend
story talk task tasks use water win
```

托管覆盖 **31 个**，未接 5 个（`fight` / `lose` / `peek` / `root` / `story`），理由见第三节。
`win` 在代码里出现在战斗结果的判断（`r.fight?.w`），不是提交的动作。

---

## 三、未接的 10 项，逐条理由（都不是遗漏）

### 1. `lotto`（谷内大乐透）—— 数学上是负收益，接了就是亏钱

`LOTTO = {price:500, nums:30, pick:5, balls:10}`，单注 500 D 币。
按 `LOTTO_PRIZE` 全表精算（C(30,5)=142,506 种红球组合 × 10 种蓝球）：

| 中奖 | 组合数 | 概率 | 奖金 |
|---|---:|---:|---:|
| 5+1 | 1 | 0.00007% | 1,000,000 |
| 5 | 1 | 0.00070% | 100,000 |
| 4+1 | 125 | 0.00877% | 20,000 |
| 4 | 125 | 0.08772% | 3,000 |
| 3+1 | 3,000 | 0.21052% | 1,000 |
| 3 | 3,000 | 2.10517% | 300 |
| 2+1 | 23,000 | 1.61397% | 200 |

**单注期望 17.44 D，返奖率 3.49%。** 每买一注平均亏 482 D。
（公告 11-12 10:10 也已宣布站内欢彩停止售票，前端入口不再挂载。）

### 2. `scratch`（刮刮乐）

`SCRATCH_TABLE = [[1000,.00005],[50,.002],[10,.01],[5,.03],[2,.08],[1,.18]]`，
两档票价 1,000 / 10,000，**返奖率 74.0%**（每买一张平均亏 26%）。
同样是稳定负期望，不接。

### 3. `storyRead`（山谷纪事章节）

规则原文：`s.b12.chapters |= 1 << (chapter-1)`，返回 `{ok:true,msg:'已记入山谷纪事'}`。
**没有任何奖励**，只是把三篇剧情文本标记为已读（`B12_CHAPTERS`：重开海路 / 暖棚与仓灯 / 静潮公约）。
托管代读没有意义。

### 4. `whAlert`（仓库到价提醒）

仓库 2 级开放，最多 8 条。这是给「人」看的提醒；托管本来就在按市场预测算卖点，
不需要提醒自己。

### 5. `whOrder`（仓库到价自动出售）

仓库 3 级开放，**只在服务端管家巡视时触发**：`b26AutoSell` 是 `autoSettle` 里调用的
（`cache/rules-05a5c445.mjs:1149`），而 `autoSettle` 需要 `b12WarehouseMasks` 这个
WeakMap 里有当前存档——它只在 `b12WithAvailableInventory` 的 try 块内存在。
托管不启用管家，所以这条路径对我们永远是死代码。
（如果哪天要用管家做离线兜底，再补 `whOrder`，届时需要单独验证。）

### 6–8. `fight` / `lose` / `peek`（修仙手动弹幕斗法）

- `fight` 进入弹幕关，`win`/`lose` 是弹幕结束的回执动作——**只对手动弹幕有意义**；
- `peek` 是花 20 灵石「观气」提前看对手招式，只对手动弹幕有用；
- 托管走 `ab`（自动对战），种子由 `hseed(日, 对手, 当日第几场, 灵石, 修为)` 确定，
  本地 `sim` 预演能赢才提交，不需要观气。

**安全边界（硬约束）**：绝不提交 `xsFight` / `xsWin` / `xsLose`。

### 9–10. `root` / `story`（测灵根 + 序章剧情）

`xs/story.js` 的序章「商会来信」要求按顺序推进（`state.xs.st` 服务端校验），
测灵根（`root`）是一次性的、影响整个账号灵根走向的选择。
公告明确写了「测灵根、剧情要真人点」——托管在 `x.storyDone` 之前直接待命，
只在 GUI 上提示。这是**有意留白**，不是没实现。

---

## 四、本轮改掉的三个真实问题

### 1. 弹弹乐十连 0 分（BUG，已修，2026-11-13 17:5x）

日志证据：`17:43:29 – 17:44:27 弹弹乐：未计分 太快了，这局不计分` × 10。

根因：规则里 `MIN_PLAY` 判定的是 **服务端两次处理的时刻差**（`ctx.t - cur.t >= MIN_PLAY[g]`），
而客户端的 POST 有 2.15 秒串行节流（`core/http.mjs` `minGap`）。旧代码把本地计时起点取在
**发 arcStart 请求之前**，请求先在节流队列里排了 1–2 秒才发出去，于是「本地等了 5.8 秒」
到服务端只剩 4 秒 < MIN_PLAY(5) → 判「太快」，次数不退。

影响面：弹弹乐（5 秒）全灭；保龄（8 秒）随机失败约一半；桌球（6 秒）靠求解耗时侥幸通过。

修法（`core/arcade.mjs`）：
- 计时起点改到 **arcStart 回执到达之后**，余量 0.8 → 1.2 秒；
- 「太快了」并不清 `arc.cur`，所以失败后**重试 arcEnd**（最多 3 次），可以把这一局救回来；
- 仍然失败就 `break`，不再把剩余次数一轮烧光。

> 今天的 30 次已经全部消耗完了，明天 0 点重置后才会看到修复效果。

### 2. 秘境行商节点不会买药（策略缺口，已补）

`planRealm` 之前只考虑 `rgo`/`rout`，行商节点（`k:'shop'`）一律跳过。
回春散 25 灵石回一半血，多撑过一个战斗节点就值几十灵石和材料。
现在：气血 < 70% 且灵石够 25 时，把 `rbuy i=0` 也作为束搜索的候选。

### 3. GUI 落后于后端（已补）

`/api/status` 早就有 `xian2` / `arcade`，但界面只显示 1.0。已新增：
概览的仓库行、修仙页的「修仙 2.0」与「游乐馆」两张卡片、设置页的三组新开关；
`/api/status` 增加 `vault` 快照。`gui/manifest.json` 2.0.0 → 2.1.0。

---

## 五、分析文档索引

| 文档 | 内容 |
|---|---|
| `ANALYSIS.md` | 11-11 版存档（`4be1c2b4`），**按要求原样保留，不覆盖** |
| `ANALYSIS-05a5c445.md` | 本轮新版：采样、账号岛况、偷菜生态、行情、游乐馆、b26、修仙 2.0、收益杠杆 |
| `MODULES.md` | 21 节机制清单：时间日界、体力 DP、农田/牧场/钓鱼/挖矿/加工、市场三层成本、货船、每日目标、52弟、擂台、站宠、串门偷菜、b26、游乐馆、修仙 1.0/2.0、管家、长夜、税、接口总表 |
| `research/analysis-tables.md` | 数值表（作物/鱼/矿/加工/动物/等级），按 05a5c445 重算 |
| `AUDIT-05a5c445.md` | 本文档：模块 × 动作 × 覆盖的对照表 |

## 六、怎么验证这份审计不是空话

```bash
node scripts/selftest.mjs        # 81 项，含游乐馆三游戏本地重放 + 修仙2.0 多轮结算
node scripts/arc-selftest.mjs    # 三游戏求解并本地 replay 校验分数
node scripts/xian2-selftest.mjs  # 修仙2.0 连续多轮，每个动作本地结算都要成功
node yuyugu2.mjs --dry           # 演练：只打印计划不提交
```

再加两条对线上文件的**逐字节**核对（需要 cookie）：

```bash
curl -s --compressed -H "Cookie: $CK" https://52dmeme.com/pet-world-rules.js?v=05a5c445 -o /tmp/r.js
diff -q /tmp/r.js cache/rules-05a5c445.mjs            # 必须无输出
curl -s --compressed -H "Cookie: $CK" https://52dmeme.com/arcade-rules.js?v=05a5c445 -o /tmp/a.js
diff -q /tmp/a.js cache/arcade-05a5c445.mjs           # 必须无输出
curl -s --compressed -H "Cookie: $CK" https://52dmeme.com/xs/rules.js -o /tmp/x.js
diff -q /tmp/x.js cache/xsrules-20b20a0e.mjs          # 必须无输出
```

规则文件一致 = 本地预演与服务端结算逐字一致，这是整套托管「先算再提交」的前提。
