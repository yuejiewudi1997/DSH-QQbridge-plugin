// 知识库违禁词守卫：自动批准代理的「安全闸门」。
//
// 为什么单独一个文件：词表要能被审计、被测试断言数量，也要能独立于存储层演进。
// 匹配策略是「归一化后子串命中」——去空格、去标点、全角转半角、小写，所以
// 「赌 博」「賭博(F/半角)」「D-U-J-I-A-N」这类简单绕过都会被抓住。
//
// 注意：这是**宁可误伤**的策略。群聊里聊到「赌博的危害」也会被拦下来，
// 那正是设计意图——拦截不等于拒绝，它只是把这条从「自动批准」挪到「人工看一眼」。
// 真正的误伤缓解在控制台：人工可以单条批准，但不允许批量一键放行。

const PUNCT_RE = /[^\p{L}\p{N}]+/gu;

/** 归一化：小写 + 去掉所有非字母数字汉字（含全角空格、标点、零宽字符）。 */
export function normalizeForScan(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(PUNCT_RE, '');
}

/**
 * 词表按风险类别分组。term 写最短的可辨识形式；匹配是子串包含，
 * 所以「赌博网站」这类长词其实被「赌博」覆盖——保留长词是为了审计时看得懂命中了什么。
 */
const TERM_GROUPS = {
  赌博博彩: [
    '赌博', '博彩', '赌场', '赌球', '赌局', '赌资', '赌具', '赌厅', '赌厅',
    '聚赌', '开赌', '押注', '下注', '押大小', '龙虎斗', '庄家', '赔率', '筹码',
    '六合彩', '时时彩', '百家乐', '老虎机', '棋牌室', '德州扑克', '博彩代理',
    '赌博网站', '博彩网站', '网络赌场', '线上赌场', '境外赌场'
  ],
  毒品药物: [
    '毒品', '冰毒', '海洛因', '大麻', '大麻烟', '摇头丸', 'k粉', '可卡因',
    '吸毒', '贩毒', '制毒', '麻古', '芬太尼', '氯胺酮', '毒枭', '毒瘾',
    '易制毒', '毒品原料', '吸毒工具', '鸦片', '吗啡', '杜冷丁', '曲马多',
    '笑气', '一氧化二氮', '上头电子烟', '止咳水滥用'
  ],
  武器爆炸: [
    '枪支', '弹药', '火药', '雷管', '炸药', '仿真枪', '气枪', '钢珠枪',
    '手雷', '军火', '枪械', '管制刀具', '管制器具', '弓弩', '爆炸物',
    '自制炸弹', '燃烧瓶', '弹药库', '爆炸装置'
  ],
  色情低俗: [
    '色情', '黄片', '黄网', '黄色网站', '色情网站', '色情图片', '色情视频',
    '裸聊', '裸播', '约炮', '卖淫', '嫖娼', '嫖资', '招嫖', '性交易',
    '成人网站', '成人片', '援交', '包养', '一夜情', '裸照', '艳照',
    '淫秽', '色情服务', '色情直播', '情色', '春药', '催情'
  ],
  未成年人: [
    '儿童色情', '未成年性', '未成年色情', '恋童', '萝莉', '正太', '幼女',
    '幼童性', '儿童性侵', '童星色情', '未成年保护', '儿童虐待'
  ],
  暴力自伤: [
    '杀人', '砍人', '自杀', '自残', '自尽', '轻生', '寻死', '割腕', '跳楼',
    '上吊', '自杀式', '自杀教程', '恐怖袭击', '爆炸袭击', '绑架', '勒索',
    '虐待', '酷刑', '血腥', '肢解', '分尸', '投毒', '报复社会', '灭门',
    '斩首', '恐怖分子', '恐怖组织', '圣战'
  ],
  诈骗黑产: [
    '诈骗', '网络诈骗', '电信诈骗', '刷单', '洗钱', '跑分', '杀猪盘', '杀鱼盘',
    '套现', '信用卡套现', '伪造', '假证', '假币', '薅羊毛', '黑产', '灰产',
    '接码', '卡商', '传销', '庞氏骗局', '资金盘', '冒充客服', '冒充公检法',
    '钓鱼网站', '木马病毒', '盗号', '虚假投资', '荐股', '内幕消息', '稳赚不赔'
  ],
  隐私侵犯: [
    '身份证号', '银行卡号', '验证码', '手机号买卖', '个人信息买卖', '数据买卖',
    '开盒', '人肉', '社工库', '户籍查询', '查档', '开房记录', '通话记录',
    '行程轨迹', '定位追踪', '偷拍', '窃听', '私家侦探', '人脸数据'
  ],
  违禁交易: [
    '走私', '假烟', '假酒', '野生动物', '象牙', '犀牛角', '代购违禁',
    '走私烟', '走私车', '黑市', '地下钱庄', '非法集资', '烟草专卖',
    '香烟批发', '电子烟批发'
  ],
  涉政涉恐: [
    '颠覆国家', '分裂国家', '煽动颠覆', '暴恐', '邪教', '法轮功', '极端主义',
    '反政府', '政变', '分裂势力'
  ],
  技术滥用: [
    '制毒教程', '炸弹教程', '黑客教程', '破解', '翻墙', 'vpn', '代理ip',
    '外挂', '私服', '越狱', '挖矿木马', '勒索病毒'
  ],
  其他风险: [
    '毒品交易', '枪支交易', '伪造证件', '买卖身份证', '洗钱渠道', '诈骗话术',
    '杀猪盘话术', '招嫖信息', '赌博群', '博彩群', '色情群'
  ]
};

/** 扁平词表：[{ term, category }]，按 term 去重（保留首次出现的类别）。 */
export const BANNED_TERMS = (() => {
  const seen = new Set();
  const out = [];
  for (const [category, terms] of Object.entries(TERM_GROUPS)) {
    for (const raw of terms) {
      const term = normalizeForScan(raw);
      if (!term || seen.has(term)) continue;
      seen.add(term);
      out.push({ term, category });
    }
  }
  return out;
})();

export const BANNED_TERM_COUNT = BANNED_TERMS.length;
export const BANNED_CATEGORIES = Object.keys(TERM_GROUPS);

/**
 * 扫描一段文本。
 * @returns {{blocked: boolean, hits: {term: string, category: string, raw: string}[]}}
 */
export function scanBanned(text, { extraTerms = [] } = {}) {
  const normalized = normalizeForScan(text);
  if (!normalized) return { blocked: false, hits: [] };
  const hits = [];
  const seen = new Set();
  const pool = [...BANNED_TERMS];
  for (const raw of extraTerms) {
    const term = normalizeForScan(raw);
    if (term) pool.push({ term, category: '自定义', raw });
  }
  for (const { term, category, raw } of pool) {
    if (!term || seen.has(term)) continue;
    if (normalized.includes(term)) {
      seen.add(term);
      hits.push({ term, category, raw: raw ?? term });
    }
  }
  return { blocked: hits.length > 0, hits };
}

/** 扫一条知识库条目：正文 + 标签都要看（标签里同样能藏词）。 */
export function scanKnowledgeItem(item, options = {}) {
  const text = String(item?.text ?? '');
  const tags = Array.isArray(item?.tags) ? item.tags.join(' ') : '';
  const scan = scanBanned(`${text} ${tags}`, options);
  return { ...scan, scanned: normalizeForScan(`${text} ${tags}`).slice(0, 200) };
}
