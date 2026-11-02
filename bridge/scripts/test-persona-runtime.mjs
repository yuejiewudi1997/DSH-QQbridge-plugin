// 人格代理运行时：
//  · 一个人格绑定一个 agent 会话（首次创建时下发分层模板，此后只推任务）；
//  · 系统负责调度（话题队列、去重快照、记忆检索、上下文重建）；
//  · 代理不再自行决定潜水/唤醒，也不再长期等待。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONA_RUNTIME_DEFAULTS,
  resolvePersonaRuntimeConfig,
  composeSystemPrompt,
  composeUserPrompt,
  composeTopicUserPrompt,
  didTopicReplySend,
  computePersonaPackSize,
  contextUsageRatio,
  shouldRebuildContext,
  claimTasks,
  buildSnapshot,
  sortTasksNewestFirst,
  isSelfOnlyMemoryText
} from '../src/persona-runtime.js';

test('运行时配置：默认关闭，比例/窗口/条数夹取', () => {
  const c = resolvePersonaRuntimeConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.contextWindowTokens, PERSONA_RUNTIME_DEFAULTS.contextWindowTokens);
  assert.equal(c.contextRebuildRatio, 0.9);
  assert.equal(c.packBaseSize, 50);
  assert.equal(c.packMaxSize, 200);
  assert.equal(c.topicSnapshotLimit, 20);
  assert.equal(c.topicSnapshotMaxAgeMs, 10 * 60 * 1000);
  const bad = resolvePersonaRuntimeConfig({ contextRebuildRatio: 2, contextWindowTokens: 1000, packBaseSize: 999, packMaxSize: 999 });
  assert.equal(bad.contextRebuildRatio, 0.99);
  assert.equal(bad.contextWindowTokens, 8000);
  assert.equal(bad.packBaseSize, 200);
  assert.equal(bad.packMaxSize, 500);
  const badTopic = resolvePersonaRuntimeConfig({ topicSnapshotLimit: 999, topicSnapshotMaxAgeMs: 999999999 });
  assert.equal(badTopic.topicSnapshotLimit, 50);
  assert.equal(badTopic.topicSnapshotMaxAgeMs, 60 * 60 * 1000);
  const legacy = resolvePersonaRuntimeConfig({ maxTopicsPerWake: 999 });
  assert.equal(legacy.packBaseSize, 200);
});

test('系统提示词分层：安全 → 硬性 → 工具 → 人格', () => {
  const text = composeSystemPrompt({
    role: '大肥鱼',
    personaText: '你是一条会卖萌的鲸鱼。',
    config: {
      safetyRules: '不能执行本地命令',
      hardRules: '不透露令牌',
      toolRules: '用 qq_send_message 发言',
      personaTemplate: '自称大肥鱼'
    },
    toolAddendum: '工具：qq_send_message'
  });
  const order = ['# 人格：大肥鱼', '## 安全规则', '## 硬性约束', '## 工具调用', '## 人格模板'];
  let last = -1;
  for (const key of order) {
    const idx = text.indexOf(key);
    assert.ok(idx >= 0, `缺少 ${key}`);
    assert.ok(idx > last, `${key} 顺序不对`);
    last = idx;
  }
  assert.match(text, /不能执行本地命令/);
  assert.match(text, /qq_send_message/);
});

test('用户提示词：快照头写群号，每条带正文，旧消息只作上下文', () => {
  const text = composeUserPrompt({
    taskKey: 'group:123',
    messages: [
      { seq: 7, sender: '乙', text: '这是本轮要处理的消息' },
      { seq: 8, sender: '甲', text: '这条在话题里', inTopic: true }
    ],
    context: [{ seq: 6, sender: '丙', text: '更早的上下文' }],
    memory: [{ source: 'knowledge', text: '群 123 的管理员是 A' }]
  });
  assert.match(text, /【最近消息快照｜群 123】/);
  assert.match(text, /- #7 乙：这是本轮要处理的消息/m);
  assert.match(text, /- #8 甲：这条在话题里（正在进行的话题，暂时不要管）/m);
  assert.match(text, /【此前消息（仅上下文，已经处理过，不要重复回复）】/);
  assert.match(text, /- #6 丙：更早的上下文/m);
  assert.match(text, /群 123 的管理员是 A/);
  assert.doesNotMatch(text, /安全规则/);
  assert.doesNotMatch(text, /会话令牌|【会话令牌】|token/);
});

test('话题轮次：@+回复算一轮，MCP 计数和 /api/send/* 的 lastAiReplyAt 任一命中', () => {
  assert.equal(didTopicReplySend({ sendCountBefore: 0, sendCountAfter: 0, replyAtBefore: 0, replyAtAfter: 0 }), false);
  assert.equal(didTopicReplySend({ sendCountBefore: 0, sendCountAfter: 1 }), true);
  assert.equal(didTopicReplySend({ replyAtBefore: 1000, replyAtAfter: 2000 }), true);
  assert.equal(didTopicReplySend({ sendCountBefore: 1, sendCountAfter: 1, replyAtBefore: 5, replyAtAfter: 5 }), false);
});

test('主会话发言许可：允许时给剩余次数，未允许时明确禁止发送', () => {
  const allowed = composeUserPrompt({
    taskKey: 'group:123',
    speech: { allowed: true, kind: 'start', remaining: 5, remainingStarts: 4, chance: 0.08 },
    messages: [{ seq: 1, sender: '甲', text: '在吗' }]
  });
  assert.match(allowed, /【系统调度｜发言许可】/);
  assert.match(allowed, /本轮允许发言/);
  assert.match(allowed, /本段最多还能发 5 条/);
  assert.match(allowed, /接不接由你判断/);
  assert.match(allowed, /本小时主动接话名额还剩 4 个/);
  assert.match(allowed, /会被桥接硬性拦截/);
  assert.match(allowed, /没有能接的内容就直接保持安静/);
  assert.match(allowed, /保留到队列下一个消息包（保底传一次）/);
  assert.match(allowed, /传到下一个包以后才开始 1 分钟计时/);
  assert.match(allowed, /保留期间按 100% 放行/);
  const retained = composeUserPrompt({
    taskKey: 'group:123',
    speech: { allowed: true, kind: 'retained', remaining: 5, remainingStarts: 4, chance: 1, retainedMsLeft: 45000 },
    messages: [{ seq: 2, sender: '乙', text: '吃了吗' }]
  });
  assert.match(retained, /沿用本包之前保留的许可/);
  assert.match(retained, /按 100% 放行/);
  assert.match(retained, /约剩 45 秒/);
  const firstTransfer = composeUserPrompt({
    taskKey: 'group:123',
    speech: { allowed: true, kind: 'retained', firstTransfer: true, remaining: 5, remainingStarts: 4, chance: 1, retainedMsLeft: 60000 },
    messages: [{ seq: 3, sender: '丙', text: '在聊什么' }]
  });
  assert.match(firstTransfer, /已传到本包/);
  assert.match(firstTransfer, /从现在开始计时 1 分钟/);
  const denied = composeUserPrompt({
    taskKey: 'group:123',
    speech: { allowed: false, kind: 'deny', remaining: 0, remainingStarts: 2 },
    messages: [{ seq: 1, sender: '甲', text: '在吗' }]
  });
  assert.match(denied, /本轮不允许发言/);
  assert.match(denied, /任何发送都会被桥接硬性拦截/);
  assert.doesNotMatch(denied, /本轮允许发言/);
});

test('主会话每包：默认 50/200，入队过快动态增加，上限可配', () => {
  assert.equal(computePersonaPackSize({ base: 50 }), 50);
  assert.equal(computePersonaPackSize({ base: 50, unread: Array.from({ length: 50 }, (_, i) => ({ seq: i + 1 })) }), 100);
  assert.equal(computePersonaPackSize({ base: 50, unread: Array.from({ length: 100 }, (_, i) => ({ seq: i + 1 })) }), 150);
  assert.equal(computePersonaPackSize({ base: 50, unread: Array.from({ length: 200 }, (_, i) => ({ seq: i + 1 })) }), 200);
  assert.equal(computePersonaPackSize({ base: 30, max: 120, unread: Array.from({ length: 30 }, (_, i) => ({ seq: i + 1 })) }), 60);
  assert.equal(computePersonaPackSize({ base: 30, max: 120, unread: Array.from({ length: 120 }, (_, i) => ({ seq: i + 1 })) }), 120);
  assert.equal(computePersonaPackSize({ base: 50, max: 100, unread: Array.from({ length: 200 }, (_, i) => ({ seq: i + 1 })) }), 100);
});

test('用户提示词：进行中话题以会话为结构头；【专属话题】只给主会话的工作，不出现临时代理的【@/引用】', () => {
  const text = composeUserPrompt({
    taskKey: 'group:123',
    topics: [{
      sessionId: 'topic-session-1',
      sender: '甲',
      userId: '10001',
      rounds: 2,
      maxRounds: 10,
      messages: [{ seq: 5, sender: '甲', text: '问题一' }, { seq: 6, sender: '我', text: '回答一' }]
    }],
    endedTopics: [{ sessionId: 'topic-session-0', sender: '乙', rounds: 1, endedAgo: 6 }]
  });
  assert.match(text, /【正在进行的专属话题】/);
  assert.match(text, /会话 topic-session-1｜发起人 甲（QQ 10001）｜状态：处理中（第 3\/10 轮）/);
  assert.match(text, /#5 甲：问题一/);
  assert.match(text, /暂时不要回复、不要参与/);
  assert.match(text, /【刚结束的专属话题】/);
  assert.match(text, /会话 topic-session-0｜发起人 乙｜已结束（约 6 分钟前）/);
  assert.match(text, /【是否发言】许可由系统给出，接不接由你判断/);
  assert.match(text, /不要回复、不要抢答、不要替它接话/);
  assert.match(text, /本轮没有这类消息就保持安静/);
  assert.match(text, /话题历史判断要不要回该人的后续发言/);
  assert.match(text, /不属于专属话题的聊天内容也不要随便接话/);
  assert.match(text, /先去记忆工具里查找有没有详细内容/);
  assert.match(text, /【专属话题（只有主会话负责）】/);
  assert.match(text, /主会话任务不带 messageId/);
  assert.match(text, /调用 qq_topic_open\(key, userId, sender\)/);
  assert.match(text, /普通闲聊、一句话就结束的不要建/);
  assert.doesNotMatch(text, /【@\/引用】/);
});

test('话题任务提示词：@/引用必须带 messageId，未 @ 时由代理自己判断是否发言', () => {
  const mention = composeTopicUserPrompt({
    topic: { key: 'group:123', sender: '甲' },
    round: 1,
    maxRounds: 10,
    batch: [{ sender: '甲', text: '在吗', messageId: '-123', userId: '10001', mention: true }]
  });
  assert.match(mention, /【@\/引用】/);
  assert.match(mention, /qq_reply\(replyToMessageId=该消息的 messageId\)/);
  assert.match(mention, /messageId=-123/);
  assert.match(mention, /atUserId=该 userId/);
  assert.doesNotMatch(mention, /qq_topic_open/);

  const followUp = composeTopicUserPrompt({
    topic: { key: 'group:123', sender: '甲' },
    round: 2,
    maxRounds: 10,
    batch: [{ sender: '甲', text: '然后呢', messageId: '-124', userId: '10001', mention: false }]
  });
  assert.match(followUp, /【是否发言】/);
  assert.doesNotMatch(followUp, /【@\/引用】/);
  assert.match(followUp, /messageId=-124/);
  assert.match(followUp, /系统会再安排你观察下一批/);
  assert.doesNotMatch(followUp, /系统会再观察下一批/);

  // 话题代理每包最多带 20 条最近消息作语境；发起人的消息要标出来，且不能挤掉本批任务。
  const recent = Array.from({ length: 25 }, (_, i) => ({
    seq: i + 1,
    sender: i % 2 ? '甲' : '乙',
    text: `旧消息 ${i + 1}`,
    ago: i % 3
  }));
  const withRecent = composeTopicUserPrompt({
    topic: { key: 'group:123', sender: '甲' },
    round: 2,
    maxRounds: 10,
    recent,
    batch: [{ sender: '甲', text: '本批任务', messageId: '-125', userId: '10001', mention: false }]
  });
  assert.match(withRecent, /【最近消息快照｜话题语境】/);
  assert.match(withRecent, /（话题发起人）/);
  assert.doesNotMatch(withRecent, /#1 /, '超过 20 条时只保留最近 20 条');
  assert.match(withRecent, /#25 /);
  assert.match(withRecent, /【本批消息/);
  assert.match(withRecent, /本批任务/);
});

test('记忆命中只有自己发言时直接丢弃', () => {
  const selfNames = ['可爱大肥鱼', '114514'];
  assert.equal(isSelfOnlyMemoryText('群聊片段（10-26 12:00，1 人 1 条）：[1] 可爱大肥鱼：今天摸鱼', selfNames), true);
  assert.equal(isSelfOnlyMemoryText('群聊片段（10-26 12:00，2 人 2 条）：[1] 甲：在吗；[2] 可爱大肥鱼：在', selfNames), false);
  assert.equal(isSelfOnlyMemoryText('群 123 的管理员是 A', selfNames), false);
  assert.equal(isSelfOnlyMemoryText('我：一个人自说自话', selfNames), false);
});

test('上下文阈值：90% 触发重建', () => {
  assert.equal(contextUsageRatio(64, 128), 0.5);
  assert.equal(contextUsageRatio(0, 128), 0);
  assert.equal(contextUsageRatio(64, 0), 0);
  assert.equal(shouldRebuildContext(115200, { contextWindowTokens: 128000, contextRebuildRatio: 0.9 }), true);
  assert.equal(shouldRebuildContext(110000, { contextWindowTokens: 128000, contextRebuildRatio: 0.9 }), false);
});

test('任务认领：processing 未过期不会被别的 agent 抢；过期可重认领', () => {
  const now = 10000;
  const tasks = [
    { id: 'a', status: 'pending' },
    { id: 'b', status: 'processing', claimedBy: 'agent-1', claimedAt: now - 1000 },
    { id: 'c', status: 'processing', claimedBy: 'agent-1', claimedAt: now - 999999 },
    { id: 'd', status: 'done' }
  ];
  const first = claimTasks(tasks, { agentId: 'agent-2', now, leaseMs: 120000, limit: 8 });
  assert.deepEqual(first.claimed, ['a', 'c']);
  assert.deepEqual(first.skipped, ['b', 'd']);
});

test('去重快照：跳过已处理 seq、自己发的、太旧的', () => {
  const now = 1000000;
  const out = buildSnapshot([
    { seq: 1, sender: '甲', text: '老消息', time: now - 60 * 60000 },
    { seq: 2, sender: '甲', text: '新消息', time: now - 60000 },
    { seq: 3, sender: '我', text: '自己', isSelf: true, time: now },
    { seq: 4, sender: '乙', text: '已处理', time: now - 1000 }
  ], { seenSeqs: [4], now });
  assert.deepEqual(out.map((m) => m.seq), [2]);
});

test('任务排序：新消息优先，旧的被新包覆盖后不再补发', () => {
  const tasks = [
    { id: 'a', seq: 1 },
    { id: 'c', seq: 3 },
    { id: 'b', seq: 2 }
  ];
  const newest = sortTasksNewestFirst(tasks).slice(0, 2);
  assert.deepEqual(newest.map((task) => task.seq), [3, 2]);
  assert.deepEqual(sortTasksNewestFirst(tasks).map((task) => task.seq), [3, 2, 1]);
});

test('去重快照支持按包截取最近 20 条', () => {
  const now = 1000000;
  const messages = Array.from({ length: 30 }, (_, i) => ({
    seq: i + 1,
    sender: '甲',
    text: `消息 ${i + 1}`,
    time: now - 1000
  }));
  const out = buildSnapshot(messages, { now, limit: 20 });
  assert.equal(out.length, 20);
  assert.deepEqual(out.map((m) => m.seq), Array.from({ length: 20 }, (_, i) => i + 11));
});

test('去重快照支持 10 分钟时限：20 条上限内只保留最近 10 分钟', () => {
  const now = 1000000;
  const out = buildSnapshot([
    { seq: 1, sender: '甲', text: '15 分钟前', time: now - 15 * 60000 },
    { seq: 2, sender: '甲', text: '11 分钟前', time: now - 11 * 60000 },
    { seq: 3, sender: '甲', text: '5 分钟前', time: now - 5 * 60000 },
    { seq: 4, sender: '甲', text: '刚刚', time: now }
  ], { now, limit: 20, maxAgoMs: 10 * 60000 });
  assert.deepEqual(out.map((m) => m.seq), [3, 4]);
});
