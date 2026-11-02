// 自动批准代理：积压与拦截语义（不联网）
//
// 这条套件回答一个具体问题：被拦下来的条目堆起来之后，会不会被反复送审？
// 结论要由断言钉住：拦截条目不进候选、每轮都跳过、verify 一次都不调；
// 阈值只数「待处理」，积压再多也不会让每条新条目立刻触发一轮。

import { createAutoApprover } from '../src/knowledge-auto-approve.js';

let passed = 0;
let failed = 0;
const ok = (name) => { passed += 1; console.log(`✅ ${name}`); };
const fail = (name, detail) => { failed += 1; console.log(`❌ ${name} — ${detail}`); };
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

function makeStore(seed) {
  const items = seed.map((row, i) => ({ id: 'k' + i, status: 'pending', createdAt: 1000 + i, tags: [], ...row }));
  return {
    items,
    list: ({ status } = {}) => items.filter((i) => !status || i.status === status).map((i) => ({ ...i })),
    search: async () => [],
    approve: async (id) => {
      const item = items.find((i) => i.id === id);
      item.status = 'approved';
      return { ok: true };
    },
    markBlocked: (id, payload) => {
      const item = items.find((i) => i.id === id);
      if (!item) return { ok: false };
      item.autoBlocked = payload;
      return { ok: true };
    },
    pendingCount: () => items.filter((i) => i.status === 'pending').length
  };
}

const blocked = (n) => ({ text: `已拦截事实 ${n}：某支付机构获牌`, autoBlocked: { at: 1, reason: 'banned-term', hits: [] } });
const plain = (n) => ({ text: `普通人事实 ${n}：他偏好冰美式` });
const domain = (n) => ({ text: `浮点事实 ${n}：IEEE 754 双精度约 15 位有效数字` });

function makeAgent(store, { batchSize = 20, maxVerifyPerRun = 10, scanBlocked = false } = {}) {
  const counters = { verify: 0, judge: 0 };
  const agent = createAutoApprover({
    store,
    getConfig: () => ({
      enabled: true,
      batchSize,
      intervalMs: 60000,
      verify: { enabled: true, maxVerifyPerRun, kbDupScore: 0.95, judge: { enabled: true, timeoutMs: 25000, maxSources: 3 } }
    }),
    log: () => {},
    scan: () => ({ blocked: scanBlocked, hits: scanBlocked ? [{ term: '测试违禁词', category: '测试' }] : [] }),
    extractTerms: (text) => (/IEEE/.test(text) ? { terms: [{ term: 'IEEE 754' }], domains: ['计算机'] } : { terms: [], domains: [] }),
    verify: async () => {
      counters.verify += 1;
      return { verdict: 'unclear', reason: '测试：不确定', queries: ['q'], sources: [], checked: [], at: Date.now() };
    }
  });
  return { agent, counters };
}

// 1 + 2. 40 条已拦截、没有新条目：连跑 5 轮，一次都不该联网核实
{
  try {
    const store = makeStore(Array.from({ length: 40 }, (_, i) => blocked(i)));
    const { agent, counters } = makeAgent(store);
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await agent.run());
    assert(counters.verify === 0, `verify 被调用 ${counters.verify} 次，应为 0`);
    assert(results.every((r) => r.skipped === 'all-blocked'), `每轮都应是 all-blocked，实际 ${results.map((r) => r.skipped).join(',')}`);
    assert(store.pendingCount() === 40, '拦截条目应原样留在待审');
    ok('40 条已拦截、零新增：连跑 5 轮 verify 0 次，每轮都跳过');
  } catch (error) { fail('拦截条目不重送', error.message); }
}

// 3. 新增 3 条命中专业词：只各审一次，第二轮起不再动
{
  try {
    const store = makeStore([...Array.from({ length: 40 }, (_, i) => blocked(i)), ...Array.from({ length: 3 }, (_, i) => domain(i))]);
    const { agent, counters } = makeAgent(store, { batchSize: 1 });
    const first = await agent.run();
    assert(first.approved === 0 && first.blocked === 3, `第一轮应拦 3 条，实际放行${first.approved}/拦截${first.blocked}`);
    assert(counters.verify === 3, `第一轮 verify 应为 3 次，实际 ${counters.verify}`);
    for (let i = 0; i < 4; i += 1) await agent.run();
    assert(counters.verify === 3, `后续 4 轮不应再核实（累计 ${counters.verify} 次）`);
    assert(store.pendingCount() === 43, '应为 40 拦截 + 3 新拦');
    ok('每条新条目只被核实一次：verify 累计 3 次后不再增长');
  } catch (error) { fail('新条目只审一次', error.message); }
}

// 4. 阈值只数待处理：40 条拦截的积压不该让「只来 1 条新的」立刻触发一轮
{
  try {
    const store = makeStore([...Array.from({ length: 40 }, (_, i) => blocked(i)), domain(99)]);
    const { agent, counters } = makeAgent(store, { batchSize: 20 });
    const result = await agent.run();
    assert(result.skipped === 'below-threshold', `应因待处理不足而跳过，实际 ${result.skipped}`);
    assert(result.candidates === 1, `候选数应为 1，实际 ${result.candidates}`);
    assert(counters.verify === 0, `不应联网核实，实际 ${counters.verify} 次`);
    ok('40 条积压 + 1 条新增（阈值 20）：跳过，不触发');
  } catch (error) { fail('阈值只数待处理', error.message); }
}

// 5. 待处理够了就触发，且只处理待处理那部分
{
  try {
    const seed = [...Array.from({ length: 40 }, (_, i) => blocked(i)), ...Array.from({ length: 20 }, (_, i) => plain(i))];
    const store = makeStore(seed);
    const { agent } = makeAgent(store, { batchSize: 20 });
    const result = await agent.run();
    assert(result.ran === true, '应跑一轮');
    assert(result.approved === 20, `应放行 20 条，实际 ${result.approved}`);
    assert(store.pendingCount() === 40, `剩 40 条拦截，实际 ${store.pendingCount()}`);
    ok('积压 40 + 干净 20：触发一轮，只放行干净的那 20 条');
  } catch (error) { fail('足量时触发', error.message); }
}

// 6. 上一轮延后的条目下一轮接着做（不受阈值卡住）
{
  try {
    const store = makeStore(Array.from({ length: 3 }, (_, i) => domain(i)));
    // 阈值 3：刚好触发一次；每轮只核实 1 条 → 余下 2 条靠「延后续跑」在下一轮继续
    const { agent, counters } = makeAgent(store, { batchSize: 3, maxVerifyPerRun: 1 });
    const first = await agent.run();
    assert(first.deferred === 2, `第一轮应延后 2 条，实际 ${first.deferred}`);
    assert(counters.verify === 1, `第一轮只核实 1 条，实际 ${counters.verify}`);
    const second = await agent.run();
    assert(second.ran === true, `延后有剩余时应继续跑，实际 ${second.skipped ?? 'ran'}`);
    assert(counters.verify === 2, `第二轮应再核实 1 条，实际 ${counters.verify}`);
    ok('延后条目下一轮续跑：verify 逐轮 +1');
  } catch (error) { fail('延后续跑', error.message); }
}

// 7. 违禁词在核实之前就拦下，不进 verify
{
  try {
    const store = makeStore(Array.from({ length: 20 }, (_, i) => ({ text: `含违禁词的事实 ${i}：自行配置危险物`, ...{} })));
    const { agent, counters } = makeAgent(store, { batchSize: 20, scanBlocked: true });
    const result = await agent.run();
    assert(result.blocked === 20, `应拦 20 条，实际 ${result.blocked}`);
    assert(counters.verify === 0, `不应联网核实，实际 ${counters.verify}`);
    ok('违禁词先拦：20 条全拦，verify 0 次');
  } catch (error) { fail('违禁词不核实', error.message); }
}

// 8. 结果里带 candidates，控制台据此显示「待处理」数
{
  try {
    const store = makeStore([...Array.from({ length: 5 }, (_, i) => blocked(i)), plain(1)]);
    const { agent } = makeAgent(store, { batchSize: 1 });
    const result = await agent.run();
    assert(result.candidates === 1, `candidates 应为 1，实际 ${result.candidates}`);
    assert(result.pending === 6, `pending 应为 6，实际 ${result.pending}`);
    ok('结果带 candidates 计数（待处理 1 / 待审 6）');
  } catch (error) { fail('candidates 计数', error.message); }
}

console.log(failed === 0 ? `\n全部通过（${passed} 项）` : `\n${failed} 项失败（${passed} 项通过）`);
if (failed > 0) process.exit(1);
