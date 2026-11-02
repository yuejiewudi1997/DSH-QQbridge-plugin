// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from './preset-prompt.js';
import { roleHasModeTags, selectRoleText } from './role-card.js';
import { createSocialInbox, topicSimilarity } from './social-inbox.js';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, at, chain, image, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken, isLoopbackBase } from './dsh-client.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { compactModelMessage, describeAge } from './qq-model-view.js';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import { normalizeImageForModel, normalizeImageForSend, normalizeStickerForSend } from './media-normalize.js';
import { AUDIO_EXTS, cleanupTemp, describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume, resolveAudioProcessing, resolveAudioSource, safeJoinLibrary } from './send-voice-lib.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { setDevWriteGuard, isDevBlockedWrite } from './dev-guard.js';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { resolvePriceTable } from './model-prices.js';
import { createTokenLedger } from './token-ledger.js';
import {
  PERSONA_RUNTIME_DEFAULTS,
  resolvePersonaRuntimeConfig,
  composeSystemPrompt,
  composeUserPrompt,
  composeTopicUserPrompt,
  didTopicReplySend,
  computePersonaPackSize,
  shouldRebuildContext,
  claimTasks,
  buildSnapshot,
  sortTasksNewestFirst,
  isSelfOnlyMemoryText
} from './persona-runtime.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  SLANG_STATUS,
  SLANG_MAX_ENTRIES
} from './slang-learner.js';
import { createEmbedder, createKnowledgeStore, buildKnowledgeBlock, rankHitsForContext, KNOWLEDGE_STATUS } from './knowledge.js';
import { scanKnowledgeItem, BANNED_TERM_COUNT } from './knowledge-guard.js';
import { createAutoApprover } from './knowledge-auto-approve.js';
import { createKnowledgeCollector } from './knowledge-collector.js';
import { buildAgentPrompt, createApproverScheduler, parseVerdicts, rebuildPackText, resolveApproverOptions } from './knowledge-approver.js';
import { clockMinutes, computePowerPlan, duePowerActions, evaluatePowerOffLock, isWithinDailyWindow, POWER_DEFAULTS, resolvePowerConfig } from './power.js';
import { buildDescribePoolPrompt, buildGeneratePrompt, matchPoolImages, normalizePoolItem, parsePoolDescriptions, createGreetingStore, createNetworkClock, dueSlots, nextFireAt, parseGeneratedGreetings, pickEntry, resolveGreetingConfig, zonedParts } from './greetings.js';
import { extractDomainTerms, DOMAIN_TERM_COUNT } from './domain-terms.js';
import { createVerifier } from './knowledge-verify.js';
import { createJudge } from './knowledge-judge.js';
import { webSearch } from './web-search.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
// 人格代理：每个人格注册一个 agent 会话；模板只在建会话时下发一次。
const PERSONA_AGENTS_FILE = path.join(STATE_DIR, 'persona-agents.json');
const PERSONA_TEMPLATES_FILE = path.join(STATE_DIR, 'persona-templates.json');
const PERSONA_TASKS_FILE = path.join(STATE_DIR, 'persona-tasks.json');
const PERSONA_TOPICS_FILE = path.join(STATE_DIR, 'persona-topics.json');
// 操作者为每个会话预写的「初始提示词」（见 main() 里的 initialPrompts）。
// 单独一个文件：它属于操作者配置，不能随 social-v2.json 的会话状态一起被重置清掉。
const INITIAL_PROMPTS_FILE = path.join(STATE_DIR, 'initial-prompts.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const GREETINGS_FILE = path.join(STATE_DIR, 'greetings.json');
const GREETINGS_SESSION_FILE = path.join(STATE_DIR, 'greetings-agent-session.json');
const GREETINGS_DESC_SESSION_FILE = path.join(STATE_DIR, 'greetings-desc-session.json');
const GREETINGS_IMAGE_DIR = path.join(STATE_DIR, 'greetings', 'images');
// 定时安全关闭后写下的「关闭锁」：任何自愈/守护把进程重新拉起时，读到它就立刻退出。
const POWER_OFF_LOCK_FILE = path.join(STATE_DIR, 'power-off.lock');
// 热重载（控制台重启）标记：重启后的首启跳过静默唤醒，避免它占住会话队列。
const HOT_RELOAD_FLAG = path.join(STATE_DIR, 'hot-reload.flag');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * `simulation` 是规范名（QSH_PLAN.md §2.1：对用户只暴露 `closed-agent` / `simulation`），
 * `chat` / `reserved` / `reserved2` 是历史拼写 —— 必须继续被**接受**（线上桥接持久化的全局值
 * 就是 `reserved2`），但进程内部一律用历史拼写存储与比较：`currentMode === 'reserved2'` 这类
 * 判断遍布发送闸门、定时器与 preset 解析，把规范名直接塞进 `currentMode` 会让它们全部变成假。
 *
 * 旧写法是 `VALID_MODES = ['chat','closed-agent','reserved','reserved2']`，控制台那处还抄了
 * 一份同样的字面量数组。后果是：在 DSH 设置或 `state/mode.json` 里写 `simulation` 会被**静默
 * 忽略**，`currentMode` 保持上一次的值（进程刚起来时是 `reserved2`，智能模式 —— preset 与工具面
 * 都和封闭 Agent 不同，`v2ToolEnabled` 之类的闸门也不生效）。用户以为切到了仿真，实际跑的是另一套，
 * 而且没有任何日志。规范名与历史名必须在这里收敛成同一个内部值。
 *
 * 2026-10-30：`chat`（聊天模式）与 `reserved`（一代仿真）已整体删除，现存模式只有
 * `closed-agent` 与 `reserved2`（对外名「智能模式」）。这两个历史拼写不再被接受，线上残留值
 * 由 warnRemovedMode() 记一条日志后按当前值继续运行。
 */
const MODE_INPUT_ALIASES = Object.freeze({
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});
/** 已删除的历史模式：只用于日志提醒，不参与模式解析。 */
const REMOVED_MODES = Object.freeze({
  chat: '聊天模式已删除，只保留智能模式 / 封闭 Agent',
  reserved: '一代仿真已删除，只保留智能模式 / 封闭 Agent'
});
/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

/**
 * 从 DSH `settings.describe` 的一个命名空间里读某个键，**user 层优先、value 回退**。
 *
 * 为什么不能只读 `value`：DSH 0.2.0-rc.2 的 `settings/update` 写入的是 user 层
 * （profile patch 的显式 config），当次进程内 `describe().value`（取自插件 fiber 的
 * 运行配置）**不会更新**，要重启 DSH 才变。控制台切模式后 5 秒一次的 `refreshMode()`
 * 会读回旧 `value`，把刚选的模式改回去（issue #22，实测复现）。
 * 写哪读哪：`user` 里有显式值就用它，否则回退 `value`（从没写过时 `user` 是空对象，
 * 老行为不变；DSH 以后修好热更新也继续正确）。
 */
function settingFromDshNamespace(ns, key) {
  if (!ns || typeof ns !== 'object') return undefined;
  for (const layer of [ns.user, ns.value]) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    if (Object.prototype.hasOwnProperty.call(layer, key) && layer[key] !== undefined) return layer[key];
  }
  return undefined;
}

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
function atomicWriteJson(file, obj) {
  // 开发者模式：AI/测试产生的文件不落盘（桥接自身配置不在拦截名单里）。
  if (isDevBlockedWrite(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

// 活动日志里混着两类行：QQ 消息收发，以及系统/调度事件。日志页要分两个窗口看，
// 所以这里按行做最小分类；规则只认已知的消息行格式，避免把内部事件混进消息窗口。
const QQ_MESSAGE_LINE_RE = /(?:群友|管理员) .+：|agent 回复：|\[send\] 成功|\[reserved2\] 工具(?:分条|统一)发送|文字\+表情同时发送|\[sticker\] 工具发送表情|\[voice\](?: \(操作者\))? 发送语音|进群招呼 |自己进群招呼|进群打招呼/;

function readQqMessageTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const hits = raw.split('\n').filter((line) => line && QQ_MESSAGE_LINE_RE.test(line));
    return hits.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格模板 = roles/<名称>.md，保存后重建人格 preset；重启 DSH 后新会话生效。
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 人格卡保存/展示上限：默认 8000，可用 config.json 的 role.maxInjectChars 调整
// （1000~20000）；人格模板写进 preset 后不再每条注入，preset 自身另有 128KB 上限。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 8000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;
function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(20000, Math.max(1000, Math.round(n)));
}
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function roleFilePath(name) {
  return path.join(ROLES_DIR, name + '.md');
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function roleWarnings() {
  // 旧的一代格式化提示（超限/空格分条/[SILENT]）已随一代移除，不再产生任何警告。
  return [];
}

function roleSummaries() {
  return listRoles().map((name) => {
    const file = roleFilePath(name);
    try {
      const stat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      // 按 〔一代〕/〔二代〕 标记筛过之后实际会注入多少（不截断，人格卡按原文注入）
      const charsV2 = selectRoleText(content, 'v2').length;
      const charsV1 = selectRoleText(content, 'v1').length;
      return {
        name,
        bytes: stat.size,
        chars: content.length,
        lines: content.split('\n').length,
        mtime: stat.mtimeMs,
        excerpt: firstMeaningfulLine(content),
        injectedV1: charsV1,
        injectedV2: charsV2,
        charsV1,
        charsV2,
        hasModeTags: roleHasModeTags(content),
        warnings: roleWarnings(content).length,
      };
    } catch {
      return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, warnings: 0 };
    }
  });
}

function validateRoleName(raw) {
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
  if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
  if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
  return name;
}

function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function readRoleContent(name) {
  return fs.readFileSync(roleFilePath(name), 'utf8');
}

function writeRoleContent(name, content) {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
}

// ── 通用系统预设（预设内置的系统层）────────────────────────────────────────
// 与「人格模板」层的边界：
//   通用系统预设 = 预设内置，只放安全规则、硬约束与工具协议
//   人格模板 = 人格配置的 system 层（与 roles/<名称>.md 对齐），只放性格、语气、格式与聊天习惯
// 系统预设改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
// 人格模板随人格 preset 重建，同样需重启 DSH 生效。
// 预设提示词的权威源只剩 qq-chat-v2（一代 qq-chat 已随聊天模式一并删除），
// 二代 qq-chat-v2（一切皆工具）。控制台可分别查看与修改。
const PRESET_NAMES = { v2: 'qq-chat-v2' };
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

/**
 * 控制台的 preset 参数校验：只接受本项目这两个预置名（缺省 = 二代）。
 *
 * 为什么必须在拼路径**之前**校验：main() 里的 resolvePresetName() 在「DSH preset 清单为空」
 * （DSH 还没连上 / 正在启动）时会把调用方给的字符串**原样返回**。那四个 preset 控制台路由
 * 都拿它去 path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml')，
 * 于是 `preset=..\..\..\x` 会读写/备份 <x>/agent.cordis.yml，越出仓库。
 * 返回 null 由调用方回 400。
 */
function knownPresetName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return PRESET_NAMES.v2;
  return Object.values(PRESET_NAMES).includes(name) ? name : null;
}

function presetSourceYaml(name) {
  return path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function installedPresetYaml(name) {
  return path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
}

// 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
// （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
// 而且它的语义是错的：未知名字静默回退到 qq-chat-v2，等于 fail-OPEN —— 一旦哪天有人把它
// "复活"成真正生效的实现，群聊会话就会在 preset 清单校验失败时照样建起来。
// 真正在用的那个（main() 内，带 strict 开关）在名字不可用时返回 '' 让调用方拒绝建会话。
// 同理不再保留 PRESET_NAME_SET：它只服务于那个死函数，留着只会诱惑下一个人去用它。

function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}

// 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
// 不加前缀会让「还原」列到另一个预设的备份。
function presetBackupPrefix(name) {
  return `${name}.${path.basename(presetSourceYaml(name))}`;
}

function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(file, dest);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
  }
  return dest;
}

function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return fs.readdirSync(PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}

function presetStatus(name) {
  // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
  // （路径已经写在服务端日志里，排查时看日志即可）。
  return {
    preset: name,
    label: '通用系统预设',
    sourceFile: path.relative(ROOT, presetSourceYaml(name)),
    installed: fs.existsSync(installedPresetYaml(name)),
    requiresRestart: true,
  };
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// 回合控制标记：DONE / TOPIC_IRRELEVANT / TOPIC_END 是「给系统的信号」，不是聊天内容。
// 模型偶尔会把它们当作回复文本输出，一旦落到自动转发路径就会被当成一句话发进 QQ
//（现场见过群里冒出一条「done」）。这里统一在出站前剔除：整段只有标记 → 整条不发。
const CONTROL_MARKER_LINE_RE = /^(?:done|topic_irrelevant|topic_end|\[silent\])\s*[.!。！]*$/i;
// 行尾的控制标记（大写，模型按提示词就是这么写的）：真内容 + 「，DONE」这种也要剃掉尾巴。
// 只认大写，避免把英文聊天里的 "well done" 当标记删掉。
const CONTROL_MARKER_TAIL_RE = /(^|[\s，。！？、,.!?\u4e00-\u9fff])(?:DONE|TOPIC_IRRELEVANT|TOPIC_END|\[SILENT\])[.!。！]*\s*$/;
function stripControlMarkers(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let out = lines.filter((line) => !CONTROL_MARKER_LINE_RE.test(line.trim())).join('\n').trim();
  // 最多光头尾三层（模型偶尔会连写），每层只砍一个行尾标记。
  for (let i = 0; i < 3; i++) {
    // 标记前面的分隔符（逗号/句号/空格）也一起带走；如果是中日韩字，保留它。
    const next = out.replace(CONTROL_MARKER_TAIL_RE, (m, sep) =>
      (sep && !/[\u4e00-\u9fff]/.test(sep) ? '' : (sep || '')));
    if (next === out) break;
    out = next.trim();
  }
  return out;
}
function controlMarkerOnly(text) {
  const raw = String(text ?? '').trim();
  return !!raw && !stripControlMarkers(raw);
}
// 发送工具（qq_send_message / qq_send_burst 等）的入参清洗：控制标记行整行剔除，
// 只剩标记的消息直接丢掉（调用方据此判断「全被拦掉就报错」，不静默发送）。
function dropControlMarkerMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((msg) => stripControlMarkers(msg))
    .filter((msg) => !!msg);
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 会话 → 该会话「当前代 + 上一代」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/socialV2/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上一代（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
const CONVERSATION_TOKENS = new Map();
const MAX_KNOWN_AGENT_TOKENS = 512;

/**
 * 记录某会话的当前 agentToken：丢掉它两代之前的旧 token，避免集合无界增长。
 * 另加一层上限兜底（防止异常路径下会话 key 无界增多），淘汰顺序是「先扔非活代」。
 */
function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) KNOWN_AGENT_TOKENS.delete(prev[1]);
  CONVERSATION_TOKENS.set(key, next);
  KNOWN_AGENT_TOKENS.add(tk);
  if (KNOWN_AGENT_TOKENS.size > MAX_KNOWN_AGENT_TOKENS) {
    // 只淘汰已经不属于任何会话**当前代**的 token（即更早的旧代）。
    // 当前代一个都不能丢：脱敏漏掉活令牌就是把令牌发到 QQ，比内存占用严重得多。
    const live = new Set([...CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...KNOWN_AGENT_TOKENS]) {
      if (KNOWN_AGENT_TOKENS.size <= MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}

/** 会话被彻底移除（重置/清空工作区/退订）时，连同它的 token 一起从脱敏集合摘掉。 */
function forgetAgentToken(key) {
  const prev = CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) KNOWN_AGENT_TOKENS.delete(tk);
  CONVERSATION_TOKENS.delete(key);
}

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// 当前生效模型与回退状态（跨会话共享；会话级 selectModel 只是把它应用到每个会话）。
// active='fallback' 时说明主模型组不可用，此时图片走辅助识图转文字。
const modelRuntime = {
  active: 'primary',
  visionCapable: true,
  degradedAt: 0,
  lastError: ''
};

/**
 * 从 our-free-model 插件的 aggregate 配置里读出 OpenAI 兼容网关地址与 key。
 * 用户已经在插件里配过 tokenrouter，桥接不必让用户再填一遍。
 */
function discoverVisionGateway(dshBaseUrl) {
  try {
    const settingsFile = path.join(os.homedir(), '.dsh', 'our-free-model', 'settings.json');
    if (!fs.existsSync(settingsFile)) return null;
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const lane = settings?.aggregate?.providers?.tokenrouter;
    const apiKey = String(lane?.apiKey ?? '').trim();
    const baseUrl = String(lane?.baseUrl ?? '').trim();
    if (!apiKey || !baseUrl) return null;
    // 只在回环地址上用这份 key：插件网关本来就是本机进程
    if (!isLoopbackBase(baseUrl)) return null;
    return { baseUrl, apiKey };
  } catch {
    return null;
  }
}

// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;
// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
// 档位词汇不是全局统一的：DSH 的模型目录里每个模型自己公布 efforts。
// volcengine 用 low/high/max，our-free-model 用 light/balanced/deep。
// 只认一套会让另一套被判「非法」→ 目录查询也筛空 → 控制台永远显示 fallback 清单。
const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max', 'light', 'balanced', 'deep'];
const REASONING_EFFORT_DEFAULT = 'max';
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// ── 开发者模式（原「静默模式」）───────────────────────────────────────────────
// 两种策略：
//   guard = 拦截所有落盘和消息发送：AI/测试产生的文件不落盘，QQ 消息一条都不发；
//   off   = 停用调度系统（完全静默）：不唤醒/不派发/不发消息，且不接收 QQ 消息（不入未读）。
const DEV_MODE_FILE = path.join(STATE_DIR, 'dev-mode.json');
const DEV_POLICIES = new Set(['guard', 'off']);
let devModeCache = null;

function normalizeDevMode(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: d.enabled === true,
    policy: DEV_POLICIES.has(String(d.policy)) ? String(d.policy) : 'guard',
    testWorkspaceId: String(d.testWorkspaceId || ''),
    testWorkspacePath: String(d.testWorkspacePath || ''),
    testSessionIds: Array.isArray(d.testSessionIds) ? d.testSessionIds.map(String).filter(Boolean).slice(-500) : []
  };
}

function readDevMode() {
  if (!devModeCache) devModeCache = normalizeDevMode(readJsonSafe(DEV_MODE_FILE, {}));
  return devModeCache;
}

function writeDevMode(patch = {}) {
  devModeCache = normalizeDevMode({ ...readDevMode(), ...patch });
  // dev-mode.json 本身不在拦截名单里：拦截开关的状态必须能保存，否则重启后连「开发者模式」都丢了。
  atomicWriteJson(DEV_MODE_FILE, devModeCache);
  setDevWriteGuard(devModeCache.enabled);
  return devModeCache;
}

function devModeEnabled() {
  return readDevMode().enabled === true;
}

function devOffActive() {
  const d = readDevMode();
  return d.enabled && d.policy === 'off';
}

function devPolicyLabel(policy = readDevMode().policy) {
  return policy === 'off' ? '停用调度系统（完全静默）' : '拦截所有落盘和消息发送';
}

function devBlockMessage() {
  return readDevMode().policy === 'off'
    ? '开发者模式已开启（停用调度系统 / 完全静默），当前不允许发送'
    : '开发者模式已开启（拦截所有落盘和消息发送），当前不允许发送';
}

function syncDevWriteGuard() {
  setDevWriteGuard(devModeEnabled());
}

// 启动即生效：拦截闸门不能等到第一次消息才打开。
syncDevWriteGuard();

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// 主会话发言调度（新架构）：配置项统一放 socialV2.speech；这里只给默认值。
const PERSONA_SPEECH_DEFAULTS = Object.freeze({
  maxStartsPerHour: 4,
  maxRepliesPerThread: 5,
  threadIdleMs: 10 * 60 * 1000,
  retentionMs: 60 * 1000,
  baseChance: 0.02,
  maxChance: 0.12,
  spreadMs: 20 * 60 * 1000,
  topicBypassMs: 5 * 60 * 1000
});

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const examplePath = path.join(ROOT, 'config.example.json');
  let file = null;
  if (fs.existsSync(p)) {
    // 存在就必须能解析：坏掉的配置直接抛错，绝不用示例覆盖（那会抹掉用户的白名单和令牌）
    file = readJsonSafe(p, null, true);
  } else {
    // 首次运行（新机器 / 刚解包）：按示例生成一份，别让人对着「配置读取失败」猜格式。
    const seed = readJsonSafe(examplePath, null, true);
    if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
      throw new Error(`缺少 config.json，且 ${examplePath} 不是可用模板`);
    }
    fs.writeFileSync(p, JSON.stringify(seed, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    log(`[config] 未找到 config.json，已按 config.example.json 生成初始配置：${p}`);
    log('[config] 请填写 allow.groups（群号）与 ownerQQ，改完重启桥接生效');
    file = seed;
  }
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 默认走「4.1 识图组」：组内成员都声明了 image 输入，人格才能真正看懂群友发的图。
      // config.json 未配置时用这个兜底（旧默认是单模型 deepseek-flash）。
      model: 'combo:vision-41',
      // 主模型组整体不可用时的回退组；空字符串 = 不回退（保持旧行为）。
      fallbackModel: 'combo:recommended-free',
      fallbackProvider: '',
      // 回退后隔多久再试主模型（毫秒）；期间所有会话都用回退组
      modelRetryCooldownMs: 600000,
      // 回退组（推荐免费组）本身没有识图能力时，用这个辅助模型把图片转成文字描述。
      // 只在「回退中」使用；主模型组自带识图时依然直接喂图，省一次调用。
      vision: {
        enabled: true,
        // OpenAI 兼容网关；留空则自动读取 ~/.dsh/our-free-model 的 tokenrouter 配置
        baseUrl: '',
        apiKey: '',
        // 实测能看图且延迟可接受（qoder/dfmodel 会超时，别用）
        model: 'trae/deepseek-v4.1-flash',
        timeoutMs: 45000,
        maxImages: 3,
        maxChars: 500
      },
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat-v2',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
  // 本机浏览器免令牌：127.0.0.1 打开控制台不再每次要口令（跨站/智能体调用仍然要）。
  consoleAuthLocal: file.consoleAuthLocal !== false,
    consoleToken: file.consoleToken ?? '',
    // 新人进群招呼：只在白名单群生效，带去重与每小时上限，防止重连补发/反复入群刷屏。
    // {name} 换成群名片或昵称，{qq} 换成 QQ 号。
    // 外部工具进程：由控制台一键拉起、并能看它们的输出。
    // 梗图管理器是 Python+tkinter 的桌面程序；SnowLuma 是 OneBot 网关（Node）。
    tools: {
      memeManager: {
        enabled: true,
        dir: 'D:/AI/meme-renamer',
        script: 'meme_renamer.py',
        ...(file.tools?.memeManager ?? {})
      },
      snowluma: {
        enabled: true,
        // DSH 起来后如果网关没在跑，就顺手把它拉起来（除非显式关掉）
        autoStart: true,
        // 空 = 自动推断：桥接仓库同级的 SnowLuma 目录
        dir: '',
        script: 'index.mjs',
        ...(file.tools?.snowluma ?? {})
      }
    },
    // 表情策略：想表达情绪时优先发收藏表情包，而不是在文字里打 emoji。
    // 二代仿真下发言走 MCP 工具（不经过本进程的发送函数），所以只能靠提示词约束。
    stickerPolicy: {
      enabled: true,
      text: [
        '【表情包优先（必须遵守）】想表达情绪、玩梗、应答、接话时，优先发一张收藏表情包（mcp__snowluma__qq_send_sticker，可先用 qq_list_stickers 按语义搜），不要在文字里打 emoji。',
        '- 文字消息里不要出现 emoji / 颜文字；这类内容一律改成发表情包',
        '- 想让文字和表情几乎同时到：给 qq_send_message / qq_reply 传 stickerId，'
          + '一次调用文字落地后表情零停顿跟上；分两次调用会慢 1~2 秒',
        '- 表情包单独发一条，一轮最多一张，别连发刷屏',
        '- 表情包要贴合语境；找不到合适的就不发，别硬塞'
      ].join('\n'),
      ...(file.stickerPolicy ?? {})
    },
    // 自己（bot）被拉进群时的自我介绍。和上面的 greeting（新人进群招呼）是两件事。
    selfIntro: {
      enabled: true,
      // true = 只在自己进群那一刻说；false = 启动/定期扫描也补说一次
      //（离线期间被拉进群时，事件已经错过，只能靠扫描补上）
      onlyOnJoin: false,
      // true = 任何群被拉进去都打招呼（除了 deny.groups）；false = 只对 allow.groups 里的群
      anyGroup: true,
      // 'llm' = 让模型现写一句（失败/超时自动退回 templates）；'template' = 只用模板
      mode: 'llm',
      maxChars: 50,
      llmTimeoutMs: 20000,
      // 打招呼后补一张图；留空字符串就不发图。路径相对 qq-bridge 目录或绝对路径。
      image: 'state/self-intro.jpg',
      delayMs: 3000,
      scanIntervalMs: 10 * 60 * 1000,
      templates: [
        '大家好，我是{name}～有问题直接 @ 我就行。',
        '嗨，{name} 来了，随便聊，我在的。'
      ],
      ...(file.selfIntro ?? {})
    },
    greeting: {
      enabled: true,
      atUser: true,
      delayMs: 1500,
      dedupeMs: 60 * 1000,
      maxPerHour: 20,
      templates: ['欢迎 {name} 进群～'],
      ...(file.greeting ?? {})
    },
    // 定时问候（复数）：控制台保存写的就是这个键。之前 loadConfig 没把它合并进 cfg，
    // 重启后又回到默认值（enabled=false / 21:30），表现就是「设置了保存不住」。
    greetings: {
      ...(file.greetings ?? {})
    },
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      // 单次提取最多入库多少条：模型按重要性排序，多余/次要的由代理舍弃
      extractMax: 10,
      // 管理员补充的提取方向（例如“只看游戏术语/只看抽象话/忽略英文缩写”）
      extractPromptExtra: '',
      // 管理员补充的研究约束（例如“只采纳能搜到来源的/优先查梗的出处”）
      researchPromptExtra: '',
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat-v2',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      // 研究要联网搜索+抓正文，120s 经常不够；超时会把整批结果丢掉（网页上就只剩「待研究」）。
      researchTimeoutMs: 300000,
      // 每次研究最多 20 个候选；超过就再开一个新会话并行跑（互不等待）。
      researchSessionBatch: 20,
      // 同时最多开几个研究会话，避免一次点太多把 DSH 打满。
      researchMaxSessions: 4,
      ...(file.slang ?? {})
    },
    // 共享知识库：只收「聊天里学到的」和「联网检索整理的」事实，全部先进 pending，
    // 控制台人工审核通过后才进检索池，所有角色/所有群共享（单条可标「仅来源群可见」）。
    // backend：off = 只用关键词；local = 本机 Ollama；cloud = 任意 OpenAI 兼容端点。
    // 定时安全关闭 + 定时关机（默认全关；关机一定排在安全关闭之后）
    power: {
      ...POWER_DEFAULTS,
      ...(file.power ?? {})
    },
    knowledge: {
      enabled: true,
      backend: 'off',
      local: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'nomic-embed-text' },
      cloud: { baseUrl: '', apiKey: '', model: '' },
      topK: 5,
      minScore: 0.25,
      injectMaxChars: 1200,
      maxEntries: 3000,
      searchTimeoutMs: 1500,
      allowPropose: true,
      // 自动批准代理：待审积压到 batchSize 就跑一轮，命中违禁词的条目永远留给人工。
      // enabled 默认开——这是「自动处理审核批准」的开关，关掉就退回全人工。
      autoApprove: {
        enabled: true,
        // agent = 交给「审批代理」判断（能调工具剥离无关行）；rules = 退回纯规则代理
        mode: 'agent',
        batchSize: 20, intervalMs: 60000, extraTerms: [],
        // 审批代理的并行策略（见 src/knowledge-approver.js）
        agent: {
          enabled: true,
          batchSize: 12,         // 每个 worker 一次处理几包
          maxWorkers: 4,         // 并行上限
          backlogThreshold: 50,  // 积压 ≥ 这个数立刻拉满并行
          intervalMs: 30000,
          maxPackChars: 1400,
          turnTimeoutMs: 180000,
          preset: ''             // 留空 = 沿用群聊安全 preset
        },
        // 被拦截的待审条目超过这么多天没人处理 → 自动归档到「已拒绝」（0 = 不归档）
        archiveDays: 30,
        // 审批前：库里已有同义内容免核实；命中专业词的联网核实（官方/百科来源才放行）
        verify: { enabled: true, kbDupScore: 0.75, maxVerifyPerRun: 10, maxRunMs: 90000,
          judge: { enabled: true, timeoutMs: 25000, maxSources: 3 } }
      },
      // 聊天采集：只收他人文字消息，每分钟每会话最多一包、每包最多 20 条
      collect: {
        enabled: true, windowMs: 60000, maxMessages: 20, minMessages: 1, minChars: 6, maxPacksPerHour: 200,
        // false（默认）= 采集包进待审，交给审批代理判断；true = 直接写向量库（不审读）
        direct: false
      },
      // 联网搜索：auto = Tavily（keyless 免 key）→ DeepSeek（需凭据）→ Bing（抓页面）
      webSearch: {
        provider: 'auto',
        tavily: { enabled: true, apiKey: '', keyless: true, searchDepth: 'basic', minScore: 0.2, maxResults: 6, timeoutMs: 20000 }
      },
      ...(file.knowledge ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 消息收件箱（src/social-inbox.js）：按发起人分队列、按时间段过期
      inbox: {
        ttlMs: 10 * 60 * 1000,   // 一条消息在上下文里最多活多久
        perSenderMax: 12,        // 单个人最多保留几条
        maxSenders: 16,          // 一个会话最多保留几个人的队列
        maxTotal: 80,            // 所有队列合计上限
        focusWindowMs: 90 * 1000,// 最近这段时间说过话才算「当前话题对象」
        topicMinSim: 0.1,        // 其他群友文字要过这个相似度才作背景
        maxChars: 1400           // 渲染后的上下文最多多少字
      },
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      agentPreset: 'qq-chat-v2',
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true,
        topicOpen: true
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 200
      },
      // 主会话调度参数：默认由系统托管；文件里的值覆盖默认。
      speech: {
        ...PERSONA_SPEECH_DEFAULTS,
        ...(file.socialV2?.speech ?? {})
      },
      // 人格代理运行时：系统托管调度（话题队列/去重快照/记忆检索/90% 上下文重建）。
      runtime: {
        ...PERSONA_RUNTIME_DEFAULTS,
        ...(file.socialV2?.runtime ?? {})
      },
      // 操作者在控制台为单个会话预写的「初始提示词」的字数上限（只在首次派发时注入一次）。
      // 它不是安全边界，只是防止误粘贴一篇长文把首次派发的 prompt 撑爆。
      initialPromptMaxChars: 2000,
      // 图片/表情（含动图）的数量与体积上限。QQ 的动图表情常见 1~4MB，
      // 旧的 4MB 单条总上限会误伤；这里默认 8MB，仍受 DSH 的 20MB/64MP 限制约束。
      media: {
        maxBytes: 8 * 1024 * 1024,
        maxPixels: 64_000_000,
        maxCount: 5
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    knowledgeSearch: true,
    knowledgePropose: true,
    // 需要更多记忆时的统一检索（知识库向量 + 已确认黑话 + 轻量记忆）
    memorySearch: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    topicOpen: true,
    sendVoice: false,
    ...(cfg.socialV2.tools ?? {})
  };
  cfg.socialV2.speech = {
    ...PERSONA_SPEECH_DEFAULTS,
    ...(cfg.socialV2.speech ?? {})
  };
  cfg.socialV2.runtime = {
    ...PERSONA_RUNTIME_DEFAULTS,
    ...(cfg.socialV2.runtime ?? {})
  };

  // socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.socialV2?.voice ?? {})
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // socialV2.media：图片/表情的数量与体积上限。旧配置没有这一段，必须深度合并出默认值，
  // 否则 `{...defaults, ...file.socialV2}` 里缺失的 media 会取到 undefined（等于无上限判断）。
  cfg.socialV2.media = {
    maxBytes: 8 * 1024 * 1024,
    maxPixels: 64_000_000,
    maxCount: 5,
    ...((cfg.socialV2?.media && typeof cfg.socialV2.media === 'object' && !Array.isArray(cfg.socialV2.media)) ? cfg.socialV2.media : {})
  };

  // socialV2.initialPromptMaxChars：会话「初始提示词」的字数上限。config.json 是用户可编辑的，
  // 手工写进字符串/负数/超大值时要收敛到安全区间，否则要么保存接口永远报"过长"，要么等于没上限。
  {
    const raw = Number(cfg.socialV2?.initialPromptMaxChars);
    cfg.socialV2.initialPromptMaxChars = Number.isFinite(raw) && raw > 0
      ? Math.min(8000, Math.max(100, Math.round(raw)))
      : 2000;
  }

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 辅助识图：回退组没有图像输入时，桥接自己调一次视觉模型把图片转成文字。
  // 网关地址与 key 默认从 our-free-model 插件的 aggregate 配置里读（用户已经在插件里配过）。
  {
    const vision = { ...(cfg.dsh.vision ?? {}) };
    vision.enabled = vision.enabled !== false;
    if (!String(vision.model ?? '').trim()) vision.model = 'trae/deepseek-v4.1-flash';
    const num = (value, fallback, min, max) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, Math.round(parsed)));
    };
    vision.timeoutMs = num(vision.timeoutMs, 45000, 5000, 180000);
    vision.maxImages = num(vision.maxImages, 3, 1, 8);
    vision.maxChars = num(vision.maxChars, 500, 40, 2000);
    if (!String(vision.baseUrl ?? '').trim() || !String(vision.apiKey ?? '').trim()) {
      const discovered = discoverVisionGateway(cfg.dsh.baseUrl);
      if (discovered) {
        if (!String(vision.baseUrl ?? '').trim()) vision.baseUrl = discovered.baseUrl;
        if (!String(vision.apiKey ?? '').trim()) vision.apiKey = discovered.apiKey;
      }
    }
    cfg.dsh.vision = vision;
    if (vision.enabled && (!vision.baseUrl || !vision.apiKey)) {
      log('⚠️ 辅助识图已开启但找不到可用网关凭据；回退到推荐免费组时将只保留「[图片]」占位');
    }
  }
  // 模型回退：主模型组不可用时切到回退组，冷却后再试主模型
  {
    const cool = Number(cfg.dsh.modelRetryCooldownMs);
    cfg.dsh.modelRetryCooldownMs = Number.isFinite(cool) && cool > 0 ? Math.min(86400000, Math.round(cool)) : 600000;
    if (cfg.dsh.fallbackModel && cfg.dsh.fallbackModel === cfg.dsh.model) {
      log('⚠️ dsh.fallbackModel 与 dsh.model 相同，回退没有意义，已清空');
      cfg.dsh.fallbackModel = '';
    }
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    state = { sessions: {}, sessionPolicies: {} };
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      state = { sessions: {}, sessionPolicies: {} };
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  atomicWriteJson(STATE_FILE, state);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
function consolePortInUse() {
  try {
    const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      // windowsHide：桥接是 DSH 拉起的无窗口进程，少一个 flag 就会闪一个黑框
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
          if (!consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  const devBlocked = () => isDevBlockedWrite(file);
  return function append(text) {
    if (devBlocked()) return; // 开发者模式：活动/工具日志不落盘
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
// DSH 控制类调用（停任务/归档会话）的超时。这些 await 以前是裸的：DSH 接受了连接但
// 不返回响应时，HTTP handler 永不返回，控制台与群消息一起失去响应（issue #32）。
// 超时后走各自的 catch 记日志，最坏情况只是「这一次重置没做成」，而不是整体挂死。
const DSH_CONTROL_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
      case 'mface': out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

/**
 * 媒体摘要（QQ 表情的 `summary`）会进入模型上下文、也会被拼进「[表情:…]」这类单行标注。
 * 压掉换行/控制字符并限长：否则一条群消息可以用摘要里的换行伪造出新的提示词段落。
 */
function sanitizeMediaSummary(value, max = 60) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s ? truncateText(s, max) : '';
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
//
// 字段必须尽量保留：SnowLuma 收到的 QQ 表情包（收藏/市场表情）是 **image 段 +
// emoji_id/emoji_package_id/key/url**（实测：sub_type 可能是 0，靠 emoji_id 区分），
// 部分网关实现则用 mface 段。以前只留 file/url/subType/summary，emoji 字段被丢掉，
// 一旦 get_image 取不到（市场表情不在网关缓存里），就再也没有其它可用的兜底地址。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    const emojiFields = {
      emojiId: String(d.emoji_id ?? d.emojiId ?? ''),
      emojiPackageId: String(d.emoji_package_id ?? d.emojiPackageId ?? ''),
      emojiKey: String(d.key ?? '')
    };
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'mface') {
      // 市场表情（mface）：没有 image 段可用，emoji_id/url 是唯一来源。
      media.push({
        kind: 'sticker',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: '1',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? ''),
        url: String(d.url ?? ''),
        summary: sanitizeMediaSummary(d.summary)
      });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 工具进程（梗图管理器 / SnowLuma）──────────────────────────────────────
// 这两个程序生命周期跟着桥接：控制台能一键拉起、能看它们的输出。
// 不塞进桥接进程里，是因为它们各自有 GUI / 端口，独立进程更好看日志、单独重启。
const toolChildren = { meme: null, snowluma: null };

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 梗图管理器的 Python：便携运行时 > DSH 自带运行时 > PATH 上的 python。 */
// ── QQ 客户端探测 ──────────────────────────────────────────────────────────
//
// 桥接的所有能力都依赖 QQ 客户端活着（hook DLL 在 QQ 进程里）。QQ 一关，网关还在、
// 端口还在监听，但收不到任何消息——外面看就是「在线但不回话」。这里只负责**看**，
// 不替用户启停 QQ：控制台据此亮灯，并给一个「启动掉线提醒」的选项。
let qqSnapshot = { at: 0, count: 0 };

function qqProcessSnapshot(force = false) {
  const now = Date.now();
  if (!force && now - qqSnapshot.at < 10_000) return qqSnapshot;
  let count = 0;
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'latin1',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024
    });
    for (const line of String(out).split(/\r?\n/)) {
      const name = /^"([^"]+)"/.exec(line)?.[1]?.toLowerCase();
      if (name === 'qq.exe' || name === 'qqnt.exe') count += 1;
    }
  } catch {
    count = 0;
  }
  qqSnapshot = { at: now, count };
  return qqSnapshot;
}

// ── QQ 安装路径探测（注册表）───────────────────────────────────────────────
//
// QQ 装在哪是用户机器的事，不能写死。这里只做**读**：
//   1) Tencent\QQNT 的 Install（NT 版写这个，实测 HKLM 的 WOW6432Node 下）
//   2) App Paths\QQ.exe 的默认值（老式安装器）
//   3) 卸载项 QQ 的 DisplayIcon / InstallLocation
//   4) 几个惯用目录
// 探到就写回 config.json 的 tools.qq，之后按配置走，不再每次重扫。
let qqInstallCache = { at: 0, path: '', source: '', version: '' };

function regValue(key, value) {
  if (process.platform !== 'win32') return '';
  try {
    const args = value ? ['query', key, '/v', value] : ['query', key, '/ve'];
    const out = execFileSync('reg', args, {
      encoding: 'latin1',
      windowsHide: true,
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    // 形如：    Install    REG_SZ    D:\QQ
    const match = /REG_(?:SZ|EXPAND_SZ)\s+(.+)/i.exec(out);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

function isQqExe(file) {
  try {
    return /^qq\.exe$/i.test(path.basename(file)) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 按优先级收集候选，返回第一个真实存在的 QQ.exe。 */
function resolveQqInstall(force = false) {
  if (process.platform !== 'win32') return { path: '', source: '', version: '' };
  if (!force && qqInstallCache.at && Date.now() - qqInstallCache.at < 5 * 60_000) return qqInstallCache;

  const candidates = [];
  const add = (installDirOrExe, source) => {
    const raw = String(installDirOrExe ?? '').trim().replace(/^"|"$/g, '');
    if (!raw) return;
    // DisplayIcon 形如 "D:\QQ\QQ.exe,0"
    const cleaned = raw.replace(/,\s*-?\d+$/, '');
    candidates.push({ file: /\.exe$/i.test(cleaned) ? cleaned : path.join(cleaned, 'QQ.exe'), source });
  };

  // 注册表路径用字符码拼：JS 字符串里的反斜杠是转义符，写成 reg 键会被悄悄吃掉，
  // 结果 reg 查了个不存在的键、最后靠 known-dir 兜底才认出安装目录（第一版就栽在这）。
  const BS = String.fromCharCode(92);
  const regKey = (...parts) => parts.join(BS);
  const QQNT_HKLM = regKey('HKLM', 'SOFTWARE', 'WOW6432Node', 'Tencent', 'QQNT');
  const QQNT_HKCU = regKey('HKCU', 'SOFTWARE', 'Tencent', 'QQNT');
  add(regValue(QQNT_HKLM, 'Install'), 'registry:QQNT');
  add(regValue(regKey('HKLM', 'SOFTWARE', 'Tencent', 'QQNT'), 'Install'), 'registry:QQNT');
  add(regValue(QQNT_HKCU, 'Install'), 'registry:QQNT');
  add(regValue(regKey('HKLM', 'SOFTWARE', 'WOW6432Node', 'Microsoft', 'Windows', 'CurrentVersion', 'App Paths', 'QQ.exe'), ''), 'registry:AppPaths');
  add(regValue(regKey('HKLM', 'SOFTWARE', 'Microsoft', 'Windows', 'CurrentVersion', 'App Paths', 'QQ.exe'), ''), 'registry:AppPaths');
  add(regValue(regKey('HKCU', 'SOFTWARE', 'Microsoft', 'Windows', 'CurrentVersion', 'App Paths', 'QQ.exe'), ''), 'registry:AppPaths');
  add(regValue(regKey('HKLM', 'SOFTWARE', 'Microsoft', 'Windows', 'CurrentVersion', 'Uninstall', 'QQ'), 'DisplayIcon'), 'registry:uninstall');
  add(regValue(regKey('HKLM', 'SOFTWARE', 'WOW6432Node', 'Microsoft', 'Windows', 'CurrentVersion', 'Uninstall', 'QQ'), 'DisplayIcon'), 'registry:uninstall');
  add(regValue(regKey('HKCU', 'SOFTWARE', 'Microsoft', 'Windows', 'CurrentVersion', 'Uninstall', 'QQ'), 'DisplayIcon'), 'registry:uninstall');
  for (const dir of [
    'C:/Program Files/Tencent/QQNT',
    'C:/Program Files (x86)/Tencent/QQNT',
    'D:/QQ'
  ]) add(dir, 'known-dir');

  const version = regValue(QQNT_HKLM, 'version') || regValue(QQNT_HKCU, 'version');
  const hit = candidates.find((item) => isQqExe(item.file));
  qqInstallCache = {
    at: Date.now(),
    path: hit ? path.resolve(hit.file) : '',
    source: hit ? hit.source : '',
    version
  };
  return qqInstallCache;
}

/**
 * 把探测结果写回 config.json 的 tools.qq（只动这一个键，其余原样保留）。
 * 已经配置过且文件还在的，不覆盖——用户手动指定优先。
 */
function autofillQqPath(cfg) {
  const configured = String(cfg.tools?.qq?.path ?? '').trim();
  if (configured && fs.existsSync(configured)) return { path: configured, source: 'config', version: String(cfg.tools?.qq?.version ?? '') };
  const found = resolveQqInstall(true);
  if (!found.path) return { path: '', source: '', version: found.version };
  const info = { path: found.path, source: found.source, version: found.version, detectedAt: new Date().toISOString() };
  try {
    const file = path.join(ROOT, 'config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      raw.tools = raw.tools && typeof raw.tools === 'object' ? raw.tools : {};
      raw.tools.qq = { ...(raw.tools.qq ?? {}), ...info };
      atomicWriteJson(file, raw);
      log(`[tools] 已从注册表识别 QQ：${info.path}（${info.source}，v${info.version || '?'}），已写入 config.json`);
    }
  } catch (error) {
    log(`[tools] 写入 QQ 路径失败：${error?.message ?? error}`);
  }
  if (cfg.tools) cfg.tools.qq = { ...(cfg.tools.qq ?? {}), ...info };
  return info;
}

/** 掉线提醒脚本：随仓库/插件一起走。 */
function qqWatchScript() {
  return path.join(ROOT, 'scripts', 'watch-qq.py');
}

function pickPython(memeDir) {
  const candidates = [
    path.join(memeDir, 'runtime', 'pythonw.exe'),
    path.join(memeDir, 'runtime', 'python.exe'),
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * SnowLuma 目录：配置优先 → 按顺序找真正有 index.mjs 的那一份 → 都没有就返回安装目标。
 *
 * 候选之所以有好几个，是因为同一份代码要同时兼容两种布局：
 *   打包态：<plugin>/bridge/src/bridge.js   → 装在 <plugin>/snowluma
 *   开发态：<repo>/src/bridge.js           → 用同级的 <repo>/../SnowLuma
 * 而插件目录本身又可能躺在仓库里（<repo>/plugins/qq-bridge-launcher），
 * 所以还得再上溯一层找 <repo>/SnowLuma。少一个候选就会出现「明明装过却去重新下载」。
 */
function snowlumaDir(cfg) {
  const script = String(cfg.tools?.snowluma?.script ?? 'index.mjs');
  const configured = String(cfg.tools?.snowluma?.dir ?? '').trim();
  if (configured) return path.resolve(configured);
  const has = (dir) => {
    try {
      return Boolean(dir) && fs.existsSync(path.join(dir, script));
    } catch {
      return false;
    }
  };
  // 本插件的安装位（打包后的标准位置）
  const installTarget = path.resolve(ROOT, '..', 'snowluma');
  if (has(installTarget)) return installTarget;
  if (has(process.env.SNOWLUMA_HOME)) return path.resolve(process.env.SNOWLUMA_HOME);
  // 开发态：从 ROOT 逐级上溯，每层都看 SnowLuma / snowluma。
  // 这样 <repo>/src、<repo>/plugins/<plugin>/bridge/src 两种深度都能命中，不用写死层数。
  let probe = path.resolve(ROOT);
  for (let depth = 0; depth < 5; depth += 1) {
    probe = path.dirname(probe);
    for (const name of ['SnowLuma', 'snowluma']) {
      const candidate = path.join(probe, name);
      if (candidate !== installTarget && has(candidate)) return candidate;
    }
  }
  return installTarget; // 都没装：返回安装目标，交给 ensureSnowlumaInstalled
}

/** 梗图管理器目录：配置里的路径不存在时，用插件内置副本兜底。 */
function memeDirOf(cfg) {
  const script = String(cfg.tools?.memeManager?.script ?? 'meme_renamer.py');
  const configured = String(cfg.tools?.memeManager?.dir ?? '').trim();
  const usable = (dir) => {
    try {
      return Boolean(dir) && fs.existsSync(path.join(dir, script));
    } catch {
      return false;
    }
  };
  if (usable(configured)) return path.resolve(configured);
  const bundled = path.resolve(ROOT, '..', 'meme');
  if (usable(bundled)) return bundled;
  return configured ? path.resolve(configured) : bundled;
}

/** 探一下某个 HTTP 端点是否活着（SnowLuma 可能不是本进程拉起的）。 */
async function probeHttpAlive(url, timeoutMs = 700) {
  const base = String(url ?? '').replace(/\/+$/, '');
  if (!base) return false;
  try {
    const res = await fetch(`${base}/get_status`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer().catch(() => {});
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  }
}

/**
 * 网关没在跑就顺手拉起来（DSH 插件场景下"随 DSH 启动"包括网关本身）。
 * 只认端口：已经有一份在跑（手动起的/系统服务）就什么都不做。
 */
// ── SnowLuma 按需安装（不随插件分发）─────────────────────────────────────
//
// 网关是上游作者的作品，**再分发需要作者同意**，所以插件里不带本体。改成运行时安装：
// 启动时检测不到就按固定版本从官方 GitHub Release 下载，校验 sha256 后解压，
// 再按本插件的要求写初始配置（hookAutoLoad 等）。
//
// 版本与发行版由 config 控制：
//   tools.snowluma.version      默认 2.1.1
//   tools.snowluma.distribution "full"（默认，自带 node.exe）| "lite"（6MB，用系统 node）
//   tools.snowluma.mirrors      额外镜像前缀
//   tools.snowluma.autoInstall  false 可彻底关掉自动安装
const SNOWLUMA_DEFAULT_VERSION = '2.1.1';
// 直连 github 放最后：DNS 卡住时 socket 超时救不了场，镜像先走。
const SNOWLUMA_MIRRORS = ['https://ghproxy.net/', 'https://gh-proxy.com/', 'https://ghfast.top/', ''];
let snowlumaInstallTask = null;

function nodeAtLeast(min) {
  const cur = String(process.versions?.node ?? '0').split('.').map(Number);
  const need = String(min).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const a = cur[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function snowlumaInstallInfo(cfg) {
  const version = String(cfg.tools?.snowluma?.version ?? '').trim() || SNOWLUMA_DEFAULT_VERSION;
  let lite = String(cfg.tools?.snowluma?.distribution ?? '').trim().toLowerCase() === 'lite';
  // lite 包不带 node.exe，要求宿主 node ^24.22.1；DSH 自带的是 24.21.0，差一点点就不行。
  // 与其让人装完起不来，不如直接用 full（自带 node.exe，自给自足）。
  if (lite && !nodeAtLeast('24.22.1')) {
    log(`[tools] lite 版要求 node ^24.22.1，当前是 ${process.versions.node}，改用 full 版`);
    lite = false;
  }
  return {
    version,
    dist: lite ? 'lite' : 'full',
    assetName: `SnowLuma-v${version}-win-x64${lite ? '-lite' : ''}.zip`
  };
}

/** 网关用哪个 node：优先它自带的 node.exe（full 版），没有才用桥接自己的。 */
function snowlumaNode(dir) {
  try {
    const bundled = path.join(dir, 'node.exe');
    if (fs.existsSync(bundled)) return bundled;
  } catch {}
  return process.execPath;
}

/** 问 GitHub API 要这个版本的资产信息（含官方 sha256）。 */
async function fetchSnowlumaAsset(info) {
  const res = await fetch(`https://api.github.com/repos/SnowLuma/SnowLuma/releases/tags/v${info.version}`, {
    headers: { 'user-agent': 'qq-bridge-launcher', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`);
  const release = await res.json();
  const asset = (release.assets ?? []).find((a) => a.name === info.assetName);
  if (!asset) throw new Error(`v${info.version} 的发布里没有 ${info.assetName}`);
  const sha256 = String(asset.digest ?? '').replace(/^sha256:/i, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${info.assetName} 缺少官方 sha256，拒绝安装`);
  return {
    name: info.assetName,
    url: String(asset.browser_download_url),
    size: Number(asset.size) || 0,
    sha256
  };
}

/** 下载到文件，体积与 sha256 都对上才落盘（对不上说明镜像给了 HTML 或文件被换过）。 */
async function downloadSnowlumaAsset(url, file, asset) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (asset.size && buf.length !== asset.size) throw new Error(`体积不符：${buf.length} != ${asset.size}`);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== asset.sha256) throw new Error(`sha256 不符：${sha.slice(0, 12)}… != ${asset.sha256.slice(0, 12)}…`);
  fs.writeFileSync(file, buf);
  return buf.length;
}

/** 解压 zip（PowerShell 自带 Expand-Archive，省掉一个 zip 依赖）。 */
function expandZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`
  ], { stdio: 'ignore', timeout: 180000, windowsHide: true });
}

/** 解压出来的 index.mjs 可能在一层子目录里，找出来。 */
function findSnowlumaRoot(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'index.mjs'))) return dir;
  if (depth >= 2) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findSnowlumaRoot(path.join(dir, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * 确保 SnowLuma 可用：已装（含仓库同级的老版本）就直接用，否则下载安装。
 * 返回 { ok, dir, version?, already?, error? }。并发调用共用同一个安装任务。
 */
async function ensureSnowlumaInstalled(cfg) {
  const script = String(cfg.tools?.snowluma?.script ?? 'index.mjs');
  const existing = snowlumaDir(cfg);
  if (fs.existsSync(path.join(existing, script))) return { ok: true, dir: existing, already: true };
  if (cfg.tools?.snowluma?.autoInstall === false) {
    return { ok: false, error: `未安装 SnowLuma，且 config.json 里 tools.snowluma.autoInstall 为 false（可用 PATH 或手动放到 ${existing}）` };
  }
  if (snowlumaInstallTask) return snowlumaInstallTask;

  snowlumaInstallTask = (async () => {
    const info = snowlumaInstallInfo(cfg);
    const target = path.resolve(ROOT, '..', 'snowluma');
    log(`[tools] 未检测到 SnowLuma，开始安装 v${info.version}（${info.dist}，${info.assetName}）`);
    const asset = await fetchSnowlumaAsset(info);
    log(`[tools] 官方发布：${asset.name} ${(asset.size / 1024 / 1024).toFixed(1)}MB sha256 ${asset.sha256.slice(0, 12)}…`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-'));
    const zip = path.join(tmpDir, asset.name);
    try {
      const mirrors = [...new Set([...(cfg.tools?.snowluma?.mirrors ?? []), ...SNOWLUMA_MIRRORS])];
      let downloaded = 0;
      let lastError = '';
      for (const mirror of mirrors) {
        const base = String(mirror ?? '').replace(/\/+$/, '');
        const url = base ? `${base}/${asset.url}` : asset.url;
        try {
          downloaded = await downloadSnowlumaAsset(url, zip, asset);
          log(`[tools] 下载完成 ${(downloaded / 1024 / 1024).toFixed(1)}MB（${base || 'github.com'}），sha256 校验通过`);
          break;
        } catch (error) {
          lastError = error?.message ?? String(error);
          log(`[tools] 下载失败（${base || 'github.com'}）：${lastError}`);
        }
      }
      if (!downloaded) throw new Error(`所有下载源都失败：${lastError}`);

      const stage = path.join(tmpDir, 'stage');
      expandZip(zip, stage);
      const root = findSnowlumaRoot(stage);
      if (!root) throw new Error('解压结果里找不到 index.mjs');
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(root, target, { recursive: true });

      // 初始配置：不开 hookAutoLoad 的话，QQ 一重启 hook 就不会重新注入（网关就不再上线）
      const runtimeFile = path.join(target, 'config', 'runtime.json');
      fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
      let runtime = {};
      try { runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')) ?? {}; } catch {}
      runtime.hookAutoLoad = true;
      runtime.webuiPort = Number(runtime.webuiPort) || Number(cfg.tools?.snowluma?.webuiPort) || 5099;
      fs.writeFileSync(runtimeFile, JSON.stringify(runtime, null, 2) + '\n', 'utf8');
      fs.writeFileSync(path.join(target, 'installed.json'), JSON.stringify({
        version: info.version,
        distribution: info.dist,
        sha256: asset.sha256,
        installedAt: new Date().toISOString()
      }, null, 2) + '\n', 'utf8');

      log(`[tools] SnowLuma v${info.version} 已安装到 ${target}`);
      return { ok: true, dir: target, version: info.version, already: false };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })().finally(() => { snowlumaInstallTask = null; });

  return snowlumaInstallTask;
}

/**
 * 单飞包装：并发调用（守护定时器 + 连接流程 + 控制台「启动」按钮）复用同一次启动。
 *
 * 不这么写会出现「检查都通过 → 各自 spawn 一个」的经典竞态：两次调用之间隔着
 * 好几个 await（探 HTTP、看 WebUI 端口），第二个进来的调用看到的还是「没在跑」。
 * 后果是两个 gateway 抢 5099/OneBot 端口，表现是「连上了又掉、OneBot 时好时坏」。
 */
let snowlumaStartTask = null;
function ensureSnowlumaRunning(cfg, opts = {}) {
  if (snowlumaStartTask) return snowlumaStartTask;
  snowlumaStartTask = runEnsureSnowlumaRunning(cfg, opts).finally(() => {
    snowlumaStartTask = null;
  });
  return snowlumaStartTask;
}

async function runEnsureSnowlumaRunning(cfg, { waitMs = 25000 } = {}) {
  if (cfg.tools?.snowluma?.enabled === false || cfg.tools?.snowluma?.autoStart === false) return 'disabled';
  if (await probeHttpAlive(cfg.snowluma?.httpUrl, 1200)) return 'already';
  // 只看 OneBot 端口会把「SnowLuma 活着、但 QQ 还没登录」误判成「没起」——
  // 未登录时 3000/3001 根本不 listen，于是每次桥接重启都会再拉一个实例，
  // 两个实例抢 WebUI 端口和 onebot 配置。补两条更可靠的「已经在跑」判据。
  const existingPid = Number(readToolStateFile().snowlumaPid) || 0;
  const pidAlive = existingPid > 0 && isPidAlive(existingPid);
  const webUiAlive = (await probeHttpAlive('http://127.0.0.1:5099/', 800))
    || (await probeHttpAlive('http://127.0.0.1:5100/', 800));
  if (pidAlive || webUiAlive) {
    log(`[tools] SnowLuma 已在运行（pid=${existingPid || '未知'}），跳过自动启动${pidAlive ? '' : '（WebUI 在监听）'}`);
    return 'already';
  }
  const installed = await ensureSnowlumaInstalled(cfg);
  if (!installed.ok) {
    log(`[tools] ${installed.error}`);
    return 'missing';
  }
  const dir = installed.dir;
  const entry = path.join(dir, String(cfg.tools?.snowluma?.script ?? 'index.mjs'));
  if (!fs.existsSync(entry)) {
    log(`[tools] 找不到 SnowLuma 入口，跳过自动启动：${entry}`);
    return 'missing';
  }
  try {
    const out = fs.openSync(path.join(STATE_DIR, 'snowluma.log'), 'a');
    // 不用 detached：Windows 下 detached 走 DETACHED_PROCESS，它会顶掉 CREATE_NO_WINDOW，
    // 子进程于是「没有控制台」；SnowLuma 的 index.mjs 又会自己再 spawn 一次 node，
    // 那次 spawn 没有控制台可继承，Windows 就给它新开一个黑窗口——就是用户看到的那只。
    // 保留 windowsHide（= CREATE_NO_WINDOW，无窗控制台），孙进程继承它，全程不闪窗。
    // 子进程本来就不会因为父进程退出而死（unref 足够），所以 detached 不是必需的。
    const child = spawn(snowlumaNode(dir), [entry], { cwd: dir, stdio: ['ignore', out, out], windowsHide: true });
    child.on('error', (error) => log(`[tools] SnowLuma 自动启动失败：${error?.message ?? error}`));
    child.unref();
    toolChildren.snowluma = child;
    writeToolStateFile({ snowlumaPid: child.pid });
    log(`[tools] 网关没在跑，已自动拉起 SnowLuma pid=${child.pid}（日志 state/snowluma.log）`);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (await probeHttpAlive(cfg.snowluma?.httpUrl, 1200)) {
        log('[tools] SnowLuma 已就绪');
        return 'started';
      }
    }
    log(`[tools] SnowLuma 启动后 ${Math.round(waitMs / 1000)}s 内仍未监听，继续按原流程重试连接`);
    return 'timeout';
  } catch (error) {
    log(`[tools] SnowLuma 自动启动异常：${error?.message ?? error}`);
    return 'error';
  }
}

/** 工具进程的持久状态（桥接重启后还能认出之前拉起的梗图管理器）。 */
function readToolStateFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'tools.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeToolStateFile(patch) {
  const next = { ...readToolStateFile(), ...patch };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'tools.json'), JSON.stringify(next, null, 2), 'utf8');
  } catch (error) {
    log(`[tools] 写 state/tools.json 失败：${error?.message ?? error}`);
  }
  return next;
}

/** 读文件尾部若干行（日志面板用）。 */
function tailFileLines(file, maxLines) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    return lines.slice(-maxLines).join('\n');
  } catch (error) {
    return `（读不到日志 ${path.basename(file)}：${error?.message ?? error}）`;
  }
}

/**
 * 网关守护。
 *
 * 拉起只在启动时做一次的话，SnowLuma 崩一次（或被手动关掉）桥接就只剩无限重连：
 * 它连的是 3001，网关不在时那个端口连不上，重连循环再久也不会把网关拉起来。
 * 所以这里定期看一眼连接状态，连续两轮都没连上就重跑一次 ensureSnowlumaRunning
 * （它内部有「已在线就跳过」的判断，不会拉起第二份）。
 */
let snowlumaSupervisorTimer = null;
function stopSnowlumaSupervisor() {
  if (snowlumaSupervisorTimer) {
    clearInterval(snowlumaSupervisorTimer);
    snowlumaSupervisorTimer = null;
    log('[tools] 网关守护已停止（定时关闭流程）');
  }
}
function startSnowlumaSupervisor(cfg, isConnected) {
  if (cfg.tools?.snowluma?.enabled === false) return;
  if (cfg.tools?.snowluma?.autoStart === false) return;
  const interval = Math.max(10000, Number(cfg.tools?.snowluma?.superviseMs) || 60000);
  let misses = 0;
  let busy = false;
  let lastResult = '';
  const timer = setInterval(async () => {
    if (busy) return;
    if (isConnected()) {
      misses = 0;
      return;
    }
    misses += 1;
    if (misses < 2) return; // 第一次当抖动：桥接自己正在重连
    busy = true;
    try {
      const alive = await probeHttpAlive(cfg.snowluma?.httpUrl, 1500);
      if (alive) {
        if (lastResult !== 'alive-but-disconnected') {
          log('[tools] 守护：SnowLuma 进程在跑但桥接连不上（多半是 OneBot 没监听：QQ 没登录 / hook 没注入）');
          lastResult = 'alive-but-disconnected';
        }
        return;
      }
      log('[tools] 守护：SnowLuma 不在线，重新拉起');
      const result = await ensureSnowlumaRunning(cfg, { waitMs: 15000 });
      if (result !== lastResult) log(`[tools] 守护结果：${result}`);
      lastResult = result;
      if (result === 'missing') misses = 0; // 装不上就别每轮都刷日志
    } catch (error) {
      log(`[tools] 守护失败：${error?.message ?? error}`);
    } finally {
      busy = false;
    }
  }, interval);
  timer.unref?.();
  snowlumaSupervisorTimer = timer;
  log(`[tools] 网关守护已启动（每 ${Math.round(interval / 1000)}s 检查一次）`);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  // 被 DSH 插件（qq-bridge-launcher）拉起时，父进程会把 DSH 的真实端口直接传下来，
  // 省掉启动时那一轮端口探测——DSH 每次启动端口都变，探测要等失败才触发。
  const envBaseUrl = String(process.env.DSH_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (envBaseUrl && /^https?:\/\//.test(envBaseUrl) && envBaseUrl !== String(cfg.dsh.baseUrl ?? '').replace(/\/+$/, '')) {
    log(`使用插件注入的 DSH 地址：${cfg.dsh.baseUrl} → ${envBaseUrl}`);
    cfg.dsh.baseUrl = envBaseUrl;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();
  loadState();

  // 定时关闭锁：上一次安全关闭之后，任何自愈（守护窗口/插件拉活）把进程拉起来，
  // 都在这里直接退出，避免「关了又自己回来」。
  try {
    const lock = readJsonSafe(POWER_OFF_LOCK_FILE, null);
    const dshBaseUrl = String(process.env.DSH_BASE_URL || cfg.dsh?.baseUrl || '').replace(/\/+$/, '');
    const decision = evaluatePowerOffLock(lock, {
      nowMs: Date.now(),
      dshBaseUrl,
      force: process.env.QQ_BRIDGE_FORCE_START === '1'
    });
    if (decision.action === 'block') {
      const until = Number(lock?.until ?? 0);
      log(`定时关闭锁生效：${new Date(Number(lock?.at) || 0).toLocaleString()} 已安全关闭，${new Date(until).toLocaleString()} 前不自动恢复；恢复请重启 DSH（或删 state/power-off.lock / 设 QQ_BRIDGE_FORCE_START=1）`);
      // 42 = 计划内关闭：守护脚本见到这个退出码就不再拉起
      process.exit(42);
    }
    if (lock && decision.reason !== 'no-lock') {
      try { fs.unlinkSync(POWER_OFF_LOCK_FILE); } catch {}
      if (decision.reason === 'dsh-restarted') log('检测到 DSH 已重启，解除定时关闭锁并恢复桥接');
      else if (decision.reason === 'expired') log('定时关闭锁已过期，本次正常启动');
      else if (decision.reason === 'forced') log('已按 QQ_BRIDGE_FORCE_START=1 强制启动，解除定时关闭锁');
    }
  } catch (error) {
    log(`读取关闭锁失败（忽略，继续启动）：${error?.message ?? error}`);
  }

  // QQ 装在哪：先按 config，没配就扫注册表并写回 config.json
  autofillQqPath(cfg);

  // 网关跟着 DSH 一起起：没在跑就先拉起来，再走原来的连接流程。
  // 必须挂 catch：Node 15 起未处理的 promise rejection 会直接终止进程，
  // 而这里正是「网关没装/网络不通」最常见的失败点，不能让它把桥接带走。
  void ensureSnowlumaRunning(cfg).catch((error) => log(`[tools] 启动时自动拉起 SnowLuma 失败：${error?.message ?? error}`));

  // 父进程看门狗：DSH 被强杀（任务管理器结束进程、崩溃）时子进程不会变孤儿。
  // 插件侧本来也会在卸载时收尾，这一层只是兜底。
  const parentPid = Number(process.env.QQ_BRIDGE_PARENT_PID) || 0;
  if (parentPid > 0) {
    const parentWatch = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        log(`DSH 父进程（pid=${parentPid}）已退出，桥接随之退出`);
        process.exit(0);
      }
    }, 5000);
    parentWatch.unref?.();
  }

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = [];
  // 读失败时（被占用 / 权限 / JSON 损坏）必须**暂停写入**：否则内存里的空数组
  // 会在下一次 saveSlangStore() 时覆盖掉磁盘上那份数据，学到的词条全丢。
  let slangStoreWritable = true;
  try {
    slangEntries = loadSlang(SLANG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });
  } catch (error) {
    slangStoreWritable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);
  }
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // ── 共享知识库（跨人格、先审核后入库） ──────────────────────────────────
  // 检索和写入都在这一个实例上；换 embedding 后端只重建 embedder，store 通过
  // getEmbedder 拿最新的那个（避免每次改配置都把向量缓存丢一遍）。
  const KNOWLEDGE_FILE = path.join(STATE_DIR, 'knowledge.json');
  const buildKnowledgeEmbedder = () => createEmbedder({
    backend: cfg.knowledge?.backend ?? 'off',
    local: cfg.knowledge?.local ?? {},
    cloud: cfg.knowledge?.cloud ?? {},
    log
  });
  let knowledgeEmbedder = buildKnowledgeEmbedder();
  const knowledgeStore = createKnowledgeStore({
    file: KNOWLEDGE_FILE,
    getEmbedder: () => knowledgeEmbedder,
    log,
    maxEntries: Number(cfg.knowledge?.maxEntries ?? 3000),
    minScore: Number(cfg.knowledge?.minScore ?? 0.25),
    // 入库即扫违禁词：命中就先打标记，控制台立刻可见，不必等代理攒够一批
    scanItem: (item) => scanKnowledgeItem(item, { extraTerms: cfg.knowledge?.autoApprove?.extraTerms ?? [] })
  });

  /**
   * 黑话确认后立刻送向量库：写成一条自洽事实入库 + 向量化，
   * 后续 knowledge_search / 上下文注入会优先命中（黑话也走 embedding）。
   */
  async function ingestSlangKnowledge(entry) {
    const meaning = String(entry?.meaning ?? '').trim();
    if (!meaning) return null;
    const text = `群聊黑话「${entry.content}」：${meaning}`
      + (entry.usage ? `；用法：${entry.usage}` : '')
      + (entry.example ? `；示例：${entry.example}` : '');
    try {
      const result = await knowledgeStore.ingest({
        text,
        tags: ['黑话'],
        source: 'slang',
        note: `黑话确认入库：${entry.content}`
      });
      if (result?.ok) log(`黑话入库：${entry.content}（${result.embedded ? '已向量化' : '未向量化'}）`);
      else if (result?.duplicate) log(`黑话入库：${entry.content} 已存在，跳过`);
      else log(`黑话入库失败：${entry.content}：${result?.error ?? '未知'}`);
      return result;
    } catch (error) {
      log(`黑话入库失败：${entry?.content ?? ''}：${error?.message ?? error}`);
      return null;
    }
  }

  // ── 自动批准代理 ────────────────────────────────────────────────────────
  // 只在积压到阈值时动手；命中违禁词的条目只打标记、永不自动批准。
  // 联网核实：走桥接已有的 web-search（DeepSeek 联网优先，Bing 兜底）。
  // 搜不到/没凭据 → verifier 返回 unknown → 代理拦截转人工，这是刻意的安全默认。
  const knowledgeVerifier = createVerifier({
    search: (term) => webSearch(term, { root: ROOT, config: cfg.knowledge?.webSearch ?? {} }),
    // 分级只回答「来源可不可信」；判定模型回答「来源支不支持这句话」。
    // 这里用箭头包一层：judgeKnowledge 声明在本作用域靠后，初始化期不解析它。
    judge: (args) => judgeKnowledge(args),
    getConfig: () => cfg.knowledge?.autoApprove?.verify ?? {},
    log
  });

  // 判定器在这里就建好：GET /api/knowledge 要读它的统计，
  // 若等会话函数（靠后声明）再建，启动早期的一次请求会撞上 TDZ。
  // askJudgeSession 是函数声明，提升后可用；真正建会话发生在首次调用时。
  const knowledgeJudge = createJudge({
    ask: (prompt) => askJudgeSession(
      prompt,
      Number(cfg.knowledge?.autoApprove?.verify?.judge?.timeoutMs ?? 25000)
    ),
    getConfig: () => cfg.knowledge?.autoApprove?.verify?.judge ?? {},
    log
  });

  const knowledgeApprover = createAutoApprover({
    store: knowledgeStore,
    getConfig: () => cfg.knowledge?.autoApprove ?? {},
    log,
    extractTerms: (text) => extractDomainTerms(text, { extraTerms: cfg.knowledge?.autoApprove?.domainTerms ?? [] }),
    verify: (text, options) => knowledgeVerifier.verify(text, options)
  });

  // ── 审批代理（agent + 工具）：判断采集包是「唠嗑」还是「值得记的经验」 ──
  // 令牌只发给审批 worker 会话；工具端点凭它放行，普通群聊会话拿不到。
  const approverTokens = new Map(); // token -> { at, sessionId, batchId, packIds }
  // 审批工具成功提交次数（用于判断模型到底有没有走工具，而不是只看最终文本）
  let approverToolSubmits = 0;
  function issueApproverToken(sessionId, { batchId = '', packIds = [] } = {}) {
    const token = crypto.randomBytes(24).toString('hex');
    approverTokens.set(token, {
      at: Date.now(),
      sessionId,
      batchId: String(batchId ?? ''),
      packIds: new Set((packIds ?? []).map(String))
    });
    // 顺手清掉 1 小时前的，令牌表不无限长
    const cutoff = Date.now() - 3600000;
    for (const [key, value] of approverTokens) if (Number(value?.at ?? 0) < cutoff) approverTokens.delete(key);
    return token;
  }
  function approverTokenOk(token) {
    const rec = approverTokens.get(String(token ?? ''));
    return !!rec && Date.now() - Number(rec.at ?? 0) < 3600000;
  }
  /** 只按审批任务自己知道的包 ID / 批次 ID 找回令牌；不提供“随便拿一个”的入口。 */
  function findApproverToken({ id = '', batchId = '' } = {}) {
    const packId = String(id ?? '').trim();
    const batch = String(batchId ?? '').trim();
    if (!packId && !batch) return '';
    for (const [token, rec] of approverTokens) {
      if (!rec || Date.now() - Number(rec.at ?? 0) >= 3600000) continue;
      if (packId && rec.packIds?.has(packId)) return token;
      if (batch && rec.batchId === batch) return token;
    }
    return '';
  }

  /** 待审的采集包（跳过被违禁词拦截的：它们只能人工处理）。 */
  function pendingApproverPacks(limit = 200) {
    return knowledgeStore.list({ status: 'pending', limit })
      .filter((item) => !item.autoBlocked)
      // list() 返回的是对外字段，lines 只在原始条目里；先按 id 取回再筛
      .map((item) => knowledgeStore.get(item.id))
      .filter((raw) => raw && Array.isArray(raw.lines) && raw.lines.length > 0)
      .map((raw) => {
        const match = String(raw.text ?? '').match(/（([^）]*)）/);
        return {
          id: raw.id,
          group: raw.group,
          count: raw.lines.length,
          timeText: match ? match[1] : '',
          text: raw.text,
          lines: raw.lines
        };
      });
  }

  const approverScheduler = createApproverScheduler({
    getPending: () => pendingApproverPacks(500).length,
    listBatch: (limit) => pendingApproverPacks(limit),
    getOptions: () => ({
      ...(cfg.knowledge?.autoApprove?.agent ?? {}),
      mode: cfg.knowledge?.autoApprove?.mode === 'rules' ? 'rules' : 'agent'
    }),
    createWorker: (args) => createApproverWorker(args),
    log
  });

  // ── 聊天采集器：把别人的话按分钟打包成待审条目 ──────────────────────────
  const knowledgeCollector = createKnowledgeCollector({
    getConfig: () => cfg.knowledge?.collect ?? {},
    log,
    onFlush: (pack) => {
      if (cfg.knowledge?.enabled === false) return false;
      const entry = {
        text: pack.text,
        tags: pack.tags,
        source: pack.source ?? 'chat',
        group: pack.key ?? pack.group,
        proposedBy: pack.exempt ? 'web-reply' : 'chat-collector',
        note: pack.note,
        // 人格联网查证后的回复：带凭据入库，仍然要人工放行
        exempt: pack.exempt ?? null
      };
      // 采集流默认「直连」：群消息一包直接进 embedding 检索池，不经过代理/人格审读。
      // 违禁词闸门仍在 add() 里（命中只打标记、保持待审，不向量化）。
      const direct = pack.exempt ? false : (cfg.knowledge?.collect?.direct === true);
      if (direct) {
        void knowledgeStore.ingest(entry)
          .then((result) => {
            if (!result?.ok) {
              if (!result?.duplicate) log(`知识采集：直采失败（${result?.error ?? '未知'}）`);
              return;
            }
            if (result.blocked) log(`知识采集：${result.id} 命中违禁词，已留在待审，不向量化`);
            if (result.evicted) log(`知识采集：库满，淘汰 ${result.evicted} 条最旧直采条目`);
          })
          .catch((error) => log(`知识采集：直采异常（${error?.message ?? error}）`));
        return true;
      }
      const added = knowledgeStore.add({ ...entry, lines: pack.lines ?? null });
      if (!added.ok) {
        if (!added.duplicate) log(`知识采集：写入失败（${added.error ?? '未知'}）`);
        return false;
      }
      // 进待审后立刻叫醒审批代理：积压 ≥ 阈值会直接拉满并行，不必等下一次巡检
      if (cfg.knowledge?.autoApprove?.mode !== 'rules') {
        void approverScheduler.tick().catch((error) => log(`审批代理调度失败：${error?.message ?? error}`));
      }
      return true;
    }
  });
  const knowledgeCollectTimer = setInterval(() => {
    try {
      knowledgeCollector.tick();
    } catch (error) {
      log(`知识采集巡检失败：${error?.message ?? error}`);
    }
  }, 15000);
  knowledgeCollectTimer.unref?.();
  let knowledgeApproverTimer = null;
  // 被拦截的条目长期没人处理就归档到「已拒绝」：不占待审队列、不再被列表窗口挤掉，
  // 但拦截凭据（autoBlocked / verification）全部保留，控制台可以一键放回待审。
  function sweepStaleBlocked() {
    try {
      const days = Number(cfg.knowledge?.autoApprove?.archiveDays ?? 30);
      if (!(days > 0)) return;
      const swept = knowledgeStore.archiveStaleBlocked({ olderThanMs: days * 86400000 });
      if (swept.archived) log(`知识库：${swept.archived} 条拦截超过 ${days} 天未处理，已归档到「已拒绝」`);
    } catch (error) {
      log(`知识库归档清扫失败：${error?.message ?? error}`);
    }
  }
  sweepStaleBlocked();

  function startKnowledgeApproverTimer() {
    if (knowledgeApproverTimer) clearInterval(knowledgeApproverTimer);
    const intervalMs = Math.max(5000, Number(cfg.knowledge?.autoApprove?.intervalMs ?? 60000));
    knowledgeApproverTimer = setInterval(() => {
      // 归档清扫放前面：先让超期拦截退场，再看还有多少待处理值得跑一轮
      sweepStaleBlocked();
      if (cfg.knowledge?.autoApprove?.mode === 'rules') {
        // run 内部先看阈值，不满足就立刻返回，所以「多久看一眼」不影响语义
        void knowledgeApprover.run().catch((error) => log(`自动批准代理运行失败：${error?.message ?? error}`));
        return;
      }
      void approverScheduler.tick().catch((error) => log(`审批代理调度失败：${error?.message ?? error}`));
    }, intervalMs);
    knowledgeApproverTimer.unref?.();
  }
  startKnowledgeApproverTimer();

  // ── 定时问候：真实网络时间到点直发（不经过代理） ──────────────────────────
  const greetingStore = createGreetingStore({ file: GREETINGS_FILE, log });
  greetingStore.load(fs);
  greetingStore.bindWriter(atomicWriteJson);
  const greetingClock = createNetworkClock({
    urls: resolveGreetingConfig(cfg.greetings).networkTimeUrls,
    log
  });
  let greetingTimer = null;
  let greetingFiring = false;
  let greetingLastError = '';
  let greetingLastTickAt = 0;

  const greetingConfig = () => resolveGreetingConfig(cfg.greetings);

  /** 问候图片只允许两个目录：state/greetings（上传）与 assets（随包图片）。 */
  function resolveGreetingImage(rawPath) {
    const raw = String(rawPath ?? '').trim();
    if (!raw) return '';
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ROOT, raw);
    const allowed = [path.join(STATE_DIR, 'greetings'), path.join(ROOT, 'assets')];
    const inside = allowed.some((dir) => abs === dir || abs.startsWith(dir + path.sep));
    if (!inside) throw new Error('问候图片必须放在 state/greetings 或 assets 目录下');
    if (!fs.existsSync(abs)) throw new Error(`问候图片不存在：${raw}`);
    return abs;
  }

  const GREETING_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

  const GREETINGS_POOL_NOTES_FILE = path.join(GREETINGS_IMAGE_DIR, 'pool.json');

  /** 图池每张图的人工描述（控制台可编辑），用于「按文字意思配图」。 */
  function greetingPoolNotes() {
    try {
      const raw = JSON.parse(fs.readFileSync(GREETINGS_POOL_NOTES_FILE, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch { return {}; }
  }

  function saveGreetingPoolNotes(notes) {
    try { atomicWriteJson(GREETINGS_POOL_NOTES_FILE, notes); } catch (error) {
      log(`问候图池描述保存失败：${error?.message ?? error}`);
    }
  }

  /** 可选的图片池：state/greetings/images/pool + assets，带描述。 */
  function greetingImagePool() {
    const out = [];
    const walk = (dir, depth = 0) => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        const full = path.join(dir, name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) { if (depth < 3) walk(full, depth + 1); continue; }
        if (!GREETING_IMAGE_EXTS.has(path.extname(name).toLowerCase())) continue;
        out.push(path.relative(ROOT, full).split(path.sep).join('/'));
      }
    };
    // 只把「图片池」当成配图来源：pool/ 子目录 + assets；
    // 条目单独上传的图（images/<id>.*）属于那一条，不混进池里。
    walk(path.join(GREETINGS_IMAGE_DIR, 'pool'));
    walk(path.join(ROOT, 'assets'));
    // 去重（同一文件不会出现两次，但上传目录与 assets 可能同名不同路径，保留全部）
    const notes = greetingPoolNotes();
    return [...new Set(out)].sort().map((rel) => ({
      path: rel,
      desc: String(notes[rel] ?? '').trim()
    }));
  }

  async function sendGreetingEntry(kind, id, entry) {
    const text = String(entry?.text ?? '').trim();
    if (!text) throw new Error('问候语为空，未发送');
    // 没配图就只发文字：不再随机抽一张（配图必须贴合文字意思）。
    const imagePath = entry?.imagePath ? resolveGreetingImage(entry.imagePath) : '';
    await onebotSendRich(kind, id, { text, imagePath });
  }

  /**
   * 发一条问候。schedule = 到点自动；test = 控制台手动测试（不记触发）。
   * 文字与图片在同一个 message 的 segments 里，QQ 侧是同一个气泡。
   */
  async function fireGreeting({ slot = 'any', target = '', entryId = '', reason = 'schedule' } = {}) {
    const conf = greetingConfig();
    const targets = target ? [target] : conf.targets;
    if (!targets.length) return { ok: false, error: '没有配置目标会话（例：group:1098011551）' };
    const entry = entryId
      ? greetingStore.entries().find((item) => item.id === entryId)
      : pickEntry(greetingStore.entries(), slot);
    if (!entry) return { ok: false, error: '没有可用的问候条目（先在控制台生成或添加）' };
    const sent = [];
    const errors = [];
    for (const item of targets) {
      const m = /^(group|private):(\d+)$/.exec(item);
      if (!m) { errors.push(`${item}：目标格式应为 group:群号 或 private:QQ号`); continue; }
      try {
        await sendGreetingEntry(m[1], m[2], entry);
        sent.push(item);
        log(`定时问候：已向 ${item} 发送「${entry.text.slice(0, 30)}」${entry.imagePath ? '（含图片）' : ''}`);
      } catch (error) {
        errors.push(`${item}：${error?.message ?? error}`);
        log(`定时问候发送失败（${item}）：${error?.message ?? error}`);
      }
    }
    if (sent.length && reason === 'schedule') {
      try {
        const time = await greetingClock.current();
        greetingStore.markFired({
          date: zonedParts(time.nowMs, conf.timeZone).date,
          slot,
          entryId: entry.id,
          target: sent.join(',')
        });
      } catch (error) {
        log(`定时问候：记录触发失败：${error?.message ?? error}`);
      }
    }
    if (!sent.length) greetingLastError = errors.join(' / ');
    return { ok: sent.length > 0, entry, sent, errors };
  }

  async function greetingTick() {
    // 只有「完全静默」才连调度一起停；拦截模式照常生成，发送在链路终点被拦。
    if (devOffActive()) return;
    greetingLastTickAt = Date.now();
    if (greetingFiring) return;
    const conf = greetingConfig();
    if (!conf.enabled || !conf.targets.length) return;
    greetingFiring = true;
    try {
      const time = await greetingClock.current();
      const date = zonedParts(time.nowMs, conf.timeZone).date;
      const due = dueSlots({ config: conf, nowMs: time.nowMs, firedToday: greetingStore.firedToday(date) });
      for (const item of due) {
        await fireGreeting({ slot: item.slot, reason: 'schedule' });
      }
    } catch (error) {
      greetingLastError = String(error?.message ?? error);
      log(`定时问候巡检失败：${greetingLastError}`);
    } finally {
      greetingFiring = false;
    }
  }

  function startGreetingTimer() {
    if (greetingTimer) clearInterval(greetingTimer);
    greetingTimer = setInterval(() => { void greetingTick(); }, 20000);
    greetingTimer.unref?.();
    // 启动先对一次时，让控制台能立刻看到网络时间/偏移
    void greetingClock.current().catch(() => {});
  }
  startGreetingTimer();

  // ── 定时安全关闭 / 定时关机 ───────────────────────────────────────────
  // 顺序保证：启用安全关闭时，关机命令只在清理完成（定时器停、队列清、状态落盘）之后发出。
  let powerState = { date: '', safeCloseDone: false, shutdownIssued: false };
  let powerClosing = false;
  let powerTimer = null;

  function issueSystemShutdown(delaySec, reason) {
    const seconds = Math.max(10, Math.min(600, Math.round(Number(delaySec) || 60)));
    if (process.platform !== 'win32') {
      log(`定时关机：当前平台 ${process.platform} 不支持，跳过`);
      return false;
    }
    try {
      const child = spawn('shutdown', ['/s', '/t', String(seconds), '/c', String(reason || '每日定时关机')], {
        detached: true, stdio: 'ignore', windowsHide: true
      });
      child.unref?.();
      return true;
    } catch (error) {
      log(`定时关机：调用 shutdown 失败：${error?.message ?? error}`);
      return false;
    }
  }

  function cancelSystemShutdown() {
    if (process.platform !== 'win32') return false;
    try {
      const child = spawn('shutdown', ['/a'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref?.();
      return true;
    } catch (error) {
      log(`取消关机失败：${error?.message ?? error}`);
      return false;
    }
  }

  async function performSafeClose(reason) {
    if (powerClosing) return false;
    powerClosing = true;
    log(`定时安全关闭：开始（${reason}）`);
    // 先掐断所有「自愈」来源，再落锁：否则进程退出后会被守护窗口/插件立刻拉回来。
    try { stopSnowlumaSupervisor(); } catch {}
    try { if (greetingTimer) { clearInterval(greetingTimer); greetingTimer = null; } } catch {}
    try { if (powerTimer) { clearInterval(powerTimer); powerTimer = null; } } catch {}
    try { clearAllSocialV2Timers(); } catch {}
    try { drainAllPromptQueues('定时安全关闭'); } catch {}
    try { approverScheduler.stop?.(); } catch {}
    // 关闭锁：默认 10 小时内不允许自愈拉起；想强制启动用 QQ_BRIDGE_FORCE_START=1
    const offHours = Math.max(1, Math.min(72, Number(cfg.power?.offHours) || 10));
    const at = Date.now();
    try {
      atomicWriteJson(POWER_OFF_LOCK_FILE, {
        at,
        until: at + offHours * 3600000,
        reason: String(reason || ''),
        // 记录关闭时的 DSH 地址：下次启动地址不同 = DSH 重启过 = 用户想恢复
        dshBaseUrl: String(process.env.DSH_BASE_URL || cfg.dsh?.baseUrl || '').replace(/\/+$/, '')
      });
      log(`定时安全关闭：已写关闭锁（${offHours} 小时内不自动恢复）`);
    } catch (error) {
      log(`定时安全关闭：写关闭锁失败：${error?.message ?? error}`);
    }
    try { saveState(); } catch {}
    try { saveSocialV2State(); } catch {}
    log('定时安全关闭：自愈已停、定时器已清、状态已落盘');
    return true;
  }

  async function powerTick() {
    if (powerClosing) return;
    const conf = resolvePowerConfig(cfg.power);
    if (!conf.enabled) return;
    let nowMs;
    try { nowMs = (await greetingClock.current()).nowMs; } catch { nowMs = Date.now(); }
    const parts = zonedParts(nowMs, conf.timeZone);
    if (powerState.date !== parts.date) powerState = { date: parts.date, safeCloseDone: false, shutdownIssued: false };
    // 用「墙钟分钟 + 30 分钟窗口」判定到点：plan 里的 nextDailyAt 只用于界面显示下次时间。
    const closeMin = clockMinutes(conf.safeCloseTime);
    const shutMin = clockMinutes(conf.shutdownTime);
    const nowMin = Number(parts.minutes);
    const shutdownDelayForClose = shutMin != null && closeMin != null && shutMin > closeMin
      ? (shutMin - closeMin) * 60
      : conf.shutdownDelaySeconds;

    if (conf.safeCloseEnabled && !powerState.safeCloseDone && isWithinDailyWindow(nowMin, closeMin)) {
      log(`定时安全关闭：到点（${conf.safeCloseTime}，现在 ${parts.time}${conf.dryRun ? '，演练模式' : ''}）`);
      if (conf.dryRun) {
        powerState.safeCloseDone = true;
        if (conf.shutdownEnabled) {
          powerState.shutdownIssued = true;
          log(`定时关机（演练）：安全关闭完成后 ${shutdownDelayForClose}s 会关机`);
        }
        return;
      }
      await performSafeClose('定时安全关闭');
      powerState.safeCloseDone = true;
      if (conf.shutdownEnabled) {
        if (issueSystemShutdown(shutdownDelayForClose, conf.shutdownReason)) {
          powerState.shutdownIssued = true;
          log(`定时关机：安全关闭完成，已安排 ${shutdownDelayForClose}s 后关机`);
        }
      }
      setTimeout(() => { log('定时安全关闭：桥接进程退出（计划内关闭，守护脚本不要再拉起）'); process.exit(42); }, 3000).unref?.();
      return;
    }
    if (!conf.safeCloseEnabled && conf.shutdownEnabled && !powerState.shutdownIssued
      && isWithinDailyWindow(nowMin, shutMin)) {
      log(`定时关机：到点（${conf.shutdownTime}，现在 ${parts.time}${conf.dryRun ? '，演练模式' : ''}）`);
      if (conf.dryRun) { powerState.shutdownIssued = true; return; }
      // 关机前也先做一遍安全关闭（停自愈 + 落锁），避免关机倒计时期间被自愈拉回来。
      await performSafeClose('定时关机前安全关闭');
      powerState.safeCloseDone = true;
      if (issueSystemShutdown(conf.shutdownDelaySeconds, conf.shutdownReason)) {
        powerState.shutdownIssued = true;
        log(`定时关机：安全关闭完成，按计划 ${conf.shutdownDelaySeconds}s 后关机`);
      }
      setTimeout(() => { log('定时关机：桥接进程退出（计划内关闭，守护脚本不要再拉起）'); process.exit(42); }, 3000).unref?.();
    }
  }

  function startPowerTimer() {
    if (powerTimer) clearInterval(powerTimer);
    powerTimer = setInterval(() => { void powerTick(); }, 20000);
    powerTimer.unref?.();
  }
  startPowerTimer();
  // 启动后后台补一轮图池含义（不阻塞启动；之后生成问候就不用再等）
  setTimeout(() => { describePoolInBackground().catch(() => {}); }, 20000).unref?.();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  // 库文件损坏/读不动时**不能当成空库继续**：下面任何一次 saveStickerStoreSafe 都会把
  // 「空库」写回去，把 AI 学到的 localNote/tags/usage 永久清零。读失败就显式降级为
  // 「只读不写」，并留下醒目日志（与 loadSlang 的 slangStoreWritable 同一套路）。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    if (!stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // ── 读接口的 HTTP 兜底：WS 挂了不等于网关挂了 ──────────────────────────────
  //
  // 为什么要有：`fetch_custom_face_detail` 原来只走 SnowLuma 的 WS action，于是
  // 「WS 正在重连」这段时间里表情库同步必然失败。日志实测 33 次同步里 16 次失败（≈48%），
  // 全是 `SnowLuma WebSocket closed before opening`；表现就是操作者说的
  // 「有时读群友的表情包会失败」——库里没有新收藏 ⇒ qq_get_sticker_image 直接报「找不到表情」。
  //
  // 而**同一个网关的 HTTP 口一直是可用的**（onebotSend 发消息、fetch_ptt_text 转写都直接用它）。
  // 读接口没有理由单点依赖 WS。这里只在 WS 失败时兜底，不改变正常路径的延迟。
  async function onebotHttpAction(action, params = {}, { timeoutMs = 15000 } = {}) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
      throw new Error(`OneBot HTTP ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body;
  }

  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
      let response;
      let via = 'ws';
      try {
        response = await bot.request('fetch_custom_face_detail', { count });
        if (!response || response.status !== 'ok' || response.retcode !== 0) {
          throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
        }
      } catch (wsError) {
        // WS 失败 ⇒ 立刻用 HTTP 再问一次同一个 action（语义相同，token 可能不同但同一账号）。
        log(`[sticker] WS 同步不可用（${wsError?.message ?? wsError}），改走 OneBot HTTP 兜底`);
        response = await onebotHttpAction('fetch_custom_face_detail', { count });
        via = 'http';
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条，via ${via}）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false, via };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();

  /**
   * 出站语音的内容审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的**文件名**
   * 都不允许外发（语音的音频内容本身无法审计，但文件名同样会泄露路径与项目信息）。
   */
  function assertOutboundAuditOk(key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  function voiceCfg() {
    const v = cfg.socialV2?.voice ?? {};
    return {
      enabled: v.enabled !== false,
      dir: path.resolve(ROOT, String(v.dir ?? 'audio')),
      maxSeconds: Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 300,
      maxBytes: Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 20 * 1024 * 1024,
      maxPerMinute: Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 2,
      maxPerHour: Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 10,
      allowAbsolutePath: v.allowAbsolutePath === true,
      defaultVolume: Number(v.defaultVolume) > 0 ? Number(v.defaultVolume) : 1,
      loudness: v.loudness || 'normal',
      ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
      autoReadback: v.autoReadback !== false
    };
  }

  function voiceLibrary() {
    const dir = voiceCfg().dir;
    const files = listAudioFiles(dir);
    return files.map((f) => {
      let stat = null;
      try { stat = fs.statSync(f); } catch {}
      return { name: path.relative(dir, f).split(path.sep).join('/'), bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 };
    });
  }

  /**
   * 把「AI 给的语音引用」解析成可发送的本地绝对路径。
   *
   * 安全边界：**AI 只能从语音库目录里取文件**（防 prompt injection 拿任意本地文件当语音外发）。
   *
   * 历史坑（已修）：这里曾经在 `socialV2.voice.allowAbsolutePath: true` 时直接把 AI 给的
   * 绝对路径交给 resolveAudioSource 解析，于是「AI 传 C:\Users\x\Music\任意.mp3」
   * 就能把本机任意音频（< 20 MB）发到群里 —— 而 inspectAudio 对「没有音频流」或
   * ffprobe 不可用的情况是放行的，等于把开关变成了任意文件外发通道。
   * 现在即使开了这个开关，也要求绝对路径**必须落在语音库目录之内**；
   * 真要从库外发文件请走操作者通道（resolveVoicePathForOperator / CLI）。
   */
  function voicePathInsideLibrary(vc, absPath) {
    const rel = path.relative(vc.dir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return safeJoinLibrary(vc.dir, rel);
  }

  function resolveVoicePathForV2(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频：给语音库里的文件名（可用 qq_list_voices 查看）');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受语音库里的本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const isAbs = path.isAbsolute(raw) || /^file:\/\//i.test(raw) || raw.startsWith('~');

    let resolved = null;
    if (isAbs) {
      const r = resolveAudioSource(raw, {});
      const confined = r.path ? voicePathInsideLibrary(vc, r.path) : null;
      if (confined) {
        resolved = { path: confined, via: `${r.via}+library-confined` };
      } else {
        // 只报目录名，不报绝对路径：这条消息会经 MCP 工具错误回给模型，
        // 而模型面对的是不可信的群聊内容（prompt injection 可能诱导它复述本机路径）。
        throw new Error(`语音只能从语音库取文件（语音库目录：${path.basename(vc.dir)}）；即使是绝对路径也必须位于语音库之内（socialV2.voice.allowAbsolutePath 已不再放宽 AI 通道）。请把音频放进语音库，或用操作者通道（CLI / 控制台）发送库外文件。`);
      }
    } else {
      // ⚠️ 安全关键：相对路径**只能**在语音库内解析。
      //
      // 不能直接丢给 resolveAudioSource —— 它会**先用 process.cwd() 解析相对路径**
      // （voice-core.js 的 cwd 分支），于是 AI 传 `..\..\某个\本机文件.mp3` 就能读库外文件，
      // 把 allowAbsolutePath=false 这个闸门整个绕过去（实测可复现）。
      // 相对路径一律先过 safeJoinLibrary（含 realpath 复核，挡 symlink 逃逸）。
      const joined = safeJoinLibrary(vc.dir, raw);
      if (joined && fs.existsSync(joined) && fs.statSync(joined).isFile()) {
        resolved = { path: joined, via: 'voice-dir-safe' };
      } else {
        // 允许省略扩展名：逐个补常见扩展名再在库内试一次（仍然不越出语音库）
        if (!path.extname(raw)) {
          for (const ext of AUDIO_EXTS) {
            const cand = safeJoinLibrary(vc.dir, `${raw}${ext}`);
            if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              resolved = { path: cand, via: 'voice-dir-safe+ext' };
              break;
            }
          }
        }
        if (!resolved) {
          // 库内没找到：检查是不是"想读库外文件"（这条错误要说清楚，避免误以为是名字写错）
          const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw) || path.isAbsolute(raw);
          if (looksLikeEscape) {
            throw new Error('语音只能从语音库取文件：路径里出现了「..」或绝对路径，已拒绝（防止读到库外的本机文件）');
          }
        }
      }
    }

    if (resolved) return { path: resolved.path, via: resolved.via, resolvedFrom: raw };

    // 模糊提示：只列库内文件（绝不回显库外路径）
    const library = voiceLibrary();
    const hint = library.length
      ? `语音库里现有：${library.slice(0, 12).map((x) => x.name).join('、')}${library.length > 12 ? ` 等 ${library.length} 个` : ''}`
      : `语音库（${path.basename(vc.dir)}）目前是空的，先把音频文件放进去`;
    // 按 basename 去扩展名做近似匹配（只用于提示）
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    const fuzzyHits = library
      .filter((x) => {
        const base = path.basename(x.name).toLowerCase();
        return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
      })
      .map((x) => x.name);
    const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
    throw new Error(`语音库里找不到「${raw}」${fuzzy}。${hint}`);
  }

  /**
   * 操作者通道（CLI）的路径解析：允许绝对路径（操作者本来就能读本机文件），
   * 相对路径先按「语音库」解析，再按当前工作目录解析 —— 这样两种直觉写法都成立。
   * base64/http 来源仍然禁止：语音应来自本地文件，别让 CLI 变成任意 URL 的外发口子。
   */
  function resolveVoicePathForOperator(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频路径');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const r = resolveAudioSource(raw, { voiceDir: vc.dir });
    if (r.path) return { path: r.path, via: r.via, resolvedFrom: raw };
    const fuzzy = r.candidates?.length ? `；语音库近似匹配：${r.candidates.map((c) => path.basename(c.path)).join('、')}` : '';
    throw new Error(`找不到音频「${raw}」${fuzzy}`);
  }

  /**
   * 语音发送限流：与文本发送分开计数，避免语音吃掉聊天额度（也避免聊天把语音额度耗光）。
   *
   * 只**检查**不占额度：额度在真正发出去之后才由 voiceBudgetCommit 记账 ——
   * 这样参数错、被审计拦截、网关失败都不会白白吃掉配额（否则连失败几次就被假 429 卡住）。
   */
  function voiceBudgetCheck(scopeKey, cfgV) {
    const now = Date.now();
    const bucket = voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) {
      throw new Error(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) {
      throw new Error(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }

  /** 语音真正发出后记账（顺带裁掉超过 1 小时的旧时间戳，避免数组无界增长）。 */
  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(scopeKey, bucket);
  }

  /**
   * 底层发送：把音频作为 record 段交给 SnowLuma。
   * guard=true（agent 通道）时，发送前必须通过 captureSendGuard —— 会话/模式/白名单任一变
   * 就放弃发送；guard=false（操作者通道）时不套会话闸门（操作者可能不在任何会话里）。
   *
   * audio 可传音量设置 { volume, normalize, loudness }：SnowLuma 的 record 段没有增益字段，
   * 所以音量必须在本地用 ffmpeg 调好再发（临时文件发完即删）。
   */
  async function sendVoiceV2(key, filePath, { guard = false, audit = true, audio = null } = {}) {
    if (devModeEnabled()) {
      devInterceptSend('send_record', key, `语音 ${path.basename(String(filePath ?? ''))}`);
      return {
        messageId: null, bytes: 0, duration: null, codec: '', warnings: [],
        detail: '（开发者模式：语音已拦截，未真正发出）',
        audioProcessing: [], volume: null, loudness: null, audioMode: 'intercepted'
      };
    }
    const vc = voiceCfg();
    // 注意：这里**不检查** vc.enabled —— 那是「AI 能不能发语音」的开关，判定放在
    // AI 路由（/api/socialV2/send-voice）与 sendVoiceForV2 里。底层只管发，
    // 否则"默认不启用"会连操作者通道（CLI / 控制台面板 / 图形界面）一起封死。
    if (audit) assertOutboundAuditOk(key, `[语音:${path.basename(filePath)}]`);
    let info;
    try {
      info = await inspectAudio(filePath, { maxBytes: vc.maxBytes, maxSeconds: vc.maxSeconds });
    } catch (error) {
      throw new Error(`音频检查失败：${error?.message ?? error}`);
    }
    if (!info.ok) throw new Error(`音频不可发送：${info.error}`);

    // 音量处理（默认原样 → 不产生临时文件）
    let processed;
    try {
      processed = await processAudioVolume(filePath, {
        volume: audio?.volume ?? vc.defaultVolume,
        normalize: audio?.normalize === true,
        loudness: audio?.loudness ?? vc.loudness,
        ffmpegPath: vc.ffmpegPath
      });
    } catch (error) {
      throw new Error(`音量处理失败：${error?.message ?? error}`);
    }
    const sendPath = processed.path;

    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const [kind, id] = key.split(':');
    const recordSegment = { type: 'record', data: { file: sendPath } };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendChain = sendChain.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        // 语音条比图片大、要过一次 SILK 转码，给 60s 预算（文本/图片共用同一 sendChain，
        // 所以这条语音发完之前后面的文本会自然排队，不会插队到语音前面）。
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: [recordSegment] }
          : { group_id: Number(id), message: [recordSegment] };
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(60000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    try {
      const data = await sendPromise;
      return {
        messageId: data?.message_id ?? null,
        bytes: info.size,
        duration: info.duration ?? null,
        codec: info.codec ?? '',
        warnings: info.warnings ?? [],
        detail: describeAudio(info),
        // 音量处理信息：mode='original' 表示没动过（没产生临时文件）
        audioProcessing: processed.detail,
        volume: processed.volume,
        loudness: processed.loudness,
        audioMode: processed.mode
      };
    } finally {
      // 音量处理产物是一次性的：发完（或失败）就删，别把 temp 撑大
      cleanupTemp(sendPath, processed.converted);
    }
  }

  /** 把「我发了条语音」写进二代会话的 recentMessages，让 AI 自己知道刚发过什么。 */
  function recordVoiceSentV2(key, sent, label) {
    const st = getSocialV2State(key);
    const display = label || `[语音 ${sent.detail}]`;
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      at: Date.now()
    };
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    st.lastAiReplyAt = entry.at;
    st.lastActionAt = entry.at;
    st.wakeConfig.noActionCount = 0;
    saveSocialV2State();
  }

  /**
   * 发完语音后的**落地验证**：把这条消息从网关读回来，确认它真的带着 record 段。
   *
   * 为什么不用 fetch_ptt_text 做这件事：那个动作依赖 QQ 侧的语音转写结果，
   * 而**自己发出去的**语音根本不会产生转写（实测 retcode=100「消息中不包含语音」）。
   * 想让 AI 确认「语音真的发出去了」，唯一可靠的证据是 get_msg 回读到的 record 段。
   * 返回 { confirmed, file, duration } 或 null（读不回来不影响"已发送"这个事实）。
   */
  async function verifyVoiceMessageSent(messageId) {
    if (!messageId) return null;
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: Number(messageId) }),
        signal: AbortSignal.timeout(30000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
      const segments = Array.isArray(body.data?.message) ? body.data.message : [];
      const record = segments.find((s) => s?.type === 'record');
      if (!record) return null;
      // 注意：只回报「确认成功 + 时长」，**不回传 file/url**。
      // 私聊消息里 get_msg 会把源文件路径塞进 url（如 D:\...\audio\xxx.mp3），
      // 回给 AI 就等于把本机路径写进模型上下文（也会被敏感信息审计拦）。
      return {
        confirmed: true,
        duration: record.data?.duration != null ? Number(record.data.duration) : null
      };
    } catch (error) {
      log(`[voice] 发送后回读校验失败（不影响已发送）：${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * AI 通道入口：解析引用 → 限流 → 发送 → 记账 → 回读校验。
   * 返回 { messageId, detail, verified, readback }。
   */
  async function sendVoiceForV2(key, voiceRef, { label = '', verify = null, readback = false, audio = null } = {}) {
    const vc = voiceCfg();
    if (!vc.enabled) throw new Error('语音功能已关闭（socialV2.voice.enabled=false）');
    const resolved = resolveVoicePathForV2(voiceRef);
    // 音量参数校验前置（AI 传错时给出可读错误，而不是让 ffmpeg 报奇怪的错）
    if (audio) resolveAudioProcessing({ volume: audio.volume ?? vc.defaultVolume, normalize: audio.normalize === true, loudness: audio.loudness ?? vc.loudness });
    voiceBudgetCheck(key, vc);
    const sent = await sendVoiceV2(key, resolved.path, { guard: true, audit: true, audio });
    voiceBudgetCommit(key);
    recordVoiceSentV2(key, sent, label);
    log(`[voice] ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice] 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
    let readbackText = null;
    const wantReadback = readback === true;
    if (wantReadback && sent.messageId) {
      try {
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify({ message_id: String(sent.messageId) }),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.status === 'ok' && body.retcode === 0) readbackText = body.data?.text ?? '';
      } catch (error) {
        log(`[voice] 语音转写回读失败（不影响已发送）：${error?.message ?? error}`);
      }
    }
    // 默认做「回读到 record 段」的落地校验；转写按需（自己发的语音通常没有转写）。
    const wantVerify = verify === true || (verify !== false && vc.autoReadback);
    const verification = wantVerify ? await verifyVoiceMessageSent(sent.messageId) : null;
    return { ...sent, key, file: resolved.path, via: resolved.via, verification, readback: readbackText };
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  /**
   * 回退成 image 段时用的表情图片段：先把尺寸钳到表情渲染大小。
   *
   * QQ 对 image 段是按「图片」渲染的，原图多大就铺多大——回退路径如果不处理，
   * 观感就和手动发表情差一个量级。所以这里统一压到长边 240（config 可调，
   * 但被 normalizeStickerForSend 钳在 64~512）。
   */
  async function stickerImageSegment(url, entryId) {
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    const image = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
    const edge = Number(cfg.socialV2?.sticker?.fallbackMaxEdge) || 240;
    const shrunk = await normalizeStickerForSend(image.buffer, {
      maxEdge: edge,
      ffmpegPath: cfg.socialV2?.voice?.ffmpegPath ?? null,
      tmpDir: path.join(STATE_DIR, 'tmp')
    });
    if (shrunk.note) log(`[sticker] ${shrunk.note}`);
    return { type: 'image', data: { file: 'base64://' + shrunk.buffer.toString('base64'), sub_type: 1, summary: '[动画表情]' } };
  }

  async function sendStickerV2(key, stickerRef, options = {}) {
    if (devModeEnabled()) {
      devInterceptSend('send_custom_face', key, `表情 ${stickerRef}`);
      const entry = findSticker(stickerEntries, stickerRef) || { id: String(stickerRef) };
      return { entry, messageId: null, intercepted: true };
    }
    const assertSendAllowed = captureSendGuard(key);
    // immediate=true：文字发完立刻跟上（合成发送用），跳过同步与停顿，把延迟压到最低。
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = options.immediate ? null : await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    const targetParams = kind === 'private' ? { user_id: Number(id) } : { group_id: Number(id) };
    const sendAction = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    let replyId = '';
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      replyId = rid;
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 首选网关的「收藏表情」通道（send_custom_face）：QQ 按表情渲染，是小图。
    // 以前一律下载字节后发 image 段——那是一张**普通图片**，QQ 按原图尺寸铺满显示，
    // 看起来就是"接口发的图很大，手动发的很小"。
    // send_custom_face 不能带 @，需要 @ 时退回图片段（带 sub_type:1 尽量按表情渲染）。
    const emojiId = String(entry.id || entry.md5 || '').trim();
    const useCustomFace = !atUserId && !options.forceImage && !!emojiId;
    if (!useCustomFace) {
      try {
        segments.push(await stickerImageSegment(url, entry.id));
      } catch (error) {
        throw new Error(`表情 ${entry.id} 的图片下载失败（QQ CDN 网络异常或地址已失效）：${error?.message ?? error}`);
      }
    }
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const post = async (action, params) => {
      const res = await fetch(`${httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
        const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
        throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
      }
      return body.data;
    };
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 单独发表情时只留一点点手速感；合成发送（immediate）则完全不睡，文字和表情几乎同时到。
        if (!options.immediate) await sleep(randInt(120, 300));
        assertSendAllowed();
        let data;
        if (useCustomFace) {
          try {
            data = await post('send_custom_face', {
              emoji_id: emojiId,
              ...targetParams,
              ...(replyId ? { reply_to: replyId } : {})
            });
          } catch (error) {
            // 网关不支持/表情 ID 失效时退回图片段，别让整条消息发不出去。
            log(`[sticker] send_custom_face 失败，退回图片段：${error?.message ?? error}`);
            const fallback = replyId ? [{ type: 'reply', data: { id: replyId } }] : [];
            fallback.push(await stickerImageSegment(url, entry.id));
            data = await post(sendAction, { ...targetParams, message: fallback });
          }
        } else {
          data = await post(sendAction, { ...targetParams, message: segments });
        }
        sendResolve(data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  function saveSlangStore() {
    if (!slangStoreWritable) {
      log('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return;
    }
    try {
      const result = saveSlang(SLANG_FILE, slangEntries);
      if (result?.dropped > 0) {
        slangEntries = result.entries;
        log(`黑话库超过 ${SLANG_MAX_ENTRIES} 条上限，已按「已确认优先」丢弃 ${result.dropped} 条最不活跃的词条`);
      }
    } catch (error) { log('保存黑话库失败:', error?.message ?? error); }
  }

  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return slangTaskChain;
  }

  async function ensureSlangLearnerSession() {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangLearnerSessionId = String(saved.sessionId);
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      await ensureChatModel(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    const workspaceId = await createRunWorkspace(dir, cfg.slang?.workspaceTitle || 'QQ 黑话学习', 'slang');
    const params = { workspaceId, agentPreset: preset };
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    trackDevSession(value.sessionId);
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset });
    log(`黑话学习会话已创建：${slangLearnerSessionId}`);
    return slangLearnerSessionId;
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = slangLearnerSessionId;
    slangLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
  }

  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  async function runSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const extractMax = Math.max(1, Math.min(50, Number(cfg.slang?.extractMax) || 10));
    const promptText = buildExtractionPrompt(messages, {
      max: extractMax,
      extra: cfg.slang?.extractPromptExtra ?? ''
    });
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const parsedItems = parseExtractionJson(output);
      const items = parsedItems.slice(0, extractMax);
      if (parsedItems.length > extractMax) {
        log(`黑话提取：模型给了 ${parsedItems.length} 条，按上限只保留前 ${extractMax} 条`);
      }
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = slangWindows.get(key) ?? [];
        slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }

  /**
   * 为一次研究新建独立会话：**只新开会话，不开新工作区**。
   * 会话仍挂在黑话功能自己的工作区（state/slang-agent）下，和研究/提取共用同一个地方。
   */
  async function createSlangResearchSession(batchId) {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话研究缺少已验证的安全 preset，拒绝创建会话');
    const dir = path.join(STATE_DIR, 'slang-agent');
    const workspaceId = await createRunWorkspace(dir, '', 'slang');
    const value = unwrap(await api.sessions.create({ workspaceId, agentPreset: preset }), 'slang-research session.create');
    trackDevSession(value.sessionId);
    learnerSessions.add(value.sessionId);
    api.events.follow(value.sessionId);
    await ensureChatModel(value.sessionId);
    return value.sessionId;
  }

  async function disposeSlangResearchSession(sessionId) {
    learnerSessions.delete(sessionId);
    try { api.events.forget?.(sessionId); } catch {}
    try { await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); } catch {}
    try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
  }

  /** 单个研究会话：处理一批（最多 20 个）候选。 */
  async function runSlangResearchBatch(candidates, batchId) {
    const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!targets.length) return { written: 0, parsed: 0 };
    for (const e of targets) slangResearchingIds.add(e.id);
    let sessionId = '';
    const researchTimeoutMs = Math.max(60000, Number(cfg.slang?.researchTimeoutMs) || 300000);
    try {
      sessionId = await createSlangResearchSession(batchId);
      const promptText = buildResearchPrompt(targets, { extra: cfg.slang?.researchPromptExtra ?? '' });
      log(`黑话研究[${batchId}]：新会话 ${sessionId}（工作区 state/slang-agent），${targets.length} 个候选（超时 ${Math.round(researchTimeoutMs / 1000)}s）`);
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted?.result?.ok) throw new Error(`研究会话拒绝 prompt：${accepted?.result?.error?.message ?? '未知'}`);
      const output = await waitLearnerTurn(sessionId, researchTimeoutMs);
      const results = parseResearchJson(output);
      let written = 0;
      for (const r of results) {
        const entry = slangEntries.find((e) => e.content === r.content);
        if (!entry) continue;
        if (!r.confirmed) log(`黑话研究[${batchId}]：${r.content} 未确认，写入待人工核对`);
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
        written += 1;
      }
      saveSlangStore();
      log(`黑话研究[${batchId}]：本轮 ${targets.length} 个候选，解析 ${results.length} 条，写入 ${written} 条解释`);
      if (!results.length) log(`黑话研究[${batchId}]：模型没有给出可解析 JSON，回复片段：${String(output ?? '').replace(/\s+/g, ' ').slice(0, 240) || '（空）'}`);
      return { written, parsed: results.length };
    } catch (error) {
      log(`黑话研究[${batchId}]失败：${error?.message ?? error}`);
      return { written: 0, parsed: 0, error: String(error?.message ?? error) };
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
      if (sessionId) void disposeSlangResearchSession(sessionId);
    }
  }

  /**
   * 研究入口：按 20 个一批切分，每批**新开一个会话**并行跑，
   * 不再共用学习会话、也不再排队等上一批（这正是之前「点了没反应」的原因）。
   */
  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const queue = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!queue.length) return;
    const batchSize = Math.max(1, Math.min(50, Number(cfg.slang?.researchSessionBatch) || 20));
    const maxSessions = Math.max(1, Math.min(12, Number(cfg.slang?.researchMaxSessions) || 4));
    const chunks = [];
    for (let i = 0; i < queue.length; i += batchSize) chunks.push(queue.slice(i, i + batchSize));
    const stamp = Date.now().toString(36);
    log(`黑话研究：${queue.length} 个候选 → ${chunks.length} 个新会话（每批 ${batchSize}，并发上限 ${maxSessions}）`);
    let cursor = 0;
    const worker = async () => {
      while (cursor < chunks.length) {
        const index = cursor;
        cursor += 1;
        await runSlangResearchBatch(chunks[index], `${stamp}-${index + 1}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxSessions, chunks.length) }, () => worker()));
  }

  function maybeQueueSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    slangExtractionCooldowns.set(key, Date.now());
    queueSlangTask(() => runSlangExtraction(key));
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  function feedSlangWindow(key, sender, plainContent) {
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: truncateText(text, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI 的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  //
  // 刻意**不含 evidence**：证据行的形状是 `{ key, sender, text, time }`，
  // 其中 text 是提交该词条的那个会话里的消息片段、key 是那个会话的名字。
  // 黑话库是全群共享的，带上 evidence 就等于让 A 群的 AI 读到 B 群的会话名和原话。
  // 控制台要证据走 `GET /api/slang`（原始条目，含 evidence，仅控制台可达）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2() {
    const max = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 8));
    return slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  function withSlangContext(promptText) {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (cfg.slang?.enabled !== false) {
      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  // 知识库检索：拿最近几条消息当查询，命中就拼在提示词最前面。
  // 同一会话、同一查询 5 分钟内复用上次结果 —— 否则每条新消息都要打一次 embedding。
  const knowledgeBlockCache = new Map(); // key -> { at, query, block, version }
  function knowledgeQueryFor(key) {
    const window = Math.max(1, Math.min(20, Number(cfg.knowledge?.queryWindow ?? 4)));
    const pick = (list) => (Array.isArray(list) ? list : [])
      .map((m) => String(m?.text ?? m?.plain ?? '').trim())
      .filter(Boolean)
      .slice(-window);
    // 两套窗口都要看：reserved2 的消息落在会话状态的 recentMessages 数组里，
    // 一代/reserved 走的是 social.recentMessages 这个 Map。只读后者的话，
    // 二代仿真下查询串永远是空的 ⇒ 知识库永远不注入（这条 bug 由 R18 抓到）。
    let recent = [];
    try {
      recent = pick(getSocialV2State(key)?.recentMessages);
    } catch { /* 状态不可读时退回旧窗口 */ }
    if (!recent.length) recent = pick(social.recentMessages.get(key));
    return recent.join('\n').slice(-800);
  }

  // 检索到的记忆是「别人说过、值得记住的事」；整条都是自己发言的命中没有提醒价值。
  function selfSpeechNames() {
    const names = new Set();
    const add = (value) => {
      const name = String(value ?? '').trim();
      if (name) names.add(name);
    };
    add(selfDisplayName);
    add(selfUserId);
    try { add(readRoleState().role); } catch { /* 角色状态不可读时只用自己的昵称/QQ */ }
    return [...names];
  }

  function dropSelfOnlyMemoryHits(hits) {
    const names = selfSpeechNames();
    return (Array.isArray(hits) ? hits : []).filter((hit) => !isSelfOnlyMemoryText(hit?.text, names));
  }

  async function withKnowledgeContext(promptText, key) {
    const base = withSlangContext(promptText);
    if (cfg.knowledge?.enabled === false || !key) return base;
    try {
      if (knowledgeStore.stats().approved === 0) return base;
      const query = knowledgeQueryFor(key);
      if (!query) return base;
      const ttl = Math.max(0, Number(cfg.knowledge?.cacheTtlMs ?? 5 * 60 * 1000));
      // 知识库变更（新批准/新采集）时立刻让缓存失效，否则新知识要等 5 分钟才可能出现。
      const stats = knowledgeStore.stats();
      const version = `${stats.approved}:${stats.total}`;
      const cached = knowledgeBlockCache.get(key);
      let block;
      if (cached && cached.query === query && cached.version === version && Date.now() - cached.at < ttl) {
        block = cached.block;
      } else {
        const hits = await knowledgeStore.search(query, {
          k: Math.max(Number(cfg.knowledge?.topK ?? 5), 8),
          key,
          timeoutMs: Number(cfg.knowledge?.searchTimeoutMs ?? 1500)
        });
        // 重排后再截断：原始群聊片段/超长条目降权，新事实更容易进注入块。
        const topK = Math.max(1, Number(cfg.knowledge?.topK ?? 5));
        const reranked = rankHitsForContext(hits);
        // 上下文里优先放「整理过的事实」；原始群聊片段只在没有别的内容时兜底，
        // 否则注入块永远是那几条 10-26 的聊天原文（用户看到的就是「知识库全是旧的」）。
        const concise = reranked.filter((hit) => !String(hit.text ?? '').startsWith('群聊片段'));
        // 只有自己发言的命中先丢再截断，别让它白占一个 topK 名额。
        const ranked = dropSelfOnlyMemoryHits(concise.length >= Math.min(2, topK) ? concise : reranked).slice(0, topK);
        block = ranked.length
          ? buildKnowledgeBlock(ranked, {
            maxChars: Number(cfg.knowledge?.injectMaxChars ?? 1200),
            currentKey: key
          })
          : '';
        if (ranked.length) knowledgeStore.touch(ranked.map((hit) => hit.id));
        knowledgeBlockCache.set(key, { at: Date.now(), query, block, version });
        if (knowledgeBlockCache.size > 200) knowledgeBlockCache.delete(knowledgeBlockCache.keys().next().value);
      }
      return block ? base + '\n\n' + block : base;
    } catch (error) {
      log(`知识库检索失败（本轮不注入）：${error?.message ?? error}`);
      return base;
    }
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return api.callUnary('session.models', {});
    }
  }
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
const sendSuccessCounts = new Map(); // sessionId -> 累计发送成功次数（跨 turn 保留，用于校验 @ 抢答真的发出去了）
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  /**
   * 回合判忙租约：只要 `turn/start` 的结束信号（turn/end）丢了，会话就会**永久**判忙，
   * 之后所有唤醒只进 pendingWakeReasons、QQ 上表现为「它不理我了」，只能重启（issue #11/#23/#26/#19）。
   * 正常回合 1~3 分钟，最长工具调用（DSH 的 toolCallTimeoutMs）≈12 分钟，15 分钟足以覆盖任何
   * **还活着**的回合。过期只是不再判忙：collector 本身保留，真回复照常 flush，只是允许新唤醒排队。
   */
  const TURN_BUSY_LEASE_MS = 15 * 60 * 1000;
  const turnLeaseNoted = new Set(); // 租约过期的日志去重（每个 session 只记一次）
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序
  // 哪些会话已经收到过完整角色卡：同一会话只在第一条 prompt 里带全文，
  // 之后省掉（会话上下文里已经有了），避免队列里每条都重发一整份人格模板。
  // 落盘：桥接重启后不该再给同一会话重发一遍角色卡（DSH 会话上下文还在）。
  const ROLE_HINT_DONE_FILE = path.join(STATE_DIR, 'rolehint-done.json');
  const roleHintDoneSessions = new Set(
    (() => { try { const arr = JSON.parse(fs.readFileSync(ROLE_HINT_DONE_FILE, 'utf8')); return Array.isArray(arr) ? arr.map(String) : []; } catch { return []; } })()
  );
  function markRoleHintDone(sessionId) {
    if (!sessionId || roleHintDoneSessions.has(sessionId)) return;
    roleHintDoneSessions.add(sessionId);
    try { atomicWriteJson(ROLE_HINT_DONE_FILE, [...roleHintDoneSessions].slice(-500)); } catch {}
  }

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:黑话学习'
        : undefined)
  });

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      const usage = event?.data?.usage;
      if (usage) {
        const used = Number(usage.cacheMiss || 0) + Number(usage.cacheHit || 0) + Number(usage.cacheWrite || 0);
        if (used > 0) personaContextTokens.set(sessionId, used);
      }
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    collectors.set(sessionId, collector);
    // 恢复出来的回合也必须带起始时间，否则租约对它无从生效 —— 这正是
    // 「DSH 重启后忙标记永不复位」的那条路径（issue #19）。不知道真实起点时按现在算：
    // 活着的回合会在 turn/end 清掉；真丢了的回合最多再忙一个租约期就自动解除。
    if (!v2TurnStartAt.has(sessionId)) v2TurnStartAt.set(sessionId, Date.now());
    log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
  }

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  let currentMode = 'reserved2'; // closed-agent | reserved2（由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 读到已删除模式的残留值时提醒一次；不抛错、不改值，只让日志里能查出来。
  const removedModeWarned = new Set();
  function warnRemovedMode(value) {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!Object.prototype.hasOwnProperty.call(REMOVED_MODES, key)) return;
    if (removedModeWarned.has(key)) return;
    removedModeWarned.add(key);
    log(`⚠️ 模式 "${key}" ${REMOVED_MODES[key]}；已忽略该值，继续使用 ${currentMode}`);
  }

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      const defaultPreset = settingFromDshNamespace(presetNs, 'default');
      if (typeof defaultPreset === 'string' && defaultPreset) {
        dshDefaultPreset = defaultPreset;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      // 读取必须 user 层优先：DSH 0.2.0-rc.2 写完 settings 后同进程内 value 不更新，
      // 只读 value 会让控制台切的模式被 5 秒轮询改回去（issue #22）。
      const rawDshMode = settingFromDshNamespace(ns, 'mode');
      warnRemovedMode(rawDshMode);
      const fromDsh = normalizeModeInput(rawDshMode);
      if (fromDsh) {
        currentMode = fromDsh;
        // DSH 设置页也可配置管理员 QQ；**留空表示不覆盖 config.json**
        // （见 plugins/qq-mode-console 的 schema 描述）。这里必须显式判断空串：
        // normalizeOwnerQQ('') 返回 null，若照旧 `!== undefined` 就直接赋值，
        // 设置页每次轮询都会把 config.json 里的 ownerQQ 抹成 null —— 而 5 秒一次的
        // refreshMode 会让它「几秒后必然发生」，后果是 closed-agent 谁都不放行、
        // 审批/提问永远等不到管理员回答。
        const rawOwnerValue = settingFromDshNamespace(ns, 'ownerQQ');
        if (rawOwnerValue !== undefined) {
          const rawOwner = String(rawOwnerValue ?? '').trim();
          if (rawOwner) {
            try {
              cfg.ownerQQ = normalizeOwnerQQ(rawOwner);
            } catch (error) {
              log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
            }
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    if (local) warnRemovedMode(local.mode);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) currentMode = fromLocal;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // reserved2（智能模式）：白名单内的群聊/私聊
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（reserved2，会话属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(closedAgentPreset);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 智能模式（reserved2）优先使用 socialV2.agentPreset；未配置时回退到默认 QQ 预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = cfg.socialV2?.agentPreset || cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  function sessionPolicy(key) {
    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  function forgetConversationCaches(key) {
    lastSendFailed.delete(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    slangSubmitTimes.delete(key);
    feedbackTimes.delete(key);
    wakeConfigMissCount.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
  }

  function retireSession(key) {
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    if (!sessionId) return;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    sessionModels.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    turnLeaseNoted.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    social.exitingSessions.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    api.events.forget?.(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      rememberAgentToken(key, st.agentToken);
      st.bootstrapSent = false;
      st.modelSeenSeqs = new Set();
    }
    saveState();
    saveSocialV2State();
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  /**
   * 人格运行时接管后，「每群一个主会话」这条旧链路必须整体退场。
   *
   * 现场症状：agents 工作区里 session-b99fd… 和人格分支 session-4f3ef… 同时在跑，同一个群两套会话
   * 各回一遍；旧会话的文本走自动转发，还会把收尾标记（DONE）发进群。根因是唤醒/回复检查/主动机会
   * 这些旧调度只认 reserved2，不认人格运行时，于是人格分支在跑的同时旧主会话仍被叫醒。
   *
   * 只在 reserved2 + 人格运行时生效：closed-agent 仍然使用旧主会话，不能动。
   */
  function legacyReserved2PathDisabled() {
    try {
      return currentMode === 'reserved2' && personaRuntimeEnabled();
    } catch {
      // 初始化早期（人格配置/运行时配置还没加载到）：没有证据就别停旧链路。
      return false;
    }
  }

  /** 把旧链路主会话一次性退场（停 DSH 在途任务 + 归档 + 清定时器），幂等，可重复调用。 */
  function retireLegacySessionsForPersonaRuntime(reason = '人格运行时接管') {
    if (!legacyReserved2PathDisabled()) return 0;
    const keys = Object.keys(state.sessions ?? {});
    if (!keys.length) return 0;
    for (const key of keys) {
      const st = socialV2.conversations.get(key);
      if (st) {
        st.pendingWakeReasons = [];
        st.mustAnswerRetry = null;
      }
      retireSession(key);
    }
    const message = `${reason}：旧链路主会话已退场 ${keys.length} 个（${keys.join('、')}）`;
    log(message);
    appendActivity(message);
    return keys.length;
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (dshPresetIds.length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            if (legacyReserved2PathDisabled()) {
              log(`补投跳过 ${key}：人格运行时接管，旧主会话链路已停用（丢弃 ${items.length - i} 条历史补投）`);
              break;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        if (currentMode === 'reserved2') {
          // 人格运行时接管时，旧链路主会话先退场，免得重启后又两套会话同时跑。
          retireLegacySessionsForPersonaRuntime('DSH 就绪后人格运行时接管');
          if (devModeEnabled()) {
            // 上次退出时开发者模式是开着的：重启后同样要把旧工作区的运行时会话退役，
            // 否则恢复的映射会把调度派回正式工作区。
            void resetRuntimeSessionsForDevMode('启动恢复开发者模式').catch(() => {});
          }
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
          // 插件完全启动后再叫醒一次 agent（静默 turn：桥接不回发任何 QQ 消息），
          // 让它把会话/工具/人设先加载起来，不用等第一条群消息。
          setTimeout(() => { runStartupSilentWake().catch(() => {}); }, 10000).unref?.();
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  // 网关守护要在 snowlumaHealth 之后起（它是 main 内的局部对象，早于声明会踩 TDZ）
  startSnowlumaSupervisor(cfg, () => snowlumaHealth.connected);

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function v2ToolEnabled(flag) {
    return cfg.socialV2?.tools?.[flag] !== false;
  }

  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    //
    // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
    // 可用响应时延逐字节试探。与控制台令牌（见下方 timingSafeEqual）保持一致。
    const tokenEq = (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
      const x = Buffer.from(a, 'utf8');
      const y = Buffer.from(b, 'utf8');
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && tokenEq(token, st.agentToken);
    };
    /**
     * 令牌是否匹配**任意**一个活跃二代会话。
     *
     * 用途是集中式纵深防御（见下方 x-agent-call 关卡）：各端点自己那套
     * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
     * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
     * 端点漏写时会整个失效。
     */
    const isLiveAgentToken = (token) => {
      if (typeof token !== 'string' || !token) return false;
      for (const st of socialV2.conversations.values()) {
        if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
      }
      return false;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      const readBody = () => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      const hostHeader = String(req.headers.host ?? '');
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
      // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
      const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
      // 浏览器「记住这台设备」：带 ?token= 通过后落一个长寿命 HttpOnly cookie，
      // 以后直接开 http://127.0.0.1:3100/ 就不再问口令。
      const cookieToken = (() => {
        const raw = String(req.headers.cookie ?? '');
        const m = raw.match(/(?:^|;\s*)qq_console_token=([^;]*)/);
        if (!m) return '';
        try { return decodeURIComponent(m[1]); } catch { return ''; }
      })();
      const tokenEquals = (candidate) => {
        if (!consoleToken || !candidate) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
        const a = Buffer.from(String(candidate), 'utf8');
        const b = Buffer.from(consoleToken, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
      };
      const tokenMatches = tokenEquals(suppliedToken) || tokenEquals(cookieToken);
      // 本机免令牌：只监听回环 + 同源 + 不是智能体调用，三者同时成立才放行。
      // 恶意网页发起的跨站请求会带 Origin（对不上）或走 POST（还要过下面的 CSRF 关），
      // MCP 智能体调用则一律照旧校验令牌，避免「免令牌」把管理端权限借给会话。
      const isAgentCall = req.headers['x-agent-call'] !== undefined || req.headers['x-agent-token'] !== undefined;
      const remoteAddr = String(req.socket?.remoteAddress ?? '');
      const isLoopback = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      const originHeader = String(req.headers.origin ?? '');
      const originSame = !originHeader || (() => {
        try { return new URL(originHeader).host.toLowerCase() === hostHeader.toLowerCase(); } catch { return false; }
      })();
      const localTrusted = cfg.consoleAuthLocal !== false && isLoopback && originSame && !isAgentCall;
      if (consoleToken && !tokenMatches && !localTrusted) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      if (tokenMatches && url.searchParams.get('token')) {
        res.setHeader('set-cookie', `qq_console_token=${encodeURIComponent(consoleToken)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`);
      }
      // 智能体调用隔离（集中关卡）。
      //
      // 背景：控制台令牌是「管理端全权」，会话令牌是「只能动自己这个会话」。MCP 工具进程
      // 两者都持有，所以「这次请求到底是智能体发的还是管理端发的」必须由请求自己声明。
      // 各端点用 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但那个写法在
      // **头缺失时整条跳过** —— 而头缺失恰恰是模型没传 token 时的自然结果
      // （旧版 mcp-snowluma-safe.js 用 `...(token ? {...} : {})` 直接省略了这个头）。
      // 于是「漏传令牌」不是被拒绝，而是**升级成控制台全权**：典型的 confused deputy。
      //
      // 现在 MCP 端一律带上 x-agent-call: 1；带了令牌就必须命中某个活跃会话，
      // 端点自己漏写校验也不会退回管理端。
      //
      // 但「没带令牌」的智能体调用不能一律拒绝：closed-agent（管理员私聊）模式下模型
      // 本来就**没有**会话令牌（令牌只在 reserved2 的唤醒提示里下发），而 qq_send_group_message
      // / qq_list_groups 等工具必须在这个模式里可用（工具描述写的也是"closed-agent 模式不需要"）。
      // 这些端点各自按模式判定（/api/send/* 只在 closed-agent 放行；/api/images/* 在 reserved2
      // 强制要令牌；/api/status 对智能体调用只回最小对象），所以这里把「无令牌智能体调用」
      // 限制到这条非 v2 会话面；整个 /api/socialV2/ 前缀一概不放——那里的 token 校验全是
      // `if (x-agent-token && …)`，放进来就等于退化成管理端全权（confused deputy）。
      if (req.headers['x-agent-call'] !== undefined) {
        const agentToken = req.headers['x-agent-token'];
        const hasToken = typeof agentToken === 'string' && agentToken !== '';
        if (hasToken && !isLiveAgentToken(agentToken)) {
          sendJson({ ok: false, error: '未授权：智能体调用携带的会话令牌无效' }, 403);
          return;
        }
        if (!hasToken) {
          // /api/send/voice 是**操作者**通道（CLI / 控制台）：它的鉴权只看控制台令牌，
          // 放无令牌的智能体进来就等于「AI 标记的请求 → 操作者权限」。
          // AI 发语音走 /api/socialV2/send-voice（要 key + 会话令牌），不受这条影响。
          const tokenlessAgentAllowed = url.pathname === '/api/status'
            || (url.pathname.startsWith('/api/send/') && url.pathname !== '/api/send/voice')
            || url.pathname.startsWith('/api/images/')
            // 审批代理工具：鉴权用的是**请求体里的审批令牌**（不是会话令牌），
            // 端点内部会自己校验 approverTokenOk；这里放行，否则工具永远 403。
            || url.pathname.startsWith('/api/knowledge/approver/');
          if (!tokenlessAgentAllowed) {
            sendJson({ ok: false, error: '未授权：该接口的智能体调用必须携带有效的会话令牌' }, 403);
            return;
          }
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
          sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        // /api/socialV2/initial-prompt 也在这里：它是操作者写给 AI 的"环境背景"，
        // 让 AI 自己读/改等于把控制台的管理输入（以及未来可能写入的其它群信息）交给会话主体。
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake', '/api/socialV2/initial-prompt'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
        // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
        // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
        if (req.headers['x-agent-token']) {
          const agentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/socialV2/')
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/')
            || url.pathname === '/api/authorize/read';
          if (!agentAllowed) {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
        }
        // 只读降级：黑话库/表情库在启动时加载失败时，写接口必须**明确失败**。
        // 旧行为是 save 函数里只打一行日志就 return，而接口照样回 {ok:true}：
        // 控制台显示"✅ 已保存"，实际只改在内存里，重启后全部消失。
        if (req.method !== 'GET') {
          const readonlyStore = (!slangStoreWritable && (url.pathname === '/api/slang'
            || url.pathname === '/api/slang/clear'
            || url.pathname === '/api/slang/extract'
            || url.pathname === '/api/slang/research'
            || url.pathname.startsWith('/api/slang/batch-')
            || url.pathname === '/api/socialV2/slang/submit')) ? '黑话库'
            : (!stickerStoreWritable && (url.pathname === '/api/stickers/sync'
              || url.pathname === '/api/stickers/note'
              || url.pathname === '/api/stickers/remark'
              || url.pathname === '/api/socialV2/sticker-note'
              || url.pathname === '/api/socialV2/sticker-remark'
              || url.pathname === '/api/socialV2/collect-sticker')) ? '表情库'
              : '';
          if (readonlyStore) {
            sendJson({ ok: false, error: `${readonlyStore}处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接` }, 503);
            return;
          }
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            let html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
      try {
        // 页面首屏就显示当前人格，不依赖 JS 初始化是否成功
        const rs = readRoleState();
        const roleName = String(rs?.role || '无').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        const modeName = (devModeEnabled() ? '开发者模式' : '正常').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
        html = html.replace('<span id="roleText">-</span>', `<span id="roleText">${roleName}</span>`);
        html = html.replace('<span id="roleModeText">-</span>', `<span id="roleModeText">${modeName}</span>`);
      } catch {}
      res.end(html);
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        // 旧链接兜底：工具面板已经内嵌进控制台的「外部工具」视图，这里只做跳转。
        if (req.method === 'GET' && url.pathname === '/tools') {
          // 不把 ?token= 再写进 Location：那会留在浏览器历史/地址栏里。
          // 带 token 的那次请求已经在上面种好 HttpOnly cookie，跳过去照样有权限。
          res.writeHead(302, { location: '/#tools', ...SECURITY_HEADERS });
          res.end();
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/agent-token') {
          // 只给 MCP 进程用的内部接口：MCP 用控制台令牌证明自己是系统组件，
          // 桥接按 key / 审批任务返回当前令牌，工具调用方（模型）永远看不到它。
          // 不接受免令牌的本机浏览器：令牌是凭据，不能由任意页面读取。
          if (!tokenMatches) { sendJson({ ok: false, error: '未授权' }, 401); return; }
          if (url.searchParams.get('kind') === 'approver') {
            const token = findApproverToken({
              id: url.searchParams.get('id'),
              batchId: url.searchParams.get('batch')
            });
            if (!token) { sendJson({ ok: false, error: '没有匹配的审批任务' }, 404); return; }
            sendJson({ ok: true, kind: 'approver', token });
            return;
          }
          const key = canonicalV2Key(url.searchParams.get('key'));
          const st = key ? socialV2.conversations.get(key) : null;
          if (!st?.agentToken) { sendJson({ ok: false, error: '该会话没有可用的 agent token' }, 404); return; }
          sendJson({ ok: true, key, token: st.agentToken });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
          // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
          // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
          // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
          // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
          // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
          // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
          if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
            sendJson({
              mode: currentMode,
              role: rs.role ?? null,
              roleMode: rs.mode ?? 'active',
              devMode: { enabled: devModeEnabled(), policy: readDevMode().policy, policyLabel: devPolicyLabel() },
              dshReady,
              socialV2Paused: socialV2.paused,
            });
            return;
          }
          sendJson({
            mode: currentMode,
            closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            devMode: {
              enabled: devModeEnabled(),
              policy: readDevMode().policy,
              policyLabel: devPolicyLabel(),
              testWorkspaceId: readDevMode().testWorkspaceId,
              testWorkspacePath: readDevMode().testWorkspacePath || DEV_TEST_WORKSPACE_DIR,
              testSessionCount: readDevMode().testSessionIds.length
            },
            dshReady,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            socialV2Paused: socialV2.paused,
            // 模型与识图：主模型组 / 回退组 / 当前生效 / 是否原生识图
            model: modelStatusSnapshot(),
            // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
            // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
            snowluma: snowlumaHealthSnapshot()
          });
          return;
        }
        // ── 控制台令牌（查看 / 修改）──────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/console/auth') {
          sendJson({
            autoAuthLocal: cfg.consoleAuthLocal !== false,
            tokenHint: consoleToken ? `${String(consoleToken).slice(0, 6)}…${String(consoleToken).slice(-4)}` : '',
            tokenLength: String(consoleToken).length,
            fromConfig: !!String(cfg.consoleToken ?? '').trim()
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody().catch(() => ({}));
          const next = String(body.token ?? '').trim();
          if (next.length < 16 || next.length > 128 || !/^[A-Za-z0-9_-]+$/.test(next)) {
            sendJson({ ok: false, error: '令牌要求 16~128 位，只能包含字母、数字、下划线、短横线' }, 400);
            return;
          }
          consoleToken = next;
          try {
            fs.writeFileSync(path.join(STATE_DIR, 'console-token'), next, { encoding: 'utf8', mode: 0o600 });
          } catch (error) {
            sendJson({ ok: false, error: `令牌已生效但写盘失败：${error?.message ?? error}` }, 500);
            return;
          }
          res.setHeader('set-cookie', `qq_console_token=${encodeURIComponent(next)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`);
          log(`[console] 控制台令牌已更新（${next.slice(0, 6)}…）`);
          sendJson({ ok: true, tokenHint: `${next.slice(0, 6)}…${next.slice(-4)}` });
          return;
        }

        // 测试用：把两种发送路径各走一遍（默认关闭，需 socialV2.sticker.testSend=true）
        if (req.method === 'POST' && url.pathname === '/api/tools/sticker-send') {
          if (cfg.socialV2?.sticker?.testSend !== true) {
            sendJson({ ok: false, error: '未开启测试发送（config.json: socialV2.sticker.testSend=true）' }, 403);
            return;
          }
          const body = await readBody().catch(() => ({}));
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          const m = /^(group|private):(\d+)$/.exec(key);
          if (!m) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = m[1];
          const id = Number(m[2]);
          if (!modeAllowed(key, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          const asImage = body.asImage === true;
          try {
            const sent = await sendStickerV2(key, stickerId, { atUserId: body.atUserId ?? null, forceImage: asImage });
            sendJson({ ok: true, messageId: sent.messageId ?? null, path: asImage ? 'image' : 'custom_face', desc: sent.entry?.desc ?? null });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 工具进程 API（梗图管理器 / SnowLuma / 日志）────────────────────
        if (req.method === 'GET' && url.pathname === '/api/tools/status') {
          const memeDir = memeDirOf(cfg);
          const memeScript = path.join(memeDir, String(cfg.tools?.memeManager?.script ?? 'meme_renamer.py'));
          // 桥接重启会丢掉子进程引用，所以再回落到 state/tools.json 里记的 pid
          const memePid = toolChildren.meme?.pid ?? readToolStateFile().memePid ?? null;
          const memeRunning = isPidAlive(memePid);
          if (!memeRunning && memePid) writeToolStateFile({ memePid: null });
          const sDir = snowlumaDir(cfg);
          const sEntry = path.join(sDir, String(cfg.tools?.snowluma?.script ?? 'index.mjs'));
          sendJson({
            bridge: { pid: process.pid, cwd: ROOT, node: process.execPath },
            meme: {
              enabled: cfg.tools?.memeManager?.enabled !== false,
              dir: memeDir,
              script: memeScript,
              exists: fs.existsSync(memeScript),
              python: pickPython(memeDir),
              running: memeRunning,
              pid: memeRunning ? memePid : null
            },
            qq: (() => {
              const snap = qqProcessSnapshot();
              const watchPid = toolChildren.qqWatch?.pid ?? readToolStateFile().qqWatchPid ?? null;
              const watchRunning = isPidAlive(watchPid);
              if (!watchRunning && watchPid) writeToolStateFile({ qqWatchPid: null });
              const detected = resolveQqInstall();
              return {
                running: snap.count > 0,
                count: snap.count,
                checkedAt: snap.at,
                path: String(cfg.tools?.qq?.path ?? '').trim() || detected.path,
                pathSource: String(cfg.tools?.qq?.source ?? '').trim() || detected.source,
                version: String(cfg.tools?.qq?.version ?? '').trim() || detected.version,
                script: qqWatchScript(),
                scriptExists: fs.existsSync(qqWatchScript()),
                watch: { running: watchRunning, pid: watchRunning ? watchPid : null }
              };
            })(),
            snowluma: {
              enabled: cfg.tools?.snowluma?.enabled !== false,
              dir: sDir,
              entry: sEntry,
              exists: fs.existsSync(sEntry),
              // 可能是别处（手动/系统服务）起的，所以再探一下 OneBot HTTP 端口
              running: isPidAlive(toolChildren.snowluma?.pid) || (await probeHttpAlive(cfg.snowluma?.httpUrl)),
              pid: toolChildren.snowluma?.pid ?? null,
              httpUrl: cfg.snowluma?.httpUrl ?? null
            },
            logs: ['bridge', 'launcher', 'snowluma']
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/tools/meme/launch') {
          if (cfg.tools?.memeManager?.enabled === false) {
            sendJson({ ok: false, error: '梗图管理器在 config.json 里被禁用' }, 403);
            return;
          }
          const memeDir = memeDirOf(cfg);
          const scriptPath = path.join(memeDir, String(cfg.tools?.memeManager?.script ?? 'meme_renamer.py'));
          if (!fs.existsSync(scriptPath)) {
            sendJson({ ok: false, error: `找不到梗图管理器脚本：${scriptPath}` }, 404);
            return;
          }
          const knownMemePid = toolChildren.meme?.pid ?? readToolStateFile().memePid ?? null;
          if (isPidAlive(knownMemePid)) {
            sendJson({ ok: true, pid: knownMemePid, already: true });
            return;
          }
          const python = pickPython(memeDir);
          try {
            const child = spawn(python, [scriptPath], { cwd: memeDir, stdio: 'ignore', detached: true, windowsHide: false });
            child.on('error', (error) => log(`[tools] 梗图管理器启动失败：${error?.message ?? error}`));
            child.unref();
            toolChildren.meme = child;
            writeToolStateFile({ memePid: child.pid });
            log(`[tools] 已启动梗图管理器 pid=${child.pid}（${python}）`);
            sendJson({ ok: true, pid: child.pid, python });
          } catch (error) {
            sendJson({ ok: false, error: `启动失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/tools/qq/detect') {
          try {
            const info = autofillQqPath({ ...cfg, tools: { ...(cfg.tools ?? {}), qq: {} } });
            sendJson({ ok: Boolean(info.path), ...info });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // QQ 掉线提醒：只负责「启/停用户自己装的守护脚本」，不碰 QQ 本身
        if (req.method === 'POST' && url.pathname === '/api/tools/qq-watch/start') {
          const script = qqWatchScript();
          if (!fs.existsSync(script)) {
            sendJson({ ok: false, error: `找不到提醒脚本：${script}` }, 404);
            return;
          }
          const existing = toolChildren.qqWatch?.pid ?? readToolStateFile().qqWatchPid ?? null;
          if (isPidAlive(existing)) {
            sendJson({ ok: true, pid: existing, already: true });
            return;
          }
          const python = pickPython('');
          const logFile = path.join(STATE_DIR, 'qq-watch.log');
          // stdout/stderr 已经重定向到 qq-watch.log，别再传 --log（会写两遍）
          const args = [script, '--interval', String(Number(cfg.tools?.qqWatch?.interval) || 30)];
          const startQq = String(cfg.tools?.qqWatch?.startQq ?? '').trim()
            || String(cfg.tools?.qq?.path ?? '').trim()
            || resolveQqInstall().path;
          if (startQq) args.push('--start-qq', startQq);
          try {
            const out = fs.openSync(logFile, 'a');
            const child = spawn(python, args, {
              cwd: ROOT,
              stdio: ['ignore', out, out],
              detached: true,
              windowsHide: true
            });
            child.on('error', (error) => log(`[tools] QQ 掉线提醒启动失败：${error?.message ?? error}`));
            child.unref();
            toolChildren.qqWatch = child;
            writeToolStateFile({ qqWatchPid: child.pid });
            log(`[tools] 已启动 QQ 掉线提醒 pid=${child.pid}（日志 state/qq-watch.log）`);
            sendJson({ ok: true, pid: child.pid, python, script });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/tools/qq-watch/stop') {
          const pid = toolChildren.qqWatch?.pid ?? readToolStateFile().qqWatchPid ?? null;
          if (!isPidAlive(pid)) {
            writeToolStateFile({ qqWatchPid: null });
            sendJson({ ok: true, already: true });
            return;
          }
          try {
            if (process.platform === 'win32') {
              execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            } else {
              process.kill(pid, 'SIGTERM');
            }
            log(`[tools] 已停止 QQ 掉线提醒 pid=${pid}`);
          } catch {}
          toolChildren.qqWatch = null;
          writeToolStateFile({ qqWatchPid: null });
          sendJson({ ok: true });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/tools/snowluma/install') {
          if (cfg.tools?.snowluma?.enabled === false) {
            sendJson({ ok: false, error: 'SnowLuma 在 config.json 里被禁用' }, 403);
            return;
          }
          const body = await readBody().catch(() => ({}));
          try {
            const result = await ensureSnowlumaInstalled(cfg);
            if (body.force === true && result.ok) {
              // 强制重装：把目录挪走再装一次，避免半装状态卡住
              fs.rmSync(path.resolve(ROOT, '..', 'snowluma'), { recursive: true, force: true });
              const again = await ensureSnowlumaInstalled(cfg);
              sendJson({ ...again, forced: true }, again.ok ? 200 : 500);
              return;
            }
            sendJson({ ...result }, result.ok ? 200 : 500);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/tools/snowluma/start') {
          if (cfg.tools?.snowluma?.enabled === false) {
            sendJson({ ok: false, error: 'SnowLuma 在 config.json 里被禁用' }, 403);
            return;
          }
          const ready = await ensureSnowlumaInstalled(cfg);
          if (!ready.ok) {
            sendJson({ ok: false, error: ready.error }, 404);
            return;
          }
          // 复用 ensureSnowlumaRunning：它自带「已经在跑就别再拉」的判据和单飞锁，
          // 这里再写一份 spawn 就等于绕过这些保护，双击两次按钮能起两个实例。
          try {
            const status = await ensureSnowlumaRunning(cfg);

            sendJson({
              ok: status === 'started' || status === 'already',
              status,
              pid: toolChildren.snowluma?.pid ?? null,
              log: path.join(STATE_DIR, 'snowluma.log')
            });
          } catch (error) {
            sendJson({ ok: false, error: `启动失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/tools/log') {
          const name = String(url.searchParams.get('name') || 'bridge');
          const lines = Math.min(2000, Math.max(10, Number(url.searchParams.get('lines')) || 300));
          const files = {
            bridge: path.join(STATE_DIR, 'bridge.log'),
            launcher: path.join(STATE_DIR, 'launcher.log'),
            snowluma: path.join(STATE_DIR, 'snowluma.log'),
            qqwatch: path.join(STATE_DIR, 'qq-watch.log'),
            activity: ACTIVITY_LOG
          };
          // 日志页有两个窗口：qqmsg 只给 QQ 消息收发，activity/system 给各功能链路的调试输出。
          const text = name === 'qqmsg' ? readQqMessageTail(lines) : tailFileLines(files[name] || files.bridge, lines);
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
          res.end(text);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
          const requestedMode = normalizeModeInput(body.mode);
          if (!requestedMode) {
            sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名；聊天模式与一代仿真已删除）` }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: requestedMode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          // 写穿的是**内部拼写**（`simulation` 会写成 `reserved2`）：DSH 里那份值会被 refreshMode
          // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'reserved2'` 判断失效。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
          }
          // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
          // 把 `simulation` 与 `reserved2` 当成两种模式，会在模式其实没变时清掉二代定时器与排队投递。
          if (currentMode === 'reserved2' && requestedMode !== 'reserved2') {
            clearAllSocialV2Timers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
          }
          currentMode = requestedMode;
          lastMode = requestedMode;
          reconcileSessionPolicies();
          if (requestedMode === 'reserved2') {
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
              sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            log(`控制台：角色已设置为 ${name}`);
            sendJson({ ok: true, role: name });
          } else {
            writeRoleState(null, rs.mode);
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null });
          }
          return;
        }
        // ── 开发者模式（原「静默模式」，界面在「调试与运维」页）─────────────
        if (req.method === 'GET' && url.pathname === '/api/dev-mode') {
          const d = readDevMode();
          sendJson({
            ok: true,
            devMode: { ...d, policyLabel: devPolicyLabel(d.policy) },
            testWorkspace: { id: d.testWorkspaceId, dir: d.testWorkspacePath || DEV_TEST_WORKSPACE_DIR },
            testSessionCount: d.testSessionIds.length
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dev-mode') {
          const body = await readBody();
          const d = readDevMode();
          const enabled = body.enabled === undefined ? d.enabled : body.enabled === true;
          const policy = body.policy === 'off' ? 'off' : body.policy === 'guard' ? 'guard' : d.policy;
          const wasEnabled = d.enabled;
          const next = writeDevMode({ enabled, policy });
          if (next.enabled) {
            // 测试工作区在启用时先备好：UI 能立刻显示路径，第一条消息也不用等建工作区。
            await ensureDevTestWorkspace().catch((error) => log(`开发者模式：测试工作区准备失败：${error?.message ?? error}`));
            if (!wasEnabled) {
              // 关键：开启前那些会话都建在正式工作区里。不退役，调度会一直派进旧会话，
              // 测试工作区永远 0 个会话（现场症状）。
              await resetRuntimeSessionsForDevMode('开启开发者模式').catch((error) => log(`开发者模式：退役旧运行时会话失败：${error?.message ?? error}`));
            }
          }
          if (next.enabled && next.policy === 'off') {
            // 完全静默：停掉所有已排队的调度，连旧的补投也清掉，避免开关一按还有残留回合。
            clearAllSocialV2Timers();
            drainAllPromptQueues('开发者模式：完全静默，取消排队投递');
          }
          if (!next.enabled) {
            // 关闭开发者模式：测试工作区里建的会话/人格分支都要退场，否则下次调度又把
            // 任务派回测试工作区（关闭后必须回到正式工作区）。
            const testWsId = next.testWorkspaceId || '';
            let personaChanged = false;
            for (const [role, rec] of personaAgents) {
              const keep = {};
              for (const [k, sid] of Object.entries(rec.branches || {})) {
                if (devTestSessionTracked(sid)) { void retireDevStaleSession(sid); personaChanged = true; continue; }
                keep[k] = sid;
              }
              if (rec.branches && rec.branches !== keep) rec.branches = keep;
              if (!rec.workspaceId || rec.workspaceId === testWsId) {
                if (rec.workspaceId || rec.workspacePath) { rec.workspaceId = ''; rec.workspacePath = ''; personaChanged = true; }
              }
              personaAgents.set(role, rec);
            }
            if (personaChanged) savePersonaAgents();
            for (const key of Object.keys(state.sessions ?? {})) {
              if (devTestSessionTracked(state.sessions[key])) retireSession(key);
            }
            // 关闭开发者模式：把调度重新挂起来（原本排着的定时器已被清空）。
            startupSilentWakeDone = false;
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
            }
            setTimeout(() => { runStartupSilentWake().catch(() => {}); }, 10000).unref?.();
          }
          log(`控制台：开发者模式 ${next.enabled ? '开启' : '关闭'}（${devPolicyLabel(next.policy)}）`);
          sendJson({ ok: true, devMode: next });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dev-mode/delete-workspace') {
          const result = await deleteDevTestWorkspace();
          sendJson(result, result.ok ? 200 : 404);
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          const summaries = roleSummaries();
          sendJson({
            // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
            // 富信息放在 summaries 里，新老调用方互不影响。
            roles: summaries.map((role) => role.name),
            summaries,
            current: rs.role ?? null,
            limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: roleInjectMaxChars },
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/roles/content') {
          let name;
          try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          const content = readRoleContent(name);
          sendJson({
            ok: true,
            name,
            content,
            chars: content.length,
            bytes: Buffer.byteLength(content, 'utf8'),
            warnings: roleWarnings(content),
            limits: { injectMaxChars: roleInjectMaxChars },
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/limit') {
          const body = await readBody();
          const next = applyRoleInjectLimit(body.maxInjectChars);
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.role = { ...(file.role ?? {}), maxInjectChars: next };
          atomicWriteJson(configFile, file);
          cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
          roleInjectMaxChars = next;
          log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
          sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
          writeRoleContent(name, content);
          log(`控制台：创建人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/update') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          writeRoleContent(name, content);
          log(`控制台：更新人格「${name}」（${content.length} 字符）`);
          sendJson({ ok: true, role: name, chars: content.length, warnings: roleWarnings(content) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
          const body = await readBody();
          let from; let to;
          try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
          if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
          if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
          fs.renameSync(roleFilePath(from), roleFilePath(to));
          const rs = readRoleState();
          const switched = rs.role === from;
          if (switched) writeRoleState(to, rs.mode);
          log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
          sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
          const body = await readBody();
          let name;
          try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          fs.rmSync(roleFilePath(name));
          const rs = readRoleState();
          const cleared = rs.role === name;
          if (cleared) writeRoleState(null, rs.mode);
          log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
          sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
          return;
        }

        // ── 通用系统预设（预设内置的安全/硬约束/工具协议）────────────────────
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const { prefix } = readPresetPromptText(preset);
            sendJson({
              ok: true,
              content: prefix,
              chars: prefix.length,
              bytes: Buffer.byteLength(prefix, 'utf8'),
              warnings: presetPromptWarnings(prefix),
              status: presetStatus(preset),
              presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt') {
          const body = await readBody();
          const preset = knownPresetName(body.preset);
          if (preset !== PRESET_NAMES.v2) { sendJson({ ok: false, error: '一代预设已移除，只保留 qq-chat-v2' }, 400); return; }
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          let nextText;
          try {
            const { text, prefix } = readPresetPromptText(preset);
            // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
            // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
            const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
            if (normalized === prefix) {
              sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix), synced: fs.existsSync(installedPresetYaml(preset)), requiresRestart: false, status: presetStatus(preset) });
              return;
            }
            nextText = renderPresetPromptYaml(text, body.content, 'v2');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
            return;
          }
          const warnings = presetPromptWarnings(body.content);
          let sourceBackup = null;
          try {
            sourceBackup = backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), nextText);
            // 同步到 DSH 实际读取的安装目录。
            // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
            // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) {
              fs.copyFileSync(presetSourceYaml(preset), installed);
            }
          } catch (error) {
            // 尽力回滚源文件，避免留下半截状态
            if (sourceBackup && fs.existsSync(sourceBackup)) {
              try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
            }
            sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          log(`控制台：${preset} 通用系统预设已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
          sendJson({
            ok: true,
            chars: String(body.content ?? '').length,
            warnings,
            synced: fs.existsSync(installedPresetYaml(preset)),
            requiresRestart: true,
            status: presetStatus(preset),
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt/backups') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            sendJson({ ok: true, backups: listPresetBackups(preset) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt/restore') {
          const body = await readBody();
          const preset = knownPresetName(body.preset);
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const requested = String(body.file ?? '').trim();
            const candidates = listPresetBackups(preset).map((b) => b.file);
            const target = requested || candidates[0];
            // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
            if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
            const backupPath = path.join(PRESET_BACKUP_DIR, target);
            const restored = fs.readFileSync(backupPath, 'utf8');
            const restoredPrefix = extractPresetPrefix(restored);
            if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
            // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
            // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
            // 不变量清单**按预设取**：一代本来就没有「你没有本地工具」这类工具面表述。
            const blockers = presetPromptBlockers(restoredPrefix, 'v2');
            if (blockers.length) {
              sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
              return;
            }
            backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), restored);
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
            log(`控制台：${preset} 通用系统预设已还原自备份 ${target}；需重启 DSH 生效`);
            sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
          }
          return;
        }

        // ── 黑话库管理 ──────────────────────────────────────────────────────
        // ── 定时安全关闭 / 定时关机 ─────────────────────────────────────
        if (url.pathname === '/api/power') {
          if (req.method === 'GET') {
            const conf = resolvePowerConfig(cfg.power);
            let nowMs = Date.now();
            try { nowMs = (await greetingClock.current()).nowMs; } catch {}
            const plan = computePowerPlan(conf, nowMs);
            sendJson({
              ok: true,
              config: conf,
              now: nowMs,
              plan: {
                safeCloseAt: plan.safeCloseAtMs,
                shutdownAt: plan.shutdownAtMs,
                shutdownDelaySec: plan.shutdownDelaySec
              },
              state: { ...powerState, closing: powerClosing }
            });
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody();
            const action = String(body.action ?? 'config');
            if (action === 'unlock') {
              try { fs.unlinkSync(POWER_OFF_LOCK_FILE); } catch {}
              powerState = { date: '', safeCloseDone: false, shutdownIssued: false };
              powerClosing = false;
              log('控制台：已解除定时关闭锁（下次启动会正常恢复）');
              sendJson({ ok: true, message: '已解除关闭锁' });
              return;
            }
            if (action === 'cancel') {
              const ok = cancelSystemShutdown();
              log(`控制台：已请求取消系统关机（${ok ? '已发送 shutdown /a' : '失败'}）`);
              sendJson({ ok, message: ok ? '已取消系统关机' : '取消失败' });
              return;
            }
            const merged = resolvePowerConfig({ ...resolvePowerConfig(cfg.power), ...(body.config && typeof body.config === 'object' ? body.config : body) });
            if (merged.shutdownTime && merged.safeCloseTime
              && merged.safeCloseEnabled && merged.shutdownEnabled
              && /^([01]\d|2[0-3]):([0-5]\d)$/.test(merged.shutdownTime)
              && /^([01]\d|2[0-3]):([0-5]\d)$/.test(merged.safeCloseTime)) {
              // 允许关机时间早于安全关闭：那就在安全关闭完成后按 shutdownDelaySeconds 关机，不跨天
            }
            const cfgFile = path.join(ROOT, 'config.json');
            const current = readJsonSafe(cfgFile, null) ?? {};
            current.power = merged;
            atomicWriteJson(cfgFile, current);
            cfg.power = merged;
            powerState = { date: '', safeCloseDone: false, shutdownIssued: false };
            log(`控制台：定时关闭配置已保存（${merged.enabled ? '启用' : '关闭'}；安全关闭 ${merged.safeCloseEnabled ? merged.safeCloseTime : 'off'}；关机 ${merged.shutdownEnabled ? merged.shutdownTime : 'off'}）`);
            sendJson({ ok: true, config: merged });
            return;
          }
        }
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          const status = url.searchParams.get('status') || '';
          const list = status ? slangEntries.filter((e) => e.status === status) : slangEntries;
          sendJson({ entries: list, config: cfg.slang, writable: slangStoreWritable });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang') {
          const body = await readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          if (slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          if (entry.status === SLANG_STATUS.CONFIRMED) void ingestSlangKnowledge(entry);
          log(`控制台：新增黑话「${content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
          const body = await readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return;
          }
          let removedCount = 0;
          if (status) {
            removedCount = slangEntries.filter((e) => e.status === status).length;
            slangEntries = slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = slangEntries.length;
            slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            slangWindows.clear();
            slangExtractionCooldowns.clear();
            slangSubmitTimes.clear();
            slangResearchingIds.clear();
          }
          saveSlangStore();
          log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = slangEntries.length;
            slangEntries = slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - slangEntries.length;
            if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
            saveSlangStore();
            log(`控制台：批量删除黑话 ${removedCount} 条`);
            sendJson({ ok: true, removedCount });
            return;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return;
          }
          if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
          const removedCount = slangEntries.filter((e) => e.status === status).length;
          slangEntries = slangEntries.filter((e) => e.status !== status);
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          const confirmedEntries = [];
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedEntries.push(entry);
            confirmedCount++;
          }
          if (confirmedCount) saveSlangStore();
          for (const entry of confirmedEntries) void ingestSlangKnowledge(entry);
          log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) saveSlangStore();
          log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          sendJson({ ok: true, rejectedCount });
          return;
        }
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = { ...slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          const wasConfirmed = slangEntries[idx].status === SLANG_STATUS.CONFIRMED;
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          slangEntries[idx] = entry;
          saveSlangStore();
          if (!wasConfirmed && entry.status === SLANG_STATUS.CONFIRMED) void ingestSlangKnowledge(entry);
          log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          void ingestSlangKnowledge(entry);
          log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = slangEntries.splice(idx, 1);
          saveSlangStore();
          log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && slangWindows.has(key)) {
            queueSlangTask(() => runSlangExtraction(key));
            sendJson({ ok: true, key });
          } else {
            const firstKey = slangWindows.keys().next().value;
            if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
            queueSlangTask(() => runSlangExtraction(firstKey));
            sendJson({ ok: true, key: firstKey });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/research') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
          // 直接开新会话并行研究（不再排进学习队列，避免等待上一批）
          void runSlangResearch(candidates).catch((error) => log(`黑话研究调度失败：${error?.message ?? error}`));
          sendJson({ ok: true, count: candidates.length });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/config') {
          const body = await readBody();
          const oldPreset = cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractMax !== undefined) merged.extractMax = Math.min(50, Math.max(1, Math.round(Number(merged.extractMax) || 10)));
          if (merged.extractPromptExtra !== undefined) merged.extractPromptExtra = String(merged.extractPromptExtra ?? '').trim().slice(0, 2000);
          if (merged.researchPromptExtra !== undefined) merged.researchPromptExtra = String(merged.researchPromptExtra ?? '').trim().slice(0, 2000);
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          atomicWriteJson(configFile, file);
          cfg.slang = { ...cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习工作区名已变更，已重置学习会话');
          }
          log('控制台：黑话系统配置已更新');
          sendJson({ ok: true, config: cfg.slang });
          return;
        }
        // ── 定时问候（真实网络时间；到点直发，不经过代理） ─────────────────────
        if (url.pathname === '/api/greetings' || url.pathname.startsWith('/api/greetings/')) {
          const sub = url.pathname.slice('/api/greetings'.length).replace(/^\//, '');
          const withImageUrl = (entry) => ({
            ...entry,
            imageUrl: entry.imagePath ? `/api/greetings/image?path=${encodeURIComponent(entry.imagePath)}` : ''
          });
          if (req.method === 'GET' && !sub) {
            const conf = greetingConfig();
            const net = await greetingClock.current();
            const parts = zonedParts(net.nowMs, conf.timeZone);
            sendJson({
              ok: true,
              config: conf,
              entries: greetingStore.entries().map(withImageUrl),
              images: greetingImagePool().map((item) => item.path),
              pool: greetingImagePool().map((item) => ({
                path: item.path,
                desc: item.desc,
                imageUrl: `/api/greetings/image?path=${encodeURIComponent(item.path)}`
              })),
              status: {
                now: parts.time,
                date: parts.date,
                network: { ok: net.networkOk, source: net.source, skewMs: net.skewMs },
                nextFireAt: nextFireAt({ config: conf, nowMs: net.nowMs }),
                firedToday: greetingStore.firedToday(parts.date),
                lastFired: greetingStore.raw().lastFired ?? null,
                lastError: greetingLastError,
                lastTickAt: greetingLastTickAt
              }
            });
            return;
          }
          if (req.method === 'GET' && sub === 'image') {
            const raw = String(url.searchParams.get('path') ?? '');
            let file = '';
            try { file = resolveGreetingImage(raw); } catch (error) {
              sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
              return;
            }
            try {
              const buf = fs.readFileSync(file);
              const ext = path.extname(file).toLowerCase();
              const mime = ext === '.png' ? 'image/png'
                : ext === '.gif' ? 'image/gif'
                  : ext === '.webp' ? 'image/webp'
                    : 'image/jpeg';
              res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', ...SECURITY_HEADERS });
              res.end(buf);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? String(error) }, 404);
            }
            return;
          }
          if (req.method !== 'POST') {
            sendJson({ ok: false, error: '不支持的方法' }, 405);
            return;
          }
          const body = await readBody();
          if (sub === 'config') {
            const merged = resolveGreetingConfig({
              ...greetingConfig(),
              ...(body.config && typeof body.config === 'object' ? body.config : body)
            });
            // configFile 是各处理分支里的局部变量，这里不能引用：统一按 ROOT 解析
            const cfgFile = path.join(ROOT, 'config.json');
            const current = readJsonSafe(cfgFile, null) ?? {};
            current.greetings = merged;
            atomicWriteJson(cfgFile, current);
            cfg.greetings = merged;
            log(`控制台：定时问候配置已保存（启用=${merged.enabled}，时段 ${merged.times.morning}/${merged.times.noon}/${merged.times.evening}，目标 ${merged.targets.join(',') || '无'}）`);
            sendJson({ ok: true, config: greetingConfig() });
            return;
          }
          if (sub === 'entry') {
            const action = String(body.action ?? 'save');
            if (action === 'delete') {
              const removed = greetingStore.remove(String(body.id ?? ''));
              sendJson({ ok: removed, entries: greetingStore.entries().map(withImageUrl) }, removed ? 200 : 404);
              return;
            }
            const raw = body.entry && typeof body.entry === 'object' ? body.entry : body;
            const text = String(raw.text ?? '').trim();
            if (action !== 'delete' && !text) {
              sendJson({ ok: false, error: '问候语不能为空' }, 400);
              return;
            }
            const entryId = String(raw.id ?? '').trim() || `g_${crypto.randomBytes(5).toString('hex')}`;
            const existing = greetingStore.entries().find((item) => item.id === entryId);
            const entry = greetingStore.upsert({
              id: entryId,
              slot: raw.slot ?? existing?.slot,
              text,
              // 没带 imagePath = 只改文字，保留原来配的图（之前这里会把图冲掉）
              imagePath: raw.imagePath === undefined ? existing?.imagePath ?? '' : raw.imagePath,
              enabled: raw.enabled !== false
            });
            sendJson({ ok: true, entry: withImageUrl(entry), entries: greetingStore.entries().map(withImageUrl) });
            return;
          }
          if (sub === 'upload') {
            const id = String(body.id ?? '').trim();
            const current = greetingStore.entries().find((entry) => entry.id === id);
            if (!current) { sendJson({ ok: false, error: '条目不存在' }, 404); return; }
            const m = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.dataUrl ?? ''));
            if (!m) { sendJson({ ok: false, error: '只支持 png/jpeg/webp/gif 的 data URL' }, 400); return; }
            const ext = m[2] === 'jpeg' || m[2] === 'jpg' ? '.jpg' : `.${m[2]}`;
            const buf = Buffer.from(m[3].replace(/\s+/g, ''), 'base64');
            if (!buf.length) { sendJson({ ok: false, error: '图片内容为空' }, 400); return; }
            if (buf.length > 8 * 1024 * 1024) { sendJson({ ok: false, error: '图片超过 8MB' }, 400); return; }
            fs.mkdirSync(GREETINGS_IMAGE_DIR, { recursive: true });
            const file = path.join(GREETINGS_IMAGE_DIR, `${id}${ext}`);
            fs.writeFileSync(file, buf);
            const rel = path.relative(ROOT, file).split(path.sep).join('/');
            const entry = greetingStore.upsert({ ...current, imagePath: rel });
            log(`问候图片已保存：${rel}（${Math.round(buf.length / 1024)} KB）`);
            sendJson({ ok: true, entry: withImageUrl(entry), entries: greetingStore.entries().map(withImageUrl) });
            return;
          }
          if (sub === 'generate') {
            try {
              const result = await generateGreetings({
                count: body.count,
                slots: Array.isArray(body.slots) ? body.slots : undefined,
                style: body.style
              });
              sendJson({
                ok: true,
                added: result.added.map(withImageUrl),
                entries: greetingStore.entries().map(withImageUrl)
              });
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            }
            return;
          }
          if (sub === 'test' || sub === 'fire') {
            try {
              const result = await fireGreeting({
                slot: String(body.slot ?? 'any'),
                entryId: String(body.id ?? ''),
                target: String(body.target ?? ''),
                reason: 'test'
              });
              sendJson(result, result.ok ? 200 : 400);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            }
            return;
          }
          if (sub === 'pool') {
            // 图片池：多张上传 / 删除；生成问候和「条目没配图」的兜底都从这里取。
            const action = String(body.action ?? 'upload');
            if (action === 'delete') {
              const raw = String(body.path ?? '');
              let abs = '';
              try { abs = resolveGreetingImage(raw); } catch (error) {
                sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
                return;
              }
              // 只允许删上传目录里的文件；assets 是随包资源，不能从控制台删。
              const uploadRoot = path.join(STATE_DIR, 'greetings');
              if (!abs.startsWith(uploadRoot + path.sep)) {
                sendJson({ ok: false, error: '只能删除 state/greetings 下的上传图片' }, 400);
                return;
              }
              try { fs.unlinkSync(abs); } catch (error) {
                sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
                return;
              }
              // 引用了这张图的条目改成「没图」（发送时只发文字，不再随机补图）
              for (const entry of greetingStore.entries()) {
                if (entry.imagePath === raw) greetingStore.upsert({ ...entry, imagePath: '' });
              }
              const notes = greetingPoolNotes();
              if (raw in notes) { delete notes[raw]; saveGreetingPoolNotes(notes); }
              log(`问候图池：已删除 ${raw}`);
              sendJson({ ok: true, pool: greetingImagePool(), entries: greetingStore.entries().map(withImageUrl) });
              return;
            }
            if (action === 'describe') {
              const raw = String(body.path ?? '');
              const desc = String(body.desc ?? '').trim().slice(0, 120);
              if (!greetingImagePool().some((item) => item.path === raw)) {
                sendJson({ ok: false, error: '图片不在图池里' }, 400);
                return;
              }
              const notes = greetingPoolNotes();
              if (desc) notes[raw] = desc; else delete notes[raw];
              saveGreetingPoolNotes(notes);
              sendJson({ ok: true, pool: greetingImagePool() });
              return;
            }
            const m = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.dataUrl ?? ''));
            if (!m) { sendJson({ ok: false, error: '只支持 png/jpeg/webp/gif 的 data URL' }, 400); return; }
            const ext = m[2] === 'jpeg' || m[2] === 'jpg' ? '.jpg' : `.${m[2]}`;
            const buf = Buffer.from(m[3].replace(/\s+/g, ''), 'base64');
            if (!buf.length) { sendJson({ ok: false, error: '图片内容为空' }, 400); return; }
            if (buf.length > 8 * 1024 * 1024) { sendJson({ ok: false, error: '图片超过 8MB' }, 400); return; }
            const poolDir = path.join(GREETINGS_IMAGE_DIR, 'pool');
            fs.mkdirSync(poolDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
            const name = `${stamp}_${crypto.randomBytes(3).toString('hex')}${ext}`;
            const file = path.join(poolDir, name);
            fs.writeFileSync(file, buf);
            const rel = path.relative(ROOT, file).split(path.sep).join('/');
            log(`问候图池：已上传 ${rel}（${Math.round(buf.length / 1024)} KB）`);
            sendJson({ ok: true, path: rel, imageUrl: `/api/greetings/image?path=${encodeURIComponent(rel)}`, pool: greetingImagePool() });
            return;
          }
          if (sub === 'reset-fired') {
            greetingStore.clearFired();
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: '未知的定时问候动作' }, 404);
          return;
        }

        // ── 共享知识库（人工审核 + 向量/关键词检索） ──────────────────────────
        // 控制台专用：AI 的读写走 /api/socialV2/knowledge/*（带会话令牌，且只读/只提议）。
        if (url.pathname === '/api/knowledge' || url.pathname.startsWith('/api/knowledge/')) {
          const publicConfig = () => ({
            enabled: cfg.knowledge?.enabled !== false,
            backend: cfg.knowledge?.backend ?? 'off',
            local: {
              baseUrl: String(cfg.knowledge?.local?.baseUrl ?? ''),
              model: String(cfg.knowledge?.local?.model ?? '')
            },
            cloud: {
              baseUrl: String(cfg.knowledge?.cloud?.baseUrl ?? ''),
              model: String(cfg.knowledge?.cloud?.model ?? ''),
              // 密钥只回有没有，不回原文：控制台只需要知道「已经配过」
              hasKey: Boolean(String(cfg.knowledge?.cloud?.apiKey ?? '').trim())
            },
            topK: Number(cfg.knowledge?.topK ?? 5),
            minScore: Number(cfg.knowledge?.minScore ?? 0.25),
            injectMaxChars: Number(cfg.knowledge?.injectMaxChars ?? 1200),
            searchTimeoutMs: Number(cfg.knowledge?.searchTimeoutMs ?? 1500),
            maxEntries: Number(cfg.knowledge?.maxEntries ?? 3000),
            allowPropose: cfg.knowledge?.allowPropose !== false,
            embedder: {
              mode: knowledgeEmbedder.mode,
              model: knowledgeEmbedder.model,
              enabled: knowledgeEmbedder.enabled,
              dim: knowledgeEmbedder.dim
            }
          });
          if (req.method === 'GET' && url.pathname === '/api/knowledge/context') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const text = await withKnowledgeContext('', key);
          sendJson({ ok: true, key, block: text, chars: text.length });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/knowledge') {
            const status = String(url.searchParams.get('status') ?? '').trim();
            const q = String(url.searchParams.get('q') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 300) || 300));
            sendJson({
              ok: true,
              items: knowledgeStore.list({ status, q, limit }),
              stats: knowledgeStore.stats(),
              config: publicConfig(),
              autoApprove: {
                config: knowledgeApprover.config(),
                stats: knowledgeApprover.stats(),
                bannedTerms: BANNED_TERM_COUNT
              },
              collect: { config: knowledgeCollector.config(), stats: knowledgeCollector.stats() },
              approver: {
                mode: cfg.knowledge?.autoApprove?.mode === 'rules' ? 'rules' : 'agent',
                scheduler: approverScheduler.status(),
                options: resolveApproverOptions(cfg.knowledge?.autoApprove?.agent ?? {}),
                pendingPacks: pendingApproverPacks(500).length
              },
              verify: { stats: knowledgeVerifier.stats(), domainTerms: DOMAIN_TERM_COUNT, judge: knowledgeJudge.stats() },
              webSearch: {
                provider: cfg.knowledge?.webSearch?.provider ?? 'auto',
                tavily: {
                  enabled: cfg.knowledge?.webSearch?.tavily?.enabled !== false,
                  // 不回传 key 本身：控制台只需要知道「有没有配」
                  hasKey: Boolean(String(cfg.knowledge?.webSearch?.tavily?.apiKey ?? '').trim()),
                  keyless: cfg.knowledge?.webSearch?.tavily?.keyless !== false,
                  searchDepth: cfg.knowledge?.webSearch?.tavily?.searchDepth === 'advanced' ? 'advanced' : 'basic',
                  minScore: Number(cfg.knowledge?.webSearch?.tavily?.minScore ?? 0.2),
                  maxResults: Number(cfg.knowledge?.webSearch?.tavily?.maxResults ?? 6)
                }
              }
            });
            return;
          }
          if (req.method !== 'POST') {
            sendJson({ ok: false, error: '不支持的方法' }, 405);
            return;
          }
          const body = await readBody();
          const action = url.pathname.slice('/api/knowledge/'.length);
          if (action.startsWith('approver/')) {
            const subAction = action.slice('approver/'.length);
            if (!approverTokenOk(body.token)) {
              log(`审批代理工具调用被拒（令牌无效）：${subAction}，token=${String(body.token ?? '').slice(0, 8)}…`);
              sendJson({ ok: false, error: '审批令牌无效或已过期（审批工具只对审批代理开放）' }, 403);
              return;
            }
            if (subAction === 'pending') {
              log('审批代理工具提交：pending（列待审包）');
              const limit = Math.min(200, Math.max(1, Number(body.limit ?? 50) || 50));
              const packs = pendingApproverPacks(limit).map((pack) => ({
                id: pack.id, group: pack.group, count: pack.count, timeText: pack.timeText, text: pack.text, lines: pack.lines
              }));
              sendJson({ ok: true, total: pendingApproverPacks(500).length, packs });
              return;
            }
            if (subAction === 'pack') {
              log(`审批代理工具提交：pack ${String(body.id ?? '')}`);
              const item = knowledgeStore.get(String(body.id ?? ''));
              if (!item) { sendJson({ ok: false, error: '条目不存在' }, 404); return; }
              sendJson({ ok: true, pack: {
                id: item.id, text: item.text, lines: item.lines ?? null, tags: item.tags,
                group: item.group, status: item.status
              } });
              return;
            }
            if (subAction === 'verdict') {
              const result = await applyApproverVerdict({ ...body });
              if (result.ok) approverToolSubmits += 1;
              // 工具路径单独留痕：这样能和「回复里 JSON 兜底」区分开，排查时不用猜。
              log(`审批代理工具提交：${String(body.id ?? '')} ${String(body.verdict ?? '')} → ${result.ok ? (result.status ?? 'ok') : `失败：${result.error}`}`);
              sendJson(result, result.ok ? 200 : 400);
              return;
            }
            sendJson({ ok: false, error: '未知审批动作' }, 404);
            return;
          }
          if (action === 'add') {
            // 「仅来源群可见」靠 group 做可见性匹配：没有 group 就是谁都看不见的死条目，
            // 与其静默写进去，不如当场说清楚。
            if (body.private === true && !String(body.group ?? '').trim()) {
              sendJson({ ok: false, error: '「仅来源群可见」必须填写来源会话 key（如 group:1019799335）' }, 400);
              return;
            }
            const result = knowledgeStore.add({
              text: body.text,
              tags: body.tags,
              source: String(body.source ?? 'manual'),
              group: String(body.group ?? ''),
              private: body.private === true,
              proposedBy: String(body.proposedBy ?? 'console'),
              note: String(body.note ?? ''),
              lines: Array.isArray(body.lines) ? body.lines : null
            });
            if (!result.ok && result.duplicate) {
              sendJson({ ok: true, duplicate: true, id: result.id, status: result.status, message: '已有相同内容，未重复添加' });
              return;
            }
            if (result.ok) {
              if (cfg.knowledge?.autoApprove?.mode === 'rules') {
                void knowledgeApprover.run().catch((error) => log(`自动批准代理运行失败：${error?.message ?? error}`));
              } else {
                void approverScheduler.tick().catch((error) => log(`审批代理调度失败：${error?.message ?? error}`));
              }
            }
            sendJson(result, result.ok ? 200 : 400);
            return;
          }
          if (action === 'update') {
            const result = knowledgeStore.update(String(body.id ?? ''), body.patch ?? body);
            sendJson(result, result.ok ? 200 : 400);
            return;
          }
          if (action === 'approve') {
            const result = await knowledgeStore.approve(String(body.id ?? ''), body.patch ?? {});
            if (result.ok) log(`控制台：知识库条目已批准（${result.item?.id}${result.embedded ? '，已向量化' : '，未向量化'}）`);
            sendJson(result, result.ok ? 200 : 400);
            return;
          }
          if (action === 'reject') {
            const result = knowledgeStore.reject(String(body.id ?? ''), String(body.note ?? ''));
            sendJson(result, result.ok ? 200 : 400);
            return;
          }
          if (action === 'restore') {
            // 超期归档的条目放回待审：拦截标记和核实凭据都还在，可以继续人工处理
            const result = knowledgeStore.restore(String(body.id ?? ''));
            if (result.ok) log(`控制台：知识库归档条目已放回待审（${result.item?.id}）`);
            sendJson(result, result.ok ? 200 : 400);
            return;
          }
          if (action === 'delete') {
            const result = knowledgeStore.remove(String(body.id ?? ''));
            sendJson(result, result.ok ? 200 : 400);
            return;
          }
          if (action === 'merge') {
            const result = knowledgeStore.merge(body.ids, { text: body.text, tags: body.tags });
            sendJson(result, result.ok ? 200 : 400);
            return;
          }
          if (action === 'search') {
            const hits = await knowledgeStore.search(String(body.q ?? ''), {
              k: Number(body.k ?? 5),
              key: String(body.key ?? '')
            });
            sendJson({ ok: true, hits, mode: hits[0]?.mode ?? (knowledgeEmbedder.enabled ? 'vector' : 'keyword') });
            return;
          }
          if (action === 'test') {
            // 表单里留空的字段按「沿用已保存的值」处理：否则用户没重填 key 就点测试，
            // 会被当成「key 为空」而失败，看起来像保存失效。
            const pick = (base, patch) => {
              const merged = { ...(base ?? {}) };
              for (const [key, value] of Object.entries(patch ?? {})) {
                if (typeof value === 'string' && !value.trim()) continue;
                merged[key] = value;
              }
              return merged;
            };
            const trial = createEmbedder({
              backend: String(body.backend ?? cfg.knowledge?.backend ?? 'off'),
              local: pick(cfg.knowledge?.local, body.local),
              cloud: pick(cfg.knowledge?.cloud, body.cloud),
              log
            });
            const result = await trial.probe({ timeoutMs: 12000 });
            sendJson({ ok: result.ok, result });
            return;
          }
          if (action === 'search-test') {
            // 控制台「试搜一下」：只跑一次真实搜索、只读，不改任何配置。
            const q = String(body.query ?? '').trim();
            if (!q) { sendJson({ ok: false, error: 'query 不能为空' }, 400); return; }
            const saved = cfg.knowledge?.webSearch ?? {};
            const incoming = body.webSearch ?? {};
            const incomingKey = incoming?.tavily?.apiKey;
            const apiKey = typeof incomingKey === 'string' && incomingKey.trim()
              ? incomingKey.trim()
              : String(saved?.tavily?.apiKey ?? '');
            const trial = {
              ...saved,
              ...(incoming.provider ? { provider: incoming.provider } : {}),
              tavily: { ...(saved.tavily ?? {}), ...(incoming.tavily ?? {}), apiKey }
            };
            try {
              const result = await webSearch(q, { root: ROOT, config: trial });
              sendJson({
                ok: true,
                query: q,
                provider: result.provider,
                note: result.note ?? '',
                results: (result.results ?? []).slice(0, 5).map((item) => ({
                  title: item.title, url: item.url, snippet: String(item.snippet ?? '').slice(0, 160),
                  ...(item.score !== undefined ? { score: item.score } : {})
                }))
              });
            } catch (error) {
              sendJson({ ok: false, error: String(error?.message ?? error) });
            }
            return;
          }
          if (action === 'collect') {
            // 控制台「立即打包」：把当前缓冲全部打出来（调试/演示用）；flushAll=false 只读状态
            if (body.flushAll === true) {
              const packs = [];
              for (const key of [...(knowledgeCollector.stats().buffered ? Object.keys(knowledgeCollector.stats().buffered) : [])]) {
                const pack = knowledgeCollector.flushKey(key, 'manual');
                if (pack) packs.push({ key: pack.key, count: pack.count, text: pack.text.slice(0, 120) });
              }
              sendJson({ ok: true, packs, stats: knowledgeCollector.stats() });
              return;
            }
            sendJson({ ok: true, stats: knowledgeCollector.stats(), config: knowledgeCollector.config() });
            return;
          }
          if (action === 'auto-approve') {
            // 控制台「立即运行一次」：force 忽略阈值，只跳过已被拦截的条目
            const result = await knowledgeApprover.run({ force: body.force !== false });
            if (result.ran) log(`控制台：手动触发自动批准（放行 ${result.approved}、拦截 ${result.blocked}）`);
            sendJson(result);
            return;
          }
          if (action === 'reindex') {
            const result = await knowledgeStore.reindex({ limit: Number(body.limit ?? 500) });
            if (result.ok) log(`控制台：知识库重建向量完成（${result.done} 条，失败 ${result.failed}）`);
            sendJson(result, result.ok ? 200 : 400);
            return;
          }
          if (action === 'settings') {
            const previous = { ...(cfg.knowledge ?? {}) };
            const merged = { ...previous };
            if (body.enabled !== undefined) merged.enabled = body.enabled !== false;
            if (body.backend !== undefined) merged.backend = ['off', 'local', 'cloud'].includes(String(body.backend)) ? String(body.backend) : 'off';
            if (body.local !== undefined) {
              merged.local = {
                baseUrl: String(body.local?.baseUrl ?? previous.local?.baseUrl ?? '').trim(),
                model: String(body.local?.model ?? previous.local?.model ?? '').trim()
              };
            }
            if (body.cloud !== undefined) {
              const nextKey = Object.prototype.hasOwnProperty.call(body.cloud ?? {}, 'apiKey')
                ? String(body.cloud.apiKey ?? '')
                : String(previous.cloud?.apiKey ?? '');
              merged.cloud = {
                baseUrl: String(body.cloud?.baseUrl ?? previous.cloud?.baseUrl ?? '').trim(),
                model: String(body.cloud?.model ?? previous.cloud?.model ?? '').trim(),
                apiKey: nextKey.trim()
              };
            }
            for (const key of ['topK', 'maxEntries', 'searchTimeoutMs', 'injectMaxChars']) {
              if (body[key] !== undefined) merged[key] = Math.max(1, Math.round(Number(body[key]) || 1));
            }
            if (merged.topK !== undefined) merged.topK = Math.min(20, merged.topK);
            if (body.minScore !== undefined) merged.minScore = Math.min(0.95, Math.max(0, Number(body.minScore) || 0));
            if (body.allowPropose !== undefined) merged.allowPropose = body.allowPropose !== false;
            if (body.autoApprove !== undefined) {
              const prevAuto = merged.autoApprove ?? {};
              const archiveDays = Number(body.autoApprove?.archiveDays ?? prevAuto.archiveDays ?? 30);
              merged.autoApprove = {
                enabled: body.autoApprove?.enabled !== false,
                archiveDays: Number.isFinite(archiveDays) ? Math.max(0, Math.min(3650, Math.round(archiveDays))) : 30,
                batchSize: Math.max(1, Math.min(500, Math.round(Number(body.autoApprove?.batchSize ?? prevAuto.batchSize ?? 20) || 20))),
                intervalMs: Math.max(5000, Math.min(3600000, Math.round(Number(body.autoApprove?.intervalMs ?? prevAuto.intervalMs ?? 60000) || 60000))),
                extraTerms: Array.isArray(body.autoApprove?.extraTerms)
                  ? body.autoApprove.extraTerms.map((term) => String(term ?? '').trim()).filter(Boolean).slice(0, 500)
                  : (Array.isArray(prevAuto.extraTerms) ? prevAuto.extraTerms : []),
                verify: {
                  enabled: body.autoApprove?.verify?.enabled !== false,
                  kbDupScore: Math.min(1, Math.max(0.5, Number(body.autoApprove?.verify?.kbDupScore ?? prevAuto.verify?.kbDupScore ?? 0.75) || 0.9)),
                  maxVerifyPerRun: Math.max(0, Math.min(100, Math.round(Number(body.autoApprove?.verify?.maxVerifyPerRun ?? prevAuto.verify?.maxVerifyPerRun ?? 10) || 10))),
                  maxRunMs: Math.max(5000, Math.min(600000, Math.round(Number(body.autoApprove?.verify?.maxRunMs ?? prevAuto.verify?.maxRunMs ?? 90000) || 90000))),
                  judge: {
                    enabled: body.autoApprove?.verify?.judge?.enabled !== false,
                    timeoutMs: Math.max(3000, Math.min(180000, Math.round(Number(body.autoApprove?.verify?.judge?.timeoutMs ?? prevAuto.verify?.judge?.timeoutMs ?? 25000) || 25000))),
                    maxSources: Math.max(1, Math.min(8, Math.round(Number(body.autoApprove?.verify?.judge?.maxSources ?? prevAuto.verify?.judge?.maxSources ?? 3) || 3)))
                  }
                }
              };
            }
            if (body.webSearch !== undefined) {
              const prevWs = merged.webSearch ?? {};
              const prevTv = prevWs.tavily ?? {};
              const numOr = (value, fallback, min, max) => {
                const n = Number(value);
                if (!Number.isFinite(n)) return fallback;
                return Math.min(max, Math.max(min, n));
              };
              const incomingKey = body.webSearch?.tavily?.apiKey;
              // 表单里留空 = 沿用已保存的 key；要清空必须显式 clearKey
              let nextKey = typeof prevTv.apiKey === 'string' ? prevTv.apiKey : '';
              if (body.webSearch?.tavily?.clearKey === true) nextKey = '';
              else if (typeof incomingKey === 'string' && incomingKey.trim()) nextKey = incomingKey.trim();
              merged.webSearch = {
                ...prevWs,
                provider: ['tavily', 'deepseek', 'bing', 'auto'].includes(body.webSearch?.provider)
                  ? body.webSearch.provider
                  : (prevWs.provider ?? 'auto'),
                tavily: {
                  ...prevTv,
                  enabled: body.webSearch?.tavily?.enabled !== false,
                  apiKey: nextKey,
                  keyless: body.webSearch?.tavily?.keyless !== false,
                  searchDepth: body.webSearch?.tavily?.searchDepth === 'advanced' ? 'advanced' : 'basic',
                  minScore: numOr(body.webSearch?.tavily?.minScore, prevTv.minScore ?? 0.2, 0, 1),
                  maxResults: Math.round(numOr(body.webSearch?.tavily?.maxResults, prevTv.maxResults ?? 6, 1, 20)),
                  timeoutMs: Math.round(numOr(body.webSearch?.tavily?.timeoutMs, prevTv.timeoutMs ?? 20000, 3000, 60000))
                }
              };
            }
            if (body.collect !== undefined) {
              const prevCollect = merged.collect ?? {};
              const int = (value, fallback, min, max) => {
                const n = Math.round(Number(value));
                if (!Number.isFinite(n)) return fallback;
                return Math.min(max, Math.max(min, n));
              };
              merged.collect = {
                enabled: body.collect?.enabled !== false,
                windowMs: int(body.collect?.windowMs, prevCollect.windowMs ?? 60000, 5000, 3600000),
                maxMessages: int(body.collect?.maxMessages, prevCollect.maxMessages ?? 20, 1, 100),
                minMessages: int(body.collect?.minMessages, prevCollect.minMessages ?? 1, 1, 100),
                minChars: int(body.collect?.minChars, prevCollect.minChars ?? 6, 1, 200),
                maxPacksPerHour: int(body.collect?.maxPacksPerHour, prevCollect.maxPacksPerHour ?? 60, 1, 600)
              };
            }
            const configFile = path.join(ROOT, 'config.json');
            const file = readConfigObject(configFile);
            file.knowledge = merged;
            atomicWriteJson(configFile, file);
            cfg.knowledge = merged;
            knowledgeEmbedder = buildKnowledgeEmbedder();
            startKnowledgeApproverTimer(); // 间隔可能被改了，重建定时器
            const backendChanged = (previous.backend ?? 'off') !== (merged.backend ?? 'off')
              || String(previous.cloud?.model ?? '') !== String(merged.cloud?.model ?? '')
              || String(previous.local?.model ?? '') !== String(merged.local?.model ?? '');
            let reindex = null;
            if (backendChanged && knowledgeEmbedder.enabled && knowledgeStore.stats().approved > 0) {
              reindex = 'running';
              void knowledgeStore.reindex()
                .then((result) => log(`知识库：后端已切换，重建向量 ${result.done}/${result.total}（失败 ${result.failed}）`))
                .catch((error) => log(`知识库：切换后端后重建向量失败：${error?.message ?? error}`));
            }
            log(`控制台：知识库配置已更新（backend=${merged.backend}，已启用=${merged.enabled !== false}）`);
            sendJson({ ok: true, config: publicConfig(), reindex });
            return;
          }
          sendJson({ ok: false, error: `未知操作：${action}` }, 404);
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readConfigObject(configFile);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          atomicWriteJson(configFile, file);
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
          const provider = String(cfg.dsh?.provider || 'deepseek-official');
          const model = String(cfg.dsh?.model || 'deepseek-flash');
          // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
          let options = REASONING_EFFORT_OPTIONS.slice();
          let labels = {};
          let providerDefault = null;
          let catalogSource = 'fallback';
          try {
            if (!modelCatalogInFlight) {
              modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
                .finally(() => { modelCatalogInFlight = null; });
            }
            const catalog = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            const efforts = entry?.reasoning?.efforts ?? [];
            const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => REASONING_EFFORT_OPTIONS.includes(id));
            if (advertised.length) {
              options = advertised;
              labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
              providerDefault = entry.reasoning.defaultEffort ?? null;
              catalogSource = 'dsh';
            }
          } catch (error) {
            // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
            const reason = String(error?.message ?? error);
            if (!modelCatalogErrorLogged.has(reason)) {
              modelCatalogErrorLogged.add(reason);
              log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            }
          }
          sendJson({
            provider,
            model,
            reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
            options,
            labels,
            default: REASONING_EFFORT_DEFAULT,
            providerDefault,
            catalogSource,
            // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
            // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
            globalSideEffect: true,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
          const body = await readBody();
          let effort;
          try { effort = normalizeReasoningEffort(body.reasoningEffort); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
          // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
          modelSelectionEpoch += 1;
          log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
          sendJson({ ok: true, reasoningEffort: effort });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/model/catalog') {
          // 控制台填模型时先看 DSH 真实公布的目录，不要让人对着空白输入框猜 id
          try {
            let groups = await dshModelGroups();
            if (!groups.length) {
              const catalog = unwrap(await withTimeout(fetchModelCatalog(), 4000, 'session/modelCatalog'), 'session/modelCatalog');
              groups = catalog?.groups ?? [];
            }
            const items = groups.map((group) => ({
              id: String(group?.id ?? ''),
              models: (group?.models ?? []).map((row) => {
                const text = `${row?.name ?? ''} ${row?.description ?? ''}`;
                return {
                  id: String(row?.id ?? ''),
                  name: String(row?.name ?? ''),
                  vision: /vision/i.test(text)
                };
              }).filter((row) => row.id)
            })).filter((group) => group.id && group.models.length);
            sendJson({ ok: items.length > 0, groups: items, count: items.reduce((total, group) => total + group.models.length, 0) });
          } catch (error) {
            sendJson({ ok: false, groups: [], error: String(error?.message ?? error) });
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/model/vision-catalog') {
          // 辅助识图走的是插件网关（OpenAI 兼容），模型名与 DSH 目录不是同一套，
          // 所以单独列「input 里含 image」的那些。
          const vision = cfg.dsh?.vision ?? {};
          const baseUrl = String(vision.baseUrl ?? '').replace(/\/+$/, '');
          const apiKey = String(vision.apiKey ?? '');
          if (!baseUrl || !apiKey) {
            sendJson({ ok: false, models: [], error: '未配置识图网关地址或凭据' });
            return;
          }
          try {
            const response = await withTimeout(fetch(`${baseUrl}/models`, {
              headers: { authorization: `Bearer ${apiKey}` }
            }), 8000, '识图模型列表');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            const models = (data?.data ?? [])
              .filter((row) => Array.isArray(row?.input) && row.input.includes('image'))
              .map((row) => ({ id: String(row.id ?? ''), name: String(row.name ?? '') }))
              .filter((row) => row.id)
              .slice(0, 200);
            sendJson({ ok: true, models, count: models.length });
          } catch (error) {
            sendJson({ ok: false, models: [], error: String(error?.message ?? error) });
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/model/config') {
          sendJson({ model: modelStatusSnapshot() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/model/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          let file;
          try { file = readConfigObject(configFile); }
          catch (error) { sendJson({ ok: false, error: `config.json 读取失败：${error?.message ?? error}` }, 500); return; }

          const clean = (value, max = 120) => String(value ?? '').trim().slice(0, max);
          const next = { ...(file.dsh ?? {}) };
          if (body.model !== undefined) next.model = clean(body.model);
          if (body.fallbackModel !== undefined) next.fallbackModel = clean(body.fallbackModel);
          if (body.visionModel !== undefined) next.vision = { ...(next.vision ?? {}), model: clean(body.visionModel) };
          if (body.visionEnabled !== undefined) next.vision = { ...(next.vision ?? {}), enabled: body.visionEnabled !== false };
          if (body.visionTimeoutMs !== undefined) {
            const ms = Number(body.visionTimeoutMs);
            if (!Number.isFinite(ms) || ms < 5000 || ms > 180000) { sendJson({ ok: false, error: '识图超时只能是 5000~180000 毫秒' }, 400); return; }
            next.vision = { ...(next.vision ?? {}), timeoutMs: Math.round(ms) };
          }
          if (body.visionMaxChars !== undefined) {
            const chars = Number(body.visionMaxChars);
            if (!Number.isFinite(chars) || chars < 40 || chars > 2000) { sendJson({ ok: false, error: '识图描述字数只能是 40~2000' }, 400); return; }
            next.vision = { ...(next.vision ?? {}), maxChars: Math.round(chars) };
          }
          if (!next.model) { sendJson({ ok: false, error: '主模型不能为空' }, 400); return; }
          if (next.fallbackModel && next.fallbackModel === next.model) {
            sendJson({ ok: false, error: '回退模型不能与主模型相同' }, 400);
            return;
          }

          file.dsh = next;
          atomicWriteJson(configFile, file);
          cfg.dsh = { ...(cfg.dsh ?? {}), ...next, vision: { ...(cfg.dsh?.vision ?? {}), ...(next.vision ?? {}) } };
          // 配置变更后立刻回到主模型重试，并让所有会话在下一条消息重新应用
          modelRuntime.active = 'primary';
          modelRuntime.visionCapable = true;
          modelRuntime.degradedAt = 0;
          modelRuntime.lastError = '';
          modelAppliedSessions.clear();
          modelSelectionEpoch += 1;
          log(`控制台：模型设置已更新（主 ${cfg.dsh.model} ｜ 回退 ${cfg.dsh.fallbackModel || '无'} ｜ 辅助识图 ${cfg.dsh.vision?.enabled !== false ? cfg.dsh.vision?.model : '关闭'}）`);
          sendJson({ ok: true, model: modelStatusSnapshot() });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({
            security: cfg.security ?? { interceptNotify: true },
            // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
            // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
            // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
            // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
            stateDir: {
              hardened: stateDirHardened,
              path: STATE_DIR,
              manualCommand: process.platform === 'win32'
                ? manualDirCommand(STATE_DIR)
                : `chmod 700 "${STATE_DIR}"`
            }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
          if (body.rehardenStateDir === true) {
            stateDirHardened = null;
            hardenStateDirAcl();
            sendJson({ ok: stateDirHardened === true, hardened: stateDirHardened, path: STATE_DIR });
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          atomicWriteJson(configFile, file);
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = devModeEnabled()
              ? (devInterceptSend('send_msg', `${kind}:${id}`, safeMessage), { message_id: 0, message_seq: 0 })
              : kind === 'private'
                ? await bot.sendPrivateMessage(id, text(safeMessage))
                : await bot.sendGroupMessage(id, text(safeMessage));
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (url.pathname.startsWith('/api/social/')) {
          sendJson({ ok: false, error: '一代仿真已移除：请使用 /api/socialV2/ 或行为配置页' }, 410);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: cfg.social, pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readConfigObject(configFile);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          atomicWriteJson(configFile, file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: cfg.social });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
            return;
          }
          if (!state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isV2 = currentMode === 'reserved2';
          const roleState = readRoleState();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          const promptText = `${roleLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        // ── 人格代理运行时：配置 / 注册 / 重置 ─────────────────────────────
        if (url.pathname === '/api/persona-runtime') {
          if (req.method === 'GET') {
            const agents = [...personaAgents.entries()].map(([role, rec]) => ({
              role,
              workspacePath: rec.workspacePath || '',
              branches: Object.keys(rec.branches || {})
            }));
            const configs = [...personaConfigs.entries()].map(([role, conf]) => ({ role, ...conf, preset: personaPresetId(role) }));
            const tasks = [...personaTaskStatus.entries()].map(([key, map]) => ({
              key,
              tasks: [...map.entries()].filter(([, s]) => s.status !== 'done').map(([seq, s]) => ({ seq, ...s }))
            }));
            sendJson({ ok: true, active: personaRuntimeEnabled(), config: personaRuntimeConf(), agents, configs, allowGroups: cfg.allow.groups ?? [], tasks, contextTokens: Object.fromEntries(personaContextTokens) });
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody();
            const input = body.config && typeof body.config === 'object' ? body.config : body;
            const cfgFile = path.join(ROOT, 'config.json');
            const file = readJsonSafe(cfgFile, null) ?? {};
            if (!file.socialV2 || typeof file.socialV2 !== 'object') file.socialV2 = {};
            const merged = resolvePersonaRuntimeConfig({ ...(file.socialV2.runtime || {}), ...input });
            file.socialV2.runtime = merged;
            atomicWriteJson(cfgFile, file);
            cfg.socialV2.runtime = merged;
            if (merged.enabled) retireLegacySessionsForPersonaRuntime('控制台启用人格运行时');
            log(`控制台：人格代理运行时配置已保存（启用=${merged.enabled}，重建阈值=${merged.contextRebuildRatio}）`);
            sendJson({ ok: true, config: merged });
            return;
          }
        }
        // 人格提示词模板库：可保存多份，新建/配置人格时选择注入
        if (url.pathname === '/api/persona-templates') {
          const loadTemplates = () => {
            const data = readJsonSafe(PERSONA_TEMPLATES_FILE, { templates: [] });
            return Array.isArray(data.templates) ? data.templates : [];
          };
          if (req.method === 'GET') {
            sendJson({ ok: true, templates: loadTemplates() });
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody();
            const list = loadTemplates();
            const name = String(body.name ?? '').trim();
            const content = String(body.content ?? '');
            if (!name) { sendJson({ ok: false, error: '模板名不能为空' }, 400); return; }
            const id = String(body.id ?? '').trim();
            const idx = id ? list.findIndex((tpl) => tpl.id === id) : list.findIndex((tpl) => tpl.name === name);
            const record = {
              id: id || (idx >= 0 ? list[idx].id : `tpl_${crypto.randomBytes(4).toString('hex')}`),
              name,
              content,
              updatedAt: Date.now()
            };
            if (idx >= 0) list[idx] = record; else list.push(record);
            atomicWriteJson(PERSONA_TEMPLATES_FILE, { templates: list });
            sendJson({ ok: true, template: record, templates: list });
            return;
          }
        }
        if (url.pathname.startsWith('/api/persona-templates/') && req.method === 'DELETE') {
          const id = decodeURIComponent(url.pathname.slice('/api/persona-templates/'.length));
          const data = readJsonSafe(PERSONA_TEMPLATES_FILE, { templates: [] });
          const list = (Array.isArray(data.templates) ? data.templates : []).filter((tpl) => tpl.id !== id);
          atomicWriteJson(PERSONA_TEMPLATES_FILE, { templates: list });
          sendJson({ ok: true, templates: list });
          return;
        }
        // 人格配置：绑定群 + 系统/用户提示词（直接存在人格名下，跟角色一起编辑）
        if (url.pathname === '/api/persona-config') {
          if (req.method === 'GET') {
            const role = String(url.searchParams.get('role') ?? '').trim();
            if (!role) {
              sendJson({ ok: true, configs: [...personaConfigs.entries()].map(([r, c]) => ({ role: r, ...c })) });
              return;
            }
            const conf = personaConfigs.get(role) || { groups: [], system: '', user: '' };
            sendJson({ ok: true, role, ...conf });
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody();
            const role = String(body.role ?? '').trim();
            if (!role) { sendJson({ ok: false, error: 'role 不能为空' }, 400); return; }
            const prev = personaConfigs.get(role) || { groups: [], system: '', user: '' };
            const normGroup = (g) => {
              const s = String(g ?? '').trim();
              if (/^\d+$/.test(s)) return `group:${s}`;
              return s;
            };
            const groups = Array.isArray(body.groups)
              ? [...new Set(body.groups.map(normGroup).filter((g) => /^(group|private):\d+$/.test(g)))]
              : prev.groups;
            // 系统层只放该人格自己的模板：通用系统预设由 preset 注入，这里不再重复拼接。
            const systemText = body.system !== undefined ? String(body.system).slice(0, 40000) : prev.system;
            const conf = {
              groups,
              system: systemText.slice(0, 40000),
              user: body.user !== undefined ? String(body.user).slice(0, 20000) : prev.user
            };
            personaConfigs.set(role, conf);
            savePersonaConfigs();
            // 保存后立刻按人格重建 preset（系统层模板注入预设；DSH 重启后生效）
            let presetBuilt = false;
            let presetError = '';
            try {
              execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-persona-presets.mjs')], { cwd: ROOT, timeout: 30000 });
              presetBuilt = true;
            } catch (error) {
              presetError = String(error?.message ?? error);
              log(`人格 preset 重建失败：${presetError}`);
            }
            log(`人格配置已保存：${role}，绑定 ${groups.join(',') || '无'}，preset 重建=${presetBuilt}`);
            sendJson({ ok: true, role, ...conf, presetBuilt, presetError });
            return;
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/persona-runtime/reset') {
          const body = await readBody();
          await resetPersonaAgent(String(body.role ?? ''), 'manual');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/persona-runtime/register') {
          const body = await readBody();
          const role = String(body.role ?? readRoleState().role ?? '').trim() || '默认';
          const rec = await ensurePersonaWorkspace(role);
          sendJson({ ok: true, role, workspaceId: rec.workspaceId, workspacePath: rec.workspacePath, branches: Object.keys(rec.branches || {}) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
          sendJson({ ok: true, config: cfg.socialV2 ?? {} });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // current 必须是「当前**生效**的 socialV2」，而不是文件里恰好写着的那一份。
          //
          // config.json 里没有 socialV2 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
          // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
          // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
          // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
          // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
          // 一个是需要先准备语音库的强表达）。cfg.socialV2 是「文件 + 默认值」深度合并后的运行时配置，
          // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
          const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
            ? file.socialV2
            : null;
          const current = fileV2 ?? ((cfg.socialV2 && typeof cfg.socialV2 === 'object') ? cfg.socialV2 : {});
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'speech', 'runtime', 'send', 'sticker', 'feedback', 'context']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // speech：新架构的主会话调度参数
          if (body.speech && typeof body.speech === 'object') {
            merged.speech = { ...(current.speech ?? {}), ...body.speech };
            const clamp = (key, fallback, min, max) => {
              const n = Number(merged.speech[key]);
              merged.speech[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
            };
            clamp('maxStartsPerHour', PERSONA_SPEECH_DEFAULTS.maxStartsPerHour, 1, 30);
            clamp('maxRepliesPerThread', PERSONA_SPEECH_DEFAULTS.maxRepliesPerThread, 1, 30);
            clamp('threadIdleMs', PERSONA_SPEECH_DEFAULTS.threadIdleMs, 60 * 1000, 24 * 3600 * 1000);
            clamp('retentionMs', PERSONA_SPEECH_DEFAULTS.retentionMs, 10 * 1000, 60 * 60 * 1000);
            clamp('baseChance', PERSONA_SPEECH_DEFAULTS.baseChance, 0, 1);
            clamp('maxChance', PERSONA_SPEECH_DEFAULTS.maxChance, 0, 1);
            clamp('spreadMs', PERSONA_SPEECH_DEFAULTS.spreadMs, 60 * 1000, 24 * 3600 * 1000);
            clamp('topicBypassMs', PERSONA_SPEECH_DEFAULTS.topicBypassMs, 60 * 1000, 60 * 60 * 1000);
            for (const k of ['maxStartsPerHour', 'maxRepliesPerThread', 'threadIdleMs', 'retentionMs', 'spreadMs', 'topicBypassMs']) {
              merged.speech[k] = Math.round(merged.speech[k]);
            }
            merged.speech.maxChance = Math.max(merged.speech.baseChance, merged.speech.maxChance);
          }
          // runtime：快照包大小（其余运行时字段原样保留）
          if (body.runtime && typeof body.runtime === 'object') {
            merged.runtime = { ...(current.runtime ?? {}), ...body.runtime };
            const base = Number(merged.runtime.packBaseSize ?? merged.runtime.maxTopicsPerWake);
            const max = Number(merged.runtime.packMaxSize);
            merged.runtime.packBaseSize = Number.isFinite(base) ? Math.min(200, Math.max(10, Math.round(base))) : 50;
            merged.runtime.packMaxSize = Number.isFinite(max) ? Math.min(500, Math.max(10, Math.round(max))) : 200;
            if (merged.runtime.packMaxSize < merged.runtime.packBaseSize) {
              merged.runtime.packMaxSize = merged.runtime.packBaseSize;
            }
            const topicLimit = Number(merged.runtime.topicSnapshotLimit);
            merged.runtime.topicSnapshotLimit = Number.isFinite(topicLimit) ? Math.min(50, Math.max(1, Math.round(topicLimit))) : 20;
            const topicAge = Number(merged.runtime.topicSnapshotMaxAgeMs);
            merged.runtime.topicSnapshotMaxAgeMs = Number.isFinite(topicAge)
              ? Math.min(60 * 60 * 1000, Math.max(60 * 1000, Math.round(topicAge)))
              : 10 * 60 * 1000;
            delete merged.runtime.maxTopicsPerWake;
          }
          // tools：只接受布尔开关
          const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'topicOpen', 'sendVoice'];
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
            for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
              const n = Number(merged.context[name] ?? fallback);
              merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
            }
            if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          }
          // 新架构不再落盘旧参数：自唤醒/潜水推荐/等待/主动机会/回复检查统一清理。
          for (const k of ['autoReplyCheckMs', 'wake', 'wait', 'proactive', 'provideRecommendations']) delete merged[k];
          if (merged.context && typeof merged.context === 'object') {
            for (const k of ['contextWindow', 'inlineWakeMessages', 'wakeMessageLimit', 'wakeRecentLimit', 'wakeMaxChars']) delete merged.context[k];
          }
          if (merged.send && typeof merged.send === 'object') {
            for (const k of ['maxSendPerMinute', 'maxSendPerHour', 'recommendedHint']) delete merged.send[k];
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.socialV2 = merged;
          atomicWriteJson(configFile, file);
          cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
          log('控制台：二代仿真配置已更新');
          sendJson({ ok: true, config: cfg.socialV2 });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          socialV2.paused = paused;
          if (paused) {
            clearAllSocialV2Timers();
            log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：二代 AI 已恢复');
            for (const key of socialV2.conversations.keys()) {
              setupSleepTimerV2(key);
              scheduleProactiveCheckV2(key);
              const st = getSocialV2State(key);
              if (Array.isArray(st.unread) && st.unread.length && personaRuntimeEnabled() && personaForGroup(key)) {
                schedulePersonaRun(key, 0);
              }
            }
          }
          saveSocialV2State();
          sendJson({ ok: true, paused: socialV2.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
          sessionEpoch++;
          sessionPromises.clear();
          clearAllSocialV2Timers();
          drainAllPromptQueues('二代状态已重置');
          for (const key of [...socialV2.conversations.keys()]) {
            const sid = state.sessions[key];
            if (sid) {
              delete state.sessions[key];
              // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
              // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
              // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
              stopRetiredSessionWork(sid, key);
              sessionModels.delete(sid);
              modelAppliedSessions.delete(sid);
              reverse.delete(sid);
              collectors.delete(sid);
              v2TurnStartAt.delete(sid);
              turnLeaseNoted.delete(sid);
              toolCallNames.delete(sid);
              pendingSendToolCalls.delete(sid);
              sendToolSucceededSessions.delete(sid);
              // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
              api.events.forget?.(sid);
            }
            delete state.sessionPolicies[key];
            forgetAgentToken(key);
            socialV2.conversations.delete(key);
            seenForwardIds.delete(key);
          }
          saveState();
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          socialV2.paused = false;
          try {
            personaTaskStatus.clear();
            personaHandledSeqs.clear();
            personaInflightSeqs.clear();
            personaTaskSaveTimer && clearTimeout(personaTaskSaveTimer);
            personaTaskSaveTimer = null;
            for (const role of [...personaAgents.keys()]) await resetPersonaAgent(role, 'reset');
            atomicWriteJson(PERSONA_TASKS_FILE, { statuses: {}, handled: {} });
          } catch {}
          try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
          log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        // 清空某个（或全部）会话的排队消息：桥接本地队列 + DSH inbox，并取消在途 turn。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/clear-queue') {
          try {
            for (const timer of personaRunTimers.values()) clearTimeout(timer);
            personaRunTimers.clear();
            personaTaskStatus.clear();
          } catch {}
          const body = await readBody().catch(() => ({}));
          const wantKey = String(body.key ?? '').trim();
          const keys = wantKey ? [wantKey] : Object.keys(state.sessions);
          // 系统调度下消息在 unread 里，不在 state.sessions：必须一起清，否则下一条消息会把旧消息重新投递。
          const unreadKeys = wantKey ? [wantKey] : [...socialV2.conversations.keys()];
          for (const key of unreadKeys) {
            const st = getSocialV2State(key);
            if (Array.isArray(st.unread) && st.unread.length) {
              st.unread = [];
              personaTaskMap(key).clear();
              personaHandledSeqs.delete(key);
              personaInflightSeqs.delete(key);
            }
          }
          if (unreadKeys.length) saveSocialV2State();
          const result = [];
          for (const key of keys) {
            const sid = state.sessions[key];
            const entry = promptQueues.get(key);
            let dropped = 0;
            if (entry) {
              dropped = entry.queue.length;
              for (const item of entry.queue) item.reject(new Error('手动清空排队'));
              entry.queue.length = 0;
              promptQueues.delete(key);
            }
            if (!sid) { result.push({ key, ok: false, error: '没有会话', dropped }); continue; }
            try {
              const r = await withTimeout(api.stopSessionWork(sid), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork');
              result.push({ key, ok: true, removed: r?.removed ?? 0, dropped });
              log(`控制台：已清空 ${key} 的排队消息（DSH inbox 移除 ${r?.removed ?? 0} 条，桥接队列丢弃 ${dropped} 条）`);
            } catch (error) {
              result.push({ key, ok: false, error: error?.message ?? String(error), dropped });
              log(`清空 ${key} 排队失败：${error?.message ?? error}`);
            }
          }
          sendJson({ ok: true, result });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = getSocialV2State(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = getSocialV2State(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.socialV2?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            topicOpen: 'qq_topic_open',
            sendVoice: 'qq_send_voice / qq_list_voices'
          };
          const tools = cfg.socialV2?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            // 机器人自己的身份：agent 需要它才能把「@樰」对到自己身上（issue #29）。
            self: {
              nickname: selfDisplayName || null,
              userId: selfUserId || null,
              line: selfIdentityTextV2().trim() || null
            },
            role: { name: roleState.role ?? null, hint: currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint() },
            recommended: cfg.socialV2?.provideRecommendations === false ? null : {
              wake: cfg.socialV2?.wake ?? {},
              send: cfg.socialV2?.send ?? {},
              wait: cfg.socialV2?.wait ?? {},
              proactive: cfg.socialV2?.proactive ?? {}
            },
            enabledTools,
            replyTiming: replyTimingV2(st),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafetyV2(st.wakeConfig),
            memory: formatMemoryV2(st),
            participation: formatParticipationV2(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: confirmedSlangListV2(),
              block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
            },
            stickers: {
              enabled: cfg.socialV2?.sticker?.enabled !== false,
              total: stickerEntries.length,
              context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
              strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
            },
            // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
            voices: cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
              enabled: true,
              total: voiceLibrary().length,
              names: voiceLibrary().slice(0, 12).map((v) => v.name),
              maxSeconds: voiceCfg().maxSeconds,
              hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
            }
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const afterRaw = url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return;
          }
          const st = getSocialV2State(key);
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const messages = afterSeq === null ? st.unread.slice(-limit)
            : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          const messages = st.recentMessages.slice(start, end);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, messages) : readThroughSeqV2(st);
          sendJson({ ok: true, key, messages, readThroughSeq });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
          if (personaRuntimeEnabled() && req.headers['x-agent-token']) {
            sendJson({ ok: false, error: '系统托管模式下已读由系统处理' }, 403);
            return;
          }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = getSocialV2State(key);
          // 注意：不带 throughSeq 的调用会清空全部未读，这是**有意保留的兼容语义**
          // （旧 preset 与「没有水位」的收尾调用；见 acknowledgeMessagesV2 的注释与
          // test-token-economy 的 legacy 用例）。当前 preset 会明确要求带上 readThroughSeq 水位。
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeMessagesV2(st, throughSeq);
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeableV2(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          markReadCalledKeys.add(key);
          saveSocialV2State();
          log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
          return;
        }
        // 主会话工具 qq_topic_open：接话后被对方回复、且像长话题时，把这个人交给专属话题代理。
        // 只建队列，不把已经处理过的消息再喂一遍（避免话题代理重复回同一条）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/topic/open') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const userId = String(body.userId ?? '').trim();
          const sender = String(body.sender ?? '').trim();
          if (!key || !userId) { sendJson({ ok: false, error: 'key / userId 不能为空' }, 400); return; }
          if (!key.startsWith('group:')) { sendJson({ ok: false, error: '专属话题只在群聊里建立' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('topicOpen')) { sendJson({ ok: false, error: '工具未启用：qq_topic_open' }, 403); return; }
          if (!personaRuntimeEnabled()) { sendJson({ ok: false, error: '当前不是人格代理运行时，专属话题只在该模式可用' }, 403); return; }
          if (devOffActive()) { sendJson({ ok: false, error: '开发者模式完全静默：不建立专属话题' }, 403); return; }
          const role = personaForGroup(key);
          if (!role) { sendJson({ ok: false, error: '该群没有绑定任何人的人格' }, 400); return; }
          const topic = await ensurePersonaTopic(key, userId, sender || `群友 ${userId}`, role);
          appendActivity(`${key} [topic] ${topic.sender} 由主会话建立专属话题（qq_topic_open）`);
          sendJson({
            ok: true,
            key,
            userId,
            topicKey: topic.topicKey,
            sender: topic.sender,
            sessionId: topic.sessionId || '',
            rounds: Number(topic.rounds) || 0,
            note: '专属话题已建立：这个人的后续消息会进入该话题队列，由话题代理处理；主会话不用再管这条话题。'
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          if (personaRuntimeEnabled()) {
            sendJson({ ok: false, error: '人格代理运行时由系统调度：代理不能自行设置潜水/唤醒' }, 403);
            return;
          }
          const st = getSocialV2State(key);
          const throughSeq = requestedReadThroughSeqV2(st, body, !!req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && v2ToolEnabled('markRead');
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              // 只带已知字段（见 WAKE_TRIGGER_KEYS 的说明）；未知键一律丢弃。
              ...pickWakeTriggersV2(inputTriggers, current.triggers),
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
            const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeOnClose ? acknowledgeMessagesV2(st, throughSeq) : 0;
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSocialV2State();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimerV2(key);
          log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: readThroughSeqV2(st), wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
          const list = [];
          for (const [key, st] of socialV2.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (legacyReserved2PathDisabled()) {
            sendJson({ ok: false, error: '人格运行时接管：旧主会话唤醒已停用，任务由系统任务队列调度' }, 409);
            return;
          }
          const st = getSocialV2State(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          // 第一次唤醒必须走 bootstrap：那条 prompt 里带着「二代协议说明 + 操作者为这个会话
          // 预写的初始提示词（群环境/氛围）」。若用手动唤醒的 admin 文案顶掉它，这个会话就
          // 永远拿不到引导 —— 而 bootstrapSent 一旦置真，后续再也不会补发。
          const firstWake = !st.bootstrapSent;
          if (firstWake) st.bootstrapSent = true;
          const effectiveReason = firstWake ? 'bootstrap' : reason;
          saveSocialV2State();
          // 和其它唤醒入口保持一致：sendWakePromptV2 是异步的，这里不 await（不能让 HTTP 回复
          // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
          // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
          // 表面上"唤醒成功"，实际上谁也不知道它失败了。
          void sendWakePromptV2(key, effectiveReason).catch((error) => log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
          log(`控制台：手动唤醒 ${key}（${effectiveReason}${firstWake && reason !== effectiveReason ? `，首次唤醒，请求原因 ${reason} 已升级为 bootstrap` : ''}）`);
          sendJson({ ok: true, key, reason: effectiveReason, requestedReason: reason, firstWake });
          return;
        }
        // 操作者预写的「会话初始提示词」：控制台专用（AI 既读不到也改不了 —— adminOnlyV2Paths）。
        // 内容只在该会话**首次唤醒**（bootstrap）时注入一次，见 buildWakePromptV2。
        if (url.pathname === '/api/socialV2/initial-prompt' && (req.method === 'GET' || req.method === 'POST')) {
          if (req.method === 'GET') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            if (!key) {
              const entries = [...initialPrompts.entries()]
                .map(([entryKey, entry]) => ({
                  key: entryKey,
                  chars: entry.text.length,
                  createdAt: entry.createdAt || 0,
                  updatedAt: entry.updatedAt || 0,
                  preview: entry.text.replace(/\s+/g, ' ').slice(0, 80)
                }))
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
              sendJson({ ok: true, entries, maxChars: initialPromptMaxChars(), writable: initialPromptsWritable });
              return;
            }
            const canonical = canonicalV2Key(key);
            if (!canonical) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            const entry = initialPrompts.get(canonical) ?? null;
            sendJson({
              ok: true,
              key: canonical,
              exists: !!entry,
              text: entry?.text ?? '',
              createdAt: entry?.createdAt || 0,
              updatedAt: entry?.updatedAt || 0,
              maxChars: initialPromptMaxChars(),
              writable: initialPromptsWritable
            });
            return;
          }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const explicitDelete = body.delete === true;
          // 只接受 { key, text: string } 或 { key, delete: true }：
          // 缺 text 时不当作"清空"（否则一次漏字段的调用就把操作者写的内容删了）。
          if (!explicitDelete && typeof body.text !== 'string') {
            sendJson({ ok: false, error: 'text 必须是字符串（留空表示删除），或用 delete:true 显式删除' }, 400);
            return;
          }
          const result = setInitialPrompt(key, explicitDelete ? '' : body.text);
          if (!result.ok) { sendJson({ ok: false, error: result.error }, result.statusCode ?? 400); return; }
          log(`控制台：${result.deleted ? '已删除' : '已保存'}会话初始提示词 ${result.key}${result.deleted ? '' : `（${result.chars} 字符，仅首次唤醒注入）`}`);
          sendJson({
            ok: true,
            key: result.key,
            deleted: result.deleted,
            chars: result.chars,
            exists: !!result.entry,
            updatedAt: result.entry?.updatedAt || 0,
            maxChars: initialPromptMaxChars()
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          // 控制标记（DONE / TOPIC_IRRELEVANT / TOPIC_END）是回合信号，不是聊天内容：
          // 模型偶尔会把收尾信号塞进 messages 发到群里（现场见过群里冒出一条「done」），
          // 这里整行剔除；整组都被剔掉就报错。
          // 注意：这段在两个发送端点（send-burst / send-message）里是同一份逻辑，改一处要同步另一处。
          const cleanMessages = dropControlMarkerMessages(messages);
          if (!cleanMessages.length) {
            log(`[reserved2] 拦截控制标记发送：${key} ${messages.join(' / ').slice(0, 60)}`);
            appendActivity(`${key} 拦截控制标记发送：${messages.join(' / ').slice(0, 40)}`);
            sendJson({ ok: false, error: 'DONE / TOPIC_* 是回合控制标记，不能作为聊天消息发送；要发言请发真正的回复内容' }, 400);
            return;
          }
          if (cleanMessages.length !== messages.length) {
            log(`[reserved2] 已剔除 ${messages.length - cleanMessages.length} 条控制标记：${key}`);
            messages.length = 0;
            messages.push(...cleanMessages);
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const nowSpeech = Date.now();
          const topicSendBypass = Number(personaTopicSendUntil.get(key) || 0) > nowSpeech;
          const personaSpeechGate = personaRuntimeEnabled() && !!personaForGroup(key);
          if (personaSpeechGate && !topicSendBypass && !personaSpeechCanSend(key, nowSpeech)) {
            sendJson({ ok: false, error: '系统本轮未批准主会话发言，已硬性拦截；不要重试，等系统下一次许可' }, 403);
            return;
          }
          if (personaSpeechGate && !topicSendBypass && messages.length > personaSpeechRemaining(key, nowSpeech)) {
            sendJson({ ok: false, error: `本段只剩 ${personaSpeechRemaining(key, nowSpeech)} 条发言次数，不能一次发 ${messages.length} 条` }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            if (personaSpeechGate && !topicSendBypass && sentMessages.length > 0) {
              recordPersonaSpeechSend(key, sentMessages.length);
            }
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 可选：文字发完立刻跟一张收藏表情（同一调用，桥接内部零停顿串起来）。
          const stickerId = String(body.stickerId ?? body.sticker ?? '').trim();
          // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
          // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          // 控制标记（DONE / TOPIC_IRRELEVANT / TOPIC_END）是回合信号，不是聊天内容：
          // 模型偶尔会把收尾信号塞进 messages 发到群里（现场见过群里冒出一条「done」），
          // 这里整行剔除；整组都被剔掉就报错。
          // 注意：这段在两个发送端点（send-burst / send-message）里是同一份逻辑，改一处要同步另一处。
          const cleanMessages = dropControlMarkerMessages(messages);
          if (!cleanMessages.length) {
            log(`[reserved2] 拦截控制标记发送：${key} ${messages.join(' / ').slice(0, 60)}`);
            appendActivity(`${key} 拦截控制标记发送：${messages.join(' / ').slice(0, 40)}`);
            sendJson({ ok: false, error: 'DONE / TOPIC_* 是回合控制标记，不能作为聊天消息发送；要发言请发真正的回复内容' }, 400);
            return;
          }
          if (cleanMessages.length !== messages.length) {
            log(`[reserved2] 已剔除 ${messages.length - cleanMessages.length} 条控制标记：${key}`);
            messages.length = 0;
            messages.push(...cleanMessages);
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const nowSpeech = Date.now();
          const topicSendBypass = Number(personaTopicSendUntil.get(key) || 0) > nowSpeech;
          const personaSpeechGate = personaRuntimeEnabled() && !!personaForGroup(key);
          if (personaSpeechGate && !topicSendBypass && !personaSpeechCanSend(key, nowSpeech)) {
            sendJson({ ok: false, error: '系统本轮未批准主会话发言，已硬性拦截；不要重试，等系统下一次许可' }, 403);
            return;
          }
          if (personaSpeechGate && !topicSendBypass && messages.length > personaSpeechRemaining(key, nowSpeech)) {
            sendJson({ ok: false, error: `本段只剩 ${personaSpeechRemaining(key, nowSpeech)} 条发言次数，不能一次发 ${messages.length} 条` }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            if (personaSpeechGate && !topicSendBypass && sentMessages.length > 0) {
              recordPersonaSpeechSend(key, sentMessages.length);
            }
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            // 文字 + 表情一体发送：文字刚落地就把表情跟上（immediate 不睡眠、不重同步），
            // 免得模型分两次调用中间空 1~2 秒。
            let stickerSent = null;
            let stickerError = null;
            if (stickerId) {
              try {
                const s = await sendStickerV2(key, stickerId, { immediate: true });
                stickerSent = { id: s.entry?.id ?? null, messageId: s.messageId ?? null };
                log(`[reserved2] ${key} 文字+表情同时发送（表情 ${stickerSent.id ?? stickerId}）`);
                appendActivity(`${key} [reserved2] 文字+表情同时发送`);
              } catch (error) {
                stickerError = String(error?.message ?? error);
                log(`[reserved2] 表情随文字发送失败 (${key}): ${stickerError}`);
              }
            }
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(stickerSent ? { sticker: stickerSent } : {}), ...(stickerError ? { stickerError } : {}), ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
          if (kind === 'group') {
            const memberError = await assertGroupMember(id, targetUserId);
            if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          // 成员校验是异步的（要问 OneBot）；期间操作者可能切模式/改白名单/开静默。
          // 拍一拍此前完全没有发送守卫，这里补上：真正发之前再确认一次。
          const sendGuard = captureSendGuard(key);
          try {
            sendGuard();
            if (devModeEnabled()) {
              // 拍一拍也是 QQ 出站动作：同样在终端拦截，代理拿到的仍是成功
              devInterceptSend('poke', key, targetUserId ? `@${targetUserId}` : '');
            } else if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
          }
          return;
        }
        // ── 表情包体系（reserved2） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            const prep = await toModelMedia(fetched.buffer, mimeType, `收藏表情 ${entry.id}`);
            if (!prep.ok) {
              sendJson({ ok: false, error: `表情图片无法提供给模型：${prep.error}` }, 413);
              return;
            }
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType: prep.mimeType, data: prep.buffer.toString('base64') },
              ...(prep.note ? { note: prep.note } : {})
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
          const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = mimeFromBuffer(buf) || 'image/png';
            sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 语音发送（操作者通道：CLI / 控制台，凭 consoleToken） ──────────────
        //
        // 与 /api/send/* 的 agent 通道分开：操作者可能不在任何 QQ 会话里，
        // 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少。
        if (req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')) {
          const body = await readBody();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const voice = voiceCfg();
          // 注意：这里是**操作者通道**（CLI / 控制台面板 / 图形界面），由控制台令牌鉴权。
          // socialV2.voice.enabled 是「AI 能不能发语音」的总闸，不该连你手动试发一起关掉——
          // 否则"默认不启用"会变成"谁都发不了"，连放音频试一下都做不到。
          // AI 通道的开关在 /api/socialV2/send-voice 里单独判定。
          // /api/send/voice 是 AI 工具入口：带 agent token 时一律按 agent 规则走，
          // 避免 AI 借用操作者通道绕过「只能发自己会话」的限制。
          if (url.pathname === '/api/send/voice' && agentToken) {
            sendJson({
              ok: false,
              error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）'
            }, 403);
            return;
          }
          const key = String(body.target ?? body.key ?? '').trim();
          const parsedTarget = parseTargetKey(key);
          if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, currentMode)) {
            const a = cfg.allow ?? {};
            sendJson({
              ok: false,
              error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
            }, 403);
            return;
          }
          let resolved;
          try {
            resolved = resolveVoicePathForOperator(body.file ?? body.path ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
          try {
            resolveAudioProcessing({
              volume: body.volume ?? voice.defaultVolume,
              normalize: body.normalize === true,
              loudness: body.loudness ?? voice.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error.message }, 400);
            return;
          }
          const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
          if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
          const preview = {
            key,
            file: resolved.path,
            via: resolved.via,
            bytes: probe.size,
            duration: probe.duration,
            codec: probe.codec,
            detail: describeAudio(probe),
            warnings: probe.warnings ?? [],
            limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
          };
          if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return; }
          const now = Date.now();
          try {
            voiceBudgetCheck('operator:cli', voice);
            const sent = await sendVoiceV2(key, resolved.path, {
              guard: false,
              audit: true,
              audio: {
                volume: body.volume ?? voice.defaultVolume,
                normalize: body.normalize === true,
                loudness: body.loudness ?? voice.loudness
              }
            });
            voiceBudgetCommit('operator:cli', now);
            log(`[voice] (操作者) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
            appendActivity(`${key} [voice] (操作者) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
            // CLI 默认要落地校验（--verify 之外也能给出可信证据）；readback 仅在做"收到的语音"实验时用。
            const verification = body.verify === false ? null : await verifyVoiceMessageSent(sent.messageId);
            let readbackText = null;
            if (body.readback === true && sent.messageId) {
              try {
                const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
                const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
                  },
                  body: JSON.stringify({ message_id: String(sent.messageId) }),
                  signal: AbortSignal.timeout(30000)
                });
                const rb = await res.json().catch(() => ({}));
                if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
              } catch (error) {
                log(`[voice] 转写回读失败：${error?.message ?? error}`);
              }
            }
            sendJson({
              ok: true,
              ...preview,
              messageId: sent.messageId,
              verified: verification?.confirmed === true,
              readback: readbackText,
              audioProcessing: sent.audioProcessing,
              volume: sent.volume,
              loudness: sent.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 语音发送（AI 通道：reserved2 + agent token，只能发自己那个会话） ────
        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const voice = voiceCfg();
          if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
          let resolved;
          try {
            resolved = resolveVoicePathForV2(body.voice ?? body.file ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          try {
            voiceBudgetCheck(key, voice);
            if (body.dryRun === true) {
              const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
              if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
              // 只回文件名：绝对路径等于把本机目录结构交给模型（voices 接口早已按这个口径脱敏）
              sendJson({ ok: true, dryRun: true, key, file: path.basename(resolved.path), detail: describeAudio(probe) });
              return;
            }
            const sent = await sendVoiceForV2(key, body.voice ?? body.file, {
              label: body.label ? String(body.label).slice(0, 100) : '',
              verify: body.verify,
              readback: body.readback === true,
              // AI 也可以调音量（默认走 config 的 defaultVolume）
              audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
                ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
                : null
            });
            sendJson({
              ok: true,
              key,
              messageId: sent.messageId,
              file: path.basename(sent.file),
              detail: sent.detail,
              audioProcessing: sent.audioProcessing,
              // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
              verified: sent.verification?.confirmed === true,
              readback: sent.readback,
              warnings: sent.warnings
            });
          } catch (error) {
            // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const nowSpeech = Date.now();
          const topicSendBypass = Number(personaTopicSendUntil.get(key) || 0) > nowSpeech;
          const personaSpeechGate = personaRuntimeEnabled() && !!personaForGroup(key);
          if (personaSpeechGate && !topicSendBypass && !personaSpeechCanSend(key, nowSpeech)) {
            sendJson({ ok: false, error: '系统本轮未批准主会话发言，已硬性拦截；不要重试，等系统下一次许可' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            if (personaSpeechGate && !topicSendBypass) recordPersonaSpeechSend(key);
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音库列表。两条通道共用：
        //   - 带 agent token（AI 的 qq_list_voices）→ 必须带 key，校验会话白名单/工具开关；
        //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
        // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
        if (req.method === 'GET' && (url.pathname === '/api/socialV2/voices' || url.pathname === '/api/voice/list')) {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const voice = voiceCfg();
          const agentCall = Boolean(req.headers['x-agent-token']);
          // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
          if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          const wantProbe = url.searchParams.get('probe') !== '0';
          try {
            const files = listAudioFiles(voice.dir);
            const items = [];
            for (const f of files.slice(0, 100)) {
              const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
              if (wantProbe) {
                const info = await inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
                entry.ok = info.ok;
                entry.bytes = info.size;
                entry.detail = info.ok ? describeAudio(info) : null;
                entry.seconds = info.duration ?? null;
                if (!info.ok) entry.error = info.error;
              }
              items.push(entry);
            }
            sendJson({
              ok: true,
              key: key || null,
              dir: agentCall ? undefined : voice.dir,
              count: items.length,
              voices: items,
              limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
              // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
              // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
              hint: items.length
                ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
                : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
          // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
          // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
          const force = false;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
          let force = body.refresh === true;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - lastForcedAgentStickerSync < 10000) force = false;
            else lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await syncStickerLibrary(false);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false, writable: stickerStoreWritable });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteV2(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          if (personaRuntimeEnabled() && req.headers['x-agent-token']) {
            sendJson({ ok: false, error: '系统托管模式下不需要等待：任务会由系统推送' }, 403);
            return;
          }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
            sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
            return;
          }
          const replyWait = body.purpose === 'reply';
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSocialV2State(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 租约按**归一后的** key 记账：`group:0123` 与 `group:123` 是同一个会话，
          // 用原始 key 会给出两个租约槽（同一会话并发多个 5~10 分钟等待、互相踩水位）。
          // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
          const leaseKey = canonicalV2Key(key) ?? key;
          if (activeWaits.has(leaseKey) && Date.now() - activeWaits.get(leaseKey) < ACTIVE_WAIT_LEASE_MS) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          const leaseStamp = Date.now();
          activeWaits.set(leaseKey, leaseStamp);
          // 只由「自己那一份租约」负责删除：超时接管后，旧等待结束时不能把新租约删掉。
          const finishWait = () => { if (activeWaits.get(leaseKey) === leaseStamp) activeWaits.delete(leaseKey); };
          req.on('close', finishWait);
          // 响应关闭也兜底清租约：handler 中途抛错时由外层 catch 回一个 JSON，
          // 那条路径不会经过下面的 finishWait()，会留下 15 分钟的假 429。
          res.on('close', finishWait);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          // A reply wait must also include messages received while the model
          // was reading/thinking after its snapshot, before this HTTP request.
          const requestSeq = st.lastUnreadSeq || 0;
          const baseline = replyWait && (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent')) ? readThroughSeqV2(st) : requestSeq;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          if (replyWait) {
            const incomingAt = () => {
              const value = Number(st.lastIncomingAt);
              return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
            };
            lastNewAt = incomingAt();
            let observedSeq = st.lastUnreadSeq || 0;
            // Batch delay and model reading time already count towards quiet.
            // New arrivals restart quiet, but timeoutMs remains a hard budget.
            while (!aborted && Date.now() - start < timeoutMs) {
              if ((st.lastUnreadSeq || 0) !== observedSeq) {
                observedSeq = st.lastUnreadSeq || 0;
                lastNewAt = incomingAt();
              }
              const remaining = quietMs - (Date.now() - lastNewAt);
              if (remaining <= 0) break;
              await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
            }
            // A message may arrive during the final sleep, exactly at timeout.
            // Its timestamp must still invalidate the previous quiet window.
            lastNewAt = incomingAt();
            arrived = (st.lastUnreadSeq || 0) > baseline;
          } else while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
              (req.headers['x-agent-token'] && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
                || !agentTokenOk(key, req.headers['x-agent-token']) || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
            finishWait();
            sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
            return;
          }
          const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
          // 闸门状态只算一次：既用于 preSleepWaitRemainingMs，也用于下面直接告诉模型"现在能不能收尾"。
          const preSleepBlocked = preSleepWaitBlockedV2(st);
          const preSleepRemainingMs = preSleepBlocked
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          // 这次等待「算不算沉睡前观察」：闸门只认单次 timeoutMs ≥ 观察窗口的调用。
          // 实测踩过：模型用 timeoutMs=90000 等了 90 秒，以为完成了观察，结果闸门不认，
          // 只能再补一次 180 秒 —— 白花一轮。所以要在返回里把这件事说破，而不是让它自己悟。
          const preSleepCountsAsObservation = !replyWait && timeoutMs >= preSleepWaitMs;
          const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !replyWait && (!arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait && !arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait) {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          if (!replyWait) saveSocialV2State();
          // Each buffer is governed by its own tool switch: the unread buffer by
          // getUnread, the recent buffer by getRecent. A disabled switch must not leak
          // through either newMessages or the watermark, so the buffer is dropped
          // before arrival is judged -- not filtered afterwards.
          const history = replyWait
            ? [...(v2ToolEnabled('getUnread') ? st.unread : []),
              ...(v2ToolEnabled('getRecent') ? st.recentMessages : [])]
            : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
          // ── 漏消息窗口（2026-10-18 修）──────────────────────────────────
          //
          // 旧实现按 `seq > baseline` 取"本次等待期间新到的"，而 baseline 对普通等待是
          // **请求开始时的 lastUnreadSeq**。于是「模型思考/发消息那几秒里到达的消息」
          // 永远落在窗口外：本次不返回、下次请求的 baseline 已经越过它们 ⇒ 既没展示给模型，
          // 也没进 readThroughSeq（连续游标）⇒ 水位从此卡死。
          // 实测：会话末段 readThroughSeq 钉在 185，可模型已经看过 205，
          // 之后每次等待都要多读一次 unread 才能收尾；期间有人 @ 也完全没进本回合。
          //
          // 现在按**已读过水位**取：凡是没有进入 readThroughSeq 的消息，一律补给它。
          // `arrived` 仍按 requestSeq 判（"有没有新动静"语义不变），所以等待不会变成忙轮询；
          // 只要这次确实返回了，返回的就是「从水位起连续的一段」，模型据此能正常推进水位。
          const watermarkAtRequest = readThroughSeqV2(st);
          const pendingFloor = Math.min(baseline, watermarkAtRequest);
          const fullPending = [...new Map(history
            .filter((m) => m && !m.isSelf && (m.seq || 0) > pendingFloor)
            .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
          // 有上限：一次倒 30 条旧账会把上下文挤爆。**必须从最老的开始取**（连续，
          // 水位才推得动）；被截断时 partial=true，提示模型用 unread 工具续读。
          const waitCap = Math.min(50, Math.max(12, Number(cfg.socialV2?.context?.unreadLimit) || 30));
          const pending = fullPending.length > waitCap ? fullPending.slice(0, waitCap) : fullPending;
          const pendingTruncated = fullPending.length > pending.length;
          // `arrived` is recomputed against what this request may actually hand over,
          // so a suppressed buffer cannot report an arrival it is not allowed to show.
          const newMessages = replyWait ? pending : (arrived ? pending : []);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
            : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            purpose: replyWait ? 'reply' : 'messages',
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
            // 补发被上限截断时告诉模型「还有更老的没给」，它才知道要用 unread(afterSeq=readThroughSeq) 续读。
            ...(pendingTruncated ? { partial: true } : {}),
            // A reply check has no sleep countdown; showing one here suggests
            // the model should complete sleep observation before its first reply.
            ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
            // ── 直接说「现在能不能收尾、该怎么收」 ────────────────────────────
            //
            // 为什么不能只给 preSleepWaitRemainingMs 让模型自己解读：实测它会用一次
            // timeoutMs=90000 的等待去凑 180 秒的观察窗口（闸门根本不认），然后再补一次 180 秒，
            // 白花一轮。这里把闸门的判断结果和**该发的参数**直接写给它，
            // 并且**只在闸门真的放行时**才说「可以收尾」——绝不诱导它提前设置潜水
            // （那会被桥接 400 拒绝，反而更慢）。
            ...(!replyWait ? {
              canSleepNow: !preSleepBlocked,
              countsAsObservation: preSleepCountsAsObservation,
              hint: preSleepBlocked
                ? `还不能收尾：还需约 ${Math.ceil(preSleepRemainingMs / 1000)} 秒没有新消息。要完成沉睡前观察，请用 qq_wait_for_messages(timeoutMs=${preSleepWaitMs}) 一次等满——更短的 timeoutMs 不算观察，满足不了闸门（本次 ${Math.round(timeoutMs)}ms ${preSleepCountsAsObservation ? '达标' : '不达标'}）。`
                : '现在可以直接收尾：qq_mark_read(throughSeq=已读水位) 或 qq_set_wake_config(throughSeq=已读水位, config=…)。不用再等一轮。'
            } : {}),
            newMessages,
            readThroughSeq,
            unreadCount: st.unread.length
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
        // 路径刻意不放在 /api/socialV2/ 下：那一整个前缀对持有 x-agent-token 的
        // QQ 侧 AI 是放行的（见上方 agentAllowed 白名单），而跨群花费属于管理信息，
        // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
        if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
            const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
            sendJson(tokenLedger.series({ hours, maxBuckets }));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            const detail = tokenLedger.conversation(key, { turnLimit: limit });
            if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
            sendJson(detail);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
            sendJson({ ok: true, symbol: priceTable.symbol, entries: tokenLedger.recent(limit) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
            tokenLedger.reset();
            log('控制台：token 用量账本已重置');
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: 'not found' }, 404);
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
          const message = truncateText(rawMessage, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = getSocialV2State(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine, readThroughSeq: readThroughSeqV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSocialV2State(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
            if (info) info.textTruncated = String(info.text ?? '').length >= 200;
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          if (!agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!v2ToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSocialV2State(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
          const st = getSocialV2State(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        // ── 群成员列表（v2 读工具；替代只有 closed-agent 才能用的旧只读工具）────────
        //
        // 为什么需要这一条：qq-chat-v2 预设第 6 条明确要求「QQ 号从 qq_get_group_members 的
        // user_id 拿」，但旧版是无令牌工具、在 reserved2 下必然 403 —— 模型被自己的提示词
        // 引到一个永远失败的工具上（实测 turn10 白烧一步）。这里给它一个带会话令牌的 v2 形态。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/group-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const groupMatch = /^group:(\d+)$/.exec(key);
          if (!groupMatch) { sendJson({ ok: false, error: '群成员只能按 group:群号 查询' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          // ⚠️ 白名单/模式判定**不能**挂在「有令牌」条件里：closed-agent 的代理调用本来就不带令牌
          // （它走的是操作者路径），只按 header 判断会让它拿任意群号去枚举成员 ——
          // 那正是旧 qq_get_group_members 明确防住的事（先 legacyReadToolAllowed 再 isAllowed）。
          //
          // 也不能直接用 v2SessionAllowed：它的 closed-agent 分支只放行 `private:<ownerQQ>`，
          // 于是「管理员在私聊里让 AI 看看某群成员」会 403 —— 那是旧工具本来支持的能力，
          // 属于这次改动不该带走的回归。所以 closed-agent 下按**同样严格的白名单**放行群读取。
          const groupMembersAllowed = currentMode === 'closed-agent'
            ? allowed('group', Number(groupMatch[1]), cfg)
            : v2SessionAllowed(key);
          if (!groupMembersAllowed) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('getGroupMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_group_members' }, 403); return; }
          const groupId = Number(groupMatch[1]);
          try {
            let response;
            try {
              response = await bot.request('get_group_member_list', { group_id: groupId });
            } catch (wsError) {
              // 与表情库同步同一条原则：WS 挂了不代表网关挂了，读接口走 HTTP 兜底。
              response = await onebotHttpAction('get_group_member_list', { group_id: groupId });
            }
            const payload = response && typeof response === 'object' && response.data !== undefined ? response.data : response;
            const raw = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : null);
            if (!raw) { sendJson({ ok: false, error: '网关返回的成员列表格式异常，已拒绝' }, 502); return; }
            const members = raw.slice(0, limit).map((m) => ({
              userId: m?.user_id != null ? String(m.user_id) : '',
              nickname: truncateText(String(m?.nickname ?? ''), 40),
              card: truncateText(String(m?.card ?? ''), 40),
              ...(m?.role ? { role: String(m.role) } : {})
            })).filter((m) => m.userId);
            sendJson({ ok: true, key, count: raw.length, returned: members.length, truncated: raw.length > members.length, members });
          } catch (error) {
            log(`群成员查询失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `获取群成员失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          const st = getSocialV2State(key);
          appendMemoryV2(st, category, content, extra);
          sendJson({ ok: true, key, category, content, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            // 必须命中**已有**条目（own property）：否则任意 target 都能凭空建一条，
            // 而 'toString'/'valueOf' 这类名字会从 Object.prototype 上取到继承来的函数，
            // 往函数对象上写 traits —— JSON.stringify 又会把它整个丢掉（静默数据丢失）。
            if (!Object.prototype.hasOwnProperty.call(st.memberImpressions, oldTarget)) {
              sendJson({ ok: false, error: '找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）' }, 404);
              return;
            }
            const im = st.memberImpressions[oldTarget];
            const newTarget = String(cleanNewExtra.target || oldTarget).trim().slice(0, 64);
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
            // 与控制台/AI 的 append 路径保持一致：条目数上限 50，超了按 lastSeenAt 淘汰最旧，
            // 否则 memory-update 能无限塞名字（每次 1MB 请求 → 状态文件与每轮 prompt 一起膨胀）。
            const impressionEntries = Object.entries(st.memberImpressions);
            if (impressionEntries.length > 50) {
              impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
              for (let i = 0; i < impressionEntries.length - 50; i += 1) delete st.memberImpressions[impressionEntries[i][0]];
            }
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          const st = getSocialV2State(key);
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          sendJson({ ok: true, key, category, formatted: formatMemoryV2({ ...st, ...raw }), raw });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          const st = getSocialV2State(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          }
          saveSocialV2State();
          sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          const st = getSocialV2State(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          saveSocialV2State();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
          return;
        }
        // ── 二代黑话学习（reserved2）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
          const list = confirmedSlangListV2().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8)
          });
          return;
        }

        // ── 二代「记忆检索」（reserved2）：需要更多记忆时自查 ───────────────
        // 一次查询同时覆盖：知识库（向量/关键词）、已确认黑话、当前会话的轻量记忆。
        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const agentToken = req.headers['x-agent-token'];
          if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentToken && !v2ToolEnabled('memorySearch')) { sendJson({ ok: false, error: '工具未启用：qq_memory_search' }, 403); return; }
          if (!q) { sendJson({ ok: true, key, q, total: 0, hits: [], hint: 'q 为空，未检索' }); return; }
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('k') ?? 8) || 8));
          const hits = [];
          // ① 知识库（已审核）：向量优先，embedding 不可用时自动退关键词
          try {
            const knowledgeHits = await knowledgeStore.search(q, { k: limit, key, timeoutMs: Number(cfg.knowledge?.searchTimeoutMs ?? 1500) });
            for (const hit of dropSelfOnlyMemoryHits(knowledgeHits)) {
              hits.push({ source: 'knowledge', text: hit.text, score: hit.score, mode: hit.mode, tags: hit.tags ?? [] });
            }
          } catch (error) {
            log(`记忆检索：知识库查询失败：${error?.message ?? error}`);
          }
          // ② 已确认黑话：按词条/含义/用法/示例做子串与二元组匹配
          const qLower = q.toLowerCase();
          const slangHits = confirmedSlangListV2()
            .map((e) => {
              const hay = `${e.content} ${e.meaning} ${e.usage} ${e.example}`.toLowerCase();
              let score = 0;
              if (e.content && qLower.includes(e.content.toLowerCase())) score += 5;
              if (hay.includes(qLower)) score += 3;
              return { e, score };
            })
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
          for (const { e, score } of slangHits) {
            hits.push({ source: 'slang', text: `黑话「${e.content}」：${e.meaning || ''}${e.usage ? `；用法：${e.usage}` : ''}`, score, mode: 'keyword', tags: ['黑话'] });
          }
          // ③ 当前会话的轻量记忆
          const st = getSocialV2State(key);
          const memoryBits = [];
          for (const t of Array.isArray(st.activeTopics) ? st.activeTopics : []) if (t?.text) memoryBits.push(`话题：${t.text}${t.pendingQuestion ? `（待追问：${t.pendingQuestion}）` : ''}`);
          for (const t of Array.isArray(st.pendingThoughts) ? st.pendingThoughts : []) if (t?.text) memoryBits.push(`想说未说：${t.text}`);
          for (const [name, im] of Object.entries(st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {})) {
            const traits = Array.isArray(im?.traits) ? im.traits.join('、') : '';
            if (traits) memoryBits.push(`印象：${name} — ${traits}`);
          }
          for (const text of memoryBits) {
            if (text.toLowerCase().includes(qLower)) hits.push({ source: 'memory', text, score: 2, mode: 'keyword', tags: ['记忆'] });
          }
          hits.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
          sendJson({ ok: true, key, q, total: hits.length, hits: hits.slice(0, limit), mode: hits[0]?.mode ?? (knowledgeEmbedder.enabled ? 'vector' : 'keyword') });
          return;
        }

        // ── 二代知识库（reserved2）：AI 检索已审核知识 + 提议新条目 ─────────────
        // 与黑话同一套路：只读检索是「拿知识」，提议是「写 pending」，批准永远在控制台。
        if (url.pathname === '/api/socialV2/knowledge/query' || url.pathname === '/api/socialV2/knowledge/propose') {
          const isQuery = url.pathname.endsWith('/query');
          const body = isQuery ? {} : await readBody();
          const key = String(isQuery ? url.searchParams.get('key') : body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const agentToken = req.headers['x-agent-token'];
          if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentToken && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentToken && !v2ToolEnabled(isQuery ? 'knowledgeSearch' : 'knowledgePropose')) {
            sendJson({ ok: false, error: `工具未启用：${isQuery ? 'qq_knowledge_search' : 'qq_knowledge_propose'}` }, 403);
            return;
          }
          if (cfg.knowledge?.enabled === false) { sendJson({ ok: false, error: '知识库已关闭' }, 403); return; }
          if (isQuery) {
            const q = String(url.searchParams.get('q') ?? '').trim();
            if (!q) { sendJson({ ok: true, key, hits: [], hint: 'q 为空，未检索' }); return; }
            const hits = await knowledgeStore.search(q, {
              k: Math.min(10, Math.max(1, Number(url.searchParams.get('k') ?? 5) || 5)),
              key,
              timeoutMs: Number(cfg.knowledge?.searchTimeoutMs ?? 1500)
            });
            const filtered = dropSelfOnlyMemoryHits(hits);
            if (filtered.length) knowledgeStore.touch(filtered.map((hit) => hit.id));
            const stats = knowledgeStore.stats();
            sendJson({
              ok: true,
              key,
              total: stats.approved,
              hits: filtered,
              mode: filtered[0]?.mode ?? (knowledgeEmbedder.enabled ? 'vector' : 'keyword'),
              hint: stats.approved === 0 ? '知识库还没有已审核条目：遇到值得长期记住的事实，用 qq_knowledge_propose 提议，等管理员批准后才会出现在这里。' : undefined
            });
            return;
          }
          if (cfg.knowledge?.allowPropose === false) { sendJson({ ok: false, error: '知识库提议已关闭（控制台：知识库 → 允许 AI 提议）' }, 403); return; }
          const result = knowledgeStore.add({
            text: body.text,
            tags: body.tags,
            source: body.source === 'web' ? 'web' : 'chat',
            group: key,
            private: body.private === true,
            proposedBy: key,
            note: String(body.note ?? '')
          });
          if (!result.ok && result.duplicate) {
            sendJson({ ok: true, duplicate: true, id: result.id, status: result.status, message: '这条知识已经存在（可能在待审队列里）' });
            return;
          }
          if (result.ok) {
            const stats = knowledgeStore.stats();
            log(`知识库：${key} 提议一条待审条目（当前待审 ${stats.pending} 条）`);
            // 攒够阈值就顺手跑一轮（run 内部判断，不够阈值立刻返回）
            void knowledgeApprover.run().catch((error) => log(`自动批准代理运行失败：${error?.message ?? error}`));
          }
          sendJson(result.ok
            ? { ok: true, id: result.item.id, status: result.item.status, pending: knowledgeStore.stats().pending, message: '已进入待审队列，管理员批准后才会被用到' }
            : result, result.ok ? 200 : 400);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          const existing = slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
              return;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            saveSlangStore();
            if (cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                queueSlangTask(() => runSlangResearch([existing]));
              }
            }
            log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
            return;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          if (cfg.slang?.autoResearch !== false) {
            queueSlangTask(() => runSlangResearch([entry]));
          }
          log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
          appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: publicSlangEntry(entry) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!token || !agentTokenOk(key, token)) {
            // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
            // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
            // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
            sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'reserved2' && !agentToken) {
            sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = unquoteJsonString(String(body.message ?? '').trim());
          // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
          // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
          // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const stickerId = String(body.stickerId ?? body.sticker ?? '').trim();
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用。
          if (socialV2.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          // 主会话硬闸门：系统没标记本轮/本段可以发言时，模型即使调用发送工具也发不出去。
          // 专属话题代理用同一会话 key，但话题运行期间由系统放行。
          const nowSpeech = Date.now();
          const topicSendBypass = Number(personaTopicSendUntil.get(key) || 0) > nowSpeech;
          const personaSpeechGate = !!token && currentMode === 'reserved2' && personaRuntimeEnabled() && !!personaForGroup(key);
          if (personaSpeechGate && !topicSendBypass && !personaSpeechCanSend(key, nowSpeech)) {
            sendJson({ ok: false, error: '系统本轮未批准主会话发言，已硬性拦截；不要重试，等系统下一次许可' }, 403);
            return;
          }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          // st/now 必须声明在 try **之外**：下面的 catch 要用它们回滚预占的发送额度。
          // 写在 try 里时 catch 拿到的是块作用域外的名字 ⇒ ReferenceError（send-burst
          // 曾整段踩过同型问题，见体检报告 #1 / R2）。后果不是"少一行日志"，而是
          // 失败响应变成「st is not defined」、额度不回滚（接下来一分钟全是假 429），
          // 且部分成功的已发消息不会被记进 recentMessages。
          const st = getSocialV2State(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            if (personaSpeechGate && !topicSendBypass && sentMessages.length > 0) {
              recordPersonaSpeechSend(key, sentMessages.length);
            }
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            let stickerSent = null;
            let stickerError = null;
            if (stickerId) {
              try {
                const s = await sendStickerV2(key, stickerId, { immediate: true });
                stickerSent = { id: s.entry?.id ?? null, messageId: s.messageId ?? null };
                log(`[send] ${key} 文字+表情同时发送（表情 ${stickerSent.id ?? stickerId}）`);
              } catch (error) {
                stickerError = String(error?.message ?? error);
                log(`[send] 表情随文字发送失败 (${key}): ${stickerError}`);
              }
            }
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo, ...(stickerSent ? { sticker: stickerSent } : {}), ...(stickerError ? { stickerError } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, 1 - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          sessionEpoch++;
          const oldSessionId = state.sessions[key];
          delete state.sessions[key];
          modelAppliedSessions.delete(oldSessionId);
          // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
          delete state.sessionPolicies[key];
          reverse.delete(oldSessionId);
          collectors.delete(oldSessionId);
          sendToolSucceededSessions.delete(oldSessionId);
          pendingSendToolCalls.delete(oldSessionId);
          v2TurnStartAt.delete(oldSessionId);
          turnLeaseNoted.delete(oldSessionId);
          toolCallNames.delete(oldSessionId);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          social.silentTurns.delete(oldSessionId);
          social.exitingSessions.delete(oldSessionId);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
          try { await withTimeout(api.stopSessionWork(oldSessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: oldSessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
          sendJson({ ok: true, key, archived: oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          sessionEpoch++;
          let archivedCount = 0;
          let stoppedCount = 0;
          try {
            // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
            // 只处理 cwd 位于 qq-bridge state/ 下的根会话；子代理会话由父会话管理，不能误归档。
            const list = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
            const stateDir = path.resolve(STATE_DIR);
            const statePrefix = path.normalize(stateDir + path.sep);
            const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
            const isUnderState = (cwd) => process.platform === 'win32'
              ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
              : cwd.startsWith(statePrefix);
            for (const item of list.items ?? []) {
              if (item.origin === 'subagent' || item.parentSessionId) continue;
              const cwd = normPath(item.cwd);
              if (isUnderState(cwd)) {
                // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
                try { await withTimeout(api.stopSessionWork(item.sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); stoppedCount += 1; }
                catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
                try { await withTimeout(api.workspace.archiveSession({ sessionId: item.sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); archivedCount += 1; } catch {}
              }
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          slangWindows.clear();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          cancelAllSocialTimers();
          clearAllSocialV2Timers();
          // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
          socialV2.conversations.clear();
          CONVERSATION_TOKENS.clear();
          KNOWN_AGENT_TOKENS.clear();
          saveSocialV2State();
          state.sessions = {};
          state.sessionPolicies = {};
          reverse.clear();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          v2TurnStartAt.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount, stoppedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            log('控制台：重启桥接');
            // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
            // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
            try { saveState(); } catch (error) { log('重启前保存会话映射失败:', error?.message ?? error); }
            try { saveSocialV2State(); } catch (error) { log('重启前保存二代会话状态失败:', error?.message ?? error); }
            try { fs.writeFileSync(HOT_RELOAD_FLAG, String(Date.now())); } catch (error) { log('写热重载标记失败:', error?.message ?? error); }
            releaseLock();
            process.exit(0);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    // 长轮询连接会一直挂着；本机任意进程开几百条就能把 fd 吃光，给个上限
    server.maxConnections = 64;
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）

  // emoji / 颜文字 / 表情符号字符：发送前统一剥掉。
  // 为什么必须放在这一层：reserved2 模式下模型自己用 MCP 工具发言，MCP 又把请求转给
  // 桥接的 /api/send/*，所以这里是唯一能对「模型实际发出什么」硬生效的地方。
  // 只在提示词里劝是不够的——21:17 那条回复就带着 🐟 发了出去。
  const EMOJI_STRIP_RE = new RegExp(
    '[\\p{Extended_Pictographic}\\p{Emoji_Presentation}\\u{1F1E6}-\\u{1F1FF}\\u{1F3FB}-\\u{1F3FF}\\uFE0F\\u200D\\u20E3]',
    'gu'
  );
  function stripEmojiForQQ(input) {
    const original = String(input ?? '');
    const stripped = original
      .replace(EMOJI_STRIP_RE, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+(?=\n)/g, '')
      .trim();
    if (stripped !== original.trim()) {
      log(`已剥掉 emoji：${original.trim().slice(0, 40)} → ${stripped || '（空）'}`);
    }
    return stripped;
  }

  /**
   * 开发者模式：**链路终点拦截**。
   * 只在这里停——上层（MCP 工具、人格分支、问候任务）拿到正常的成功返回，代理完全不知道
   * 消息被拦；中间数据、状态、日志照常流转，回合能按时收尾。日志写在 bridge.log。
   */
  function devInterceptSend(action, target, detail = '') {
    const extra = String(detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    log(`[dev] 拦截发送 ${action} -> ${target}${extra ? '：' + extra : ''}（${devPolicyLabel()}，未真正发出）`);
  }

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = stripEmojiForQQ(redactKnownTokensOnly(msg));
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg).filter((part) => String(part).trim() !== '');
    if (parts.length === 0) {
      log(`QQ 发送跳过（内容为空或只剩 emoji）(${key})`);
      return sendChain;
    }
    lastSendFailed.delete(key);
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          if (devModeEnabled()) {
            devInterceptSend(kind === 'private' ? 'send_private_msg' : 'send_group_msg', key, part);
            return;
          }
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => {
          lastSendFailed.set(key, true);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendChain;
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
    // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
    // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
    // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
    // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
    const PLACEHOLDER_ANY = /\u0000URL\d+\u0000/;
    const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
    /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
    const splitByPlaceholder = (tok) => {
      const parts = [];
      let last = 0;
      let m;
      PLACEHOLDER_ALL.lastIndex = 0;
      while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
        if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
        parts.push({ text: m[0], isPlaceholder: true });
        last = m.index + m[0].length;
      }
      if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
      return parts;
    };
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (const piece of splitByPlaceholder(tok)) {
          // 占位符整块输出；普通文本仍按 safeMax 切
          if (piece.isPlaceholder) { out.push(piece.text); continue; }
          for (let i = 0; i < piece.text.length;) {
            let end = Math.min(i + safeMax, piece.text.length);
            // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
            // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
            // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
            // 宁可硬切也要保证循环一定前进。逻辑内联在此，函数保持自包含
            // —— test-voice.mjs 会把这个函数的源码单独 eval 出来测。
            if (end < piece.text.length && end - i > 1) {
              const last = piece.text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end -= 1;
            }
            out.push(piece.text.slice(i, end));
            i += end > i ? end - i : safeMax;
          }
        }
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    // 分条路径不经过 sendToQQ，emoji 过滤必须在这里再做一次。
    const prepared = messages
      .map((m) => stripEmojiForQQ(redactKnownTokensOnly(m)))
      .filter((m) => String(m ?? '').trim() !== '');
    if (prepared.length === 0) {
      log(`QQ 分条发送跳过（内容为空或只剩 emoji）(${key})`);
      return sendChain;
    }
    const sent = [];
    for (let i = 0; i < prepared.length; i++) {
      const msg = prepared[i];
      const isLast = i === prepared.length - 1;
      sendChain = sendChain
        .then(async () => {
          if (devModeEnabled()) {
            devInterceptSend(kind === 'private' ? 'send_private_msg' : 'send_group_msg', key, msg);
            sent.push(msg);
            return;
          }
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    if (devModeEnabled()) {
      devInterceptSend('send_msg', `${kind}:${id}`, message);
      return { message_id: 0, message_seq: 0 };
    }
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  /**
   * 文字 + 图片放在同一条消息的 segments 里：QQ 侧表现为同一个气泡（图片卡片 + 文字）。
   * 和 onebotSend 分开是因为后者只发纯文本；这里不做 CQ 拼接，直接传消息段给 OneBot。
   */
  async function onebotSendRich(kind, id, { text = '', imagePath = '', replyToMessageId = null, atUserId = null } = {}) {
    if (devModeEnabled()) {
      devInterceptSend('send_msg', `${kind}:${id}`, text || (imagePath ? `[图片 ${path.basename(imagePath)}]` : ''));
      return { message_id: 0, message_seq: 0 };
    }
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawText = String(text ?? '');
    if (rawText.trim()) {
      const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((token) => token && rawText.includes(token));
      if (hasKnownToken) {
        log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
        throw new Error('发送内容包含会话令牌，已阻止发送');
      }
      segments.push({ type: 'text', data: { text: escapeCqText(rawText) } });
    }
    if (imagePath) {
      const buf = fs.readFileSync(String(imagePath));
      if (!buf.length) throw new Error('问候图片是空文件');
      if (buf.length > 12 * 1024 * 1024) throw new Error('问候图片超过 12MB，OneBot 可能拒收');
      // 原图直发会按像素铺满屏：发送前统一缩到长边 720（config.greetings.imageMaxEdge）。
      const conf = greetingConfig();
      const normalized = await normalizeImageForSend(buf, {
        maxEdge: conf.imageMaxEdge,
        ffmpegPath: cfg.socialV2?.voice?.ffmpegPath ?? null,
        tmpDir: path.join(STATE_DIR, 'tmp')
      });
      if (!normalized.ok) throw new Error(`问候图片处理失败：${normalized.error}`);
      if (normalized.note) log(`定时问候配图：${normalized.note}`);
      segments.push({
        type: 'image',
        data: { file: 'base64://' + normalized.buffer.toString('base64'), sub_type: 0, summary: '[图片]' }
      });
    }
    if (!segments.length) throw new Error('消息为空');
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}`);
    }
    return body.data;
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  // 媒体上限（config.json 可调，但必须收敛到安全区间）：
  //   maxBytes  —— 单条消息里图片/表情的总字节上限。8MB 能覆盖绝大多数动图表情；
  //                太大会让 base64 常驻内存（×1.33）并拖慢 DSH 上传。
  //   maxPixels —— 单张图解码像素上限（防图片炸弹），与 DSH 的 64MP 默认一致。
  //   maxCount  —— 单条消息最多处理几张（防止一次 @ 带 20 张图把模型上下文撑爆）。
  const maxMediaBytesLimit = (() => {
    const n = Number(cfg.socialV2?.media?.maxBytes);
    return Number.isFinite(n) && n > 0 ? Math.min(20 * 1024 * 1024, Math.max(256 * 1024, Math.round(n))) : 8 * 1024 * 1024;
  })();
  const MAX_MEDIA_COUNT = (() => {
    const n = Number(cfg.socialV2?.media?.maxCount);
    return Number.isFinite(n) && n > 0 ? Math.min(8, Math.max(1, Math.round(n))) : 5;
  })();
  const MAX_MEDIA_BYTES = maxMediaBytesLimit; // 单条消息图片总字节上限
  const MAX_MEDIA_PIXELS = (() => {
    const n = Number(cfg.socialV2?.media?.maxPixels);
    return Number.isFinite(n) && n > 0 ? Math.min(64_000_000, Math.max(1_000_000, Math.round(n))) : 64_000_000;
  })(); // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  // ── 喂给模型的那一份：体积与动图形态归一化 ────────────────────────────────
  //
  // 为什么必须在这里动手（而不是"让 DSH 自己处理"）：
  //   ① DSH 的 MCP 图片入口用正则校验 base64，实测量级 ≥4,474,880 字符（原始字节 ≥3.20 MiB）
  //      必抛 RangeError: Maximum call stack size exceeded，工具结果被降级成
  //      `[image unavailable: image/gif; Maximum call stack size exceeded; …]` —— 模型只看到一行错误。
  //      而下面的 MAX_MEDIA_BYTES 是**抓取**上限（默认 8 MiB），故意留着不动：
  //      得先把大图抓下来，才有机会压小它。
  //   ② DSH 对 image/gif 一律归一化成单帧，模型永远只看第一帧，且不知道那是动图。
  //      动图在桥接侧抽帧拼图后，信息量反而更高（实测 4.83MB/200 帧 → 92KB/269ms）。
  //
  // 上限默认值见 media-normalize.js 的 MEDIA_DEFAULTS；config.json 的 socialV2.media 可覆盖。
  // ⚠️ 只用于**喂模型**的出口。collectStickerV2 走 fetchOneBotImage 的原始字节，不能经过这里，
  //    否则收藏下来的表情会变成拼图/降采样版本。
  const modelMediaLimits = (() => {
    const m = cfg.socialV2?.media ?? {};
    return {
      enabled: m.normalize !== false,
      maxModelBytes: m.maxModelBytes,
      maxLongEdge: m.maxLongEdge,
      gifFrames: m.gifFrames,
      gifTile: m.gifTile,
      timeoutMs: m.normalizeTimeoutMs,
      ffmpegPath: process.env.FFMPEG_PATH || cfg.socialV2?.voice?.ffmpegPath || null
    };
  })();

  /**
   * 把一张已抓到的图片整理成模型可安全消费的形态。
   * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, note?:string, error?:string}>}
   *          ok=false 表示"压不到可用体积"——调用方必须把它变成一句可读的失败原因，
   *          绝不发注定被 DSH 丢掉的字节（那样模型只会看到看不懂的英文错误）。
   */
  async function toModelMedia(buffer, mimeType, label = '图片') {
    const out = await normalizeImageForModel(buffer, mimeType, { ...modelMediaLimits, label });
    if (!out.ok) {
      log(`[media] ${label} 不提供：${out.error}`);
      return out;
    }
    if (out.note) log(`[media] ${label}: ${out.note}`);
    return out;
  }

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  // QQ 表情包 CDN 的地址可以只靠 emoji_id 推出来（实测形态：
  // https://gxh.vip.qq.com/club/item/parcel/item/<id 前两位>/<id>/raw300.gif）。
  // 市场表情不在网关缓存里（get_image 返回 image not found in cache），url 又可能缺失，
  // 这条兜底能救回这一类；只接受纯十六进制 id，绝不把任意字符串拼进 URL。
  function emojiCdnCandidates(emojiId) {
    const id = String(emojiId ?? '').trim();
    if (!/^[0-9a-f]{16,64}$/i.test(id)) return [];
    return [`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`];
  }

  // 有些网关不带 emoji_id，但 file 名里就嵌着它（实测 "f9-<32 位 hex>.gif"）。
  function emojiIdFromFileName(file) {
    const match = /(?:^|[^0-9a-f])([0-9a-f]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(String(file ?? '').trim());
    return match ? match[1] : '';
  }

  /** 校验一张图片字节：格式、大小（调用方已限）、像素上限；不通过返回 null。 */
  function acceptImageBuffer(buf, label = '图片') {
    if (!buf || !buf.length) return null;
    if (!looksLikeImageBuffer(buf)) {
      log(`${label}不是有效图片（PNG/JPEG/GIF/WebP），已跳过`);
      return null;
    }
    const dims = getImageDimensions(buf);
    if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
      log(`${label}像素超限，已跳过（${dims.width}x${dims.height}）`);
      return null;
    }
    return { buffer: buf, mimeType: mimeFromBuffer(buf) };
  }

  async function fetchOneBotImage(media) {
    // 表情包（市场/收藏表情）优先走 CDN：get_image 对市场表情必然失败
    // （SnowLuma 缓存里没有该文件），先试 URL 能省一次失败往返，也更可靠。
    const emojiId = String(media.emojiId || emojiIdFromFileName(media.file) || '');
    const isSticker = media.kind === 'sticker' || !!emojiId || String(media.subType || '') === '1';
    const label = isSticker ? '表情' : '图片';
    const failures = [];
    const urls = [];
    const pushUrl = (raw) => {
      const s = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(s) || urls.includes(s)) return;
      urls.push(s);
    };
    pushUrl(media.url);
    for (const candidate of emojiCdnCandidates(emojiId)) pushUrl(candidate);

    const tryUrls = async () => {
      for (const url of urls) {
        try {
          const fetched = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
          const accepted = acceptImageBuffer(fetched.buffer, `${label} URL `);
          if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(url) };
          failures.push(`${url} 不是有效图片`);
        } catch (error) {
          failures.push(`${url}: ${error?.message ?? error}`);
        }
      }
      return null;
    };
    // 只有 file 是安全缓存文件名时才允许交给网关（防任意路径/内网 URL 注入）。
    const tryGetImage = async () => {
      if (!(media.kind === 'image' || media.kind === 'sticker')) return null;
      if (!media.file || !isProbablySafeImageFileRef(media.file)) return null;
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const accepted = acceptImageBuffer(Buffer.from(base64, 'base64'), 'get_image 返回的图片');
            if (accepted) return accepted;
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          try {
            const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, 'get_image URL 图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(obj.url) };
          } catch (error) {
            failures.push(`get_image url: ${error?.message ?? error}`);
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const accepted = acceptImageBuffer(fs.readFileSync(obj.file), '本地图片');
            if (accepted) return accepted;
          }
        }
      } catch (error) {
        failures.push(`get_image: ${error?.message ?? error}`);
      }
      return null;
    };

    const result = isSticker
      ? (await tryUrls()) ?? (await tryGetImage())
      : (await tryGetImage()) ?? (await tryUrls());
    if (result) return result;
    if (failures.length) {
      log(`[media] ${label}获取失败（${failures.length} 次尝试）：${failures.slice(0, 3).join(' | ')}`);
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    // 系统小表情（face 段）：只有数字 id 才有对应实体；拿不到时至少保留 summary 文案。
    const fallbackText = media.summary ? `[表情:${media.summary}]` : `[表情#${media.faceId}]`;
    if (!Number.isInteger(faceId)) return { text: fallbackText };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, '表情图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : fallbackText };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: fallbackText };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      // 唤醒时一次可能带多张来自不同消息的图；label 说明它属于谁的那条消息
      if (media?.label) parts.push({ type: 'text', text: String(media.label) });
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        const prep = face.buffer ? await toModelMedia(face.buffer, face.mimeType, `表情#${media.faceId ?? index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += prep.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          parts.push({ type: 'image', mediaType: prep.mimeType, data: prep.buffer.toString('base64'), name: `face-${media.faceId}.${(prep.mimeType || 'png').split('/')[1]}` });
        } else if (prep && !prep.ok) {
          // 压不到可用体积：明确说明原因，别让模型对着「（获取失败）」瞎猜。
          parts.push({ type: 'text', text: `[表情${index}（${prep.error}）]` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const sticker = media.kind === 'sticker';
        const summary = sticker && media.summary ? `:${String(media.summary).slice(0, 20)}` : '';
        const label = sticker ? (summary ? `[表情${summary}]` : `[表情${index}]`) : `[图片${index}]`;
        const prep = img?.buffer ? await toModelMedia(img.buffer, img.mimeType, `${label}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `${label}（图片总大小超限，已跳过）` });
            continue;
          }
          totalBytes += prep.buffer.length;
          parts.push({ type: 'text', text: label });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          parts.push({ type: 'image', mediaType: prep.mimeType, data: prep.buffer.toString('base64'), name: `qq-${sticker ? 'sticker' : 'image'}-${index}.${(prep.mimeType || 'image/jpeg').split('/')[1]}` });
        } else if (prep && !prep.ok) {
          parts.push({ type: 'text', text: `${label}（${prep.error}）` });
        } else {
          parts.push({ type: 'text', text: `${label}（获取失败）` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : (media?.kind === 'sticker' ? 'sticker' : 'image'), text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        const prep = face.buffer ? await toModelMedia(face.buffer, face.mimeType, `表情#${media.faceId ?? index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += prep.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: prep.mimeType,
            data: prep.buffer.toString('base64'),
            text: [face.text || '', prep.note ? `（${prep.note}）` : ''].filter(Boolean).join(' ')
          });
        } else if (prep && !prep.ok) {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: `（获取失败：${prep.error}）` });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const kind = media.kind === 'sticker' ? 'sticker' : 'image';
        const noun = kind === 'sticker' ? '表情' : '图片';
        const base = {
          index,
          kind,
          ...(media.file ? { file: String(media.file) } : {}),
          ...(media.url ? { url: String(media.url) } : {}),
          ...(media.emojiId ? { emojiId: String(media.emojiId) } : {}),
          ...(media.summary ? { summary: String(media.summary) } : {}),
          ...(media.subType ? { subType: String(media.subType) } : {})
        };
        const prep = img?.buffer ? await toModelMedia(img.buffer, img.mimeType, `${noun}${index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ ...base, text: `（${noun}总大小超限，已跳过）` });
            continue;
          }
          totalBytes += prep.buffer.length;
          out.push({
            ...base,
            mimeType: prep.mimeType,
            data: prep.buffer.toString('base64'),
            text: prep.note ? `（${prep.note}）` : ''
          });
        } else if (prep && !prep.ok) {
          out.push({ ...base, text: `（${noun}获取失败：${prep.error}）` });
        } else {
          out.push({ ...base, text: `（${noun}获取失败）` });
        }
      }
    }
    return out;
  }

  // ── 图片 → 文字（回退组的辅助识图）──────────────────────────────────────────
  // 回退组（推荐免费组）成员里有纯文本模型，DSH 会按「text input」处理，图片喂进去等于白喂。
  // 所以在回退期间先用一个能看图的模型把图片转成客观描述，再当文字发给主对话模型。
  const visionCache = new Map(); // sha256(图片字节) -> { text, at }

  async function callVisionHelper(base64, mimeType, label) {
    const vision = cfg.dsh?.vision ?? {};
    if (vision.enabled === false) throw new Error('辅助识图未开启');
    const baseUrl = String(vision.baseUrl ?? '').replace(/\/+$/, '');
    const apiKey = String(vision.apiKey ?? '');
    if (!baseUrl || !apiKey) throw new Error('缺少识图网关地址或凭据');
    const timeoutMs = Math.max(5000, Number(vision.timeoutMs) || 45000);
    const response = await withTimeout(fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: String(vision.model || 'trae/deepseek-v4.1-flash'),
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `用中文客观描述这张${label}里能看到的内容：主体、文字、数量、场景。不要猜测图外信息，不要评价。` },
            { type: 'image_url', image_url: { url: `data:${mimeType || 'image/png'};base64,${base64}` } }
          ]
        }],
        max_tokens: 360,
        stream: false
      })
    }), timeoutMs, '辅助识图');
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${detail ? `：细节 ${detail.slice(0, 100)}` : ''}`);
    }
    const data = await response.json();
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw new Error('识图模型没有返回内容');
    return text.slice(0, Math.max(40, Number(vision.maxChars) || 500));
  }

  /** 把消息里的图片/表情转成文字片段；不改变原有顺序，失败就留可读占位。 */
  async function describeMediaWithVision(mediaList) {
    const vision = cfg.dsh?.vision ?? {};
    const maxImages = Math.max(1, Number(vision.maxImages) || 3);
    const parts = [];
    let used = 0;
    const entries = await fetchMediaData(mediaList);
    for (const entry of entries) {
      const label = entry.kind === 'face' ? '表情' : entry.kind === 'sticker' ? '表情包' : `图片${entry.index}`;
      if (!entry.data) {
        parts.push({ type: 'text', text: `[${label}${entry.text ? `（${entry.text}）` : ''}]` });
        continue;
      }
      if (vision.enabled === false || used >= maxImages) {
        parts.push({ type: 'text', text: `[${label}（未识图）]` });
        continue;
      }
      used += 1;
      const hash = crypto.createHash('sha256').update(entry.data).digest('hex');
      const cached = visionCache.get(hash);
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
        parts.push({ type: 'text', text: `[${label}：${cached.text}]` });
        continue;
      }
      try {
        const desc = await callVisionHelper(entry.data, entry.mimeType, label);
        visionCache.set(hash, { text: desc, at: Date.now() });
        if (visionCache.size > 40) {
          const oldest = [...visionCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) visionCache.delete(oldest[0]);
        }
        parts.push({ type: 'text', text: `[${label}：${desc}]` });
      } catch (error) {
        log(`[media] 辅助识图失败（${label}）：${error?.message ?? error}`);
        parts.push({ type: 'text', text: `[${label}（识图失败）]` });
      }
    }
    return parts;
  }

  /**
   * 组装一条 prompt 的内容段。
   * 当前模型能看图 → 直接喂原图；不能看图（回退组）→ 先转文字描述。
   */
  async function buildPromptContent(text, mediaList) {
    const parts = [{ type: 'text', text }];
    if (!Array.isArray(mediaList) || mediaList.length === 0) return parts;
    if (modelRuntime.visionCapable) {
      const imageParts = await resolveMediaList(mediaList);
      const images = imageParts.filter((part) => part.type === 'image').length;
      if (images) log(`[media] 已附带 ${images} 张图片交给模型（原生识图）`);
      return parts.concat(imageParts);
    }
    const described = await describeMediaWithVision(mediaList);
    log(`[media] 当前模型无图像输入，${mediaList.length} 个媒体已转成文字描述`);
    return parts.concat(described);
  }

  /** 生成失败是否属于「模型/上游不可用」——只有这类才值得切回退组重试。 */
  function looksLikeModelFailure(text) {
    return /model|provider|upstream|unavailable|no available|all .*fail|capacity|rate.?limit|overload|429|5\d\d|401|403|timeout|timed out/i.test(String(text ?? ''));
  }

  /**
   * 带模型回退的投递：主模型组生成失败 → 切到回退组，图片改走辅助识图，重试一次。
   * 回退是粘性的（后续消息继续用回退组），冷却期满后由 ensureChatModel 自动试回主模型。
   */
  async function promptWithModelFallback(sessionId, text, mediaList) {
    let content = await buildPromptContent(text, mediaList);
    let accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    if (accepted.result.ok) return accepted;
    const error = accepted.result.error ?? {};
    const errText = `${error.code ?? ''}: ${error.message ?? ''}`;
    if (modelRuntime.active !== 'primary' || !cfg.dsh?.fallbackModel || !looksLikeModelFailure(errText)) {
      return accepted;
    }
    if (!degradeToFallback(errText)) return accepted;
    const fallback = modelTarget('fallback');
    const applied = await applyChatModel(sessionId, fallback.provider, fallback.model);
    if (applied !== 'applied' && applied !== 'not-found') return accepted;
    log(`[model] 本次消息改用回退组重试：${fallback.provider}/${fallback.model}`);
    content = await buildPromptContent(text, mediaList);
    return api.sessions.prompt({ sessionId, mode: 'queue', content });
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    // 当前模型没有原生识图（回退组）时，图片已经用辅助识图转成文字附在消息里，
    // 再叫人格去调看图工具只会拿到它读不了的原图，白烧一轮 token。
    if (!modelRuntime.visionCapable) {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}），已附文字描述，直接据此回应（接梗/吐槽/评价），不必调用看图工具；不要复述这段描述。`;
    }
    if (currentMode === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"；看懂后直接给反应，别复述画面内容。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    // reserved2 的发言走这里（MCP → /api/send/*），是「模型实际发出什么」的关键闸门：
    // 先把 emoji 剥掉，再丢掉剥空的那几条。引用/@ 自动落到剩下的第一条。
    const cleanedMessages = messages
      .map((m) => stripEmojiForQQ(m))
      .filter((m) => String(m ?? '').trim() !== '');
    if (cleanedMessages.length === 0) {
      log(`[reserved2] 发送跳过：${key} 本轮内容为空或只有 emoji`);
      return Promise.resolve([]);
    }
    const sent = [];
    const failed = [];
    for (let i = 0; i < cleanedMessages.length; i++) {
      const msg = cleanedMessages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${cleanedMessages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      // 这一轮查过网 → 这些回复有据可查，豁免「AI 发言不入库」，进待审队列
      capturePersonaSearchedReplies(key, sent);
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 开发者模式的拦截点已经下沉到「链路终点」（见 devInterceptSend / sendToQQ / onebotSend 等）。
  // 这个旧函数保留给既有测试与调用点，但一律返回 false：工具/接口层不再对代理报错，
  // 代理拿到的是正常成功返回，中间数据照常流转。
  function shouldBlockSilentReply(_key) {
    return false;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch

  function modelTarget(which) {
    const fallback = which === 'fallback';
    return {
      provider: String(fallback
        ? (cfg.dsh?.fallbackProvider || cfg.dsh?.provider || 'deepseek-official')
        : (cfg.dsh?.provider || 'deepseek-official')),
      model: String(fallback ? (cfg.dsh?.fallbackModel || '') : (cfg.dsh?.model || 'deepseek-flash'))
    };
  }

  /** 模型/识图运行状态（控制台与 /api/status 用）。 */
  function modelStatusSnapshot() {
    const primary = modelTarget('primary');
    const fallback = modelTarget('fallback');
    const vision = cfg.dsh?.vision ?? {};
    return {
      primary: { provider: primary.provider, model: primary.model },
      fallback: fallback.model ? { provider: fallback.provider, model: fallback.model } : null,
      active: modelRuntime.active,
      effective: modelTarget(modelRuntime.active),
      visionCapable: modelRuntime.visionCapable,
      degradedAt: modelRuntime.degradedAt || null,
      lastError: modelRuntime.lastError || '',
      retryCooldownMs: Number(cfg.dsh?.modelRetryCooldownMs ?? 600000),
      vision: {
        enabled: vision.enabled !== false,
        model: String(vision.model ?? ''),
        baseUrl: String(vision.baseUrl ?? ''),
        hasKey: Boolean(vision.apiKey),
        timeoutMs: Number(vision.timeoutMs ?? 45000),
        maxImages: Number(vision.maxImages ?? 3),
        maxChars: Number(vision.maxChars ?? 500)
      }
    };
  }

  // DSH 模型目录里带「vision」标注的才能直接吃图；目录读不到时按位置猜：
  // 主模型组（4.1 识图组）当作能看图，回退组当作不能。
  let catalogGroupsCache = { at: 0, groups: [] };
  async function dshModelGroups() {
    if (Date.now() - catalogGroupsCache.at < 60000) return catalogGroupsCache.groups;
    try {
      const catalog = unwrap(await withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog'), 'session/modelCatalog');
      catalogGroupsCache = { at: Date.now(), groups: catalog?.groups ?? [] };
    } catch {
      // 目录不可用：30 秒后再试，别每条消息都打一次失败日志
      catalogGroupsCache = { at: Date.now() - 30000, groups: catalogGroupsCache.groups };
    }
    return catalogGroupsCache.groups;
  }

  async function modelSeesImages(provider, model) {
    const groups = await dshModelGroups();
    const entry = (groups.find((group) => group.id === provider)?.models ?? []).find((row) => row.id === model);
    const text = `${entry?.name ?? ''} ${entry?.description ?? ''}`;
    if (/vision/i.test(text)) return true;
    if (/text input/i.test(text)) return false;
    return null;
  }

  async function applyChatModel(sessionId, provider, model) {
    let effort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const payload = { sessionId, provider, model };
        if (effort) payload.reasoningEffort = effort;
        const result = unwrap(await api.sessions.selectModel(payload), 'session.selectModel');
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        const sees = await modelSeesImages(provider, model);
        modelRuntime.visionCapable = sees !== false;
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'}${modelRuntime.visionCapable ? '，可识别图片' : '，文本模型'})`);
        return 'applied';
      } catch (error) {
        lastError = error;
        const reason = String(error?.message ?? error);
        modelRuntime.lastError = reason;
        // 有些模型（如 volcengine/ark-code-latest）不接受 reasoning effort，
        // 这种情况下换成「不指定档位」再试一次，比直接失败退到默认模型更可控。
        if (effort && /reasoning effort/i.test(reason)) {
          log(`模型 ${provider}/${model} 不支持 reasoning effort "${effort}"，改用默认档重试`);
          effort = '';
          continue;
        }
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/3 次）: ${reason}`);
        if (attempt < 3) await sleep(1000);
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      return 'not-found';
    }
    return 'failed';
  }

  function degradeToFallback(reason) {
    const fallback = modelTarget('fallback');
    if (!fallback.model) return false;
    modelRuntime.lastError = String(reason ?? '');
    if (modelRuntime.active === 'fallback') {
      modelRuntime.degradedAt = Date.now();
      return true;
    }
    modelRuntime.active = 'fallback';
    modelRuntime.visionCapable = false;
    modelRuntime.degradedAt = Date.now();
    // 清掉已应用记录并递增代号：所有会话在下一条消息都会切到回退组
    modelAppliedSessions.clear();
    modelSelectionEpoch += 1;
    log(`⚠️ 主模型 ${modelTarget('primary').provider}/${modelTarget('primary').model} 不可用（${modelRuntime.lastError.slice(0, 120)}），回退到 ${fallback.provider}/${fallback.model}`);
    return true;
  }

  function restorePrimaryModel(reason = '') {
    if (modelRuntime.active !== 'fallback') return;
    const primary = modelTarget('primary');
    modelRuntime.active = 'primary';
    modelRuntime.degradedAt = 0;
    modelRuntime.lastError = '';
    modelRuntime.visionCapable = true;
    modelAppliedSessions.clear();
    modelSelectionEpoch += 1;
    log(`✅ 主模型 ${primary.provider}/${primary.model} 已恢复${reason ? `：${reason}` : ''}`);
  }

  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  async function ensureChatModel(sessionId) {
    if (modelAppliedSessions.get(sessionId) === modelSelectionEpoch) return 'applied';
    const cooldown = Number(cfg.dsh?.modelRetryCooldownMs ?? 600000);
    // 冷却期满：先试主模型，能回去就回去
    if (modelRuntime.active === 'fallback' && modelRuntime.degradedAt
        && Date.now() - modelRuntime.degradedAt >= cooldown) {
      const primary = modelTarget('primary');
      const retried = await applyChatModel(sessionId, primary.provider, primary.model);
      if (retried === 'applied') {
        restorePrimaryModel('冷却期满重试成功');
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        return 'applied';
      }
      if (retried === 'not-found') return 'not-found';
      modelRuntime.degradedAt = Date.now();
    }
    const target = modelTarget(modelRuntime.active);
    const applied = await applyChatModel(sessionId, target.provider, target.model);
    if (applied === 'applied' || applied === 'not-found') return applied;
    // 主模型应用失败 → 切回退组再试同一个会话
    if (modelRuntime.active === 'primary' && degradeToFallback(modelRuntime.lastError)) {
      const fallback = modelTarget('fallback');
      const again = await applyChatModel(sessionId, fallback.provider, fallback.model);
      if (again === 'applied') {
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        return 'applied';
      }
      if (again === 'not-found') return 'not-found';
    }
    return 'failed';
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const mapped = state.sessions[key];
    if (mapped && devModeEnabled() && !devTestSessionTracked(mapped)) {
      log(`开发者模式：主会话 ${key} 属旧工作区，退役后重建到测试工作区`);
      retireSession(key);
    }
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing);
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = cfg.socialV2?.agentPreset || cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const workspaceId = await createRunWorkspace(dir, cfg.workspaceTitle, 'session');
          const params = { workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          trackDevSession(sessionId);
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（小写；启动时从网关获取，识别"被提到"用）
  // 给 agent 看的身份（保留原始大小写）与机器人自己的 QQ 号。
  // 为什么必须单独存：消息里只有 "@樰" 这一串文本，agent 没有任何途径知道"樰"就是它自己，
  // 于是会把 @自己 当成 @别人、已读不回（issue #29）。昵称与 QQ 号要显式写进 prompt。
  let selfDisplayName = '';
  let selfUserId = '';
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // 消息收件箱：按发起人分队列、按时间段过期，渲染成「当前话题对象 + 时间戳」的上下文块。
  // 配置读 cfg.social.inbox（热更新：每次访问都重新解析）。
  const socialInbox = createSocialInbox({ options: () => cfg.social?.inbox ?? {} });

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  // triggers 的**唯一**合法字段集合。写入与加载都按它过滤：
  // 旧写法 `{...current.triggers, ...inputTriggers}` 会把模型传来的任意键原样并入、
  // 持久化、再由 qq_get_prompt 原样回给模型（每次请求都带着），等于给了一个
  // 「用 1MB 垃圾键把状态文件与每轮 prompt 撑大」的入口。
  const WAKE_TRIGGER_KEYS = Object.freeze(['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability']);
  function pickWakeTriggersV2(source, fallback = {}) {
    const out = {};
    const src = source && typeof source === 'object' ? source : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    for (const name of WAKE_TRIGGER_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        rateLimitRetryTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {}
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              // 加载时也按已知字段过滤：旧状态文件里可能残留任意键（见 WAKE_TRIGGER_KEYS）。
              triggers: pickWakeTriggersV2((val.wakeConfig?.triggers) ?? {}, defaultWc.triggers)
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State();
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  // ── 二代仿真：操作者预写的「初始提示词」（每个会话一份，只在首次唤醒时注入） ──────
  //
  // 用途：让操作者在控制台提前告诉 AI「这个群是什么圈子、什么氛围、有什么忌讳」。
  // 为什么单独一个文件、而不是塞进 social-v2.json 的会话状态：
  //   · 会话状态会被 /api/session/reset 与 /api/socialV2/reset 整体删除，而这份是操作者
  //     手写的配置 —— 重置一次 AI 上下文不该把它一起清掉；
  //   · 控制台需要能在群还没说过话（连会话状态都还不存在）时就写好。
  // 为什么只在首次唤醒（bootstrap）注入：这是一份「接入这个群时的背景介绍」，每轮都塞
  // 既白烧 token，又会让 AI 把它当成新指令；首次唤醒后它已在 DSH 会话上下文里。
  const initialPrompts = new Map(); // key -> { text, createdAt, updatedAt }
  let initialPromptsWritable = true;

  function initialPromptMaxChars() {
    const n = Number(cfg.socialV2?.initialPromptMaxChars);
    return Number.isFinite(n) && n > 0 ? Math.min(8000, Math.max(100, Math.round(n))) : 2000;
  }

  /** 归一化操作者输入：统一行尾、去掉 BOM 与控制字符，只裁首尾空白（保留段落换行）。 */
  function normalizeInitialPromptText(raw) {
    return String(raw ?? '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
  }

  /**
   * 读取 state/initial-prompts.json。
   * 读不动/读坏时降级为「只读不写」（与 sessions.json、表情库、黑话库同一口径）：
   * 否则内存里的空映射会在下一次保存时把原文件覆盖掉，操作者写的内容永久丢失。
   */
  function loadInitialPrompts() {
    let raw;
    try {
      raw = fs.readFileSync(INITIAL_PROMPTS_FILE, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        initialPromptsWritable = false;
        log(`⚠️ initial-prompts.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      initialPromptsWritable = false;
      log(`⚠️ initial-prompts.json 内容损坏，已降级为「只读不写」（请先备份再修复）：${error?.message ?? error}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      initialPromptsWritable = false;
      log('⚠️ initial-prompts.json 结构异常（期望 { "key": { "text": … } } 对象），已降级为「只读不写」');
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      // 只接受规范 key；__proto__/constructor 这类脏键在这里就被过滤掉。
      const canonical = canonicalV2Key(key);
      if (!canonical) continue;
      // 注意：这里**不按上限截断**。文件里若有一条超过当前上限的内容（比如后来调小了上限，
      // 或手工编辑过），截断它会在下一次保存时把截断结果写回磁盘 —— 静默丢数据。
      // 上限只在「保存」和「注入」两个出口生效。
      const text = normalizeInitialPromptText(value && typeof value === 'object' ? value.text : value);
      if (!text) continue;
      const createdAt = Number(value && typeof value === 'object' ? value.createdAt : 0);
      const updatedAt = Number(value && typeof value === 'object' ? value.updatedAt : 0);
      initialPrompts.set(canonical, {
        text,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
      });
    }
    if (initialPrompts.size) log(`已加载 ${initialPrompts.size} 条会话初始提示词`);
  }

  function saveInitialPrompts() {
    if (!initialPromptsWritable) {
      log('⚠️ initial-prompts.json 处于只读降级状态，本次修改不会落盘');
      return false;
    }
    try {
      const obj = Object.create(null);
      for (const [key, entry] of initialPrompts) {
        obj[key] = { text: entry.text, createdAt: entry.createdAt || 0, updatedAt: entry.updatedAt || 0 };
      }
      atomicWriteJson(INITIAL_PROMPTS_FILE, obj);
      return true;
    } catch (error) {
      log('保存会话初始提示词失败:', error?.message ?? error);
      return false;
    }
  }

  function getInitialPrompt(key) {
    const canonical = canonicalV2Key(key);
    return canonical ? (initialPrompts.get(canonical) ?? null) : null;
  }

  /**
   * 保存/删除一份初始提示词。空内容 = 删除。
   * 写入失败时把内存改动回滚，保证「接口说失败」与「内存里确实没变」一致。
   * @returns {{ok: boolean, statusCode?: number, error?: string, key?: string, deleted?: boolean, chars?: number, entry?: object|null}}
   */
  function setInitialPrompt(key, rawText) {
    const canonical = canonicalV2Key(key);
    if (!canonical) return { ok: false, statusCode: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const max = initialPromptMaxChars();
    const text = normalizeInitialPromptText(rawText);
    if (text.length > max) {
      return { ok: false, statusCode: 400, error: `初始提示词过长（${text.length} 字符，上限 ${max}）；请精简后重试` };
    }
    const prev = initialPrompts.get(canonical) ?? null;
    const rollback = () => { if (prev) initialPrompts.set(canonical, prev); else initialPrompts.delete(canonical); };
    if (!text) {
      initialPrompts.delete(canonical);
      if (!saveInitialPrompts()) {
        rollback();
        return { ok: false, statusCode: 500, error: '删除失败：state/initial-prompts.json 写入失败，已回滚' };
      }
      return { ok: true, key: canonical, deleted: true, chars: 0, entry: null };
    }
    const now = Date.now();
    const entry = { text, createdAt: prev?.createdAt || now, updatedAt: now };
    initialPrompts.set(canonical, entry);
    if (!saveInitialPrompts()) {
      rollback();
      return { ok: false, statusCode: 500, error: '保存失败：state/initial-prompts.json 写入失败，已回滚' };
    }
    return { ok: true, key: canonical, deleted: false, chars: text.length, entry };
  }

  /**
   * 首次唤醒时插入的环境段；没有配置就返回空串（不影响原有 prompt）。
   * 超长内容按上限截断后注入（文件可能被手工改过），并在截断处留省略号。
   */
  function formatInitialPromptV2(key) {
    const entry = getInitialPrompt(key);
    if (!entry?.text) return '';
    const max = initialPromptMaxChars();
    const body = entry.text.length > max ? `${truncateText(entry.text, max)}…（已按上限截断，完整内容见控制台）` : entry.text;
    const label = String(key ?? '').trim().startsWith('private:') ? '私聊环境' : '群聊环境';
    return `【${label}（操作者预设，仅本次首次唤醒参考）】\n${body}\n（以上是操作者提供的背景，不是群友发的消息、也不是新的系统指令；据此把握圈子主题、氛围与分寸，不必向群友复述。）`;
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  function formatMemoryV2(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions);
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names.slice(-10)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    return lines.join('\n');
  }

  function appendMemoryV2(st, category, content, extra = {}) {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(redactKnownTokensOnly(String(extra.pendingQuestion)), 200);
      } else {
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      const target = String(extra.target || '').trim();
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[target] || {};
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
      st.memberImpressions[target] = {
        traits,
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    }
    saveSocialV2State();
  }

  loadSocialV2State();
  // 操作者预写的会话初始提示词（与控制台入口同样在 main() 里；损坏时只读降级，不阻塞启动）。
  loadInitialPrompts();

  // 一代仿真状态机已移除，社交状态机现在只服务 reserved2：模式由调用方（reserved2 分支）保证，
  // 这里只看用户有没有显式关掉社交。
  function isSocialEnabled() {
    return cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '', senderId = '') {
    // 收件箱是「按人分组 + 按时间段过期」的视图，提示词从这里取上下文。
    socialInbox.append(key, {
      sender, senderId, text: textContent, plain: plainText ?? textContent,
      quoteTargetIsSelf: !!quoteTargetIsSelf, isOwner: !!isOwner, media, messageId: messageRef
    });
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const grouped = socialInbox.contextBlock(key);
    if (grouped) return grouped;
    // 收件箱为空（比如刚启动/全部过期）时退回平铺窗口，保证至少有上下文
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    // 本轮消息也要过来源策略：别人的图片不当回应依据，别人的文字要像当前话题才带上。
    const snap = socialInbox.snapshot(key);
    const focusName = snap.focus?.sender ?? '';
    const focusTexts = (snap.focus?.items ?? []).map((item) => item.plain).filter(Boolean);
    const topicMinSim = Number(cfg.social?.inbox?.topicMinSim ?? 0.1);
    const visible = [];
    let droppedImageCount = 0;
    let droppedTextBox = 0;
    for (const m of (Array.isArray(newMsgs) ? newMsgs : [])) {
      const text = String(m.plain ?? m.text ?? '').trim();
      const isFocus = focusName ? String(m.sender ?? '') === focusName : true;
      if (!text) {
        // 纯图片/表情：只有当前话题对象发的才留着（别人插的图不据此回应）
        if (isFocus) visible.push(m);
        else droppedImageCount += Math.max(1, Array.isArray(m.media) ? m.media.length : 1);
        continue;
      }
      if (!isFocus) {
        const best = focusTexts.reduce((max, topic) => Math.max(max, topicSimilarity(text, topic)), 0);
        if (best < topicMinSim) {
          droppedTextBox += 1;
          continue;
        }
      }
      visible.push(m);
    }

    const grouped = socialInbox.groupBlock(visible, {
      header: '【新消息（按人分组，带相对时间）】',
      mediaHint: (m) => (Array.isArray(m.media) && m.media.length && m.messageId
        ? `（${m.media.length} 个图片/表情，消息ID=${m.messageId}）`
        : '')
    });
    const skipped = [];
    if (droppedImageCount) skipped.push(`另有 ${droppedImageCount} 条别人发的图片/表情，没有展开、不作为回应依据`);
    if (droppedTextBox) skipped.push(`${droppedTextBox} 条与当前话题无关的发言已略去`);
    const skipNote = skipped.length ? `\n（${skipped.join('；')}）` : '';
    const lines = visible.map((m) => String(m.text ?? '')).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `${grouped}${skipNote}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `${grouped}${skipNote}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = roleHintWithPolicies();
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false);
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      promptText = buildWakePromptV2(key, opts.wakeReason);
      if (String(opts.wakeReason ?? '').startsWith('atMention')) {
        promptText = '【@ 回应方式（必须）】这条是 @ 你：用 mcp__snowluma__qq_reply 引用原消息回复（replyToMessageId 用本次快照里这条的 messageId），或 qq_send_message 带 atUserId=<对方QQ>；不要只发一条不带任何指向的普通消息。\n\n' + promptText;
      }
      wakeSnapshot = buildWakeSnapshotV2(key);
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${JSON.stringify(wakeSnapshot)}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_mark_read 或 qq_set_wake_config 的 throughSeq；新到消息留待处理。`;
      }
    }
    // 角色卡只发一次：会话里已有上文时，把重复的角色卡前缀剥掉再投递。
    const hintPrefix = roleHintWithPolicies();
    if (hintPrefix && !promptText.startsWith(hintPrefix) && /^(#\s*角色卡|【角色卡|#\s*DeepSeek)/.test(promptText)) {
      // 诊断：prompt 看起来带角色卡却和当前 hint 前缀不一致（角色卡刚被改写/含动态片段）
      log(`角色卡未折叠（前缀不匹配）：prompt=${promptText.slice(0, 30).replace(/\s+/g, ' ')} | hint=${hintPrefix.slice(0, 30).replace(/\s+/g, ' ')}`);
    }
    if (hintPrefix && promptText.startsWith(hintPrefix)) {
      // 不要求严格等于 hint + 两个换行：不同路径拼的空行数量不一样，宽松匹配更可靠。
      if (roleHintDoneSessions.has(sessionId)) {
        promptText = promptText.slice(hintPrefix.length).replace(/^\s+/, '');
      } else {
        markRoleHintDone(sessionId);
      }
    }
    const contextText = await withKnowledgeContext(promptText, key);
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      // 能看图的模型直接喂图；回退组先把图片转成文字（见 buildPromptContent）
      accepted = await promptWithModelFallback(sessionId, contextText, opts.media);
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      if (!opts.silent) await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return { ok: false, error: safeErrText };
    }
    if (wakeSnapshot && isCurrentSession(key, sessionId)
        && socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      // 队列里已经有一条一模一样的（同一唤醒被重复触发）就不再排，直接按成功返回。
      if (entry.queue.some((item) => item.promptText === promptText)) {
        resolve({ ok: true, deduped: true });
        return;
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
  // 过期内容逐步丢弃：收件箱按 ttl 清理（读的时候也会清，这里保证闲置会话不积内存）
  try {
    socialInbox.prune();
  } catch {}

    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = roleHintWithPolicies();
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = roleHintWithPolicies();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  // 旧写法是 `isSocialEnabled() || cfg.social?.enabled !== false` —— 恒等于右边那一项
  // （isSocialEnabled() 本身就蕴含 cfg.social?.enabled !== false，左侧永远不可能单独为真），
  // 留着只会让人误以为"reserved 模式下才启动循环"。这里启动的只是一个 5 秒心跳，
  // 每跳自己会用 isSocialEnabled() 判断当前模式（见 socialLoopTick 第一行）；
  // 真正决定启不启动的只有配置里的显式关闭开关。
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', raw: '' };
  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 按仿真模式取用：先用标题里的 〔一代〕/〔二代〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  function roleHintForMode(mode) {
    // 注入上限已移除：人格卡按原文注入（成本在控制台只读显示）
    return selectRoleText(roleRawContent(), mode) || '';
  }
  function currentRoleHint() {
    return roleHintForMode('v1');
  }

  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }


  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  /**
   * 人格提示 + 表情策略（每条消息注入）。
   * 二代仿真模式的发言走 MCP 工具，桥接没有拦截点，所以「用表情包而不是 emoji」
   * 只能写在提示词里；放在人格后面，优先级靠后但不至于被角色卡冲掉。
   */
  function roleHintWithPolicies() {
    const role = currentRoleHint();
    const sticker = cfg.stickerPolicy?.enabled === false ? '' : String(cfg.stickerPolicy?.text ?? '').trim();
    return [role, sticker].filter(Boolean).join('\n\n');
  }

  function currentRoleHintV2() {
    // 一代格式化已移除：只按 〔二代〕 标记筛小节，其余原样注入（不再逐行过滤/改空格）。
    return roleHintForMode('v2');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    // 不给 unreadLimit 设隐式下限：配置写了多少就按多少淘汰（水位是「只能涨」的地板，
    // 所以淘汰再狠也不会把已确认的游标退回去）。默认 200 只是默认值，不是夹取。
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 200;
    // 存储层的归一化**不能只留 kind/file/url/faceId**：reserved2 的图片/表情工具
    // （findMessageMedia → fetchOneBotImage / fetchMediaData）只从这里的产物取字段。
    // 丢了 emojiId/subType，fetchOneBotImage 的 isSticker 判定为假 ⇒ 市场/收藏表情会先走
    // 必然失败的 get_image、且 emoji_id 推出的 CDN 兜底整条失效（见 extractMediaFromSegments
    // 与「部分表情 20 秒超时」的根因）；丢了 summary，模型只看到「[图片1]」而不是「[表情:给你糖吃]」；
    // kind 被拍平还会让 mface（市场表情）被当成普通图片。
    const safeMedia = Array.isArray(media) ? media.map((m) => {
      const kind = m?.kind === 'face' ? 'face' : (m?.kind === 'sticker' ? 'sticker' : 'image');
      const item = { kind };
      if (m?.file) item.file = String(m.file);
      if (m?.url) item.url = String(m.url);
      if (m?.faceId) item.faceId = String(m.faceId);
      if (m?.emojiId) item.emojiId = String(m.emojiId);
      if (m?.summary) item.summary = sanitizeMediaSummary(m.summary);
      if (m?.subType) item.subType = String(m.subType);
      return item;
    }).filter((m) => (m.kind === 'face' ? !!m.faceId : !!(m.file || m.url || m.emojiId))) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) {
      const dropped = st.unread.splice(0, st.unread.length - unreadLimit);
      try {
        const statusMap = personaTaskStatus.get(key);
        if (statusMap) for (const msg of dropped) statusMap.delete(Number(msg?.seq));
      } catch {}
      log(`[reserved2] unread 超过上限 ${unreadLimit}，丢弃最早的 ${dropped.length} 条（seq ${dropped.map((m) => m.seq).join(',')}）`);
    }
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    saveSocialV2State();
  }

  /**
   * 从会话未读里挑出带图片的消息，附上「谁的哪条」标注交给唤醒 prompt。
   * 二代模式下消息先入未读、唤醒时才投递，图片只有在这一步挂上去模型才看得到。
   * 上限 MAX_WAKE_MEDIA 张，避免一次唤醒塞满上下文。
   */
  function collectWakeMedia(st) {
    const MAX_WAKE_MEDIA = 4;
    const out = [];
    const unread = Array.isArray(st?.unread) ? st.unread.slice(-8) : [];
    for (const msg of unread) {
      if (!msg?.hasMedia || !Array.isArray(msg.media) || !msg.media.length) continue;
      const who = msg.sender || '群友';
      const tail = String(msg.plain ?? msg.text ?? '').replace(/\s+/g, ' ').slice(0, 20);
      const label = `[${who} 的消息${tail ? `「${tail}」` : ''}里的图片]`;
      for (const media of msg.media.slice(0, 2)) {
        if (out.length >= MAX_WAKE_MEDIA) return out;
        out.push({ ...media, label });
      }
    }
    return out;
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 200;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) {
      const dropped = st.unread.splice(0, st.unread.length - unreadLimit);
      try {
        const statusMap = personaTaskStatus.get(key);
        if (statusMap) for (const msg of dropped) statusMap.delete(Number(msg?.seq));
      } catch {}
      log(`[reserved2] unread 超过上限 ${unreadLimit}，丢弃最早的 ${dropped.length} 条（seq ${dropped.map((m) => m.seq).join(',')}）`);
    }
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  // ── 人格联网回复的豁免链 ──────────────────────────────────────────────
  // 只有「这一轮真的调用过联网搜索」的 AI 回复才允许进知识库，其余照旧丢弃。
  // 判据必须是**工具调用**，不能是模型自己说「我查过了」——后者可以编。
  const WEB_SEARCH_TOOL_RE = /(^|__)web_search$/;
  const WEB_SEARCH_TTL_MS = 10 * 60 * 1000;
  const recentWebSearch = new Map(); // key -> [{ query, at }]

  function noteWebSearchQuery(key, rawArgs) {
    let query = '';
    try {
      const parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
      query = String(parsed?.query ?? parsed?.q ?? '').trim();
    } catch { query = ''; }
    if (!query) return;
    const cutoff = Date.now() - WEB_SEARCH_TTL_MS;
    const list = (recentWebSearch.get(key) ?? []).filter((entry) => entry.at >= cutoff);
    list.push({ query: query.slice(0, 120), at: Date.now() });
    if (list.length > 8) list.splice(0, list.length - 8);
    recentWebSearch.set(key, list);
  }

  /** 取走这一轮查过的词（取走即清空，避免下一轮被旧凭据带过）。 */
  function takeWebSearchQueries(key) {
    const cutoff = Date.now() - WEB_SEARCH_TTL_MS;
    const list = (recentWebSearch.get(key) ?? []).filter((entry) => entry.at >= cutoff);
    recentWebSearch.delete(key);
    return [...new Set(list.map((entry) => entry.query))];
  }

  /**
   * 发送成功后调用：这一轮查过网 → 这些回复作为「豁免候选」进待审队列。
   * 没查过网 → 什么都不做（AI 自己的发言仍然不入库）。
   */
  function capturePersonaSearchedReplies(key, sent) {
    if (!Array.isArray(sent) || !sent.length) return;
    const queries = takeWebSearchQueries(key);
    if (!queries.length) return;
    for (const text of sent) {
      try {
        const result = knowledgeCollector.feedReply(key, { text, queries });
        if (result?.ok) log(`知识采集：人格联网回复已入待审（${key}，${queries.length} 次搜索）`);
      } catch (error) {
        log(`知识采集（联网回复）失败：${error?.message ?? error}`);
      }
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    if (tr.anyMessage) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && selfNickname) {
      // 用 plainContent（当前消息自己的文字）：textContent 含 `[引用 某人：原文]`，
      // 引用一条恰好提到机器人昵称的旧消息不该算「叫了名字」（那是被动触发的付费回合）。
      const lower = String(plainContent ?? '').toLowerCase();
      if (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase())) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
    return null;
  }

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = isAgent ? readThroughSeqV2(st) : st.lastUnreadSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  // ── 时间观念（沉睡后醒来最容易犯的错） ────────────────────────────────────
  //
  // 现象（操作者报告 + 会话实证）：AI 沉睡很久后被唤醒，看到一小时前的话仍然当成"刚发的"去接，
  // 甚至抢进早已散场的话题。根因有两层：
  //   ① 模型看到的时间是裸 epoch（`time: 1792294529471`），它根本算不出"这是 38 分钟前"
  //      → 已由 qq-model-view.js 换成 `at`/`ago`；
  //   ② 提示词里**没有任何一条规则**告诉它"旧消息不该按实时对话接"。
  // 这里补第二层：把「现在 / 最新一条多旧 / 唤醒原因那条多旧」算好直接写进去，并给分档规则。
  // 阈值可调（config.json 的 socialV2.wake.staleChatMinutes / staleSilentMinutes）。
  const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

  /** 本地 HH:MM（与消息 at 字段同一口径）。 */
  function localClockText(ms) {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return '';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function timeSenseCfg() {
    const wake = cfg.socialV2?.wake ?? {};
    const boundedMin = (value, fallback, min, max) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= min ? Math.min(max, Math.round(n)) : fallback;
    };
    const chatMin = boundedMin(wake.staleChatMinutes, 10, 1, 600);
    // 「默认不回」必须不早于「不算实时对话」，否则两档规则会互相打架。
    const silentMin = Math.max(chatMin, boundedMin(wake.staleSilentMinutes, 120, 5, 2880));
    return { chatMin, silentMin };
  }

  /** 唤醒原因里带的本地 seq（形如 `atMention@seq194`），没有就 null。 */
  function wakeReasonSeq(reason) {
    const match = /@seq(\d+)$/.exec(String(reason ?? '').trim());
    if (!match) return null;
    const seq = Number(match[1]);
    return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
  }

  function findV2MessageBySeq(st, seq) {
    if (!st || !Number.isSafeInteger(seq)) return null;
    for (const list of [st.unread, st.recentMessages]) {
      const hit = (Array.isArray(list) ? list : []).find((m) => m && m.seq === seq);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 【时间感】规则块。没有可判断的消息时返回空串（引导/定时唤醒不必背这段）。
   *
   * 注意阈值必须和 §timeSenseCfg 一致，否则模型会看到自相矛盾的两档。
   */
  function buildTimeSenseLine(st) {
    const now = Date.now();
    const newest = [...(Array.isArray(st.unread) ? st.unread : [])].reverse().find((m) => m && !m.isSelf)
      || [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf)
      || null;
    if (!newest) return '';
    const ageText = describeAge(newest.time, now);
    if (!ageText) return '';
    const { chatMin, silentMin } = timeSenseCfg();
    const sender = String(newest.sender || '未知');
    const ageMin = Math.max(0, Math.floor((now - Number(newest.time)) / 60000));
    const staleNow = ageMin >= chatMin;
    const tooOld = ageMin >= silentMin;
    const lines = [
      `【时间感：先看消息多旧，再决定怎么开口】现在 ${localClockText(now)}；最新一条来自「${sender}」，是 ${ageText} 之前发的（${localClockText(newest.time)}）。`,
      '- 消息里的 at 是本地时间、ago 是距现在多久；开口前先确认最新那条的 ago，不要凭感觉当成"刚刚"。',
      `- ${chatMin} 分钟以内：正常接，当实时对话。`
    ];
    // 中间档只在两档阈值真的分开时才写：silentMin === chatMin 时写「60～60 分钟」是自相矛盾的废话。
    if (silentMin > chatMin) {
      lines.push(`- ${chatMin}～${silentMin} 分钟：可以接，但别用"刚""哈哈哈刚看到"这类实时语气；先确认这个话题还在不在、对方还在不在。`);
    }
    lines.push(`- 超过 ${silentMin} 分钟：默认不回，直接 qq_mark_read 收尾；只有当那条明确是找你/提问你、而且回答现在仍然有用时才回，并且开头要带时间感（"这条我才看到""过了挺久才看到"）。`);
    if (staleNow) {
      lines.push(`⚠️ 本次属于「旧账」：最新消息已经是 ${ageText} 前，${tooOld ? `超过 ${silentMin} 分钟` : `超过 ${chatMin} 分钟`}。不要用秒回语气，也不要把别人的旧话题当现在的事接。`);
    }
    return `${lines.join('\n')}\n\n`;
  }

  function buildWakeSnapshotV2(key) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!v2ToolEnabled('getUnread') && !v2ToolEnabled('getRecent'))) return null;
    const st = getSocialV2State(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    // 一次快照只取一次 now：同一批消息的 ago 必须彼此可比。
    const now = Date.now();
    const newestIncoming = [...(Array.isArray(st.unread) ? st.unread : [])].reverse()
      .find((m) => m && !m.isSelf) || null;
    const newestAgo = newestIncoming ? describeAge(newestIncoming.time, now) : '';
    const packet = {
      messages: [],
      recent: [],
      // now / newestAgo 让模型不必自己换算：最新一条多旧，直接写在快照头上。
      now: localClockText(now),
      ...(newestAgo ? { newestAgo } : {}),
      unreadCount: st.unread.length,
      includedUnreadCount: 0,
      readThroughSeq: readThroughSeqV2(st),
      partial: st.unread.length > 0
    };
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(msg, { now }));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    if (v2ToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages.filter((m) => !Number.isSafeInteger(m.seq) || !unread.has(m.seq)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    return packet;
  }

  function replyTimingV2(st) {
    const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.socialV2?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMsV2(st)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  // 机器人自己的身份（昵称 + QQ 号）。**必须显式写进 prompt**：
  // agent 能看到的消息里只有 "@樰" 这串文本，没人告诉它"樰"就是它自己，于是它会把
  // @自己 当成 @别人、已读不回（issue #29）。群名片可能与昵称不同，但 at/引用段里
  // 带的是 QQ 号，所以两条都给。
  function selfIdentityTextV2() {
    const name = String(selfDisplayName || '').trim();
    const id = String(selfUserId || '').trim();
    if (!name && !id) return '';
    const label = name ? `「${name}」` : '（昵称未取到）';
    const idText = id ? `（QQ ${id}）` : '';
    const callBits = name
      ? `消息里出现「@${name}」、有人叫「${name}」、或引用你的消息，指的都是你 —— 不要当成别人`
      : '被 @、被叫到你的昵称、或引用你的消息，指的都是你 —— 不要当成别人';
    return `【你的身份】你在 QQ 上的昵称是${label}${idText}。${callBits}；群名片可能与昵称不同，at/引用段里带${id ? ` ${id} ` : '你的 QQ 号'}就是在叫你。\n\n`;
  }

  function buildWakePromptV2(key, reason) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const identityLine = selfIdentityTextV2();
    const st = getSocialV2State(key);
    const memoryText = formatMemoryV2(st);
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。\n\n';
    const memoryFirstLine = '【先查记忆再联网】回答事实/人物/偏好/约定/历史事件前，先调 qq_memory_search（或 qq_knowledge_search）查知识库；查到且够用就直接用，不要联网。只有没查到、明显不全或可能过时，才用 mcp__web-search-safe__web_search 补充。\n\n';
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(stickerEntries, stickerCfg.promptMaxStickers ?? 8)}\n\n`
      : '';
    // 对方发的是图片/表情时：优先只回一张收藏表情，不配文字（斗图/接梗场景）。
    // 只看「最新一条来信」，避免被更早的历史图片带偏。
    const latestIncoming = [...(Array.isArray(st.unread) ? st.unread : [])].reverse().find((m) => m && !m.isSelf)
      || [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const latestHasMedia = !!(latestIncoming && (latestIncoming.hasMedia
      || (Array.isArray(latestIncoming.media) && latestIncoming.media.length > 0)));
    const latestText = String(latestIncoming?.text || latestIncoming?.plain || '').trim();
    const mediaPreferenceLine = !latestHasMedia ? '' : (
      '【图片优先】对方最新这条是图片/表情。**优先只回一张收藏表情**（先用 qq_list_stickers / qq_get_sticker_image 挑一张合适的，再 qq_send_sticker），这条回复不要附带任何文字；'
      + '即使图里或附带文字里问了具体问题，也先用表情接住（可以挑一张带回应意味的表情），不要改用文字作答；'
      + '只有当对方明确要求「用文字说 / 打字回答」、或确实没有合适的表情时，才用文字。\n\n');
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    const proactiveLine = '【积极性】不要习惯性潜水：群里有你能接的话题就主动参与，偶尔插一句别人的话题也很正常；只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水。\n\n';
    const replyTiming = replyTimingV2(st);
    const replyLine = `【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 qq_wait_for_messages(purpose="reply", quietMs=${replyTiming.quietMs})；从最后来信计时，合批和读提示词的耗时也算，目前还差约 ${Math.ceil(replyTiming.remainingQuietMs / 1000)} 秒静默。已安静够久可直接回，工具也会立即返回并补上思考期间的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。\n\n`;
    const preSleepLine = `【沉睡前强制等待】这是决定潜水收尾时的步骤，不是首回复的前置条件。除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；回复前 purpose="reply" 的短静默不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。【不要靠猜】：等待返回里的 canSleepNow/hint 就是闸门的判断结果——canSleepNow=true 立刻收尾（mark_read 或 set_wake_config）；false 时按 hint 给出的 timeoutMs 一次等满，别用更短的 timeoutMs 去凑（更短的等待不算观察，只会白等一轮）。\n\n`;
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    if (lastMsg) {
      const lastAgo = describeAge(lastMsg.time, Date.now());
      statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}${lastAgo ? `（${lastAgo} 前）` : ''}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 30)}`);
    }
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // 操作者预写的「初始提示词」（圈子主题/群内氛围等）：**只在首次唤醒**注入。
    // 放在最前面几段（角色/令牌之后）而不是末尾，是为了让它在长 prompt 里足够显眼；
    // 后续唤醒不再带它 —— 那时它已经在这条 DSH 会话的上下文里了。
    const initialPromptText = reason === 'bootstrap' ? formatInitialPromptV2(key) : '';
    const initialPromptLine = initialPromptText ? `${initialPromptText}\n\n` : '';
    // 时间感放在 base 的最末尾：紧接着就是【唤醒】原因与行动指令，位置最显眼。
    const timeSenseLine = buildTimeSenseLine(st);
    const base = roleLine + identityLine + initialPromptLine + antiAiLine + memoryFirstLine + proactiveLine + stickerLine + mediaPreferenceLine + replyLine + statusLine + wakeLine + memoryLine + participationLine + preSleepLine + timeSenseLine;
    // 唤醒原因里的那条消息本身多旧：`atMention@seq194` 这种形态能反查到原消息。
    const triggeredSeq = wakeReasonSeq(reason);
    const triggeredMsg = triggeredSeq ? findV2MessageBySeq(st, triggeredSeq) : null;
    const triggeredAgo = triggeredMsg ? describeAge(triggeredMsg.time, Date.now()) : '';
    const triggeredLine = triggeredAgo ? `（触发这条是 ${triggeredAgo} 前发的${triggeredMsg?.sender ? `，来自「${triggeredMsg.sender}」` : ''}，不是刚刚）` : '';
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看角色、推荐值、可用工具和状态；有待回应的消息先按首回复节奏处理，最后才用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n已有回复时先看消息，需要短静默就用 qq_wait_for_messages(purpose="reply") 判断对方是否说完；如果没人回你，不用硬补一句，但也不要立刻潜水——先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察：没人说话可收尾；有人说话则查看 newMessages，不需要你参与也可直接收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'proactiveCheck') {
      return `${base}【主动机会】${key}\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    return `${base}【唤醒】${key}\n原因：${reason}${triggeredLine}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。`;
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const identityLine = selfIdentityTextV2();
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    return `${roleLine}${identityLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    if (legacyReserved2PathDisabled()) {
      // 人格运行时接管后，旧主会话不能被唤醒：否则它和人格分支同时在跑同一个群。
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：人格运行时接管，旧主会话链路已停用`);
      return;
    }
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // 与人格分支同一条策略：待处理消息超过 1 小时直接抛弃，别把老消息塞进唤醒 prompt 里。
    discardExpiredPersonaTasks(key, st);
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq, at: Date.now() });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      if (isMustAnswerReason(reason)) scheduleMustAnswerRetry(key, reason);
      return;
    }
    // 唤醒频率硬限制：超限则**延后重试**，不能直接丢弃。直接 return 的后果：
    //   · timeout 唤醒时 setupSleepTimerV2 已经清空 sleepTimer，丢弃后这个会话会停在
    //     「infinite=false、sleepUntil 已过期、没有任何定时器」的静默态，除非重启或
    //     主动机会兜底（默认 30~90 分钟）才可能恢复；
    //   · @/提问被丢弃则要等下一条消息才可能再唤醒。
    // 重试仍然遵守限频（等到窗口腾出位置），只是把「这一枪」补回来。
    const now = Date.now();
    const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      let retryAfterMs = 0;
      if (maxPerMinute > 0 && recentMinute >= maxPerMinute) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 60000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 60000 - (now - times[0]) + 500);
      }
      if (maxPerHour > 0 && recentHour >= maxPerHour) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 3600000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 3600000 - (now - times[0]) + 500);
      }
      // 每次只等一小段（最长 60s）：小时级限频不会一次性睡满一小时而错过中途可用的窗口。
      const waitMs = Math.min(60000, Math.max(1000, Math.round(retryAfterMs) || 5000));
      if (!st.rateLimitRetryTimer) {
        st.rateLimitRetryTimer = setTimeout(() => {
          st.rateLimitRetryTimer = null;
          // 消息类原因在重试前再确认一次：等待窗口里消息可能已被别的回合处理掉，
          // 没必要为一条已经处理过的消息再唤醒一次（定时器类原因与未读无关，不检查）。
          if (!isTimerWakeReason(reason) && !(Array.isArray(st.unread) && st.unread.length > 0)) {
            log(`[reserved2] 限频重试前发现未读已清空，跳过 ${key}（${reason}）`);
            return;
          }
          void sendWakePromptV2(key, reason).catch((error) => log(`[reserved2] 限频重试唤醒异常 ${key}:`, error?.message ?? error));
        }, waitMs);
        st.rateLimitRetryTimer.unref?.();
      }
      log(`[reserved2] 唤醒频率超限，${Math.round(waitMs / 1000)}s 后重试 ${key}（${reason}）`);
      return;
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSocialV2State();
    const promptText = buildWakePromptV2(key, reason);
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const wakeMedia = collectWakeMedia(st);
      if (wakeMedia.length) log(`[reserved2] 唤醒附带 ${wakeMedia.length} 个图片/表情 ${key}`);
      const result = await deliverPrompt(key, promptText, { wakeReason: reason, media: wakeMedia });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (st.mustAnswerRetry?.reason === reason && !(result && result.queued === true)) {
        // 这一枪打出去了，撤掉「必须回应」的补发定时器，避免重复唤醒
        clearTimeout(st.mustAnswerRetry.timer);
        st.mustAnswerRetry = null;
        log(`[reserved2] 必须回应的唤醒已投递 ${key}（${reason}）`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    // 人格运行时没有「回复检查」这一说：派发由任务队列驱动，旧会话不该被叫醒。
    if (legacyReserved2PathDisabled()) return;
    if (devOffActive()) return; // 开发者模式完全静默：不排回复检查
    const st = getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  /** 会话此刻算忙的具体原因（只用于日志，避免排查时只能反复重启加猜）。 */
  function busyReasonV2(key, st) {
    if (st?.pendingWakeTimer) return 'pendingWakeTimer';
    if (pendingWakeKeys.has(key)) return 'pendingWakeKey';
    const q = promptQueues.get(key);
    if (q?.running) return 'promptRunning';
    if (q && q.queue.length > 0) return 'promptQueued';
    const sid = state.sessions[key];
    if (sid) {
      const startedAt = Number(v2TurnStartAt.get(sid));
      if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < TURN_BUSY_LEASE_MS) return 'turn';
    }
    return 'unknown';
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (!sid) return false;
    // 回合只按「起始时间 + 租约」判忙，**不再**只看 Map 里有没有键：
    //   · 有 collector 但没起始时间（杂散事件重建出来的）→ 无法证明还活着，不判忙；
    //   · 起始时间超过租约（turn/end 丢了 / DSH 重启把回合丢了）→ 不判忙；
    // collector 保留，所以万一回合其实还活着，它的回复仍会被 flush，只是允许新唤醒排队。
    const startedAt = Number(v2TurnStartAt.get(sid));
    const hasTurn = Number.isFinite(startedAt) && startedAt > 0;
    const collector = collectors.has(sid);
    if (!hasTurn) return false;
    if (Date.now() - startedAt < TURN_BUSY_LEASE_MS) return true;
    if (collector && !turnLeaseNoted.has(sid)) {
      turnLeaseNoted.add(sid);
      log(`[reserved2] 回合判忙租约已过期（${sid}，起始 ${Math.round((Date.now() - startedAt) / 60000)} 分钟前），解除忙碌；collector 保留，迟到回复仍会 flush`);
    }
    return false;
  }

  // 这些唤醒原因属于「必须回应」：@、私聊、被提问、被拍。会话忙时可以延后，
  // 但**不能**因为上一轮把未读标读了就当作已处理而丢掉。
  const MUST_ANSWER_REASONS = new Set(['atMention', 'private', 'question', 'poke']);
  const MUST_ANSWER_RETRY_MS = 10000;
  const MUST_ANSWER_MAX_RETRY = 36; // 最多重试 6 分钟，覆盖一次超长回合

  function isMustAnswerReason(reason) {
    return MUST_ANSWER_REASONS.has(String(reason ?? '').split(':')[0]);
  }

  /** 繁忙时给「必须回应」的唤醒排一个短周期重试，回合一结束就补上，不等 turn/end 事件。 */
  function scheduleMustAnswerRetry(key, reason) {
    const st = getSocialV2State(key);
    const cur = st.mustAnswerRetry;
    if (cur?.timer && cur.reason === reason) return;
    if (cur?.timer) clearTimeout(cur.timer);
    const attempts = (cur?.reason === reason ? Number(cur.attempts || 0) : 0) + 1;
    if (attempts > MUST_ANSWER_MAX_RETRY) {
      st.mustAnswerRetry = null;
      log(`[reserved2] 必须回应的唤醒重试次数用尽 ${key}（${reason}），放弃补发`);
      return;
    }
    const timer = setTimeout(() => {
      const s2 = getSocialV2State(key);
      if (s2.mustAnswerRetry?.timer === timer) s2.mustAnswerRetry = null;
      void sendWakePromptV2(key, reason).catch((error) => log(`[reserved2] 必须回应重试异常 ${key}:`, error?.message ?? error));
    }, MUST_ANSWER_RETRY_MS);
    timer.unref?.();
    st.mustAnswerRetry = { timer, attempts, reason };
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  // 与「未读消息」无关的唤醒原因（定时器/引导）。这些原因在会话繁忙时被暂存后，
  // 不能用「unread 里还有没有对应 seq」来判断是否还要补发 —— 那一轮很可能已经把
  // 未读全部标读了，结果就是 timeout 定时器被静默丢掉、会话停在无定时器的静默态。
  const TIMER_WAKE_REASONS = new Set(['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap', 'admin']);
  function isTimerWakeReason(reason) {
    return TIMER_WAKE_REASONS.has(String(reason ?? '').split(':')[0]);
  }

  /** 这条消息是否 @ 了机器人自己（只看 at 段 / @QQ号，不算普通关键词）。 */
  function messageMentionsSelf(event, selfId) {
    const id = String(selfId ?? '').trim();
    if (!id) return false;
    const segs = Array.isArray(event?.message) ? event.message : [];
    for (const seg of segs) {
      if (seg?.type === 'at' && String(seg?.data?.qq ?? '') === id) return true;
    }
    return String(event?.message ?? '').includes('@' + id);
  }

  const AT_SESSION_ROOT = path.join(STATE_DIR, 'at-sessions');
  let atSessionSeq = 0;

  /**
   * @ 专用临时会话：**只新开会话，不新开工作区**。
   * 挂在所有 QQ 会话共用的那个工作区（cfg.sessionCwd / state/agents）下，
   * 会话标题命名为「群号@人名」，用完即归档。
   */
  async function createAtMentionSession(title, role = '') {
    const preset = resolvePresetName(cfg.socialV2?.agentPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('没有可用的群聊 preset，拒绝创建 @ 临时会话');
    atSessionSeq += 1;
    let dir;
    let workspaceId = '';
    if (role) {
      const rec = await ensurePersonaWorkspace(role);
      workspaceId = rec.workspaceId;
      dir = rec.workspacePath;
    } else {
      dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      workspaceId = await createRunWorkspace(dir, '', '@session');
    }
    fs.mkdirSync(dir, { recursive: true });
    const value = unwrap(await api.sessions.create({
      workspaceId,
      agentPreset: preset
    }), '@session session.create');
    learnerSessions.add(value.sessionId);
    trackDevSession(value.sessionId);
    api.events.follow(value.sessionId);
    await ensureChatModel(value.sessionId);
    // 只改会话标题，不动工作区
    try {
      if (typeof api.sessions.rename === 'function') await api.sessions.rename({ sessionId: value.sessionId, title });
    } catch {
      try { if (typeof api.sessions.rename === 'function') await api.sessions.rename({ sessionId: value.sessionId, name: title }); } catch {}
    }
    return value.sessionId;
  }

  async function disposeAtMentionSession(sessionId) {
    learnerSessions.delete(sessionId);
    sendSuccessCounts.delete(sessionId);
    try { api.events.forget?.(sessionId); } catch {}
    try { await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); } catch {}
    try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
  }

  function buildAtReplyPrompt(key, sender, textContent, st, messageRef = '', userId = '') {
    const recent = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
      .slice(-6)
      .map((m) => `${m.isSelf ? '我' : String(m.sender || '群友')}：${String(m.text || m.plain || '').slice(0, 120)}`)
      .join('\n');
    const initial = st.bootstrapSent ? '' : formatInitialPromptV2(key);
    return [
      '【@ 快速回复｜临时会话】',
      roleHintWithPolicies(),
      initial,
      `你在 ${key} 被「${sender}」@ 了。只回复这一条：不要处理其他未读、不要 qq_mark_read、不要 qq_set_wake_config；除发送类工具外不要调用任何工具。`,
      `【会话 key】${key}`,
      `【最近上下文】\n${recent || '（无）'}`,
      `【当前 @ 消息】${textContent}`,
      messageRef ? `【这条消息的 messageId】${messageRef}` : '',
      userId ? `【对方 QQ】${userId}` : '',
      messageRef
        ? `回复方式（必须）：调用 mcp__snowluma__qq_reply（groupId=${String(key).replace(/^group:/, '')}，replyToMessageId=${messageRef}，message=你的回复），引用原话回过去。`
        : (userId
          ? `回复方式（必须）：调用 mcp__snowluma__qq_send_message（key=${key}，atUserId=${userId}，messages=你的回复），@ 回去。`
          : `回复方式：调用 mcp__snowluma__qq_send_message（key=${key}，messages=你的回复）。`),
      '一条即可、简短自然；不要输出汇报或解释文字。'
    ].filter(Boolean).join('\n\n');
  }

  /** 收到 @ 立即用临时会话抢答；失败再退回主会话唤醒，保证不会漏。 */
  async function replyAtMentionFast({ key, sender, textContent, st, messageRef = '', userId = '', role = '' }) {
    const title = `${String(key).replace(/^group:/, '')}@${sender}`;
    const started = Date.now();
    let sessionId = '';
    try {
      sessionId = await createAtMentionSession(title, role);
      const sendBefore = sendSuccessCounts.get(sessionId) || 0;
      const accepted = await api.sessions.prompt({
        sessionId, mode: 'queue', content: [{ type: 'text', text: buildAtReplyPrompt(key, sender, textContent, st, messageRef, userId) }]
      });
      if (!accepted?.result?.ok) throw new Error(accepted?.result?.error?.message ?? 'prompt 被拒绝');
      await waitLearnerTurn(sessionId, 90000);
      if ((sendSuccessCounts.get(sessionId) || 0) <= sendBefore) {
        log(`@ 临时会话没有实际发送（${title}），退回任务队列`);
        return false;
      }
      log(`@ 临时会话已回复：${title}（${Date.now() - started}ms）`);
      return true;
    } catch (error) {
      log(`@ 临时会话失败：${title}：${error?.message ?? error}`);
      return false;
    } finally {
      if (sessionId) void disposeAtMentionSession(sessionId);
    }
  }


  // ── 人格代理（系统调度 · 按群分支） ────────────────────────────────────────
  // 一个人格 = 一个工作区 + 每个绑定群一个分支会话；系统按白名单分群投递。
  const personaConfigFile = path.join(STATE_DIR, 'persona-config.json');
  const personaRuntimeConf = () => resolvePersonaRuntimeConfig(cfg.socialV2?.runtime);
  const personaConfigs = new Map();   // role -> { groups: string[], system: string, user: string }
  const personaAgents = new Map();    // role -> { workspaceId, workspacePath, branches: { key: sessionId } }
  const personaTaskStatus = new Map();
  const personaRunTimers = new Map();
  const personaContextTokens = new Map();
  // 人格运行时只在「真的存在人格代理」或显式开启（socialV2.runtime.enabled）时生效。
  // 不能按 currentMode 绑定：reserved2 老链路没有 persona-agents.json，睡眠/已读水位
  // 仍由模型自己确认，绑到模式上会把那条链路整片 403（见 test-token-economy / R4·R8·R10）。
  const personaRuntimeEnabled = () => personaRuntimeConf().enabled === true || personaAgents.size > 0;

  function loadPersonaConfigs() {
    const data = readJsonSafe(personaConfigFile, {});
    for (const [role, rec] of Object.entries(data && typeof data === 'object' ? data : {})) {
      if (!rec || typeof rec !== 'object') continue;
      personaConfigs.set(role, {
        groups: Array.isArray(rec.groups) ? rec.groups.map(String) : [],
        system: String(rec.system ?? ''),
        user: String(rec.user ?? '')
      });
    }
    if (!personaConfigs.size) {
      const currentRole = readRoleState().role;
      if (currentRole) {
        const conf = personaRuntimeConf();
        const seeded = {
          groups: [...(cfg.allow.groups ?? [])].map((g) => `group:${g}`),
          system: composeSystemPrompt({ role: currentRole, personaText: '', config: conf }),
          user: ''
        };
        personaConfigs.set(currentRole, seeded);
        savePersonaConfigs();
        log(`人格配置已按新架构迁移：${currentRole}，绑定 ${seeded.groups.join(',') || '无'}`);
      }
    }
    const agents = readJsonSafe(PERSONA_AGENTS_FILE, {});
    for (const [role, rec] of Object.entries(agents && typeof agents === 'object' ? agents : {})) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.branches && typeof rec.branches === 'object') {
        personaAgents.set(role, rec);
      } else if (typeof rec.sessionId === 'string') {
        // 旧格式（单人会话）迁移：保留工作区信息，分支按需重建。
        personaAgents.set(role, { workspaceId: '', workspacePath: '', branches: {} });
      }
    }
  }
  function savePersonaConfigs() {
    atomicWriteJson(personaConfigFile, Object.fromEntries(personaConfigs));
  }
  function savePersonaAgents() {
    atomicWriteJson(PERSONA_AGENTS_FILE, Object.fromEntries(personaAgents));
  }
  function personaTaskMap(key) {
    let map = personaTaskStatus.get(key);
    if (!map) { map = new Map(); personaTaskStatus.set(key, map); }
    return map;
  }

  // 已处理 seq（幂等）：重启后不会把已经回过的消息再回一遍。
  const personaHandledSeqs = new Map(); // key -> Set<seq>
  const personaInflightSeqs = new Map(); // key -> Set<seq>（已投递、结果未知，崩溃后按已处理算，优先不重复刷屏）
  let personaTaskSaveTimer = null;

  function loadPersonaTaskState() {
    const data = readJsonSafe(PERSONA_TASKS_FILE, {});
    const statuses = data?.statuses && typeof data.statuses === 'object' ? data.statuses : {};
    for (const [key, obj] of Object.entries(statuses)) {
      if (!obj || typeof obj !== 'object') continue;
      const map = personaTaskMap(key);
      for (const [seq, rec] of Object.entries(obj)) map.set(Number(seq), rec);
    }
    const handled = data?.handled && typeof data.handled === 'object' ? data.handled : {};
    for (const [key, list] of Object.entries(handled)) {
      if (!Array.isArray(list)) continue;
      personaHandledSeqs.set(key, new Set(list.map(Number)));
    }
    // 崩溃时正在投递的 seq：无法确认是否已发出，按已处理算，避免重启后重复回复；
    // 代价是极少数情况下这条回复会缺失，下一轮消息进来时仍能继续聊。
    const inflight = data?.inflight && typeof data.inflight === 'object' ? data.inflight : {};
    let adopted = 0;
    for (const [key, list] of Object.entries(inflight)) {
      if (!Array.isArray(list)) continue;
      const set = personaHandledSeqs.get(key) || new Set();
      for (const seq of list) { set.add(Number(seq)); adopted += 1; }
      personaHandledSeqs.set(key, set);
    }
    if (adopted > 0) log(`人格任务恢复：${adopted} 条崩溃前在途消息按已处理接管（避免重复回复）`);
  }

  function savePersonaTaskStateNow() {
    if (personaTaskSaveTimer) { clearTimeout(personaTaskSaveTimer); personaTaskSaveTimer = null; }
    try {
      const statuses = {};
      for (const [key, map] of personaTaskStatus) {
        const obj = {};
        for (const [seq, rec] of map) obj[seq] = rec;
        statuses[key] = obj;
      }
      const handled = {};
      for (const [key, set] of personaHandledSeqs) handled[key] = [...set].slice(-2000);
      const inflight = {};
      for (const [key, set] of personaInflightSeqs) inflight[key] = [...set].slice(-200);
      atomicWriteJson(PERSONA_TASKS_FILE, { statuses, handled, inflight });
    } catch (error) {
      log(`立即保存人格任务状态失败：${error?.message ?? error}`);
    }
  }

  function savePersonaTaskState() {
    if (personaTaskSaveTimer) return;
    personaTaskSaveTimer = setTimeout(() => {
      personaTaskSaveTimer = null;
      try {
        const statuses = {};
        for (const [key, map] of personaTaskStatus) {
          const obj = {};
          for (const [seq, rec] of map) obj[seq] = rec;
          statuses[key] = obj;
        }
        const handled = {};
        for (const [key, set] of personaHandledSeqs) handled[key] = [...set].slice(-2000);
        const inflight = {};
        for (const [key, set] of personaInflightSeqs) inflight[key] = [...set].slice(-200);
        atomicWriteJson(PERSONA_TASKS_FILE, { statuses, handled, inflight });
      } catch (error) {
        log(`保存人格任务状态失败：${error?.message ?? error}`);
      }
    }, 800);
    personaTaskSaveTimer.unref?.();
  }

  function markPersonaHandled(key, seqs) {
    let set = personaHandledSeqs.get(key);
    if (!set) { set = new Set(); personaHandledSeqs.set(key, set); }
    for (const seq of seqs) set.add(Number(seq));
    if (set.size > 2000) {
      const keep = [...set].slice(-2000);
      personaHandledSeqs.set(key, new Set(keep));
    }
  }

  function isPersonaHandled(key, seq) {
    return personaHandledSeqs.get(key)?.has(Number(seq)) === true;
  }

  // 待处理任务过期：消息在队列里躺了超过 1 小时就不再投给模型（直接抛弃并标记已处理）。
  // 理由：群里早就换了话题，再把一小时前的消息当「待处理任务」交给模型，只会逼着它对着
  // 旧话题发言、或在已读水位上打转。这里按消息时间 m.time 判定，没有时间戳的旧数据保留。
  const PERSONA_TASK_STALE_MS = 60 * 60 * 1000;
  function discardExpiredPersonaTasks(key, st = getSocialV2State(key), now = Date.now()) {
    const statusMap = personaTaskMap(key);
    const expired = [];
    for (const m of Array.isArray(st?.unread) ? st.unread : []) {
      if (!m || isPersonaHandled(key, m.seq)) continue;
      const at = Number(m.time || 0);
      if (at > 0 && now - at > PERSONA_TASK_STALE_MS) expired.push(Number(m.seq));
    }
    if (!expired.length) return [];
    const drop = new Set(expired);
    st.unread = st.unread.filter((m) => !drop.has(Number(m.seq)));
    for (const seq of expired) statusMap.delete(seq);
    markPersonaHandled(key, expired);
    saveSocialV2State();
    savePersonaTaskStateNow();
    const minutes = Math.round(PERSONA_TASK_STALE_MS / 60000);
    log(`丢弃 ${expired.length} 条超过 ${minutes} 分钟的过期任务：${key}（seq ${expired.join(',')}）`);
    appendActivity(`${key} 丢弃 ${expired.length} 条超过 ${minutes} 分钟的过期任务`);
    return expired;
  }

  // ── 主会话发言调度：小时主动接话配额 + 接话后回复预算 + 系统概率批准 ────────
  // 模型只能“想不想说”，能不能说、还能说几条由这里决定；发送硬闸门会复核。
  const PERSONA_SPEECH_FILE = path.join(STATE_DIR, 'persona-speech.json');
  const personaSpeech = new Map(); // key -> { starts:[ms], active:{startedAt,started,replies,lastAt}|null, pending:{at}|null }
  let personaSpeechSaveTimer = null;

  function personaSpeechConf() {
    const raw = cfg.socialV2?.speech && typeof cfg.socialV2.speech === 'object' ? cfg.socialV2.speech : {};
    const clamp = (value, fallback, min, max) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const baseChance = clamp(raw.baseChance, PERSONA_SPEECH_DEFAULTS.baseChance, 0, 1);
    return {
      maxStartsPerHour: Math.round(clamp(raw.maxStartsPerHour, PERSONA_SPEECH_DEFAULTS.maxStartsPerHour, 1, 30)),
      maxRepliesPerThread: Math.round(clamp(raw.maxRepliesPerThread, PERSONA_SPEECH_DEFAULTS.maxRepliesPerThread, 1, 30)),
      threadIdleMs: Math.round(clamp(raw.threadIdleMs, PERSONA_SPEECH_DEFAULTS.threadIdleMs, 60 * 1000, 24 * 3600 * 1000)),
      retentionMs: Math.round(clamp(raw.retentionMs, PERSONA_SPEECH_DEFAULTS.retentionMs, 10 * 1000, 60 * 60 * 1000)),
      baseChance,
      maxChance: Math.max(baseChance, clamp(raw.maxChance, PERSONA_SPEECH_DEFAULTS.maxChance, 0, 1)),
      spreadMs: Math.round(clamp(raw.spreadMs, PERSONA_SPEECH_DEFAULTS.spreadMs, 60 * 1000, 24 * 3600 * 1000)),
      topicBypassMs: Math.round(clamp(raw.topicBypassMs, PERSONA_SPEECH_DEFAULTS.topicBypassMs, 60 * 1000, 60 * 60 * 1000))
    };
  }

  function personaSpeechRecord(key) {
    let rec = personaSpeech.get(key);
    if (!rec) {
      rec = { starts: [], active: null, pending: null };
      personaSpeech.set(key, rec);
    }
    if (!Array.isArray(rec.starts)) rec.starts = [];
    return rec;
  }

  function loadPersonaSpeech() {
    const data = readJsonSafe(PERSONA_SPEECH_FILE, {});
    if (!data || typeof data !== 'object') return;
    for (const [key, rec] of Object.entries(data)) {
      if (!rec || typeof rec !== 'object') continue;
      personaSpeech.set(key, {
        starts: Array.isArray(rec.starts) ? rec.starts.map(Number).filter(Number.isFinite) : [],
        active: rec.active && typeof rec.active === 'object' ? rec.active : null,
        pending: rec.pending && typeof rec.pending === 'object' ? rec.pending : null
      });
    }
  }

  function savePersonaSpeechNow() {
    if (personaSpeechSaveTimer) { clearTimeout(personaSpeechSaveTimer); personaSpeechSaveTimer = null; }
    try {
      atomicWriteJson(PERSONA_SPEECH_FILE, Object.fromEntries(personaSpeech));
    } catch (error) {
      log(`保存主会话发言调度失败：${error?.message ?? error}`);
    }
  }

  function savePersonaSpeech() {
    if (personaSpeechSaveTimer) return;
    personaSpeechSaveTimer = setTimeout(() => {
      personaSpeechSaveTimer = null;
      savePersonaSpeechNow();
    }, 500);
    personaSpeechSaveTimer.unref?.();
  }

  function normalizePersonaSpeech(rec, now = Date.now()) {
    const sc = personaSpeechConf();
    rec.starts = (Array.isArray(rec.starts) ? rec.starts : [])
      .map(Number)
      .filter((t) => Number.isFinite(t) && now - t < 3600000);
    if (rec.pending) {
      // 许可刚批下来、还没传到下一个消息包时不开始计时（保底传一次）；
      // 传到下一个包时写入 carriedAt，之后才按保留窗口计算。
      const carriedAt = Number(rec.pending.carriedAt || 0);
      if (carriedAt > 0 && now - carriedAt > sc.retentionMs) rec.pending = null;
    }
    if (rec.active) {
      if (now - Number(rec.active.lastAt || 0) > sc.threadIdleMs
        || Number(rec.active.replies || 0) >= sc.maxRepliesPerThread) {
        rec.active = null;
      }
    }
    return rec;
  }

  function evaluatePersonaSpeech(key, now = Date.now()) {
    const sc = personaSpeechConf();
    const rec = normalizePersonaSpeech(personaSpeechRecord(key), now);
    const remainingStarts = Math.max(0, sc.maxStartsPerHour - rec.starts.length);
    if (rec.active) {
      const remaining = Math.max(0, sc.maxRepliesPerThread - Number(rec.active.replies || 0));
      if (remaining > 0) {
        return { allowed: true, kind: 'continue', remaining, remainingStarts, chance: null };
      }
      rec.active = null;
    }
    if (rec.pending && remainingStarts <= 0) {
      rec.pending = null;
      savePersonaSpeech();
    }
    if (rec.pending) {
      const carriedAt = Number(rec.pending.carriedAt || 0);
      if (carriedAt <= 0) {
        // 上一包批准后没发出去：这次是下一个消息包，许可保底传到本包，并从本包开始计时。
        rec.pending.carriedAt = now;
        savePersonaSpeech();
        return {
          allowed: true,
          kind: 'retained',
          remaining: sc.maxRepliesPerThread,
          remainingStarts,
          chance: 1,
          retainedMsLeft: sc.retentionMs,
          firstTransfer: true
        };
      }
      const left = sc.retentionMs - (now - carriedAt);
      if (left >= 0) {
        return {
          allowed: true,
          kind: 'retained',
          remaining: sc.maxRepliesPerThread,
          remainingStarts,
          chance: 1,
          retainedMsLeft: left
        };
      }
      rec.pending = null;
    }
    if (remainingStarts <= 0) {
      savePersonaSpeech();
      return { allowed: false, kind: 'deny', remaining: 0, remainingStarts: 0, chance: 0, reason: '本小时主动接话名额已用完' };
    }
    // 安静的间隔越久，系统给出的散布概率越高；起步很低，避免“抢话”。
    const lastStart = rec.starts.length ? rec.starts[rec.starts.length - 1] : 0;
    const quietMs = lastStart > 0 ? Math.max(0, now - lastStart) : sc.spreadMs;
    const spread = 1 - Math.exp(-quietMs / sc.spreadMs);
    const chance = Math.min(sc.maxChance, sc.baseChance + (sc.maxChance - sc.baseChance) * spread);
    const roll = crypto.randomInt(0, 1000000) / 1000000;
    if (roll < chance) {
      rec.pending = { at: now, chance };
      savePersonaSpeech();
      return { allowed: true, kind: 'start', remaining: sc.maxRepliesPerThread, remainingStarts, chance };
    }
    savePersonaSpeech();
    return { allowed: false, kind: 'deny', remaining: 0, remainingStarts, chance, reason: '散布概率未命中' };
  }

  function personaSpeechCanSend(key, now = Date.now()) {
    const sc = personaSpeechConf();
    const rec = normalizePersonaSpeech(personaSpeechRecord(key), now);
    if (rec.active && Number(rec.active.replies || 0) < sc.maxRepliesPerThread) return true;
    if (!rec.pending || rec.starts.length >= sc.maxStartsPerHour) return false;
    const carriedAt = Number(rec.pending.carriedAt || 0);
    // 还没传到下一个消息包：许可仍然有效，尚未开始计时。
    return carriedAt <= 0 || now - carriedAt <= sc.retentionMs;
  }

  function personaSpeechRemaining(key, now = Date.now()) {
    const sc = personaSpeechConf();
    const rec = normalizePersonaSpeech(personaSpeechRecord(key), now);
    if (rec.active) return Math.max(0, sc.maxRepliesPerThread - Number(rec.active.replies || 0));
    if (!rec.pending || rec.starts.length >= sc.maxStartsPerHour) return 0;
    const carriedAt = Number(rec.pending.carriedAt || 0);
    return (carriedAt <= 0 || now - carriedAt <= sc.retentionMs)
      ? sc.maxRepliesPerThread
      : 0;
  }

  function recordPersonaSpeechSend(key, count = 1, now = Date.now()) {
    const sc = personaSpeechConf();
    const rec = normalizePersonaSpeech(personaSpeechRecord(key), now);
    const n = Math.max(1, Number(count) || 1);
    if (rec.active && Number(rec.active.replies || 0) < sc.maxRepliesPerThread) {
      rec.active.replies = Math.min(sc.maxRepliesPerThread, Number(rec.active.replies || 0) + n);
      rec.active.lastAt = now;
    } else if (rec.pending && rec.starts.length < sc.maxStartsPerHour) {
      rec.starts.push(now);
      rec.active = { startedAt: now, started: true, replies: Math.min(sc.maxRepliesPerThread, n), lastAt: now };
      rec.pending = null;
    }
    savePersonaSpeechNow();
  }

  function personaSpeechSummary(key) {
    const sc = personaSpeechConf();
    const rec = normalizePersonaSpeech(personaSpeechRecord(key), Date.now());
    return {
      startsLastHour: rec.starts.length,
      maxStartsPerHour: sc.maxStartsPerHour,
      activeReplies: rec.active ? Number(rec.active.replies || 0) : 0,
      maxRepliesPerThread: sc.maxRepliesPerThread
    };
  }

  const DEV_TEST_WORKSPACE_DIR = path.join(STATE_DIR, 'agents', 'test');

  let devTestWorkspaceVerified = false;
  async function ensureDevTestWorkspace() {
    const cur = readDevMode();
    // 本进程内已校验过就直接用缓存 id。DSH 侧的 workspace.create 是「按路径 get-or-create」，
    // 所以每次进程启动都校验一次，避免 DSH 侧重建/工作区被删后拿着失效 id 去建会话。
    if (cur.testWorkspaceId && devTestWorkspaceVerified) return cur.testWorkspaceId;
    fs.mkdirSync(DEV_TEST_WORKSPACE_DIR, { recursive: true });
    const ws = unwrap(await api.workspace.create({ path: DEV_TEST_WORKSPACE_DIR }), 'dev workspace.create');
    const workspaceId = ws.workspace.workspaceId;
    const changed = workspaceId !== cur.testWorkspaceId;
    if (changed) writeDevMode({ testWorkspaceId: workspaceId, testWorkspacePath: DEV_TEST_WORKSPACE_DIR });
    if (changed || !devTestWorkspaceVerified) {
      try { await api.workspace.rename({ workspaceId, title: '测试工作区（开发者模式）' }); } catch {}
      log(`开发者模式：测试工作区已就绪 -> ${DEV_TEST_WORKSPACE_DIR}`);
    }
    devTestWorkspaceVerified = true;
    return workspaceId;
  }

  function trackDevSession(sessionId) {
    if (!devModeEnabled() || !sessionId) return;
    const cur = readDevMode();
    const id = String(sessionId);
    if (cur.testSessionIds.includes(id)) return;
    writeDevMode({ testSessionIds: [...cur.testSessionIds, id].slice(-500) });
  }

  async function deleteDevTestWorkspace() {
    const d = readDevMode();
    const testIds = new Set(d.testSessionIds);
    if (!d.testWorkspaceId && testIds.size === 0 && !fs.existsSync(DEV_TEST_WORKSPACE_DIR)) {
      return { ok: false, error: '没有测试工作区可删除' };
    }
    let archived = 0;
    let failed = 0;
    for (const sid of testIds) {
      try { await withTimeout(api.stopSessionWork(sid), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); } catch {}
      try {
        await withTimeout(api.workspace.archiveSession({ sessionId: sid }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession');
        archived += 1;
      } catch { failed += 1; }
    }
    // 只清指向测试会话的本地映射：正式会话（开发者模式之前建的）保持不动。
    for (const [key, sid] of Object.entries(state.sessions ?? {})) {
      if (testIds.has(String(sid))) retireSession(key);
    }
    let personaChanged = false;
    for (const rec of personaAgents.values()) {
      const branches = rec.branches || {};
      const keep = {};
      for (const [k, sid] of Object.entries(branches)) {
        if (testIds.has(String(sid))) { personaChanged = true; continue; }
        keep[k] = sid;
      }
      if (personaChanged) rec.branches = keep;
    }
    if (personaChanged) savePersonaAgents();
    for (const sid of testIds) learnerSessions.delete(sid);
    // 会话映射文件（黑话/自我介绍/判定/问候）如果指向测试会话，一起清掉，避免下次复用死会话。
    // 这里按文件名现拼路径，不引用那几个后置 const：它们在 main 后半段才初始化，早期调用会撞 TDZ。
    for (const name of ['slang-session.json', 'self-intro-session.json', 'knowledge-judge-session.json', 'greetings-agent-session.json', 'greetings-desc-session.json']) {
      const file = path.join(STATE_DIR, name);
      try {
        const saved = readJsonSafe(file, null);
        if (saved?.sessionId && testIds.has(String(saved.sessionId))) fs.rmSync(file, { force: true });
      } catch {}
    }
    let workspaceDeleted = false;
    if (d.testWorkspaceId) {
      try {
        await withTimeout(api.workspace.delete({ workspaceId: d.testWorkspaceId }), DSH_CONTROL_TIMEOUT_MS, 'workspace.delete');
        workspaceDeleted = true;
      } catch (error) {
        log(`⚠️ 删除测试工作区失败（DSH 侧）：${error?.message ?? error}`);
      }
    }
    try { fs.rmSync(DEV_TEST_WORKSPACE_DIR, { recursive: true, force: true }); } catch (error) { log(`删除测试工作区目录失败：${error?.message ?? error}`); }
    writeDevMode({ testWorkspaceId: '', testWorkspacePath: '', testSessionIds: [] });
    appendActivity(`开发者模式：测试工作区已删除（归档 ${archived} 个会话）`);
    log(`测试工作区已删除（归档 ${archived} 个会话，失败 ${failed}，DSH 侧删除=${workspaceDeleted}）`);
    return { ok: true, archived, failed, workspaceDeleted, dir: DEV_TEST_WORKSPACE_DIR };
  }

  /** 这个会话是不是开发者模式下登记在测试工作区的会话。 */
  function devTestSessionTracked(sessionId) {
    const sid = String(sessionId || '');
    if (!sid) return false;
    return readDevMode().testSessionIds.includes(sid);
  }

  /** 退役一个运行时会话：停掉在途任务 + 归档；失败只记日志，不阻塞调用方。 */
  async function retireDevStaleSession(sessionId) {
    const sid = String(sessionId || '');
    if (!sid) return false;
    learnerSessions.delete(sid);
    try { await withTimeout(api.stopSessionWork(sid), DSH_CONTROL_TIMEOUT_MS, 'dev stopSessionWork'); } catch {}
    try {
      await withTimeout(api.workspace.archiveSession({ sessionId: sid }), DSH_CONTROL_TIMEOUT_MS, 'dev archiveSession');
    } catch {}
    return true;
  }

  /**
   * 开开发者模式（或重启后恢复开发者模式）时必须先把「旧工作区里那批运行时会话」整体退役。
   *
   * 现场症状：勾选开发者模式后调度系统不往测试工作区派任务 —— 因为人格分支/每群主会话/
   * 黑话学习等后台代理的 sessionId 都还指着正式工作区里早就建好的会话，调度一唤就是旧会话，
   * 测试工作区永远 0 个会话。这里把所有会复用到的映射一次性清掉，逼它们下次按需重建到测试工作区。
   */
  async function resetRuntimeSessionsForDevMode(reason = '开启开发者模式') {
    const retired = new Set();
    // 人格分支 + 人格工作区指针（重建时 ensurePersonaWorkspace 会指向测试工作区）
    let personaChanged = false;
    for (const [role, rec] of personaAgents) {
      if (!rec) continue;
      for (const sid of Object.values(rec.branches || {})) retired.add(String(sid));
      if (Object.keys(rec.branches || {}).length || rec.workspaceId) personaChanged = true;
      rec.branches = {};
      rec.workspaceId = '';
      rec.workspacePath = '';
      personaAgents.set(role, rec);
    }
    if (personaChanged) savePersonaAgents();
    // 每群一个主会话（旧链路）
    for (const key of Object.keys(state.sessions ?? {})) {
      const sid = state.sessions[key];
      if (sid) retired.add(String(sid));
      retireSession(key);
    }
    // 一次性后台代理会话的文件映射（按文件名现拼路径，避免撞后置 const 的 TDZ）
    for (const name of ['slang-session.json', 'self-intro-session.json', 'knowledge-judge-session.json', 'greetings-agent-session.json', 'greetings-desc-session.json']) {
      const file = path.join(STATE_DIR, name);
      try {
        const saved = readJsonSafe(file, null);
        if (saved?.sessionId) retired.add(String(saved.sessionId));
        fs.rmSync(file, { force: true });
      } catch {}
    }
    // 其余登记在 learnerSessions 的后台代理会话
    for (const sid of learnerSessions) retired.add(String(sid));
    learnerSessions.clear();
    let archived = 0;
    for (const sid of retired) {
      try { if (await retireDevStaleSession(sid)) archived += 1; } catch {}
    }
    // 登记表清空：后续重建时会由 trackDevSession 重新记账
    writeDevMode({ testSessionIds: [] });
    log(`开发者模式：${reason}，已退役 ${archived} 个旧运行时会话；后续调度一律派到测试工作区`);
    return { archived, dir: DEV_TEST_WORKSPACE_DIR };
  }

  /**
   * 所有运行时会话的工作区入口。
   * 开发者模式下无论调用方要什么目录，一律挂到同一个测试工作区 —— 这样「一键删除」才有确定的边界，
   * 正式工作区也不会被测试会话污染；关闭开发者模式后恢复原来的「按用途建目录 + 重命名工作区」。
   */
  async function createRunWorkspace(dir, title, label = 'workspace') {
    if (devModeEnabled()) return ensureDevTestWorkspace();
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), `${label} workspace.create`);
    if (wsValue.created && title) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title }); } catch {}
    }
    return wsValue.workspace.workspaceId;
  }

  const personaWorkspacePromises = new Map();
  const personaBranchPromises = new Map();

  async function ensurePersonaWorkspace(role) {
    if (personaWorkspacePromises.has(role)) return personaWorkspacePromises.get(role);
    const promise = ensurePersonaWorkspaceInner(role);
    personaWorkspacePromises.set(role, promise);
    try { return await promise; } finally { personaWorkspacePromises.delete(role); }
  }

  async function ensurePersonaWorkspaceInner(role) {
    const rec = personaAgents.get(role) || { workspaceId: '', workspacePath: '', branches: {} };
    if (!rec.branches) rec.branches = {};
    if (devModeEnabled()) {
      // 开发者模式：人格工作区统一指向测试工作区（旧正式工作区保持原样，随时可回看）。
      const testWs = await ensureDevTestWorkspace();
      if (rec.workspaceId !== testWs || rec.workspacePath !== DEV_TEST_WORKSPACE_DIR) {
        rec.workspaceId = testWs;
        rec.workspacePath = DEV_TEST_WORKSPACE_DIR;
        personaAgents.set(role, rec);
        savePersonaAgents();
        log(`人格工作区（开发者模式）已指向测试工作区：${role}`);
      }
      return rec;
    }
    if (rec.workspaceId) return rec;
    const safeName = sanitizeRoleName(role) || 'persona';
    const dir = path.join(STATE_DIR, 'agents', 'personas', safeName);
    fs.mkdirSync(dir, { recursive: true });
    rec.workspaceId = await createRunWorkspace(dir, '', 'persona');
    rec.workspacePath = dir;
    if (!rec.branches) rec.branches = {};
    personaAgents.set(role, rec);
    savePersonaAgents();
    log(`人格工作区已就绪：${role} -> ${dir}`);
    return rec;
  }

  /** 按人格生成的 preset id（qq-chat-v2-<slug>）；DSH 还没装载时返回空，回退基础 preset。 */
  function personaPresetId(role) {
    const raw = String(role || '');
    const ascii = raw.replace(/[^\w-]/g, '');
    const slug = ascii && ascii === raw ? ascii.toLowerCase() : 'p' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 6);
    const id = `qq-chat-v2-${slug}`;
    return dshPresetIds.includes(id) ? id : '';
  }

  async function ensurePersonaBranch(role, key) {
    const promiseKey = `${role}|${key}`;
    if (personaBranchPromises.has(promiseKey)) return personaBranchPromises.get(promiseKey);
    const promise = ensurePersonaBranchInner(role, key);
    personaBranchPromises.set(promiseKey, promise);
    try { return await promise; } finally { personaBranchPromises.delete(promiseKey); }
  }

  async function ensurePersonaBranchInner(role, key) {
    const rec = await ensurePersonaWorkspace(role);
    const existing = rec.branches?.[key];
    if (existing && devModeEnabled() && !devTestSessionTracked(existing)) {
      log(`开发者模式：人格分支 ${key} 属旧工作区，退役后重建到测试工作区`);
      await retireDevStaleSession(existing);
      delete rec.branches[key];
      savePersonaAgents();
    } else if (existing) {
      const applied = await ensureChatModel(existing);
      if (applied !== 'not-found') return existing;
      delete rec.branches[key];
      savePersonaAgents();
    }
    const perPersona = personaPresetId(role);
    const preset = perPersona || resolvePresetName(cfg.socialV2?.agentPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('没有可用的群聊 preset，无法注册人格分支');
    const value = unwrap(await api.sessions.create({ workspaceId: rec.workspaceId, agentPreset: preset }), 'persona session.create');
    learnerSessions.add(value.sessionId);
    trackDevSession(value.sessionId);
    api.events.follow(value.sessionId);
    await ensureChatModel(value.sessionId);
    const conf = personaRuntimeConf();
    const custom = personaConfigs.get(role) || {};
    if (perPersona) {
      // 系统层模板已在该人格的 preset 里，分支不再重复下发模板。
      log(`人格分支使用专属 preset ${perPersona}（${role} / ${key}），跳过模板下发`);
    } else {
      const personaTemplate = custom.system || conf.personaTemplate;
      const preamble = composeSystemPrompt({
        role,
        personaText: custom.system ? '' : roleRawContent(),
        config: { ...conf, personaTemplate },
        toolAddendum: `本分支只处理 ${key} 的消息。发言用 qq_send_message / qq_reply；只处理系统推送的任务；不要自行设置潜水、睡眠、唤醒。`
      });
      try {
        await api.sessions.prompt({
          sessionId: value.sessionId, mode: 'queue',
          content: [{ type: 'text', text: `【人格模板｜本群分支，仅本次下发】\n\n${preamble}` }]
        });
        await waitLearnerTurn(value.sessionId, 120000);
      } catch (error) {
        log(`人格分支模板下发失败（${role} / ${key}）：${error?.message ?? error}`);
      }
    }
    if (!rec.branches) rec.branches = {};
    rec.branches[key] = value.sessionId;
    savePersonaAgents();
    log(`人格分支已注册：${role} / ${key} -> ${value.sessionId}`);
    return value.sessionId;
  }

  async function resetPersonaBranch(role, key, reason = 'context') {
    const rec = personaAgents.get(role);
    const sessionId = rec?.branches?.[key];
    if (!sessionId) return;
    delete rec.branches[key];
    savePersonaAgents();
    learnerSessions.delete(sessionId);
    try { api.events.forget?.(sessionId); } catch {}
    try { await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); } catch {}
    try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
    log(`人格分支已归档：${role} / ${key}（${reason}）`);
  }

  // ── 专属话题（@ 某人后开启，后续该人的消息都进这个队列） ──────────────
  const personaTopics = new Map();        // topicKey -> {key,userId,sender,role,sessionId,rounds,createdAt,lastAt}
  const personaTopicSendUntil = new Map(); // key -> 允许话题代理发送的截止时间（主会话发言闸门用）
  const personaTopicTimers = new Map();   // topicKey -> 超时定时器
  const personaTopicRunTimers = new Map();// topicKey -> 批处理定时器
  const personaTopicQueues = new Map();   // topicKey -> [msg]
  const personaTopicRunning = new Set();
  const PERSONA_TOPIC_MAX_ROUNDS = 10;
  const PERSONA_TOPIC_TIMEOUT_MS = 10 * 60 * 1000;
  // 结束缓冲：连续两个「安静时段」（每段 3 分钟，无新消息/无相关内容）才真正归档
  const PERSONA_TOPIC_END_BUFFER_MS = 3 * 60 * 1000;
  const PERSONA_TOPIC_BATCH_MS = 30 * 1000; // 该人的消息每 30 秒打包成一批任务
  const personaTopicEndTimers = new Map();
  // 已归档话题的短历史：主会话在话题结束后可能还要判断要不要回这个人的后续发言。
  const personaTopicHistory = new Map();   // key -> [{sessionId,sender,userId,rounds,endedAt,messages}]
  const PERSONA_TOPIC_HISTORY_MS = 30 * 60 * 1000;

  const topicKeyFor = (key, userId) => `${key}#${userId}`;

  function savePersonaTopics() {
    try {
      const obj = {};
      for (const [k, v] of personaTopics) obj[k] = { ...v };
      atomicWriteJson(PERSONA_TOPICS_FILE, obj);
    } catch (error) { log(`保存专属话题失败：${error?.message ?? error}`); }
  }

  function armPersonaTopicTimeout(topic) {
    const old = personaTopicTimers.get(topic.topicKey);
    if (old) clearTimeout(old);
    const remain = Math.max(1000, PERSONA_TOPIC_TIMEOUT_MS - (Date.now() - Number(topic.createdAt || Date.now())));
    const timer = setTimeout(() => { void archivePersonaTopic(topic.topicKey, '超时 10 分钟'); }, remain);
    timer.unref?.();
    personaTopicTimers.set(topic.topicKey, timer);
  }

  async function archivePersonaTopic(topicKey, reason) {
    const topic = personaTopics.get(topicKey);
    if (!topic) return;
    personaTopics.delete(topicKey);
    // 话题历史：归档后主会话仍可能要根据话题内容判断是否回这个人的后续发言。
    try {
      const histState = getSocialV2State(topic.key);
      const seqs = Array.isArray(topic.seqs) ? topic.seqs.slice(-8) : [];
      const messages = seqs.map((seq) => {
        const msg = findV2MessageBySeq(histState, seq);
        return { seq: Number(seq), sender: msg?.sender || topic.sender || '群友', text: msg?.text || msg?.plain || '' };
      });
      const history = personaTopicHistory.get(topic.key) || [];
      history.unshift({
        sessionId: topic.sessionId || '',
        sender: topic.sender || '',
        userId: topic.userId || '',
        rounds: Number(topic.rounds) || 0,
        endedAt: Date.now(),
        messages
      });
      personaTopicHistory.set(topic.key, history.slice(0, 3));
    } catch (error) {
      log(`专属话题历史记录失败：${error?.message ?? error}`);
    }
    for (const map of [personaTopicTimers, personaTopicRunTimers, personaTopicEndTimers]) {
      const timer = map.get(topicKey);
      if (timer) clearTimeout(timer);
      map.delete(topicKey);
    }
    const leftover = personaTopicQueues.get(topicKey) || [];
    personaTopicQueues.delete(topicKey);
    personaTopicRunning.delete(topicKey);
    if (leftover.length) {
      const st = getSocialV2State(topic.key);
      const seqs = new Set(leftover.map((m) => Number(m.seq)));
      st.unread = (st.unread || []).filter((m) => !seqs.has(Number(m.seq)));
      markPersonaHandled(topic.key, [...seqs]);
      saveSocialV2State();
      savePersonaTaskStateNow();
    }
    savePersonaTopics();
    const sid = topic.sessionId;
    if (!sid) { log(`专属话题归档：${topicKey}（${reason}）`); return; }
    learnerSessions.delete(sid);
    try { api.events.forget?.(sid); } catch {}
    try { await withTimeout(api.stopSessionWork(sid), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); } catch {}
    try { await withTimeout(api.workspace.archiveSession({ sessionId: sid }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
    log(`专属话题归档：${topicKey}（${reason}，${topic.rounds} 轮）`);
  }

  async function ensurePersonaTopicSession(topic) {
    if (topic.sessionId) {
      const applied = await ensureChatModel(topic.sessionId);
      if (applied !== 'not-found') return topic.sessionId;
    }
    const rec = await ensurePersonaWorkspace(topic.role);
    const perPersona = personaPresetId(topic.role);
    const preset = perPersona || resolvePresetName(cfg.socialV2?.agentPreset || cfg.agentPreset, { strict: true });
    const value = unwrap(await api.sessions.create({ workspaceId: rec.workspaceId, agentPreset: preset }), 'topic session.create');
    learnerSessions.add(value.sessionId);
    trackDevSession(value.sessionId);
    api.events.follow(value.sessionId);
    await ensureChatModel(value.sessionId);
    if (!perPersona) {
      const custom = personaConfigs.get(topic.role) || {};
      const rtConf = personaRuntimeConf();
      const personaTemplate = custom.system || rtConf.personaTemplate;
      const preamble = composeSystemPrompt({
        role: topic.role,
        personaText: custom.system ? '' : roleRawContent(),
        config: { ...rtConf, personaTemplate },
        toolAddendum: `本会话只处理 ${topic.key} 里「${topic.sender}」的专属话题；最多 ${PERSONA_TOPIC_MAX_ROUNDS} 轮、10 分钟。`
      });
      try {
        await api.sessions.prompt({ sessionId: value.sessionId, mode: 'queue', content: [{ type: 'text', text: `【人格模板｜专属话题会话】\n\n${preamble}` }] });
        await waitLearnerTurn(value.sessionId, 120000);
      } catch (error) { log(`专属话题模板下发失败：${error?.message ?? error}`); }
    }
    try {
      if (typeof api.sessions.rename === 'function') {
        await api.sessions.rename({ sessionId: value.sessionId, title: `${String(topic.key).replace(/^group:/, '')}@${topic.sender}` });
      }
    } catch {}
    topic.sessionId = value.sessionId;
    savePersonaTopics();
    log(`专属话题会话已建立：${topic.topicKey} -> ${value.sessionId}`);
    return value.sessionId;
  }

  async function ensurePersonaTopic(key, userId, sender, role) {
    const topicKey = topicKeyFor(key, userId);
    let topic = personaTopics.get(topicKey);
    if (topic) {
      topic.lastAt = Date.now();
      if (sender) topic.sender = sender;
      if (!Array.isArray(topic.seqs)) topic.seqs = [];
      armPersonaTopicTimeout(topic);
      savePersonaTopics();
      return topic;
    }
    topic = { topicKey, key, userId, sender, role, sessionId: '', rounds: 0, seqs: [], createdAt: Date.now(), lastAt: Date.now() };
    personaTopics.set(topicKey, topic);
    armPersonaTopicTimeout(topic);
    savePersonaTopics();
    log(`专属话题已开启：${topicKey}（人格 ${role}）`);
    return topic;
  }

  function findPersonaTopic(key, userId) {
    const topic = personaTopics.get(topicKeyFor(key, userId));
    if (!topic) return null;
    if (Date.now() - Number(topic.createdAt || 0) > PERSONA_TOPIC_TIMEOUT_MS) { void archivePersonaTopic(topic.topicKey, '超时 10 分钟'); return null; }
    if (Number(topic.rounds) >= PERSONA_TOPIC_MAX_ROUNDS) { void archivePersonaTopic(topic.topicKey, `达到 ${PERSONA_TOPIC_MAX_ROUNDS} 轮`); return null; }
    return topic;
  }

  function buildPersonaTopicPrompt(topic, batch, round, recent = [], recentWindowMs = 10 * 60 * 1000) {
    return composeTopicUserPrompt({ topic, batch, recent, recentWindowMs, round, maxRounds: PERSONA_TOPIC_MAX_ROUNDS });
  }

  function enqueuePersonaTopicMessage(topic, msg) {
    // 有新消息进来 → 结束判定作废，话题继续
    if (topic.endPending) {
      topic.endPending = false;
      topic.endCount = 0;
      const timer = personaTopicEndTimers.get(topic.topicKey);
      if (timer) clearTimeout(timer);
      personaTopicEndTimers.delete(topic.topicKey);
      savePersonaTopics();
      log(`专属话题结束判定作废（有新消息）：${topic.topicKey}`);
    }
    let queue = personaTopicQueues.get(topic.topicKey);
    if (!queue) { queue = []; personaTopicQueues.set(topic.topicKey, queue); }
    queue.push(msg);
    if (queue.length > 20) queue.splice(0, queue.length - 20);
    if (!Array.isArray(topic.seqs)) topic.seqs = [];
    const seq = Number(msg?.seq);
    if (Number.isSafeInteger(seq) && !topic.seqs.includes(seq)) topic.seqs.push(seq);
    if (topic.seqs.length > 40) topic.seqs.splice(0, topic.seqs.length - 40);
    savePersonaTopics();
  }

  function scheduleTopicEndCheck(topicKey, delayMs) {
    if (personaTopicEndTimers.has(topicKey)) clearTimeout(personaTopicEndTimers.get(topicKey));
    const timer = setTimeout(() => {
      personaTopicEndTimers.delete(topicKey);
      void checkTopicEnd(topicKey);
    }, Math.max(1000, delayMs));
    timer.unref?.();
    personaTopicEndTimers.set(topicKey, timer);
  }

  async function checkTopicEnd(topicKey) {
    const topic = personaTopics.get(topicKey);
    if (!topic || !topic.endPending) return;
    topic.endCount = Number(topic.endCount || 0) + 1;
    savePersonaTopics();
    if (topic.endCount >= 2) {
      await archivePersonaTopic(topicKey, '连续两个安静时段，代理判定结束');
      return;
    }
    log(`专属话题结束观察：${topicKey} 第 ${topic.endCount}/2 个安静时段`);
    scheduleTopicEndCheck(topicKey, PERSONA_TOPIC_END_BUFFER_MS);
  }

  function beginTopicEndCountdown(topic) {
    if (topic.endPending) return;
    topic.endPending = true;
    topic.endCount = 0;
    savePersonaTopics();
    log(`专属话题收到结束判定，进入两个安静时段观察：${topic.topicKey}`);
    scheduleTopicEndCheck(topic.topicKey, PERSONA_TOPIC_END_BUFFER_MS);
  }

  function schedulePersonaTopicRun(topicKey, delayMs = 800) {
    if (devOffActive()) return; // 开发者模式完全静默：不排专门话题
    if (personaTopicRunning.has(topicKey)) return;
    if (personaTopicRunTimers.has(topicKey)) clearTimeout(personaTopicRunTimers.get(topicKey));
    const timer = setTimeout(() => {
      personaTopicRunTimers.delete(topicKey);
      void runPersonaTopic(topicKey).catch((error) => log(`专属话题任务失败 ${topicKey}：${error?.message ?? error}`));
    }, Math.max(0, delayMs));
    timer.unref?.();
    personaTopicRunTimers.set(topicKey, timer);
  }

  async function runPersonaTopic(topicKey) {
    if (devOffActive()) return;
    if (personaTopicRunning.has(topicKey)) return;
    const topic = personaTopics.get(topicKey);
    if (!topic) return;
    const queue = personaTopicQueues.get(topicKey) || [];
    if (!queue.length) return;
    personaTopicRunning.add(topicKey);
    const batch = queue.splice(0, Math.max(1, Math.min(6, queue.length)));
    const round = Number(topic.rounds) + 1;
    let sendBefore = 0;
    let replyAtBefore = 0;
    let promptStarted = false;
    personaTopicSendUntil.set(topic.key, Date.now() + personaSpeechConf().topicBypassMs);
    try {
      const sessionId = await ensurePersonaTopicSession(topic);
      sendBefore = sendSuccessCounts.get(sessionId) || 0;
      replyAtBefore = Number(getSocialV2State(topic.key).lastAiReplyAt || 0);
      // 每包附上最近 20 条群聊作为话题语境，重点用于判断发起人前面在聊什么；
      // 本批消息单独列出，不能把语境里的旧消息当成要逐条回复的新任务。
      const batchSeqSet = new Set(batch.map((m) => Number(m.seq)));
      const snapshotConf = personaRuntimeConf();
      const recentSnapshot = buildSnapshot(getSocialV2State(topic.key).recentMessages, {
        seenSeqs: [...batchSeqSet],
        limit: snapshotConf.topicSnapshotLimit,
        maxAgoMs: snapshotConf.topicSnapshotMaxAgeMs,
        now: Date.now()
      });
      const prompt = buildPersonaTopicPrompt(topic, batch, round, recentSnapshot, snapshotConf.topicSnapshotMaxAgeMs);
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
      if (!accepted?.result?.ok) throw new Error(accepted?.result?.error?.message ?? 'prompt 被拒绝');
      promptStarted = true;
      const finalText = await waitLearnerTurn(sessionId, 240000);
      const text = String(finalText ?? '');
      // finalText 只用来判定话题是否该收尾；DONE/TOPIC_* 是控制标记，任何情况都不该当成回话。
      const irrelevant = /TOPIC_IRRELEVANT|TOPIC_END/i.test(text);
      if (text.trim() && controlMarkerOnly(text)) {
        log(`专属话题只返回控制标记（不发送）：${topic.topicKey} ${text.trim().slice(0, 40)}`);
      }
      // 话题代理可能走 MCP 工具，也可能走桥接的 /api/send/*；后者不会进 sendSuccessCounts，
      // 所以必须同时看 lastAiReplyAt。一个 @ + 一次回复只在这里计 1 轮。
      const sent = didTopicReplySend({
        sendCountBefore: sendBefore,
        sendCountAfter: sendSuccessCounts.get(sessionId) || 0,
        replyAtBefore,
        replyAtAfter: Number(getSocialV2State(topic.key).lastAiReplyAt || 0)
      });
      if (sent) topic.rounds = Math.max(Number(topic.rounds) || 0, round);
      topic.lastAt = Date.now();
      savePersonaTopics();
      const seqs = batch.map((m) => Number(m.seq));
      markPersonaHandled(topic.key, seqs);
      const st = getSocialV2State(topic.key);
      const seqSet = new Set(seqs);
      st.unread = st.unread.filter((m) => !seqSet.has(Number(m.seq)));
      saveSocialV2State();
      savePersonaTaskStateNow();
      appendActivity(`${topic.key} [topic] ${topic.sender} 第 ${topic.rounds}/${PERSONA_TOPIC_MAX_ROUNDS} 轮${sent ? '' : '（未发言）'}`);
      if (irrelevant) {
        topic.irrelevantStreak = Number(topic.irrelevantStreak || 0) + 1;
        savePersonaTopics();
        log(`专属话题：第 ${topic.irrelevantStreak}/2 批与本话题无关 ${topic.topicKey}`);
        if (topic.irrelevantStreak >= 2) {
          await archivePersonaTopic(topicKey, '连续两批与本话题无关');
          return;
        }
      } else {
        // 这批被判为「相关」（哪怕选择不发言），连续无关计数清零
        topic.irrelevantStreak = 0;
      }
      if (Number(topic.rounds) >= PERSONA_TOPIC_MAX_ROUNDS) {
        await archivePersonaTopic(topicKey, `达到 ${PERSONA_TOPIC_MAX_ROUNDS} 轮`);
      } else {
        armPersonaTopicTimeout(topic);
      }
    } catch (error) {
      // 超时/异常时先看这一批是否已经真的发出过回复：发过就按一轮收尾，
      // 不能再把同一批塞回队列，否则会重发并多算一轮。
      const sent = promptStarted && didTopicReplySend({
        sendCountBefore: sendBefore,
        sendCountAfter: sendSuccessCounts.get(topic.sessionId) || 0,
        replyAtBefore,
        replyAtAfter: Number(getSocialV2State(topic.key).lastAiReplyAt || 0)
      });
      if (sent) {
        topic.rounds = Math.max(Number(topic.rounds) || 0, round);
        topic.lastAt = Date.now();
        savePersonaTopics();
        const seqs = batch.map((m) => Number(m.seq));
        markPersonaHandled(topic.key, seqs);
        const st = getSocialV2State(topic.key);
        const seqSet = new Set(seqs);
        st.unread = st.unread.filter((m) => !seqSet.has(Number(m.seq)));
        saveSocialV2State();
        savePersonaTaskStateNow();
        appendActivity(`${topic.key} [topic] ${topic.sender} 第 ${topic.rounds}/${PERSONA_TOPIC_MAX_ROUNDS} 轮（已发送，超时收尾）`);
        log(`专属话题已发送但 turn 超时，按一轮收尾不重发 ${topicKey}：${error?.message ?? error}`);
        if (Number(topic.rounds) >= PERSONA_TOPIC_MAX_ROUNDS) {
          await archivePersonaTopic(topicKey, `达到 ${PERSONA_TOPIC_MAX_ROUNDS} 轮`);
        } else {
          armPersonaTopicTimeout(topic);
        }
        return;
      }
      const rest = personaTopicQueues.get(topicKey) || [];
      personaTopicQueues.set(topicKey, [...batch, ...rest]);
      if (/超时|timeout/i.test(String(error?.message ?? error))) {
        try { await withTimeout(api.stopSessionWork(topic.sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); } catch {}
      }
      log(`专属话题失败，消息回队 ${topicKey}：${error?.message ?? error}`);
      setTimeout(() => schedulePersonaTopicRun(topicKey, 3000), 3000).unref?.();
    } finally {
      personaTopicRunning.delete(topicKey);
      personaTopicSendUntil.delete(topic.key);
      if ((personaTopicQueues.get(topicKey) || []).length) schedulePersonaTopicRun(topicKey, 300);
    }
  }

  function loadPersonaTopics() {
    const data = readJsonSafe(PERSONA_TOPICS_FILE, {});
    for (const [topicKey, rec] of Object.entries(data && typeof data === 'object' ? data : {})) {
      if (!rec || typeof rec !== 'object') continue;
      const loaded = { ...rec, topicKey };
      if (!Array.isArray(loaded.seqs)) loaded.seqs = [];
      personaTopics.set(topicKey, loaded);
      armPersonaTopicTimeout(loaded);
    }
  }

  loadPersonaTopics();

  function personaForGroup(key) {
    for (const [role, conf] of personaConfigs) {
      if (conf.groups.includes(key)) return role;
    }
    return '';
  }

  function schedulePersonaRun(key, delayMs) {
    if (devOffActive()) { log(`[dev] 完全静默：跳过人格派发 ${key}`); return; }
    const wait = Number.isFinite(delayMs) ? Math.max(0, delayMs) : Math.max(500, Number(personaRuntimeConf().batchWindowMs) || 1200);
    if (personaRunTimers.has(key)) {
      if (wait > 0) return;
      clearTimeout(personaRunTimers.get(key));
      personaRunTimers.delete(key);
    }
    const timer = setTimeout(() => {
      personaRunTimers.delete(key);
      void runPersonaTasks(key).catch((error) => log(`人格分支任务失败 ${key}：${error?.message ?? error}`));
    }, wait);
    timer.unref?.();
    personaRunTimers.set(key, timer);
  }

  const personaRunningKeys = new Set();
  const personaQueuedKeys = new Set();

  async function runPersonaTasks(key) {
    if (personaRunningKeys.has(key)) { personaQueuedKeys.add(key); return; }
    personaRunningKeys.add(key);
    try {
      await runPersonaTasksInner(key);
    } catch (error) {
      log(`人格分支任务异常，稍后重试 ${key}：${error?.message ?? error}`);
      schedulePersonaRun(key, 8000);
    } finally {
      personaRunningKeys.delete(key);
      if (personaQueuedKeys.delete(key)) schedulePersonaRun(key, 300);
    }
  }

  async function runPersonaTasksInner(key) {
    const conf = personaRuntimeConf();
    if (!personaRuntimeEnabled()) return;
    if (devOffActive()) { log('[dev] 完全静默：不派发人格任务'); return; }
    const role = personaForGroup(key);
    if (!role) {
      log(`系统未把 ${key} 绑定给任何人格，消息不投递`);
      return;
    }
    // 专属话题正在跑时，主会话先等：避免同一批消息在话题代理和主会话里各回一遍。
    if (Number(personaTopicSendUntil.get(key) || 0) > Date.now()) {
      schedulePersonaRun(key, 1500);
      return;
    }
    const st = getSocialV2State(key);
    // 旧链路主会话只要还在，就会和人格分支一起跑；第一次派发时顺手退场（幂等）。
    retireLegacySessionsForPersonaRuntime();
    // 先丢过期任务，再看还剩什么：省得为一批早就过时的消息白建会话/白烧 token。
    discardExpiredPersonaTasks(key, st);
    if (!Array.isArray(st.unread) || !st.unread.length) return;
    const sessionId = await ensurePersonaBranch(role, key);
    // 先出许可，再决定这一包内容：没获许可就不要把任何批次推给模型，
    // 否则模型会为一批“不允许发言”的旧消息白跑一轮；获许可时只取此刻最近的一包。
    const speechDecision = evaluatePersonaSpeech(key);
    if (!speechDecision.allowed) {
      const chanceText = speechDecision.chance == null ? '' : `，散布概率 ${(speechDecision.chance * 100).toFixed(1)}%`;
      log(`主会话发言调度 ${key}：不允许（${speechDecision.kind}，本小时名额剩 ${speechDecision.remainingStarts}${chanceText}），本包不派发`);
      return;
    }
    const statusMap = personaTaskMap(key);
    const tasks = st.unread
      .filter((m) => !isPersonaHandled(key, m.seq))
      .map((m) => {
      const id = `${key}#${m.seq}`;
      const status = statusMap.get(m.seq) || { status: 'pending', claimedBy: '', claimedAt: 0 };
      return { id, seq: m.seq, sender: m.sender, text: status.text || m.text || m.plain, status: status.status, claimedBy: status.claimedBy, claimedAt: status.claimedAt, mention: status.mention === true, messageId: status.messageId || '', userId: status.userId || '', urgent: status.urgent === true };
    });
    const packLimit = computePersonaPackSize({
      base: conf.packBaseSize,
      max: conf.packMaxSize,
      unread: st.unread,
      recent: st.recentMessages,
      now: Date.now()
    });
    // 新消息优先：许可生成后才组包，只把此刻最近的 packLimit 条作为本轮任务；
    // 更早的 pending 任务视为已被新一包覆盖，不再补发，避免回复过时消息。
    const newestFirst = sortTasksNewestFirst(tasks);
    const { claimed } = claimTasks(newestFirst, { agentId: `${role}:${sessionId}`, now: Date.now(), leaseMs: 180000, limit: packLimit });
    if (!claimed.length) return;
    const claimedSeqs = new Set(claimed.map((id) => Number(String(id).split('#').pop())));
    const oldestClaimedSeq = Math.min(...claimedSeqs);
    const superseded = tasks.filter((task) => task.status === 'pending'
      && !claimedSeqs.has(task.seq)
      && Number(task.seq) < oldestClaimedSeq);
    for (const seq of claimedSeqs) {
      const cur = statusMap.get(seq) || {};
      statusMap.set(seq, { ...cur, status: 'processing', claimedBy: `${role}:${sessionId}`, claimedAt: Date.now() });
    }
    if (superseded.length) {
      const supersededSeqs = new Set(superseded.map((task) => Number(task.seq)));
      for (const seq of supersededSeqs) {
        statusMap.set(seq, { ...(statusMap.get(seq) || {}), status: 'done', doneAt: Date.now(), note: '被更新的消息包覆盖' });
        markPersonaHandled(key, [seq]);
      }
      st.unread = st.unread.filter((m) => !supersededSeqs.has(Number(m.seq)));
      appendActivity(`${key} [runtime] 跳过 ${superseded.length} 条更早消息，只派发最近一包`);
    }
    savePersonaTaskState();
    const claimedTasks = tasks.filter((task) => claimedSeqs.has(task.seq)).sort((a, b) => Number(a.seq) - Number(b.seq));
    let memory = [];
    try {
      const q = claimedTasks.map((task) => task.text).join(' ').slice(0, 200);
      if (q) {
        const topK = Math.max(1, Number(cfg.knowledge?.topK ?? 5));
        const hits = await knowledgeStore.search(q, {
          k: Math.max(topK, 8),
          key,
          timeoutMs: Number(cfg.knowledge?.searchTimeoutMs ?? 1500)
        });
        // 与旧路径一致：先多取，再重排（原始群聊片段降权、近期/短事实加权），
        // 有整理过的事实时不注入原始片段；只有自己发言的命中直接丢。
        const reranked = rankHitsForContext(hits);
        const concise = reranked.filter((hit) => !String(hit.text ?? '').startsWith('群聊片段'));
        const picked = dropSelfOnlyMemoryHits(concise.length >= Math.min(2, topK) ? concise : reranked).slice(0, topK);
        memory = picked.map((hit) => ({
          text: hit.text,
          source: hit.source || 'knowledge',
          score: hit.score,
          mode: hit.mode
        }));
      }
    } catch (error) {
      log(`人格分支记忆检索失败：${error?.message ?? error}`);
    }
    // 主会话只拿本轮真正派给它的消息：每条带正文预览，避免只给序号/来源人让模型反复查；
    // 更早的 recentMessages 放到「此前消息」上下文里，明确标成已处理，防止同一段历史被当成新任务重复回复。
    const topicList = [...personaTopics.values()].filter((topic) => topic.key === key);
    const topicSeqSet = new Set();
    for (const topic of topicList) {
      for (const seq of (Array.isArray(topic.seqs) ? topic.seqs : [])) topicSeqSet.add(Number(seq));
    }
    const currentMessages = claimedTasks.map((task) => {
      const msg = findV2MessageBySeq(st, task.seq);
      return {
        seq: Number(task.seq),
        sender: msg?.sender || task.sender || '群友',
        text: msg?.text || msg?.plain || task.text || '',
        inTopic: topicSeqSet.has(Number(task.seq))
      };
    }).filter((m) => m && Number.isSafeInteger(m.seq));
    const currentSeqSet = new Set(currentMessages.map((m) => m.seq));
    const contextMessages = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
      .filter((m) => m && !m.isSelf && Number.isSafeInteger(Number(m.seq)))
      .filter((m) => !currentSeqSet.has(Number(m.seq)) && !topicSeqSet.has(Number(m.seq)))
      .slice(-10)
      .map((m) => ({ seq: Number(m.seq), sender: m.sender || '群友', text: m.text || m.plain || '' }));
    const topics = topicList.map((topic) => ({
      sessionId: topic.sessionId || '',
      sender: topic.sender || '',
      userId: topic.userId || '',
      rounds: Number(topic.rounds) || 0,
      maxRounds: PERSONA_TOPIC_MAX_ROUNDS,
      messages: (Array.isArray(topic.seqs) ? topic.seqs : []).slice(-10).map((seq) => {
        const msg = findV2MessageBySeq(st, seq);
        return { seq: Number(seq), sender: msg?.sender || topic.sender || '群友', text: msg?.text || msg?.plain || '' };
      })
    }));
    const endedTopics = (personaTopicHistory.get(key) || [])
      .filter((item) => item && Date.now() - Number(item.endedAt) < PERSONA_TOPIC_HISTORY_MS)
      .map((item) => ({
        sessionId: item.sessionId || '',
        sender: item.sender || '',
        userId: item.userId || '',
        rounds: Number(item.rounds) || 0,
        endedAgo: Math.round((Date.now() - Number(item.endedAt)) / 60000),
        messages: Array.isArray(item.messages) ? item.messages : []
      }));
    const prompt = composeUserPrompt({
      messages: currentMessages,
      context: contextMessages,
      topics,
      endedTopics,
      memory,
      speech: speechDecision,
      maxMessages: packLimit,
      taskKey: key
    });
    const speechChanceText = speechDecision.kind === 'retained'
      ? '，保留许可 100%'
      : (speechDecision.chance == null ? '' : `，散布概率 ${(speechDecision.chance * 100).toFixed(1)}%`);
    log(`主会话发言调度 ${key}：${speechDecision.allowed ? '允许' : '不允许'}（${speechDecision.kind}，本段剩余 ${speechDecision.remaining}，本小时名额剩 ${speechDecision.remainingStarts}${speechChanceText}）`);
    {
      let set = personaInflightSeqs.get(key);
      if (!set) { set = new Set(); personaInflightSeqs.set(key, set); }
      for (const seq of claimedSeqs) set.add(Number(seq));
      savePersonaTaskStateNow();
    }
    const sendBeforeTurn = sendSuccessCounts.get(sessionId) || 0;
    const batchSeqs = claimedTasks.map((task) => Number(task.seq));
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
      if (!accepted?.result?.ok) throw new Error(accepted?.result?.error?.message ?? 'prompt 被拒绝');
      await waitLearnerTurn(sessionId, 240000);
      for (const seq of claimedSeqs) {
        const cur = statusMap.get(seq) || {};
        statusMap.set(seq, { ...cur, status: 'done', doneAt: Date.now() });
      }
      st.unread = st.unread.filter((m) => !claimedSeqs.has(Number(m.seq)));
      markPersonaHandled(key, [...claimedSeqs]);
      personaInflightSeqs.get(key)?.clear();
      saveSocialV2State();
      savePersonaTaskStateNow();
      appendActivity(`${key} [runtime] 系统投递 ${claimed.length} 条任务给 ${role} 的 ${key} 分支`);
      if (st.unread.length > 0) schedulePersonaRun(key, 300);
      const used = personaContextTokens.get(sessionId) || 0;
      if (shouldRebuildContext(used, conf)) await resetPersonaBranch(role, key, 'context');
    } catch (error) {
      const sentDuringTurn = (sendSuccessCounts.get(sessionId) || 0) > sendBeforeTurn;
      const timedOut = /超时|timeout/i.test(String(error?.message ?? error));
      if (sentDuringTurn || timedOut) {
        // 超时先清掉该会话的排队项/当前 turn，避免它稍后又被 DSH 执行一遍。
        if (timedOut) {
          try { await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); } catch {}
        }
        // turn 超时时 DSH 可能已经执行、只是 turn/end 没及时回来；此时重发同一批任务
        // 会让模型把同一段快照再处理一遍。按项目既有原则「结果未知按已处理算」收尾，
        // 优先不重复刷屏；真正的发送成功仍由 sendSuccessCounts 记录。
        for (const seq of claimedSeqs) {
          const cur = statusMap.get(seq) || {};
          statusMap.set(seq, {
            ...cur,
            status: 'done',
            doneAt: Date.now(),
            note: sentDuringTurn ? 'turn 超时但已发送' : 'turn 超时，按已处理避免重发'
          });
        }
        st.unread = st.unread.filter((m) => !claimedSeqs.has(Number(m.seq)));
        markPersonaHandled(key, [...claimedSeqs]);
        personaInflightSeqs.get(key)?.clear();
        saveSocialV2State();
        savePersonaTaskStateNow();
        log(`人格分支任务${timedOut ? '超时' : '超时但已发送'}，按已处理避免重发 ${key}：seq=${batchSeqs.join(',')}：${error?.message ?? error}`);
        if (st.unread.length > 0) schedulePersonaRun(key, 300);
        return;
      }
      for (const seq of claimedSeqs) {
        const cur = statusMap.get(seq) || {};
        statusMap.set(seq, { ...cur, status: 'pending', claimedBy: '', claimedAt: 0 });
      }
      personaInflightSeqs.get(key)?.clear();
      savePersonaTaskStateNow();
      // 超时/失败时把该会话正在跑的 turn 停掉，避免下一次重试排在它后面造成重复回复。
      try { await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); } catch {}
      log(`人格分支任务失败，回到队列 ${key}：seq=${batchSeqs.join(',')}：${error?.message ?? error}`);
      throw error;
    }
  }

  async function resetPersonaAgent(role = '', reason = 'manual') {
    const targets = role ? [[role, personaAgents.get(role)]] : [...personaAgents.entries()];
    for (const [name, rec] of targets) {
      if (!rec?.branches) continue;
      for (const key of Object.keys(rec.branches)) {
        await resetPersonaBranch(name, key, reason);
      }
      personaAgents.delete(name);
    }
    savePersonaAgents();
  }

  // 默认模板库：首次运行（或模板被清空）时，把当前人格的角色卡作为默认模板
  function seedDefaultPersonaTemplate() {
    const data = readJsonSafe(PERSONA_TEMPLATES_FILE, { templates: [] });
    const list = Array.isArray(data.templates) ? data.templates : [];
    if (list.length) return;
    const current = readRoleState().role;
    if (!current) return;
    const content = roleRawContent();
    if (!content.trim()) return;
    const record = { id: `tpl_default_${sanitizeRoleName(current) || 'persona'}`, name: current, content, updatedAt: Date.now() };
    atomicWriteJson(PERSONA_TEMPLATES_FILE, { templates: [record] });
    log(`默认人格模板已生成：${current}（${content.length} 字符）`);
  }
  seedDefaultPersonaTemplate();

  loadPersonaConfigs();
  loadPersonaTaskState();
  loadPersonaSpeech();


  function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (personaRuntimeEnabled()) return; // 运行时：唤醒全部由系统任务队列调度
    if (devOffActive()) { log(`[dev] 完全静默：跳过计划唤醒 ${key}（${reason}）`); return; }
    if (socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq, at: Date.now() });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReasonV2(key, st)}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  /**
   * 回合结束后补发「繁忙期间暂存」的唤醒原因。
   *
   * 两类原因必须分开处理：
   *   · 消息类（@/关键词/提问/私聊/拍一拍…）只有在那条消息还没被本回合处理掉时才补发
   *     （unread 里还能找到它的 seq）；
   *   · 定时器类（timeout/replyCheck/proactiveCheck/bootstrap/admin）与未读水位无关：
   *     那一轮很可能已经把未读全部标读，用 unread 判断会让「到点唤醒」被静默吞掉 ——
   *     timeout 时 sleepTimer 已被清空，结果是会话停在「sleepUntil 已过期、无任何定时器」。
   */
  function replayPendingWakeReasonsV2(key) {
    const st = getSocialV2State(key);
    if (!Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) return null;
    // 超过 1 小时的暂存唤醒直接抛弃：再补一枪只会把过时的 @/提问重新翻出来。
    // 没有 at 字段的是旧版本状态文件写下的，保留（无法判定年龄）。
    const staleBefore = Date.now() - 60 * 60 * 1000;
    const kept = st.pendingWakeReasons.filter((r) => {
      const at = Number(r?.at || 0);
      return at <= 0 || at >= staleBefore;
    });
    if (kept.length !== st.pendingWakeReasons.length) {
      const droppedCount = st.pendingWakeReasons.length - kept.length;
      st.pendingWakeReasons = kept;
      saveSocialV2State();
      log(`[reserved2] ${key} 丢弃 ${droppedCount} 条超过 1 小时的暂存唤醒`);
    }
    if (!st.pendingWakeReasons.length) return null;
    const item = st.pendingWakeReasons.shift();
    if (!item || typeof item !== 'object') return null;
    if (isTimerWakeReason(item.reason)) {
      if (item.reason === 'timeout') {
        log(`[reserved2] ${key} 补收繁忙期间到期的潜水定时器`);
        setupSleepTimerV2(key);
      } else if (item.reason === 'replyCheck') {
        log(`[reserved2] ${key} 补排繁忙期间的回复检查`);
        scheduleReplyCheckV2(key);
      } else if (item.reason === 'proactiveCheck') {
        // 主动机会有周期性重排，错过一次可接受（也不该在回合结束时立刻补一刀）。
        log(`[reserved2] ${key} 繁忙期间的主动机会已过期，跳过补发`);
      } else {
        log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}`);
        scheduleWakeV2(key, item.reason);
      }
      return { reason: item.reason, action: 'timer' };
    }
    const stillRelevant = Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
    // 必须回应的唤醒（@/私聊/提问/拍一拍）不能因为"未读已清空"就丢掉：未读被清空既可能是
    // 真的答过了，也可能是上轮标读却没答。区别在于水位——seq 在水位以内的消息已经进过某个
    // 回合，重放只会重复轰炸；seq 超过水位的才是"从未被任何回合送到过模型"的那种。
    const beyondWatermark = Number(item.seq) > Number(st.lastUnreadSeq ?? 0);
    if (!stillRelevant && beyondWatermark && isMustAnswerReason(item.reason)) {
      // @/私聊/提问/拍一拍：上一轮可能只是标读了却没答，必须补一次
      log(`[reserved2] ${key} 补发必须回应的唤醒：${item.reason}@seq${item.seq}（上一轮未回应）`);
      scheduleWakeV2(key, item.reason);
      return { reason: item.reason, action: 'replayed-must-answer' };
    }
    if (stillRelevant) {
      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
      scheduleWakeV2(key, item.reason);
      return { reason: item.reason, action: 'replayed' };
    }
    log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
    return { reason: item.reason, action: 'skipped' };
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (personaRuntimeEnabled()) return; // 运行时：不存在人格自设的睡眠
    if (devOffActive()) return; // 开发者模式完全静默：不设睡眠定时器
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等一小段后重新续期，
    // 而不是提前唤醒。这里刻意用 100 秒级的小步长（而不是 24 天的上限）：
    // 每次续期都会用 Date.now() 重新算剩余时间，系统时钟被校正/跳变时能很快纠正过来。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 1000)} 秒后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  let startupSilentWakeDone = false;

  /**
   * 启动静默唤醒：插件完全起来后让 agent 跑一个「不说话」的 turn，
   * 作用是创建/加载会话、工具与人设；桥接端用 silent 投递，绝不发 QQ 消息。
   */
  async function runStartupSilentWake() {
    if (startupSilentWakeDone) return;
    if (currentMode !== 'reserved2' || !dshReady) return;
    if (devOffActive()) {
      startupSilentWakeDone = true;
      log('静默唤醒：完全静默模式跳过');
      return;
    }
    if (personaRuntimeEnabled()) {
      startupSilentWakeDone = true;
      log('静默唤醒：系统调度模式下跳过（无需预建主会话）');
      return;
    }
    if (socialV2.paused || cfg.socialV2?.enabled === false) return;
    // 热重载/控制台重启后的首启：不要发静默唤醒，否则它先占住主会话队列，真消息要排在它后面。
    try {
      if (fs.existsSync(HOT_RELOAD_FLAG)) {
        try { fs.unlinkSync(HOT_RELOAD_FLAG); } catch {}
        log('静默唤醒：本次是热重载首启，跳过（避免阻塞消息队列）');
        return;
      }
    } catch {}
    // 已经有群在等你回复时，静默唤醒没有意义，只会抢队列。
    const pendingUnread = [...socialV2.conversations.values()].some((st) => Array.isArray(st?.unread) && st.unread.length > 0);
    if (pendingUnread) {
      log('静默唤醒：已有未读消息待处理，跳过');
      return;
    }
    const groups = (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : []).map(String).filter(Boolean);
    const owner = cfg.ownerQQ ? String(cfg.ownerQQ) : '';
    // 白名单里每个群都要唤醒一次（不是只叫第一个）；一个群都没有时退回管理员私聊。
    const keys = groups.length ? groups.map((gid) => `group:${gid}`) : (owner ? [`private:${owner}`] : []);
    if (!keys.length) {
      log('静默唤醒：没有可用会话（allow.groups / ownerQQ 都为空），跳过');
      return;
    }
    const hint = roleHintWithPolicies();
    const text = [
      '【静默唤醒】插件刚刚完全启动，这次只是叫你起来确认在线，**不要发任何消息**。',
      '请做三件事：',
      '1) 看一眼当前会话有没有未读（qq_get_unread_messages）；有就快速过一遍，但不要回复；',
      '2) 把已看到的用 qq_mark_read 标到 readThroughSeq 收尾；',
      '3) 按你的判断设置下一次唤醒（qq_set_wake_config），然后直接结束这一轮。',
      '禁止调用任何发送类工具（qq_send_message / qq_send_burst / qq_reply / qq_send_sticker / qq_send_poke），这一轮在 QQ 上必须是静默的。'
    ].join('\n');
    startupSilentWakeDone = true;
    const prompt = (hint ? hint + '\n\n' : '') + text;
    // 逐个错开 1.5s 投递，避免同一瞬间创建多个会话把 DSH 打满；互不阻塞。
    const results = await Promise.allSettled(keys.map((key, index) => new Promise((resolve) => {
      setTimeout(() => {
        deliverPrompt(key, prompt, { silent: true }).then(
          () => { log(`静默唤醒：${key} 的 agent 已启动（未发送任何消息）`); resolve(); },
          (error) => { log(`静默唤醒失败（${key}）：${error?.message ?? error}`); resolve(); }
        );
      }, index * 1500).unref?.();
    })));
    const failed = results.filter((item) => item.status === 'rejected').length;
    if (failed === keys.length && keys.length > 0) startupSilentWakeDone = false;
  }

  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    // 人格运行时：主动机会由任务队列/人格分支处理，旧主会话不再排期。
    if (legacyReserved2PathDisabled()) return;
    if (devOffActive()) return; // 开发者模式完全静默：不排主动机会
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (st.rateLimitRetryTimer) {
      clearTimeout(st.rateLimitRetryTimer);
      st.rateLimitRetryTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      return;
    }
    // 开发者模式「停用调度系统（完全静默）」：QQ 消息不接收、不入未读，群里彻底安静。
    if (devOffActive()) {
      log(`[dev] 完全静默：不接收 QQ 消息 ${key}（来自 ${event.user_id}）`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }


    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          delete state.sessions[key];
          modelAppliedSessions.delete(old);
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          turnLeaseNoted.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await withTimeout(api.stopSessionWork(old), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: old }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；开发者模式 ${devModeEnabled() ? '开' : '关'}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      // /silent 是旧命令，保留为「开发者模式·拦截落盘与发送」的别名；界面在「调试与运维」页。
      if (plainContent === '/dev' || plainContent === '/silent' || plainContent === '/quiet') {
        const next = writeDevMode({ enabled: true, policy: 'guard' });
        log(`管理命令：开发者模式已开启（${devPolicyLabel(next.policy)}）`);
        return; // 开启后所有发送都会被拦截，这里不再尝试回话
      }
      if (plainContent === '/active' || plainContent === '/speak' || plainContent === '/dev-off') {
        writeDevMode({ enabled: false });
        log('管理命令：开发者模式已关闭');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      // 知识采集：只收他人文字消息。自己发的、媒体/表情/转发、命令，都在采集器内部丢掉。
      try {
        knowledgeCollector.feed(key, {
          sender,
          text: plainContent,
          isSelf: String(event.user_id ?? '') === String(event.self_id ?? ''),
          isOwner
        });
      } catch (error) {
        log(`知识采集失败：${error?.message ?? error}`);
      }
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      if (personaRuntimeEnabled()) {
        // 系统只把「绑定给该人格」的白名单群投递过去，其它群不投。
        const roleForGroup = personaForGroup(key);
        if (!roleForGroup) {
          appendActivity(`${key} [runtime] 未绑定人格，忽略：${textContent.slice(0, 60)}`);
          return;
        }
        const stRuntime = getSocialV2State(key);
        const atSelfNow = kind === 'group' && messageMentionsSelf(event, event.self_id);
        const urgent = atSelfNow || quoteTargetIsSelf;
        const seqNow = Number(stRuntime.lastUnreadSeq) || 0;
        const uid = String(event.user_id ?? '');
        const askedBy = kind === 'group' ? (event.sender?.card || event.sender?.nickname || uid) : '私聊';
        if (urgent && seqNow && kind === 'group') {
          // @ / 引用：开启该人的专属话题队列，立即投递给话题会话。
          void (async () => {
            const topic = await ensurePersonaTopic(key, uid, askedBy, roleForGroup);
            enqueuePersonaTopicMessage(topic, { seq: seqNow, text: plainContent, messageId: String(messageRef || ''), mention: true, userId: uid });
            schedulePersonaTopicRun(topic.topicKey, 0);
            appendActivity(`${key} [topic] ${askedBy} 开启/继续专属话题（@）：${textContent.slice(0, 60)}`);
          })().catch((error) => log(`专属话题启动失败 ${key}：${error?.message ?? error}`));
          return;
        }
        if (seqNow && kind === 'group') {
          const topic = findPersonaTopic(key, uid);
          if (topic) {
            enqueuePersonaTopicMessage(topic, { seq: seqNow, text: plainContent, messageId: String(messageRef || ''), mention: false, userId: uid });
            schedulePersonaTopicRun(topic.topicKey, PERSONA_TOPIC_BATCH_MS);
            appendActivity(`${key} [topic] ${askedBy} 的后续消息进入专属话题：${textContent.slice(0, 60)}`);
            return;
          }
        }
        if (seqNow) {
          const taskMap = personaTaskMap(key);
          taskMap.set(seqNow, { status: 'pending', claimedBy: '', claimedAt: 0, urgent: false, mention: false, messageId: String(messageRef || ''), userId: uid, text: plainContent });
        }
        schedulePersonaRun(key);
        appendActivity(`${key} [runtime] 已投递给 ${roleForGroup} 的分支：${textContent.slice(0, 60)}`);
        return;
      }
      const st = getSocialV2State(key);
      // 被 @（或引用机器人）→ 系统直接开一个「群号@人名」临时会话抢答，
      // 主会话不再处理这条，避免排在长回合后面、或和“多人同时叫你”的批处理里互相等。
      const atSelf = kind === 'group' && messageMentionsSelf(event, event.self_id);
      if (atSelf || quoteTargetIsSelf) {
        if (!st.bootstrapSent) {
          st.bootstrapSent = true;
          saveSocialV2State();
        }
        const askedBy = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
        const atSeq = Number(st.lastUnreadSeq) || 0;
        appendActivity(`${key} [reserved2] @ 临时会话回复：${askedBy}`);
        void replyAtMentionFast({
          key, sender: askedBy, textContent, st, messageRef, userId: String(event.user_id ?? '')
        }).then((ok) => {
          if (ok) {
            // 系统接管已读：这条 @ 已由临时会话回掉，从主会话未读里摘掉，避免主会话再回一遍。
            const live = getSocialV2State(key);
            if (Array.isArray(live.unread) && atSeq) {
              live.unread = live.unread.filter((m) => Number(m?.seq) !== atSeq);
              saveSocialV2State();
            }
          } else {
            log(`@ 临时会话失败，退回主会话唤醒 ${key}`);
            scheduleWakeV2(key, 'atMention');
          }
        });
        return;
      }
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          scheduleWakeV2(key, reason);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = roleHintWithPolicies();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef, String(event.user_id ?? '')); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = roleHintWithPolicies();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    const contextText = await withKnowledgeContext(promptText, key);
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await promptWithModelFallback(sessionId, contextText, mediaList);
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ

  /**
   * 把一条 session/event 喂给该会话的 turn collector，并维护 collectors 的生命周期。
   *
   * 两条不变量（都曾被真实故障踩过）：
   *   ① 只为 turn/start 建 collector —— 任何事件都建的话，一条重连后补发的
   *      assistant/message 就会留下永不结束的空 collector，而「会话是否繁忙」正是按
   *      collectors.has() 判断的 ⇒ 这个会话从此再也收不到唤醒；
   *   ② turn/end 即使没有匹配的 turn/start（重连快照没带上）也要清掉已成空壳的
   *      collector，否则同样会永久繁忙。
   */
  function trackTurnEvent(sessionId, event) {
    let collector = collectors.get(sessionId);
    if (!collector && event?.type === 'turn/start') {
      collector = createTurnCollector();
      collectors.set(sessionId, collector);
    }
    const ended = collector ? collector.push(event) : null;
    if (ended) {
      // 回合正常收尾：collector 立刻释放。v2TurnStartAt 留给调用方（无行动判定要用它），
      // 调用方在 `if (ended)` 分支里用完再删。
      collectors.delete(sessionId);
    } else if (event?.type === 'turn/end' && (!collector || collector.size?.() === 0)) {
      collectors.delete(sessionId);
      v2TurnStartAt.delete(sessionId);
      turnLeaseNoted.delete(sessionId);
    }
    return { collector, ended };
  }

  // ── DSH 端口自愈 ───────────────────────────────────────────────────────
  // DSH Desktop 每次启动都换随机端口，config.json 里的 dsh.baseUrl 必然过期：
  // 表现就是控制台显示「DSH 未连接」、bridge.log 每 30 秒一行「事件流已结束（0 帧）」。
  // 这里按 DSH 的特征（401 + "dsh web authentication required"）扫本机监听端口，
  // 命中就把 baseUrl 热切过去（会话 Cookie 按 authority 签名，所以必须重铸）。
  let dshHealing = false;
  let dshHealedAt = 0;

  async function probeDshSignature(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(700)
      });
      if (res.status !== 401) { await res.body?.cancel(); return false; }
      const body = await res.text();
      return body.includes('dsh web authentication required');
    } catch {
      return false;
    }
  }

  function listeningLoopbackPorts() {
    let out = '';
    try {
      out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    } catch (error) {
      log(`（扫本机端口失败：${error?.message ?? error}）`);
      return [];
    }
    const skip = new Set([3000, 3001, 3100, Number(cfg.consolePort) || 0]);
    let currentPort = 0;
    try { currentPort = Number(new URL(api.baseUrl).port) || 0; } catch { currentPort = 0; }
    const ports = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+[^\s]*:(\d+)\s+[^\s]+\s+LISTENING\s/i.exec(line);
      if (!m) continue;
      const port = Number(m[1]);
      if (!port || skip.has(port) || port === currentPort) continue;
      ports.add(port);
    }
    return [...ports];
  }

  async function discoverDshBaseUrl() {
    const ports = listeningLoopbackPorts();
    for (let i = 0; i < ports.length; i += 8) {
      const batch = ports.slice(i, i + 8);
      const hits = await Promise.all(batch.map(async (port) => ((await probeDshSignature(port)) ? port : 0)));
      const found = hits.find((port) => port > 0);
      if (found) return `http://127.0.0.1:${found}`;
    }
    return null;
  }

  function persistDshBaseUrl(baseUrl) {
    try {
      const cfgPath = path.join(ROOT, 'config.json');
      let raw = fs.readFileSync(cfgPath, 'utf8');
      const hadBom = raw.charCodeAt(0) === 0xfeff;
      if (hadBom) raw = raw.slice(1);
      const json = JSON.parse(raw);
      if (String(json?.dsh?.baseUrl ?? '') === baseUrl) return false;
      json.dsh = { ...(json.dsh ?? {}), baseUrl };
      fs.writeFileSync(cfgPath, `${hadBom ? '\ufeff' : ''}${JSON.stringify(json, null, 2)}\n`, 'utf8');
      return true;
    } catch (error) {
      log(`（写回 config.json 失败：${error?.message ?? error}）`);
      return false;
    }
  }

  async function healDshBaseUrl() {
    if (dshHealing) return false;
    if (Date.now() - dshHealedAt < 60 * 1000) return false;   // 一分钟最多扫一次
    dshHealing = true;
    dshHealedAt = Date.now();
    try {
      const found = await discoverDshBaseUrl();
      if (!found || found === api.baseUrl) return false;
      const previous = api.baseUrl;
      api.baseUrl = found;
      api.invalidateAuth();          // Cookie 绑 authority，换端口必须重新铸造
      cfg.dsh.baseUrl = found;
      const written = persistDshBaseUrl(found);
      log(`🔁 DSH 端口变了：${previous} → ${found}（已热切换${written ? '，并写回 config.json' : ''}）`);
      return true;
    } finally {
      dshHealing = false;
    }
  }

  async function pumpMux() {
    // 事件流重连退避：DSH 侧流被立刻关闭时（例如版本不兼容，见 issue #34），
    // 固定 3 秒重连会以每分钟 20 行的速度刷屏，真正有用的错误反而被淹没。
    let retryMs = 3000;
    let failureStreak = 0;
    for (;;) {
      // 连续失败先怀疑「DSH 换端口了」——这是 DSH Desktop 的常态，不自愈的话
      // 控制台会一直显示「DSH 未连接」，QQ 那边也就一直没有任何回复。
      if (failureStreak >= 2) {
        try { await healDshBaseUrl(); } catch (error) {
          log(`（DSH 端口自愈失败：${error?.message ?? error}）`);
        }
      }
      let framesThisStream = 0;
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          framesThisStream += 1;
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            recordSessionUsage(frame.sessionId, frame.event);
            const key = reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                // 与主 collector 同样的道理（issue #26 的补充）：**只有 turn/start 才建** collector。
                // 迟到事件（session/end-seed、session/title、model/selection…）不会有 turn/end，
                // 若在这里顺手建一个，它会永远留在 learnerCollectors 里并吞掉后续 turn 事件，
                // 等待者要么拿不到结果、要么拿到错位的文本。
                let learnerCollector = learnerCollectors.get(frame.sessionId) ?? null;
                if (!learnerCollector && frame.event.type === 'turn/start') {
                  learnerCollector = createTurnCollector();
                  learnerCollectors.set(frame.sessionId, learnerCollector);
                }
                const learnerEnded = learnerCollector ? learnerCollector.push(frame.event) : null;
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  // slang / 自我介绍 / 知识判定 三个专用会话要常驻，否则第二次提问收不到事件
                  if (frame.sessionId !== slangLearnerSessionId && frame.sessionId !== selfIntroSessionId
                    && frame.sessionId !== judgeSessionId) learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!isCurrentSession(key, frame.sessionId)) continue;
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
              turnLeaseNoted.delete(frame.sessionId);
              // 新的一轮开始，上一轮的搜索凭据作废（不允许「上一轮查过」豁免这一轮）
              recentWebSearch.delete(key);
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              // 记下这一轮查过什么：只有查过的轮次，AI 的回复才允许进知识库
              if (WEB_SEARCH_TOOL_RE.test(toolName)) noteWebSearchQuery(key, args);
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              // 搜失败的搜索不算凭据：撤掉刚才记下的那个查询词
              if (resultError && WEB_SEARCH_TOOL_RE.test(toolName)) {
                const list = recentWebSearch.get(key);
                if (list?.length) list.pop();
                if (list && list.length === 0) recentWebSearch.delete(key);
              }
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                    sendSuccessCounts.set(frame.sessionId, (sendSuccessCounts.get(frame.sessionId) || 0) + 1);
                  }
                }
              }
            }
            // collector 生命周期见 trackTurnEvent()：只为 turn/start 建、空壳 turn/end 即清。
            const { ended } = trackTurnEvent(frame.sessionId, frame.event);
            if (ended) {
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const sendToolHit = sendToolSucceededSessions.has(frame.sessionId);
                // turn/start 丢了（重连后由快照补发的回合）就无从判断「这一轮有没有行动」：
                // 此时记 miss 会冤枉 AI，连续 3 次就把 AI 自己设的唤醒配置重置成默认值。
                if (turnStart > 0 || sendToolHit) {
                  const actionTaken = sendToolHit || (turnStart > 0 && st.lastActionAt >= turnStart);
                  if (actionTaken) {
                    st.wakeConfig.noActionCount = 0;
                  } else {
                    st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                    const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                    if (st.wakeConfig.noActionCount >= limit) {
                      log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                      st.wakeConfig = defaultWakeConfigV2();
                      st.bootstrapSent = true;
                      st.wakeConfig.noActionCount = 0;
                    }
                  }
                  saveSocialV2State();
                } else {
                  log(`[reserved2] ${key} 回合结束但缺少 turn/start（重连补发），跳过无行动计数`);
                }
              }
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              turnLeaseNoted.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次（定时器类与消息类语义不同，
              // 详见 replayPendingWakeReasonsV2 的注释）。
              replayPendingWakeReasonsV2(key);
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  // 控制标记（DONE / TOPIC_IRRELEVANT / TOPIC_END）是给系统的信号，不能当聊天内容发出去。
                  // 只看标记、不看长度：模型偶尔整段只回一个「done」，那是回合收尾，不是要说的话。
                  const printable = stripControlMarkers(plain);
                  if (!printable) {
                    log(`回合只返回控制标记，拦截不发送 (${key})：${plain.slice(0, 60)}`);
                    appendActivity(`${key} 控制标记被拦截：${plain.slice(0, 40)}`);
                    continue;
                  }
                  const timeline = planSocialTimeline(printable, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${printable.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social);
                  } else {
                    await sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    if (lastSendSucceeded(key)) {
                      st.lastActiveMessageAt = Date.now();
                      st.lastAiReplyAt = Date.now();
                      log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                    } else {
                      // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
                      // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
                      // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
                      log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
                    }
                  }
                } else if (currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  const printable = stripControlMarkers(plain);
                  if (!printable) {
                    log(`回合只返回控制标记，拦截不发送 (${key})：${plain.slice(0, 60)}`);
                    appendActivity(`${key} 控制标记被拦截：${plain.slice(0, 40)}`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${printable.length} 字`);
                  appendActivity(`${key} agent 回复：${printable.slice(0, 80)}${printable.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, printable);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                // 以前这里只发 QQ、不写日志：出问题时 bridge.log 里什么都没有，排查只能靠猜（PR #24）。
                log(`⚠️ agent 处理出错 (${key})：${safeMsg}`);
                appendActivity(`${key} agent 处理出错：${safeMsg.slice(0, 80)}`);
                await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                log(`⏹️ 回合被中止 (${key})`);
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
        // 流正常关闭（服务端主动断开）不会抛错。以前这里什么都不打，日志看起来
        // 就像「连上了、然后又连一次」，完全看不出 DSH 把流关了。
        log(`DSH 事件流已结束（本次收到 ${framesThisStream} 帧）`);
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：它的 req.on('close') 在事件流
        // 断开时不一定触发，残留租约会用 429 卡住该会话最长 15 分钟的等待工具。
        activeWaits.clear();
      }
      if (framesThisStream > 0) {
        failureStreak = 0;
        retryMs = 3000;
      } else {
        failureStreak += 1;
        retryMs = Math.min(30000, retryMs * 2);
        if (failureStreak === 3) {
          log('⚠️ 连续多次连上 DSH 事件流后一帧都没收到就断开：多半是 DSH 侧事件流协议/版本不匹配'
            + '（可在 DSH 里核对版本，或查看 issue #34）。已改为指数退避重连，不再每 3 秒刷屏。');
        }
      }
      await sleep(retryMs);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    // 统一按字符串比较：网关可能把 id 序列化成 number/string 混用，
    // 用 `===` 漏掉自己发的消息会进入正常处理（reserved2 下 AI 会回答自己 / chat 下可能回复循环）。
    if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (String(event?.sender?.user_id ?? '') === String(event?.self_id ?? '')
      || String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // ── 新人进群打招呼 ─────────────────────────────────────────────────────
  // OneBot 11 的成员变更走 notice：标准名 group_increase，也有实现发 increase
  // （老协议）—— 两个都认，换运行时不会静默失效。
  const greetedRecently = new Map();   // "group:user" -> 时间戳

  function greetingCfg() {
    const g = cfg.greeting ?? {};
    const templates = Array.isArray(g.templates)
      ? g.templates.filter((t) => typeof t === 'string' && t.trim())
      : [];
    return {
      enabled: g.enabled !== false,
      templates: templates.length ? templates : ['欢迎 {name} 进群～'],
      atUser: g.atUser !== false,
      delayMs: Math.max(0, Number(g.delayMs ?? 1500) || 0),
      dedupeMs: Math.max(0, Number(g.dedupeMs ?? 60000) || 0),
      maxPerHour: Math.max(0, Number(g.maxPerHour ?? 20) || 0)
    };
  }

  function greetingAllowed(groupId) {
    if ((cfg.deny?.groups ?? []).includes(groupId)) return false;
    const allow = cfg.allow?.groups ?? [];
    if (allow.length) return allow.includes(groupId);
    return cfg.allowAllWhenEmpty === true;
  }

  async function handleGroupIncrease(event) {
    const g = greetingCfg();
    if (!g.enabled) return;
    const groupId = String(event?.group_id ?? '');
    const userId = String(event?.user_id ?? '');
    if (!groupId || !userId) return;
    if (userId === String(event?.self_id ?? '')) return;      // 自己进群不招呼
    if (!greetingAllowed(groupId)) return;

    const stamp = Date.now();
    const dedupeKey = `${groupId}:${userId}`;
    for (const [k, t] of greetedRecently) {
      if (stamp - t > 10 * 60 * 1000) greetedRecently.delete(k);
    }
    if (g.dedupeMs && stamp - (greetedRecently.get(dedupeKey) ?? 0) < g.dedupeMs) {
      log(`进群招呼：${dedupeKey} 刚招呼过，跳过（重连补发/反复入群）`);
      return;
    }
    if (g.maxPerHour) {
      let recent = 0;
      for (const t of greetedRecently.values()) if (stamp - t < 60 * 60 * 1000) recent += 1;
      if (recent >= g.maxPerHour) {
        log(`进群招呼已达每小时上限（${g.maxPerHour}），跳过 ${dedupeKey}`);
        return;
      }
    }
    greetedRecently.set(dedupeKey, stamp);

    let name = '';
    try {
      const info = await withTimeout(
        bot.getGroupMemberInfo(Number(groupId), Number(userId)),
        5000, '取群成员信息');
      name = String(info?.card || info?.nickname || '').trim();
    } catch (error) {
      log(`进群招呼：读成员信息失败（${error?.message ?? error}），用 QQ 号代替`);
    }
    if (!name) name = userId;

    const tpl = g.templates[Math.floor(Math.random() * g.templates.length)];
    const body = tpl.replace(/\{name\}/g, name).replace(/\{qq\}/g, userId);
    if (g.delayMs) await sleep(g.delayMs);

    // ⚠️ SDK 的 MessageChain 是**不可变**的：每个 .at()/.text() 都返回新链，
    // 必须接住返回值，否则发出去的是一条空消息（实测踩过）。
    let parts = chain();
    if (g.atUser) parts = parts.at(Number(userId)).text(' ');
    parts = parts.text(body);
    try {
      if (devModeEnabled()) devInterceptSend('send_group_msg', `group:${groupId}`, '进群招呼');
      else await bot.sendGroupMessage(Number(groupId), parts);
      log(`进群招呼：已在 ${groupId} 招呼 ${name}（${userId}）`);
      appendActivity(`${groupId} 进群招呼 ${name}`);
    } catch (error) {
      log(`进群招呼发送失败（${dedupeKey}）：${error?.message ?? error}`);
    }
  }

  // ── 自己（bot）进群时向群里打招呼 ──────────────────────────────────────
  // 和上面的「新人进群招呼」是两回事：这里触发的是 **self_id 自己** 入群。
  // 双保险：notice/group_increase（自己）立即说；另外启动和定期扫 get_group_list，
  // 把「离线时被拉进群」这种错过事件的情况补上。
  let selfIntroTimer = null;
  const greetedGroupsPath = path.join(STATE_DIR, 'greeted-groups.json');
  const greetedGroups = readJsonSafe(greetedGroupsPath, {}) ?? {};
  let selfIntroScanning = false;

  function saveGreetedGroups() {
    try {
      fs.writeFileSync(greetedGroupsPath, JSON.stringify(greetedGroups, null, 2), 'utf8');
    } catch (error) {
      log(`（写 greeted-groups.json 失败：${error?.message ?? error}）`);
    }
  }

  function selfIntroCfg() {
    const c = cfg.selfIntro ?? {};
    const templates = Array.isArray(c.templates)
      ? c.templates.filter((t) => typeof t === 'string' && t.trim())
      : [];
    return {
      enabled: c.enabled !== false,
      onlyOnJoin: c.onlyOnJoin === true,
      anyGroup: c.anyGroup !== false,
      mode: c.mode === 'template' ? 'template' : 'llm',
      maxChars: Math.max(10, Math.min(200, Number(c.maxChars ?? 50) || 50)),
      llmTimeoutMs: Math.max(5000, Number(c.llmTimeoutMs ?? 20000) || 20000),
      image: String(c.image ?? '').trim(),
      delayMs: Math.max(0, Number(c.delayMs ?? 3000) || 0),
      scanIntervalMs: Math.max(60 * 1000, Number(c.scanIntervalMs ?? 600000) || 600000),
      templates
    };
  }

  // ── 自我介绍文案：走 DSH 模型现写，写不出来就退回模板 ─────────────────
  // 单独开一个「自我介绍会话」，加进 learnerSessions —— 这样它的事件只被收集，
  // 绝不会被当成某个 QQ 会话的回复转发出去。
  const SELF_INTRO_SESSION_FILE = path.join(STATE_DIR, 'self-intro-session.json');
  let selfIntroSessionId = null;

  async function ensureSelfIntroSession() {
    if (selfIntroSessionId) return selfIntroSessionId;
    const saved = readJsonSafe(SELF_INTRO_SESSION_FILE, null);
    if (saved?.sessionId) {
      selfIntroSessionId = String(saved.sessionId);
      learnerSessions.add(selfIntroSessionId);
      api.events.follow(selfIntroSessionId);
      return selfIntroSessionId;
    }
    const dir = path.join(STATE_DIR, 'self-intro-agent');
    const workspaceId = await createRunWorkspace(dir, '', 'intro');
    // ⚠️ 必须走和 QQ 会话同一套 preset 解析：
    //   1) 人格/角色卡都挂在 preset 上，不传就等于让模型裸答（第一次就是这么错的）；
    //   2) 群名、群名片会被我塞进 prompt，等于半个注入入口 —— 绝不能落到
    //      DSH 默认 preset（带 bash/文件读写），否则群名可以驱动本机命令。
    //   modePreset 用了 strict 解析：拿不到安全 preset 就返回 undefined，这里直接放弃建会话。
    const preset = cfg.selfIntro?.agentPreset
      ? resolvePresetName(cfg.selfIntro.agentPreset, { strict: true })
      : modePreset(null, currentMode, cfg);
    if (!preset) {
      throw new Error('没有可用的群聊 preset，拒绝用 DSH 默认 preset 生成自我介绍（fail-closed）');
    }
    const params = { workspaceId, agentPreset: preset };
    const value = unwrap(await api.sessions.create(params), 'intro session.create');
    trackDevSession(value.sessionId);
    selfIntroSessionId = value.sessionId;
    learnerSessions.add(selfIntroSessionId);
    api.events.follow(selfIntroSessionId);
    await ensureChatModel(selfIntroSessionId);
    atomicWriteJson(SELF_INTRO_SESSION_FILE, { sessionId: selfIntroSessionId });
    log(`自我介绍会话已创建：${selfIntroSessionId}（preset: ${preset}）`);
    return selfIntroSessionId;
  }

  // ── 知识判定会话：给「来源支不支持这句话」一个答案 ──────────────────────
  // 和自我介绍同一套范式：独立会话 + 加进 learnerSessions，事件只被收集，
  // 绝不会被当成 QQ 会话的回复发出去。
  const JUDGE_SESSION_FILE = path.join(STATE_DIR, 'knowledge-judge-session.json');
  let judgeSessionId = null;

  async function ensureJudgeSession() {
    if (judgeSessionId) return judgeSessionId;
    const saved = readJsonSafe(JUDGE_SESSION_FILE, null);
    if (saved?.sessionId) {
      judgeSessionId = String(saved.sessionId);
      learnerSessions.add(judgeSessionId);
      api.events.follow(judgeSessionId);
      return judgeSessionId;
    }
    const dir = path.join(STATE_DIR, 'knowledge-judge-agent');
    const workspaceId = await createRunWorkspace(dir, '', 'judge');
    // 判定会话不产生任何对外内容，但仍必须走安全 preset：
    // 判定提示里塞着群聊原文，落到带 bash/文件读写的默认 preset 就是可执行注入面。
    const judgeCfg = cfg.knowledge?.autoApprove?.verify?.judge ?? {};
    const preset = judgeCfg.agentPreset
      ? resolvePresetName(judgeCfg.agentPreset, { strict: true })
      : modePreset(null, currentMode, cfg);
    if (!preset) {
      throw new Error('没有可用的群聊 preset，拒绝用 DSH 默认 preset 做知识判定（fail-closed）');
    }
    const value = unwrap(await api.sessions.create({
      workspaceId, agentPreset: preset
    }), 'judge session.create');
    trackDevSession(value.sessionId);
    judgeSessionId = value.sessionId;
    learnerSessions.add(judgeSessionId);
    api.events.follow(judgeSessionId);
    await ensureChatModel(judgeSessionId);
    atomicWriteJson(JUDGE_SESSION_FILE, { sessionId: judgeSessionId });
    log(`知识判定会话已创建：${judgeSessionId}（preset: ${preset}）`);
    return judgeSessionId;
  }

  function resetJudgeSession() {
    const old = judgeSessionId;
    judgeSessionId = null;
    if (old) learnerSessions.delete(old);
    try { fs.unlinkSync(JUDGE_SESSION_FILE); } catch {}
  }

  async function askJudgeSession(promptText, timeoutMs) {
    const sessionId = await ensureJudgeSession();
    const accepted = await api.sessions.prompt({
      sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }]
    });
    if (!accepted?.result?.ok) {
      throw new Error(`判定会话拒绝 prompt：${accepted?.result?.error?.message ?? '未知'}`);
    }
    return waitLearnerTurn(sessionId, timeoutMs);
  }

  /** verifier 调它：模型判定为主，不可用时规则兜底（绝不因判定失败而放行）。 */
  async function judgeKnowledge(args) {
    return knowledgeJudge.judge(args);
  }

  // ── 审批代理 worker：读带编号的采集包，用工具提交「保留/剥离/拒绝」 ────────
  // 会话按 slot 复用（上限 maxWorkers），用满 8 次就换新会话，防止上下文无限膨胀。
  const APPROVER_SESSION_REUSE = 8;
  const approverWorkers = new Map(); // slot -> { sessionId, uses }

  async function ensureApproverWorkerSession(slot) {
    const current = approverWorkers.get(slot);
    if (current?.sessionId && current.uses < APPROVER_SESSION_REUSE) return current;
    if (current?.sessionId) {
      learnerSessions.delete(current.sessionId);
      approverWorkers.delete(slot);
    }
    const dir = path.join(STATE_DIR, 'knowledge-approver-agent', `worker-${slot}`);
    const workspaceId = await createRunWorkspace(dir, '', 'approver');
    // 判定/审批会话都塞着群聊原文：必须走安全 preset，落到默认 preset 就是可执行注入面
    const agentCfg = cfg.knowledge?.autoApprove?.agent ?? {};
    const preset = agentCfg.preset
      ? resolvePresetName(agentCfg.preset, { strict: true })
      : modePreset(null, currentMode, cfg);
    if (!preset) {
      throw new Error('没有可用的群聊 preset，拒绝用默认 preset 跑审批代理（fail-closed）');
    }
    const value = unwrap(await api.sessions.create({
      workspaceId, agentPreset: preset
    }), 'approver session.create');
    trackDevSession(value.sessionId);
    const entry = { sessionId: value.sessionId, uses: 0 };
    approverWorkers.set(slot, entry);
    learnerSessions.add(value.sessionId);
    api.events.follow(value.sessionId);
    await ensureChatModel(value.sessionId);
    log(`审批代理会话已创建：${value.sessionId}（slot ${slot}，preset: ${preset}）`);
    return entry;
  }

  async function createApproverWorker({ id, batch, options }) {
    const slot = ((Number(String(id ?? '').replace(/[^0-9]/g, '')) || 1) - 1) % Math.max(1, options.maxWorkers);
    const worker = await ensureApproverWorkerSession(slot);
    worker.uses += 1;
    // 事件循环在 turn 结束时会把非「常驻」学习会话从集合里删掉；这里补登记，
    // 否则同一个 worker 的第二个 batch 再也收不到 turn/end（只能等 180s 超时）。
    learnerSessions.add(worker.sessionId);
    const submitsBefore = approverToolSubmits;
    const packs = batch.map((pack) => ({
      ...pack,
      lines: knowledgeStore.get(pack.id)?.lines ?? pack.lines ?? null
    }));
    const token = issueApproverToken(worker.sessionId, {
      batchId: id,
      packIds: packs.map((pack) => pack.id)
    });
    const promptText = buildAgentPrompt({ packs, batchTag: id });
    const accepted = await api.sessions.prompt({
      sessionId: worker.sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }]
    });
    if (!accepted?.result?.ok) {
      throw new Error(`审批代理会话拒绝 prompt：${accepted?.result?.error?.message ?? '未知'}`);
    }
    let finalText = '';
    try {
      finalText = await waitLearnerTurn(worker.sessionId, options.turnTimeoutMs);
    } catch (error) {
      log(`审批代理 ${id} 等待 turn 超时：${error?.message ?? error}`);
    }
    // 没有工具提交 → 用一条极短的提醒再催一次（长提示词里模型倾向写 JSON/散文，短提示词成功率高）
    if (approverToolSubmits === submitsBefore) {
      log(`审批代理 ${id}：本轮没有工具提交，发送短提醒重试一次`);
      try {
        const ids = packs.map((pack) => pack.id).join('、');
        const retryText = `【提醒】上一轮没有用工具提交任何裁决。请立刻对包 ${ids} 调用 mcp__snowluma__qq_knowledge_approver_verdict（id 用包 ID），逐包提交 keep/reject；不要输出 JSON，不要解释。`;
        const retryAccepted = await api.sessions.prompt({ sessionId: worker.sessionId, mode: 'queue', content: [{ type: 'text', text: retryText }] });
        if (retryAccepted?.result?.ok) {
          try { finalText = await waitLearnerTurn(worker.sessionId, 90000); } catch (error) { log(`审批代理 ${id} 重试等待超时：${error?.message ?? error}`); }
        }
      } catch (error) {
        log(`审批代理 ${id} 重试失败：${error?.message ?? error}`);
      }
    }
    approverTokens.delete(token);
    // 工具没调成（或模型直接输出 JSON）时兜底解析；两路都无效就留着下一轮
    const fallbackVerdicts = parseVerdicts(finalText);
    if (fallbackVerdicts.length) {
      log(`审批代理 ${id}：没有工具提交，按回复里的 JSON 兜底解析出 ${fallbackVerdicts.length} 条`);
    } else {
      // 没有裁决时要能看出代理到底回了什么：是没调工具、还是调了但失败
      log(`审批代理 ${id} 没返回裁决，回复片段：${String(finalText ?? '').replace(/\s+/g, ' ').slice(0, 240) || '（空）'}`);
    }
    for (const verdict of fallbackVerdicts) {
      try {
        await applyApproverVerdict({ ...verdict }, { skipToken: true });
      } catch (error) {
        log(`审批代理 ${id} 应用裁决失败：${error?.message ?? error}`);
      }
    }
    const left = batch.filter((pack) => knowledgeStore.get(pack.id)?.status === 'pending').length;
    if (left) log(`审批代理 ${id}：${batch.length} 包中还有 ${left} 包未裁决，等下一轮`);
    return { left };
  }

  /**
   * 应用一条裁决。keep 可以用 keepLines 只保留相关行（重写成干净的一条）；
   * 违禁词闸门在这里再扫一遍——代理被内容带偏也不能把敏感内容放进来。
   */
  async function applyApproverVerdict(body = {}, { skipToken = false } = {}) {
    if (!skipToken && !approverTokenOk(body.token)) {
      return { ok: false, error: '审批令牌无效或已过期（审批工具只对审批代理开放）' };
    }
    const id = String(body.id ?? '');
    const item = knowledgeStore.get(id);
    if (!item) return { ok: false, error: `条目不存在：${id}` };
    if (item.status !== 'pending') return { ok: true, skipped: true, id, status: item.status };
    if (item.autoBlocked) return { ok: false, error: '该条命中违禁词，代理不能放行（需人工处理）' };
    const verdict = String(body.verdict ?? '').toLowerCase();
    if (verdict === 'reject' || verdict === 'drop') {
      const reason = String(body.reason ?? '代理判断为闲聊/无信息量').slice(0, 200);
      knowledgeStore.reject(id, `代理拒绝：${reason}`);
      return { ok: true, id, status: 'rejected' };
    }
    if (verdict !== 'keep' && verdict !== 'approve') {
      return { ok: false, error: 'verdict 只能是 keep（保留）或 reject（拒绝）' };
    }
    let text = String(body.text ?? '').trim();
    if (!text) text = rebuildPackText(item, Array.isArray(body.keepLines) ? body.keepLines : []);
    if (text.length < 6) {
      return { ok: false, error: '剥离后没有可入库内容（改用 verdict=reject）' };
    }
    try {
      const scan = scanKnowledgeItem({ text, tags: item.tags });
      if (scan?.blocked) {
        knowledgeStore.markBlocked(id, { hits: scan.hits, reason: 'approver-rewrite' });
        return { ok: false, error: '改写后的内容命中违禁词，已拦截' };
      }
    } catch (error) {
      log(`审批代理改写扫描失败：${error?.message ?? error}`);
    }
    const patch = { text };
    if (Array.isArray(body.tags) && body.tags.length) patch.tags = body.tags;
    const result = await knowledgeStore.approve(id, patch);
    if (!result.ok) return result;
    log(`审批代理：${id} 放行${result.embedded ? '（已向量化）' : ''}：${text.slice(0, 60)}`);
    return { ok: true, id, status: 'approved', embedded: result.embedded };
  }

  // ── 定时问候的「人格分支」：生成问候包体（文字，图片由桥接从图池配） ──────
  let greetingsSessionId = null;

  async function ensureGreetingsSession() {
    if (greetingsSessionId) return greetingsSessionId;
    const saved = readJsonSafe(GREETINGS_SESSION_FILE, null);
    if (saved?.sessionId) {
      greetingsSessionId = String(saved.sessionId);
      learnerSessions.add(greetingsSessionId);
      api.events.follow(greetingsSessionId);
      return greetingsSessionId;
    }
    const dir = path.join(STATE_DIR, 'greetings-agent');
    const workspaceId = await createRunWorkspace(dir, '', 'greetings');
    // 和自我介绍一致：必须落在群聊安全 preset 上，拿不到就 fail-closed，
    // 绝不回落到带 bash/文件读写的 DSH 默认 preset。
    const genPreset = cfg.greetings?.generate?.preset;
    const preset = genPreset ? resolvePresetName(genPreset, { strict: true }) : modePreset(null, currentMode, cfg);
    if (!preset) throw new Error('没有可用的群聊 preset，拒绝生成问候语（fail-closed）');
    const value = unwrap(await api.sessions.create({ workspaceId, agentPreset: preset }), 'greetings session.create');
    trackDevSession(value.sessionId);
    greetingsSessionId = value.sessionId;
    learnerSessions.add(greetingsSessionId);
    api.events.follow(greetingsSessionId);
    await ensureChatModel(greetingsSessionId);
    atomicWriteJson(GREETINGS_SESSION_FILE, { sessionId: greetingsSessionId });
    log(`问候生成会话已创建：${greetingsSessionId}（preset: ${preset}）`);
    return greetingsSessionId;
  }

  let greetingsDescSessionId = null;

  /** 看图描述用独立会话：只做图片含义，别把问候生成的上下文搅乱。 */
  async function ensurePoolDescSession() {
    if (greetingsDescSessionId) return greetingsDescSessionId;
    const saved = readJsonSafe(GREETINGS_DESC_SESSION_FILE, null);
    if (saved?.sessionId) {
      greetingsDescSessionId = String(saved.sessionId);
      learnerSessions.add(greetingsDescSessionId);
      api.events.follow(greetingsDescSessionId);
      return greetingsDescSessionId;
    }
    const dir = path.join(STATE_DIR, 'greetings-desc-agent');
    const workspaceId = await createRunWorkspace(dir, '', 'greetings-desc');
    const genPreset = cfg.greetings?.generate?.preset;
    const preset = genPreset ? resolvePresetName(genPreset, { strict: true }) : modePreset(null, currentMode, cfg);
    if (!preset) throw new Error('没有可用的群聊 preset，拒绝看图描述（fail-closed）');
    const value = unwrap(await api.sessions.create({ workspaceId, agentPreset: preset }), 'greetings-desc session.create');
    trackDevSession(value.sessionId);
    greetingsDescSessionId = value.sessionId;
    learnerSessions.add(greetingsDescSessionId);
    api.events.follow(greetingsDescSessionId);
    await ensureChatModel(greetingsDescSessionId);
    atomicWriteJson(GREETINGS_DESC_SESSION_FILE, { sessionId: greetingsDescSessionId });
    log(`问候图池描述会话已创建：${greetingsDescSessionId}（preset: ${preset}）`);
    return greetingsDescSessionId;
  }

  let poolDescJob = null;

  /** 后台补图片含义：同一时刻只跑一份，生成问候时最多等它 90 秒。 */
  function describePoolInBackground() {
    if (poolDescJob) return poolDescJob;
    const missing = greetingImagePool().filter((item) => item.path && !item.desc);
    if (!missing.length) return Promise.resolve(0);
    poolDescJob = ensurePoolDescriptions(missing).finally(() => { poolDescJob = null; });
    return poolDescJob;
  }

  /** 图池里没描述过的图，先让模型看图写一句含义（结果持久化，之后不再重复）。 */
  async function ensurePoolDescriptions(pool) {
    const missing = pool.filter((item) => item.path && !item.desc);
    if (!missing.length) return 0;
    const sessionId = await ensurePoolDescSession();
    learnerSessions.add(sessionId);
    const mimeOf = (file) => {
      const ext = path.extname(file).toLowerCase();
      if (ext === '.png') return 'image/png';
      if (ext === '.gif') return 'image/gif';
      if (ext === '.webp') return 'image/webp';
      return 'image/jpeg';
    };
    const described = [];
    const batchSize = Math.max(1, Math.min(MAX_MEDIA_COUNT, 5));
    for (let start = 0; start < missing.length; start += batchSize) {
      const batch = missing.slice(start, start + batchSize);
      const content = [{ type: 'text', text: buildDescribePoolPrompt(batch) }];
      let bytes = 0;
      for (const item of batch) {
        let buf;
        try { buf = fs.readFileSync(resolveGreetingImage(item.path)); } catch { continue; }
        const prep = await toModelMedia(buf, mimeOf(item.path), item.path);
        if (!prep?.ok) continue;
        if (bytes + prep.buffer.length > MAX_MEDIA_BYTES) break;
        bytes += prep.buffer.length;
        content.push({ type: 'text', text: `[${content.filter((part) => part.type === 'image').length + 1}] ${item.path}` });
        content.push({
          type: 'image',
          mediaType: prep.mimeType,
          data: prep.buffer.toString('base64'),
          name: item.path.split('/').pop()
        });
      }
      if (content.filter((part) => part.type === 'image').length === 0) continue;
      try {
        const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
        if (!accepted?.result?.ok) continue;
        const output = await waitLearnerTurn(sessionId, 240000);
        for (const item of parsePoolDescriptions(output, { allowed: batch })) {
          const notes = greetingPoolNotes();
          notes[item.path] = item.desc;
          saveGreetingPoolNotes(notes);
          described.push(item);
        }
      } catch (error) {
        log(`问候图池看图描述失败：${error?.message ?? error}`);
      }
    }
    if (described.length) log(`问候图池：自动补写 ${described.length} 条图片含义（用于按文字配图）`);
    return described.length;
  }

  /** 人格分支生成问候 → 配图 → 入库。返回新增条目。 */
  async function generateGreetings({ count, slots, style } = {}) {
    const conf = greetingConfig();
    const want = Math.max(1, Math.min(30, Number(count) || conf.generate.count));
    const sessionId = await ensureGreetingsSession();
    // turn 结束后事件循环会把非常驻学习会话移出集合，这里补登记再提问
    learnerSessions.add(sessionId);
    const existing = greetingStore.entries().map((entry) => entry.text);
    let pool = greetingImagePool();
    await Promise.race([
      describePoolInBackground(),
      new Promise((resolve) => setTimeout(() => resolve(0), 90000))
    ]);
    pool = greetingImagePool();
    const promptText = (roleHintWithPolicies() ? roleHintWithPolicies() + '\n\n' : '')
      + buildGeneratePrompt({ count: want, slots, style: style ?? conf.generate.style, avoid: existing, pool });
    const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
    if (!accepted?.result?.ok) throw new Error(`问候生成会话拒绝 prompt：${accepted?.result?.error?.message ?? '未知'}`);
    const output = await waitLearnerTurn(sessionId, 240000);
    const generated = parseGeneratedGreetings(output, { limit: want });
    if (!generated.length) throw new Error(`没解析出问候语，模型输出片段：${String(output ?? '').slice(0, 160)}`);

    const known = new Set(existing.map((text) => text.trim()));
    const picked = generated.filter((item) => !known.has(item.text));
    if (!picked.length) throw new Error('生成的问候语与已有条目全部重复，未新增');
    // 配图：模型按文字意思选的优先，没选/选错按贴合度兜底，对不上就留空（不随机）。
    const assignment = matchPoolImages(pool, picked);
    const added = [];
    for (let i = 0; i < picked.length; i += 1) {
      const item = picked[i];
      known.add(item.text);
      added.push(greetingStore.upsert({
        id: `g_${crypto.randomBytes(5).toString('hex')}`,
        slot: item.slot,
        text: item.text,
        imagePath: assignment.images[i],
        enabled: true
      }));
    }
    const plain = added.filter((entry) => !entry.imagePath).length;
    const warning = assignment.empty
      ? '图池是空的：先到「图片池」上传图片，否则发出去没有配图'
      : (plain ? `${plain} 条文字和图池里的图都不贴合，已留空（只发文字）` : '');
    log(`问候生成：新增 ${added.length} 条（配图 ${assignment.assigned} 条，图池 ${assignment.poolSize} 张，按文字贴合度挑选）`);
    return { added, warning, reply: String(output ?? '').slice(0, 200) };
  }

  function resetSelfIntroSession() {
    const old = selfIntroSessionId;
    selfIntroSessionId = null;
    if (old) learnerSessions.delete(old);
    try { fs.unlinkSync(SELF_INTRO_SESSION_FILE); } catch {}
  }

  /** 把模型输出收拾成一条能直接发的短句：去代码块/多行/包裹引号，按字数截断。 */
  function cleanIntroText(raw, maxChars) {
    let s = String(raw ?? '')
      .replace(/```[\s\S]*?```/g, ' ')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
    s = s.replace(/^[\s"'“”‘’「」『』]+/, '').replace(/[\s"'“”‘’「」『』]+$/, '');
    s = s.replace(/^(好的|好|嗯)[，,、:：]\s*/, '');
    s = s.replace(/\s+/g, '');
    const chars = [...s];
    return chars.length > maxChars ? chars.slice(0, maxChars).join('') : s;
  }

  async function generateIntroText(gid) {
    const c = selfIntroCfg();
    if (!dshReady) { log('自我介绍：DSH 未就绪，改用模板'); return ''; }
    let groupName = '';
    let memberCount = 0;
    try {
      const info = await withTimeout(bot.getGroupInfo(Number(gid)), 6000, '取群信息');
      groupName = String(info?.group_name ?? info?.groupName ?? '');
      memberCount = Number(info?.member_count ?? info?.memberCount ?? 0) || 0;
    } catch { /* 群信息拿不到也能生成 */ }
    // 人格提示词和 QQ 回复走同一份（roles/*.md，经 selectRoleText + 长度截断），
    // 注入方式也照抄普通消息：放在 prompt 最前面。少了这一步，模型就会用自己的默认口吻
    // 「我是大肥鱼」——而角色卡里明确禁止自称大肥鱼。
    const roleHint = roleHintWithPolicies();
    const promptText = (roleHint ? roleHint + '\n\n' : '') + [
      '【一次性任务】你刚被拉进一个 QQ 群，现在要在群里说一句话当自我介绍。',
      '硬性要求：',
      `1. 只输出这一句话，${c.maxChars} 个汉字以内（含标点）`,
      '2. 不要 emoji、不要引号、不要换行、不要解释，也不要输出“好的”这类前缀',
      '3. 不要说自己是 AI / 语言模型 / 助手，不要列表式地报功能',
      '4. 口语、有性格，像真人进群打招呼',
      `群名：${groupName || '未知'}`,
      `群人数：${memberCount || '未知'}`,
      `你的群昵称：${selfDisplayName || '可爱大肥鱼'}`
    ].join('\n');
    try {
      const sessionId = await ensureSelfIntroSession();
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`自我介绍生成被拒：${accepted.result.error.code}，改用模板`);
        return '';
      }
      const output = await waitLearnerTurn(sessionId, c.llmTimeoutMs);
      const cleaned = cleanIntroText(output, c.maxChars);
      if (!cleaned) { log('自我介绍：模型输出为空，改用模板'); return ''; }
      log(`自我介绍文案（模型）：${cleaned}`);
      return cleaned;
    } catch (error) {
      log(`自我介绍生成失败（${error?.message ?? error}），改用模板`);
      resetSelfIntroSession();
      return '';
    }
  }

  async function sendSelfIntroImage(gid) {
    if (devModeEnabled()) return;
    const c = selfIntroCfg();
    if (!c.image) return;
    const file = path.isAbsolute(c.image) ? c.image : path.join(ROOT, c.image);
    try {
      const buf = fs.readFileSync(file);
      if (!buf.length) { log(`自我介绍配图是空文件：${file}`); return; }
      if (buf.length > 8 * 1024 * 1024) { log(`自我介绍配图超过 8MB，跳过：${file}`); return; }
      await sleep(randInt(700, 1500));
      if (devModeEnabled()) devInterceptSend('send_group_msg', `group:${gid}`, '自我介绍配图');
      else await withTimeout(
        bot.sendGroupMessage(Number(gid), image(`base64://${buf.toString('base64')}`)),
        20000, '发送自我介绍配图');
      log(`自我介绍配图已发送（${gid}）`);
    } catch (error) {
      log(`自我介绍配图发送失败（${gid}）：${error?.message ?? error}`);
    }
  }

  async function introduceSelf(groupId, reason = 'join') {
    const c = selfIntroCfg();
    if (!c.enabled) return false;
    const gid = String(groupId ?? '');
    if (!gid) return false;
    // 和白名单解耦：被拉进群本身就是信号。anyGroup=false 时退回按 allow.groups 判定。
    const denied = (cfg.deny?.groups ?? []).includes(gid);
    const permitted = c.anyGroup ? !denied : greetingAllowed(gid);
    if (!permitted) {
      log(`自己进群：${gid} ${denied ? '在 deny.groups 里' : '不在白名单且 anyGroup=false'}，不打招呼`);
      return false;
    }
    if (greetedGroups[gid]) {
      log(`自己进群：${gid} 之前已经打过招呼，跳过`);
      return false;
    }
    const templates = c.templates.length ? c.templates : ['大家好，我是{name}，有问题直接 @ 我。'];
    const pickTemplate = () => templates[Math.floor(Math.random() * templates.length)]
      .replace(/\{name\}/g, selfDisplayName || '鲸鱼')
      .replace(/\{group\}/g, gid);
    if (c.delayMs) await sleep(c.delayMs);
    // 文案：llm 模式先让模型写一句，写不出来/超时/没连上 DSH 就退回模板。
    let body = c.mode === 'llm' ? await generateIntroText(gid) : '';
    if (!body) body = pickTemplate();
    try {
      if (devModeEnabled()) devInterceptSend('send_group_msg', `group:${gid}`, body);
      else await bot.sendGroupMessage(Number(gid), text(escapeCqText(body)));
      greetedGroups[gid] = Date.now();
      saveGreetedGroups();
      log(`✅ 自己进群招呼：已在 ${gid} 打招呼（${reason}）`);
      appendActivity(`${gid} 进群打招呼`);
      // 配图紧接着发（单独一条消息），失败不影响招呼本身
      void sendSelfIntroImage(gid);
      return true;
    } catch (error) {
      log(`自己进群招呼发送失败（${gid}）：${error?.message ?? error}`);
      return false;
    }
  }

  function forgetGreetedGroup(groupId) {
    const gid = String(groupId ?? '');
    if (!gid || !greetedGroups[gid]) return;
    delete greetedGroups[gid];
    saveGreetedGroups();
    log(`自己退群：已清掉 ${gid} 的招呼记录（再被拉进来会重新打招呼）`);
  }

  /** 扫一遍自己所在的群，把「白名单里但还没打过招呼」的补上。 */
  async function scanGroupsForIntro(reason = 'scan') {
    const c = selfIntroCfg();
    if (!c.enabled || c.onlyOnJoin || selfIntroScanning) return;
    if (!Array.isArray(cfg.allow?.groups) || cfg.allow.groups.length === 0) return;
    selfIntroScanning = true;
    try {
      const list = await withTimeout(bot.getGroupList(), 8000, '取群列表');
      const groups = Array.isArray(list) ? list : (Array.isArray(list?.data) ? list.data : []);
      const joined = groups
        .map((g) => String(g?.group_id ?? g?.groupId ?? ''))
        .filter(Boolean);
      const c2 = selfIntroCfg();
      const targets = joined.filter((gid) => {
        if (greetedGroups[gid]) return false;
        if ((cfg.deny?.groups ?? []).includes(gid)) return false;
        return c2.anyGroup ? true : cfg.allow.groups.includes(gid);
      });
      if (!targets.length) {
        if (reason === 'online') {
          log(`自己进群检查：在 ${joined.length} 个群里（${joined.join(', ')}），都已经打过招呼`);
        }
        return;
      }
      log(`自己进群检查（${reason}）：发现 ${targets.join(', ')} 还没打过招呼`);
      for (const gid of targets) {
        await introduceSelf(gid, reason);
      }
    } catch (error) {
      log(`自己进群检查失败（${reason}）：${error?.message ?? error}`);
    } finally {
      selfIntroScanning = false;
    }
  }

  // 第一次见到某种通知类型时打一行日志，方便核对运行时实际发的是哪个名字。
  const seenNoticeTypes = new Set();
  bot.onEvent((event) => {
    if (event?.post_type !== 'notice') return;
    const nt = String(event.notice_type ?? '');
    if (nt && !seenNoticeTypes.has(nt)) {
      seenNoticeTypes.add(nt);
      log(`收到通知事件类型：${nt}`);
    }
    const uid = String(event?.user_id ?? '');
    const sid = String(event?.self_id ?? selfUserId ?? '');
    const selfJoined = uid !== '' && sid !== '' && uid === sid;

    if (nt === 'group_increase' || nt === 'increase' || nt === 'group_member_increase') {
      if (selfJoined) {
        // 自己被拉进群：向群里打招呼
        introduceSelf(event?.group_id, nt)
          .catch((error) => log('自己进群打招呼出错:', error?.message ?? error));
        return;
      }
      handleGroupIncrease(event).catch((error) => log('处理进群事件出错:', error?.message ?? error));
      return;
    }

    if (nt === 'group_decrease' || nt === 'decrease' || nt === 'group_member_decrease') {
      if (selfJoined) forgetGreetedGroup(event?.group_id);
    }
  });

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      snowlumaHealth.accountOnline = sub === 'online';
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
    log(`SnowLuma 已连接：${connectedUrl}`);
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        selfDisplayName = String(login.nickname).trim();
        log(`机器人昵称: ${login.nickname}`);
      }
      if (login?.user_id != null) selfUserId = String(login.user_id);
    }).catch(() => {});
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
    // 自己进群补招呼：DSH/网关重启期间被拉进群的话，入群事件已经错过，靠扫描补上。
    void scanGroupsForIntro('online');
    if (!selfIntroTimer) {
      const scanMs = selfIntroCfg().scanIntervalMs;
      selfIntroTimer = setInterval(() => { void scanGroupsForIntro('interval'); }, scanMs);
      selfIntroTimer.unref?.();
    }
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      // 只记「已写回」，不打印 token 片段：日志会被贴进 issue / 截图，
      // 前 4 个字符同样是凭据的一部分（CWE-532，见 PR #13）。
      if (r.updated) log('🔄 已把当前 token 写回 config.json');
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => {
    // SDK 在 WS 升级被拒（401 / 建连失败）时可能**只 emit error、不 emit close**，
    // 于是挂在 close 上的 token 自愈永远不会触发 —— 表现为「桥接活着但收发全废」，
    // 用户只能靠手工改 token 绕过去（issue #19）。这里同样尝试一次（内部有 10s 节流）。
    const detail = error && typeof error === 'object'
      ? [error.code, error.message, error.reason, error.type].filter(Boolean).join(' | ') || JSON.stringify(error)
      : String(error ?? '');
    log(`SnowLuma 错误：${detail || '(无详情)'}`);
    void healTokenIfStale(`error ${detail}`.trim().slice(0, 200));
  });

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  startDshWatch();
  startSnowlumaWatch();
  startConsoleServer();

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
