// 自动批准代理：把「人工审核」从「每条都点」变成「只点被拦下来的那些」。
//
// 一轮的处置顺序（刻意先易后难，避免被联网核实拖住整批）：
//   第一批：知识库里已经有明确同义内容的 → 直接批准（verifiedBy: knowledge-base）
//           没有命中任何专业词的 → 直接批准（verifiedBy: no-domain-term）
//   第二批：命中专业词的 → 联网核实
//           有官方/百科来源 → 批准（verifiedBy: web）
//           只有杂站/搜不到/辟谣信号 → 打标记拦下来，转人工
//   违禁词在任何一步之前就拦掉。
//
// 它不做的事：不删除、不改写、不合并、不调整可见性。出问题能靠
// autoBlocked / autoApproved / verifiedBy / verification 四个字段回溯是它干的。

import { scanKnowledgeItem } from './knowledge-guard.js';
import { normalizeForHash } from './knowledge.js';
import { VERIFY_PASS, verifyLabel } from './knowledge-verify.js';

export const AUTO_APPROVE_DEFAULTS = {
  enabled: true,
  batchSize: 20,
  intervalMs: 60000,
  archiveDays: 30,
  extraTerms: [],
  verify: {
    enabled: true,
    kbDupScore: 0.75,
    maxVerifyPerRun: 10,
    maxRunMs: 90000,
    judge: { enabled: true, timeoutMs: 25000, maxSources: 3 }
  }
};

export function createAutoApprover({
  store, getConfig, log = () => {}, now = Date.now,
  scan = scanKnowledgeItem, extractTerms = null, verify = null
} = {}) {
  const stats = {
    runs: 0, approved: 0, blocked: 0, failed: 0, skipped: 0, deferred: 0,
    byKnowledgeBase: 0, byNoTerm: 0, byWeb: 0, lastRunAt: 0, lastResult: null
  };

  function config() {
    const raw = getConfig?.() ?? {};
    const int = (value, fallback, min, max) => {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };
    const v = raw.verify ?? {};
    return {
      enabled: raw.enabled !== false,
      batchSize: int(raw.batchSize, AUTO_APPROVE_DEFAULTS.batchSize, 1, 500),
      intervalMs: int(raw.intervalMs, AUTO_APPROVE_DEFAULTS.intervalMs, 5000, 3600000),
      // 拦截条目自动归档天数（0 = 不归档）；实际清扫在 bridge 的定时器里做
      archiveDays: int(raw.archiveDays, 30, 0, 3650),
      extraTerms: Array.isArray(raw.extraTerms) ? raw.extraTerms.slice(0, 500) : [],
      verify: {
        enabled: v.enabled !== false,
        kbDupScore: Math.min(1, Math.max(0.5, Number(v.kbDupScore ?? AUTO_APPROVE_DEFAULTS.verify.kbDupScore) || 0.9)),
        maxVerifyPerRun: int(v.maxVerifyPerRun, AUTO_APPROVE_DEFAULTS.verify.maxVerifyPerRun, 0, 100),
        maxRunMs: int(v.maxRunMs, AUTO_APPROVE_DEFAULTS.verify.maxRunMs, 5000, 600000),
        // 判定模型配置原样透出：控制台要靠它回填表单
        judge: {
          enabled: v.judge?.enabled !== false,
          timeoutMs: int(v.judge?.timeoutMs, AUTO_APPROVE_DEFAULTS.verify.judge.timeoutMs, 3000, 180000),
          maxSources: int(v.judge?.maxSources, AUTO_APPROVE_DEFAULTS.verify.judge.maxSources, 1, 8)
        }
      }
    };
  }

  function domainTermsOf(text) {
    if (typeof extractTerms !== 'function') return { terms: [], domains: [] };
    try {
      return extractTerms(text) ?? { terms: [], domains: [] };
    } catch (error) {
      log(`自动批准代理：专业词提取失败：${error?.message ?? error}`);
      return { terms: [], domains: [] };
    }
  }

  /** 知识库里是否已有无歧义的同一事实（有则免核实直接放行）。 */
  async function findDuplicate(item, cfg) {
    if (!cfg.verify.enabled) return null;
    try {
      const hits = await store.search(item.text, { k: 3, key: item.group ?? '' });
      const top = hits[0];
      if (!top) return null;
      // 归一化后完全相同 → 无歧义，直接算满分（不受分词差异影响）
      const same = normalizeForHash(top.text) === normalizeForHash(item.text);
      if (same) return { ...top, score: 1 };
      if (top.score >= cfg.verify.kbDupScore) return top;
    } catch (error) {
      log(`自动批准代理：知识库检索失败：${error?.message ?? error}`);
    }
    return null;
  }

  function blockPayload(verdict, fallbackTerms) {
    const checked = Array.isArray(verdict.checked) && verdict.checked.length
      ? verdict.checked
      : (fallbackTerms ?? []).map((entry) => ({ term: entry.term }));
    return {
      reason: verdict.verdict === 'contradicted' ? 'contradicted' : 'unverified',
      // 审计里的「命中词」只列专业词：整句检索那一条是查询语句，不是命中的词。
      hits: (checked.some((entry) => entry.kind !== 'claim')
        ? checked.filter((entry) => entry.kind !== 'claim')
        : checked).map((entry) => ({ term: entry.term, category: verifyLabel(verdict.verdict) })),
      verification: {
        verdict: verdict.verdict,
        reason: verdict.reason,
        queries: verdict.queries ?? [],
        sources: verdict.sources ?? [],
        // 判定模型的结论必须落库：事后要能回答「当时为什么判它不可信」
        judgement: verdict.judgement ?? null,
        at: verdict.at ?? now()
      }
    };
  }

  async function run({ force = false } = {}) {
    const cfg = config();
    const at = now();
    if (!cfg.enabled) return { ok: true, skipped: 'disabled', at };

    const pending = store.list({ status: 'pending', limit: 1000 });
    const alreadyBlocked = pending.filter((item) => item.autoBlocked).length;
    // 豁免条目（人格联网查证后的回复）不走自动批准：它们的凭据是「查过」，
    // 不是「核实过」，所以一律留给人看。
    const exempt = pending.filter((item) => item.exempt && !item.autoBlocked);
    const candidates = pending.filter((item) => !item.autoBlocked && !item.exempt);
    if (!candidates.length) {
      stats.skipped += 1;
      stats.lastRunAt = at;
      stats.lastResult = {
        skipped: pending.length ? 'all-blocked' : 'empty',
        pending: pending.length,
        exempt: exempt.length
      };
      return { ok: true, skipped: stats.lastResult.skipped, pending: pending.length, exempt: exempt.length, at };
    }
    // 阈值只看「待处理」的候选：已拦截条目会一直留在待审队列等人工，
    // 把它们算进来，队列一积压阈值就永远满足，等于每条新条目都立刻触发一轮。
    // 上一轮有延后（maxVerifyPerRun / maxRunMs 用尽）时例外：那是已知的未完成工作，接着做。
    const carryover = Number(stats.lastResult?.deferred ?? 0) > 0;
    if (!force && !carryover && candidates.length < cfg.batchSize) {
      stats.skipped += 1;
      return {
        ok: true, skipped: 'below-threshold', pending: pending.length,
        candidates: candidates.length, exempt: exempt.length, batchSize: cfg.batchSize, at
      };
    }

    const deadline = at + cfg.verify.maxRunMs;
    let approved = 0;
    let blocked = 0;
    let failed = 0;
    let deferred = 0;
    const tags = { byKnowledgeBase: 0, byNoTerm: 0, byWeb: 0 };

    const approveWith = async (item, meta) => {
      const result = await store.approve(item.id, {
        autoApproved: { at, by: 'auto-approve-agent' },
        ...meta
      });
      if (result.ok) {
        approved += 1;
        return true;
      }
      failed += 1;
      log(`自动批准代理：批准 ${item.id} 失败：${result.error ?? '未知原因'}`);
      return false;
    };

    const blockWith = (item, payload) => {
      const marked = store.markBlocked(item.id, payload);
      if (marked.ok) {
        blocked += 1;
        return true;
      }
      failed += 1;
      return false;
    };

    // ── 第一批：不联网就能定的一类（知识库已有 / 无专业词）───────────────
    const needVerify = [];
    for (const item of candidates) {
      const banned = scan({ text: item.text, tags: item.tags }, { extraTerms: cfg.extraTerms });
      if (banned.blocked) {
        blockWith(item, {
          reason: 'banned-term',
          hits: banned.hits.map((hit) => ({ term: hit.term, category: hit.category }))
        });
        log(`自动批准代理：拦截 ${item.id}（违禁词：${banned.hits.map((hit) => hit.term).slice(0, 3).join('、')}）`);
        continue;
      }
      const dup = await findDuplicate(item, cfg);
      if (dup) {
        await approveWith(item, {
          verifiedBy: 'knowledge-base',
          verification: { verdict: 'duplicate', duplicateOf: dup.id, score: dup.score, at }
        });
        tags.byKnowledgeBase += 1;
        continue;
      }
      const domain = domainTermsOf(item.text);
      if (!domain.terms.length || !cfg.verify.enabled) {
        await approveWith(item, {
          verifiedBy: 'no-domain-term',
          verification: {
            verdict: 'skipped',
            reason: domain.terms.length ? '联网核实已关闭' : '没有专业词',
            at
          }
        });
        tags.byNoTerm += 1;
        continue;
      }
      needVerify.push({ item, domain });
    }

    // ── 第二批：联网核实 ────────────────────────────────────────────────
    let verifiedThisRun = 0;
    for (const { item, domain } of needVerify) {
      if (now() > deadline || verifiedThisRun >= cfg.verify.maxVerifyPerRun) {
        deferred += 1;
        continue;
      }
      verifiedThisRun += 1;
      let verdict;
      if (typeof verify !== 'function') {
        verdict = { verdict: 'unknown', reason: '没有可用的核实实现', queries: [], sources: [], checked: [], at: now() };
      } else {
        try {
          verdict = await verify(item.text, { terms: domain.terms });
        } catch (error) {
          verdict = {
            verdict: 'unknown',
            reason: `核实异常：${error?.message ?? error}`,
            queries: [], sources: [], checked: [], at: now()
          };
        }
      }
      if (VERIFY_PASS.has(verdict.verdict)) {
        await approveWith(item, {
          verifiedBy: 'web',
          verification: { ...verdict, terms: domain.terms.map((entry) => entry.term) }
        });
        tags.byWeb += 1;
      } else {
        blockWith(item, blockPayload(verdict, domain.terms));
        log(`自动批准代理：拦截 ${item.id}（${verifyLabel(verdict.verdict)}：${verdict.reason}）`);
      }
    }

    stats.runs += 1;
    stats.approved += approved;
    stats.blocked += blocked;
    stats.failed += failed;
    stats.deferred += deferred;
    stats.byKnowledgeBase += tags.byKnowledgeBase;
    stats.byNoTerm += tags.byNoTerm;
    stats.byWeb += tags.byWeb;
    stats.lastRunAt = at;
    stats.lastResult = {
      approved, blocked, failed, deferred, alreadyBlocked,
      scanned: candidates.length, candidates: candidates.length, pending: pending.length,
      exempt: exempt.length,
      byKnowledgeBase: tags.byKnowledgeBase, byNoTerm: tags.byNoTerm, byWeb: tags.byWeb
    };
    log(`自动批准代理：放行 ${approved}（库内复用 ${tags.byKnowledgeBase}、无专业词 ${tags.byNoTerm}、`
      + `联网核实 ${tags.byWeb}）、拦截 ${blocked}、失败 ${failed}、延后 ${deferred}、豁免待人工 ${exempt.length}（原待审 ${pending.length}）`);
    return { ok: true, ran: true, ...stats.lastResult, at };
  }

  return {
    run,
    config,
    stats: () => ({ ...stats }),
    /** 供控制台展示：单条会走哪条路（不写库） */
    preview: (text, tags = []) => {
      const banned = scan({ text, tags }, { extraTerms: config().extraTerms });
      return { banned, domain: domainTermsOf(text) };
    }
  };
}
