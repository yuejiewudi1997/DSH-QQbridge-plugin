// 群聊收件箱（src/social-inbox.js）的离线回归。
//
// 需求背景：人格收到的消息要「按人分队列 + 按时间段过期」，
// 回复依据只看当前话题对象和时间间隔；中间别人插的图片不作为依据，
// 别人的文字要过话题相似度才带上。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INBOX_DEFAULTS,
  createSocialInbox,
  mediaKinds,
  resolveInboxOptions,
  textTokens,
  topicSimilarity
} from '../src/social-inbox.js';

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);
const T = (seconds) => T0 + seconds * 1000;

function msg(sender, text, at, extra = {}) {
  return { sender, text, plain: text, time: at, ...extra };
}

test('按发起人分队列：同一个人的多条消息落在同一条队列里', () => {
  const inbox = createSocialInbox();
  inbox.append('group:1', { sender: '张三', senderId: 'u1', text: '今晚开黑吗' }, T(0));
  inbox.append('group:1', { sender: '李四', senderId: 'u2', text: '我在加班' }, T(5));
  inbox.append('group:1', { sender: '张三', senderId: 'u1', text: '九点也行' }, T(10));
  const snap = inbox.snapshot('group:1', T(20));
  assert.equal(snap.total, 3);
  assert.equal(snap.focus.senderId, 'u1', '最后一条带文字的是张三');
  assert.deepEqual(snap.focus.items.map((item) => item.text), ['今晚开黑吗', '九点也行']);
  assert.equal(snap.others.length, 0, '李四那句和开黑无关，应被相似度过滤掉');
  assert.equal(snap.omittedText, 1);
});

test('过期内容逐步丢弃：超过 ttl 的消息不再出现', () => {
  const inbox = createSocialInbox({ ttlMs: 60 * 1000 });
  inbox.append('group:1', { sender: '张三', senderId: 'u1', text: '很早的一句' }, T(0));
  inbox.append('group:1', { sender: '李四', senderId: 'u2', text: '刚说的' }, T(70));
  const snap = inbox.snapshot('group:1', T(80));
  assert.equal(snap.total, 1);
  assert.equal(snap.focus.sender, '李四');
  assert.equal(inbox.snapshot('group:1', T(200)).total, 0);
});

test('话题对象取「最后一条带文字的人」，纯图片不抢话题', () => {
  const inbox = createSocialInbox();
  inbox.append('group:1', { sender: '张三', senderId: 'u1', text: '这版本数值怪' }, T(0));
  inbox.append('group:1', {
    sender: '李四', senderId: 'u2', text: '', plain: '', media: [{ type: 'image' }]
  }, T(5));
  const snap = inbox.snapshot('group:1', T(10));
  assert.equal(snap.focus.sender, '张三', '图片发送者不能把话题抢走');
  assert.equal(snap.focus.lastTextAt, T(0));
  assert.equal(snap.imageCount, 1);
});

test('别人的图片/表情不进上下文，只报数量', () => {
  const inbox = createSocialInbox();
  inbox.append('group:1', { sender: '张三', senderId: 'u1', text: '看这个' }, T(0));
  inbox.append('group:1', { sender: '李四', senderId: 'u2', text: '', plain: '', media: [{ type: 'sticker' }] }, T(1));
  inbox.append('group:1', { sender: '王五', senderId: 'u3', text: '', plain: '', media: [{ type: 'image' }, { type: 'image' }] }, T(2));
  const block = inbox.contextBlock('group:1', { now: T(10) });
  assert.match(block, /另有 3 条图片\/表情，不作为回应依据/);
  assert.doesNotMatch(block, /李四：/);
  assert.doesNotMatch(block, /王五：/);
});

test('别人的文字：话题相似才作背景，不相关直接丢', () => {
  const inbox = createSocialInbox();
  inbox.append('group:1', { sender: '张三', senderId: 'u1', text: '原神新版本卡池出了什么' }, T(0));
  inbox.append('group:1', { sender: '李四', senderId: 'u2', text: '今晚吃火锅还是烧烤' }, T(3));
  inbox.append('group:1', { sender: '王五', senderId: 'u3', text: '原神卡池我看是双五星' }, T(4));
  const snap = inbox.snapshot('group:1', T(10));
  const names = snap.others.map((item) => item.sender);
  assert.deepEqual(names, ['张三'], '只保留和当前话题（原神卡池）相关的那条');
  assert.equal(snap.omittedText, 1);
  const block = inbox.contextBlock('group:1', { now: T(10) });
  assert.match(block, /原神新版本卡池出了什么/);
  assert.doesNotMatch(block, /火锅/);
});

test('话题相似度是纯函数：同话题高分、不同话题接近 0', () => {
  assert.ok(topicSimilarity('原神新版本卡池出了什么', '原神卡池我看是双五星') >= 0.1);
  assert.ok(topicSimilarity('原神新版本卡池', '今晚吃火锅') < 0.05);
  assert.equal(topicSimilarity('', '随便'), 0);
  const tokens = textTokens('原神 卡池 v5.3');
  assert.ok(tokens.has('原神'));
  assert.ok(tokens.has('卡池'));
  assert.ok([...tokens].some((token) => token.startsWith('v5')));
});

test('上下文带相对时间戳，隔太久会提示「可能翻篇」', () => {
  const inbox = createSocialInbox({ focusWindowMs: 60 * 1000 });
  inbox.append('group:1', { sender: '张三', senderId: 'u1', text: '有人吗' }, T(0));
  inbox.append('group:1', { sender: '张三', senderId: 'u1', text: '那我先走了' }, T(180));
  const block = inbox.contextBlock('group:1', { now: T(400) });
  assert.match(block, /当前话题对象：张三/);
  assert.match(block, /-4m 张三：那我先走了/);
  assert.match(block, /（已 4m 没说话，可能已经翻篇）/);
});

test('新消息按人分组渲染，图片只写占位不写内容', () => {
  const inbox = createSocialInbox();
  const block = inbox.groupBlock([
    msg('张三', '你看这个', T(0)),
    { sender: '李四', text: '', plain: '', time: T(2), media: [{ type: 'image' }] },
    msg('张三', '笑死', T(4))
  ], { now: T(10) });
  assert.match(block, /张三：/);
  assert.match(block, /-10s 你看这个/);
  assert.match(block, /李四：/);
  assert.match(block, /［图片\/表情］/);
  assert.doesNotMatch(block, /画面|内容如下/);
});

test('容量上限：单人条数、会话人数、总条数都会被压住', () => {
  const inbox = createSocialInbox({ perSenderMax: 3, maxSenders: 2, maxTotal: 5, ttlMs: 60 * 60 * 1000 });
  for (let i = 0; i < 6; i += 1) inbox.append('group:1', { sender: '张三', senderId: 'u1', text: `第${i}条` }, T(i));
  assert.equal(inbox.snapshot('group:1', T(10)).focus.items.length, 3, '单人最多 3 条');

  inbox.append('group:1', { sender: '李四', senderId: 'u2', text: '李四的话' }, T(11));
  inbox.append('group:1', { sender: '王五', senderId: 'u3', text: '王五的话' }, T(12));
  const snap = inbox.snapshot('group:1', T(20));
  assert.ok(snap.total <= 5, '总条数不超过 5');
  const senders = new Set([snap.focus.sender, ...snap.others.map((item) => item.sender)]);
  assert.ok(senders.size <= 2, '最多保留两个人的队列');
});

test('清空与空会话：没有消息时上下文块为空', () => {
  const inbox = createSocialInbox();
  assert.equal(inbox.contextBlock('group:1', { now: T(0) }), '');
  inbox.append('group:1', { sender: '张三', senderId: 'u1', text: 'hi' }, T(0));
  assert.notEqual(inbox.contextBlock('group:1', { now: T(0) }), '');
  inbox.clear('group:1');
  assert.equal(inbox.contextBlock('group:1', { now: T(0) }), '');
});

test('配置可调：options() 支持热更新，非法值回落到默认', () => {
  let current = { ttlMs: 30 * 1000 };
  const inbox = createSocialInbox({ options: () => current });
  inbox.append('group:1', { sender: '张三', senderId: 'u1', text: '旧的' }, T(0));
  assert.equal(inbox.snapshot('group:1', T(31)).total, 0);

  const opts = resolveInboxOptions({ ttlMs: -5, topicMinSim: 9, maxSenders: 0 });
  assert.equal(opts.ttlMs, INBOX_DEFAULTS.ttlMs);
  assert.equal(opts.topicMinSim, 1);
  assert.equal(opts.maxSenders, 1);
});

test('媒体分类：图片/表情/视频都能识别，普通消息为空', () => {
  assert.deepEqual(mediaKinds([{ type: 'image' }, { type: 'sticker' }, { type: 'image' }]), ['image', 'sticker']);
  assert.deepEqual(mediaKinds([{ type: 'video' }]), ['video']);
  assert.deepEqual(mediaKinds([]), []);
  assert.deepEqual(mediaKinds(undefined), []);
});
