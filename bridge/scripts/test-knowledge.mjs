// 知识库自检：审核状态、去重、向量/关键词检索、私有可见性、合并、重建、持久化。
// 不联网：embedding 端点用假 fetch 顶替，形状照 OpenAI /v1/embeddings 和 Ollama /api/embed 各测一遍。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createEmbedder,
  createKnowledgeStore,
  buildKnowledgeBlock,
  rankHitsForContext,
  keywordScore,
  cosine,
  encodeVector,
  decodeVector,
  fingerprint,
  normalizeForHash,
  publicItem,
  KNOWLEDGE_STATUS
} from '../src/knowledge.js';
import { scanKnowledgeItem } from '../src/knowledge-guard.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
const file = path.join(tmpDir, 'knowledge.json');
const logs = [];
const log = (msg) => logs.push(msg);

/** 确定性假向量：按词的哈希累加成 32 维，语义相近的文本会被分到相近方向。 */
function fakeVector(text, dim = 32) {
  const vec = new Array(dim).fill(0);
  const words = String(text).toLowerCase().match(/[\u4e00-\u9fff]|[a-z0-9]+/g) ?? [];
  for (const word of words) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.codePointAt(0)) % 100000;
    vec[h % dim] += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, n) => sum + n * n, 0)) || 1;
  return vec.map((n) => n / norm);
}

function fakeFetchOpenAI({ fail = false } = {}) {
  return async (url, init) => {
    if (fail) throw new Error('connect ECONNREFUSED');
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: inputs.map((text) => ({ embedding: fakeVector(text) })) })
    };
  };
}

// 1. 去重用的归一化：大小写、空白、标点都不该造成重复条目
{
  assert.equal(normalizeForHash('  Hello, 世界！ '), 'hello世界');
  assert.equal(fingerprint('A b!'), fingerprint('a  b'));
  ok('normalizeForHash / fingerprint 忽略空白与标点');
}

// 2. 向量编码往返
{
  const vector = fakeVector('测试向量');
  const back = decodeVector(encodeVector(vector));
  assert.equal(back.length, vector.length);
  for (let i = 0; i < vector.length; i += 1) assert.ok(Math.abs(back[i] - vector[i]) < 1e-6);
  assert.ok(Math.abs(cosine(vector, vector) - 1) < 1e-6);
  ok('encodeVector/decodeVector 往返无损，cosine 自相似为 1');
}

// 3. 关键词打分：中文二元组命中
{
  assert.ok(keywordScore('北京 天气', '北京今天天气不错') > 0.9);
  assert.equal(keywordScore('北京 天气', '上海今天下雨'), 0);
  ok('keywordScore 对中文二元组有效');
}

// 4. 新增默认 pending，重复内容返回既有 id
{
  const store = createKnowledgeStore({ file, log });
  const a = store.add({ text: '用户「大肥鱼」是 QQ 机器人账号。', tags: ['账号', '身份'], source: 'chat', group: 'group:1019799335' });
  assert.equal(a.ok, true);
  assert.equal(a.item.status, KNOWLEDGE_STATUS.PENDING);
  const dup = store.add({ text: '用户「大肥鱼」是 QQ 机器人账号', source: 'web' });
  assert.equal(dup.ok, false);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.id, a.item.id);
  ok('新增条目进 pending，重复内容被识别');
}

// 5. 未批准的不进检索池；批准后进池
{
  const store = createKnowledgeStore({ file, log });
  const pending = await store.search('大肥鱼 账号');
  assert.equal(pending.length, 0);
  const id = store.list({ status: KNOWLEDGE_STATUS.PENDING })[0].id;
  const approved = await store.approve(id);
  assert.equal(approved.ok, true);
  const hit = await store.search('大肥鱼 账号');
  assert.ok(hit.length >= 1);
  assert.equal(hit[0].id, id);
  ok('pending 不参与检索，批准后立刻可检索');
}

// 6. private 条目只在来源会话可见
{
  const store = createKnowledgeStore({ file, log });
  store.add({ text: '群 1098011551 的口令是「芝麻开门」。', source: 'chat', group: 'group:1098011551', private: true });
  const id = store.list({ status: KNOWLEDGE_STATUS.PENDING })[0].id;
  await store.approve(id);
  const outside = await store.search('口令 芝麻开门', { key: 'group:1019799335' });
  assert.equal(outside.length, 0);
  const inside = await store.search('口令 芝麻开门', { key: 'group:1098011551' });
  assert.equal(inside.length, 1);
  ok('private 条目只在来源会话可见');
}

// 7. 向量模式：embedding 可用时走 vector，语义最近的排第一
{
  const embedder = createEmbedder({ backend: 'cloud', cloud: { baseUrl: 'http://fake/v1', model: 'fake-embed' }, fetchImpl: fakeFetchOpenAI() });
  const probe = await embedder.probe();
  assert.equal(probe.ok, true);
  assert.equal(probe.dim, 32);

  const file2 = path.join(tmpDir, 'knowledge-vector.json');
  const store = createKnowledgeStore({ file: file2, embedder, log, minScore: 0 });
  const a = store.add({ text: '用户喜欢用猫表情包', source: 'chat' });
  const b = store.add({ text: '这个群的群主叫小明', source: 'chat' });
  await store.approve(a.item.id);
  await store.approve(b.item.id);
  const hits = await store.search('猫 表情包 用户', { k: 2 });
  assert.equal(hits[0].id, a.item.id);
  assert.equal(hits[0].mode, 'vector');
  assert.ok(hits[0].score > hits[1].score);
  ok('向量检索按语义相似度排序（mode=vector）');
}

// 7b. 换模型但没重建：旧向量不得参与向量排序（同维度也不行），重建后恢复
{
  const mk = (model) => createEmbedder({
    backend: 'cloud', cloud: { baseUrl: 'http://fake/v1', model }, fetchImpl: fakeFetchOpenAI()
  });
  let current = mk('fake-embed-a');
  const fileSwap = path.join(tmpDir, 'knowledge-model-swap.json');
  const store = createKnowledgeStore({ file: fileSwap, embedder: current, getEmbedder: () => current, log, minScore: 0 });
  const a = store.add({ text: '群规是周日晚报备', source: 'chat' });
  await store.approve(a.item.id);
  assert.equal(store._raw()[0].embeddingModel, 'fake-embed-a');
  assert.equal((await store.search('周日晚报备 群规', { k: 1 }))[0].mode, 'vector');

  // 切到「同维度、不同名」的模型：旧向量必须被忽略
  current = mk('fake-embed-b');
  const swapped = await store.search('周日晚报备 群规', { k: 1 });
  assert.equal(swapped[0].mode, 'keyword', '换模型未重建时应退回关键词');
  assert.equal(swapped[0].text, '群规是周日晚报备');

  // 重建后回到向量模式
  const rebuilt = await store.reindex();
  assert.equal(rebuilt.done, 1);
  assert.equal(rebuilt.remaining, 0);
  assert.equal(store._raw()[0].embeddingModel, 'fake-embed-b');
  assert.equal((await store.search('周日晚报备 群规', { k: 1 }))[0].mode, 'vector');
  ok('换模型但未重建时旧向量被忽略，重建后恢复向量检索');
}

// 7c. reindex 单次有上限，必须回传还剩多少条
{
  const embedder = createEmbedder({ backend: 'cloud', cloud: { baseUrl: 'http://fake/v1', model: 'fake-embed' }, fetchImpl: fakeFetchOpenAI() });
  const fileMany = path.join(tmpDir, 'knowledge-many.json');
  const store = createKnowledgeStore({ file: fileMany, embedder, log, minScore: 0 });
  for (let i = 0; i < 3; i += 1) {
    const added = store.add({ text: `第 ${i} 条待重建事实`, source: 'chat' });
    await store.approve(added.item.id);
  }
  const partial = await store.reindex({ limit: 2 });
  assert.equal(partial.total, 2);
  assert.equal(partial.done, 2);
  assert.equal(partial.remaining, 1, '还有 1 条没处理，必须如实上报');
  ok('reindex 上报 remaining，超出单次上限不会假装已全量重建');
}

// 8. embedding 挂掉时自动退回关键词
{
  const embedder = createEmbedder({ backend: 'cloud', cloud: { baseUrl: 'http://fake/v1', model: 'fake-embed' }, fetchImpl: fakeFetchOpenAI({ fail: true }) });
  const file3 = path.join(tmpDir, 'knowledge-fallback.json');
  const store = createKnowledgeStore({ file: file3, embedder, log });
  const a = store.add({ text: '周三晚上有群活动', source: 'chat' });
  await store.approve(a.item.id);
  assert.equal(store._raw()[0].embedding, null);
  const hits = await store.search('周三 群活动');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].mode, 'keyword');
  ok('embedding 不可用时退回关键词检索');
}

// 9. 后端返回 Ollama 原生形状也能解析
{
  const embedder = createEmbedder({
    backend: 'local',
    local: { baseUrl: 'http://127.0.0.1:11434', model: 'nomic-embed-text' },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:11434/v1/embeddings');
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ embeddings: [fakeVector(body.input)] }) };
    }
  });
  const [vec] = await embedder.embed(['你好']);
  assert.equal(vec.length, 32);
  ok('本地端点自动补 /v1，兼容 {embeddings:[[...]]} 形状');
}

// 10. 合并：保留一条，其余标记 rejected
{
  const store = createKnowledgeStore({ file, log });
  store.add({ text: '这里周三有活动', source: 'chat' });
  store.add({ text: '周三晚上有活动', source: 'web' });
  const ids = store.list({ status: KNOWLEDGE_STATUS.PENDING }).map((item) => item.id);
  const merged = store.merge(ids, { text: '每周三晚上有群活动' });
  assert.equal(merged.ok, true);
  assert.equal(merged.merged, 2);
  const items = store._raw();
  assert.equal(items.filter((item) => item.status === KNOWLEDGE_STATUS.REJECTED).length, 1);
  assert.ok(items.some((item) => item.text === '每周三晚上有群活动'));
  ok('多条合并成一条，其余进 rejected');
}

// 11. 重建向量
{
  const embedder = createEmbedder({ backend: 'cloud', cloud: { baseUrl: 'http://fake/v1', model: 'fake-embed' }, fetchImpl: fakeFetchOpenAI() });
  const file4 = path.join(tmpDir, 'knowledge-reindex.json');
  const store = createKnowledgeStore({ file: file4, embedder, log });
  for (const text of ['甲知道密码', '乙喜欢猫', '丙在写代码']) {
    const added = store.add({ text, source: 'chat' });
    const approved = await store.approve(added.item.id);
    assert.equal(approved.embedded, true);
  }
  const result = await store.reindex();
  assert.equal(result.done, 3);
  assert.equal(store.stats().withVector, 3);
  ok('reindex 重新向量化已批准条目');
}

// 12. 持久化：重新加载后条目与状态都在
{
  const before = createKnowledgeStore({ file, log }).stats();
  const reloaded = createKnowledgeStore({ file, log });
  const after = reloaded.stats();
  assert.equal(after.total, before.total);
  assert.equal(after.approved, before.approved);
  assert.equal(after.pending, before.pending);
  ok('落盘后重新加载，状态一致');
}

// 13. 提示词块：空数组返回空串，超长截断
{
  assert.equal(buildKnowledgeBlock([]), '');
  const block = buildKnowledgeBlock([{ text: '事实一', tags: ['标签'] }], { maxChars: 200 });
  assert.ok(block.includes('事实一') && block.includes('标签'));
  const long = buildKnowledgeBlock([{ text: 'A'.repeat(300) }, { text: '第二条' }], { maxChars: 80 });
  assert.ok(!long.includes('第二条'));
  ok('buildKnowledgeBlock 空输入为空、超长会截断');
}

// 14. 内容超过上限、空内容被拒
{
  const store = createKnowledgeStore({ file: path.join(tmpDir, 'knowledge-limit.json'), log, maxEntries: 2 });
  assert.equal(store.add({ text: '   ' }).ok, false);
  assert.equal(store.add({ text: '一' }).ok, true);
  assert.equal(store.add({ text: '二' }).ok, true);
  const full = store.add({ text: '三' });
  assert.equal(full.ok, false);
  assert.match(full.error, /已满/);
  ok('空内容与超出容量被拒绝');
}

// 15. embedding 探测失败时给出可读原因
{
  const embedder = createEmbedder({ backend: 'cloud', cloud: { baseUrl: 'http://fake/v1', model: 'x' }, fetchImpl: fakeFetchOpenAI({ fail: true }) });
  const probe = await embedder.probe();
  assert.equal(probe.ok, false);
  assert.match(probe.error, /ECONNREFUSED/);
  const disabled = createEmbedder({ backend: 'off' });
  assert.equal(disabled.enabled, false);
  ok('probe 如实报告失败原因，off 模式为未启用');
}

// 16. publicItem 不泄露向量
{
  const item = { id: 'k_1', text: 'x', status: 'approved', embedding: 'AAAA', embeddingModel: 'm' };
  const pub = publicItem(item);
  assert.equal(pub.hasVector, true);
  assert.equal(pub.embedding, undefined);
  ok('publicItem 不返回向量本身');
}

// 17. 超期拦截归档：只动被拦截的，凭据全留，能放回待审
{
  const archiveFile = path.join(tmpDir, 'archive.json');
  const store = createKnowledgeStore({ file: archiveFile, log });
  const oldBlocked = store.add({ text: '超期拦截条目：某支付机构获牌。', source: 'chat' });
  store.markBlocked(oldBlocked.item.id, { reason: 'banned-term', hits: [{ term: '获牌', category: '其他风险' }] });
  // 把拦截时间改到 40 天前（模拟长期无人处理）
  const raw = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
  raw.items.find((item) => item.id === oldBlocked.item.id).autoBlocked.at = Date.now() - 40 * 86400000;
  fs.writeFileSync(archiveFile, JSON.stringify(raw), 'utf8');
  const reopened = createKnowledgeStore({ file: archiveFile, log });

  const fresh = reopened.add({ text: '刚拦下的条目：另一个机构获牌。', source: 'chat' });
  reopened.markBlocked(fresh.item.id, { reason: 'banned-term', hits: [] });
  const plainPending = reopened.add({ text: '仍在排队的普通事实：他偏好冰美式。', source: 'chat' });

  const swept = reopened.archiveStaleBlocked({ olderThanMs: 30 * 86400000 });
  assert.equal(swept.archived, 1, `应只归档超期的那 1 条，实际 ${swept.archived}`);
  const all = reopened.list({ limit: 50 });
  const archived = all.find((item) => item.id === oldBlocked.item.id);
  assert.equal(archived.status, 'rejected');
  assert.ok(archived.archivedAt > 0);
  assert.equal(archived.autoBlocked.hits[0].term, '获牌', '归档必须保留拦截凭据');
  assert.match(archived.note, /超期未确认/);
  assert.equal(all.find((item) => item.id === fresh.item.id).status, 'pending', '刚拦下的不该被归档');
  assert.equal(all.find((item) => item.id === plainPending.item.id).status, 'pending', '没被拦截的更不该被归档');
  const second = reopened.archiveStaleBlocked({ olderThanMs: 30 * 86400000 });
  assert.equal(second.archived, 0, `归档应幂等，第二次却归档了 ${second.archived} 条`);
  ok('超期拦截归档：只归档拦截项、凭据保留、幂等');
}

// 18. 归档条目可放回待审，拦截标记仍在
{
  const archiveFile2 = path.join(tmpDir, 'archive2.json');
  const store = createKnowledgeStore({ file: archiveFile2, log });
  const added = store.add({ text: '超期拦截条目：某支付机构获牌。', source: 'chat' });
  store.markBlocked(added.item.id, { reason: 'banned-term', hits: [] });
  const raw = JSON.parse(fs.readFileSync(archiveFile2, 'utf8'));
  raw.items.find((item) => item.id === added.item.id).autoBlocked.at = Date.now() - 40 * 86400000;
  fs.writeFileSync(archiveFile2, JSON.stringify(raw), 'utf8');
  const reopened = createKnowledgeStore({ file: archiveFile2, log });
  reopened.archiveStaleBlocked({ olderThanMs: 30 * 86400000 });
  const restored = reopened.restore(added.item.id);
  assert.equal(restored.ok, true);
  assert.equal(restored.item.status, 'pending');
  assert.ok(restored.item.autoBlocked, '放回待审后拦截标记必须还在');
  assert.ok(restored.item.restoredAt > 0);
  const again = reopened.restore(added.item.id);
  assert.equal(again.ok, false, '非归档条目不该能「放回」');
  ok('归档条目放回待审：拦截标记保留，非归档条目拒绝');
}

// 22. 采集直采：ingest 直接 approved + 写向量，不进待审
{
  const directFile = path.join(tmpDir, 'knowledge-direct.json');
  const embedder = createEmbedder({ backend: 'cloud', cloud: { baseUrl: 'https://fake.invalid/v1', apiKey: 'k', model: 'fake-embed' }, fetchImpl: fakeFetchOpenAI() });
  const store = createKnowledgeStore({ file: directFile, log, getEmbedder: () => embedder, maxEntries: 50 });
  const pack = '群聊片段（20:31，2 人 3 条）：张三：这版本数值怪；李四：卡池我抽到了；张三：晚上开黑';
  const result = await store.ingest({ text: pack, tags: ['聊天汇总'], source: 'chat', group: 'group:456', proposedBy: 'chat-collector', note: '自动采集' });
  assert.equal(result.ok, true);
  assert.equal(result.status, KNOWLEDGE_STATUS.APPROVED);
  assert.equal(result.blocked, false);
  assert.equal(result.embedded, true);
  const listed = store.list({ q: '数值怪' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, KNOWLEDGE_STATUS.APPROVED);
  assert.equal(listed[0].directIngested, true);
  assert.equal(listed[0].hasVector, true);
  assert.equal(store.stats().pending, 0, '直采不该留下待审条目');
  const hits = await store.search('这版本卡池抽到了吗');
  assert.ok(hits.some((hit) => hit.text.includes('数值怪')), '直采条目应可被向量检索命中');
  ok('直采：群聊片段直接 approved + 向量化，不进待审');
}

// 23. 直采也过违禁词闸门：命中只打标记、保持待审、不做向量
{
  const guardFile = path.join(tmpDir, 'knowledge-direct-guard.json');
  const store = createKnowledgeStore({
    file: guardFile,
    log,
    maxEntries: 50,
    scanItem: (item) => scanKnowledgeItem(item, { extraTerms: [] })
  });
  const banned = '群聊片段：张三：刷单日结，想做的私聊';
  const result = await store.ingest({ text: banned, tags: ['聊天汇总'], source: 'chat', group: 'group:456' });
  assert.equal(result.ok, true);
  assert.equal(result.blocked, true, '「刷单」必须在违禁词表里命中');
  assert.equal(result.embedded, false, '被拦截的条目不向量化');
  assert.equal(result.status, KNOWLEDGE_STATUS.PENDING, '被拦截条目留在待审');
  const item = store.list({ q: '刷单' })[0];
  assert.ok(item.autoBlocked, '拦截标记必须保留');
  ok('直采命中违禁词：留在待审且不向量化');
}

// 24. 库满时淘汰最旧直采条目，人工加的条目不动
{
  const evictFile = path.join(tmpDir, 'knowledge-direct-evict.json');
  const store = createKnowledgeStore({ file: evictFile, log, maxEntries: 3 });
  const manual = store.add({ text: '人工加的关键事实：群规禁止发广告', tags: ['群规'] });
  assert.equal(manual.ok, true);
  for (let i = 1; i <= 3; i += 1) {
    const res = await store.ingest({ text: `群聊片段第 ${i} 包：张三：今天第 ${i} 次聊开黑`, tags: ['聊天汇总'], source: 'chat', group: 'group:456' });
    assert.equal(res.ok, true, `第 ${i} 包应写入成功`);
  }
  const all = store.list({});
  assert.equal(all.length, 3, '库容量保持 maxEntries');
  assert.ok(all.some((item) => item.text.includes('群规禁止发广告')), '人工条目不能被直采挤掉');
  assert.ok(all.some((item) => item.text.includes('第 3 包')), '最新直采条目要保留');
  assert.ok(!all.some((item) => item.text.includes('第 1 包')), '最旧直采条目被淘汰');
  ok('库满优先淘汰最旧直采条目，人工条目不动');
}

console.log(`\n全部通过（${passed} 项）`);
fs.rmSync(tmpDir, { recursive: true, force: true });

{
  const now = Date.now();
  const ranked = rankHitsForContext([
    { text: '群聊片段（10-26 20:50，1 人 1 条）：[1] 甲：' + '闲聊'.repeat(80), score: 0.9, createdAt: now - 30 * 86400000 },
    { text: '群 1019799335 的管理员是 大肥鱼', score: 0.8, createdAt: now }
  ]);
  assert.equal(ranked[0].text.startsWith('群 1019799335'), true, '新事实应排到原始群聊片段前面');
  ok('上下文重排：原始群聊片段降权、近期短事实优先');
}
