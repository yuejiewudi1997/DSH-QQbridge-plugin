// 知识审批代理：让「代理」（agent + 工具）判断采集包该不该记。
//
// 为什么要代理而不是规则：规则只能数违禁词/专业词，分不清「唠嗑打屁」和「他人经验」。
// 代理读得到上下文，能说「这包全是接梗，拒绝」或「第 2/5 行是经验，其余是闲聊，剥掉」。
//
// 本文件只放纯逻辑（批次/扩缩容/提示词/剥离重写），会话与工具由 bridge 注入，
// 这样这些判断可以离线单测，不依赖 DSH。
import crypto from 'node:crypto';
export const APPROVER_DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'agent',            // agent = 代理判断；rules = 退回规则代理（自动批准代理）
  batchSize: 12,            // 每个 worker 一次处理几包
  maxWorkers: 4,            // 并行上限
  backlogThreshold: 50,     // 积压 ≥ 这个数就立刻拉满并行
  intervalMs: 30000,        // 巡检间隔
  maxPackChars: 1400,       // 单包渲染上限
  turnTimeoutMs: 180000,    // 单个 worker 的 turn 超时
  preset: ''                // 留空 = 沿用群聊安全 preset
});

const int = (value, fallback, min, max) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export function resolveApproverOptions(raw = {}) {
  const cfg = raw ?? {};
  return {
    enabled: cfg.enabled !== false,
    mode: cfg.mode === 'rules' ? 'rules' : 'agent',
    batchSize: int(cfg.batchSize, APPROVER_DEFAULTS.batchSize, 1, 50),
    maxWorkers: int(cfg.maxWorkers, APPROVER_DEFAULTS.maxWorkers, 1, 8),
    backlogThreshold: int(cfg.backlogThreshold, APPROVER_DEFAULTS.backlogThreshold, 1, 5000),
    intervalMs: int(cfg.intervalMs, APPROVER_DEFAULTS.intervalMs, 5000, 3600000),
    maxPackChars: int(cfg.maxPackChars, APPROVER_DEFAULTS.maxPackChars, 200, 6000),
    turnTimeoutMs: int(cfg.turnTimeoutMs, APPROVER_DEFAULTS.turnTimeoutMs, 10000, 900000),
    preset: String(cfg.preset ?? '')
  };
}

/**
 * 这一轮该再开几个 worker。
 * - 已经开满 → 0
 * - 积压 ≥ backlogThreshold 且还有空闲并行位 → 立刻补齐（不受 batchSize 限制）
 * - 否则按「pending 能被 batchSize 消化」开最少的人手
 */
export function planWorkers({ pending = 0, busy = 0, options = {} } = {}) {
  const opt = resolveApproverOptions(options);
  if (!opt.enabled || pending <= 0) return 0;
  if (busy >= opt.maxWorkers) return 0;
  const free = opt.maxWorkers - busy;
  const wanted = Math.ceil(pending / opt.batchSize);
  const urgent = pending >= opt.backlogThreshold;
  const target = urgent ? opt.maxWorkers : Math.min(opt.maxWorkers, wanted);
  return Math.max(0, Math.min(free, target - busy));
}

/** 把待处理包按 batchSize 切开（返回 id 数组的数组，保序）。 */
export function splitBatch(items, size) {
  const list = Array.isArray(items) ? items : [];
  const step = Math.max(1, Number(size) || 1);
  const out = [];
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}

/** 包体编号：`[1] 张三：…`。老包没有编号就按分号切一次补上，保住向下兼容。 */
export function packLines(pack = {}) {
  if (Array.isArray(pack.lines) && pack.lines.length) {
    return pack.lines.map((line, index) => ({
      i: Number(line.i ?? index + 1),
      sender: String(line.sender ?? ''),
      text: String(line.text ?? '')
    }));
  }
  const raw = String(pack.text ?? '');
  const body = raw.includes('）：') ? raw.slice(raw.indexOf('）：') + 2) : raw;
  return body.split('；').filter((part) => part.trim()).map((part, index) => {
    const at = part.indexOf('：');
    return {
      i: index + 1,
      sender: at > 0 ? part.slice(0, at).trim() : '',
      text: at > 0 ? part.slice(at + 1).trim() : part.trim()
    };
  });
}

/** 按编号重建包正文：keepLines 为空则保留全部。 */
export function rebuildPackText(pack = {}, keepLines = null) {
  const lines = packLines(pack);
  const head = String(pack.text ?? '').includes('）：')
    ? String(pack.text).slice(0, String(pack.text).indexOf('）：') + 2)
    : '群聊片段：';
  const keep = Array.isArray(keepLines) && keepLines.length
    ? new Set(keepLines.map((n) => Number(n)).filter((n) => Number.isFinite(n)))
    : null;
  const chosen = keep ? lines.filter((line) => keep.has(line.i)) : lines;
  if (!chosen.length) return '';
  return `${head}${chosen.map((line) => `${line.sender ? `${line.sender}：` : ''}${line.text}`).join('；')}`;
}

/** 渲染给代理看的包清单（带编号、带 id）。 */
export function buildAgentPrompt({ packs = [], batchTag = '' } = {}) {
  const list = packs.map((pack) => {
    const count = pack.count ?? packLines(pack).length;
    return `- ${pack.id}（${pack.timeText || '时间未知'}，${pack.group || '来源未知'}，${count} 条）`;
  }).join('\n');
  return [
    '【知识库审批任务｜后台任务】',
    '你是 QQ 群聊知识库的后台审批代理。',
    '',
    '本批待审包（正文必须用工具读取，下面只有元信息）：',
    list || '（无）',
    '',
    '处理流程（必须真的调用工具，不要输出 JSON 或解释文字）：',
    '1) 对每个包调用 mcp__snowluma__qq_knowledge_approver_pack：id 用包 ID，读出编号行；',
    '2) 判断：',
    '   - 拒绝：纯唠嗑、接梗、情绪、表情包式附和、重复刷屏、无信息量短句、单纯骂人或玩笑；',
    '   - 保留：他人的经验教训、工具/软件用法、版本/配置/价格等具体信息、群规与约定、人物偏好、可脱离上下文的事实结论；',
    '   - 判断不了就倾向拒绝（闲聊污染比漏记更烦人）。',
    '3) 调用 mcp__snowluma__qq_knowledge_approver_verdict 提交：keep 时用 keepLines=[2,4] 只留相关行，或 text 给一句改写；reject 必须写 reason；',
    '4) 全部提交完只回复 DONE；如果工具报错，只回复 TOOL_ERROR <原因>。',
    '5) 只有需要重新查看积压时才调用 qq_knowledge_approver_pending，batch 参数用本批次 ID；日常按上面包清单处理。',
    '',
    '禁止：输出 JSON、写解释性散文、调用发送类或本地工具、和群友说话。',
    batchTag ? `本批次：${batchTag}` : ''
  ].filter(Boolean).join('\n');
}

/**
 * 兜底解析：模型没调工具、而是直接回了 JSON 时也能用。
 * 支持数组或单个对象，字段至少要有 id 与 verdict。
 */
export function parseVerdicts(text) {
  const raw = String(text ?? '');
  const out = [];
  // 括号配平扫描：JSON 里可能嵌数组（keepLines），正则的懒惰匹配会在第一个 ']' 处截断
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '{' && ch !== '[') continue;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < raw.length; j += 1) {
      const c = raw[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === ch) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) break;
    let parsed;
    try {
      parsed = JSON.parse(raw.slice(i, end + 1));
    } catch {
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      if (!item || typeof item !== 'object' || !item.id) continue;
      const verdict = String(item.verdict ?? '').toLowerCase();
      if (!verdict) continue;
      out.push({
        id: String(item.id),
        verdict,
        keepLines: Array.isArray(item.keepLines) ? item.keepLines : item.keepLines === undefined ? undefined : [item.keepLines],
        text: item.text === undefined ? undefined : String(item.text),
        tags: Array.isArray(item.tags) ? item.tags : undefined,
        reason: item.reason === undefined ? undefined : String(item.reason)
      });
    }
    i = end;
  }
  return out;
}

/**
 * 审批调度器：只负责「什么时候开几个 worker、每个 worker 发什么」，
 * 真正建会话/调模型由 bridge 传入的 createWorker 完成。
 */
export function createApproverScheduler({
  getPending = () => 0,
  listBatch = () => [],
  createWorker = async () => {},
  getOptions = () => ({}),
  log = () => {},
  now = Date.now
} = {}) {
  let busy = 0;
  const workers = new Map(); // id -> { startedAt, batch: [] }
  let seq = 0;
  let retick = null;      // 完成一批后的「再巡检」定时器（防抖）
  let failStreak = 0;     // 连续失败次数：没有进展时指数退避，避免 1 秒一次死循环

  function options() {
    return resolveApproverOptions(getOptions());
  }

  async function tick({ urgent = false } = {}) {
    const opt = options();
    if (!opt.enabled) return { spawned: 0, pending: 0, busy };
    let pending = 0;
    try {
      pending = Number(getPending()) || 0;
    } catch {
      pending = 0;
    }
    if (pending <= 0) {
      failStreak = 0;
      return { spawned: 0, pending: 0, busy };
    }
    const want = planWorkers({ pending, busy: busy, options: opt });
    if (want <= 0) return { spawned: 0, pending, busy };
    const batches = splitBatch(listBatch(pending), opt.batchSize).slice(0, want);
    let spawned = 0;
    for (const batch of batches) {
      if (!batch?.length) continue;
      const id = `worker-${++seq}-${crypto.randomBytes(6).toString('hex')}`;
      busy += 1;
      workers.set(id, { startedAt: now(), batch });
      spawned += 1;
      void (async () => {
        try {
          await createWorker({ id, batch, options: opt });
          failStreak = 0;
        } catch (error) {
          failStreak += 1;
          log(`知识审批代理 ${id} 失败：${error?.message ?? error}`);
        } finally {
          busy = Math.max(0, busy - 1);
          workers.delete(id);
          // 处理完再看一眼：积压还在就继续扩，但用定时器防抖 + 失败退避，
          // 否则 worker 秒失败时 here 会变成「立刻新建 → 立刻失败」的 CPU 死循环。
          if (options().enabled && getPending() > 0) scheduleRetick();
        }
      })();
    }
    return { spawned, pending, busy };
  }

  function scheduleRetick() {
    if (retick) return;
    const delay = Math.min(60000, 1000 * (2 ** Math.min(failStreak, 6)));
    retick = setTimeout(() => {
      retick = null;
      tick().catch(() => {});
    }, delay);
    retick.unref?.();
  }

  function status() {
    const opt = options();
    return {
      enabled: opt.enabled,
      mode: opt.mode,
      busy,
      maxWorkers: opt.maxWorkers,
      backlogThreshold: opt.backlogThreshold,
      batchSize: opt.batchSize,
      workers: [...workers.entries()].map(([id, info]) => ({
        id,
        startedAt: info.startedAt,
        packs: info.batch.map((item) => item.id)
      }))
    };
  }

  return { tick, status };
}
