// 定时问候（src/greetings.js）离线单测：配置归一化、到点判定、网络对时、
// 条目挑选、生成解析、条目存储。不联网、不建会话、不碰真实 state。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GREETING_DEFAULTS,
  resolveGreetingConfig,
  isValidClock,
  zonedParts,
  dueSlots,
  nextFireAt,
  parseHttpDate,
  createNetworkClock,
  pickEntry,
  normalizeEntry,
  parseGeneratedGreetings,
  buildGeneratePrompt,
  matchPoolImages,
  scoreImageForText,
  normalizePoolItem,
  buildDescribePoolPrompt,
  parsePoolDescriptions,
  createGreetingStore
} from '../src/greetings.js';

const TZ = 'Asia/Shanghai';

test('配置归一化：默认值、时间格式校验、目标过滤', () => {
  const c = resolveGreetingConfig({});
  assert.equal(c.enabled, false);
  assert.deepEqual(c.times, GREETING_DEFAULTS.times);
  assert.deepEqual(c.targets, []);
  assert.equal(c.windowMs, 300000);
  assert.equal(resolveGreetingConfig({ enabled: true }).enabled, true);
  assert.equal(isValidClock('08:30'), true);
  assert.equal(isValidClock('24:00'), false);
  assert.equal(isValidClock('8:30'), false);
  const c2 = resolveGreetingConfig({
    times: { morning: '07:05', noon: 'bad', evening: '23:59' },
    targets: ['group:1098011551', 'private:123456', 'group:abc', 'all'],
    windowMs: 1
  });
  assert.equal(c2.times.morning, '07:05');
  assert.equal(c2.times.noon, '12:00', '非法时间退回默认');
  assert.deepEqual(c2.targets, ['group:1098011551', 'private:123456']);
  assert.equal(c2.windowMs, 60000, '窗口有下限');
  assert.equal(c.imageMaxEdge, 260, '配图长边默认 260（QQ 聊天显示尺寸）');
  assert.equal(resolveGreetingConfig({ imageMaxEdge: 900 }).imageMaxEdge, 900);
  assert.equal(resolveGreetingConfig({ imageMaxEdge: 10 }).imageMaxEdge, 120, '配图长边有下限');
  assert.equal(resolveGreetingConfig({ imageMaxEdge: 99999 }).imageMaxEdge, 2048, '配图长边有上限');
});

test('时区墙钟：按时区取日期与 HH:MM', () => {
  const p = zonedParts(Date.parse('2026-10-27T00:30:00Z'), TZ);
  assert.equal(p.date, '2026-10-27');
  assert.equal(p.time, '08:30');
  assert.equal(p.minutes, 8 * 60 + 30);
});

test('到点判定：窗口内触发一次，窗口外不补发，已触发不重复', () => {
  const config = resolveGreetingConfig({ times: { morning: '08:30', noon: '12:00', evening: '21:00' } });
  const at = (iso) => Date.parse(iso);
  // 08:30 整（UTC 00:30）
  assert.deepEqual(dueSlots({ config, nowMs: at('2026-10-27T00:30:00Z'), firedToday: [] }).map((x) => x.slot), ['morning']);
  // 08:34:59 仍在 5 分钟窗口内
  assert.equal(dueSlots({ config, nowMs: at('2026-10-27T00:34:59Z'), firedToday: [] }).length, 1);
  // 08:35 已出窗口
  assert.equal(dueSlots({ config, nowMs: at('2026-10-27T00:35:00Z'), firedToday: [] }).length, 0);
  // 已经发过 morning 就不再触发
  assert.equal(dueSlots({ config, nowMs: at('2026-10-27T00:31:00Z'), firedToday: ['morning'] }).length, 0);
  // 中午
  assert.deepEqual(dueSlots({ config, nowMs: at('2026-10-27T04:00:30Z'), firedToday: [] }).map((x) => x.slot), ['noon']);
});

test('下一次触发时间：今天未到的第一条，全都过了就排到明天', () => {
  const config = resolveGreetingConfig({ times: { morning: '08:30', noon: '12:00', evening: '21:00' } });
  const now = Date.parse('2026-10-27T03:00:00Z'); // 11:00 上海
  const next = nextFireAt({ config, nowMs: now });
  assert.equal(new Date(next).toISOString(), '2026-10-27T04:00:00.000Z', '11:00 之后下一次是 12:00');
  const late = Date.parse('2026-10-27T15:00:00Z'); // 23:00 上海
  const tomorrow = nextFireAt({ config, nowMs: late });
  assert.ok(tomorrow > late);
});

test('HTTP Date 解析与网络对时：用响应头 Date 算偏移', async () => {
  assert.equal(parseHttpDate('Sun, 27 Oct 2026 03:00:00 GMT'), Date.parse('2026-10-27T03:00:00Z'));
  assert.equal(parseHttpDate('not a date'), null);
  let nowMs = Date.parse('2026-10-27T03:00:05Z');
  const fakeFetch = async () => ({
    headers: { get: () => 'Sun, 27 Oct 2026 03:00:00 GMT' }
  });
  const clock = createNetworkClock({ fetchImpl: fakeFetch, urls: ['https://example.com'], now: () => nowMs });
  const info = await clock.get();
  assert.equal(info.ok, true);
  assert.equal(info.source, 'https://example.com');
  assert.ok(info.skewMs < -4000 && info.skewMs > -6000, `偏移应约 -5s，实际 ${info.skewMs}`);
  const cur = await clock.current();
  assert.equal(cur.networkOk, true);
  assert.ok(cur.nowMs <= nowMs && cur.nowMs > nowMs - 10000);
});

test('网络对时失败：退回本机时钟且不抛错', async () => {
  const failing = async () => { throw new Error('offline'); };
  const clock = createNetworkClock({ fetchImpl: failing, urls: ['https://a.example', 'https://b.example'] });
  const cur = await clock.current();
  assert.equal(cur.networkOk, false);
  assert.equal(cur.source, 'local');
  assert.ok(Math.abs(cur.nowMs - Date.now()) < 5000);
});

test('挑条目：优先同时段，其次通用，只挑启用的', () => {
  const entries = [
    { id: 'a', slot: 'morning', text: '早', enabled: true },
    { id: 'b', slot: 'noon', text: '午', enabled: true },
    { id: 'c', slot: 'any', text: '通用', enabled: true },
    { id: 'd', slot: 'morning', text: '禁用的早', enabled: false }
  ];
  // pickEntry 内部用 Math.random 取池内一条：测试固定成第一条，避免偶发失败
  const first = () => 0;
  assert.equal(pickEntry(entries, 'morning', first).id, 'a', '同时段优先，且忽略禁用');
  assert.equal(pickEntry(entries, 'evening', first).id, 'c', '没有同时段就选通用');
  assert.equal(pickEntry(entries.filter((e) => e.slot !== 'any'), 'evening', first).slot, 'morning', '最后兜底任意可用');
  assert.equal(pickEntry([], 'morning', first), null);
});

test('生成解析：围栏/前后文/嵌套数组也能解析，去重并限条数', () => {
  const text = '好的，我来写：\n```json\n[{"slot":"morning","text":"早啊，今天也要加油"},'
    + '{"slot":"noon","text":"午饭吃了没"},{"slot":"evening","text":"早点休息"},'
    + '{"slot":"morning","text":"早啊，今天也要加油"}]\n```\n就这些。';
  const list = parseGeneratedGreetings(text, { limit: 10 });
  assert.equal(list.length, 3, '重复条目要去重');
  assert.deepEqual(list.map((x) => x.slot), ['morning', 'noon', 'evening']);
  assert.equal(parseGeneratedGreetings('没有 JSON').length, 0);
  assert.equal(parseGeneratedGreetings('{"slot":"noon","text":"单条对象"}').length, 1);
});

test('提示词：含条数、时段、角色、避免重复', () => {
  const prompt = buildGeneratePrompt({ count: 4, slots: ['morning', 'evening'], style: '轻微撒娇', role: '你是大肥鱼', avoid: ['早安'] });
  assert.match(prompt, /4 条/);
  assert.match(prompt, /morning/);
  assert.match(prompt, /evening/);
  assert.match(prompt, /大肥鱼/);
  assert.match(prompt, /轻微撒娇/);
  assert.match(prompt, /早安/);
  assert.match(prompt, /JSON 数组/);
});

test('条目存储：增改删、触发记账、按文件持久化', () => {
  const files = new Map();
  const store = createGreetingStore({ file: 'greetings.json', now: () => 1000 });
  store.bindWriter((file, state) => files.set(file, JSON.stringify(state)));
  store.load({ readFileSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  const added = store.upsert({ id: 'g1', slot: 'morning', text: '早', imagePath: 'assets/a.png' });
  assert.equal(added.enabled, true);
  assert.equal(store.entries().length, 1);
  store.upsert({ id: 'g1', slot: 'noon', text: '午', enabled: false });
  assert.equal(store.entries().length, 1);
  assert.equal(store.entries()[0].text, '午');
  store.markFired({ date: '2026-10-27', slot: 'noon', entryId: 'g1', target: 'group:1' });
  assert.deepEqual(store.firedToday('2026-10-27'), ['noon']);
  assert.equal(store.raw().lastFired.slot, 'noon');
  const saved = JSON.parse(files.get('greetings.json'));
  assert.equal(saved.entries[0].text, '午');
  store.remove('g1');
  assert.equal(store.entries().length, 0);

  const store2 = createGreetingStore({ file: 'x.json' });
  store2.load({ readFileSync: () => JSON.stringify({ entries: [{ id: 'g9', slot: 'any', text: '回来了' }] }) });
  assert.equal(store2.entries()[0].id, 'g9');
});

test('图池配图：模型选的优先，其次按文字贴合度，都不贴合就留空（不随机）', () => {
  const pool = [
    { path: 'assets/night.png', desc: '夜晚 月亮 睡觉' },
    { path: 'assets/lunch.png', desc: '午饭 吃饭' },
    'assets/plain.png'
  ];
  // 模型明确选了就照办，同图不重复用
  const chosen = matchPoolImages(pool, [
    { text: '晚上好，早点休息', image: 'assets/night.png' },
    { text: '晚上好，早点休息', image: 'assets/night.png' }
  ]);
  assert.equal(chosen.images[0], 'assets/night.png');
  assert.notEqual(chosen.images[1], 'assets/night.png');

  // 没选就按描述贴合度挑，而不是随机
  const auto = matchPoolImages(pool, [{ text: '中午了，午饭记得吃' }]);
  assert.equal(auto.images[0], 'assets/lunch.png');
  assert.equal(auto.assigned, 1);

  // 选了个不在池里的 path → 退化为贴合度，挑不出来就留空
  const invalid = matchPoolImages(['assets/plain.png'], [{ text: '完全无关', image: 'assets/ghost.png' }]);
  assert.equal(invalid.images[0], '');

  // 描述匹配权重高于文件名
  assert.ok(scoreImageForText('月亮', { path: 'x.png', desc: '月亮' }) > scoreImageForText('月亮', { path: 'moon.png', desc: '' }));
  assert.deepEqual(normalizePoolItem('a/b.png'), { path: 'a/b.png', desc: '' });
  assert.deepEqual(normalizePoolItem({ path: 'c.png', desc: '猫' }), { path: 'c.png', desc: '猫' });
});

test('图片池描述：解析模型 JSON 描述，只保留 allowed 的路径', () => {
  const raw = '好的，结果是：[{"path":"a.png","desc":"猫 打盹"},{"path":"b.png","desc":""},{"path":"c.png","desc":"月亮"}]';
  const out = parsePoolDescriptions(raw, { allowed: ['a.png', 'b.png'] });
  assert.deepEqual(out, [{ path: 'a.png', desc: '猫 打盹' }]);
  assert.match(buildDescribePoolPrompt(['a.png']), /图片池描述任务/);
  assert.deepEqual(parsePoolDescriptions('无'), []);
});

test('normalizeEntry：非法 slot 归 any，文字截断', () => {
  const e = normalizeEntry({ id: 'g2', slot: 'dawn', text: 'x'.repeat(500), enabled: false });
  assert.equal(e.slot, 'any');
  assert.equal(e.text.length, 400);
  assert.equal(e.enabled, false);
});
