// 联网核实：自动批准代理在放行「专业内容」前的最后一道闸门。
//
// 判定规则很朴素，刻意不做语义理解（没有第二个模型来判真假）：
//   1. 从条目里抽出专业词（domain-terms.js 命中）；
//   2. 拿这些词去联网搜；
//   3. 看结果的来源域名：官方（政府/官媒/国际组织）> 百科（维基/游戏 wiki/百度百科）> 其它；
//   4. 有官方 → official，有百科 → wiki，只有杂站 → weak，搜不到 → unknown。
// weak/unknown/contradicted 一律拦下来人工看——「无法判断」就不放行，这是安全默认。
//
// 它挡不住的东西也写清楚：来源存在 ≠ 内容正确。搜到「原神」的百科页，不代表
// 「3.2 版本上线了纳西妲」这句是对的。真正的一致性校验要靠人。

const OFFICIAL_SUFFIXES = ['.gov.cn', '.gov', '.mil', '.edu.cn'];
const OFFICIAL_HOSTS = new Set([
  // 裸域名也要列：'gov.cn'.endsWith('.gov.cn') 是 false，只靠后缀会漏掉 www.gov.cn
  'gov.cn', 'gov.hk', 'gov.mo', 'gov.tw',
  'xinhuanet.com', 'news.cn', 'people.com.cn', 'cctv.com', 'cctv.cn', 'cnr.cn',
  'gmw.cn', 'youth.cn', 'china.com.cn', 'china.org.cn', 'qstheory.cn', 'ce.cn',
  'chinadaily.com.cn', 'thepaper.cn', 'un.org', 'who.int', 'worldbank.org',
  'imf.org', 'nato.int', 'europa.eu', 'whitehouse.gov', 'nih.gov', 'cdc.gov',
  'nasa.gov', 'noaa.gov', 'iso.org', 'ietf.org', 'w3.org', 'iana.org'
]);
// 注意：知乎/CSDN 这类 UGC 站点**不是**百科，不能当可靠来源放行。
const WIKI_HOSTS = new Set([
  'wikipedia.org', 'wikimedia.org', 'wiktionary.org', 'fandom.com', 'wikia.com',
  'wiki.gg', 'huijiwiki.com', 'moegirl.org.cn', 'namu.wiki', 'baike.baidu.com'
]);

const DEBUNK_RE = /辟谣|谣言|不实|假的|并非|纯属虚构|不实信息|假的吧|网传|假的！/;

function hostMatches(host, set) {
  if (!host) return false;
  for (const rule of set) {
    if (host === rule || host.endsWith('.' + rule)) return true;
  }
  return false;
}

export function classifyHost(rawHost) {
  const host = String(rawHost ?? '').toLowerCase().replace(/^www\./, '');
  if (!host) return 'other';
  if (hostMatches(host, OFFICIAL_HOSTS)) return 'official';
  if (OFFICIAL_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1))) return 'official';
  if (hostMatches(host, WIKI_HOSTS)) return 'wiki';
  return 'other';
}

// 域名不可能枚举完（每个游戏、每家公司都有官网）。用标题里的「官方」字样兜底：
// 「《原神》官方网站」这种结果，域名是厂商自有域名，但它就是官方一手资料。
const OFFICIAL_TITLE_RE = /官方网站|官网|官方发布|官方公告|政府门户|人民政府|官方文档|official (site|website|docs)/i;

/** 结合标题判断来源等级：域名优先，域名判不出来再看标题。 */
export function classifySource(rawUrl, title = '') {
  const tier = classifyHost(hostOf(rawUrl));
  if (tier !== 'other') return tier;
  if (OFFICIAL_TITLE_RE.test(String(title ?? ''))) return 'official';
  return 'other';
}

/**
 * 搜索结果和查询词的相关性：标题或摘要里必须出现查询词本身。
 * 不加这一层，「原神」搜出 bilibili 首页也会被当成来源——判定模型只能照着垃圾来源判。
 */
function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesTerm(hay, needle) {
  if (!needle) return true;
  if (hay.includes(needle)) return true;
  // 英文词按词边界，避免 "bridge" 命中 "abridged"
  if (/^[a-z0-9 .+#_-]+$/.test(needle)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}([^a-z0-9]|$)`).test(hay);
  }
  return false;
}

/**
 * 相关性：标题/摘要里必须出现**该查询对应的词**（可以是多个词里任意一个）。
 * 整句检索时传整个专业词列表——否则「原神 是 开放世界 游戏」搜回来的页面
 * 只要不含整句原文就会被全丢掉。
 */
export function isRelevantResult(item, termOrTerms) {
  const needles = (Array.isArray(termOrTerms) ? termOrTerms : [termOrTerms])
    .map((term) => String(term ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (!needles.length) return true;
  const hay = `${item?.title ?? ''} ${item?.snippet ?? ''}`.toLowerCase();
  if (!hay.trim()) return false;
  return needles.some((needle) => matchesTerm(hay, needle));
}

function hostOf(rawUrl) {
  try {
    return new URL(String(rawUrl)).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 挑最值得搜的词：长词更具体，自定义词优先（管理员明确关心的）。 */
export function pickVerifyTerms(terms, limit = 2) {
  return (Array.isArray(terms) ? terms : [])
    .filter((entry) => entry?.term)
    .slice()
    .sort((a, b) => {
      const custom = (b.domain === '自定义' ? 1 : 0) - (a.domain === '自定义' ? 1 : 0);
      if (custom) return custom;
      return b.term.length - a.term.length;
    })
    .slice(0, limit);
}

export function createVerifier({ search, judge = null, getConfig = () => ({}), log = () => {}, now = Date.now } = {}) {
  const stats = { calls: 0, official: 0, wiki: 0, weak: 0, unknown: 0, contradicted: 0, errors: 0 };
  const cache = new Map(); // term -> { at, value }

  function config() {
    const raw = getConfig() ?? {};
    return {
      enabled: raw.enabled !== false,
      maxQueries: Math.max(1, Math.min(4, Number(raw.maxQueries ?? 2) || 2)),
      timeoutMs: Math.max(1000, Math.min(60000, Number(raw.searchTimeoutMs ?? 10000) || 10000)),
      cacheTtlMs: Math.max(0, Number(raw.cacheTtlMs ?? 30 * 60 * 1000) || 0)
    };
  }

  async function searchTerm(term, { timeoutMs }) {
    const cfg = config();
    const key = String(term).toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < cfg.cacheTtlMs) return hit.value;
    if (typeof search !== 'function') throw new Error('没有可用的联网搜索实现');
    const value = await withTimeout(Promise.resolve(search(term)), timeoutMs, `搜索「${term}」`);
    cache.set(key, { at: now(), value });
    return value;
  }

  /**
   * 核实一段文本。
   * @returns {{verdict:string, sources:object[], queries:string[], reason:string, checked:object[]}}
   */
  async function verify(text, { terms = [] } = {}) {
    const cfg = config();
    if (!cfg.enabled) {
      return { verdict: 'skipped', sources: [], queries: [], reason: '联网核实已关闭', checked: [] };
    }
    const picked = pickVerifyTerms(terms, cfg.maxQueries);
    if (!picked.length) {
      return { verdict: 'skipped', sources: [], queries: [], reason: '没有需要核实的专业词', checked: [] };
    }
    stats.calls += 1;

    const sources = [];
    const queries = [];
    const checked = [];
    let sawError = '';
    let searchReturned = 0;
    let irrelevant = 0;
    const perTerm = [];   // 每个查询词各自的命中，用于轮转合并

    // 语义搜索（Tavily）搜整句比搜孤立名词准得多：搜「Docker」只能得到名词解释，
    // 搜「Docker 容器默认走 bridge 网络」能直接命中官方文档里那句话。
    // 整句检索失败/太短时仍退回逐词检索，两条路都保留。
    const claim = String(text ?? '').trim();
    const claimQuery = claim.length >= 4 && claim.length <= 120 ? claim : '';
    const termNeedles = picked.map((entry) => entry.term);
    const plan = [];
    if (claimQuery) plan.push({ term: claimQuery, needles: termNeedles, kind: 'claim' });
    for (const entry of picked) plan.push({ term: entry.term, needles: [entry.term], kind: 'term' });

    for (const entry of plan) {
      queries.push(entry.term);
      try {
        const result = await searchTerm(entry.term, { timeoutMs: cfg.timeoutMs });
        const list = Array.isArray(result?.results) ? result.results : [];
        searchReturned += list.length;
        checked.push({ term: entry.term, kind: entry.kind, hits: list.length, provider: result?.provider ?? '' });
        const termSources = [];
        for (const item of list.slice(0, 6)) {
          const host = hostOf(item?.url);
          if (!host) continue;
          if (!isRelevantResult(item, entry.needles)) {
            irrelevant += 1;
            continue;
          }
          const source = {
            title: String(item?.title ?? '').slice(0, 160),
            // snippet 是判定模型的输入：只给标题不足以判断「来源是否支持这句话」
            snippet: String(item?.snippet ?? '').slice(0, 400),
            url: String(item?.url ?? ''),
            host,
            tier: classifySource(item?.url, item?.title)
          };
          termSources.push(source);
          sources.push(source);
        }
        if (termSources.length) perTerm.push({ term: entry.term, sources: termSources });
      } catch (error) {
        sawError = String(error?.message ?? error);
        stats.errors += 1;
        log(`知识库核实：搜索「${entry.term}」失败：${sawError}`);
        checked.push({ term: entry.term, kind: entry.kind, hits: 0, error: sawError });
      }
    }

    // 辟谣信号：结果标题/摘要里出现「辟谣/谣言/不实」等，且和查的词同现
    const debunked = sources.some((source) => DEBUNK_RE.test(source.title))
      || (Array.isArray(sources) && sources.length > 0 && DEBUNK_RE.test(picked.map((entry) => entry.term).join(' ')));

    const hasOfficial = sources.some((source) => source.tier === 'official');
    const hasWiki = sources.some((source) => source.tier === 'wiki');
    // 轮转合并：每个查询词各取一条再取第二条……否则 maxSources 会被第一个词的
    // 结果占满（「原神 是 开放世界 游戏」里先搜「开放世界」，判定模型就只看到
    // 解释开放世界概念的文章，得不出「来源提到原神」）。
    const unique = [];
    const seen = new Set();
    const maxLen = perTerm.reduce((max, group) => Math.max(max, group.sources.length), 0);
    for (let index = 0; index < maxLen; index += 1) {
      for (const group of perTerm) {
        const source = group.sources[index];
        if (!source || seen.has(source.url)) continue;
        seen.add(source.url);
        unique.push(source);
      }
    }
    for (const source of sources) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      unique.push(source);
    }

    let verdict = 'unknown';
    let reason = '';
    if (debunked) {
      verdict = 'contradicted';
      reason = '结果里出现辟谣/不实信号';
    } else if (hasOfficial) {
      verdict = 'official';
      reason = '存在官方来源';
    } else if (hasWiki) {
      verdict = 'wiki';
      reason = '存在百科/wiki 来源';
    } else if (unique.length > 0) {
      verdict = 'weak';
      reason = '只有非权威站点结果';
    } else if (sawError && !searchReturned) {
      verdict = 'unknown';
      reason = `搜索不可用（${sawError}）`;
    } else if (searchReturned > 0) {
      verdict = 'unknown';
      reason = `搜索结果与查询词无关（${irrelevant} 条被过滤）`;
    } else {
      verdict = 'unknown';
      reason = '搜索没有返回结果';
    }

    // 分级只回答「来源可不可信」，判定模型回答「来源支不支持这句话」。
    // 只有前面已经通过（official/wiki）的才值得花一次判定；其余直接拦。
    let judgement = null;
    if (VERIFY_PASS.has(verdict) && typeof judge === 'function') {
      try {
        judgement = await judge({ claim: text, sources: unique.slice(0, 5) });
      } catch (error) {
        judgement = { verdict: 'unclear', reason: `判定异常：${error?.message ?? error}`, source: 'error' };
      }
      if (judgement?.verdict === 'contradicted') {
        verdict = 'contradicted';
        reason = `来源与陈述矛盾：${judgement.reason || '判定为假'}`;
      } else if (judgement?.verdict !== 'supported') {
        verdict = 'unclear';
        reason = `来源不足以支持陈述：${judgement?.reason || '判定为无法确认'}`;
      } else {
        reason = `${reason} + 判定支持（${judgement.source === 'model' ? '模型' : '规则'}）`;
      }
    }

    stats[verdict] = (stats[verdict] ?? 0) + 1;
    return {
      verdict,
      reason,
      queries,
      checked,
      judgement,
      sources: unique.slice(0, 5).map((source) => ({
        title: source.title, url: source.url, host: source.host, tier: source.tier
      })),
      at: now()
    };
  }

  return { verify, stats: () => ({ ...stats }), config, classifyHost, classifySource };
}

/** 哪些 verdict 可以自动放行。 */
export const VERIFY_PASS = new Set(['official', 'wiki']);

/** 给拦截条目用的中文标签。 */
export function verifyLabel(verdict) {
  switch (verdict) {
    case 'official': return '官方来源';
    case 'wiki': return '百科来源';
    case 'weak': return '仅有非权威来源';
    case 'contradicted': return '疑似不实（来源矛盾/辟谣）';
    case 'unclear': return '来源不足以支持';
    case 'unknown': return '无法证实';
    case 'skipped': return '未核实';
    default: return '未知';
  }
}
