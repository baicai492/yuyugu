# 大肥鱼修仙记 2.0 前端源码分析（版本 20b20a0e）

> 源码快照：`new4/xs/`（14 个文件，含规则本体 `rules.js`）。
> 与线上 `https://52dmeme.com/xs/rules.js?v=20b20a0e` 逐字节一致（md5 `f824c9bf4470fd0bb4fd9dabb09b8de6`，43,177 B）。
> 行号均为实际全文读取所得。生成日期 2026-11-13。

## 一、总体架构

`entry.js` 是站内挂载口：注入 `xs.css?v=20b20a0e`（entry.js:4），用 `serverStore` 建立存档同步（entry.js:5），按 `state.xs.st` 选初始场景 `<1 ferry`、`<2 sect`、否则 `garden`（entry.js:7），再 `mountXs(wrap,{art,maps,store,onReturn,start})`（entry.js:8），销毁链为 game→DOM（entry.js:9）。

核心模型：**本地用 rules.js 即时演算，每 2.2 秒合批上传，服务端复核后整体覆盖**（net.js:1-2,10,16-25）。前端只是"预测器 + 渲染器"，一切以服务端回执为准。

## 二、逐文件职责与导出

**entry.js（11 行）**：`export mountXian(host,{toast,onReturn})`（entry.js:3），无其它导出。

**net.js（29 行）**：`export serverStore({onSync,onError})`（net.js:5）；常量 `GAP=2200, MAX=30`（net.js:4）。store 暴露 `state/now/coins/pending/act/flush/destroy`（net.js:9-11）；`replace` 保留对象引用整体替换（net.js:12）；初拉 `GET /api/pet/world`（net.js:13）；`schedule`（net.js:14）；`flush` 串行化（net.js:15-16）。

**engine.js（70 行）**：导出 `TILE=32`（engine.js:2）、`loadImage`（缓存、`__xsResolve`，engine.js:4）、`Input`（engine.js:6-18，GAME_KEYS:19）、`Sheet`（engine.js:23-29）、`TileMap`（solid 碰撞，engine.js:32-40）、`Actor`（engine.js:42-49）、`Camera`（engine.js:51-54）、`Loop`（engine.js:56-58）、`findPath`（4 邻接 A*、6000 次上限、目标被占时半径 6 找替身，engine.js:61-69）。

**ui.js（61 行）**：导出 `h`（ui.js:2-3）、`Dialog`（26ms/字、1-9/空格/回车/E、Esc，ui.js:4-21）、`Hud`（ui.js:22-25）、`Hotbar`（10 格、滚轮、折叠，ui.js:27-46）、`floatText`（1.2s，ui.js:47）、`toast`（2.6s，ui.js:48）、`Panel`（ui.js:50-60）。

**game.js（222 行）**：`export mountXs`（game.js:20）。负责地图/NPC（game.js:49-56）、快捷栏（41-45）、种田（62-76）、商店行囊（78-85）、蒲团（89-101）、功法斗法炼丹（104-137）、闲聊切磋（142-152）、物件交互（153-167）、主循环与输入（168-212）。对象类型 `npc/boat/door/stairs/cultivate/scroll/arena/tower/shop/cauldron/well/sign`（154-166）。

**alchemy.js（36 行）**：导出 `BREW_GAME=18`（alchemy.js:4）、`pillIcon`（5）、`PILL_COLORS`（6）、`playBrew`（7）。18 秒青带占比 `>=.7` 上品、`>=.4` 良品，返回 `{q,frac}`（alchemy.js:32）。

**farm.js（29 行）**：导出 `Farm`（4-24）、`poly`（25）、`herbIcon`（26）、`plotView`（27）。杂草位置由 sin 确定（farm.js:5），作物阶段取 `x.plots[i].g`（15-18），特效分 hoe/water/plant/harvest（21-23）。

**story.js（45 行）**：导出 `GOALS`（5）、`createStory`（6）。序章 0 渡口→1 测灵根→2 收一株→3 复命→4 完成（story.js:1-2,14-41）；`step` 发 `story`（8）；灵根选项由 ROOTS 生成并发送 `root`（23-26）。

**content.js（24 行）**：导出 `NPCS`（21 人，2-22）、`npc`（23）。

**content2.js（63 行）**：导出 `NEW_NPC_INFO`（8 人，3-4）、`STORY`（10 人 × 2 章，5-46）、`EVENT_TEXT`（12 机缘，48-61）、`TASK_TEXT`（62）。

**danmaku.js（280 行）**：`export playDanmaku(...)`（102）。内置 secret/demon/sword 三关（42-78）、`duelDef`（83-100）、SHOT 十种弹型（26-32）、符卡特效（213-223）；返回 `{win,captures,time,score,graze}`（154）。

**xs2.js（71 行）**：`export setupXs2`（9）、`GUIDE2`（67-70）；返回 `{chatOptions,talked,maybeEvent,openPeople,openSect,showEvent}`（64）。

**xs3.js（142 行）**：`export setupXs3`（16）、`GUIDE3`（135-141）；返回 `{duelPrep,openRealm,playFight}`（133）。

**rules.js（349 行，规则本体）**：导出全部常量、`newXs/tick/plotView/act/act2/act3`、`skill/skillsOf/mySlots/sim`、`rlmMap/rlmNext/rlmGo/rlmDm` 等（rules.js:1-2,74-129,202-226,250-348）。前端只调用或按同一种子重放。

## 三、HTTP 接口与全部动作

### 3.1 HTTP

- `GET /api/pet/world`（同源、20s 超时）：返回 `{state,rev,coins,now}`；`accept` 覆盖 `state.xs`、记录 rev/coins、用 now 校正时钟（net.js:8,13）。
- `POST /api/pet/world/act`：`{rev, operation:crypto.randomUUID(), actions}`，单批最多 30（net.js:4,16-18）。动作只保留非空的 `i/herb/n/el`（net.js:10）。
- 成功响应 `{rev,state,coins,now,out[]}`；`out` 中 `!ok` 取第一条 msg 提示（net.js:21）；`world_conflict` 接受新态、清队、提示（net.js:22）；429 按 `body.retry`+200ms 重试（net.js:20）；网络异常重试 3 次（800/1600/2400ms），最终失败清队并重拉存档（net.js:19,24）。
- 节奏：距上次成功至少 2200ms、单飞、队列空即停、销毁前 flush（net.js:11,14-16,25）。
- 其它资源：地图 JSON（game.js:51）、art 图片（game.js:35,46；danmaku.js:103-107）、xs.css（entry.js:4）。

### 3.2 修仙 1.0 动作（线上前缀 `xs` + 首字母大写，net.js:10）

| 动作 | 请求字段 | 触发与返回/UI |
|---|---|---|
| xsHoe | `{i}` | 点有草/枯田（game.js:64-72）；`{ok,msg}`，浮字、−3 灵力（game.js:74） |
| xsPlant | `{i,herb}` | 空地有种子（game.js:65,72）；`{ok,msg}`，−1 |
| xsWater | `{i}` | 未浇水（game.js:66,72）；`{ok,msg}`，−1 |
| xsHarvest | `{i}` | `g>=3`（game.js:63,72）；`{ok,msg,herb,n,lvUp?}`，显示 +n、触发序章（game.js:73） |
| xsSit | 无 | 蒲团打坐（game.js:91,97）；`{ok,msg}` → 入定 UI（98） |
| xsRise | 无 | 点任意处收功（game.js:207）；`{ok,msg,gainCv,lvUp2?}`（99） |
| xsBreak | 无 | 修为满 9 层（game.js:92,100）；`{ok,msg,realm?,failBreak?}` |
| xsFuse | `{el:"a+b"}` | 筑基多灵根融合（game.js:93,101）；`{ok,msg,fused?,failFuse?}` |
| xsBrew | `{herb}` | 丹炉选方（game.js:163）；`{ok,msg}` → 小游戏 |
| xsFinish | `{n:q}` | 小游戏结束（game.js:137）；`{ok,msg,pill,n,q,lvUp?}` |
| xsRefill | 无 | 灵泉井（game.js:164）；`{ok,msg}` |
| xsBuy | `{herb,n}` | 每次 1 包（game.js:78,81）；`{ok,msg}` |
| xsSell | `{herb,n}` | 每次 1 株（game.js:79,81）；`{ok,msg}` |
| xsUse | `{herb}` | 行囊服丹（game.js:84）；`{ok,msg}` |
| xsLearn | `{el}` | 经卷台（game.js:105）；`{ok,msg}` |
| xsEquip | `{el}` | 设主修（game.js:105）；`{ok,msg}` |
| xsFight | `{herb:stage, el?:npcId}` | 论剑台/切磋（game.js:133）；`{ok,msg}` → 弹幕；首领走 playBoss（131-132） |
| xsWin | `{n:captures}` | 弹幕胜（game.js:132,135）；`{ok,msg,stone,cap,first?,gainCv,layer?,end?,bank?}`，秘境走 rlmDm（rules.js:120） |
| xsLose | 无 | 失败/撤退（game.js:132,135）；`{ok,msg,end?,bank?}` |
| xsStory | `{n}` | 序章（story.js:8）；`{ok,msg}`；n=4 加灵石 30 + 金菇种 3（rules.js:102-103） |
| xsRoot | `{el}` | 测灵根（story.js:26）；`{ok,msg,roots}`，用 `x.roots.e` 展示（27-29） |

### 3.3 修仙 2.0 动作

| 动作 | 请求字段 | 触发与返回/UI |
|---|---|---|
| xsTalk | `{el}` | 首次聊天（game.js:144；xs2.js:23）；`{ok,msg,fav}`，静默 |
| xsGift | `{el,herb}` | 送礼（xs2.js:29）；`{ok,msg,fav,like}`，like 决定台词（30） |
| xsChap | `{el,n,i}` | 往事选项（xs2.js:26）；`{ok,msg,eff}`，拼在结果后（27） |
| xsEvroll | 无 | 进图自动掷（game.js:55；xs2.js:44）；`{ok,ev,msg}`，读 `state.ev.cur` 弹窗 |
| xsEvpick | `{i}` | 机缘选项（xs2.js:52）；`{ok,res,eff,msg}`，用 `T.res[i][res]`（53） |
| xsTasks | 无 | 宗门面板未生成时（xs2.js:56）；`{ok,msg}` |
| xsTask | `{n}` | 交委托（xs2.js:59）；`{ok,msg,eff}` |
| xsStipend | 无 | 领俸禄（xs2.js:61）；`{ok,msg}` 含金额 |
| xsSlots | `{herb:"id,id,id,id"}` | 战前槽位改动（xs3.js:79）；`{ok,msg}` |
| xsPeek | `{el}` | 观气（xs3.js:78）；`{ok,msg,n}`，n 控制揭示张数（67,74） |
| xsAb | `{el}` | 自动对战（xs3.js:80）；`{ok,msg,fight:{kind,me,op,sd,w},stone?,layer?}`，回放（81） |
| xsRin | `{herb:areaId}` | 选秘境（xs3.js:92）；`{ok,msg}` |
| xsRgo | `{i:col, n?:1}` | 点节点；n=1 首领亲自出手（xs3.js:119-120）；返回 `{ok,msg,node?,fight?,ev?,hurt?,loot?,cv?,heal?,shop?,end?,danmaku?}` |
| xsRbuy | `{i}` | 行商购买（xs3.js:130）；`{ok,msg}` |
| xsRout | 无 | 撤出（xs3.js:115）；`{ok,msg,end,bank?}` |

## 四、state.xs 字段

初始结构见 `newXs`（rules.js:58-62），其余按需惰性创建。

| 字段 | 含义 |
|---|---|
| `v` | 版本 = `XS_VERSION=1`（rules.js:3,59） |
| `en/enAt` | 灵力/回复锚点，360 秒 +1、上限 100（rules.js:4,64-66） |
| `stone` | 灵石（59） |
| `can` | 水壶次数，上限 `CAN_MAX+(water?10:0)`（5,51,88,122） |
| `lv/xp` | 药园等级/经验，升级需 `40*lv*lv`，最高 5 级（59,71,130） |
| `plots` | 24 块 `{s:'soil'|'weed', c, g:0-3, w, dead?}`（5,58-60,67,70） |
| `seeds/bag` | 种子 / 药材（59-60） |
| `log` | 动作计数，收获每 4 次多 1 株（90,128） |
| `st/root/hv` | 序章 0-4、主灵根、累计收获（57-58,102） |
| `pills` | `{huiling,peiyuan}`（58） |
| `brew` | 当前炉 `{p,t}`（58,105-107） |
| `dp` | 回灵丹每日 `{d,n}`（58,108） |
| `roots` | `{e:[五行], v:[变异]}`（58,92,101） |
| `cv` | `{r:大境界 0-8, s:层 1-9, xp}`（58；需求见 33） |
| `med` | 打坐起点 `{t}`（58,93-96） |
| `techs/tech` | 已学功法 / 主修功法（58,110-112） |
| `fight` | 进行中战斗 `{s,t,npc?,rlm?}`（58,114） |
| `df` | 每日斗法 `{d,n}`（58,114,332） |
| `clear` | 1.0 各战场首通（58,119） |
| `mind/luck` | 心境 0-100（默认 50）、气运 -50~50（默认 0）（178-180,185-186） |
| `npc` | `{id:[好感,关系,往事进度,送礼日]}`（181,205-210） |
| `ch` | 当日已叙话 `{d,ids[]}`，最多 30 人（134,205） |
| `ev` | `{d,n,last,cur:{id,t,r}}`，r 为 0-1 随机结果种子（211-216） |
| `tk` | 委托 `{d,list:[[种类,done]]}`（217-221） |
| `rep/ctb` | 声望/贡献；宗门身份由 rep 推导，**无独立 sect 字段**（139-140,190,221） |
| `sp/te` | 领俸日 / 换主修日（112,222） |
| `fuseCd` | 融合失败冷却戳（100-101） |
| `tw` | 当日胜场 `{d,n}`（118,220） |
| `tm` | 功法熟练 `{tech:n}`，层数 = 1+⌊√(n/2)⌋（48,118,191,336） |
| `dd` | 当日已领奖同门 `{d,w[]}`（117,335） |
| `sl` | 4 技能槽（239,330） |
| `pk` | 观气 `{d,o,n}`（331） |
| `rlm` | 秘境 `{a,sd,L,R,c,v,hp,mx,lt,t,amb,bought}`（341,303-324） |
| `rd` | 每日秘境 `{d,n}`（340） |
| `rc` | 秘境首通 `{areaId:1}`（289） |
| `mat` | 材料 `{xuantie,lingyu,yaodan}`（286,345） |
| `flag` | 一次性事件旗标（196,213） |

## 五、数值常量（原文照抄）

- `EN_MAX=100, EN_REGEN=360; // 每 6 分钟回 1 点灵力`（rules.js:4）；`CAN_MAX=20, PLOTS=24, START_OPEN=8`（5）。
- 作物（rules.js:7-14）：灵草 `seed:5, sell:12, grow:600, lv:1`；金菇 `12/30/1200/1`；铃兰 `20/55/1800/2`；冰莲 `40/120/3600/3`；赤芝 `60/190/5400/4`；雷竹 `90/300/7200/5`。浇水分 3 阶；木主修生长 ×0.8（67）。
- `COST={hoe:3, plant:1, water:1, harvest:2, refill:0, buy:0, sell:0, story:0, root:0, brew:5, finish:0, use:0, sit:0, rise:0, break:0, fuse:0, learn:0, equip:0, fight:10, win:0, lose:0, talk:0, gift:0, chap:0, evroll:0, evpick:0, tasks:0, task:0, stipend:0, slots:0, peek:0, ab:0, rin:0, rgo:0, rbuy:0, rout:0}`（15）；土主修锄地只需 1（75）。
- 丹方（17-20）：回灵丹 `{lingcao:3, jingu:1}`，`sell:60`，回 30 灵力、每日 3；培元丹 `{lingcao:2, linglan:1}`，`sell:90`，经验 +40。`BREW_MIN=15, BREW_MAX=1800, PILL_DAILY=3`（21）；品级 `['凡品','良品','上品']`（22）；出炉 `1+q`，火主修良品以上再 +1（106）；小游戏 18 秒、`.7/.4` 分档（alchemy.js:4,32）。
- 开局：灵石 100、水壶 20、1 级、8 块松土、14 号田灵草 g3、15 号田 g1、灵草种子 6（rules.js:58-61）。
- 灵根：`ROOT_WEIGHT=[[1,8],[2,20],[3,32],[4,25],[5,15]]`（27）；`ROOT_BASE={1:2.0, 2:1.5, 3:1.15, 4:.85, 5:.6}`、`ROOT_GROW={1:.85, 2:.93, 3:1, 4:1.08, 5:1.17}`（26）；变异每根 +12%（32）。`cvNeed = 60*(r+1)^2*(1+s*.25)` 四舍五入（33）；`MED_MIN=60, MED_MAX=1800`（34）。
- 突破：培元丹 ×(r+1)，成功率 `max(.3, min(.9, .6+(mind-50)/250+luck/500))`；成功心境 +5，失败修为 ×0.7、心境 −8（97-98,179）。融合：筑基后、培元丹 2 + 灵石 200、55%，失败修为 ×0.8、冷却 86400 秒（99-101）；融合表见 29。
- `TECH_PRICE=50`（43）；十部功法名见 36-42；主修加成（45-46）：火炼丹 +1、水壶 +10、木生长 +20%、金卖药 +15%、土锄地 1、冰打坐 +20%、雷斗法修为 ×1.5、风回灵 +25%、熔斗法灵石 +30%、毒培元 +50% 且回灵丹多回 10。层数 `min(9, 1+⌊√(tm/2)⌋)`、升层 `2L²`、每层 +6%、3/9 层多符卡、6 层多命（48-50）；单灵根功法效率 ×1.5（52）。
- `STAGES`（55）：切磋 `min40, stone15, need0, spells2`；秘境竹林 `70/40/0/3`；魔窟 `100/90/1/4`；葬剑山 `100/150/2/4`。`FIGHT_DAILY=8, FIGHT_COST=10`（56）；战斗间隔 1800 秒（113）；胜利灵石 `S.stone+cap*5`，熔 ×1.3、结拜 ×1.1；修为 `floor(15*rootMult*(thunder?1.5:1))`（116-120）。
- 好感 `FAV_TIER=[0,100,300,600,900]`、`['陌生','熟识','好友','挚友','知己']`（137）；聊天首日 +5、前 3 人 +1 心境（205）；送礼 +40/+15/−10，每人每日一次（207）；好感范围 -500~1000（183）。宗门 `[[0,'外门弟子',10],[200,'内门弟子',25],[800,'真传弟子',50],[2000,'长老',90]]`（139）；俸禄取第三列（222）；委托贡献 win30/pill40/herb `20+n*4`，声望同值、灵石一半、执事 +5（221）。
- 机缘 `EV_DAILY=3, EV_GAP=600, EV_CHANCE=.4`（174）；触发率 `EV_CHANCE+luck/500`（212）；有效 30 分钟（211,214）；结果 `roll = cur.r - luck/400`（216）。往事条件见 CHAPTERS（147-158）。
- 五行 `WHEEL={metal:'wood', wood:'earth', earth:'water', water:'fire', fire:'metal'}`（228）；被克伤害 ×0.75、读条 ×1.2（258,263）。
- 技能：灵弹 `cast:.6, cd:1.2, dmg:7`；护体 `cast:.8, cd:10, shield:22`；大招 `cast:1.8, cd:6, dmg:26` + 特性，小技能 `cast:.9, cd:4` + SK_U（水回 24、土盾 30、金 15 穿透、木 4 定身 1.6、冰 6 减速 5、雷 8 打断、风 9、火 5 灼烧 [3,5]、熔 10 灼烧 [4,4]、毒灼烧 [5,6]）（230-237）。
- 气血 `100+60r+5(s-1)`（240）；NPC `pw=.7+.06lv, hp=90+10lv`（247）；模拟 60 秒 / 0.1 秒步长 / 600 跳，10% 暴击 ×1.5（251-263）。
- 秘境 `RLM_DAILY=3, RLM_EN=15, RLM_MUL=1.5`（277）；节点权重 `fight38, chest10, spring8, event14, shop6, trap8, camp6, herb10`（276）；每层 3 排、每排中列必在、左右列各 70%（278-279）；区域 `竹海 need0, pw.5, hp45`、`洞窟 1, .64, 62`、`洞府 2, 1.02, 100`、`云海 3, 1.1, 105`（270-273）；首领/精英倍率 1.7/1.4（310）；小怪浮动 `.85+.3R`（281）。
- 节点倍率 `sc=1+.6*k`：战斗 6 灵石 + 30% 药材 + 20% 材料；精英 20 + 1~2 材料 + 30% 培元丹；首领 50 + 2~3 材料 + 培元丹；仇人 40；宝箱 12 + 50% 材料 + 30% 药材；灵药 2~3 株（292-301）。泉 +40% 血、篝火 +30% + 心境 2、陷阱 10~20%、奇遇 `p=R()+luck/200` 五档（<.2 伤 12%、<.45 心境 4、<.7 药材、<.9 宝箱、其余修为 `20*(1+k)*rootMult`）（313-321）。行商：回春散 25（回半血）、玄铁 80、灵玉 80（327）。

## 六、2.0 三大块流程与确定性

**xs2 人脉/机缘/宗门**：人脉按好感排序（xs2.js:34-35），`row = id=>x.npc[id]||[0,0,0,0]`（12）。聊天追加"往事/送礼"（19-21）；往事按序、条件满足才可听，结果 = 原文 + 服务端 `eff`（24-27）；送礼好友以上才显示喜好（28-32）。进图 900ms 后自动 `maybeEvent`（game.js:55），要求 `st>=4`，次数未满或已有 cur 才 `evroll`（43-44）；`showEvent` 展示条件/消耗，`evpick` 后取文本 + eff（45-53）。宗门打开先 `tasks`，两页"委托/宗门"，含执事闲聊与俸禄（56-63）。

**xs3 配招/切磋**：`duelPrep` 显示对方前 `pk` 张技能、我方 4 槽可换（63-77）；按钮为自动战（先 slots 后 ab）、观气 20 灵石、亲自弹幕、退出（77-81）。`playFight` 用 `{me,op,sd}` 本地重跑 `sim(trace)`，0.1 秒时间轴回放，×3 速/跳过（38-60），胜负取 `R.w`（58）。

**danmaku 手动弹幕**：仅前端判定，Boss 血尽为胜、命 <0 为败、撤退判负（134,147,154,225）；服务端只验时长 `S.min..1800` 与收取上限 `S.spells`（rules.js:115-116）。收取条件为当前阶段有名字、Boss 血尽、本阶段未中弹/未放符卡（184），每张 +20000 分。客户端还会等 `minTime = 关卡 min+4` 秒（game.js:131,134；danmaku.js:154）。

**确定性边界**：

- **可按种子本地重放**：`sim` 战斗、秘境地图/节点/掉落。种子为切磋 `hseed(day, npc, df.n, stone, cv.xp)`（333）、秘境开局 `hseed(day, rd.n, area, stone, cv.xp, log)`（341）、节点战斗 `hseed(sd, L, R, c, 'b')`、节点随机 `hseed(sd, L, R+1, c)`、弹幕首领掉落 `hseed(sd, 'dm')`（306,311,326）。
- **服务端随机、不可重放**：测灵根（91-92）、突破/融合（98,101）、机缘抽取与 `cur.r`（213）、委托池（217-218）。
- 本地 `store.act` 只是即时预测，flush 后用服务端 state 覆盖（net.js:8,10,12,21-22）。弹幕胜负和炼丹成色是**前端决定、服务端弱校验**（rules.js:106,115-116）。

## 七、技能 / 五行 / 观气 / 自动对战

技能池 = `bolt` + `guard` + 每部已学功法 `el1/el2`（rules.js:238）；4 槽必须互异且已学（239,330）；默认 `[主修1, 主修2, 灵弹, 护体]`（239）。五行相克见 WHEEL（228），界面提示"对方克你 / 你克对方"（xs3.js:25）。

观气：20 灵石、按序揭示、最多 4 次（rules.js:331），UI 按 `pk.n` 隐藏卡牌（xs3.js:67,74）。

自动战：要求已学功法、10 灵力、当日 <8 场；扣费后 `sim`，好感 +3，同日同门首胜才给灵石，累计熟练可升层（rules.js:332-337）；UI 先存槽再 `ab`（xs3.js:79-81）。

弹幕自机十种弹型及符卡见 SHOT / BOMB_COLOR（danmaku.js:26-33），命/符数由层数决定（rules.js:50）。

## 八、秘境

入口：主菜单（game.js:38）、论剑台（game.js:129）、秘境面板（xs3.js:88）。进入要求已学功法、境界达标、当日 <3 次、15 灵力；已有 `rlm` 不足 6 小时拒绝，超 6 小时按失败结算（rules.js:339-341）。进入气血 = `meFighter(x,1.5).mx`，种子写入 `rlm.sd`（341）。

地图 3 层 × 4 排，节点 12 类 `fight/elite/boss/chest/spring/event/shop/trap/tele/camp/herb/gate`（275；显示名 xs3.js:10），连线同列/相邻列，首步与第三排后全连通（278-280；xs3.js:99-105）。

普通/精英/首领自动 `sim`，胜后回 10% 气血并结算掉落；仇人（关系 = 4）普通战 30% 变截杀、数值 ×1.5，输了收获全丢（307-314）。首领可选亲自弹幕：`rgo {n:1}` 建 `x.fight={s:A.stage, t, rlm:1}` 并返回 `danmaku`（305），播完用 win/lose 结算；此路径不再扣 15 灵力、不占 8 场次数，但胜利照给关卡奖励（115-120）。云海 `stage:null` 只能自动战（273,305）。

通关全带、首通培元丹 ×2 + 回灵丹 ×2；撤出/战败带 50%；截杀 0（288-291,346）。材料玄铁/灵玉/妖丹留给未来法宝（274；xs3.js:141）。

## 九、自动逻辑与后台轮询

唯一持续网络轮询是 net.js 合批器：2.2 秒窗口、30 条上限、单飞、仅队列非空时运行，销毁前 flush（net.js:4,11,14-16,25）。

本地每帧 `tick` 处理灵力/作物（game.js:169；rules.js:64-69）；入定 UI 每帧估算收益，实际以 `rise` 为准（game.js:176）。进图触发剧情与 900ms 后机缘检查（game.js:55）；出口每帧检测切图（171）。NPC 随机游走/冒泡（172-175），首次对话自动发 `talk`（144）。机缘 `evBusy` 防重入（xs2.js:42-43），无定时轮询。炼丹/弹幕用 rAF；弹幕页面隐藏自动暂停（danmaku.js:149）；`?xsdebug` 暴露调试对象（game.js:219；danmaku.js:277）。
