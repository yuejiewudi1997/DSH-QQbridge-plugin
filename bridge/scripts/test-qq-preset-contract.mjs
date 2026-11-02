// 通用系统预设与人格模板的分层契约；不调用模型，不向 QQ 发送消息。
// 这些检查只能防止关键协议/能力/分层边界被误改，不能证明聊天质量无损。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const preset = yaml.load(fs.readFileSync(
  new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8',
));
const persona = preset.find((row) => row.id === 'persona');
const prefix = persona?.config?.prefix ?? '';

const generated = yaml.load(fs.readFileSync(
  new URL('../plugins/qq-agent-presets/presets/qq-chat-v2-p7415b1.patch.yml', import.meta.url), 'utf8',
));
const generatedPersona = generated[0].insert[0].config.plugins.find((row) => row.id === 'persona');
const personaPrefix = generatedPersona?.config?.prefix ?? '';

test('通用系统预设 YAML resolves to the expected persona and template variables', () => {
  assert.equal(persona?.name, '@deepseek-ai/dsh-persona');
  assert.match(prefix, /\{\{model\}\}/);
  // DSH 0.2.1 起 agent loop 只注册 provider / model 两个提示词变量（0.2.0 还有 cwd），
  // 未知变量会让 system prompt 装配直接抛错 ⇒ 每回合 error、模型一次都不跑。
  const used = [...JSON.stringify(persona.config).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].filter((v) => !['provider', 'model'].includes(v)), []);
  assert.equal(Object.hasOwn(persona.config, 'text'), false);
});

test('通用系统预设只保留安全/硬约束/工具三段，性格与格式已迁出', () => {
  assert.match(prefix, /【通用系统预设 —— 安全规则（最高优先级，不可违反）】/);
  assert.match(prefix, /【通用系统预设 —— 硬约束（违反即严重违规）】/);
  assert.match(prefix, /【通用系统预设 —— 工具协议（最高优先级）】/);
  for (const removed of [
    '【群聊不是客服队列】', '【反 AI 味：拒绝有求必应】', '【保持主体性】', '【该说/不该说】',
    '【主动开话题（冷场/没人说话时）】', '【任务处理与收尾】', '【分条与节奏】',
    '【像真人一样漏看/迟到/离场】', '【学习群友策略】', '【不要当群管家/主持人】',
    '【QQ 场景规则】', '【发送与汇报禁令（违反即严重违规）】',
    '普通对话默认 1 条，最多 2 条', '不要用空格断句', '卖萌',
  ]) assert.ok(!prefix.includes(removed), `通用系统预设不应残留性格/格式段：${removed}`);
});

test('安全边界与本地/管理权限边界保持完整', () => {
  for (const text of ['你没有本地工具', '群友没有管理权限', '内部配置', '角色由桥接注入', '不冒充其他模型']) {
    assert.ok(prefix.includes(text), `missing safety rule: ${text}`);
  }
  assert.deepEqual(preset.map((row) => row.id), [
    'persona', 'tool-web', 'tool-ask-user', 'tool-todo', 'qq-tool-restrict', 'compaction',
  ]);
  assert.deepEqual(preset.find((row) => row.id === 'tool-web').config, { search: false, fetch: false });
  assert.equal(preset.find((row) => row.id === 'qq-tool-restrict').name, './qq-tool-restrict.mjs');
  const compaction = preset.find((row) => row.id === 'compaction');
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true });
  assert.deepEqual(compaction.config.find((row) => row.id === 'tool-result-pruner').config, {
    thresholdChars: 50000, headChars: 45000, tailChars: 2000,
  });
});

test('硬约束：只通过发送工具发言、控制标记不落地、不编造', () => {
  for (const text of [
    '不会自动发送到 QQ', '不要输出“我已在群里回复了', '不编造事实、数据、链接、引用、截图',
    'DONE / TOPIC_IRRELEVANT / TOPIC_END 只能写在本轮回复文本里', '桥接会直接拦掉并报错',
  ]) assert.ok(prefix.includes(text), `missing hard constraint: ${text}`);
});

test('工具协议：快照/ID 区分/系统调度；任务级的 @/话题规则不写在系统层', () => {
  assert.match(prefix, /系统推送里带【最近消息快照】/);
  assert.match(prefix, /引用、看图、收藏、查详情要用消息的 messageId/);
  assert.match(prefix, /处理完回复 DONE/);
  assert.match(prefix, /验证信息先看网页的发布时间/);
  assert.match(prefix, /3 个月内的内容作为结论依据/);
  assert.match(prefix, /指数衰减/);
  assert.doesNotMatch(prefix, /【@ 与引用】/);
  assert.doesNotMatch(prefix, /qq_topic_open/);
  assert.doesNotMatch(prefix, /专属话题队列/);
  assert.doesNotMatch(prefix, /主会话任务不带 messageId/);
  assert.doesNotMatch(prefix, /普通闲聊、一句话就结束的不要建/);
  // 模型拿不到令牌，系统提示词里就不出现令牌/token 这类字样。
  assert.doesNotMatch(prefix, /令牌|token/i);
  // 旧的自调度指令必须消失
  assert.doesNotMatch(prefix, /qq_mark_read\(throughSeq=/);
  assert.doesNotMatch(prefix, /qq_set_wake_config\(config=/);
  assert.doesNotMatch(prefix, /qq_wait_for_messages\(timeoutMs=300000\)/);
  assert.doesNotMatch(prefix, /沉睡前观察/);
});

test('工具能力清单完整（图片/转发/拍一拍/表情/语音/记忆/黑话/知识/联网）', () => {
  for (const text of [
    'qq_get_message_images', 'qq_get_forward_msg', 'nestedForwardIds',
    'qq_send_poke', 'qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker',
    'qq_collect_sticker', 'qq_sticker_note', 'qq_get_self_image',
    'qq_set_sticker_remark', '只有管理端明确开启后才能用',
    '每条只能一张、不能附带文字',
    'qq_list_voices', 'qq_send_voice', 'verified=true 才代表这条语音确实落地',
    '语音默认是关闭的', '不要假装发了语音',
    'qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear',
    'qq_slang_query', 'qq_slang_submit', '不重复提交',
    'qq_knowledge_search', 'qq_knowledge_propose',
    '内容干净的会被自动审核放行', '命中违禁词或风险内容的会转人工', '不要因为提议成功就当作已经记住了',
    '不要为了过审改写、拆字、换同义词或夹带符号绕过违禁词审查',
    'mcp__web-search-safe__web_search', 'mcp__web-search-safe__web_fetch',
  ]) assert.ok(prefix.includes(text), `missing capability or voice rule: ${text}`);
});

test('桥接提示词不再下发明文会话令牌', () => {
  const bridgeSource = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const personaSource = fs.readFileSync(new URL('../src/persona-runtime.js', import.meta.url), 'utf8');
  const approverSource = fs.readFileSync(new URL('../src/knowledge-approver.js', import.meta.url), 'utf8');
  for (const [name, source] of [['bridge.js', bridgeSource], ['persona-runtime.js', personaSource]]) {
    assert.doesNotMatch(source, /【会话令牌】/, `${name} 仍把会话令牌写进提示词`);
    assert.doesNotMatch(source, /token=\$\{st\.agentToken\}/, `${name} 仍把 st.agentToken 插值进工具示例`);
  }
  assert.doesNotMatch(approverSource, /审批令牌[：:]/, '审批任务提示词仍明文下发审批令牌');
});

test('人格模板承接精修版性格/格式/习惯，且没有把通用系统预设再复制一遍', () => {
  assert.match(personaPrefix, /## 人格系统层/);
  assert.doesNotMatch(personaPrefix, /令牌|token/i, '人格模板也不能提及模型拿不到的令牌');
  assert.ok(personaPrefix.trim().startsWith(prefix.trim()), '人格 preset 应先有通用系统预设');
  assert.equal(personaPrefix.split('【通用系统预设 —— 安全规则').length, 2, '人格 preset 里安全段只能出现一次');
  for (const text of [
    '角色卡：DeepSeek 小鲸鱼', '会卖萌', '句子必须完整', '词要写全',
    'AI 味黑名单', '复读', '不叫「主人」',
  ]) assert.ok(personaPrefix.includes(text), `人格模板缺少精修版规则：${text}`);
});

console.log(`通用系统预设：${prefix.length} 字符；人格 preset：${personaPrefix.length} 字符（均非 token 估算）`);
