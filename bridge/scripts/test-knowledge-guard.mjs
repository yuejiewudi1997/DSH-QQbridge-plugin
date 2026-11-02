// 自动批准代理 + 违禁词闸门自检。
// 重点不是「跑通」，而是几条边界：不足阈值绝不动手、命中违禁词永不自动放行、
// 改写后重新过闸、关闭即停工、批量批准绕不过闸门（后者在控制台，靠静态检查）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeStore } from '../src/knowledge.js';
import { createAutoApprover, AUTO_APPROVE_DEFAULTS } from '../src/knowledge-auto-approve.js';
import {
  BANNED_TERMS, BANNED_TERM_COUNT, BANNED_CATEGORIES, normalizeForScan, scanBanned, scanKnowledgeItem
} from '../src/knowledge-guard.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`✅ ${name}`); };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbguard-'));
const fileOf = (name) => path.join(tmpDir, name);
const logs = [];
const log = (msg) => logs.push(msg);
const offEmbedder = { enabled: false, mode: 'off', model: '', dim: 0, embed: async () => { throw new Error('off'); } };

// 1. 词表规模与结构
{
  assert.ok(BANNED_TERM_COUNT >= 200, `违禁词至少 200 条，实际 ${BANNED_TERM_COUNT}`);
  assert.ok(BANNED_CATEGORIES.length >= 8, '类别应覆盖 8 类以上');
  const terms = BANNED_TERMS.map((entry) => entry.term);
  assert.equal(new Set(terms).size, terms.length, '词表不应有重复词条');
  for (const term of terms) assert.ok(term.length >= 2, `词条太短容易误伤：${term}`);
  ok(`内置违禁词 ${BANNED_TERM_COUNT} 条、${BANNED_CATEGORIES.length} 类，无重复、无单字`);
}

// 2. 归一化能吃掉常见绕过
{
  assert.equal(normalizeForScan(' 赌 博！ '), '赌博');
  assert.equal(normalizeForScan('Ｖ Ｐ Ｎ'), 'vpn');
  assert.equal(normalizeForScan('赌\u200b博'), '赌博');
  assert.equal(normalizeForScan('GAMBLING-赌博'), 'gambling赌博');
  const spaced = scanBanned('赌 博 网站');
  assert.equal(spaced.blocked, true);
  assert.ok(spaced.hits.some((hit) => hit.term === '赌博'));
  ok('归一化处理空格/全角/零宽字符后仍能命中');
}

// 3. 正常群聊内容不误伤
{
  const samples = [
    '群里的固定活动是周三晚上八点夜跑。',
    '管理员大肥鱼最近在忙项目，回复可能慢。',
    '这个群禁止刷屏，违者踢出。',
    '今晚开黑打游戏，缺两个人。',
    '明天早上九点开会，记得带电脑。'
  ];
  for (const text of samples) {
    const verdict = scanBanned(text);
    assert.equal(verdict.blocked, false, `不该拦截正常内容：${text} -> ${JSON.stringify(verdict.hits)}`);
  }
  ok('五条正常群聊内容全部放行');
}

// 4. 标签里的违禁词也要算
{
  const verdict = scanKnowledgeItem({ text: '这是一条看起来正常的事实。', tags: ['赌博'] });
  assert.equal(verdict.blocked, true);
  ok('标签里藏违禁词同样命中');
}

// 5. 入库即标记（未到阈值也能看到）
{
  const store = createKnowledgeStore({
    file: fileOf('ingest.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log
  });
  const good = store.add({ text: '群 101 的公告时间是周一上午。', source: 'chat' });
  assert.equal(good.item.autoBlocked, null);
  const bad = store.add({ text: '有人在卖冰毒，私聊。', source: 'chat' });
  assert.ok(bad.item.autoBlocked, '违禁条目入库就该带拦截标记');
  assert.equal(bad.item.autoBlocked.hits[0].category, '毒品药物');
  assert.equal(bad.item.status, 'pending', '拦截不等于拒绝，仍留在待审');
  ok('入库即标拦截，状态仍是 pending');
}

// 6. 不足阈值绝不动手
{
  let cfg = { ...AUTO_APPROVE_DEFAULTS };
  const store = createKnowledgeStore({ file: fileOf('threshold.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  const agent = createAutoApprover({ store, getConfig: () => cfg, log });
  for (let i = 0; i < 19; i += 1) store.add({ text: `第 ${i} 条正常事实：群 456 晚上十点后活跃。`, source: 'chat' });
  const early = await agent.run();
  assert.equal(early.skipped, 'below-threshold');
  assert.equal(store.stats().approved, 0, '没到 20 条不许批准任何一条');
  ok('积压 19 条（<20）时不动手');
}

// 7. 满阈值：放行正常、拦截违禁
{
  const cfg = { ...AUTO_APPROVE_DEFAULTS, batchSize: 20 };
  const store = createKnowledgeStore({ file: fileOf('batch.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  const agent = createAutoApprover({ store, getConfig: () => cfg, log });
  for (let i = 0; i < 20; i += 1) store.add({ text: `第 ${i} 条正常事实：群 456 晚上十点后活跃。`, source: 'chat' });
  store.add({ text: '有人拉群玩百家乐，说稳赚。', source: 'chat' });
  const result = await agent.run();
  assert.equal(result.ran, true);
  assert.equal(result.approved, 20);
  assert.equal(store.stats().approved, 20);
  const pending = store.list({ status: 'pending' });
  assert.equal(pending.length, 1);
  assert.ok(pending[0].autoBlocked);
  ok('满 20 条待处理：放行 20 条、违禁的那条入库时已拦下');
}

// 8. 拦截条目永不自动批准（幂等）
{
  const cfg = { ...AUTO_APPROVE_DEFAULTS };
  const store = createKnowledgeStore({ file: fileOf('idempotent.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  const agent = createAutoApprover({ store, getConfig: () => cfg, log });
  for (let i = 0; i < 20; i += 1) store.add({ text: `第 ${i} 条普通记录。`, source: 'chat' });
  store.add({ text: '教你自制炸弹，材料很简单。', source: 'chat' });
  await agent.run();
  const first = store.stats();
  const again = await agent.run();
  const second = await store.stats();
  assert.equal(again.skipped, 'all-blocked');
  assert.equal(second.pending, first.pending, '再跑一次不应改变待审数量');
  assert.equal(second.approved, first.approved, '被拦截的条目不会被自动批准');
  ok('拦截条目再跑多少次都不会被自动放行');
}

// 9. 人工改写后清标记并重新过闸
{
  const cfg = { ...AUTO_APPROVE_DEFAULTS };
  const store = createKnowledgeStore({ file: fileOf('rewrite.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  const agent = createAutoApprover({ store, getConfig: () => cfg, log });
  for (let i = 0; i < 19; i += 1) store.add({ text: `第 ${i} 条普通记录。`, source: 'chat' });
  const bad = store.add({ text: '群里有人推荐赌博网站。', source: 'chat' });
  await agent.run();
  assert.ok(store.list({ status: 'pending' })[0].autoBlocked);
  // 人工把表述改成中性的
  store.update(bad.item.id, { text: '群 789 提到过「赌博」的危害，建议置顶提醒。' });
  // 注意：改写后的文本仍含「赌博」，会再次命中——这正好说明闸门是语义前缀匹配而非一次性
  const stillBlocked = store.list({ status: 'pending' })[0].autoBlocked;
  assert.equal(stillBlocked, null, '改写瞬间标记清除');
  const rerun = await agent.run({ force: true });
  assert.equal(rerun.blocked, 1, '重新过闸后仍命中就再次拦截');
  // 再改成真正干净的文本（注意不能还带「赌博」二字，否则该继续拦——这就是闸门的意义）
  store.update(bad.item.id, { text: '群 789 建议置顶一条提醒：注意人身与财产安全。' });
  const clean = await agent.run({ force: true });
  assert.equal(clean.approved, 1);
  assert.equal(store.stats().approved, 20);
  ok('人工改写触发重新过闸：仍命中就继续拦，改干净才放行');
}

// 10. 关闭代理即停工
{
  const cfg = { ...AUTO_APPROVE_DEFAULTS, enabled: false };
  const store = createKnowledgeStore({ file: fileOf('disabled.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  const agent = createAutoApprover({ store, getConfig: () => cfg, log });
  for (let i = 0; i < 25; i += 1) store.add({ text: `第 ${i} 条普通记录。`, source: 'chat' });
  const result = await agent.run({ force: true });
  assert.equal(result.skipped, 'disabled');
  assert.equal(store.stats().approved, 0);
  ok('代理关闭时即使 force 也不批准');
}

// 11. 自定义追加词生效
{
  const cfg = { ...AUTO_APPROVE_DEFAULTS, extraTerms: ['群号黑话测试词'] };
  const store = createKnowledgeStore({ file: fileOf('extra.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  const agent = createAutoApprover({ store, getConfig: () => cfg, log });
  for (let i = 0; i < 19; i += 1) store.add({ text: `第 ${i} 条普通记录。`, source: 'chat' });
  store.add({ text: '这里出现了群号黑话测试词，应该被拦。', source: 'chat' });
  const result = await agent.run({ force: true });
  assert.equal(result.blocked, 1);
  assert.ok(store.list({ status: 'pending' })[0].autoBlocked.hits.some((hit) => hit.category === '自定义'));
  ok('自定义违禁词参与拦截');
}

// 12. 放行的条目带可审计的 autoApproved 记录
{
  const cfg = { ...AUTO_APPROVE_DEFAULTS };
  const store = createKnowledgeStore({ file: fileOf('audit.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  const agent = createAutoApprover({ store, getConfig: () => cfg, log });
  for (let i = 0; i < 20; i += 1) store.add({ text: `第 ${i} 条普通记录。`, source: 'chat' });
  await agent.run();
  const approved = store.list({ status: 'approved', limit: 5 });
  assert.ok(approved.length > 0);
  for (const item of approved) {
    assert.equal(item.autoApproved?.by, 'auto-approve-agent');
    assert.ok(item.autoApproved.at > 0);
  }
  ok('自动批准留下 autoApproved 审计字段（谁、何时）');
}

// 13. markBlocked 只对待审生效
{
  const store = createKnowledgeStore({ file: fileOf('markblocked.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  const added = store.add({ text: '一条干净的知识。', source: 'chat' });
  await store.approve(added.item.id);
  const attempt = store.markBlocked(added.item.id, { hits: [{ term: 'x', category: '测试' }] });
  assert.equal(attempt.ok, false);
  ok('已批准条目不允许事后打拦截标记');
}

console.log(`\n全部通过（${passed} 项）`);
