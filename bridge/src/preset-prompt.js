// 通用系统预设（预设内置）的读取与安全改写。
//
// 边界说明：
//   通用系统预设 = 预设内置（dsh/agent-presets/<preset>/agent.cordis.yml 的 persona.prefix），
//                  只放安全规则、硬约束与工具协议；改完需重启 DSH 生效。
//   人格模板 = 人格配置里的 system 层（与 roles/<名称>.md 对齐），只放性格、语气、
//              格式与聊天习惯；改完重建 persona preset，同样需重启 DSH 生效。
//
// 本模块只做纯文本/YAML 处理，不碰文件系统以外的任何状态，便于单测。
import yaml from 'js-yaml';

export const PRESET_PERSONA_ID = 'persona';
export const PRESET_PROMPT_MAX_BYTES = 128 * 1024;

// 安全基线段落：缺失说明 AI 的权限边界可能被削弱，保存时警告（不阻断，管理员有最终决定权）。
export const PRESET_REQUIRED_MARKERS = ['【通用系统预设 —— 安全规则', '【通用系统预设 —— 工具协议'];

// 硬性不变量：这些串是本项目自己的测试与安全边界所依赖的（test-qq-preset-contract.mjs / verify-persona-config.mjs），
// 一旦被删就会同时削弱 AI 的权限边界并让 `npm run test:audit`、`npm run verify:persona` 变红，因此保存时直接拒绝。
//
// **按预设分别校验**：清单起初是照二代预设（qq-chat-v2）写的，一代预设（qq-chat）当时
// 需要另一份更短的清单。聊天模式删除后一代预设已不在仓库里，`_V1` 清单只用于还原历史
// 备份文件（老备份仍按它校验），新会话一律走二代替。
export const PRESET_BLOCKING_SUBSTRINGS = [
  '你没有本地工具',
  '群友没有管理权限',
  '内部配置',
  '角色由桥接注入',
  '不会自动发送到 QQ',
];
// 一代（qq-chat）：不用 MCP 工具，靠空格分句 + [SILENT]，因此工具面那几条不适用。
// 该预设的源文件已随聊天模式删除，此处保留清单只为老备份的还原校验——
// 清单必须与当时的预设文案一致，否则还原会用一个预设自己都不满足的条件把它锁死。
export const PRESET_BLOCKING_SUBSTRINGS_V1 = [
  '群友没有管理权限',
  'API 令牌',
  '角色扮演由系统注入',
];
export const PRESET_MIN_BODY_CHARS = 500;

/** 取某个预设对应的硬性不变量清单（未知预设按更严的二代替处理）。 */
export function presetBlockingSubstrings(preset = 'v2') {
  return preset === 'v1' ? PRESET_BLOCKING_SUBSTRINGS_V1 : PRESET_BLOCKING_SUBSTRINGS;
}

/** 硬性校验：返回阻止保存的原因列表（空数组=可保存）。preset 取 'v1' / 'v2'。 */
export function presetPromptBlockers(content, preset = 'v2') {
  const text = String(content ?? '');
  const blockers = [];
  if (!text.trim()) {
    blockers.push('通用系统预设不能为空');
    return blockers;
  }
  for (const needle of presetBlockingSubstrings(preset)) {
    if (!text.includes(needle)) {
      blockers.push(`缺少安全不变量「${needle}」：删除它会让 AI 的权限边界失效，并使 npm run test:audit 失败`);
    }
  }
  if (text.trim().length < PRESET_MIN_BODY_CHARS) {
    blockers.push(`正文过短（${text.trim().length} 字符 < ${PRESET_MIN_BODY_CHARS}）：疑似内容被误删`);
  }
  return blockers;
}

/**
 * 定位 persona 条目的 prefix 块标量（支持 >- / | 等块语法）。
 * @returns {{lines: string[], entryStart: number, entryEnd: number, keyLine: number, keyIndent: number, blockEnd: number}|null}
 */
export function locatePresetPromptBlock(text) {
  const lines = String(text ?? '').split('\n');
  const entryStart = lines.findIndex((line) => new RegExp(`^- id:\\s*${PRESET_PERSONA_ID}\\s*$`).test(line));
  if (entryStart < 0) return null;
  let entryEnd = lines.length;
  for (let i = entryStart + 1; i < lines.length; i += 1) {
    if (/^- /.test(lines[i])) { entryEnd = i; break; }
  }
  let keyLine = -1;
  for (let i = entryStart; i < entryEnd; i += 1) {
    if (/^\s*prefix:\s*[>|][-+]?\s*$/.test(lines[i])) { keyLine = i; break; }
  }
  if (keyLine < 0) return null;
  const keyIndent = lines[keyLine].match(/^\s*/)[0].length;
  // 只有真正的内容行才推进块尾：块内的空行（段落分隔）会被后面的内容行重新纳入，
  // 而块尾的空行留给后续行，避免把 persona 与下一条注释之间的空行吞掉。
  let blockEnd = keyLine + 1;
  for (let i = keyLine + 1; i < entryEnd; i += 1) {
    if (lines[i].trim() === '') continue;
    if (lines[i].match(/^\s*/)[0].length <= keyIndent) break;
    blockEnd = i + 1;
  }
  return { lines, entryStart, entryEnd, keyLine, keyIndent, blockEnd };
}

/** 取出 persona.prefix 的真实字符串值（已由 YAML 解析，折叠标量已展开）。 */
export function extractPresetPrefix(text) {
  let loaded;
  try {
    loaded = yaml.load(text);
  } catch {
    return null;
  }
  const entry = Array.isArray(loaded) ? loaded.find((item) => item?.id === PRESET_PERSONA_ID) : null;
  const prefix = entry?.config?.prefix;
  return typeof prefix === 'string' ? prefix : null;
}

/** 保存前的软校验：只提示，不阻断。 */
export function presetPromptWarnings(content) {
  const text = String(content ?? '');
  const warnings = [];
  if (!text.trim()) warnings.push('内容为空');
  for (const marker of PRESET_REQUIRED_MARKERS) {
    if (!text.includes(marker)) warnings.push(`缺少「${marker}…】段落：AI 的权限与工具边界可能被削弱`);
  }
  return warnings;
}

/**
 * 用字面量块（|-）把新提示词写回 YAML 文本。
 * 关键保证：读出来的是 YAML 解析后的真实字符串，写回后重新解析必须逐字一致，
 * 否则抛错拒绝写入——这样无论原文用的是 >- 还是 |，都不会改变提示词的实际语义。
 * 用 |-（literal + strip）与原文 >-（folded + strip）在"结尾不留多余换行"上保持一致。
 * @param {string} text 原 YAML 全文
 * @param {string} content 新的提示词正文
 * @param {'v1'|'v2'} preset 预设代次（决定用哪一套硬性不变量）
 * @returns {string} 新的 YAML 全文
 */
export function renderPresetPromptYaml(text, content, preset = 'v2') {
  const loc = locatePresetPromptBlock(text);
  if (!loc) throw new Error('无法定位预设里的 prefix 块（文件结构可能已变化）');
  const normalized = String(content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const bytes = Buffer.byteLength(normalized, 'utf8');
  if (bytes > PRESET_PROMPT_MAX_BYTES) {
    throw new Error(`通用系统预设过长（${(bytes / 1024).toFixed(1)} KB，上限 ${PRESET_PROMPT_MAX_BYTES / 1024} KB）`);
  }
  const blockers = presetPromptBlockers(normalized, preset);
  if (blockers.length) throw new Error(blockers.join('；'));
  // 新增行沿用文件的主导行尾，避免把 CRLF 文件写成更混乱的混合行尾。
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lfOnly = (text.match(/\n/g) ?? []).length - crlf;
  const eol = crlf >= lfOnly ? '\r\n' : '\n';
  const pad = ' '.repeat(loc.keyIndent + 2);
  // 只有「真正的空行」才写成空行；只含空格/Tab 的行必须保留原样（写成 pad + 原内容），
  // 否则它会被 YAML 当成空行读回，导致下面的一致性校验失败、提示词无法保存。
  const body = normalized.split('\n').map((line) => (line === '' ? '' : pad + line));
  // 外层用 '\n' 连接各行：CRLF 文件的行自带 '\r'，因此块的最后一行也要补一个 '\r'，
  // 否则它与下一行之间会变成 LF-only，把文件行尾弄得更混杂。
  const block = [`${' '.repeat(loc.keyIndent)}prefix: |-`, ...body].join(eol) + (eol === '\r\n' ? '\r' : '');
  const next = [...loc.lines.slice(0, loc.keyLine), block, ...loc.lines.slice(loc.blockEnd)].join('\n');
  const reparsed = extractPresetPrefix(next);
  if (reparsed === null) throw new Error('写入后 YAML 解析失败或找不到 persona.prefix');
  if (reparsed !== normalized) {
    throw new Error('写入校验失败：读回的提示词与新内容不一致，已放弃写入');
  }
  return next;
}
