// 联网搜索的来源策略：剔除国内 AI 灌水资讯站；游戏类查询优先论坛/社区。
//
// 需求背景：游戏版本/攻略/卡池这类问题，论坛里的玩家实测比资讯稿可靠；
// 而国内一批资讯站靠 AI 批量灌水（百家号、搜狐号、网易号、头条号、腾讯看点、
// 一点资讯这类），内容重复且经常是拼凑的二手结论，不该进模型上下文。
// 本文件只测纯函数，不访问网络。
import assert from 'node:assert/strict';
import test from 'node:test';
import { applySearchPolicy, hostPathOf, loadSearchConfig } from '../src/web-search.js';

const site = (url, title = 't') => ({ url, title, snippet: 's' });

const SLOP = [
  'https://baijiahao.baidu.com/s?id=123456',
  'https://www.sohu.com/a/7890123_120000',
  'https://www.163.com/dy/article/JABCDEF.html',
  'https://new.qq.com/omn/20260101/20260101A0ABCD.html',
  'https://www.toutiao.com/article/7345678901234567890/',
  'https://www.yidianzixun.com/article/0ABCDEFG',
  'https://k.sina.com.cn/article_1234567890_abcdef.html',
  'https://mini.eastday.com/a/260101000000000.html',
  'https://dayu.uc.cn/article/abc123.html',
];

test('hostPathOf 归一成「主机名+路径」并忽略端口/协议', () => {
  assert.equal(hostPathOf('https://www.sohu.com/a/1_2'), 'www.sohu.com/a/1_2');
  assert.equal(hostPathOf('http://NGABBS.COM/read.php?tid=1'), 'ngabbs.com/read.php');
  assert.equal(hostPathOf('https://example.com:8443/Path/To?q=1'), 'example.com/path/to');
  assert.equal(hostPathOf('not a url'), '');
  assert.equal(hostPathOf(undefined), '');
});

test('国内 AI 灌水资讯站整条丢弃', () => {
  const results = SLOP.map((url, index) => site(url, `slop-${index}`));
  const policy = applySearchPolicy(results, '原神 版本', loadSearchConfig(process.cwd()));
  assert.equal(policy.dropped, SLOP.length);
  assert.deepEqual(policy.results, []);
});

test('正常站点不会被误杀', () => {
  const results = [
    site('https://www.gamersky.com/news/202601/1234.shtml'),
    site('https://store.steampowered.com/app/1234/'),
    site('https://bbs.nga.cn/read.php?tid=999'),
    site('https://www.nexusmods.com/skyrimspecialedition/mods/1234'),
  ];
  const policy = applySearchPolicy(results, '老滚五 mod 推荐', loadSearchConfig(process.cwd()));
  assert.equal(policy.dropped, 0);
  assert.equal(policy.results.length, 4);
});

test('游戏类查询：论坛/社区结果排到前面，其余相对顺序不变', () => {
  const results = [
    site('https://www.gamersky.com/news/202601/1.shtml', 'media-1'),
    site('https://bbs.nga.cn/read.php?tid=1', 'nga-1'),
    site('https://store.steampowered.com/app/2/', 'steam-store'),
    site('https://tieba.baidu.com/p/123', 'tieba-1'),
    site('https://forum.gamer.com.tw/C.php?bsn=1', 'bahamut-1'),
  ];
  const policy = applySearchPolicy(results, '黑神话 攻略', loadSearchConfig(process.cwd()));
  assert.equal(policy.isGameQuery, true);
  assert.deepEqual(policy.results.map((r) => r.title), ['nga-1', 'tieba-1', 'bahamut-1', 'media-1', 'steam-store']);
});

test('非游戏查询不重排顺序', () => {
  const results = [
    site('https://www.gamersky.com/news/1.shtml', 'a'),
    site('https://bbs.nga.cn/read.php?tid=1', 'b'),
  ];
  const policy = applySearchPolicy(results, '明天天气怎么样', loadSearchConfig(process.cwd()));
  assert.equal(policy.isGameQuery, false);
  assert.deepEqual(policy.results.map((r) => r.title), ['a', 'b']);
});

test('灌水站 + 论坛混在一起：先剔除再重排', () => {
  const results = [
    site('https://baijiahao.baidu.com/s?id=1', 'slop'),
    site('https://bbs.nga.cn/read.php?tid=1', 'nga'),
    site('https://www.toutiao.com/article/1/', 'slop2'),
    site('https://www.gamersky.com/news/1.shtml', 'media'),
  ];
  const policy = applySearchPolicy(results, '艾尔登法环 平衡性', loadSearchConfig(process.cwd()));
  assert.equal(policy.dropped, 2);
  assert.deepEqual(policy.results.map((r) => r.title), ['nga', 'media']);
});

test('空结果 / 非法条目不会抛异常', () => {
  const policy = applySearchPolicy([null, { title: 'no url' }, undefined], '随便问问', loadSearchConfig(process.cwd()));
  assert.equal(policy.results.length, 3);
  assert.equal(policy.dropped, 0);
  assert.equal(applySearchPolicy(undefined, 'x', loadSearchConfig(process.cwd())).results.length, 0);
});

test('配置可覆盖名单：自定义 excludeHosts 生效，空数组沿用默认', () => {
  const config = loadSearchConfig(process.cwd());
  const custom = applySearchPolicy(
    [site('https://example.com/a'), site('https://baijiahao.baidu.com/s?id=1')],
    'x',
    { ...config, excludeHosts: ['example.com'] }
  );
  assert.deepEqual(custom.results.map((r) => r.title), ['t']); // baijiahao 不在自定义名单里，保留
  assert.equal(custom.dropped, 1);

  const fallback = applySearchPolicy(
    [site('https://baijiahao.baidu.com/s?id=1')],
    'x',
    { ...config, excludeHosts: [] }
  );
  assert.equal(fallback.dropped, 1, '空数组应回落到默认黑名单');
});

test('默认名单覆盖需求点名的几类资讯站', () => {
  const config = loadSearchConfig(process.cwd());
  const joined = config.excludeHosts.join('|');
  for (const host of ['baijiahao.baidu.com', 'sohu.com/a/', '163.com/dy/', 'toutiao.com', 'new.qq.com/omn/']) {
    assert.ok(joined.includes(host), `默认名单应包含 ${host}`);
  }
  const forums = config.gameForumHosts.join('|');
  for (const host of ['nga', 'tieba.baidu.com', 'gamer.com.tw', 'reddit.com']) {
    assert.ok(forums.includes(host), `论坛名单应包含 ${host}`);
  }
});
