// 人格代理运行时（system-owned scheduling）的纯逻辑层。
//
// 目标（按需求）：
//  · 一个人格 = 一个已注册的 agent 会话；模板只在会话创建时下发一次；
//  · 系统负责调度（话题队列/唤醒/重发/上下文重建），代理只处理推送过来的任务；
//  · 系统提示词分层：安全规则 → 硬性约束 → 工具调用 → 人格模板；
//  · 用户提示词只放任务：最近消息快照（群号 + 序号/来源人/是否在话题中）、进行中话题结构、检索到的记忆，
//    外加风格纠正/使用案例作为「模板」的一部分，不再每轮重复整份人格卡；
//  · 上下文用到阈值（默认 90%）后，归档并重建会话。

export const PERSONA_RUNTIME_DEFAULTS = Object.freeze({
  enabled: false,
  // 主会话上下文窗口（token），用于 90% 重建判定
  contextWindowTokens: 128000,
  contextRebuildRatio: 0.9,
  // 快照每包默认条数 / 上限；入队过快时按 base 的 1~4 倍动态扩容
  packBaseSize: 50,
  packMaxSize: 200,
  // 专属话题代理每包附带的最近消息语境：条数上限 + 时间窗口
  topicSnapshotLimit: 20,
  topicSnapshotMaxAgeMs: 10 * 60 * 1000,
  // 用户提示词里的风格纠正/使用案例（模板的一部分，仅会话创建时随系统层下发）
  styleFix: '',
  examples: '',
  // 系统提示词分层：安全 → 硬性 → 工具 → 人格
  safetyRules: '',
  hardRules: '',
  toolRules: '',
  personaTemplate: ''
});

export function resolvePersonaRuntimeConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    enabled: src.enabled === true,
    contextWindowTokens: Math.round(num(src.contextWindowTokens, PERSONA_RUNTIME_DEFAULTS.contextWindowTokens, 8000, 1000000)),
    contextRebuildRatio: num(src.contextRebuildRatio, PERSONA_RUNTIME_DEFAULTS.contextRebuildRatio, 0.5, 0.99),
    packBaseSize: Math.round(num(src.packBaseSize ?? src.maxTopicsPerWake, PERSONA_RUNTIME_DEFAULTS.packBaseSize, 10, 200)),
    packMaxSize: Math.round(num(src.packMaxSize, PERSONA_RUNTIME_DEFAULTS.packMaxSize, 10, 500)),
    topicSnapshotLimit: Math.round(num(src.topicSnapshotLimit, PERSONA_RUNTIME_DEFAULTS.topicSnapshotLimit, 1, 50)),
    topicSnapshotMaxAgeMs: Math.round(num(src.topicSnapshotMaxAgeMs, PERSONA_RUNTIME_DEFAULTS.topicSnapshotMaxAgeMs, 60 * 1000, 60 * 60 * 1000)),
    styleFix: String(src.styleFix ?? '').slice(0, 4000),
    examples: String(src.examples ?? '').slice(0, 8000),
    safetyRules: String(src.safetyRules ?? '').slice(0, 12000),
    hardRules: String(src.hardRules ?? '').slice(0, 8000),
    toolRules: String(src.toolRules ?? '').slice(0, 12000),
    personaTemplate: String(src.personaTemplate ?? '').slice(0, 20000)
  };
}

/**
 * 系统提示词分层拼装：安全规则 → 硬性约束 → 工具调用 → 人格模板。
 * 顺序有语义：越靠前优先级越高，人格模板不能覆盖安全/硬性规则。
 */
export function composeSystemPrompt({ role = '', personaText = '', config = {}, toolAddendum = '' } = {}) {
  const conf = resolvePersonaRuntimeConfig(config);
  const sections = [
    ['安全规则（最高优先级，不可违反）', conf.safetyRules],
    ['硬性约束', conf.hardRules],
    ['工具调用', [conf.toolRules, toolAddendum].filter(Boolean).join('\n')],
    ['人格模板', [personaText, conf.personaTemplate].filter(Boolean).join('\n\n')],
    ['风格纠正', conf.styleFix],
    ['使用案例', conf.examples]
  ];
  const body = sections
    .filter(([, text]) => String(text ?? '').trim())
    .map(([title, text]) => `## ${title}\n${String(text).trim()}`)
    .join('\n\n');
  const head = role ? `# 人格：${role}\n\n` : '';
  return (head + body).trim();
}

const CONTROL_MARKER = 'DONE';

/** 会话 key → 展示用的群/私聊标签。快照头必须写清群号。 */
function chatLabel(taskKey = '') {
  const m = /^(group|private):(.+)$/.exec(String(taskKey || '').trim());
  if (!m) return String(taskKey || '未知');
  return m[1] === 'group' ? `群 ${m[2]}` : `私聊 ${m[2]}`;
}

/**
 * 命中的记忆如果只是人格代理自己说过的话，就没有检索价值（自己不会提醒自己）。
 * 只认「群聊片段 / 带发言人的条目」：先剥掉片段前缀，再看出场的人是不是全是自己。
 * @param {string} text 记忆条目正文
 * @param {string[]} selfNames 自己的昵称 / QQ 号 / 人格名
 */
export function isSelfOnlyMemoryText(text = '', selfNames = []) {
  const self = new Set((Array.isArray(selfNames) ? selfNames : [selfNames])
    .map((name) => String(name ?? '').trim())
    .filter(Boolean));
  if (!self.size) return false;
  let body = String(text ?? '').trim();
  if (!body) return false;
  body = body.replace(/^群聊片段[（(][^）)]*[）)][：:]\s*/u, '');
  const speakers = [];
  const re = /(?:^|[；;\n])\s*(?:\[\d+\]\s*)?(?:@)?([^：:\n；;]{1,24})[：:]/gu;
  for (const m of body.matchAll(re)) speakers.push(m[1].trim());
  if (!speakers.length) return false;
  return speakers.every((name) => self.has(name));
}

/**
 * 主会话的任务提示词。这里只给「要处理什么、哪些不该管」，不给临时代理的指引：
 *  · 【最近消息快照】：头部写群号，每条只有序号、来源人、正文预览、是否属于正在处理的话题；
 *  · 【此前消息】：只作为上下文，已经处理过，避免模型把整段历史当成本轮任务重复回复；
 *  · 【正在进行的专属话题】：话题处理会话（session）作结构头，下面是发起人、与该发起人的消息、
 *    处理状态——这些只用于帮主会话正确排除正在被话题代理处理的消息，暂时无视；
 *  · 【刚结束的专属话题】：话题归档后不再打标记，主会话可据此判断是否回该人的后续发言；
 *  · 记忆：已过滤掉只有自己发言的条目。
 *  【是否发言】只讲调度规则：哪些消息正在被话题代理处理、哪些不该管、什么时候该保持安静；
 *  【专属话题】只讲主会话自己的工作：接话后被回复可建话题，建好后交给话题代理；
 *  【@/引用】的判定属于话题临时代理，主会话不出现。
 */
export function composeUserPrompt({ taskKey = '', messages = [], context = [], topics = [], endedTopics = [], memory = [], speech = null, maxMessages = 50 } = {}) {
  const preview = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const lines = ['【系统推送任务】'];
  if (taskKey) lines.push(`会话 key：${taskKey}`);
  if (speech) {
    lines.push('', '【系统调度｜发言许可】');
    if (speech.allowed) {
      const kindText = speech.kind === 'retained'
        ? (speech.firstTransfer
          ? `上一包保留的许可已传到本包，从现在开始计时 1 分钟（按 100% 放行）`
          : `沿用本包之前保留的许可（按 100% 放行，约剩 ${Math.max(0, Math.round((Number(speech.retainedMsLeft) || 0) / 1000))} 秒）`)
        : (speech.kind === 'start' ? '系统批准的一次主动接话' : '接话继续');
      lines.push(`本轮允许发言（${kindText}）：本段最多还能发 ${Math.max(0, Number(speech.remaining) || 0)} 条；本小时主动接话名额还剩 ${Math.max(0, Number(speech.remainingStarts) || 0)} 个。`);
      lines.push('接不接由你判断：没有能接的内容就直接保持安静（只输出 DONE），不要为了用掉许可硬接；没发出去时系统会把这次许可保留到队列下一个消息包（保底传一次），传到下一个包以后才开始 1 分钟计时，保留期间按 100% 放行。');
      lines.push('超过次数或未获许可的发送会被桥接硬性拦截。');
    } else {
      lines.push('本轮不允许发言：只查看、判断、整理，不要调用任何发送工具；任何发送都会被桥接硬性拦截。');
    }
  }
  lines.push('', `【最近消息快照｜${chatLabel(taskKey)}】（本轮待处理：序号、来源人、正文预览、是否属于正在处理的话题；原文可用 qq_get_unread_messages / qq_get_recent_messages / qq_get_message_detail 查看）`);
  if (!messages.length) lines.push('（无）');
  for (const m of messages.slice(-Math.max(1, Number(maxMessages) || 50))) {
    const topicFlag = m.inTopic ? '（正在进行的话题，暂时不要管）' : '';
    const body = preview(m.text);
    lines.push(`- #${Number(m.seq) || 0} ${m.sender || '群友'}${body ? `：${body}` : ''}${topicFlag}`);
  }

  if (Array.isArray(context) && context.length) {
    lines.push('', '【此前消息（仅上下文，已经处理过，不要重复回复）】');
    for (const m of context.slice(-10)) {
      const body = preview(m.text);
      lines.push(`- #${Number(m.seq) || 0} ${m.sender || '群友'}${body ? `：${body}` : ''}`);
    }
  }

  lines.push('', '【正在进行的专属话题】（结构只用于让你排除消息：会话头 + 发起人 + 与该发起人的消息 + 处理状态）');
  if (!topics.length) lines.push('（无）');
  for (const topic of topics) {
    const round = Number(topic.rounds) + 1;
    lines.push(`- 会话 ${topic.sessionId || '（会话建立中）'}｜发起人 ${topic.sender || '群友'}${topic.userId ? `（QQ ${topic.userId}）` : ''}｜状态：处理中（第 ${round}/${Number(topic.maxRounds) || 10} 轮）`);
    const list = (Array.isArray(topic.messages) ? topic.messages : []).slice(-10);
    if (!list.length) lines.push('  消息：（暂无）');
    for (const m of list) lines.push(`  · #${Number(m.seq) || 0} ${m.sender || topic.sender || '群友'}：${String(m.text || '').slice(0, 60)}`);
  }
  lines.push('这些话题里的消息暂时不要回复、不要参与；话题结束后再根据话题历史判断是否要回该人的后续发言。');

  if (Array.isArray(endedTopics) && endedTopics.length) {
    lines.push('', '【刚结束的专属话题】（已归档：这些消息不再标记，可据此判断要不要回该人的后续发言）');
    for (const topic of endedTopics) {
      const ago = Number(topic.endedAgo) > 0 ? `（约 ${Math.round(Number(topic.endedAgo))} 分钟前）` : '';
      lines.push(`- 会话 ${topic.sessionId || '（已归档）'}｜发起人 ${topic.sender || '群友'}${topic.userId ? `（QQ ${topic.userId}）` : ''}｜已结束${ago}`);
      for (const m of (Array.isArray(topic.messages) ? topic.messages : []).slice(-5)) {
        lines.push(`  · #${Number(m.seq) || 0} ${m.sender || topic.sender || '群友'}：${String(m.text || '').slice(0, 60)}`);
      }
    }
  }

  lines.push('', '【是否发言】许可由系统给出，接不接由你判断；你主要判断“可不可以不说”：');
  lines.push('- 快照里标了「正在进行的话题」的消息由话题代理处理：不要回复、不要抢答、不要替它接话；等话题结束（见【刚结束的专属话题】）后，才根据话题历史判断要不要回该人的后续发言。');
  lines.push('- 没有标记的消息才归你处理；本轮没有这类消息就保持安静（只输出 DONE），不要为了凑话去接话题里的内容。');
  lines.push('- 即使归你处理，接不上、与本群当前对话无关、或对方已收尾时，也可以保持安静（只输出 DONE）。');
  lines.push('- 没有能接话的内容就直接不回复；不要为了用掉系统给的许可硬找话。');
  lines.push('- 不属于专属话题的聊天内容也不要随便接话：想接某句话前先去记忆工具里查找有没有详细内容；查不到详细信息就提问或放弃，绝不自以为是。');
  lines.push('- 发言次数由系统扣：获批也不能超过上面写的本段剩余条数。');

  lines.push('', '【专属话题（只有主会话负责）】');
  lines.push('- 主会话任务不带 messageId：不要为了引用而引用；只有要回更早的具体消息时才带 replyToMessageId。');
  lines.push('- 如果你接话后被其回复了（也没有 @ 你），判断这个回复是否构成一个长话题；如果构成，调用 qq_topic_open(key, userId, sender) 为该人建立专属话题队列，之后这个话题由话题代理接管。');
  lines.push('- 普通闲聊、一句话就结束的不要建；建好后主会话不再回复这条话题。');

  lines.push('', '【检索到的记忆】');
  if (!memory.length) lines.push('（无）');
  for (const mem of memory.slice(0, 8)) lines.push(`- [${mem.source || 'memory'}] ${String(mem.text || '').slice(0, 240)}`);

  lines.push('', '处理要求：获许可时仍由你判断有没有能接的内容；没有就只输出 DONE，许可由系统保留到队列下一个消息包（最多 1 分钟）。只有获许可且确实要接时才用 qq_send_message / qq_reply（引用具体某条时才带 replyToMessageId）；未获许可只输出 DONE。不要自行设置潜水/唤醒，也不要等待。');
  return lines.join('\n');
}

/** 主会话每包消息数：默认 50；入队/来消息越快，包越大，最多 200。 */
export function computePersonaPackSize({ base = 50, max = 200, unread = [], recent = [], now = Date.now() } = {}) {
  const sizeMax = Math.min(500, Math.max(10, Math.round(Number(max) || 200)));
  const sizeBase = Math.min(sizeMax, Math.max(10, Math.round(Number(base) || 50)));
  const at = Number(now) || Date.now();
  const unreadList = Array.isArray(unread) ? unread : [];
  const queued = unreadList.length;
  const arriveMinute = unreadList.filter((m) => {
    const t = Number(m?.time || 0);
    return t > 0 && at - t <= 60000;
  }).length + (Array.isArray(recent) ? recent.filter((m) => {
    const t = Number(m?.time || 0);
    return t > 0 && at - t <= 60000;
  }).length : 0);
  const pressure = Math.max(queued, arriveMinute);
  if (pressure >= sizeBase * 4) return sizeMax;
  if (pressure >= sizeBase * 2) return Math.min(sizeMax, sizeBase * 3);
  if (pressure >= sizeBase) return Math.min(sizeMax, sizeBase * 2);
  return sizeBase;
}

/** 专属话题一轮是否真的发出过回复：MCP 计数和 /api/send/* 的 lastAiReplyAt 任一条命中都算。 */
export function didTopicReplySend({ sendCountBefore = 0, sendCountAfter = 0, replyAtBefore = 0, replyAtAfter = 0 } = {}) {
  return Number(sendCountAfter) > Number(sendCountBefore)
    || Number(replyAtAfter) > Number(replyAtBefore);
}

/** 专属话题临时代理的任务提示词：只给该代理自己的工作（@/引用、本话题是否回复）。 */
export function composeTopicUserPrompt({ topic = {}, batch = [], recent = [], recentWindowMs = 10 * 60 * 1000, round = 1, maxRounds = 10 } = {}) {
  const sender = topic.sender || '群友';
  const lines = [`【专属话题｜${topic.key || ''}｜${sender}】`, `当前是第 ${round}/${maxRounds} 轮。`];
  const mentionMsgs = (Array.isArray(batch) ? batch : []).filter((m) => m && m.mention);
  if (mentionMsgs.length) {
    lines.push('', '【@/引用】本批有消息直接 @/引用你：必须回复这些消息。');
    lines.push('- 引用回复用 qq_reply(replyToMessageId=该消息的 messageId)；该消息没有 messageId 时，用 qq_send_message 带 atUserId=该 userId。');
  } else {
    lines.push('', '【是否发言】是否回复由你判断：接得上就回；这批消息与本话题无关（对方只是在跟别人说话、换话题、收尾），不要发言。');
  }
  if (round >= maxRounds - 1) lines.push(`已接近 ${maxRounds} 轮上限：本轮尽量收尾、引导话题结束，不要再开新话题。`);
  // 话题代理每包附最近 20 条群聊作为语境，重点看话题发起人前面在聊什么；
  // 这些消息只作参考，不能当成新任务逐条回复。
  const recentList = (Array.isArray(recent) ? recent : []).slice(-20);
  if (recentList.length) {
    const windowMin = Math.max(1, Math.round(Number(recentWindowMs) / 60000) || 10);
    lines.push('', `【最近消息快照｜话题语境】（最近 ${windowMin} 分钟内、本批之前的 ${recentList.length} 条，只作参考，不要逐条回复）`);
    for (const m of recentList) {
      const tag = m.sender === sender ? '（话题发起人）' : '';
      const ago = Number(m.ago) > 0 ? `（约 ${Number(m.ago)} 分钟前）` : '';
      lines.push(`- #${Number(m.seq) || 0} ${m.sender || sender}${tag}${ago}：${String(m.text || '').slice(0, 120)}`);
    }
  }
  lines.push('', '【本批消息（该人最近 30 秒）】');
  for (const m of (Array.isArray(batch) ? batch : [])) {
    const tags = [
      m.messageId ? `messageId=${m.messageId}` : '',
      m.userId ? `userId=${m.userId}` : ''
    ].filter(Boolean).join('，');
    lines.push(`- ${m.sender || sender}${tags ? `（${tags}）` : ''}：${String(m.text || '').slice(0, 300)}`);
  }
  lines.push('', '相关性判定：如果这批消息基本与本话题无关，只回复 TOPIC_IRRELEVANT，不要发 QQ 消息；系统会再安排你观察下一批，连续两批无关才归档。');
  lines.push('如果对方明确结束（拜拜/晚安/不聊了）也可以只回复 TOPIC_END，同样计入一批无关。');
  // DONE 是「回合收尾」的内部信号：必须写明不许用发送工具把它发进群。
  lines.push('最后一步：这一轮处理完，只在这一轮回复文本里输出 DONE（系统用它判定收尾）。DONE、TOPIC_IRRELEVANT、TOPIC_END 都只是给系统的信号，绝对不要通过 qq_send_message / qq_reply 等发送工具发到 QQ。');
  return lines.join('\n');
}

/** 上下文使用比例（0~1）。 */
export function contextUsageRatio(usedTokens, windowTokens) {
  const used = Number(usedTokens) || 0;
  const win = Number(windowTokens) || 0;
  if (used <= 0 || win <= 0) return 0;
  return Math.min(1, used / win);
}

/** 是否需要在「最后一次回复完成后」归档并重建会话。 */
export function shouldRebuildContext(usedTokens, config = {}) {
  const conf = resolvePersonaRuntimeConfig(config);
  return contextUsageRatio(usedTokens, conf.contextWindowTokens) >= conf.contextRebuildRatio;
}

/**
 * 任务认领：同一任务只能被一个 agent 处理；processing 超过 leaseMs 视为失效可重新认领。
 * @returns {{claimed: string[], skipped: string[]}}
 */
export function claimTasks(tasks = [], { agentId = '', now = Date.now(), leaseMs = 120000, limit = 8 } = {}) {
  const claimed = [];
  const skipped = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task !== 'object') continue;
    if (claimed.length >= limit) break;
    const busy = task.status === 'processing'
      && task.claimedBy
      && task.claimedBy !== agentId
      && now - Number(task.claimedAt || 0) < leaseMs;
    if (busy || task.status === 'done') { skipped.push(task.id); continue; }
    task.status = 'processing';
    task.claimedBy = agentId;
    task.claimedAt = now;
    claimed.push(task.id);
  }
  return { claimed, skipped };
}

/** 去重快照：跳过已经处理过的 seq / 文本。 */
export function buildSnapshot(messages = [], { seenSeqs = [], now = Date.now(), maxAgoMs = 30 * 60000, limit = 12 } = {}) {
  const seen = new Set((seenSeqs || []).map(Number));
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.isSelf) continue;
    if (seen.has(Number(m.seq))) continue;
    const ageMs = now - Number(m.time || now);
    if (ageMs > maxAgoMs) continue;
    out.push({
      seq: Number(m.seq) || 0,
      sender: m.sender || '群友',
      text: String(m.text || m.plain || '').slice(0, 200),
      ago: Math.max(0, Math.round(ageMs / 60000))
    });
  }
  return out.slice(-Math.max(1, Math.round(Number(limit) || 12)));
}

/** 认领候选：新消息优先。主会话只处理“生成许可时最近的一包”，旧包不再排队补发。 */
export function sortTasksNewestFirst(tasks = []) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task && typeof task === 'object')
    .slice()
    .sort((a, b) => Number(b.seq) - Number(a.seq));
}
