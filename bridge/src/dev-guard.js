// 开发者模式（原「静默模式」）的落盘闸门。
//
// 「拦截所有落盘」只拦 **AI/测试产生** 的内容（知识库、黑话、表情、反馈、活动/用量日志）；
// 桥接自身的配置、模式、会话映射照常保存 —— 否则一开开发者模式就重启失联，或者测试痕迹
// 反而因为「dev 开关自己也丢了」而无法收尾。
import path from 'node:path';

const BLOCKED_BASENAMES = new Set([
  'knowledge.json',
  'slang.json',
  'stickers.json',
  'feedback.json',
  'qq-activity.log',
  'token-usage.jsonl',
  'tool-calls.jsonl'
]);

let guardActive = false;

/** 由 bridge.js 在开发者模式开关变化 / 启动时同步设置。 */
export function setDevWriteGuard(active) {
  guardActive = Boolean(active);
}

export function devWriteGuardActive() {
  return guardActive;
}

export function isDevBlockedWrite(file) {
  return guardActive && BLOCKED_BASENAMES.has(path.basename(String(file)));
}
