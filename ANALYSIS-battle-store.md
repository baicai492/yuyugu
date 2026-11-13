# 鱼鱼谷前端（05a5c445）战斗 / 商店 / 站宠模块分析

> 源码快照：`new4/`。行号均为实际全文读取所得。生成日期 2026-11-13。

## 0. 关键结论

1. `pet-arena.js` 只是**战报回放渲染器**，不做属性、装备、对手生成或战斗结算；它消费服务端返回的 `{battle, skills}` 并按 `battle.events` 演出（pet-arena.js:33、260-321）。`pet-battle.js` 开头明确写着「所有结算、扣费都在服务端；这里只展示和发请求」（pet-battle.js:39）。
2. `pet-battle.js` 所有业务请求都通过站点注入的 `api(path, opts)`，代码内路径是 `/pet/...`（pet-battle.js:74）；若站点 helper 统一加 `/api` 前缀，实际 HTTP 路径即 `/api/pet/...`。
3. 任务点名要求覆盖的 `/api/pet/world/act`、`rank/*`、`tax`、`lotto`、`auto`、`welcome` **不在这 10 个文件中**：实际位于 pet-isle.js、pet-isle-rank.js、pet-isle-ui.js、pet-isle-fun.js、isle-arcade.js（见附录 A）。这 10 个文件只直接使用 `/pet/state`、`/pet/battle/*`、`/pet/duel*`、`/pet/world/favorite/:id` 与 `/api/pet/world/refund`。
4. 一键回收已于 `2026-11-05T00:00:00+08:00` 截止（pet-refund.js:3）；`refundQuote` 先判断 `live()`，过期直接返回 null（pet-refund.js:6、10），所以当前 `refundBanner`/`refundNotifs` 都静默不显示（pet-refund.js:19-22、73-74）。
5. 前端唯一的「自动战斗类」行为是**约战轮询**：擂台对话框打开时每 5 秒拉一次 `/pet/duel`，并自动播放刚被接受的约战回放（pet-battle.js:79-90）；没有自动挑战、自动开宝箱、自动领每日奖励。

## 1. pet-arena.js（战报回放）

**职责与导出**：导出 `createArena(host, { battle, skills }, viewer, back, opts)`（pet-arena.js:33），返回 `{ destroy() }`，用于取消 RAF、断开 ResizeObserver、销毁双方播放器（pet-arena.js:352）。依赖 `createPlayerFor` 与 `petSrc`（pet-arena.js:3-4）。

**数据来源**：唯一网络请求是 `fetch('/pets/dsh/manifest.json', { cache:'force-cache' })` 读动作表（pet-arena.js:31），不是游戏动作。战斗内容全部由调用方传入。

**消费的 battle 结构**：`battle.id`（决定场景，`id % 6`，pet-arena.js:37）、`battle.fighters[2]`（含 `name/level/hp/gear`，pet-arena.js:38、65-69）、`battle.attacker_id`（判断己方，pet-arena.js:39）、`battle.events`、`battle.winner`、`battle.rounds`、`battle.xp`、`battle.drop`、`battle.duel`（pet-arena.js:260、329-346）。事件字段包括 `by/r/skill/tick/dmg/hp[]/sh[]/stunned/revive/heal/counter/hits[]{dmg,crit,dodge}/stun/burn/weak/drain/thorns/cleanse/shield/evade/focus`（pet-arena.js:262-311）。

**演出逻辑**：每场固定 6 个场景之一（pet-arena.js:21-28、37）；按 `MELEE` 集合区分近战/远程（pet-arena.js:7、283-285）；多段 `hits` 逐段结算特效与飘字（pet-arena.js:286-300）；灼烧 tick、眩晕跳过、复活、反击、治疗、护盾、闪避/蓄力各有独立分支（pet-arena.js:266-281）。支持 1×/2×/3×、跳过、双击加速（pet-arena.js:85-91）。结束显示经验、约战押注/抽成、掉落（pet-arena.js:342-347）；`drop.upgraded` 表示重复装备自动强化 +1（pet-arena.js:346）。

**不做的部分**：没有属性计算、装备生成、对手生成、命中/伤害公式；这些都在服务端（pet-battle.js:39）。

## 2. pet-battle.js（擂台大厅）

**顶部副作用**：文件先注入全站确认框 `window.siteConfirm/sitePrompt/siteAlert`（pet-battle.js:1-37），供约战、洗点等二次确认使用（pet-battle.js:174、195、249）。

**导出**：仅 `openBattle({ api, toast, user })`（pet-battle.js:58）。打开时动态加载 `/pet-battle.css`（pet-battle.js:60），写入/清理 `#battle` hash（pet-battle.js:67、71）。六个页签：擂台/装备/加点/商店/每日/说明（pet-battle.js:76）。

**初始化与刷新**：`refresh()` 先 `ensurePetSaved()`，再并发请求 `GET /pet/battle/home`、`GET /pet/battle/gear`、`GET /pet/duel`（pet-battle.js:94-99）。

### 2.1 发给服务端的请求（本文件全部）

| 动作 | 方法/路径 | 请求字段（类型/范围/必填） | 触发 | 返回使用 |
|---|---|---|---|---|
| 首页 | GET `/pet/battle/home` | 无 | 打开、刷新、装备/加点/训练后 | `home.adopted/me/today/record/history/allSkills`（pet-battle.js:96、102、128-167） |
| 装备页 | GET `/pet/battle/gear` | 无 | 同上 | `gear.items/gear/catalog/coins/daily/prices/points/free/breakdown/passive/rewards/pity/level`（pet-battle.js:96、211-268） |
| 约战列表 | GET `/pet/duel` | 无 | 打开、每 5 秒轮询 | `incoming/outgoing/eligible/rules/staked`（pet-battle.js:82、96、169-177） |
| 对手列表 | GET `/pet/battle/opponents` 或 `/pet/battle/opponents/marked` | query：`limit=20`（固定）、`q`（string，可空）、`minLevel`（1-100，默认 1）、`maxLevel`（1-100，默认 100）、`cursor`（可选 string） | 进入擂台、搜索防抖 500ms、筛选、加载更多、切标记页签（pet-battle.js:144-161） | `opponents[]{id,name,level,fought,left,marked}`、`nextCursor`（pet-battle.js:148-158） |
| 标记佬友 | POST `/pet/world/favorite/:id` | body `{active:boolean}`（必填） | 点 🐳 | 返回 `d.marked`，更新按钮并派发 `pet-friend-saved`（pet-whale-friends.js:5、pet-battle.js:157） |
| 发起挑战 | POST `/pet/battle` | body `{opponent_id:number, operation:uuid:string}` 均必填 | 点「挑战」，需 `o.left` 且未达当日上限（pet-battle.js:158、183-190） | 若有 `r.progress` 调 `applyServerProgress`，否则 `show(r)` 回放；随后异步 `refresh()`（pet-battle.js:186-189） |
| 发起约战 | POST `/pet/duel` | body `{opponent_id:number, stake:number, operation:uuid}`；`stake=Math.floor(Number(v))`，界面范围 `rules.minStake–rules.maxStake` | 点「约战」并输入押注（pet-battle.js:192-199） | 提示押注已冻结，`refresh()` 后重绘（pet-battle.js:198） |
| 取消约战 | POST `/pet/duel/:id/cancel` | body `{}` | 自己发起的 open 约战点「取消」（pet-battle.js:172） | 提示押注退回，刷新（pet-battle.js:172） |
| 拒绝约战 | POST `/pet/duel/:id/decline` | body `{}` | 收到邀请点「拒绝」（pet-battle.js:173） | 重新拉取约战列表（pet-battle.js:173） |
| 接受约战 | POST `/pet/duel/:id/accept` | body `{}` | 收到邀请点「接受」，先确认押注与 5% 抽成（pet-battle.js:174） | 返回战斗结果 `r`，`show(r)` 播放；异步刷新（pet-battle.js:174） |
| 读战报 | GET `/pet/battle/:id` | 路径 id（number） | 点最近战报、约战自动播放（pet-battle.js:84、165、200） | 交给 `createArena` 回放（pet-battle.js:200-206） |
| 装备/卸下 | POST `/pet/battle/equip` | body `{slot:'weapon'\|'armor'\|'charm', item:string\|null}` 必填；`item=null` 表示卸下 | 装备详情按钮（pet-battle.js:228） | 用返回 gear 覆盖本地并重绘，再拉 home（pet-battle.js:228） |
| 强化 | POST `/pet/battle/enhance?item=:id` | query `item`（catalog id，必填）；body `{operation:uuid}` | `own.enh < 10` 且 `coins >= cost`（pet-battle.js:223、229） | 用返回 gear 覆盖；提示 +1（pet-battle.js:229） |
| 保存加点 | POST `/pet/battle/points` | body `{points:{str:int,agi:int,spd:int,vit:int}}`，四项非负整数且只能加不能减（pet-battle.js:237-248） | 点「保存加点」（pet-battle.js:248） | 用返回 gear 覆盖，拉 home（pet-battle.js:248） |
| 洗点 | POST `/pet/battle/respec` | body `{operation:uuid}` | 确认后，且 `coins >= prices.respec`（pet-battle.js:249） | 用返回 gear 覆盖，拉 home（pet-battle.js:249） |
| 购买 | POST `/pet/battle/buy?item=:id` | query `item` 必填；body `{operation:uuid}` | 未拥有、`coins >= price`（pet-battle.js:268） | 用返回 gear 覆盖并重绘（pet-battle.js:268） |
| 突破训练 | POST `/pet/battle/train?xp=:xp` | query `xp` ∈ {10,50,100,200,300}（界面只显示 ≤ 今日剩余）；body `{operation:uuid}` | 点训练按钮，`coins >= cost`（pet-battle.js:270-275） | 用返回 gear 覆盖，拉 home 并 `applyServerProgress`（pet-battle.js:275） |
| 开宝箱 | POST `/pet/battle/chest` | body `{}` | 每日页 `ready` 为真（pet-battle.js:281-291） | 返回 gear + `got.{item,pity,upgraded}`，弹奖励并重绘（pet-battle.js:287-290） |

**约战轮询**：`pollDuel` 每 5000ms 执行；`incoming` 增多就提示；对 `outgoing` 中 `status==='done' && battle_id && !shownDuels.has(id)` 且 `created_at > openedAt-600` 的记录自动 `replay(battle_id)`（pet-battle.js:79-90）。对话框关闭时 `clearInterval`（pet-battle.js:91）。

**挑战/搜索限制**：挑战按钮在 `!o.left` 或 `home.today.used >= home.today.limit` 时禁用（pet-battle.js:158）；搜索输入 500ms 防抖（pet-battle.js:161）；等级筛选校验 1–100 且 min ≤ max（pet-battle.js:145）。

### 2.2 装备、加点与商店数值

- 装备面板实际生效比例：`statLine` 为 `v * 0.3 * (1 + 0.04*enh)`，即面板数值 30% 生效、每强化 +4%（pet-battle.js:111）；说明页写「按 30% 生效，每强化一级 +4%（最高 +10）」（pet-battle.js:310）。
- 强化费用：`Math.round(enhanceBase[enh] * enhanceRarity[rarity])`，`enh < 10`（pet-battle.js:223）；说明页写「+0→+1 普通 enhanceBase[0] 起，稀有 ×1.6、史诗 ×2.6、传说 ×4，越往后越贵」（pet-battle.js:311）。
- 商店价格来自服务端 `p.shop[rarity]`（pet-battle.js:265-268）；说明页示例「传说 15 万 D币」，且传说不出售（pet-battle.js:276、310）。
- 加点效果：力量/敏捷/速度每点 +0.4，体质每点生命 +4（pet-battle.js:240）；每升 1 级得 3 点（pet-battle.js:255）。
- 属性成长：每级生命 +5、力量 +0.7、敏捷 +0.5、速度 +0.5（pet-battle.js:258、307）；账号固定 ±10% 天赋浮动（pet-battle.js:256、307）。
- 升级所需经验：`level * 100`（pet-battle.js:128）。
- 自然成长每日上限 1000 经验；追赶期上限 ×2/×3、经验 ×1.6/×2.5（pet-battle.js:274、308）。
- 突破训练：每日上限 `p.trainDaily`；阶梯价 `p.trainTiers`，界面按钮 10/50/100/200/300（pet-battle.js:270-275、308）。
- 每日宝箱：每主动挑战 3 场一个，每天最多 5 个，必出装备，传说 8%，连续 10 个内保底传说（pet-battle.js:285、306）。
- 主动挑战奖励：胜 +15、平 +8、负 +5 经验；掉落率胜 25%、平 15%、负 10%；每日前 `home.today.drops || 30` 场有掉落；两次挑战间隔 8 秒（pet-battle.js:135、306）。
- 约战：押注 `rules.minStake–rules.maxStake`，赢家拿两份押注扣 `R.rake`（确认文案写 5%），平局退回，10 分钟未接自动退回；同一对每天 `pairDaily` 场，每人每天押注上限 `dailyStake`（pet-battle.js:174、195、312）。
- 战斗规则（说明页原文）：最多 20 回合；同回合按速度先后各行动一次；伤害 = 力量 × 招式倍率 × (0.6–1.4 随机) × 暴击 1.7，再按防御「100 ÷ (100 + 防御)」减免；闪避率 = 4% + 双方敏捷差 × 0.6%（2%–40%）；暴击率 = 10% + 敏捷 × 0.3%（最高 35%）；状态含眩晕/灼烧 3 回合/虚弱/灵巧/蓄力（pet-battle.js:307、309）。

## 3. pet-float.js（全站悬浮站宠）

**职责与导出**：导出 `mountPetFloat({ user, api, navigate, toast })`（pet-float.js:63），返回 `{ sync, say }`（pet-float.js:712）。依赖 pet-store 的状态、养成、互动、陪伴计时与保存（pet-float.js:1）。

**常量（原文数值）**：拖拽阈值 `DRAG_THRESHOLD=5`、长按 `LONG_PRESS_MS=450`（pet-float.js:7-8）；随机动作权重 `idle:10,turn:5,move:5`（pet-float.js:10）；分类权重 small 20 / play 20 / food 16 / season 14 / text 10 / work 6 / balance 4（pet-float.js:11-15）；甩动 `drag 2.2, bounce 0.6, maxSpeed 2400, deadZone 450, stopSpeed 25`（pet-float.js:19）；下落 `gravity 1400, floorBounce 0.55, restSpeed 120, groundFriction 2.5`（pet-float.js:20）；尺寸 small 160×220 / normal 200×300 / large 240×380（pet-float.js:22）；位置键 `jinhuan.pet-float-pos`（pet-float.js:39）。

**行为与动作/经验转换**：

- 左键短按 → `interact()` → `petInteract()`：每天第一次 +20 经验，之后每 20 秒 +2 经验并 +1 亲密；8 秒内连戳 6 次变生气（pet-float.js:317-333；pet-store.js:366-391）。
- 菜单四项养成 → `carePet(kind)`：喂食 +8、玩耍 +12、休息 +4、清洁 +4 经验（pet-float.js:539-551；pet-store.js:93-110）。
- 每 2 分钟且可见时 `companionTick()` +1 经验（pet-float.js:666-667；pet-store.js:394-400）。
- 拖拽/甩出/走动/睡觉/换动作本身不加经验（pet-float.js:336-433、214-245、248-278）。
- 所有状态变化只改内存并 `markDirty()`，由 pet-store 2.5 秒防抖后 POST `/pet/state`（pet-store.js:300-306）。

**自动行为**：待机 6–15 秒后随机 `roll()`（pet-float.js:169-173、193-211）；凌晨 1–6 点自动睡觉，醒来后 10 分钟不再睡（pet-float.js:197、259）；Lv5 节日动作 40%、季节动作 8% 概率（pet-float.js:184-190）；Lv3 每 4–8 分钟碎碎念（pet-float.js:294-304）；Lv4 每 15 秒读顶栏未读角标并提醒（pet-float.js:653-665）；每 2 秒校准位置（pet-float.js:704）；隐藏时 `flushPet()`（pet-float.js:697-700）。伪装皮肤、bossing、`/pets` 页面不显示；收起时只留 🐾 标签（pet-float.js:671-692）。

**菜单 UI 入口**：随机动作、睡觉/叫醒、大小（需 Lv10）、贴底/自由放置、换一只、打开擂台（在 `/pets` 直接 `openBattle`，否则 `navigate('/pets#battle')`）、站宠屋、收起、关闭悬浮（pet-float.js:494-517）。

## 4. pet-player.js（播放器）

**导出**：`createVideoPlayer`（:3）、`createFramePlayer`（:117）、`createSpinePlayer`（:197）、`createPlayerFor`（:301）。按 `def.kind` 选择 video/frames/spine（:301-305）。

**职责**：双 `<video>` 轮换预载，第一帧绘制后切前台（:25-50）；同一动作复用、不同动作后台加载，最多 2.5 秒兜底换台（:54-79）；Safari `.mov` 解码失败回退 `.webm`（:14-16）。帧序列用 canvas 精灵图，缓存最多 24 张（:94-107、117-183）。Spine 运行时按需加载，WebGL 渲染，循环动作用 `hold` 随机时长（:188-296）。本文件无 HTTP 业务请求、无动作、无经验。

## 5. pet-store.js（共享状态与云档）

**导出清单**：`DAILY_XP_CAP`、`LEVELS`、`unlockLevel`、`unlocked`、`hasPerk`、`xpToNext`、`petLevels`、`applyDecay`、`CARE`、`petStore`、`applyServerProgress`、`loadPetDef`、`setActivePet`、`petCatalog`、`currentPet`、`subscribePet`、`petState`、`initPetStore`、`reloadPet`、`ensurePetSaved`、`flushPet`、`carePet`、`petInteract`、`companionTick`、`renamePet`、`petName`、`rememberAction`、`petSrc`、`actionsIn`、`actionsNamed`、`findAction`、`floatPrefs`、`setFloatPrefs`、`DEFAULT_PET_STATE`（pet-store.js:12-446）。

**状态结构与公式**：经验上限 300/天（pet-store.js:12）；升级所需 `level*100`、封顶 Lv100（:31、80-86）；总经验 `50*(level-1)*level+xp`（:118）。每小时衰减：饱食 2（Lv10 减半、Lv2 起 0.9 倍）、精力 1（Lv10 0.5、Lv6 0.8）、清洁 1（Lv10 0.5），最多计 48 小时（:49-67）。升级时亲密 +3（:83）。

**养成数值（原文）**：喂食 +18 饱食 / +2 亲密 / 8 经验，饱食 ≥95 拒绝；玩耍 -10 精力 / -4 饱食 / +7 亲密 / 12 经验，精力 <12 拒绝；休息 +22 精力 / -2 饱食 / 4 经验，精力 ≥95 拒绝；清洁 +28 清洁 / +1 亲密 / 4 经验，清洁 ≥95 拒绝（:93-110）。摸摸每天首次 +20，之后 20 秒一次 +2 且 +1 亲密（:366-391）。陪伴每 2 分钟 +1（:394-400）。改名需 Lv8，去控制字符、最多 8 字（:402-410）。

**HTTP**：

- `GET /pet/state`：载入 `{revision, state, progress:{total,day,day_xp}}`（:272-281）。
- `POST /pet/state`：body `{user_id:number, revision:number, operation:uuid, state:object, base_total?:number}`（:321-323）。2.5 秒防抖（:300-306），失败 5 秒后重试（:344-347），409 以云端为准并 `loadCloud`（:336-342），429 提示稍后（:342）。
- 资源 JSON：`/pets/index.json`、`/pets/ark/index.json`、各系列 index、各宠物 manifest（:142-146、194-199、231-237、249）。

**同步机制**：`BroadcastChannel('jinhuan-site-pet')` 跨标签同步，本地缓存键 `jinhuan.site-pet:<userId>`（:131、253-262）；每 60 秒衰减并广播（:263）；页面隐藏/`pagehide` 时 `flushPet`（:264-265）；换宠用 `switchSeq` 只认最后一次（:205-217），并跟随云端 `activePet`（:220-230）。

## 6. pet-refund.js（一键回收）

**导出**：`REFUND_UNTIL`、`refundQuote`、`refundNotifs`、`openRefund`、`refundBanner`（pet-refund.js:3-83）。

**规则**：活动截止 `2026-11-05T00:00:00+08:00`（:3）；报价缓存 10 分钟（:12）；GET `/api/pet/world/refund`（:13）返回 `{available, done:{delta}, until, spent, earned, net, coins, enough}`（:22-24、42-53）；POST 同路径，body `{operation:uuid}`（:61），返回 `{already, net, coins}`（:63-65）。回收会重置小岛（地、动物、工具、小屋、库存、管家全清空），新人礼和降价补偿不动、新人礼不能再领，只能回收一次（:51）。余额不足以扣回时禁用（:52-54）。UI 要求勾选确认框才可提交（:53-57）。顶部横幅仅在 `available` 时显示（:72-81）。

**当前状态**：因为 `live()` 为假，`refundQuote` 直接返回 null（:6、10），所以 GET/POST 都不会发生；`openRefund` 会走到「暂时查不到」分支（:41）。

## 7. pet-state.js（站宠状态定义）

**导出**：`DEFAULT_PET_STATE`（:1-12）、`validPetState`（:16-31）、`clonePetState`（:33-35）。默认值：`version:1, activePet:'dsh-blue-whale', level:1, xp:0, hunger:78, energy:82, cleanliness:86, affection:12, lastTick:0, currentAction:'待机呼吸休闲'`（:1-12）。校验范围：activePet 匹配 `^[a-z0-9][a-z0-9-]{1,47}$`；level 1–100；xp 0–1,000,000,000；hunger/energy/cleanliness/affection 0–100；lastTick 0–4,000,000,000；currentAction 长度 1–80（:19-30）。未校验 `daily/nickname` 等扩展字段（:16-31）。

## 8. pet-fullscreen.js（全屏控制）

导出 `mountFullscreen(host,{sdk,notify})`（:1），在 `.isle` 内插入「⛶ 全屏 / 退出全屏」按钮（:2-4）。优先用 `sdk.fullscreen.request/exit`，否则用 `document.documentElement.requestFullscreen/exitFullscreen`（:5、12）；`fullscreenchange` 同步按钮状态（:9-11）；繁忙时防重入，失败 toast（:12）；返回清理函数（:14）。无 HTTP、无游戏动作。

## 9. pet-whale-friends.js（佬友标记按钮）

导出 `whaleMark({id,name,marked,request,onChange,onError,className})`（:2）。生成 🐳 按钮，`aria-pressed`/title 反映标记状态（:3-4）。点击前派发 `pet-friend-check` 让当前小岛操作置 busy；若忙则提示「小岛操作尚未结束，请稍候标记。」（:5）。否则调用注入的 `request(id, !marked)`，成功后更新状态并派发 `pet-friend-saved`（:5）。自身不发 HTTP；在 pet-battle.js 中该 request 为 `POST /pet/world/favorite/:id` body `{active}`（pet-battle.js:157）。

## 10. pets.js（页面入口与装载）

**导出**：`mountPetRoom`（:29）、`mountPets`（:359）。

**mountPets（/pets 入口）**：未登录显示登录引导（:361-363）；加载 `/pet-isle.css` 与 `/b13-island-layout.css`（:365-366）；动态 `import('/pet-refund.js')` 后调用 `refundBanner`（:371）；锁定页面滚动（:373-375）；`fit()` 计算可用宽高和手机底栏（:377-388）；并发加载 `pet-isle.js` 与 `pet-isle-ui.js`（:390），挂载小岛（:454）、全屏控件（:455）、初始化 pet-store（:453）；`#battle` 时 `queueMicrotask(openArena)`（:457）；离开时恢复滚动、销毁房间/修仙/小岛或缩成小窗（:458）。

**菜单入口 → 动作**（:416-451）：修仙记 `switchXian(true)`；集市 `openMarket`；说明 `openGuide`；擂台 `openArena()`；背包 `openBag`；宠物屋 `openRoom()`（内部 `mountPetRoom`，:393-399）；挂机管家 `openAuto`；游乐/鱼彩 `openFun`/`openLotto`；**游乐馆 `openArcade`**；仓库 `openWarehouse`；串门 `openVisit`；菜单里另有悬浮开关、音效、小窗开关（:428-449）。`#battle` 由 `openArena` 动态加载 `pet-battle.js`（:392、457）。

> **归属证据**：`what === 'arcade'` 与 bag/fun/warehouse/visit 同级，都是小岛菜单项；修仙是独立的 `/xs/entry.js` 入口、存档在 `state.xs`，游乐馆存档在 `state.arc`。

**mountPetRoom（宠物屋）**：登录校验（:30-33）、`initPetStore`（:36）、头部按钮「擂台/换一只/回图廊」与悬浮开关（:49-55）、舞台点击 `petInteract`（:95-105）、四个养成按钮 `carePet`（:125-132）、动作图鉴 `setAction`/`rememberAction`（:134-143、164-175）、改名（:148-151）、成长之路（:152-155）、换宠 `setActivePet`（:211-215）、全局 `petchange/petlevelup` 监听（:271-272、291-297）、可见性暂停/恢复（:298-299）、离开时 `flushPet`（:301-310）。无独立轮询；状态刷新依赖 `subscribePet`（:289）与 pet-store 的 60 秒衰减定时器（pet-store.js:263）。

**摸鱼小窗**：`b15Mini` 用 localStorage `b15IsleMini`/`b15IsleMiniPos` 记忆开关与位置（:320-357）；离开 /pets 时 `keep` 把整个小岛 DOM 移入右下角小窗并保持运行（:458）。

## 11. 自动逻辑汇总

- 约战轮询 5 秒 + 自动播放已接受约战回放（pet-battle.js:79-91）。
- 进入 `/pets#battle` 自动打开擂台（pets.js:457）。
- 悬浮宠自动待机/随机动作/走动/睡觉/碎碎念/节日动作/未读提醒/陪伴经验/位置校准（pet-float.js:193-211、248-304、653-667、704）。
- pet-store 每 60 秒衰减、2.5 秒防抖保存、失败 5 秒重试、隐藏/离开页面立即保存（pet-store.js:263-265、300-306、344-347）。
- 小岛挂机管家由服务端 `autoDue` 触发 `autoPost`（pet-isle.js:1671）；`/api/pet/world/auto` 配置保存（pet-isle.js:455-470）。
- **无**自动挑战、自动开宝箱、自动领每日奖励/升级奖励；宝箱、训练、购买、约战均需点击（pet-battle.js:268、286、172-174、275）。

## 附录 A：本组文件不涉及、但属于小岛模块的接口

| 接口 | 方法/参数 | 用途与位置 |
|---|---|---|
| `/api/pet/world/act` | POST body `{rev:number, operation:uuid, actions:Array}`；429 最多重试 3 次；409 回滚未确认操作 | 小岛所有操作批量提交（pet-isle.js:155-176）；`actNow(action)` 单动作排队、20 秒超时（pet-isle.js:184-193）；批量上限 `WORLD.maxActions=40`、最小间隔 `minGap=2` 秒（pet-world-rules.js:13） |
| `/api/pet/world/welcome` | POST body `{operation:uuid}` | 新人礼领取（pet-isle.js:441-453）；`WELCOME_GIFT=1,000,000` D币（pet-world-rules.js:148） |
| `/api/pet/world/auto` | POST body `{rev:number, operation:uuid, config:object}` | 挂机管家配置/补算（pet-isle.js:455-470）；`AUTO={every:7200, maxBack:172800, maxVisits:24, fee:0, surcharge:0, budgetMax:5000000, hire:150000, wage:1500}`、`AUTO_DEFAULT` 各字段（pet-world-rules.js:1021-1022） |
| `/api/pet/world/rank/:kind/:period` | GET query `limit`（榜单 20 / 游乐馆 5）、`cursor`；kind=battle/steal/help/earn/balance/bounce/pool/bowl；period=day/total（balance 忽略 period） | 山谷榜单（pet-isle-rank.js:3-5）、游乐馆榜（isle-arcade.js:30-31） |
| `/api/pet/world/tax` | GET，无参数 | 公库账目（pet-isle-ui.js:442-450）；返回 `current/treasury/mine/history/season/day` |
| `/api/pet/world/lotto` | GET，无参数 | 鱼彩开奖信息（pet-isle-fun.js:185、201-205）；购买走 act `{a:'lotto', n:[5个红球1-30], b:蓝球1-10}`（pet-isle-fun.js:194；pet-world-rules.js:430、846-852）；兑奖 `{a:'lottoClaim'}`（pet-isle-fun.js:197）；`LOTTO={price:500, max:30, nums:30, pick:5, balls:10}`、奖级（pet-world-rules.js:430-431） |
| `/api/pet/battle/:id` | GET | 守护战/偷菜战回放（pet-isle-visit.js:34）；擂台回放同一接口（pet-battle.js:200） |
| `/api/pet/world/visit/:id` | GET 读取；POST body `{operation:uuid, kind, i:number}` 偷菜 | 串门店（pet-isle.js:993-998、1045、1113-1137） |
| `/api/pet/world/help/:id` | POST body `{operation:uuid}` | 帮好友浇水/清理/喂养（pet-isle.js:1014-1035） |
| `/api/pet/world/neighbors`、`neighbors/marked` | GET query `limit=20, q, stealable, cursor` | 串门目录（pet-isle-visit.js:50-51） |
| `/api/pet/world/board/:id` | GET / POST `{operation,text}` 或 `{operation,remove}` | 留言板（pet-isle-visit.js:8、17-21） |
| `/api/pet/world/guard-log` | GET query `cursor` | 守护战日志（pet-isle-visit.js:30） |

**偷菜/守家与发现率**：守家战斗由偷菜 POST 返回的 `r.battle` 触发（pet-isle.js:1113-1137）；被发现时气泡「被发现了！」（:1120）；结果标题为「打赢了守家的大肥鱼/没被发现/被大肥鱼打跑了/打平」（:1141-1143）；输了按这批货市价 1.2 倍赔偿，上限 `visit.d.rules.fineMax || 5000`（:1150）；偷一批体力 `min(15, 5+max(0, 可偷处数-1))`（:1006、1153）。**发现率公式**：`min(0.75, max(0.35, 0.55 + 警戒道具加成 + 潜行道具减成 + min(0.06, max(0, 好友度))))`（pet-world-rules.js:196-198）；警戒道具潮铃 +10%、萤火灯 +6%，潜行道具轻步斗篷 -10%、风声口哨 -6%（且每次偷菜少耗 1 体力），守家道具贝壳护具生命 +8%、珊瑚挡板防御 +4，均持续 24 小时（pet-world-rules.js:175-183）。新手 24 小时偷菜保护（pet-isle-visit.js:56）。

## 附录 B：字段归属澄清

`state.b9Rank` 属于小岛游乐馆存档，写在小岛状态 JSON 的 `state.b9Rank`（arcade-rules.js:1、147；pet-world-rules.js:1343、1489）。`state.arc` 存游乐次数与纪录（isle-arcade.js:29）。`state.tools`（鱼竿/镐子/洒水器/小屋等级）定义于 pet-world-rules.js:19、449，UI 读取于 pet-isle-ui.js:222、pet-isle.js:827。`state.iq` 是每日任务计数（pet-world-rules.js:433、510-511）。`srv.gift` 是新人礼是否已领（pet-isle.js:440）；`d.help.aff` 是好友亲密度（pet-isle.js:1009、1027），**不是** `state.aff`。本组 10 个文件未引用 `state.b9Rank/state.battle/state.gift/state.tools/state.iq`；这些属于小岛 world state，不属于 pet-store 的站宠状态（pet-state.js:1-31）。
