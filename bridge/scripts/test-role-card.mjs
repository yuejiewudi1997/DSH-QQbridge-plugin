// 人格卡按仿真模式取用（src/role-card.js）的离线单测。
// 保证：模式标记能被正确识别与剥离、未标记的老卡片行为不变、真实人格卡可用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseRoleSections, roleHasModeTags, selectRoleText } from '../src/role-card.js';

const CARD = [
  '# 角色卡：测试',
  '',
  '## 一、你是谁',
  '- 你是群里的测试角色。',
  '',
  '## 二、分条方式 〔一代〕',
  '- 想分条就用空格分隔；想沉默就输出 [SILENT]。',
  '',
  '## 三、发言方式 〔二代〕',
  '- 用 qq_send_message 的数组分条，潜水走 qq_mark_read。',
  '',
  '## 四、说话风格',
  '- 简短、口语化。',
].join('\n');

test('模式标记能被识别，未标记的小节两种模式都注入', () => {
  const sections = parseRoleSections(CARD);
  const byHeading = Object.fromEntries(sections.filter((s) => s.heading).map((s) => [s.heading, s.mode]));
  assert.equal(byHeading['一、你是谁'], 'all');
  assert.equal(byHeading['二、分条方式'], 'v1');
  assert.equal(byHeading['三、发言方式'], 'v2');
  assert.equal(byHeading['四、说话风格'], 'all');
});

test('按模式筛选：只保留公共小节 + 该模式专属小节', () => {
  const v1 = selectRoleText(CARD, 'v1');
  const v2 = selectRoleText(CARD, 'v2');
  // 公共内容两边都有
  for (const text of [v1, v2]) {
    assert.match(text, /你是群里的测试角色/);
    assert.match(text, /简短、口语化/);
  }
  // 专属内容互不串场
  assert.match(v1, /空格分隔/);
  assert.doesNotMatch(v1, /qq_send_message/);
  assert.match(v2, /qq_send_message/);
  assert.doesNotMatch(v2, /\[SILENT\]/);
});

test('注入文本里不再残留模式标记', () => {
  assert.doesNotMatch(selectRoleText(CARD, 'v1'), /〔一代〕|〔二代〕/);
  assert.doesNotMatch(selectRoleText(CARD, 'v2'), /〔一代〕|〔二代〕/);
  // 标题保留但已清洗
  assert.match(selectRoleText(CARD, 'v2'), /## 三、发言方式\n/);
});

test('多种标记写法都认（[v1] / （reserved2） / 2 代）', () => {
  const card = [
    '## A [v1]', '- a',
    '## B （reserved2）', '- b',
    '## C 〔2 代〕', '- c',
    '## D [一代]', '- d',
  ].join('\n');
  const v1 = selectRoleText(card, 'v1');
  const v2 = selectRoleText(card, 'v2');
  assert.match(v1, /- a/); assert.match(v1, /- d/);
  assert.doesNotMatch(v1, /- b/); assert.doesNotMatch(v1, /- c/);
  assert.match(v2, /- b/); assert.match(v2, /- c/);
  assert.doesNotMatch(v2, /- a/); assert.doesNotMatch(v2, /- d/);
});

test('没有模式标记的老卡片：两种模式都完整注入（向后兼容）', () => {
  const legacy = '# 老卡\n\n- 性格：傲娇\n- 说话风格：简短';
  assert.equal(selectRoleText(legacy, 'v1'), legacy);
  assert.equal(selectRoleText(legacy, 'v2'), legacy);
});

test('标题之外的内容（前言）不受影响', () => {
  const card = '开头一句话\n\n## X 〔一代〕\n- x\n\n## Y\n- y';
  assert.match(selectRoleText(card, 'v2'), /开头一句话/);
  assert.doesNotMatch(selectRoleText(card, 'v2'), /- x/);
  assert.match(selectRoleText(card, 'v2'), /- y/);
});

test('控制台预览所需的长度与「分代内容」判断', () => {
  const v1 = selectRoleText(CARD, 'v1').length;
  const v2 = selectRoleText(CARD, 'v2').length;
  assert.ok(v1 < CARD.length && v2 < CARD.length, '筛选后应短于原文');
  assert.notEqual(v1, v2, '两代内容不同，长度不应相等');
  assert.equal(roleHasModeTags(CARD), true, '含模式标记的卡片应被标记出来');
});

test('CRLF 人格卡也能按标题分节（Windows 换行不会让模式标记失效）', () => {
  const card = [
    '## 一、你是谁',
    '- 通用人设',
    '## 二、分条方式 〔一代〕',
    '- 用空格分隔',
    '## 三、分条方式 〔二代〕',
    '- 用工具数组分条',
  ].join('\r\n');
  const sections = parseRoleSections(card);
  assert.equal(sections.filter((s) => s.heading).length, 3, 'CRLF 下标题必须被识别');
  const v1 = selectRoleText(card, 'v1');
  const v2 = selectRoleText(card, 'v2');
  assert.match(v1, /空格分隔/);
  assert.doesNotMatch(v1, /工具数组分条/);
  assert.match(v2, /工具数组分条/);
  assert.doesNotMatch(v2, /空格分隔/);
});

test('真实人格卡可用，且筛选不丢公共内容', () => {
  const file = new URL('../roles/蓝色大肥鱼.md', import.meta.url);
  const raw = fs.readFileSync(file, 'utf8');
  const v2 = selectRoleText(raw, 'v2');
  const v1 = selectRoleText(raw, 'v1');
  assert.ok(v2.length > 0 && v1.length > 0);
  // 人设部分两种模式都必须保留
  for (const text of [v1, v2]) {
    assert.match(text, /小鲸鱼/);
    assert.match(text, /AI 味|去 AI 味/);
  }
  // 二代注入的文本里不应再出现一代的分条机制
  assert.doesNotMatch(v2, /空格分隔（例如|\[SILENT\]/);
  // 真实人格卡没有分代小节：控制台不该给它挂「分代内容」标记，两种模式注入结果也应一致。
  assert.equal(roleHasModeTags(raw), false, '真实人格卡未使用模式标记');
  assert.equal(v1, v2, '无标记的人格卡在两种模式下注入内容应相同');
});

test('没有模式标记的卡片不算「分代内容」', () => {
  assert.equal(roleHasModeTags('# 老卡\n\n- 性格：傲娇'), false);
  assert.equal(roleHasModeTags(''), false);
});
