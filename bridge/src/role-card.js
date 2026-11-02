// 人格卡（roles/<名称>.md）的解析与「按仿真模式取用」。
//
// 现在只有二代仿真（reserved2）：它必须用工具发言（qq_send_message 的数组分条），
// 没有 [SILENT]，也没有「空格分条」。一代仿真（reserved）已整体移除。
//
// 但人格卡里可能还残留当年写下的 〔一代〕 专属小节（例如「## 分条方式 〔一代〕」），
// 这些内容在二代下是错的（会和工具协议冲突），所以保留按标题标记筛选的机制：
//   ## 表情包体系 〔二代〕      → 只在二代注入（等价于 always，保留标记是为了可读）
//   ## 分条方式 〔一代〕        → 二代下一律丢弃
//   ## 你是谁                   → 两种都注入
// 标记会在注入前从标题里去掉，模型看到的始终是干净的小节标题。
export const ROLE_INJECT_MODES = ['v1', 'v2'];

// 模式标记：`〔二代〕` / `[v2]` / `（reserved2）` 等写法都认。
const MODE_TAGS = [
  { mode: 'v2', re: /[\[〔（(]\s*(?:二代|2\s*代|v2|reserved2)\s*[\]〕）)]/gi },
  { mode: 'v1', re: /[\[〔（(]\s*(?:一代|1\s*代|v1|reserved)\s*[\]〕）)]/gi },
];

function detectMode(heading) {
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    if (tag.re.test(heading)) return tag.mode;
  }
  return 'all';
}

function stripModeTags(heading) {
  let out = String(heading);
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    out = out.replace(tag.re, '');
  }
  return out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

/**
 * 按标题把人格卡拆成小节。
 * @returns {{mode: 'all'|'v1'|'v2', heading: string|null, lines: string[]}[]}
 */
export function parseRoleSections(text) {
  const sections = [];
  let current = null;
  for (const line of normalizeNewlines(text).split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (!current) {
        current = { mode: 'all', heading: null, lines: [] };
        sections.push(current);
      }
      current.lines.push(line);
      continue;
    }
    const title = stripModeTags(heading[2]);
    current = { mode: detectMode(heading[2]), heading: title, lines: [`${heading[1]} ${title}`] };
    sections.push(current);
  }
  return sections;
}

/**
 * 取出某次仿真真正要注入的人格文本（已去掉模式标记）。
 * @param {'v1'|'v2'} mode
 */
export function selectRoleText(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text)
    .filter((section) => section.mode === 'all' || section.mode === want)
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 人格卡里是否含模式专属小节（控制台用它决定要不要显示「分代内容」提示）。 */
export function roleHasModeTags(text) {
  return parseRoleSections(text).some((section) => section.mode !== 'all');
}
