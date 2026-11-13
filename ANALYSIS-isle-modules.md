# 鱼鱼谷小岛前端模块分析（构建 05a5c445）

> 源码快照：`new4/`，9 个模块 + 纯美术模块 `pet-isle-art.js`。
> 线上 20 个前端文件与 3 份规则文件已逐字节核对（md5 相同）。
> `R` 指 `pet-world-rules.js`，`A` 指 `arcade-rules.js` 或 `pet-isle-art.js`（按导入别名，行内标注）。生成日期 2026-11-13。

## 0. 模块总表

| 文件 | 职责 | export 清单 |
|---|---|---|
| `pet-isle.js` | 小岛主场景、镜头、输入、渲染、操作队列、本地预测、服务端同步、串门、偷菜、守家对战演出、管家报告、HUD | `setSfx`（:31）、`sfx`（:32）、`mountIsle`（:91）；返回对象见 :1678-1684 |
| `pet-isle-ui.js` | 集市（卖货、行情、加工、货船、杂货、公库）、背包图鉴、说明、挂机管家配置、囤货列表、山谷纪事 | `sheet`（:25）、`openMarket`（:51）、`openBag`（:176）、`openGuide`（:229）、`openAuto`（:273）、`openWarehouse`（:325）、`openB12Journal`（:455） |
| `pet-isle-visit.js` | 玩家目录、搜索、留言板、守护对战日志与回放入口 | `openBoard`（:9）、`openGuardLog`（:25）、`openVisit`（:43） |
| `pet-isle-fun.js` | 52弟玩具摊（猜拳、抽牌、五子棋、盲盒）与鱼彩（刮刮乐、大乐透） | `openFun`（:44）、`openLotto`（:174） |
| `pet-isle-food.js` | 随身食物（吃作物、潮汐饭团、咖啡）与串门时的独立补给 | `openFood`（:5）、`openTravelFood`（:26） |
| `pet-isle-scratch.js` | 刮刮乐银色涂层与票面 UI | `attachScratchCoat`（:2）、`mountScratch`（:12） |
| `pet-isle-rank.js` | 山谷榜单（8 类玩法、日榜、总榜、分页） | `openLeaderboard`（:2） |
| `isle-arcade.js` | 全屏游乐馆（弹弹乐、鲸鱼桌球、鲸鱼保龄） | `openArcade`（:20） |
| `isle-warehouse.js` | b26 囤货仓库内景（货架、冷库、地面、行情、到价提醒、自动出售、升级） | `openWarehouseHall`（:23） |
| `pet-isle-art.js` | 纯像素美术：贴图常量、`bake*` 烘焙、`blit/iconUrl/spr`、内部 xorshift32 `rng` | `ANIMAL C CAT CROP CROP_WITHER ITEM_ROWS TILE TOOLS autoShade bakeAnvil bakeBarn bakeBoard bakeCave bakeDecor bakeDock bakeFence bakeGate bakeHouse bakeMine bakeStall bakeTerrain blit canvasIcon iconUrl itemIcon itemSpr mineRock rng setPackIcons soil spr whale`；**零网络调用** |

路由入口：地图点击 `warehouse`、`arcade` 分别触发 `onOpen('warehouse')`、`onOpen('arcade')`（`pet-isle.js:734-735`），外层 `pets.js:425-426` 动态加载 `openArcade`、`openWarehouseHall`；玩具摊、鱼彩在 `pets.js:424` 加载。仓库列表面板通过集市、背包、管家里的「囤货仓库」按钮打开 `pet-isle-ui.js` 的 `openWarehouse`（`pet-isle-ui.js:324`、:62、:215、:298）。

## 1. pet-isle.js（主场景与网络层）

### 1.1 职责

- 场景交互：点地块种/浇/收，点动物收/喂，点码头钓鱼，点矿洞挖矿，点猫猫摊主买卖（文件头注释 :3-6）。
- 所有操作先在本地预测并合并提交：「每批 ≤ 40 个动作、两次提交间隔 ≥ 2 秒；没有轮询；页面隐藏时停帧」（:6）。
- 网络层：`load()` 读 `/api/pet/world`（:99-104）；`flush()` 提交 `/api/pet/world/act`（:147-181）；`actNow()` 单动作等回执（:184-193）；`push()` 本地预检后入队（:127-141）。
- 串门/偷菜/守家：`vcall()`（:993-998）、`goVisit()`（:1037-1062）、`helpAll()`（:1014-1036）、`steal()`（:1113-1139）、`fieldFight()`（:1167-1225）。
- 对外能力：`manualWarehouse` getter/setter、`actNow`、`foodMenu`、`visit`、`state`、`coins`、`prices`、`day`、`season`、`weather`、`serverInv`、`push`、`flush`、`autoSave`、`now`、`busy`、`coinBurst`、`refresh`、`destroy`（:1678-1684）。

### 1.2 动作清单

通用返回约定：`/act` 返回 `{state, rev, coins, prices, now, out[], xp?, autoLog?, duplicate?}`；`out[i]` 为 `{ok, a, msg?, spend?, earn?, got?, tax?, ...}`（:173-176、:203-218）。`actNow` 用 `waiters` 按动作对象解析 `out`；`push` 用本地 `applyActions` 的预测结果立即反馈，服务端揭晓后由 `reveal()` 播放飘字（:184-219）。

- `plant`：`{a:'plant', i:number(0..plotN-1), c:string(作物id), includeWarehouse?:boolean}`。触发：点空地 :676-680、拖过一排 :1296-1298、批量补种 :633；先检查当季 :678。返回 `spend`。
- `water`：`{a:'water', i:number}`。触发：点需水地块 :686、批量浇水 :633。返回仅 `ok/msg`。
- `harvest`：`{a:'harvest', i:number}`。触发：点成熟地块 :685、批量收获 :646-657。返回 `got:[{id,q,n}]`，用于飞物品与新发现提示（:210-215）。
- `clear`：`{a:'clear', i:number}`。触发：点枯萎地块 :684、批量清理 :633。
- `expand`：`{a:'expand', k:'plot'|'barn'}`。触发：开垦锁定地块 :719-721、扩建畜栏 :778。返回 `spend`。
- `buyTrap`：`{a:'buyTrap'}`。触发：码头空蟹笼位 :725。
- `collect`：`{a:'collect', i:number}`。触发：点可收动物 :750、批量收产物 :635-636。返回 `got[]`。
- `buy`：`{a:'buy', id:'feed'|'bait'|'bomb'|守家/偷菜道具id, n:number}`。触发：动物饿了自动买 10 份饲料 :753；鱼饵快捷栏 :975；集市杂货 `pet-isle-ui.js:156-166`。`n` 取 1/5/10/30。
- `feed`：`{a:'feed', i:number, includeWarehouse?:boolean}`。触发：点动物且距上次喂食 ≥ 8 小时 :752-754、批量喂食 :636。
- `pet`：`{a:'pet', i:number}`。触发：点动物且当日未摸 :756。每只每天一次。
- `sellAnimal`：`{a:'sellAnimal', i:number}`。触发：动物气泡「卖掉」二次确认 :762-766；回收价为基础价 40%。
- `buyAnimal`：`{a:'buyAnimal', k:string(动物id)}`。触发：畜栏菜单 :770-777。
- `trap`：`{a:'trap', i:number}`。触发：点蟹笼有货 :783-788；返回 `got[]`。
- `goal`：`{a:'goal', k:number(0..4)}`。触发：公告栏单个/全部领取 :795-804。返回 `earn/got/pet`。
- `upgrade`：`{a:'upgrade', k:'house'|'rod'|'pick'|'spr'}`。触发：小屋 :821、铁匠铺 :827。
- `fish`：`{a:'fish', bait:boolean, includeWarehouse?:boolean}`。触发：钓鱼感叹号时点击 :865-873；`bait` 表示是否消耗鱼饵（:870）。返回 `got:[{id,q,n}]`。
- `mine`：`{a:'mine', f:number(矿洞层数)}`。触发：敲碎石头 :907-923；`f` 为 `cave.floor`。
- `bomb`：`{a:'bomb', f:number, includeWarehouse?:boolean}`。触发：矿洞快捷栏炸药 :931-949；规则侧每次 6–8 块矿，可能升级梯子（R:780-790）。
- `eat`/`coffee` 由 `pet-isle-food.js` 构造后经 `isle.actNow` 提交（见 §5）。
- `sell`/`craft`/`warehouse`/`whAlert`/`whOrder`/`whUp`/`stockBuy`/`guardRefund`/`nightClaim`/`storyRead` 由 UI/仓库/纪事构造，见后续小节。

串门相关（独立接口，不是 `/act` 的 `a`）：

- 偷菜：`POST /api/pet/world/visit/:id`，body `{operation:uuid, kind:'all', i:0}`；触发「一键偷光」:1083-1088 或点带「偷」标记的地块/窝 :1103-1107；结果用于结算卡 `stealCard()`（:1141-1161），字段 `result.outcome`、`item`、`n`、`items[]`、`spots`、`fine`、`energy`、`xp`，以及可选 `battle`（:1119-1137）。
- 帮忙：`POST /api/pet/world/help/:id`，body `{operation:uuid}`；触发「一键帮忙」:1014-1018；返回 `r.result`（`done{water,clear,feed}`、`coins`、`xp`、`affGain`、`aff`、`lv`、`lvUp`、`energy`、`owner`）、`r.isle`、`r.help`、`r.energy`、`r.state`（:1019-1028）。
- 进入/刷新串门：`GET /api/pet/world/visit/:id`；触发 `goVisit()` :1045、`refreshVisit()` :1163；返回 `d`（`state`、`owner`、`energy`、`help`、`isle`、`rules`），用于 `visit.d`、守家鱼与偷菜目标（:1050-1054、:1076-1081、:1103-1110）。

### 1.3 HTTP 接口（本文件）

- `GET /api/pet/world`：无 query/body；加载自己的小岛（:100）。`accept()` 读 `state/rev/coins/prices/now/clockStart`（:105-110）。
- `POST /api/pet/world/act`：body `{rev:number, operation:uuid, actions:Array<action>}`；`actions` 最多 `R.WORLD.maxActions=40`，整体 JSON 限制 3900 字节（:129、:187）；`keepalive:true`；最多重试 3 次；429 按 `retry` 秒退避，409 用返回的 `state/rev` 同步并撤回未确认操作，其他 4xx 丢弃该批并提示（:154-169）。
- `POST /api/pet/world/welcome`：body `{operation:uuid}`；领新人礼（:446）；响应 `j.ok/j.gift` 与最新 `state/rev/coins`（:448-450）。
- `POST /api/pet/world/auto`：body `{rev:number, operation:uuid, config:object}`；保存/结算管家（:460）；响应 `j.autoLog`（:466）。
- `GET/POST /api/pet/world/:path`（`vcall`，:993-998）：`GET visit/:id`、`POST visit/:id`（偷菜）、`POST help/:id`（帮忙）。POST 统一 `content-type: application/json`，GET 只带 `credentials:'same-origin'`。
- 静态资源（非业务 API）：`/pets/dsh/isle/pack/isle-pack.json?v=984fcf37a667`、`isle-pack.webp`（:251）、`/pets/dsh/isle/whale.json?v=1`（:310）、`guard.json?v=1`（:1239）、`whale.webp?v=1`（:244）；只影响贴图动画，失败可降级。

### 1.4 前端读取、依赖的 state 字段

`state` 来自顶层响应 `j.state`，另有顶层 `rev/coins/prices/now`（:105-110）。本地视图 `local()` 把待提交 `queue` 叠加到 `srv` 上，随机结果固定 `rand:()=>0.5`，每 20 秒重算体力回复与作物阶段（:115-121）。

- `state.plots[]`：空地为 `null`，作物为 `{c:作物id, t:种植时刻, w:浇水次数, g:加速秒, h:已收茬次, sv?:被偷记录}`；前端读 `p.c/p.w/p.h`（:687、:1361-1373）。
- `state.plotN`：已开垦地块数（:284、:601、:719-721）。
- `state.barn[]`：动物 `{k:种类, f:上次喂食, p:产出游标, m:心情, born:出生, held[], heldAt}`；前端读 `pen.k/f/m`（:744-757）。
- `state.barnN`：畜栏格数（:772-778）。
- `state.traps[]`：蟹笼 `{p:投入时刻}`；前端读 `s.traps.length` 与 `R.trapReady`（:603、:783-788）。
- `state.mine.max`：已解锁最深矿层（:892、:927-928）。
- `state.tools.{rod,pick,spr,house}`：工具等级（:821-832、:892）。
- `state.inv`：`{物品id: [普通,银星,金星]}`（:752-754、:870、:975；`pet-isle-ui.js:190`）。
- `state.en`、`state.enT`：体力与体力计时起点（:1318-1324）。
- `state.cnt`：按日计数器；读 `cnt.pet{i}`（:756）、`cnt.coffee`（`pet-isle-food.js:19`）、`cnt.craft`（`pet-isle-ui.js:139`）、`cnt.npc`（`pet-isle-fun.js:47`）、`cnt.gomokuPaid`（:87）、`cnt.goal{k}`（:791-804）。
- `state.seen[]`：图鉴已发现物品（`pet-isle-ui.js:181-187`）。
- `state.earn.amt`：本岛日累计卖出金额（`pet-isle-ui.js:223`）。
- `state.auto`、`state.autoLog`：管家开关、下次巡视、上次报告（`pet-isle-ui.js:274`、:288-318；`pet-isle.js:472-490`）。
- `state.b26.lv`：仓库等级；主场景据此切换仓库外观贴图（:401）。
- `state.gift`：是否已领新人礼（:440）。
- `state.b12`：长夜时钟、仓库预留、纪事等（:106、:813；详见 §2、§9）。

### 1.5 数值常量（原文照抄）

- 地图：`const W = 44, H = 30`（:47）；农田 `cols: 8, rows: 3, gap: 18`；码头 `len: 9`；仓库/游乐馆/榜单建筑坐标（:49-60）；蟹笼位 `TRAP_POS = [[586,222],[626,222],[586,276],[626,276]]`（:62）。
- 队列：「每批 ≤ 40 个动作、两次提交间隔 ≥ 2 秒」（:6）；请求体上限 `3900` 字节（:129、:187）；收获/收产物/蟹笼/钓鱼/挖矿用 `0.4` 秒延迟，其余 `3.5` 秒（:138）。
- 重试超时：`for (let tries = 0; tries < 3; tries++)`（:154）；429 等待 `(j.retry || 2) * 1000 + 200` 毫秒（:157）；`actNow` 20 秒未确认即拒绝（:191）。
- 本地视图重算周期：`Math.floor(now() / 20)`（:116）。
- 新人礼：`R.WELCOME_GIFT = 1000000`（:439、:497；R:148）。

### 1.6 自动、后台行为

- **没有轮询**：文件头明确（:6）；只有 `flushTimer`、`requestAnimationFrame` 渲染循环和 `visibilitychange`。
- 自动提交：`push`、`actNow` 调 `schedule()`，`flush()` 按 `minGap` 合并提交（:127-181）。
- 页面隐藏：取消 RAF，有队列则 `beacon()` 立即 `flush()`；`pagehide` 也 beacon（:1661-1665）。
- 跨岛日：HUD 发现 `R.isleDay(now()) !== day` 且空闲时重新 `load()` 拉当天价格与天气（:1334）。
- 管家：挂载时若 `R.autoDue(srv, now())`，400ms 后自动 `autoPost()` 补算并显示报告（:1671、:455-490）。
- 好友事件：监听 `pet-friend-check` 标记忙碌、`pet-friend-saved` 接受更高 rev 的状态（:1663）。
- 场景动画（动物闲逛、天气、夜间、鱼跃、粒子）均为本地帧循环，不请求服务端（:1580-1659）。

## 2. pet-isle-ui.js（集市、背包、说明、管家、囤货列表、纪事）

### 2.1 动作清单

- `sell`：`{a:'sell', id:string, q:0|1|2, n:number(1..999), includeWarehouse:boolean}`。由 `b12SaleActions()` 生成，按 `n` 每 999 个拆一条（:416-418）；触发：集市「一键全卖」:68、涨幅区间卖出 :100、单品质卖出 :117、仓库列表「卖出高价存货」:386-395；并发按 24 条一批 `Promise.allSettled`（:421、:431）。返回 `earn/tax` 累加并 `coinBurst`（:431-433）。
- `craft`：`{a:'craft', id:string, n:number(1..20), includeWarehouse:boolean}`；触发加工页按钮 :150；前端显示单次最多 20 份、每天 80 份（:139-145；R:173）。
- `buy`：`{a:'buy', id:'feed'|'bait'|'bomb'|'guard1'..'guard4'|'cloak'|'whistle'|'sack', n?:number}`；触发集市杂货 :156-166；饲料/鱼饵/炸药 n 为 10/30、1/5；守家、偷菜道具不带 n（默认 1）。
- `coffee`：`{a:'coffee'}`；触发咖啡按钮 :167。
- `guardRefund`：`{a:'guardRefund'}`；触发旧守家道具补偿按钮 :162；返回 `earn/refund/msg`，成功后 `draw('shop')`。
- `stockBuy`：`{a:'stockBuy', id:string, n:number, day:string}`；触发货船「买 n」:409-411；`day` 为 `R.isleDay(t)`；服务端校验当日货单与个人额度（R:1551-1560）。
- `warehouse`（列表面板）：`{a:'warehouse', id:string, q:0|1|2, n:number(0..inv[id][q]), keep?:boolean}`；触发保存、卖出后回写 :383、:394；服务端校验 b26 容量与每格上限，并维护 `b12.vault/keep`（R:1234-1245、:1516-1520）。
- `nightClaim`：`{a:'nightClaim', key:string}`；触发山谷纪事「领取夜潮小礼」:461。
- `storyRead`：`{a:'storyRead', chapter:number(1..3)}`；触发「标记本章已读」:462。

### 2.2 HTTP 接口

- `GET /api/pet/world/tax`：`credentials:'same-origin'`、`cache:'no-store'`；读公库账目（:442）。响应 `season/day`、`current{sales,balance_tax,allocated,paid,recipients,phase}`、`treasury{balance,reserved}`、`mine{amount,first_at,second_at}`、`history[{kind,delta,created_at}]`（:443-450）。
- 其余写操作都经 `isle.actNow`/`isle.push`，最终落到 `/api/pet/world/act`。

### 2.3 state 字段

- 集市：`isle.state`、`isle.prices`、`isle.day`、`isle.coins`（:59-64）；`s.inv`、`s.earn.amt`（:223）。
- 背包：`s.inv`、`s.seen`、`s.tools`、`s.plotN/barnN/traps.length/mine.max`、`s.cnt`（:181-224）。
- 管家：`s.auto` 与 `R.AUTO_DEFAULT` 合并（:274），保存字段见 :292；`s.auto.t`（:299）；`s.autoLog`（:288、:316）。
- 囤货列表：`s.inv`、`s.b12.vault`、`s.b12.keep`（:332-335）；`isle.prices`、`R.BASE_PRICE`、`R.QUALITY`（:330-331）；`isle.manualWarehouse`（:397）。
- 公库：`isle.now()`；`openB12Journal` 用 `s.b12.chapters`、`R.B12_CHAPTERS`、`R.b12NightView(s, isle.now())`（:458-462）。

### 2.4 数值常量（原文照抄）

- 走势：14 天（前 13 天本地算，今天用服务端价）（:37-38）。
- 集市说明：价格每累计 4 小时白昼变动，22:00–08:00 长夜暂停；作物阶梯「前 150 个全价，151 到 400 个 85%，之后 70%」；供需最多便宜 20%（:137）。
- 加工：每次 1 体力、每岛日上限 `R.WORLD.daily.craft`（80）、单次最多 20 份（:139-145）。
- 卖货拆单：每条最多 999 个（:417）；本地预览与实际卖出均 24 条一批（:421、:431）。
- 囤货列表保存：每批 20 条并发（:383）；「卖出高价存货」20 条并发（:391）。
- 管家表单：`fishPct` 0–100 步长 10；`minPct` 0–150 步长 10；`keep` 0–300 步长 10；`budget` 0–`R.AUTO.budgetMax` 步长 10000；`guard` 0–4（:280-284）。默认值来自 `R.AUTO_DEFAULT`（:274）。
- 公库规则原文：钱包前 300 万免税；300 万到 1000 万售卖税 1%，超过 1000 万 3%；余额税 08:00 结算，300 万到 1000 万 0.1%，超过 1000 万 0.3%；可分配税池 80% 按缺口分配、每人每季最多 100 万、第 11、12 岛日各发一半（:448）。
- 仓库列表价格：`Math.round(prices[id] * R.QUALITY[q])`，`base` 同法（:330-331）；低价/高价标记按现价与基础价比较（:342-347）。

### 2.5 自动化

- `settle()`：先 `isle.flush()`，再最多 40×150ms（约 6 秒）等 `isle.busy()` 结束（:49）。
- 公库读取 `queueMicrotask(read)`，无轮询（:452）。
- 管家保存 `await isle.autoSave(cfg)` 后关闭面板（:289-296）；不自行定时。
- 无自动刷新榜单和行情；均为打开或点击时读取。

## 3. pet-isle-visit.js（留言板、守护日志、串门目录）

### 3.1 HTTP 接口、动作

- `GET /api/pet/world/board/:id`：读留言板；响应 `d.owner.name`、`d.messages[]`（:8、:20）。
- `POST /api/pet/world/board/:id`：`{operation:uuid, text:string}` 发表留言；`text` 去空白后 1–200 字（:21）；或 `{operation:uuid, remove:messageId}` 删除自己的留言，需二次点击（:17）。
- `GET /api/pet/world/guard-log`（可选 `?cursor=`）：分页读自己参与的守护战报（:30）；响应 `d.battles[]`（`{id,attacker_id,attacker,defender,winner,created_at}`）与 `d.nextCursor`；`winner===-1` 平局，`winner===0` 为攻击方胜，前端用 `(b.winner===0)===mine` 判断胜负（:30）。
- `GET /api/pet/battle/:id`：读完整战报，交给 `pet-arena.js` 的 `createArena` 回放（:34-37）。
- `GET /api/pet/world/neighbors?limit=20&q=&stealable=1&cursor=`：玩家目录；`markedOnly` 时路径改 `/neighbors/marked`（:50）。响应 `d.neighbors[]`（`{id,name,level,newbie,plots,pens,active,marked}`）、`d.visits[]`（`{t,n,w,b}`）、`d.nextCursor`（:51-53）。
- `POST /api/pet/world/favorite/:id`：body `{active:boolean}`；由 `whaleMark` 组件的 `request` 调用（:51）。
- 本文件不构造 `/act` 动作。

### 3.2 前端依赖字段

- `user?.id` 用于判断守护战「我」是攻方还是守方（:30）；`openBoard` 的 `m.canRemove/m.id`（:17-18）。
- `d.neighbors` 的 `newbie/plots/pens/active/marked` 用于列表文案与筛选（:51-52）；`d.visits` 的 `w` 值 `help|win|lose|draw` 映射为来帮忙、偷取成功、被守护鱼打跑、守护战打平（:53）。
- `battle` 对象传给 `createArena`（:34-37）。

### 3.3 数值、限制

- 留言框 `rows:3, maxlength:400`，业务校验 1–200 字（:13、:21）；保留最近 20 条、每分钟可发一条（:20）。
- 目录、守护日志每页 `limit=20`（:50、:30）。
- 新手保护：新账号创建后 24 小时偷菜保护，产物另有成熟保护（:56）。

### 3.4 自动化

- 打开即 `load()`；「刷新留言」「加载更多小岛」「加载更多」均手动（:22-23、:29-30、:46）。
- 无定时器与轮询；回放是动态 `import('/pet-arena.js?v=05a5c445')`（:35）。

## 4. pet-isle-fun.js（52弟玩具摊与鱼彩）

### 4.1 动作清单

`send()` 统一用 `isle.actNow(action)`，出错 toast 并返回 `null`（:48、:177）。

- `npc` 猜拳：`{a:'npc', g:'rps', m:0|1|2}`（0 石头、1 剪刀、2 布）；触发三个手势按钮 :62-65；响应 `o.npc`（0–2）、`o.res`、`o.earn/got/jackpot`（:66；`prizeView()` :27-36）。
- `npc` 抽牌：`{a:'npc', g:'card'}`；触发「抽牌」:75-78；响应 `o.me`、`o.np`（1–13）、`o.suit:[number,number]`（0–3）、`o.res`（:79-82）。
- `npc` 五子棋开局：`{a:'npc', g:'gomoku', k:'start', d:1|2|3}`；触发难度按钮 :93-100；响应 `o.seed`、`o.practice`（:101）。
- `npc` 五子棋结算：`{a:'npc', g:'gomoku', k:'end', mv:Array<[x,y]>}`；触发五连或和棋 :120-132；`mv` 是玩家落子序列；响应 `o.res`、`o.practice`、奖励字段（:122-125）。
- `npc` 盲盒开局：`{a:'npc', g:'box', k:'start'}`；触发进入盲盒 :151；服务端在 `s.npcG` 保存盒局。
- `npc` 盲盒开一个：`{a:'npc', g:'box', k:'pick', i:0..8}`；触发点盒子 :156-158；响应 `o.mine`、`o.theirs`、`o.j`，第三轮还有 `o.res`、`o.sa`、`o.sb`（:159-162）。
- `lotto` 买一注：`{a:'lotto', n:[5 个不重复红球 1..30], b:1..10}`；触发「买一注」:191-194；响应 `o.d`。
- `lottoClaim` 兑奖：`{a:'lottoClaim'}`；触发「兑奖（N 注已开奖）」:197；响应 `o.tickets[]`、`o.earn`。
- `scratch`：由 `mountScratch` 的 `send` 发出，`{a:'scratch', k:0|1, n:1|10}`（`pet-isle-scratch.js:15`）；响应 `tickets[{mult,earn,jackpot?}]`、`spend`。

每日限制、练习局：`left() = max(0, 52 - cnt.npc)`（:47）；五子棋计奖局 `paidLeft() = max(0, 10 - cnt.gomokuPaid)`（:87），计奖局用完仍可开练习局（:89-96）；猜拳/抽牌/盲盒平局不计次数（R:796）。

盲盒规则：9 个盒子轮流开、双方各 3 个、比总分（:52、:153-165）；分值池 `R.BOX_SET`（:154）。

五子棋：15 路（`R.GOMOKU_N`），玩家执黑先手；前端用 `R.gomokuLine` 判五连、`R.gomokuAI` 落白棋（:87、:119、:132-137）；服务端按 `seed+mv` 重放判定（R:805-813）。

### 4.2 HTTP 接口

- `GET /api/pet/world/lotto`：读开奖信息；响应 `info.next`（下一期时间戳）、`info.last[]`（`{d,n[],b}`）（`pet-isle-fun.js:185`、:201-205）。
- 其余全部经 `isle.actNow` 到 `POST /api/pet/world/act`。

### 4.3 state 字段

- `isle.state.cnt.npc`：今日 52弟已消耗局数（:47）。
- `isle.state.cnt.gomokuPaid`：今日已计奖五子棋局数（:87）。
- `isle.state.scratchLast`：`{t,k,n,spend,earn,tickets[{mult,earn,jackpot?}]}`（`pet-isle-scratch.js:15`、:27）。
- `isle.state.lotto[]`：`{d:期号, n:[红球], b:蓝球}`（:195-198）。
- `isle.state.lottoLog[]`：`{d,key,coins}` 最近中奖（:199）。

### 4.4 数值常量（原文照抄）

- `R.NPC.daily` 文案「每天 52 局（平局不算），0 点刷新」（:54）；实际 `NPC = { daily: 52, jackpot: 0.001, jackpotCoins: 1000000 }`（R:301）。
- 五子棋：15×15、三档「简单/普通/困难」倍率 `0.8/1.2/1.5`；每天前 `10` 局计奖励（:52、:54、:87；R:304-306）。
- 盲盒：9 个盒子、各开 3 个；分值池 `[50,30,20,10,5,0,-10,-20,-30]`（:52、:153-165；R:303）。
- 鱼彩：刮刮乐不限次数、可买 1 或 10 张、最高为票价 1000 倍（`pet-isle-scratch.js:13`）；票价 1000、10000（R:427）；大乐透 `price 500`、最多持有 30 注、红球 30 选 5、蓝球 10 选 1（R:430）；奖级 5+1 1000000、5 100000、4+1 20000、4 3000、3+1 1000、3 300、2+1 200（R:431）；每岛日开一次（:203）。

### 4.5 自动化

- 无轮询与定时器；只有动画 `sleep()`、confetti 和开奖信息一次性读取（:20、:185）。开奖倒计时由 `info.next` 在打开时计算（:201-203）。

## 5. pet-isle-food.js（随身食物、串门补给）

### 5.1 动作清单

- `eat`：`{a:'eat', id:string, q:0|1|2, includeWarehouse:boolean}`；触发每种食物「吃一份」:18；恢复量前端展示 `c.eat*R.QUALITY[q]`；服务端校验库存、满体力回滚、潮汐饭团每天最多 2 份（:18；R:1326、:1562-1568）。
- `coffee`：`{a:'coffee'}`；触发咖啡按钮 :19；价格 15000、+60 体力、每日 3 杯（R:22-24）。
- 食物来源：`R.CROPS` 加合成项 `{id:'tide_snack', name:'潮汐饭团', eat:20}`（:12）；`includeWarehouse=false` 时用 `R.b12Available(s,id,q)`（扣除仓库预留），`true` 时用背包总量（:12-14）。
- 串门补给：`openTravelFood` 先 `GET /api/pet/world` 同步自己的 `state/rev/coins`（:28-30），再 `POST /api/pet/world/act`，body `{rev:world.rev, operation:crypto.randomUUID(), actions:[action]}`（:32）；最多 3 次，409 用 `e.data.state` 同步，5xx/429 退避重试，失败最后再 GET 同步（:33）。

### 5.2 state、数值

- `state.en`、`state.inv`、`state.cnt.coffee`、`state.cnt.tide_snack`、`state.b12.vault/keep`（经 `R.b12Available`）、`isle.coins`（:12、:18-19）。
- 食物恢复 `c.eat * QUALITY[q]`；潮汐饭团 +20（:12；`R.B12_SNACK.energy=20` 于 R:1326）；咖啡 +60（R:24）；自然恢复每 `R.WORLD.regen/60` 分钟 1 点（:21，regen 180 秒即 3 分钟，R:11-25）。

### 5.3 自动化

- `uncertain` 时每 500ms 轮询 `isle.busy()`，直到不忙再提示「体力状态已同步」（:9）；关闭面板时清定时器（:8）。
- `busy/uncertain` 时禁用吃和买按钮，避免重复消费（:15-16）。

## 6. pet-isle-scratch.js（刮刮乐涂层与票面）

- `scratch`：`{a:'scratch', k:0|1, n:1|10}`；`k=0` 小鱼刮刮乐（1000/张）、`k=1` 金鲸刮刮乐（10000/张）（:16；R:427）；触发「买 1 张 / 买 10 张」:16；「刮刮乐不限次数」（:13）。
- 服务端返回 `result.tickets[{mult,earn,jackpot?}]`、`result.spend`，单张时兼容 `result.mult/result.earn`（:15）；`batch.t` 为购买时间（:15、:27）。
- `last`（即 `state.scratchLast`）存在且 `R.SCRATCH[last.k]` 且票数为 1 或 10 时直接复用，不扣款（:27）。
- 涂层网格 `radius=18`、`cell=10`（:4）；刮开面积 `count/(cols*rows) > .55` 即揭晓（:7）；`devicePixelRatio` 有上限（:10）。中奖阈值 `mult>=50` 触发大 confetti（:25）。
- 无 HTTP 请求；`send` 由 `openLotto` 注入（:12、:15）。无定时器，仅 rAF。

## 7. pet-isle-rank.js（山谷榜单）

- `GET /api/pet/world/rank/:kind/:period?limit=20&cursor=...`：`kind` 取 `battle|steal|help|earn|balance|bounce|pool|bowl`，`period` 取 `day|total`；`limit=20`（:3-5）。
- 响应 `d.rows[]`（`{id,name,mine,place,wins,losses,draws,value}`）、`d.nextCursor`、`d.total`、`d.day`、`d.mine{...}`、`d.notice`（:5）。
- `balance` 类型隐藏日榜/总榜切换（:4），但请求仍带 `period`。
- 列：名次、玩家，`battle` 显示「胜/负/平」，`earn|balance` 显示 D币，其余显示成功次数（:5）。
- 每页 20，游标「加载更多」，刷新按钮；同 id 去重（:3-5）。文案「榜单最多延迟60秒更新」（:5）。
- 无 state 依赖、无写操作、无自动轮询。

## 8. isle-arcade.js（游乐馆）

### 8.1 动作清单

- `arcStart`：`{a:'arcStart', g:'bounce'|'pool'|'bowl'}`；触发大厅「全屏开始（用 1 次）」:38，实际 `await isle.flush()` 后 `isle.actNow({a:'arcStart',g})`（:60）；响应 `r.seed`、`r.left`，前端 `A.setup(g, r.seed)` 建局（:62）；**服务端在 `arcStart` 时就把当日次数加 1**（A:130-139）。
- `arcEnd`：`{a:'arcEnd', g, shots:Array<shot>}`；触发 `A.over(w)` 后 `finish()`（:114-116）；响应 `o.score/best/newBest/newDay/left`（:116-119）。
- `shots` 格式：
  - `bounce` 每条 `[x,y,vx,vy]`（4 个 number）；前端从拖拽最后约 100ms 采样速度并夹到 `A.FLING.maxSpeed`（:84-86），规则侧 `A.shoot` 量化为 0.001 并 push 该 4 元组（A:43-50）；服务端 `validShot` 要求长度 4 且 `|vx|,|vy|<=2400`（A:43）。
  - `pool`、`bowl` 每条 `[angle,power,spin?]`；前端 `release()` 用 `[Math.atan2(dy,dx), Math.min(1,d/220), spin]`（:87-88），规则侧 push `[a,p,spin]`（A:51-56）；服务端要求 `|angle|<=7`、`power 0..1`、`|spin|<=1`（A:43）。
- 服务端按 `seed+shots` 重放整局给分（A:130-149）；本地分与服务端不同时 toast「以服务器复算为准：N 分」（:119）。

### 8.2 榜单、每日次数、最短用时

- 每日次数：三个游戏各 `daily:10`（A:4-7）；大厅显示「今日剩余 left / 10」并在 `left<=0` 时禁用（:33-38）。**服务端在 `arcStart` 消耗次数，`arcEnd` 不再消耗；中途退出次数已用**（:47）。
- 今日最高、个人纪录：读 `state.arc.db[g]` 与 `state.arc.best[g]`（:37）。
- 榜单：每个游戏卡内 `GET /api/pet/world/rank/:g/:period?limit=5`（:30-35）；服务端同时把成绩写入 `state.b9Rank.daily/total`（A:147-148）。
- **MIN_PLAY 的前端表现**：本模块里没有 MIN_PLAY 或最短用时提示。它只在服务端 `MIN_PLAY={bounce:5,pool:6,bowl:8}`（A:130）校验；不足该秒数提交 `arcEnd` 返回「太快了，这局不计分」，前端只是显示在「结算失败」结果面板（:120）。玩家中途退出另提示「这局没打完，不计分（次数已用）」（:47），这是「未完成」提示，不是 MIN_PLAY 倒计时。

### 8.3 state、常量

- `state.arc` 由服务端维护为 `{v,d,n,best,db,cur,plays}`（A:134-135）。前端读 `x.d`（不等于 `isle.day` 时回退为 `{n:{},best:x?.best||{},db:{}}`，:29）、`x.n[g]`（:33）、`x.db[g]`（:37）、`x.best[g]`（:37）；`cur/plays/v` 仅服务端用。
- 场地：弹弹乐 `1280×720`，桌球/保龄 `540×960`（:66）；快进 4 倍（:124）。
- 服务端：`GAMES` 三项各 `daily:10`，`shots: bounce 5 / pool 6 / bowl 10`（A:4-7）；`MIN_PLAY={bounce:5,pool:6,bowl:8}`（A:130）；有效场地范围 `w 320..2560, h 320..1600`（A:131）。
- 资源：`AV='?v=d69c0fb5'`，`IMGS={faces,boxes,fx,sec,pf,p1..p3}`（:12-13）；art 注释「站长 2026-11-13 出图」（:11）。

### 8.4 自动化

- 只有游戏 RAF 循环与动画；无轮询。打开大厅时每个游戏卡读一次榜单（:30-35），切日榜/总榜时重读。
- Esc 先停游戏再关面板（:25-26）；`stop()` 取消 RAF、销毁双视频、退出全屏并回大厅（:46-47）。

## 9. isle-warehouse.js（b26 囤货仓库，重点）

### 9.1 动作清单（完整字段）

`send(acts)` 对每个动作依次 `await isle.actNow(a)`，返回最后一个结果（:34）。

- `warehouse`：`{a:'warehouse', id:string, q:0|1|2, n:number(0..inv[id][q]), keep:boolean}`。触发：编辑器「保存」仅在 `n!==vault[id][q]` 或 `keep` 变化时生成（:89）；「全部取出」对每个有库存品质发 `{a:'warehouse',id,q,n:0,keep:false}`（:93）；列表面板另有不带 `keep` 的卖出后同步（`pet-isle-ui.js:394`）。
  服务端校验：已知物品、q 0..2、n 0..inv[q]、b26 格数与每格上限；`n=0` 会删除该 `id:q` 的自动出售订单；`keep` 为 boolean 时同步 `b12.keep[id][q]`（R:1234-1245、:1516-1520）。返回 `{ok,id,q,n,msg}`（R:1244）。
- `whAlert`：`{a:'whAlert', id:string, price:number(0..1000000000)}`。触发：仓库 2 级编辑器「提醒价」保存且值变化（:90、:81-82）；`price=0` 取消提醒；需 Lv≥2，条数上限见 9.4（R:1527-1530）。
- `whOrder`：`{a:'whOrder', id:string, q:0|1|2, price:number(0..1000000000), n:number(1..B26.unit[3]=2400)}`。触发：3 级编辑器「到价自动出售」保存（:91、:83-84）；`price=0` 取消；需 Lv≥3；同品质设置订单会清空 `b12.keep[id][q]`（R:1531-1536）。
- `whUp`：`{a:'whUp'}`。触发：等级 <4 时「升级」按钮、锁定货位、升级弹窗（:41、:45、:95-98）；服务端按 `B26.cost[d.lv]` 扣费并升级（R:1526）；返回 `{spend,lv,msg}`。
- 到价提醒、自动出售本身没有「确认出售」动作，**自动出售由管家巡视在服务端执行**（:53；R:1538-1544）。

### 9.2 与 b12.vault、b12.keep 的交互

- `vault` 是 `inv` 的「预留子集」，不是额外库存；`vault[id]=[q0,q1,q2]` 表示该品质被仓库预留的数量，`warehouse` 动作只是调整预留值（R:1229-1245）。
- `keep` 是「自动补足目标」；编辑器「自动补足」勾选框写入 `keep`（:76、:89）；管家每轮卖货前 `b12ReplenishWarehouse` 把仓库补到目标（调用点 R:1148）。
- 设置 `whOrder` 会关闭同 `id:q` 的自动补足（R:1535，UI 文案 :84）。
- 自动出售从 `vault` 扣减并把货放回 `inv` 再卖，因而仍受售卖税与价格规则（R:1538-1544、:1644-1653）；售出记录写 `b26.sold`，最多 20 条，每条 `[day,id,q,amt,price]`（R:1514、:1543-1544）。
- 集市/加工/吃东西可勾选「包含仓库」，此时服务端临时揭示预留库存供本次操作使用，再恢复账本（`pet-isle-ui.js:62`、:64；`pet-isle-food.js:12-14`；R:1249-1268）。
- 列表面板「本次游玩手动种植、喂养、钓鱼和炸矿可用仓库」写 `isle.setManualWarehouse`（`pet-isle-ui.js:397-402`）；主场景 `b12PrepareManual` 仅对 `plant/feed/fish/bomb` 自动加 `includeWarehouse`（`pet-isle.js:124-126`）。
- 「卖出高价存货」流程：先 quote（含税），再以 `includeWarehouse:true` 卖出，最后把 vault 数量同步扣掉（`pet-isle-ui.js:386-395`）。

### 9.3 等级、格数、单价、升级价

`B26` 原文（R:1506-1507）：

```text
cost:[0,80000,300000,1000000]
slots:[12,18,22,30]
unit:[300,600,1200,2400]
alerts:[0,8,16,24]
orders:[0,0,8,16]
perks:
  Lv1 基础货架 12 格
  Lv2 18 格、每格 600 个、行情走势、到价提醒
  Lv3 22 格、每格 1200 个、到价自动出售（管家巡视时执行）
  Lv4 30 格、每格 2400 个、自动出售 16 条
```

- 升级：1→2 花 80000，2→3 花 300000，3→4 花 1000000；`B26.cost[w.lv]`（:95-98）。
- 格数：`ids.length / B26.slots[lv-1]`；超出格数的物理货位显示锁（:39-45）。
- 每格上限：`B26.unit[lv-1]`；服务端拒绝超上限（R:1516-1520）。
- 到价提醒条数：Lv2 8、Lv3 16、Lv4 24（`B26.alerts`）；自动出售条目：Lv3 8、Lv4 16（`B26.orders`；`orders[1]=0` 表示 Lv2 无）。
- UI 趋势：今日价 ≥ 基础价 1.08 显示上涨，≤ 0.92 显示下跌，其余横盘（:33）；7 日走势图（:69-71）；编辑框显示相对基础价百分比（:79）。
- 货位布局：三层货架各 6 格、冷库 4 格、地面 8 格（:15-18）；`ids[i]` 按 `vault` 键顺序分配，**上架位置不是独立持久字段**（:44）。

### 9.4 UI 调用流程

- 打开：`openWarehouseHall(host, isle, {toast})` 创建根节点，关闭时恢复 `isle.refresh()`（:23-29）。
- 读取：`S()=>isle.state`；`W()` 读 `s.b26` 并夹取 Lv1–4；`vault()/keep()/inv()`（:30-31）。
- 渲染：头部显示等级、已用格、每格上限、升级、出售记录；货位显示货物、总数量、品质星、提醒铃、订单齿轮；底部背包可点选、拖动（:38-58）。
- 编辑器：品质行有滑杆、数字、「自动补足」；Lv≥2 有提醒价；Lv≥3 有自动出售价与数量；保存时生成 `warehouse/whAlert/whOrder`；`run()` 依次提交并 toast（:72-94）。
- 到价提醒：`fired = Object.entries(w.alert).filter(([id,p]) => price(id) >= p)`，在提示区列出「今日价（≥ 提醒价）」，货位铃铛高亮（:39、:49、:53）。**只在打开或重绘时计算，没有后台推送。**
- 出售记录：`w.sold.slice().reverse()`，显示日期、物品（品质）、数量、单价（:99）。
- 拖拽：移动超过 8px 才开始拖，松手命中未锁定货位则打开编辑器并默认「放进仓库」（:59-65、:72）。

### 9.5 自动化

- 本模块自身没有定时器与轮询；只有渲染和动画。
- 真正的自动出售在服务端管家巡视中执行：Lv≥3、`price >= order.price`、卖出 `min(order.n, vault 数量)`、写 `sold`、递减或删除订单（R:1538-1544）；管家每轮先补仓库再自动卖（R:1148-1149）。
- 触发管家：`state.auto.on` 且距 `state.auto.t` 达到 `AUTO.every`（R:1021、:1036）。

## 10. 跨模块共享常量（前端通过 `R.*`、`A.*` 引用）

- `WORLD`（R:11-25）：`energyBase:100, energyPerHouse:20, regen:180, dailyEarn:1800000, maxActions:40, minGap:2`；`plotsStart:6, plotsMax:24, plotPrice:(n)=>10000*n`；`barnStart:2, barnMax:8, barnPrice:(n)=>80000*n`；`trapMax:4, trapPrice:(n)=>30000*n, trapEvery:180, trapCap:4`；`houseMax:5, housePrice:[100000,250000,600000,1200000,2500000]`；`tools:{rod:[0,80000,300000,1000000], pick:[...], spr:[150000,500000,1500000]}`；`sprCover:[0,8,16,24]`；`cost:{plant:2, water:1, harvest:1, clear:1, feed:1, fish:4, mine:3}`；`daily:{fish:80, mine:100, coffee:3}`；`xp:{harvest:6, collect:6, fish:9, mine:6}`；`coffee:{price:15000, energy:60}`。
- 追加成本、日限：`WORLD.cost.craft=1; WORLD.cost.bomb=6; WORLD.daily.craft=80; WORLD.daily.bomb=10; WORLD.xp.craft=2`（R:173）。
- 商店：`SHOP={feed:{price:150}, bait:{price:400}}`（R:79）；`SHOP.bomb={price:2500}`（R:172）。
- 品质：`QUALITY=[1,1.25,1.5]`（R:87）。
- 守家、偷菜道具：`GUARD_ITEMS` 4 种、`THIEF_ITEMS` 3 种，价格、时长、槽位（R:175-185）；发现率 `Math.min(.75, Math.max(.35, .55+...))`（R:196-198），对应集市文案「基础发现率 55%，范围 35%–75%……好友最多加 6 个百分点，主场保留 10% 生命」（`pet-isle-ui.js:160`）。
- 52弟：`NPC={daily:52, jackpot:0.001, jackpotCoins:1000000}`；`GOMOKU_N=15`；`GOMOKU_LEVELS={1:{mult:.8},2:{mult:1.2},3:{mult:1.5}}`；`GOMOKU_PAID=10`；`BOX_SET=[50,30,20,10,5,0,-10,-20,-30]`（R:301-306）。
- 刮刮乐：`SCRATCH=[{name:'小鱼刮刮乐',price:1000},{name:'金鲸刮刮乐',price:10000}]`；`SCRATCH_TABLE=[[1000,0.00005],[50,0.002],[10,0.01],[5,0.03],[2,0.08],[1,0.18]]`（期望返还约 74%）（R:427-429）。
- 大乐透：`LOTTO={price:500, max:30, nums:30, pick:5, balls:10}`；`LOTTO_PRIZE=[['5+1',1000000],['5',100000],['4+1',20000],['4',3000],['3+1',1000],['3',300],['2+1',200]]`（R:430-431）。
- 管家：`AUTO={every:2*3600, maxBack:48*3600, maxVisits:24, fee:0, surcharge:0, budgetMax:5000000, hire:150000, wage:1500}`；`AUTO_DEFAULT={on:false, crop:'best', water:true, feed:true, fishPct:50, keep:30, sell:true, minPct:90, budget:100000, craft:false, bomb:false, goals:true, guard:0}`（R:1021-1022）。
- 潮汐饭团：`B12_SNACK={energy:20, daily:2, price:6500}`（R:1326）。
- b26：见 §9.3（R:1506-1507）。
- 游乐馆：`GAMES` 三项各 `daily:10`，`shots: bounce 5 / pool 6 / bowl 10`（A:4-7）；`MIN_PLAY={bounce:5,pool:6,bowl:8}`（A:130）；有效场地 `w 320..2560, h 320..1600`（A:131）。
- 税费：`B12_TAX={free:3000000, high:10000000, subsidyCap:1000000}`（R:1638）；售卖税、余额税边际税率见 R:1644-1653。

## 11. 05a5c445 中看起来新增的功能

1. **b26 囤货仓库内景**：整个 `isle-warehouse.js`，头部注明「鱼鱼谷 · 囤货仓库（b26）」，仓位走原 `warehouse`、等级/提醒/订单走 `whUp/whAlert/whOrder`（:1-2）；样式 `/isle-warehouse.css?v=05a5c445`（:6）；仓库美术独立版本 `?v=fb3c9b0c`（:5）。
2. **仓库建筑与等级外观接入主场景**：`LAYOUT.warehouse`（`pet-isle.js:51`）、名牌绘制（:1497-1516）、地图命中（:734）、建筑图 `warehouse-N.webp?v=fb3c9b0c`（:401）。
3. **游乐馆全屏模块**：整个 `isle-arcade.js`，带 2026-11-13 美术注释与独立资源版本 `d69c0fb5`（:11-13）；`LAYOUT.arcade`、地图命中、建筑图 `arcade-hall.webp?v=1e07a12c`（`pet-isle.js:50`、:735、:400）。
4. **榜单大厅与游乐馆榜单**：`LAYOUT.leaderboard` 与 `leaderboard-hall.webp`（`pet-isle.js:49`、:399）；榜单按钮（:239）；榜单种类新增 `bounce/pool/bowl`（`pet-isle-rank.js:3`）；服务端把街机成绩写入 `state.b9Rank`（A:147-148）。
5. **囤货列表面板追加到 UI 模块**：注释「Appended to the existing UI module」与 `b12WarehouseButton`（`pet-isle-ui.js:323-324`）；集市、背包、管家均加入「囤货仓库」入口（:62、:215、:298）。
6. **b12 公库、货船、山谷纪事**：集市页签新增 `cargo/tax`（:170），货船购买 `stockBuy`（:405-414），公库账目 `GET /tax`（:436-453），长夜纪事 `nightClaim/storyRead`（:455-464）。主场景接入长夜时钟与夜潮提示（`pet-isle.js:106`、:813）。
7. **仓库与食物、集市、管家的「包含仓库」联动**：`pet-isle-food.js:14`、`pet-isle-ui.js:62`、:397-402、`pet-isle.js:124-126`。
8. **玩具摊、鱼彩（b7）与串门（b8）**：文件头带版本注释 `2026-11-07 b7`（`pet-isle-fun.js:1`）与 `b8`（`pet-isle-visit.js:2`）。
9. **串门、守家视觉与好友标记**：`pet-isle-visit.js` 引入 `/pet-whale-friends.js?v=05a5c445` 的 `whaleMark`（:1），目录支持「已标记 / 只看可偷」筛选（:48-51）；主场景 :987 注释「11-07 串门」，守家图集 `guard.webp/guard.json`（:1239）。
10. **贴图包与独立资源哈希**：`isle-pack.json/webp?v=984fcf37a667`（:251）；仓库 `fb3c9b0c`（`isle-warehouse.js:5`）；游乐馆 `d69c0fb5`（`isle-arcade.js:12`）；`05a5c445` 只统一了 JS/CSS 查询串。

## 12. 动作、接口完整性检查

动作名汇总（括号内为构造或触发位置）：

`plant`（`pet-isle.js:679`）、`water`（:686）、`harvest`（:685）、`clear`（:684）、`expand`（:721、:778）、`buyTrap`（:725）、`collect`（:750）、`buy`（:753、:975；`pet-isle-ui.js:156-166`）、`feed`（:754）、`pet`（:756）、`sellAnimal`（:766）、`buyAnimal`（:775）、`trap`（:787）、`goal`（:799、:804）、`upgrade`（:821、:827）、`fish`（:870）、`mine`（:921）、`bomb`（:939）、`eat`（`pet-isle-food.js:18`）、`coffee`（`pet-isle-food.js:19`；`pet-isle-ui.js:167`）、`craft`（`pet-isle-ui.js:150`）、`sell`（:417）、`warehouse`（`isle-warehouse.js:89`、:93；`pet-isle-ui.js:383`、:394）、`whAlert`（`isle-warehouse.js:90`）、`whOrder`（:91）、`whUp`（:98）、`stockBuy`（`pet-isle-ui.js:411`）、`guardRefund`（:162）、`nightClaim`（:461）、`storyRead`（:462）、`scratch`（`pet-isle-scratch.js:15`）、`lotto`（`pet-isle-fun.js:194`）、`lottoClaim`（:197）、`npc`（:65、:78、:100、:122、:151、:158）、`arcStart`（`isle-arcade.js:60`）、`arcEnd`（:116）。

独立 HTTP 写接口还有 `visit`（偷菜）、`help`、`board`、`favorite`、`welcome`、`auto`；只读接口还有 `world`、`rank`、`neighbors`、`guard-log`、`battle/:id`、`lotto`、`tax`。

未发现 `worldAct` 这一封装；所有世界写操作最终都落到 `POST /api/pet/world/act`，或使用 `visit/help/board/favorite/welcome/auto` 等独立接口。前端未发出任何未列出的动作名。
