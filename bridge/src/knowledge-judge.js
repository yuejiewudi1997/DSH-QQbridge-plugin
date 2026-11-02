// 判定模型：回答「这些来源到底支不支持这句话」。
//
// 上一版的核实只看「有没有官方/百科来源」——搜到「原神」的百科页就放行，
// 哪怕那句话是「原神 3.2 版本上线了纳西妲」这种编造。这一层补的就是这个缺口。
//
// 两条路径：
//   1. 主路径：把「陈述 + 来源标题/摘要」交给模型判，要求只回 JSON。
//      桥接通过 DSH 的独立会话完成（不在群里说话，不占人格会话）。
//   2. 兜底：模型不可用（没配、超时、回不出 JSON）时走规则判定。
//      规则只做一件事，但做得很实：**陈述里的数字/版本/日期，来源里必须有**。
//      编造的事实十有八九死在数字上（3.2、2026、30%、12 月 5 日）。
//
// 判定结果三态，宁可 unclear 也不猜：
//   supported    来源明确支持
//   contradicted 来源与陈述矛盾（含辟谣）
//   unclear      来源没提到，或信息不足以判断

const DEBUNK_RE = /辟谣|谣言|不实|假的|并非|纯属虚构|不实信息|假的吧|网传不实/;

// 强断言：出现这些词而来源里没有对应表述时，倾向 unclear
const STRONG_CLAIM_RE = /全部|所有|唯一|第一|最[好大强快高多]|必然|一定|绝对|从来没有|永远不会|无例外/;

const VERSION_RE = /\d+(?:\.\d+){1,3}/g;                  // 3.2 / 1.21.4 / 0.9.1
const DATE_RE = /\d{4}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*月|\d{4}-\d{1,2}-\d{1,2}/g;
const PERCENT_RE = /\d+(?:\.\d+)?\s*[%％]/g;
const AMOUNT_RE = /\d+(?:\.\d+)?\s*[亿万千百]?(?:元|块|人|次|条|台|架|吨|公里|km)/g;
const PLAIN_NUM_RE = /\b\d{2,}\b/g;

/** 抽出陈述里的「硬事实」片段：数字、版本、日期、比例、数量。 */
export function extractHardFacts(text) {
  const source = String(text ?? '');
  const out = new Set();
  for (const re of [VERSION_RE, DATE_RE, PERCENT_RE, AMOUNT_RE, PLAIN_NUM_RE]) {
    for (const match of source.match(re) ?? []) {
      const token = String(match).replace(/\s+/g, '');
      if (token.length >= 2) out.add(token);
    }
  }
  return [...out];
}

/** 抽引号里的名字与英文专名，用于判断「来源有没有提到同一个东西」。 */
export function extractEntities(text) {
  const source = String(text ?? '');
  const out = new Set();
  for (const match of source.match(/[「『“"]([^」』”"]{2,20})[」』”"]/g) ?? []) {
    out.add(match.replace(/[「『“"」』”"]/g, ''));
  }
  for (const match of source.match(/\b[A-Za-z][A-Za-z0-9.+#-]{2,}\b/g) ?? []) {
    out.add(match);
  }
  return [...out];
}

function normalizeForMatch(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, '');
}

/** 来源里是否出现过这个数字/版本（允许 3.2 与 3.20 这种轻微差异）。 */
function hasNumber(sourcesText, token) {
  const haystack = normalizeForMatch(sourcesText);
  const needle = normalizeForMatch(token);
  if (!needle) return false;
  if (haystack.includes(needle)) return true;
  // 版本号：3.2 允许命中 "3.2" / "v3.2" / "3.2版本"，但不允许 3.20
  if (/^\d+(\.\d+)+$/.test(needle)) {
    const base = needle.replace(/\./g, '\\.');
    return new RegExp(`${base}(?![0-9])`).test(haystack);
  }
  return false;
}

export function sourcesToText(sources, maxChars = 1600) {
  const list = Array.isArray(sources) ? sources : [];
  const parts = list.map((source, index) => {
    const title = String(source?.title ?? '').trim();
    const snippet = String(source?.snippet ?? '').trim();
    const host = String(source?.host ?? '').trim();
    return `[${index + 1}] ${title || host}${snippet ? ' — ' + snippet : ''}${host ? `（${host}）` : ''}`;
  });
  let text = parts.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  return text;
}

export function buildJudgePrompt({ claim, sources, maxSources = 3 }) {
  const list = (Array.isArray(sources) ? sources : []).slice(0, maxSources);
  const block = sourcesToText(list, 1200) || '（无来源）';
  return [
    '你是事实核查员。下面是「待核实陈述」和搜索引擎返回的来源摘要。',
    '请判断：这些来源是否支持该陈述。',
    '',
    `【待核实陈述】${String(claim ?? '').slice(0, 400)}`,
    '',
    '【来源】',
    block,
    '',
    '只输出一个 JSON 对象，不要解释、不要代码块、不要前后缀：',
    '{"verdict":"supported|contradicted|unclear","confidence":0.0,"reason":"20字以内"}',
    '',
    '判定标准（按顺序判断）：',
    '1. 来源讲的是不是同一个主体？来源在讲别的主题 → unclear。',
    '2. 陈述里的硬事实（数字、版本号、日期、比例、金额、专有人名/机构名）在来源里出现过吗？',
    '   陈述含这类硬事实而来源完全没有 → unclear（编造的事实基本死在这一步）。',
    '3. 来源与陈述矛盾吗（含辟谣/澄清）？矛盾 → contradicted。',
    '4. 来源在讲同一主体、无矛盾，且能指出来源里支持该陈述的具体表述 → supported。',
    '   措辞不同不算矛盾（例如来源写「动作角色扮演游戏」，陈述写「开放世界游戏」）。',
    '5. 来源只是泛泛介绍这个主体，完全没涉及陈述所断言的那件事 → unclear。',
    '',
    '不要因为「搜到了相关词」就判 supported；也不要因为措辞差异就判 unclear。'
  ].join('\n');
}

/** 从模型回复里抠出 JSON；抠不出来返回 null（交给规则兜底）。 */
export function parseJudgeReply(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, ' ').replace(/```/g, ' ');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) {
    // 没 JSON 也认「verdict: supported」这种裸写法
    const bare = cleaned.match(/verdict\s*[:：]\s*"?(supported|contradicted|unclear)"?/i);
    if (!bare) return null;
    return { verdict: bare[1].toLowerCase(), confidence: 0.5, reason: '模型未输出 JSON' };
  }
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    const loose = cleaned.slice(start, end + 1).match(/"verdict"\s*:\s*"([a-z]+)"/i);
    if (!loose) return null;
    const reason = cleaned.slice(start, end + 1).match(/"reason"\s*:\s*"([^"]*)"/i);
    return {
      verdict: loose[1].toLowerCase(),
      confidence: 0.5,
      reason: reason ? reason[1].slice(0, 60) : ''
    };
  }
  const verdict = String(parsed?.verdict ?? '').toLowerCase();
  if (!['supported', 'contradicted', 'unclear'].includes(verdict)) return null;
  const confidence = Number(parsed?.confidence);
  return {
    verdict,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    reason: String(parsed?.reason ?? '').slice(0, 60)
  };
}

/**
 * 规则判定：不看语义，只查「硬事实是否在来源里出现」。
 * 这是模型不可用时的降级路径，宁可错杀（unclear）不可放过。
 */
export function ruleJudge({ claim, sources }) {
  const text = sourcesToText(sources, 2000);
  if (!text.trim()) return { verdict: 'unclear', confidence: 0.6, reason: '没有来源' };
  if (DEBUNK_RE.test(text)) return { verdict: 'contradicted', confidence: 0.7, reason: '来源含辟谣信号' };

  const facts = extractHardFacts(claim);
  const missing = facts.filter((token) => !hasNumber(text, token));
  if (facts.length && missing.length === facts.length) {
    return {
      verdict: 'unclear',
      confidence: 0.55,
      reason: `陈述里的 ${missing.slice(0, 2).join('、')} 在来源中找不到`
    };
  }
  if (facts.length && missing.length) {
    return {
      verdict: 'unclear',
      confidence: 0.5,
      reason: `部分数字缺失：${missing.slice(0, 2).join('、')}`
    };
  }

  if (STRONG_CLAIM_RE.test(claim) && !STRONG_CLAIM_RE.test(text)) {
    return { verdict: 'unclear', confidence: 0.45, reason: '强断言在来源中没有对应表述' };
  }

  const entities = extractEntities(claim).filter((entity) => entity.length >= 3);
  if (entities.length) {
    const haystack = normalizeForMatch(text);
    const hit = entities.filter((entity) => haystack.includes(normalizeForMatch(entity))).length;
    if (hit === 0) {
      return { verdict: 'unclear', confidence: 0.5, reason: '来源没有提到陈述里的实体' };
    }
  }
  return { verdict: 'supported', confidence: 0.4, reason: '来源覆盖了陈述关键信息' };
}

export const JUDGE_DEFAULTS = { enabled: true, timeoutMs: 25000, maxSources: 3 };

/**
 * 组合判定器。
 * @param {object} options
 * @param {(prompt:string)=>Promise<string>} [options.ask] 走模型；不可用时留空
 */
export function createJudge({ ask = null, getConfig = () => ({}), log = () => {}, now = Date.now } = {}) {
  const stats = { model: 0, rules: 0, failed: 0, supported: 0, contradicted: 0, unclear: 0, skipped: 0 };

  function config() {
    const raw = getConfig() ?? {};
    const int = (value, fallback, min, max) => {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };
    return {
      enabled: raw.enabled !== false,
      timeoutMs: int(raw.timeoutMs, JUDGE_DEFAULTS.timeoutMs, 3000, 180000),
      maxSources: int(raw.maxSources, JUDGE_DEFAULTS.maxSources, 1, 8)
    };
  }

  function withTimeout(promise, ms) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`判定超时（${ms}ms）`)), ms);
      if (timer.unref) timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function judge({ claim, sources = [] } = {}) {
    const cfg = config();
    const at = now();
    if (!cfg.enabled) {
      stats.skipped += 1;
      return { verdict: 'supported', confidence: 0, reason: '判定已关闭', source: 'disabled', at };
    }
    const list = (Array.isArray(sources) ? sources : []).slice(0, cfg.maxSources);
    if (!list.length) {
      stats.skipped += 1;
      return { verdict: 'unclear', confidence: 0.6, reason: '没有来源可判', source: 'none', at };
    }

    if (typeof ask === 'function') {
      try {
        const prompt = buildJudgePrompt({ claim, sources: list, maxSources: cfg.maxSources });
        const reply = await withTimeout(ask(prompt), cfg.timeoutMs);
        const parsed = parseJudgeReply(reply);
        if (parsed) {
          stats.model += 1;
          stats[parsed.verdict] = (stats[parsed.verdict] ?? 0) + 1;
          return { ...parsed, source: 'model', at };
        }
        stats.failed += 1;
        log(`判定模型：回复无法解析（${String(reply ?? '').slice(0, 80)}）`);
      } catch (error) {
        stats.failed += 1;
        log(`判定模型调用失败：${error?.message ?? error}`);
      }
    }

    const fallback = ruleJudge({ claim, sources: list });
    stats.rules += 1;
    stats[fallback.verdict] = (stats[fallback.verdict] ?? 0) + 1;
    return { ...fallback, source: typeof ask === 'function' ? 'rules(degraded)' : 'rules', at };
  }

  return { judge, stats: () => ({ ...stats }), config, extractHardFacts, extractEntities };
}

export const JUDGE_VERDICTS = ['supported', 'contradicted', 'unclear'];
