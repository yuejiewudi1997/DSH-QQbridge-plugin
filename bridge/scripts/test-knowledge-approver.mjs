// 知识审批代理（src/knowledge-approver.js）的离线单测：
// 并行扩缩容、包体编号/剥离、提示词、兜底裁决解析、调度器行为。
// 不建 DSH 会话、不联网、不碰真实 knowledge.json。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVER_DEFAULTS,
  resolveApproverOptions,
  planWorkers,
  splitBatch,
  packLines,
  rebuildPackText,
  buildAgentPrompt,
  parseVerdicts,
  createApproverScheduler
} from '../src/knowledge-approver.js';

const pack = {
  id: 'k_abc123',
  group: 'group:456',
  text: '群聊片段（20:31，2 人 3 条）：[1] 张三：这版本数值怪；[2] 李四：卡池我抽到了；[3] 张三：晚上开黑吗',
  lines: [
    { i: 1, sender: '张三', text: '这版本数值怪' },
    { i: 2, sender: '李四', text: '卡池我抽到了' },
    { i: 3, sender: '张三', text: '晚上开黑吗' }
  ]
};

test('默认值：走代理、批量 12、并行 4、积压阈值 50', () => {
  const opt = resolveApproverOptions({});
  assert.equal(opt.mode, 'agent');
  assert.equal(opt.batchSize, APPROVER_DEFAULTS.batchSize);
  assert.equal(opt.maxWorkers, 4);
  assert.equal(opt.backlogThreshold, 50);
  assert.equal(resolveApproverOptions({ mode: 'rules' }).mode, 'rules');
  assert.equal(resolveApproverOptions({ maxWorkers: 999 }).maxWorkers, 8, '非法值要被夹住');
  assert.equal(resolveApproverOptions({ batchSize: 0 }).batchSize, 1);
});

test('并行扩缩容：积压 ≥ 50 立刻拉满，空闲按 batchSize 最少开', () => {
  assert.equal(planWorkers({ pending: 0, busy: 0 }), 0);
  assert.equal(planWorkers({ pending: 5, busy: 0 }), 1, '5 包只需 1 个 worker');
  assert.equal(planWorkers({ pending: 5, busy: 1 }), 0, '已有 1 个在跑就不再开');
  // 60 包 ≥ 阈值：不等 2 个批次，直接开满 4 个
  assert.equal(planWorkers({ pending: 60, busy: 0 }), 4);
  assert.equal(planWorkers({ pending: 50, busy: 2 }), 2, '只补到双倍并行');
  assert.equal(planWorkers({ pending: 60, busy: 4 }), 0, '满了不再开');
  // 小积压、worker 处理慢：按需求量开
  assert.equal(planWorkers({ pending: 30, busy: 1, options: { batchSize: 12 } }), 2, '30 包需要 3 人，已 1 人再补 2');
  // 关掉就一个都不开
  assert.equal(planWorkers({ pending: 100, busy: 0, options: { enabled: false } }), 0);
});

test('批次切分：按 batchSize 等分且保序', () => {
  const ids = Array.from({ length: 5 }, (_, i) => ({ id: `k${i}` }));
  assert.deepEqual(splitBatch(ids, 2).map((batch) => batch.length), [2, 2, 1]);
  assert.deepEqual(splitBatch(ids, 2)[0].map((item) => item.id), ['k0', 'k1']);
  assert.deepEqual(splitBatch([], 3), []);
  assert.deepEqual(splitBatch(ids, 0).length, 5, '非法 size 退化为 1');
});

test('包体编号：优先用结构化 lines，老包按分号兼容解析', () => {
  assert.deepEqual(packLines(pack).map((line) => line.i), [1, 2, 3]);
  const legacy = packLines({ text: '群聊片段（10:00，2 人 2 条）：张三：A；李四：B' });
  assert.deepEqual(legacy, [{ i: 1, sender: '张三', text: 'A' }, { i: 2, sender: '李四', text: 'B' }]);
});

test('剥离：keepLines 只保留相关行并保留包头', () => {
  const kept = rebuildPackText(pack, [2]);
  assert.equal(kept, '群聊片段（20:31，2 人 3 条）：李四：卡池我抽到了');
  const all = rebuildPackText(pack, []);
  assert.equal(all, '群聊片段（20:31，2 人 3 条）：张三：这版本数值怪；李四：卡池我抽到了；张三：晚上开黑吗');
  assert.equal(rebuildPackText(pack, [99]), '', '不存在的行号剥完就是空');
});

test('提示词：带包 ID、编号行、批次与判断标准，不再明文下发审批令牌', () => {
  const prompt = buildAgentPrompt({ packs: [pack], batchTag: 'worker-1' });
  assert.match(prompt, /k_abc123/);
  // 正文刻意不内联：包体可能有几十行，逐包拼进提示词会让审批请求本身随聊天量线性膨胀。
  // 提示词只给元信息，并要求用 qq_knowledge_approver_pack 读编号行（该工具就是为此存在）。
  assert.match(prompt, /编号行/);
  assert.match(prompt, /qq_knowledge_approver_pack/);
  assert.doesNotMatch(prompt, /审批令牌|token|自动注入/i, '审批令牌由 MCP 自动注入，提示词里就不该出现这类字样');
  assert.match(prompt, /qq_knowledge_approver_verdict/);
  assert.match(prompt, /拒绝/);
  assert.match(prompt, /他人/);
  assert.match(prompt, /worker-1/);
});

test('兜底裁决解析：JSON 数组/单对象，非法内容不炸', () => {
  const text = '好的我处理了 [{"id":"k_abc","verdict":"reject","reason":"闲聊"},'
    + '{"id":"k_def","verdict":"keep","keepLines":[2]}] 完成';
  const verdicts = parseVerdicts(text);
  assert.equal(verdicts.length, 2);
  assert.equal(verdicts[0].verdict, 'reject');
  assert.equal(verdicts[1].keepLines[0], 2);
  assert.deepEqual(parseVerdicts('{"id":"k1","verdict":"keep"}').length, 1);
  assert.deepEqual(parseVerdicts('没有 JSON'), []);
  assert.deepEqual(parseVerdicts('{"broken":'), []);
  assert.deepEqual(parseVerdicts(JSON.stringify([{ id: 'k2', verdict: 'keep' }])).length, 1, 'JSON 数组字符串也要能解析');
});

test('调度器：积压 60 时一轮开 4 个 worker，完成后自动再巡检', async () => {
  let pending = 60;
  let spawned = 0;
  const started = [];
  const scheduler = createApproverScheduler({
    getPending: () => pending,
    listBatch: (limit) => Array.from({ length: Math.min(limit, 60) }, (_, i) => ({ id: `k${i}` })),
    getOptions: () => ({ maxWorkers: 4, batchSize: 10, backlogThreshold: 50 }),
    createWorker: async ({ id, batch }) => {
      spawned += 1;
      started.push(batch.length);
      pending = Math.max(0, pending - batch.length);
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
    log: () => {}
  });
  const first = await scheduler.tick();
  assert.equal(first.spawned, 4, '积压 60 必须立刻拉满并行');
  assert.equal(started.reduce((a, b) => a + b, 0), 40, '一轮最多推进 4×10 包');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(spawned >= 4);
  assert.equal(scheduler.status().busy, 0, 'worker 完成后 busy 归零');
});

test('调度器：规则模式/没积压时不动作', async () => {
  let calls = 0;
  const scheduler = createApproverScheduler({
    getPending: () => 100,
    listBatch: () => [{ id: 'k1' }],
    getOptions: () => ({ enabled: false }),
    createWorker: async () => { calls += 1; }
  });
  await scheduler.tick();
  assert.equal(calls, 0);
  assert.equal(scheduler.status().enabled, false);
});
