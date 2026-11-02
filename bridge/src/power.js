// 定时「安全关闭 + 关机」的纯逻辑部分（不碰进程、不碰操作系统，方便离线单测）。
//
// 设计要点：
//  · 关机一定排在「安全关闭」之后 —— 要么由安全关闭流程在清理完成后调用 shutdown，
//    要么（未启用安全关闭时）才按自己的时间直接关机；
//  · 全部使用真实网络时间（由 bridge 传入 nowMs，时区与问候功能一致）；
//  · 默认全部关闭，避免误配置把机器关掉。

import { isValidClock, zonedParts } from './greetings.js';

export const POWER_DEFAULTS = Object.freeze({
  enabled: false,
  timeZone: 'Asia/Shanghai',
  safeCloseEnabled: false,
  safeCloseTime: '23:30',
  shutdownEnabled: false,
  shutdownTime: '23:40',
  // 安全关闭完成后再等多少秒才真正关机（给日志/落盘留时间）
  shutdownDelaySeconds: 60,
  shutdownReason: '每日定时关机',
  // 演练模式：到点只写日志、不真的关闭/关机（用于验证时间）
  dryRun: false,
  // 安全关闭后多少小时内不允许自愈拉起
  offHours: 10
});

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function clockMinutes(clock) {
  const m = CLOCK_RE.exec(String(clock ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function resolvePowerConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pickClock = (value, fallback) => (isValidClock(String(value ?? '')) ? String(value) : fallback);
  const delay = Number(src.shutdownDelaySeconds);
  return {
    enabled: src.enabled === true,
    timeZone: typeof src.timeZone === 'string' && src.timeZone.trim() ? src.timeZone.trim() : POWER_DEFAULTS.timeZone,
    safeCloseEnabled: src.safeCloseEnabled === true,
    safeCloseTime: pickClock(src.safeCloseTime, POWER_DEFAULTS.safeCloseTime),
    shutdownEnabled: src.shutdownEnabled === true,
    shutdownTime: pickClock(src.shutdownTime, POWER_DEFAULTS.shutdownTime),
    shutdownDelaySeconds: Number.isFinite(delay) ? Math.min(600, Math.max(10, Math.round(delay))) : POWER_DEFAULTS.shutdownDelaySeconds,
    shutdownReason: String(src.shutdownReason ?? POWER_DEFAULTS.shutdownReason).slice(0, 60),
    dryRun: src.dryRun === true,
    offHours: Number.isFinite(Number(src.offHours)) ? Math.min(72, Math.max(1, Math.round(Number(src.offHours)))) : POWER_DEFAULTS.offHours
  };
}

/**
 * 当天 wall clock 的下一次出现时间（毫秒）。Asia/Shanghai 无夏令时，直接按分钟差推进。
 * @returns {number}
 */
export function nextDailyAt(nowMs, timeZone, clock) {
  const minutes = clockMinutes(clock);
  if (minutes == null) throw new Error(`非法时间：${clock}`);
  const p = zonedParts(nowMs, timeZone);
  let delta = minutes - Number(p.minutes);
  if (delta <= 0) delta += 24 * 60;
  return nowMs + delta * 60000;
}

/**
 * 关闭锁判定：决定这次启动该「正常启动」还是「继续关闭」。
 *
 * 恢复优先级（按产品约定）：**重启 DSH 是首要恢复手段**。
 * 锁里记录了关闭时的 DSH 地址；新启动时地址变了 = DSH 已被重启 = 用户想恢复，
 * 于是解除锁。只有在同一个 DSH 里被自愈重新拉起时才会继续拦截。
 *
 * @returns {{action: 'start'|'block', reason: string}}
 */
export function evaluatePowerOffLock(lock, { nowMs = Date.now(), dshBaseUrl = '', force = false } = {}) {
  if (!lock || typeof lock !== 'object') return { action: 'start', reason: 'no-lock' };
  const until = Number(lock.until ?? 0);
  if (!Number.isFinite(until) || until <= 0 || nowMs >= until) return { action: 'start', reason: 'expired' };
  if (force) return { action: 'start', reason: 'forced' };
  const closedAt = String(lock.dshBaseUrl ?? '').trim();
  const current = String(dshBaseUrl ?? '').trim();
  if (closedAt && current && closedAt !== current) return { action: 'start', reason: 'dsh-restarted' };
  return { action: 'block', reason: 'locked' };
}

/**
 * 到点窗口判定：目标分钟数 <= 当前分钟数 <= 目标 + window（默认 30 分钟）。
 * 为什么需要它：`nextDailyAt` 永远返回「下一次」，过了目标点就滚到明天，
 * 用它做 `now >= at` 判定永远不会成立 —— 这就是「到点不触发」的根因。
 */
export function isWithinDailyWindow(nowMinutes, targetMinutes, windowMinutes = 30) {
  if (!Number.isFinite(nowMinutes) || !Number.isFinite(targetMinutes)) return false;
  const diff = nowMinutes - targetMinutes;
  return diff >= 0 && diff <= Math.max(1, windowMinutes);
}

/**
 * 计算这一轮的两个时间点与关机延迟。
 *
 * 规则（关机必须在安全关闭之后）：
 *  · 启用安全关闭：关机命令由安全关闭流程在清理完成后发出；延迟取
 *    「到 shutdownTime 还差多少秒」，若 shutdownTime 不晚于 safeCloseTime，就用 shutdownDelaySeconds；
 *  · 未启用安全关闭：关机按自己的 shutdownTime 到点执行，延迟 shutdownDelaySeconds。
 *
 * @returns {{safeCloseAtMs: number|null, shutdownAtMs: number|null, shutdownDelaySec: number|null, error: string}}
 */
export function computePowerPlan(conf, nowMs) {
  const c = resolvePowerConfig(conf);
  const result = { safeCloseAtMs: null, shutdownAtMs: null, shutdownDelaySec: null, error: '' };
  if (!c.enabled) return result;
  if (c.safeCloseEnabled && c.shutdownEnabled && clockMinutes(c.shutdownTime) === clockMinutes(c.safeCloseTime)) {
    // 同一时刻：先安全关闭，再按 shutdownDelaySeconds 关机
  }
  if (c.safeCloseEnabled) {
    result.safeCloseAtMs = nextDailyAt(nowMs, c.timeZone, c.safeCloseTime);
  }
  if (c.shutdownEnabled) {
    if (!c.safeCloseEnabled) {
      result.shutdownAtMs = nextDailyAt(nowMs, c.timeZone, c.shutdownTime);
      result.shutdownDelaySec = c.shutdownDelaySeconds;
    } else {
      // 关机由安全关闭流程触发：时间点就是安全关闭时间，延迟由两者时间差决定
      const closeMin = clockMinutes(c.safeCloseTime);
      const shutMin = clockMinutes(c.shutdownTime);
      const diffSec = shutMin > closeMin ? (shutMin - closeMin) * 60 : c.shutdownDelaySeconds;
      result.shutdownAtMs = result.safeCloseAtMs;
      result.shutdownDelaySec = diffSec;
    }
  }
  return result;
}

/**
 * 到点判定：返回这一 tick 应该执行的动作。
 * @param {object} plan computePowerPlan 的结果
 * @param {number} nowMs
 * @param {{date: string, safeCloseDone: boolean, shutdownIssued: boolean}} state
 * @param {string} date 当天日期（由调用方按时区算好）
 */
export function duePowerActions(plan, nowMs, state, date) {
  const s = state && typeof state === 'object' ? state : { date: '', safeCloseDone: false, shutdownIssued: false };
  const sameDay = s.date === date;
  const safeCloseDone = sameDay ? s.safeCloseDone === true : false;
  const shutdownIssued = sameDay ? s.shutdownIssued === true : false;
  const actions = { safeClose: false, shutdown: false };
  if (plan.safeCloseAtMs && nowMs >= plan.safeCloseAtMs && !safeCloseDone) actions.safeClose = true;
  if (plan.shutdownAtMs && nowMs >= plan.shutdownAtMs && !shutdownIssued) {
    // 有安全关闭时，关机必须等它完成；同一 tick 里先跑安全关闭，由安全关闭流程发关机命令。
    actions.shutdown = plan.safeCloseAtMs ? safeCloseDone : true;
  }
  return actions;
}
