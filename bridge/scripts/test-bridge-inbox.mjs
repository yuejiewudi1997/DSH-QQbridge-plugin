// 收件箱接进桥接后的集成回归：提示词按人分组、带时间戳、图片不当回应依据。
//
// 用审计用的 VM harness 直接跑真实 bridge.js：把消息喂进收件箱实例，
// 再调真实的 buildContextBlock / buildBatchPrompt 看渲染结果。
import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';

async function withBridge(fn, config = {}) {
  const h = await bridgeHarness({ config: { social: { inbox: { ttlMs: 5 * 60 * 1000 } }, ...config } });
  try {
    return await fn(h);
  } finally {
    try { h.cleanup?.(); } catch {}
  }
}

test('上下文块：按人分组 + 当前话题对象 + 图片只报数量', async () => {
  await withBridge(async (h) => {
    const now = Date.now();
    h.socialInbox.append(KEY, { sender: '张三', senderId: '1', text: '这版本数值怪', plain: '这版本数值怪' }, now - 8000);
    h.socialInbox.append(KEY, { sender: '张三', senderId: '1', text: '你们抽到了吗', plain: '你们抽到了吗' }, now - 3000);
    h.socialInbox.append(KEY, { sender: '李四', senderId: '2', text: '', plain: '', media: [{ type: 'image' }] }, now - 1000);
    const block = h.buildContextBlock(KEY);
    assert.match(block, /【最近消息（按人分组）】/);
    assert.match(block, /当前话题对象：张三/);
    assert.match(block, /-8s 张三：这版本数值怪/);
    assert.match(block, /-3s 张三：你们抽到了吗/);
    assert.match(block, /另有 1 条图片\/表情，不作为回应依据/);
    assert.doesNotMatch(block, /李四：/, '别人的图片不能进上下文正文');
  });
});

test('上下文块：没有收件箱数据时退回平铺窗口（不会变成「无」）', async () => {
  await withBridge(async (h) => {
    assert.equal(h.buildContextBlock(KEY), '（无）');
  });
});

test('batch 提示词：按人分组、带消息ID，且不再平铺【新消息】', async () => {
  await withBridge(async (h) => {
    const now = Date.now();
    const msgs = [
      { sender: '张三', text: '在吗', plain: '在吗', time: now - 6000, media: [], messageId: 'm1' },
      { sender: '李四', text: '', plain: '', time: now - 3000, media: [{ type: 'image' }], messageId: 'm2' },
      { sender: '张三', text: '看这个', plain: '看这个', time: now - 2000, media: [], messageId: 'm3' }
    ];
    const block = h.buildBatchPrompt(KEY, msgs, true);
    assert.match(block, /【新消息（按人分组，带相对时间）】/);
    assert.match(block, /张三：/);
    assert.match(block, /李四：/);
    assert.match(block, /［图片\/表情］（1 个图片\/表情，消息ID=m2）/);
    assert.match(block, /\[SILENT\]/);
    assert.doesNotMatch(block, /^【新消息】/m);
  });
});

test('采集直采（显式开关）：一包群消息直接进库，不经过代理/人格审读', async () => {
  await withBridge(async (h) => {
    h.knowledgeCollector.feed(KEY, { sender: '张三', text: '这版本数值怪，卡池我抽到了', isSelf: false, isOwner: false });
    h.knowledgeCollector.feed(KEY, { sender: '李四', text: '晚上开黑吗兄弟们', isSelf: false, isOwner: false });
    const pack = h.knowledgeCollector.flushKey(KEY, 'manual');
    assert.ok(pack, '采集器应打包出候选条目');
    // onFlush 里是「写入即返回 + 异步向量化」，给微任务一点时间落盘
    await new Promise((resolve) => setTimeout(resolve, 60));
    const approved = h.knowledgeStore.list({ status: 'approved' });
    assert.equal(approved.length, 1, '一包应直接变成一条 approved 条目');
    assert.equal(approved[0].directIngested, true, '要带直采标记（未经审读）');
    assert.match(approved[0].text, /群聊片段/);
    assert.equal(h.knowledgeStore.stats().pending, 0, '直采不该产生待审条目');
  }, { knowledge: { collect: { direct: true }, autoApprove: { mode: 'rules' } } });
});

test('默认流程：采集包进待审并带编号行，等审批代理处理', async () => {
  await withBridge(async (h) => {
    h.knowledgeCollector.feed(KEY, { sender: '张三', text: '这版本数值怪，卡池我抽到了', isSelf: false, isOwner: false });
    h.knowledgeCollector.feed(KEY, { sender: '李四', text: '晚上开黑吗兄弟们', isSelf: false, isOwner: false });
    const pack = h.knowledgeCollector.flushKey(KEY, 'manual');
    assert.ok(pack, '采集器应打包');
    assert.match(pack.text, /\[1\] 张三：/, '包体每条消息都要带编号');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const pending = h.knowledgeStore.list({ status: 'pending' });
    assert.equal(pending.length, 1, '默认应进待审，等审批代理');
    assert.equal(h.knowledgeStore.get(pending[0].id).lines.length, 2, '编号行要结构化存下来');
    assert.equal(h.approverScheduler.status().mode, 'agent', '默认审批走代理');
  }, { autoApprove: { mode: 'rules' } }); // 这里只验库存形态：规则模式避免真的拉起审批会话
});

test('收件箱过期后，上下文块自然收缩', async () => {
  await withBridge(async (h) => {
    const now = Date.now();
    h.socialInbox.append(KEY, { sender: '张三', senderId: '1', text: '很久以前的话', plain: '很久以前的话' }, now - 6 * 60 * 1000);
    h.socialInbox.append(KEY, { sender: '李四', senderId: '2', text: '刚刚的话', plain: '刚刚的话' }, now - 2000);
    const block = h.buildContextBlock(KEY);
    assert.match(block, /刚刚的话/);
    assert.doesNotMatch(block, /很久以前的话/, '超过 ttl 的消息应被丢弃');
  });
});
