// 定时安全关闭 / 关机的离线单测：配置归一化、下一次时间、顺序保证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { computePowerPlan, duePowerActions, evaluatePowerOffLock, isWithinDailyWindow, nextDailyAt, resolvePowerConfig } from '../src/power.js';

const TZ = 'Asia/Shanghai';
// 2026-10-27 22:00:00 +08:00
const NOW = Date.parse('2026-10-27T22:00:00+08:00');

test('配置归一化：默认全关、时间校验、延迟夹取', () => {
  const c = resolvePowerConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.safeCloseEnabled, false);
  assert.equal(c.shutdownEnabled, false);
  assert.equal(c.safeCloseTime, '23:30');
  assert.equal(c.shutdownTime, '23:40');
  assert.equal(c.shutdownDelaySeconds, 60);

  const bad = resolvePowerConfig({ safeCloseTime: '25:00', shutdownTime: 'x', shutdownDelaySeconds: 9999 });
  assert.equal(bad.safeCloseTime, '23:30');
  assert.equal(bad.shutdownTime, '23:40');
  assert.equal(bad.shutdownDelaySeconds, 600);
});

test('nextDailyAt：今天未到 → 今天；已过/相等 → 明天', () => {
  const at23 = nextDailyAt(NOW, TZ, '23:00');
  assert.equal(new Date(at23).toISOString(), '2026-10-27T15:00:00.000Z');
  const at22 = nextDailyAt(NOW, TZ, '22:00');
  assert.equal(new Date(at22).toISOString(), '2026-10-28T14:00:00.000Z');
});

test('计划：关机排在安全关闭之后（时间更晚 → 延迟=时间差）', () => {
  const plan = computePowerPlan({
    enabled: true, safeCloseEnabled: true, safeCloseTime: '23:30',
    shutdownEnabled: true, shutdownTime: '23:40', shutdownDelaySeconds: 60
  }, NOW);
  assert.equal(plan.safeCloseAtMs, nextDailyAt(NOW, TZ, '23:30'));
  assert.equal(plan.shutdownAtMs, plan.safeCloseAtMs);
  assert.equal(plan.shutdownDelaySec, 600);
});

test('计划：关机时间早于安全关闭 → 用固定延迟，绝不提前关机', () => {
  const plan = computePowerPlan({
    enabled: true, safeCloseEnabled: true, safeCloseTime: '23:30',
    shutdownEnabled: true, shutdownTime: '23:00', shutdownDelaySeconds: 90
  }, NOW);
  assert.equal(plan.shutdownAtMs, plan.safeCloseAtMs);
  assert.equal(plan.shutdownDelaySec, 90);
});

test('计划：只开定时关机时按自己的时间执行', () => {
  const plan = computePowerPlan({
    enabled: true, safeCloseEnabled: false,
    shutdownEnabled: true, shutdownTime: '23:40', shutdownDelaySeconds: 30
  }, NOW);
  assert.equal(plan.safeCloseAtMs, null);
  assert.equal(plan.shutdownAtMs, nextDailyAt(NOW, TZ, '23:40'));
  assert.equal(plan.shutdownDelaySec, 30);
});

test('关闭锁：重启 DSH 是首要恢复方式，同一 DSH 内自愈仍会被拦', () => {
  const now = NOW;
  const lock = { at: now, until: now + 3600000, dshBaseUrl: 'http://127.0.0.1:50608' };
  // 同一个 DSH：拦截
  assert.deepEqual(evaluatePowerOffLock(lock, { nowMs: now, dshBaseUrl: 'http://127.0.0.1:50608' }),
    { action: 'block', reason: 'locked' });
  // DSH 重启（地址变化）：恢复
  assert.deepEqual(evaluatePowerOffLock(lock, { nowMs: now, dshBaseUrl: 'http://127.0.0.1:54741' }),
    { action: 'start', reason: 'dsh-restarted' });
  // 过期 / 强制 / 无锁
  assert.equal(evaluatePowerOffLock(lock, { nowMs: now + 7200000, dshBaseUrl: 'http://127.0.0.1:50608' }).reason, 'expired');
  assert.equal(evaluatePowerOffLock(lock, { nowMs: now, dshBaseUrl: 'http://127.0.0.1:50608', force: true }).reason, 'forced');
  assert.equal(evaluatePowerOffLock(null, { nowMs: now }).reason, 'no-lock');
});

test('到点窗口：目标分钟已过但未超窗口 → 命中；过期太久 → 不补触发', () => {
  assert.equal(isWithinDailyWindow(1410, 1410), true);
  assert.equal(isWithinDailyWindow(1415, 1410), true);
  assert.equal(isWithinDailyWindow(1440, 1410), true);
  assert.equal(isWithinDailyWindow(1250, 1410), false, '没到点不能触发');
  assert.equal(isWithinDailyWindow(1449, 1410), false, '超过 30 分钟窗口不补触发');
  assert.equal(isWithinDailyWindow(NaN, 1410), false);
});

test('到点判定：安全关闭未完成时绝不判关机', () => {
  const plan = computePowerPlan({
    enabled: true, safeCloseEnabled: true, safeCloseTime: '23:30',
    shutdownEnabled: true, shutdownTime: '23:40', shutdownDelaySeconds: 60
  }, NOW);
  const date = '2026-10-27';
  const before = duePowerActions(plan, plan.safeCloseAtMs - 1, { date, safeCloseDone: false, shutdownIssued: false }, date);
  assert.deepEqual(before, { safeClose: false, shutdown: false });

  const atClose = duePowerActions(plan, plan.safeCloseAtMs, { date, safeCloseDone: false, shutdownIssued: false }, date);
  assert.equal(atClose.safeClose, true);
  assert.equal(atClose.shutdown, false, '安全关闭必须先完成');

  const after = duePowerActions(plan, plan.safeCloseAtMs, { date, safeCloseDone: true, shutdownIssued: false }, date);
  assert.equal(after.shutdown, true);
});
