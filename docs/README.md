# docs

本目录存放分析文档与子代理（agent）报告归档。

## 总览

| 文件 | 内容 |
|---|---|
| [SITE-MODULES.md](SITE-MODULES.md) | **按网站功能模块组织**的完整详解（26 章 / 3,100+ 行）：三套时钟、体力与额度、28 个动作协议、价格与两套税，再逐个功能域（种植/养殖/加工/商店/卖货/仓库/升级/钓鱼/挖矿/蟹笼/偷菜/守家/帮忙/擂台/站宠/玩具摊/游乐馆/修仙 1.0+2.0/每日目标/纪事/咖啡/管家/总调度）讲「规则是什么 + 参考项目具体怎么处理」（含算法、阈值、代码行号） |
| [REFERENCE-KERNEL.md](REFERENCE-KERNEL.md) | 参考项目 `yuyugu-kernel` 全模块详解（598 行）：model / planner / execution / audit / cli / rules / test 逐层展开，附"我们是否已移植"对照 |
| [changes-2026-11-14.md](changes-2026-11-14.md) | 2026-11-14 全天 38 个提交的详细改动记录：问题背景 → 改法 → 验证，含"评估后不移植"清单 |

## 线上前端分析（2026-11-13 抓取）

| 文件 | 内容 |
|---|---|
| [ANALYSIS.md](ANALYSIS.md) | 站点整体协议与模块总览 |
| [ANALYSIS-isle-modules.md](ANALYSIS-isle-modules.md) | 小岛 33 个前端模块详解 |
| [ANALYSIS-battle-store.md](ANALYSIS-battle-store.md) | 战斗与商店 |
| [ANALYSIS-xian-frontend.md](ANALYSIS-xian-frontend.md) | 修仙前端 |
| [ANALYSIS-rules-mechanics.md](ANALYSIS-rules-mechanics.md) | 规则数值全量（A–P 十五节） |
| [ANALYSIS-05a5c445.md](ANALYSIS-05a5c445.md) | 站点 05a5c445 版本新增内容 |
| [AUDIT-05a5c445.md](AUDIT-05a5c445.md) | 33 模块 × 71 协议动作逐个核对，未接 10 项给出定量理由 |

## agent-reports/

2026-11-14「重读参考仓库 yuyugu-kernel 并分析差距」任务的全部子代理报告，共 11 份（10 份完成，1 份因上游 API 400 中断）。

按启动时间分 5 批：

| 批次 | 内容 |
|---|---|
| 11:58 | 参考仓库的新改动：修仙 2.0 / 主岛经济 / 出击调度与审计 |
| 13:01 | 通读参考实现：execution+cli / model+planner / 修仙+NPC+audit+文档 |
| 13:45 | 参考对账与杂项、掐点与修仙实现（求解器策略那份失败） |
| 14:24 | 参考求解器与经济目标 |
| 15:13 | 参考实现 vs 我们的功能差距（据此产出当天 7 个 commit） |

入口：[agent-reports/README.md](agent-reports/README.md)

> 报告里的文件行号指向当时读到的版本，代码改动后可能漂移。
