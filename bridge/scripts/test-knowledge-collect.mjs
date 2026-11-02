// 聊天采集 + 专业词 + 联网核实 + 代理处置 的自检。
// 不联网：搜索用假实现注入，专测「判定逻辑」和「边界行为」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeStore } from '../src/knowledge.js';
import { createKnowledgeCollector } from '../src/knowledge-collector.js';
import { createAutoApprover } from '../src/knowledge-auto-approve.js';
import { extractDomainTerms, DOMAIN_TERM_COUNT, DOMAIN_GROUPS } from '../src/domain-terms.js';
import { createVerifier, classifySource, pickVerifyTerms, VERIFY_PASS } from '../src/knowledge-verify.js';
import { createJudge, ruleJudge, parseJudgeReply, buildJudgePrompt, extractHardFacts } from '../src/knowledge-judge.js';
import { tavilySearch, mapTavilyResponse, isTavilyEnabled, loadSearchConfig } from '../src/web-search.js';
import { scanKnowledgeItem } from '../src/knowledge-guard.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log(`✅ ${name}`); };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbcollect-'));
const fileOf = (name) => path.join(tmpDir, name);
const logs = [];
const log = (msg) => logs.push(msg);
const offEmbedder = { enabled: false, mode: 'off', model: '', dim: 0, embed: async () => { throw new Error('off'); } };

// ── 1. 专业词库 ────────────────────────────────────────────────────────────
{
  assert.ok(DOMAIN_TERM_COUNT >= 1000, `专业词至少 1000 条，实际 ${DOMAIN_TERM_COUNT}`);
  assert.ok(DOMAIN_GROUPS.length >= 12, '领域应覆盖 12 类以上');
  const hit = extractDomainTerms('原神 3.2 版本上线了新角色，配装要参考 Python 脚本算的伤害。');
  const terms = hit.terms.map((entry) => entry.term);
  assert.ok(terms.includes('原神'), `应命中「原神」，实际 ${terms.join(',')}`);
  assert.ok(terms.includes('python'), `应命中 python，实际 ${terms.join(',')}`);
  // 英文词必须按词边界，不能把 capital 里的 api 当命中
  assert.equal(extractDomainTerms('a capital city story').terms.length, 0, '英文词不得子串误伤');
  assert.equal(extractDomainTerms('今天好热，笑死').terms.length, 0, '日常闲聊不应有专业词');
  ok(`专业词库 ${DOMAIN_TERM_COUNT} 条 / ${DOMAIN_GROUPS.length} 领域，提取与词边界正确`);
}

// ── 2. 采集器：只收他人文字、按分钟打包、上限 20 ──────────────────────────
{
  let clock = 1_700_000_000_000;
  const packs = [];
  const collector = createKnowledgeCollector({
    now: () => clock,
    getConfig: () => ({ enabled: true, windowMs: 60000, maxMessages: 20, minMessages: 3, minChars: 6, maxPacksPerHour: 60 }),
    onFlush: (pack) => { packs.push(pack); return true; },
    log
  });

  // 自己发的、命令、媒体占位、太短：全部丢弃
  assert.equal(collector.feed('group:1', { sender: '我', text: '这是我自己发的很长一句话', isSelf: true }).skipped, 'self');
  assert.equal(collector.feed('group:1', { sender: '甲', text: '/help' }).skipped, 'command');
  assert.equal(collector.feed('group:1', { sender: '甲', text: '[图片]' }).skipped, 'media-placeholder');
  assert.equal(collector.feed('group:1', { sender: '甲', text: '哈哈' }).skipped, 'too-short');
  assert.equal(packs.length, 0, '这些都该被丢掉');

  // 正常消息进缓冲
  collector.feed('group:1', { sender: '甲', text: '今晚八点群里有活动，记得来。' });
  collector.feed('group:1', { sender: '乙', text: '好的，我会准时到场的。' });
  assert.equal(collector.stats().buffered['group:1'], 2);
  // 不足 minMessages：这一分钟没有值得记的东西，窗口到点整包丢弃（不是留到下一分钟）
  clock += 61000;
  assert.deepEqual(collector.tick(), []);
  assert.equal(packs.length, 0, '不足 3 条应丢弃');
  assert.equal(collector.stats().buffered['group:1'], undefined, '丢弃后缓冲应清空');

  // 接下来这一分钟攒满 3 条 → 窗口到点打包
  collector.feed('group:1', { sender: '甲', text: '今晚八点群里有活动，记得来。' });
  collector.feed('group:1', { sender: '乙', text: '好的，我会准时到场的。' });
  collector.feed('group:1', { sender: '丙', text: '我也去，顺便带点吃的。' });
  clock += 61000;
  const flushed = collector.tick();
  assert.equal(flushed.length, 1, '窗口到点应打包一包');
  assert.equal(flushed[0].count, 3);
  assert.ok(flushed[0].text.includes('甲：') && flushed[0].text.includes('乙：') && flushed[0].text.includes('丙：'), '打包要保留发言人与原话');
  assert.equal(flushed[0].source, 'chat');
  assert.equal(flushed[0].key, 'group:1');
  assert.deepEqual(flushed[0].tags, ['聊天汇总']);
  ok('采集器丢弃自己/命令/媒体/短消息，窗口到点按发言人与原话打包');
}

// ── 3. 采集器：满 20 条立即打包，不等窗口 ─────────────────────────────────
{
  const packs = [];
  const collector = createKnowledgeCollector({
    now: () => 1_700_000_000_000,
    getConfig: () => ({ minMessages: 1, maxMessages: 20, minChars: 2 }),
    onFlush: (pack) => { packs.push(pack); return true; }
  });
  for (let i = 0; i < 19; i += 1) collector.feed('group:2', { sender: `群友${i}`, text: `这是第 ${i} 条足够长的消息内容` });
  assert.equal(packs.length, 0, '19 条还没到 20');
  const last = collector.feed('group:2', { sender: '群友19', text: '这是第 19 条足够长的消息内容' });
  assert.equal(last.flushed?.count, 20, '第 20 条应立即打包');
  assert.equal(packs.length, 1);
  ok('满 20 条立即打包（不等窗口结束）');
}

// ── 4. 采集器：每会话每小时封顶 ───────────────────────────────────────────
{
  let clock = 1_700_000_000_000;
  const packs = [];
  const collector = createKnowledgeCollector({
    now: () => clock,
    getConfig: () => ({ windowMs: 60000, minMessages: 1, minChars: 2, maxMessages: 100, maxPacksPerHour: 2 }),
    onFlush: (pack) => { packs.push(pack); return true; }
  });
  for (let round = 0; round < 4; round += 1) {
    collector.feed('group:3', { sender: '甲', text: `第 ${round} 轮的一条消息内容` });
    clock += 61000;
    collector.tick();
  }
  assert.equal(packs.length, 2, `每小时最多 2 包，实际 ${packs.length}`);
  assert.ok(collector.stats().hourLimited >= 2, '超限次数应被记录');
  ok('每会话每小时打包次数封顶');
}

// ── 5. 核实：来源分级 ─────────────────────────────────────────────────────
{
  assert.equal(classifySource('https://www.gov.cn/zhengce/x.html'), 'official');
  assert.equal(classifySource('https://www.moe.gov.cn/a.html'), 'official');
  assert.equal(classifySource('https://zh.wikipedia.org/wiki/原神'), 'wiki');
  assert.equal(classifySource('https://baike.baidu.com/item/x'), 'wiki');
  assert.equal(classifySource('https://bbs.example.com/t/1'), 'other');
  // 域名判不出来时看标题
  assert.equal(classifySource('https://ys.mihoyo.com/', '《原神》官方网站-米哈游'), 'official');
  assert.equal(classifySource('https://ys.mihoyo.com/', '玩家论坛'), 'other');
  ok('来源分级：gov/官媒=official、维基百科=wiki、标题含「官方」兜底 official');
}

// ── 6. 核实：四种判定 ─────────────────────────────────────────────────────
{
  const fakeSearch = (map) => async (term) => ({ provider: 'fake', results: map[term] ?? [] });
  const mk = (map) => createVerifier({ search: fakeSearch(map) });

  const official = await mk({ '国务院': [{ title: '国务院办公厅关于…的通知', url: 'https://www.gov.cn/zhengce/1.html' }] })
    .verify('x', { terms: [{ term: '国务院', domain: '时政新闻' }] });
  assert.equal(official.verdict, 'official');
  assert.ok(VERIFY_PASS.has(official.verdict));

  const wiki = await mk({ '原神': [{ title: '原神 - 维基百科', url: 'https://zh.wikipedia.org/wiki/原神' }] })
    .verify('x', { terms: [{ term: '原神', domain: '游戏' }] });
  assert.equal(wiki.verdict, 'wiki');

  const weak = await mk({ '冷聚变': [{ title: '冷聚变讨论帖 - 某论坛', url: 'https://bbs.example.com/a' }] })
    .verify('x', { terms: [{ term: '冷聚变', domain: '物理化学' }] });
  assert.equal(weak.verdict, 'weak');
  assert.equal(VERIFY_PASS.has(weak.verdict), false, 'weak 不得放行');

  const unknown = await mk({}).verify('x', { terms: [{ term: '不存在的东西', domain: '其他' }] });
  assert.equal(unknown.verdict, 'unknown');
  assert.equal(VERIFY_PASS.has(unknown.verdict), false, 'unknown 不得放行');
  ok('核实判定：official/wiki 放行，weak/unknown 拦截');
}

// ── 7. 核实：搜索抛错 → unknown（不能当成通过）────────────────────────────
{
  const verifier = createVerifier({ search: async () => { throw new Error('ECONNREFUSED'); } });
  const result = await verifier.verify('x', { terms: [{ term: 'Docker', domain: '编程开发' }] });
  assert.equal(result.verdict, 'unknown', '搜索失败必须判为无法证实');
  assert.ok(result.reason.includes('不可用') || result.reason.includes('失败'), result.reason);
  ok('搜索不可用 → unknown（拦截而不是放行）');
}

// ── 8. 核实：辟谣信号 → contradicted ──────────────────────────────────────
{
  const verifier = createVerifier({
    search: async () => ({ provider: 'fake', results: [{ title: '官方辟谣：某消息不实', url: 'https://www.gov.cn/1.html' }] })
  });
  const result = await verifier.verify('x', { terms: [{ term: '某消息', domain: '时政新闻' }] });
  assert.equal(result.verdict, 'contradicted', '辟谣信号优先级高于官方来源');
  ok('辟谣信号 → contradicted（即使同时有官方域名）');
}

// ── 9. 核实：同一词有缓存，不重复搜索 ────────────────────────────────────
{
  let calls = 0;
  const verifier = createVerifier({ search: async () => { calls += 1; return { results: [] }; } });
  await verifier.verify('x', { terms: [{ term: 'Redis', domain: '编程开发' }] });
  await verifier.verify('x', { terms: [{ term: 'Redis', domain: '编程开发' }] });
  assert.equal(calls, 1, '同一词两次核实应命中缓存');
  ok('核实结果按词缓存，不重复打搜索接口');
}

// ── 10. 代理：三条处置路径 + 延后 ─────────────────────────────────────────
{
  const store = createKnowledgeStore({ file: fileOf('flow.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  const verifier = createVerifier({
    search: async (term) => ({
      provider: 'fake',
      results: term === '原神'
        ? [{ title: '原神 - 维基百科', url: 'https://zh.wikipedia.org/wiki/原神' }]
        : [{ title: `${term} 使用讨论 - 某论坛`, url: 'https://bbs.example.com/x' }]
    })
  });
  const approver = createAutoApprover({
    store,
    getConfig: () => ({ enabled: true, batchSize: 2, verify: { enabled: true, maxVerifyPerRun: 5 } }),
    log,
    extractTerms: (text) => extractDomainTerms(text),
    verify: (text, options) => verifier.verify(text, options)
  });

  store.add({ text: '今天天气不错，适合出去走走。', source: 'chat', group: 'group:9' });         // 无专业词
  store.add({ text: '原神是米哈游开发的开放世界游戏。', source: 'chat', group: 'group:9' });    // wiki 放行
  store.add({ text: '某个冷门框架能让服务器快十倍。', source: 'chat', group: 'group:9' });      // 无专业词（词库未覆盖）
  store.add({ text: 'Docker 容器默认走 bridge 网络。', source: 'chat', group: 'group:9' });      // 只有杂站 → 拦

  const result = await approver.run();
  assert.equal(result.ran, true);
  assert.equal(result.byNoTerm, 2, `无专业词应走 byNoTerm，实际 ${JSON.stringify(result)}`);
  assert.equal(result.byWeb, 1, `wiki 应走 byWeb，实际 ${JSON.stringify(result)}`);
  assert.equal(result.blocked, 1, '只有杂站来源的应被拦');

  const blocked = store.list({ status: 'pending' })[0];
  assert.equal(blocked.autoBlocked.reason, 'unverified');
  assert.equal(blocked.verification.verdict, 'weak');
  assert.ok(blocked.autoBlocked.hits[0].term.toLowerCase() === 'docker');
  ok('代理处置：无专业词直批、wiki 放行、非权威来源拦截并留核实记录');
}

// ── 11. 代理：总闸关闭时不过核实，但仍过违禁词 ────────────────────────────
{
  const store = createKnowledgeStore({ file: fileOf('offverify.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  let verifyCalls = 0;
  const approver = createAutoApprover({
    store,
    getConfig: () => ({ enabled: true, batchSize: 1, verify: { enabled: false } }),
    log,
    extractTerms: (text) => extractDomainTerms(text),
    verify: async () => { verifyCalls += 1; return { verdict: 'unknown' }; }
  });
  store.add({ text: 'Docker 容器默认走 bridge 网络。', source: 'chat', group: 'group:8' });
  store.add({ text: '有人在群里推荐赌博网站。', source: 'chat', group: 'group:8' });
  const result = await approver.run();
  assert.equal(verifyCalls, 0, '关闭核实后不得联网');
  // 违禁条目在入库那一刻就被标记了，代理不会把它算进本轮拦截数——它本来就进不了候选
  const stillPending = store.list({ status: 'pending' });
  assert.equal(stillPending.length, 1, '违禁条目必须留在待审');
  assert.equal(stillPending[0].autoBlocked.reason, 'banned-term');
  assert.equal(result.approved, 1, '专业词内容在关闭核实后直接放行');
  ok('关闭联网核实时不搜索，但违禁词照拦');
}

// ── 12. 代理：每轮核实条数有上限，超出延后 ────────────────────────────────
{
  const store = createKnowledgeStore({ file: fileOf('defer.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  let verifyCalls = 0;
  const approver = createAutoApprover({
    store,
    getConfig: () => ({ enabled: true, batchSize: 1, verify: { enabled: true, maxVerifyPerRun: 2 } }),
    log,
    extractTerms: (text) => extractDomainTerms(text),
    verify: async () => { verifyCalls += 1; return { verdict: 'unknown', reason: 'fake', sources: [], queries: [] }; }
  });
  for (const word of ['Docker', 'Redis', 'Kubernetes', 'PostgreSQL']) {
    store.add({ text: `${word} 是常用的基础设施组件。`, source: 'chat', group: 'group:7' });
  }
  const first = await approver.run();
  assert.equal(first.deferred, 2, `应延后 2 条，实际 ${JSON.stringify(first)}`);
  assert.equal(verifyCalls, 2, '本轮只核实 2 条');
  const second = await approver.run({ force: true });
  assert.equal(second.deferred, 0, '第二轮应把剩下的处理完');
  ok('每轮核实条数有上限，超出留到下一轮（deferred）');
}

// ── 13. 代理：知识库已有同义内容 → 免核实直接批准 ─────────────────────────
{
  const store = createKnowledgeStore({ file: fileOf('dup.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  let verifyCalls = 0;
  const approver = createAutoApprover({
    store,
    getConfig: () => ({ enabled: true, batchSize: 1, verify: { enabled: true, maxVerifyPerRun: 5, kbDupScore: 0.75 } }),
    log,
    extractTerms: (text) => extractDomainTerms(text),
    verify: async () => { verifyCalls += 1; return { verdict: 'unknown' }; }
  });
  const first = store.add({ text: 'Docker 容器默认使用 bridge 网络。', source: 'chat', group: 'group:6' });
  await approver.run();
  // 第一条没有既有知识，会被核实并拦下（fake verify = unknown）
  assert.equal(verifyCalls, 1);
  // 人工把它批准，成为库内既有知识
  await store.approve(first.item.id);
  // 再来一条同义内容：应直接复用，不再核实
  store.add({ text: 'Docker 容器默认是用 bridge 网络。', source: 'chat', group: 'group:6' });
  const run = await approver.run({ force: true });
  assert.equal(run.byKnowledgeBase, 1, `应走知识库复用，实际 ${JSON.stringify(run)}`);
  assert.equal(verifyCalls, 1, '库内已有内容不得再联网核实');
  const approved = store.list({ status: 'approved', limit: 10 });
  const reused = approved.find((item) => item.verifiedBy === 'knowledge-base');
  assert.ok(reused, '应记录 verifiedBy=knowledge-base');
  assert.ok(reused.verification.duplicateOf, '应记录复用的是哪一条');
  ok('库内已有无歧义内容 → 免核实直接批准，并记录 duplicateOf');
}

// ── 14. 判定：JSON 解析容错 ───────────────────────────────────────────────
{
  assert.deepEqual(parseJudgeReply('{"verdict":"supported","confidence":0.9,"reason":"一致"}'),
    { verdict: 'supported', confidence: 0.9, reason: '一致' });
  const fenced = parseJudgeReply('```json\n{"verdict":"contradicted","reason":"辟谣"}\n```');
  assert.equal(fenced.verdict, 'contradicted', '代码块包裹要能剥掉');
  const chatty = parseJudgeReply('我认为结果是：{"verdict":"unclear","confidence":0.4,"reason":"没提到"} 以上。');
  assert.equal(chatty.verdict, 'unclear', '前后有闲聊也要能抠出 JSON');
  const loose = parseJudgeReply('verdict: supported');
  assert.equal(loose.verdict, 'supported', '裸写法也要认');
  assert.equal(parseJudgeReply('我不知道'), null, '完全无法解析应返回 null');
  assert.equal(parseJudgeReply('{"verdict":"maybe"}'), null, '非法 verdict 应返回 null');
  ok('判定回复解析：JSON/代码块/夹带/裸写法都认，垃圾输入返回 null');
}

// ── 15. 判定：规则兜底专查硬事实 ───────────────────────────────────────────
{
  const facts = extractHardFacts('原神 3.2 版本在 2026 年 1 月上线，涨了 30%');
  assert.ok(facts.includes('3.2'), `应抽出 3.2，实际 ${facts.join(',')}`);
  assert.ok(facts.some((f) => f.includes('2026')), '应抽年份');
  assert.ok(facts.some((f) => f.includes('%')), '应抽百分比');

  // 编造的版本号：来源里没有 3.2 → unclear
  const missing = ruleJudge({
    claim: '原神 3.2 版本上线了纳西妲。',
    sources: [{ title: '原神 - 维基百科', snippet: '原神是米哈游开发的开放世界游戏，已更新至 4.1 版本。', host: 'zh.wikipedia.org' }]
  });
  assert.equal(missing.verdict, 'unclear', `数字对不上必须判 unclear，实际 ${JSON.stringify(missing)}`);

  // 来源确实提到 3.2 → supported
  const hit = ruleJudge({
    claim: '原神 3.2 版本上线了纳西妲。',
    sources: [{ title: '原神 3.2 版本前瞻', snippet: '3.2 版本新增角色纳西妲。', host: 'ys.mihoyo.com' }]
  });
  assert.equal(hit.verdict, 'supported', JSON.stringify(hit));

  // 辟谣信号优先
  const debunk = ruleJudge({
    claim: '某地 12 月 5 日发生了地震。',
    sources: [{ title: '官方辟谣：网传地震消息不实', snippet: '', host: 'www.gov.cn' }]
  });
  assert.equal(debunk.verdict, 'contradicted');

  // 没有来源
  assert.equal(ruleJudge({ claim: '随便一句话', sources: [] }).verdict, 'unclear');
  ok('规则判定：数字/版本对不上→unclear，对得上→supported，辟谣→contradicted');
}

// ── 16. 判定：模型优先、失败降级到规则 ─────────────────────────────────────
{
  let asked = 0;
  let promptSeen = '';
  const judge = createJudge({
    ask: async (prompt) => { asked += 1; promptSeen = prompt; return '{"verdict":"supported","confidence":0.8,"reason":"来源一致"}'; }
  });
  const good = await judge.judge({ claim: 'A 是 B', sources: [{ title: 't', snippet: 's', host: 'h' }] });
  assert.equal(good.verdict, 'supported');
  assert.equal(good.source, 'model');
  assert.equal(asked, 1);
  assert.ok(promptSeen.includes('只输出一个 JSON'), '提示词必须约束输出格式');
  assert.ok(promptSeen.includes('A 是 B'), '提示词必须带待核实陈述');

  const broken = createJudge({ ask: async () => { throw new Error('模型挂了'); } });
  const degraded = await broken.judge({ claim: '原神 9.9 版本上线了纳西妲。', sources: [{ title: '原神 4.1', snippet: '4.1 版本', host: 'x.com' }] });
  assert.equal(degraded.source, 'rules(degraded)', '模型失败应降级到规则');
  assert.equal(degraded.verdict, 'unclear', '降级后仍要按硬事实判 unclear，不能放行');
  assert.equal(broken.stats().failed, 1);

  const disabled = createJudge({ getConfig: () => ({ enabled: false }) });
  assert.equal((await disabled.judge({ claim: 'x', sources: [{ title: 't' }] })).source, 'disabled');
  ok('判定器：模型优先、异常降级为规则且不放行、可关闭');
}

// ── 17. 核实 + 判定：有官方来源但来源不支持陈述 → 拦 ─────────────────────
{
  const verifier = createVerifier({
    search: async () => ({ provider: 'fake', results: [{ title: '国务院关于某事的通知', url: 'https://www.gov.cn/a.html', snippet: '内容与本条无关的公文' }] }),
    judge: async () => ({ verdict: 'unclear', reason: '来源没提到陈述细节', source: 'model' })
  });
  const result = await verifier.verify('国务院决定给每人发三万元现金。', { terms: [{ term: '国务院', domain: '时政新闻' }] });
  assert.equal(result.verdict, 'unclear', `来源可信但内容不支持时必须拦，实际 ${JSON.stringify(result)}`);
  assert.equal(VERIFY_PASS.has(result.verdict), false);
  assert.ok(result.judgement, '应保留判定记录供审计');
  ok('核实+判定：官方来源但内容不支持 → unclear 拦截（补上了只看域名的缺口）');
}

// ── 18. 核实 + 判定：判定矛盾时按 contradicted 拦 ─────────────────────────
{
  const verifier = createVerifier({
    search: async () => ({ provider: 'fake', results: [{ title: '辟谣：该消息不实', url: 'https://www.gov.cn/b.html' }] }),
    judge: async () => ({ verdict: 'contradicted', reason: '来源明确否认', source: 'model' }),
    getConfig: () => ({})
  });
  // 注意：搜索标题已含辟谣词时会在分级阶段就判 contradicted；这里换个不含辟谣词的标题，
  // 单独验证「判定模型给出的 contradicted 会被采纳」。
  const v2 = createVerifier({
    search: async () => ({ provider: 'fake', results: [{ title: '某地公告', url: 'https://www.gov.cn/c.html', snippet: '公告正文' }] }),
    judge: async () => ({ verdict: 'contradicted', reason: '公告内容与陈述相反', source: 'model' })
  });
  const result = await v2.verify('某地宣布永久取消所有考试。', { terms: [{ term: '公告', domain: '时政新闻' }] });
  assert.equal(result.verdict, 'contradicted');
  assert.equal(VERIFY_PASS.has(result.verdict), false);
  assert.ok(result.reason.includes('矛盾'), result.reason);
  ok('核实+判定：判定为矛盾 → contradicted 拦截');
}

// ── 19. 代理端到端：判定模型拦下「有来源但不支持」的条目 ────────────────
{
  const store = createKnowledgeStore({ file: fileOf('judgeflow.json'), embedder: offEmbedder, scanItem: scanKnowledgeItem, log });
  const verifier = createVerifier({
    search: async () => ({ provider: 'fake', results: [{ title: '原神 - 维基百科', url: 'https://zh.wikipedia.org/wiki/原神', snippet: '原神是米哈游开发的开放世界游戏，最新版本 4.1。' }] }),
    judge: async () => ({ verdict: 'unclear', reason: '来源未提及该版本角色', source: 'model' })
  });
  const approver = createAutoApprover({
    store,
    getConfig: () => ({ enabled: true, batchSize: 1, verify: { enabled: true, maxVerifyPerRun: 5 } }),
    log,
    extractTerms: (text) => extractDomainTerms(text),
    verify: (text, options) => verifier.verify(text, options)
  });
  store.add({ text: '原神 7.9 版本上线了能秒杀所有 boss 的角色。', source: 'chat', group: 'group:5' });
  const run = await approver.run();
  assert.equal(run.blocked, 1, `应被判定拦下，实际 ${JSON.stringify(run)}`);
  const pending = store.list({ status: 'pending' })[0];
  assert.equal(pending.autoBlocked.reason, 'unverified');
  assert.equal(pending.verification.judgement.verdict, 'unclear', '审计里要留下判定结论');
  ok('代理端到端：来源可信但判定不支持 → 打标拦截并记录 judgement');
}

// ── 20. 核实：搜索结果与查询无关 → unknown（不是 weak，更不是放行）──────
{
  const verifier = createVerifier({
    search: async () => ({ provider: 'fake', results: [
      { title: '哔哩哔哩 (゜-゜)つロ 干杯~', url: 'https://www.bilibili.com/', snippet: '国内知名的视频弹幕网站' },
      { title: 'BOSS直聘-找工作', url: 'https://www.zhipin.com/', snippet: '招聘求职平台' }
    ] })
  });
  const result = await verifier.verify('原神是米哈游开发的开放世界游戏。', {
    terms: [{ term: '原神', domain: '游戏' }]
  });
  assert.equal(result.verdict, 'unknown', `无关结果必须判 unknown，实际 ${JSON.stringify(result)}`);
  assert.equal(VERIFY_PASS.has(result.verdict), false);
  assert.ok(result.reason.includes('无关') || result.reason.includes('过滤'), result.reason);

  // 标题里有关键词的仍然算相关
  const good = createVerifier({
    search: async () => ({ provider: 'fake', results: [
      { title: '原神 - 维基百科', url: 'https://zh.wikipedia.org/wiki/原神', snippet: '开放世界游戏' }
    ] }),
    judge: async () => ({ verdict: 'supported', reason: '一致', source: 'model' })
  });
  const okResult = await good.verify('原神是米哈游开发的开放世界游戏。', { terms: [{ term: '原神', domain: '游戏' }] });
  assert.equal(okResult.verdict, 'wiki');
  ok('核实：搜索结果为无关站点 → unknown 拦截；标题命中关键词才算来源');
}

// ── 21. Tavily：响应映射（去重/低分过滤/只留 http）──────────────────────
{
  const mapped = mapTavilyResponse({
    results: [
      { title: 'A', url: 'https://a.com/1', content: '甲', score: 0.9 },
      { title: 'A dup', url: 'https://a.com/1', content: '重复', score: 0.8 },
      { title: '低分', url: 'https://b.com/2', content: '不相关', score: 0.05 },
      { title: '无协议', url: 'ftp://c.com/3', score: 0.9 },
      { title: '', url: 'https://d.com/4', content: '丁', score: 0.5 }
    ]
  }, { maxResults: 5, minScore: 0.2 });
  assert.equal(mapped.length, 2, `应只剩 2 条，实际 ${JSON.stringify(mapped)}`);
  assert.equal(mapped[0].snippet, '甲', 'content 要映射成 snippet');
  assert.equal(mapped[1].title, 'https://d.com/4', '标题为空时用 URL 兜底');
  assert.ok(mapped[0].score !== undefined, '分数要保留');
  ok('Tavily 响应映射：去重、丢低分、丢非 http、content→snippet');
}

// ── 22. Tavily：keyless / Bearer / 限流 / 凭据无效 ────────────────────────
{
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ results: [{ title: 'T', url: 'https://x.com', content: 's', score: 0.9 }] }) };
    };
    const keyless = await tavilySearch('原神', { tavily: { enabled: true, keyless: true } });
    assert.equal(keyless.length, 1);
    assert.equal(seen[0].headers['X-Tavily-Access-Mode'], 'keyless', '无 key 时必须走 keyless 头');
    assert.equal(seen[0].body.search_depth, 'basic');
    assert.ok(!seen[0].headers.Authorization);

    await tavilySearch('原神', { tavily: { enabled: true, apiKey: 'tvly-test', keyless: false } });
    assert.equal(seen[1].headers.Authorization, 'Bearer tvly-test', '有 key 时走 Bearer');
    assert.equal(seen[1].headers['X-Tavily-Access-Mode'], undefined, '有 key 时不带 keyless 头');

    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    let rateErr = '';
    try { await tavilySearch('x', { tavily: { enabled: true, keyless: true } }); } catch (e) { rateErr = String(e.message); }
    assert.ok(rateErr.includes('限流'), `限流要有可操作提示，实际 ${rateErr}`);

    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    let authErr = '';
    try { await tavilySearch('x', { tavily: { enabled: true, apiKey: 'bad' } }); } catch (e) { authErr = String(e.message); }
    assert.ok(authErr.includes('凭据无效'), authErr);

    globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
    let netErr = '';
    try { await tavilySearch('x', { tavily: { enabled: true, keyless: true } }); } catch (e) { netErr = String(e.message); }
    assert.ok(netErr.includes('Tavily 搜索失败'), netErr);
  } finally { globalThis.fetch = realFetch; }

  assert.equal(isTavilyEnabled({ tavily: { enabled: false } }), false, '关掉就不可用');
  assert.equal(isTavilyEnabled({ tavily: { enabled: true, keyless: true } }), true, 'keyless 也算可用');
  assert.equal(isTavilyEnabled({ tavily: { enabled: true, keyless: false, apiKey: '' } }), false, '无 key 且关 keyless 不可用');
  ok('Tavily 请求：keyless 头、Bearer、429 限流提示、401 凭据、网络错误');
}

// ── 23. 搜索配置解析：provider 与 tavily 段来自 config.json ──────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kbc-'));
  const write = (obj) => fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(obj), 'utf8');
  write({ webSearch: { provider: 'tavily', tavily: { enabled: true, apiKey: 'tvly-x', keyless: false, minScore: 0.4, maxResults: 4 } } });
  const parsed = loadSearchConfig(root);
  assert.equal(parsed.provider, 'tavily');
  assert.equal(parsed.tavily.apiKey, 'tvly-x');
  assert.equal(parsed.tavily.keyless, false);
  assert.equal(parsed.tavily.minScore, 0.4);
  assert.equal(parsed.tavily.maxResults, 4);

  write({ webSearch: { provider: '乱填' } });
  assert.equal(loadSearchConfig(root).provider, 'auto', '未知 provider 必须退回 auto');
  assert.equal(loadSearchConfig(root).tavily.enabled, true, '缺省时 Tavily 默认开');
  fs.rmSync(root, { recursive: true, force: true });
  ok('搜索配置：provider 解析、tavily 段读取、未知值退回 auto');
}

// ── 24. 核实：多个查询词的结果轮转合并，判定模型能看到每个词 ─────────────
{
  let judgedSources = [];
  const verifier = createVerifier({
    search: async (term) => ({
      provider: 'fake',
      results: term === '甲'
        ? [1, 2, 3, 4, 5, 6].map((i) => ({ title: `甲 条目${i}`, url: `https://zh.wikipedia.org/wiki/甲${i}`, snippet: '内容' }))
        : [{ title: '乙 条目', url: 'https://zh.wikipedia.org/wiki/乙', snippet: '内容' }]
    }),
    judge: async ({ sources }) => {
      judgedSources = sources;
      return { verdict: 'supported', reason: '一致', source: 'model' };
    },
    getConfig: () => ({ maxQueries: 2 })
  });
  // 陈述短于 4 字时不发整句检索，正好测纯逐词轮转
  const result = await verifier.verify('甲乙。', {
    terms: [{ term: '甲', domain: '游戏' }, { term: '乙', domain: '游戏' }]
  });
  assert.ok(judgedSources.some((s) => s.url === 'https://zh.wikipedia.org/wiki/乙'),
    `第二个查询词的结果必须送到判定，实际 ${JSON.stringify(judgedSources.map((s) => s.url))}`);
  assert.ok(judgedSources.some((s) => s.url.includes('/甲')), '第一个词的结果也要在');
  assert.equal(judgedSources[0].url, 'https://zh.wikipedia.org/wiki/甲1', '轮转：先甲后乙');
  assert.equal(judgedSources[1].url, 'https://zh.wikipedia.org/wiki/乙', '轮转：第二条就是乙');
  assert.ok(!result.checked.some((entry) => entry.kind === 'claim'), '短陈述不发整句检索');

  // 长陈述要发一次整句检索（语义后端靠它命中「官方文档里那一句」）
  const withClaim = createVerifier({
    search: async () => ({ provider: 'fake', results: [{ title: '甲 条目', url: 'https://zh.wikipedia.org/wiki/甲', snippet: '内容' }] }),
    judge: async () => ({ verdict: 'supported', reason: '一致', source: 'model' })
  });
  const claimRun = await withClaim.verify('甲是一种被广泛使用的技术。', { terms: [{ term: '甲', domain: '编程开发' }] });
  assert.ok(claimRun.checked.some((entry) => entry.kind === 'claim'), '长陈述应发整句检索');
  assert.ok(claimRun.queries.includes('甲是一种被广泛使用的技术。'), '整句要进 queries 审计');
  assert.equal(claimRun.verdict, 'wiki');
  ok('核实：多词结果轮转合并，判定模型不会只看到第一个词的结果');
}

// ── 25. 人格联网回复豁免：查过网才入库，且必须人工放行 ────────────────────
{
  // 25a. 没有搜索凭据 → 和以前一样丢弃
  {
    let flushed = 0;
    const collector = createKnowledgeCollector({
      getConfig: () => ({ enabled: true, minChars: 4 }),
      onFlush: () => { flushed += 1; return true; },
      log
    });
    const res = collector.feedReply('group:7', { text: '这是我凭印象说的一个事实。', queries: [] });
    assert.equal(res.ok, false);
    assert.equal(res.skipped, 'no-search');
    assert.equal(flushed, 0, '没有搜索凭据不得入库');
    assert.equal(collector.stats().replyDropped, 1);
    ok('豁免：没有搜索凭据的 AI 回复照旧丢弃');
  }

  // 25b. 有搜索凭据 → 作为独立候选交出（不打包、不入缓冲）
  {
    const packs = [];
    const store = createKnowledgeStore({ file: fileOf('exempt.json'), embedder: offEmbedder, log });
    const collector = createKnowledgeCollector({
      getConfig: () => ({ enabled: true, minChars: 4 }),
      onFlush: (pack) => {
        packs.push(pack);
        const added = store.add({
          text: pack.text, tags: pack.tags, source: pack.source, group: pack.group,
          proposedBy: pack.exempt ? 'web-reply' : 'chat-collector', note: pack.note, exempt: pack.exempt
        });
        return added.ok;
      },
      log
    });
    const res = collector.feedReply('group:7', {
      text: '原神是米哈游开发的开放世界游戏。',
      queries: ['原神 米哈游', '原神 开放世界']
    });
    assert.equal(res.ok, true, `带凭据的回复应入库，实际 ${JSON.stringify(res)}`);
    assert.equal(packs.length, 1);
    assert.deepEqual(packs[0].tags, ['联网回复']);
    assert.equal(packs[0].exempt.kind, 'web-search');
    assert.deepEqual(packs[0].exempt.queries, ['原神 米哈游', '原神 开放世界']);
    assert.equal(packs[0].source, 'chat');
    assert.equal(collector.stats().buffered['group:7'], undefined, '豁免回复不进群聊缓冲');
    const stored = store.list({ status: 'pending' })[0];
    assert.ok(stored.exempt, 'store 必须保留豁免凭据');
    assert.deepEqual(stored.exempt.queries, ['原神 米哈游', '原神 开放世界']);
    ok('豁免：查过网的回复单独入库并携带查询凭据');
  }

  // 25c. 豁免条目绕过自动批准，留在待审
  {
    const store = createKnowledgeStore({ file: fileOf('exempt-auto.json'), embedder: offEmbedder, log });
    store.add({ text: '普通群聊说法，需要核实。', source: 'chat', group: 'group:9' });
    store.add({
      text: '原神是米哈游开发的开放世界游戏。',
      source: 'chat', group: 'group:9', proposedBy: 'web-reply',
      exempt: { kind: 'web-search', queries: ['原神 米哈游'], at: Date.now() }
    });
    const verifier = createVerifier({
      search: async () => ({ provider: 'fake', results: [{ title: '原神 维基', url: 'https://zh.wikipedia.org/wiki/原神', snippet: '原神是米哈游开发的开放世界游戏。' }] }),
      judge: async () => ({ verdict: 'supported', reason: '一致', source: 'model' })
    });
    const approver = createAutoApprover({
      store,
      getConfig: () => ({ enabled: true, batchSize: 1, verify: { enabled: true, maxVerifyPerRun: 5 } }),
      log,
      extractTerms: (text) => extractDomainTerms(text),
      verify: (text, options) => verifier.verify(text, options)
    });
    const result = await approver.run({ force: true });
    assert.equal(result.exempt, 1, `结果里应报告豁免条数，实际 ${JSON.stringify(result)}`);
    const pending = store.list({ status: 'pending' });
    assert.equal(pending.length, 1, '豁免条目必须还留在待审');
    assert.ok(pending[0].exempt, '留下的正是豁免条目');
    assert.equal(pending[0].status, 'pending');
    assert.equal(pending[0].autoApproved ?? null, null, '豁免条目不得被自动批准');
    ok('豁免：自动批准代理跳过豁免条目，只报数量，交人工');
  }
}

console.log(`\n全部通过（${passed} 项）`);
