// 修仙人脉的显示名。
//
// 站点把名字拆在两个文件里，而这两个文件都不适合直接搬进仓库：
//   · 老的 21 人（content.js 的 NPCS）——id → 名字 + 头衔，正文里还夹着台词和立绘信息
//   · 新的 8 人（content2.js 的 NEW_NPC_INFO）——id → 名字 + 头衔
// 而 core/xian-rules.mjs 是 /xs/rules.js 的逐字副本（改一个字节就对不上版本校验），
// 它只带 NEW_NPCS（新人的名字，且是老 NPC 缺失的那一部分）。
//
// 于是这里单独放一张纯展示用的表：id → { name, title }。
// 托管决策不读它，只用于 GUI 人脉卡和日志。
// 来源：https://52dmeme.com/xs/content.js?v=20b20a0e（21 人）
//      https://52dmeme.com/xs/content2.js?v=20b20a0e 的 NEW_NPC_INFO（8 人）

export const NPC_INFO = {
  // ---- content.js · NPCS ----
  '52d': { name: '52弟', title: '仙渡引路人' },
  fas: { name: '法斯', title: '潮库书记' },
  melon: { name: '西瓜', title: '集市司会' },
  duck: { name: '蓝嘎', title: '巡潮水手' },
  rollbin: { name: '洛宾', title: '游方客' },
  echo: { name: '回声', title: '传音使' },
  rainbow: { name: '虹夏', title: '节拍行者' },
  egg: { name: '荷包', title: '试炼丹师' },
  iron: { name: '铁衣', title: '锻器师' },
  lafish: { name: '辣鱼', title: '潮火厨修' },
  meow: { name: '琦喵', title: '灵圃掌柜' },
  water: { name: '止水', title: '济世居士' },
  sup: { name: '风祝', title: '祈风使' },
  soup: { name: '无极', title: '说书客' },
  earthcat: { name: '地喵', title: '符书匠' },
  wheat: { name: '麦穗', title: '巡田使' },
  ant: { name: '时蚁', title: '渡阵师' },
  blessing: { name: '福鱼', title: '食禄使' },
  whitebird: { name: '白羽', title: '归巢营造师' },
  flower: { name: '九一', title: '探花客' },
  castle: { name: '结城', title: '守灯剑客' },

  // ---- content2.js · NEW_NPC_INFO ----
  steward: { name: '执事老周', title: '外门执事' },
  apothecary: { name: '青黛', title: '丹房药师' },
  keeper: { name: '沈默', title: '剑冢守墓人' },
  demon: { name: '厉寒', title: '魔修少年' },
  merchant: { name: '钱多多', title: '散修商人' },
  fox: { name: '白绒', title: '狐妖少女' },
  senior: { name: '苏晚晴', title: '宗门大师姐' },
  ancestor: { name: '玄冥老祖', title: '闭关老祖' },
}

/** 显示名；表里没有就退回 id（站点也是这么兜底的） */
export const npcName = (id) => NPC_INFO[id]?.name || id
/** 头衔；没有就空串 */
export const npcTitle = (id) => NPC_INFO[id]?.title || ''
