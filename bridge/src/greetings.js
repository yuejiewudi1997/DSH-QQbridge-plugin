// 定时问候：按真实网络时间在早/中/晚自动发一条「文字 + 图片」问候。
//
// 设计要点：
// - **不用代理**：到点由桥接直接发，不建 DSH 会话、不花 token（生成问候语才用代理）。
// - **真实网络时间**：优先读 HTTP Date 响应头算系统时钟偏移，网络可用时以网络时间为准；
//   全部失败才退回本机时钟并打日志（绝不因为对时就悄悄改语义）。
// - **一个气泡**：文字与图片放在同一条 message 的 segments 里（text + image），
//   而不是分两条发。
// - 本文件只放纯逻辑（配置/到点/挑选/解析/存储），发送与会话由 bridge 注入，便于离线单测。
export const GREETING_SLOTS = ['morning', 'noon', 'evening'];

export const GREETING_DEFAULTS = Object.freeze({
  enabled: false,
  timeZone: 'Asia/Shanghai',
  times: { morning: '08:30', noon: '12:00', evening: '21:30' },
  targets: [],              // 例如 ["group:1098011551"]，空 = 不自动发
  windowMs: 300000,         // 到点后 5 分钟内允许发送；错过窗口不补发
  useNetworkTime: true,
  networkTimeUrls: ['https://www.baidu.com', 'https://www.microsoft.com'],
  imageMaxEdge: 260,        // 发送前把配图长边缩到这个值（QQ 聊天图片的常见显示尺寸）
  maxPerDay: 3,
  generate: { count: 6, preset: '', style: '' }
});

const int = (value, fallback, min, max) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export function isValidClock(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  return !!m;
}

export function resolveGreetingConfig(raw = {}) {
  const cfg = raw ?? {};
  const times = { ...GREETING_DEFAULTS.times };
  for (const slot of GREETING_SLOTS) {
    if (isValidClock(cfg.times?.[slot])) times[slot] = String(cfg.times[slot]).trim();
  }
  const targets = (Array.isArray(cfg.targets) ? cfg.targets : [])
    .map((t) => String(t ?? '').trim())
    .filter((t) => /^(group|private):\d+$/.test(t));
  return {
    enabled: cfg.enabled === true,
    timeZone: String(cfg.timeZone ?? GREETING_DEFAULTS.timeZone).trim() || GREETING_DEFAULTS.timeZone,
    times,
    targets: [...new Set(targets)],
    windowMs: int(cfg.windowMs, GREETING_DEFAULTS.windowMs, 60000, 3600000),
    useNetworkTime: cfg.useNetworkTime !== false,
    imageMaxEdge: int(cfg.imageMaxEdge, GREETING_DEFAULTS.imageMaxEdge, 120, 2048),
    networkTimeUrls: (Array.isArray(cfg.networkTimeUrls) && cfg.networkTimeUrls.length
      ? cfg.networkTimeUrls
      : GREETING_DEFAULTS.networkTimeUrls).map((u) => String(u)).filter((u) => /^https?:\/\//.test(u)),
    maxPerDay: int(cfg.maxPerDay, GREETING_DEFAULTS.maxPerDay, 1, 24),
    generate: {
      count: int(cfg.generate?.count, GREETING_DEFAULTS.generate.count, 1, 30),
      preset: String(cfg.generate?.preset ?? ''),
      style: String(cfg.generate?.style ?? '').slice(0, 500)
    }
  };
}

/** 按时区取墙钟（日期 + HH:MM + 分钟数）。 */
export function zonedParts(nowMs, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    minutes: hour * 60 + minute
  };
}

/**
 * 这一分钟该不该触发。
 * 只看「目标时刻 ≤ 现在 < 目标时刻 + window」，同一天同一时段每天只发一次。
 */
export function dueSlots({ config, nowMs, firedToday = [] } = {}) {
  const cfg = resolveGreetingConfig(config);
  const parts = zonedParts(nowMs, cfg.timeZone);
  const fired = new Set(firedToday);
  const out = [];
  for (const slot of GREETING_SLOTS) {
    const [h, m] = cfg.times[slot].split(':').map(Number);
    const at = h * 60 + m;
    const diff = parts.minutes - at;
    if (diff >= 0 && diff * 60000 < cfg.windowMs && !fired.has(slot)) {
      out.push({ slot, at: cfg.times[slot], date: parts.date });
    }
  }
  return out;
}

/** 下一次触发时刻（毫秒），给控制台显示用；今天都过了就返回明天第一条。 */
export function nextFireAt({ config, nowMs } = {}) {
  const cfg = resolveGreetingConfig(config);
  const parts = zonedParts(nowMs, cfg.timeZone);
  const base = new Date(nowMs);
  let best = null;
  for (const slot of GREETING_SLOTS) {
    const [h, m] = cfg.times[slot].split(':').map(Number);
    const at = h * 60 + m;
    if (at > parts.minutes) {
      const deltaMin = at - parts.minutes;
      const candidate = nowMs + deltaMin * 60000;
      if (!best || candidate < best) best = candidate;
    }
  }
  if (best === null) {
    const [h, m] = cfg.times[GREETING_SLOTS[0]].split(':').map(Number);
    const tomorrow = new Date(nowMs + 86400000);
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: cfg.timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const d = Object.fromEntries(fmt.formatToParts(tomorrow).map((p) => [p.type, p.value]));
    // 用本地时间构造明天该时刻（近似即可；timeZone 与主机相同时精确）
    const target = new Date(`${d.year}-${d.month}-${d.day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
    best = target.getTime();
  }
  return best;
}

/** 从 HTTP Date 头（RFC 1123）解析 epoch 毫秒；解析失败返回 null。 */
export function parseHttpDate(header) {
  const text = String(header ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 网络时钟：请求若干个站点，用响应头 Date 与本地时间算偏移，缓存一段时间。
 * 失败不抛错，返回 { ok:false }，由调用方决定是否退回本机时钟。
 */
export function createNetworkClock({
  fetchImpl = globalThis.fetch,
  urls = GREETING_DEFAULTS.networkTimeUrls,
  timeoutMs = 4000,
  cacheMs = 10 * 60 * 1000,
  now = () => Date.now(),
  log = () => {}
} = {}) {
  let cache = null;
  let warned = false;

  async function probe() {
    for (const url of urls) {
      const startedAt = now();
      try {
        const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
        const epoch = parseHttpDate(res.headers.get('date'));
        if (epoch === null) continue;
        const skewMs = epoch - Math.round((startedAt + now()) / 2);
        cache = { ok: true, epoch: now() + skewMs, skewMs, source: url, fetchedAt: now(), roundTripMs: Math.max(0, now() - startedAt) };
        warned = false;
        log(`问候定时：网络时间源 ${url}，时钟偏移 ${skewMs > 0 ? '+' : ''}${Math.round(skewMs / 1000)}s`);
        return cache;
      } catch (error) {
        if (!warned) log(`问候定时：网络时间源不可用（${url}）：${error?.message ?? error}`);
      }
    }
    warned = true;
    return { ok: false, epoch: null, skewMs: 0, source: '', fetchedAt: now() };
  }

  async function get({ force = false } = {}) {
    if (!force && cache && now() - cache.fetchedAt < cacheMs) return cache;
    return probe();
  }

  /** 当前可信时间：网络可用用网络 epoch + 本地流逝，否则本机时钟。 */
  async function current() {
    const info = await get();
    const local = now();
    if (info.ok) {
      return {
        nowMs: info.epoch + (local - info.fetchedAt),
        skewed: true,
        skewMs: info.skewMs,
        source: info.source,
        networkOk: true
      };
    }
    return { nowMs: local, skewed: false, skewMs: 0, source: 'local', networkOk: false };
  }

  return { get, current, peek: () => cache };
}

/** 挑一条：优先同时段，其次 any；只考虑 enabled 且有文字。 */
export function pickEntry(entries = [], slot = '', random = Math.random) {
  const usable = (entries ?? []).filter((e) => e && e.enabled !== false && String(e.text ?? '').trim());
  if (!usable.length) return null;
  const exact = usable.filter((e) => e.slot === slot);
  const any = usable.filter((e) => e.slot === 'any' || !e.slot);
  const pool = exact.length ? exact : (any.length ? any : usable);
  return pool[Math.floor(random() * pool.length) % pool.length];
}

export function normalizeEntry(raw = {}, { id, now = Date.now } = {}) {
  const slot = GREETING_SLOTS.includes(String(raw.slot)) ? String(raw.slot) : 'any';
  return {
    id: String(raw.id ?? id ?? ''),
    slot,
    text: String(raw.text ?? '').slice(0, 400),
    // undefined = 调用方没提这个字段（保存文字时不该把已配的图冲掉）
    imagePath: raw.imagePath === undefined ? undefined : String(raw.imagePath ?? ''),
    enabled: raw.enabled !== false,
    createdAt: Number(raw.createdAt ?? now())
  };
}

export function normalizeEntries(list = [], options = {}) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const entry = normalizeEntry(item, options);
    if (entry.id && entry.text.trim()) out.push(entry);
  }
  return out.slice(0, 500);
}

/**
 * 从图池给一批问候配图：池够就一张一张不重复，池不够才循环并标记会重复。
 * 不在这里做缩放，缩放发生在发送前（normalizeImageForSend）。
 */
/** 图池条目统一成 { path, desc }（兼容旧的纯路径数组）。 */
export function normalizePoolItem(item) {
  if (typeof item === 'string') return { path: item, desc: '' };
  if (item && typeof item === 'object') {
    return { path: String(item.path ?? ''), desc: String(item.desc ?? '').trim() };
  }
  return { path: '', desc: '' };
}

const CJK_CHAR = /[\u4e00-\u9fff]/;

/** 把一句话/一条描述拆成可比较的语义词：中文二元组 + 单字，英文/数字按词。 */
function textTokens(text) {
  const s = String(text ?? '').toLowerCase();
  const tokens = new Set();
  for (const word of s.match(/[a-z0-9]{2,}/g) ?? []) tokens.add(word);
  const cjk = [...s].filter((ch) => CJK_CHAR.test(ch));
  for (let i = 0; i < cjk.length; i += 1) {
    tokens.add(cjk[i]);
    if (i + 1 < cjk.length) tokens.add(cjk[i] + cjk[i + 1]);
  }
  return tokens;
}

/** 图和文字的贴合分：描述权重高，文件名只作弱提示。 */
export function scoreImageForText(text, item) {
  const { path: imagePath, desc } = normalizePoolItem(item);
  const textSet = textTokens(text);
  if (!textSet.size) return 0;
  let score = 0;
  for (const token of textTokens(desc)) if (textSet.has(token)) score += token.length > 1 ? 3 : 1;
  const base = String(imagePath).split('/').pop().replace(/\.[a-z0-9]+$/i, '').replace(/[_\-.]+/g, ' ');
  for (const token of textTokens(base)) if (textSet.has(token)) score += 1;
  return score;
}

/**
 * 给每条问候配图：模型明确选了的优先（同一张不重复用），
 * 没选或选错就按文字贴合度取最高分，一张都贴合不上就留空（只发文字，不再随机配图）。
 */
export function matchPoolImages(pool = [], items = []) {
  const list = pool.map(normalizePoolItem).filter((item) => item.path);
  const used = new Set();
  const images = (Array.isArray(items) ? items : []).map((item) => {
    // 池里按文字贴合度的最佳候选（全局比对，供「模型选得不贴」时纠正）
    let best = '';
    let bestScore = 0;
    for (const it of list) {
      if (used.has(it.path)) continue;
      const score = scoreImageForText(item?.text, it);
      if (score > bestScore) { bestScore = score; best = it.path; }
    }
    const wanted = String(item?.image ?? '').trim();
    const wantedItem = wanted ? list.find((it) => it.path === wanted) : null;
    if (wantedItem && !used.has(wanted)) {
      // 模型选的图和文字完全对不上、而池里有明显更贴合的 → 用贴合度更高的那张
      const wantedScore = scoreImageForText(item?.text, wantedItem);
      if (best && bestScore > wantedScore) {
        used.add(best);
        return best;
      }
      used.add(wanted);
      return wanted;
    }
    if (best) { used.add(best); return best; }
    return '';
  });
  return { images, poolSize: list.length, assigned: images.filter(Boolean).length, empty: list.length === 0 };
}

/** 生成提示词：让「人格分支」写出可发出去的问候，而不是解释任务。 */
/** 看图写描述的提示词：给图池里还没描述的图补一句短含义（用于配图贴合文字）。 */
export function buildDescribePoolPrompt(items = []) {
  const list = (Array.isArray(items) ? items : []).map(normalizePoolItem).filter((item) => item.path);
  if (!list.length) return '没有要描述的图片。';
  return [
    '【图片池描述任务】',
    '下面每张图都带了路径标签。请看图后给每张写一句不超过 12 个字的含义，说明画面主体 + 场景/情绪，供之后给问候语配图用。',
    '不要写文件名、不要写「图片」二字、不要解释；看不清就写「无关」。',
    '',
    '只输出 JSON 数组，path 必须原样照抄每张图前面标签里的路径：',
    '[{"path":"assets/xxx.png","desc":"小鲸鱼 抱抱 安慰"}]'
  ].join('\n');
}

/** 解析「图片池描述」任务的 JSON 输出；只保留 allowed 里的 path。 */
export function parsePoolDescriptions(raw, { allowed = null } = {}) {
  const allow = allowed ? new Set(allowed.map((item) => normalizePoolItem(item).path)) : null;
  const text = String(raw ?? '');
  const out = [];
  const seen = new Set();
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          let obj;
          try { obj = JSON.parse(text.slice(i, j + 1)); } catch { obj = null; }
          if (obj && typeof obj === 'object') {
            const item = normalizePoolItem({ path: obj.path, desc: obj.desc });
            if (item.path && item.desc && !seen.has(item.path) && (!allow || allow.has(item.path))) {
              seen.add(item.path);
              out.push(item);
            }
          }
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

export function buildGeneratePrompt({ count = 6, slots = GREETING_SLOTS, style = '', role = '', avoid = [], pool = [] } = {}) {
  const slotLabel = { morning: '早间', noon: '午间', evening: '晚间' };
  const picked = (Array.isArray(slots) && slots.length ? slots : GREETING_SLOTS).filter((s) => GREETING_SLOTS.includes(s));
  const lines = [
    '【定时问候生成任务】',
    role ? `你的角色设定：\n${role}` : '',
    `请为这些时段生成 ${count} 条「可以直接发到 QQ 群」的问候语：${picked.map((s) => `${s}（${slotLabel[s]}）`).join('、')}。`,
    '',
    '要求：',
    '- 口吻像群里的**营业/服务号**：直接对群友打招呼、带一句当下的安排或招呼，读起来就是正常说话。',
    '- **不要自述「播报」这件事**：禁止出现「播报」「报时」「报到」「X 档」「值班」「上岗」「开工」这类字眼，也不要「现在是 X 点」的报时腔。',
    '- 不要写「我还在发呆」「我刚闻到饭味」这类独白/个人状态。',
    '- 每条 1~2 句、口语、轻快、有营业感；不要客服模板套话（「亲爱的用户」），不要 emoji、不要表情符号。',
    '- 各条之间不要重复，也不要套同一种句式；' + (style ? `风格参考：${style}` : '风格自然、热情一点。'),
    avoid.length ? `- 避免和这些已存在的问候重复：${avoid.slice(0, 12).join(' / ')}` : '',
    '- slot 用英文 morning / noon / evening，轮着分配，不要全塞一个时段。',
    '- 每条还要按文字意思选一张配图，写在 image 字段里，必须是同一件事：说吃饭选饭碗/吃饱，说睡觉/熬夜选睡熟/躺倒，说干活/电脑选盯电脑，打招呼选挥手/立绘；对不上就填 ""，不要随便凑一张。',
    pool.length
      ? '可选配图（image 只能原样填下面某一条的 path，必须贴合该条文字的意思；都不贴合就填空字符串 ""）：\n'
        + pool.slice(0, 40).map((item) => {
          const { path: imagePath, desc } = normalizePoolItem(item);
          return `- ${imagePath}${desc ? `（${desc}）` : ''}`;
        }).join('\n')
      : '没有可选配图，image 一律填 ""。',
    '',
    '只输出 JSON 数组，不要任何解释，格式：',
    '[{"slot":"morning","text":"…","image":"assets/xxx.png 或 \"\""}]'
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * 解析人格返回的 JSON 数组（容忍 ```json 围栏、多余前后文）。
 * 用括号配平扫描，避免正则懒惰匹配在字符串里的 `]` 处截断。
 */
export function parseGeneratedGreetings(text, { limit = 30 } = {}) {
  const raw = String(text ?? '');
  const found = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '[' && ch !== '{') continue;
    const close = ch === '[' ? ']' : '}';
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
      i = end;
      continue;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const text2 = String(item.text ?? '').trim();
      if (!text2) continue;
      found.push({
        slot: GREETING_SLOTS.includes(String(item.slot)) ? String(item.slot) : 'any',
        text: text2.slice(0, 400)
      });
    }
    i = end;
    if (found.length >= limit) break;
  }
  // 按文字去重，保留第一次出现
  const seen = new Set();
  return found.filter((item) => {
    if (seen.has(item.text)) return false;
    seen.add(item.text);
    return true;
  }).slice(0, limit);
}

/** 条目存储（JSON 文件）：定时问候的包体列表 + 今天的触发记录。 */
export function createGreetingStore({ file, now = Date.now, log = () => {} } = {}) {
  let state = { entries: [], fired: {}, lastFired: null, updatedAt: 0 };
  function load(fsImpl) {
    try {
      const text = fsImpl.readFileSync(file, 'utf8');
      const parsed = JSON.parse(text);
      state = {
        entries: normalizeEntries(parsed.entries, { now }),
        fired: parsed.fired && typeof parsed.fired === 'object' ? parsed.fired : {},
        lastFired: parsed.lastFired ?? null,
        updatedAt: Number(parsed.updatedAt ?? 0)
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`问候条目读取失败，按空库处理（不覆盖原文件）：${error?.message ?? error}`);
      state = { entries: [], fired: {}, lastFired: null, updatedAt: 0 };
    }
    return state;
  }
  let write = () => {};
  function bindWriter(fn) { write = fn; }
  function save() {
    state.updatedAt = now();
    try { write(file, state); } catch (error) { log(`问候条目保存失败：${error?.message ?? error}`); }
  }
  function entries() { return state.entries.map((e) => ({ ...e })); }
  function firedToday(date) {
    return Array.isArray(state.fired?.[date]) ? [...state.fired[date]] : [];
  }
  function markFired({ date, slot, entryId = '', target = '' }) {
    const list = new Set(firedToday(date));
    list.add(slot);
    state.fired = { [date]: [...list] };
    state.lastFired = { date, slot, entryId, target, at: now() };
    save();
  }
  function upsert(entry) {
    const normalized = normalizeEntry(entry, { now });
    const idx = state.entries.findIndex((e) => e.id === normalized.id);
    if (idx >= 0) {
      const old = state.entries[idx];
      if (normalized.imagePath === undefined) normalized.imagePath = old.imagePath ?? '';
      state.entries[idx] = { ...old, ...normalized, createdAt: old.createdAt };
    } else {
      state.entries.unshift(normalized);
    }
    save();
    return normalized;
  }
  function remove(id) {
    const before = state.entries.length;
    state.entries = state.entries.filter((e) => e.id !== String(id));
    if (state.entries.length !== before) save();
    return state.entries.length !== before;
  }
  function clearFired() { state.fired = {}; save(); }

  return { load, bindWriter, save, entries, firedToday, markFired, upsert, remove, clearFired, raw: () => state };
}
