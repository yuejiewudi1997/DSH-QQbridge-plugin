// 知识库：跨人格共享的「人工审核过的既有事实」。
//
// 为什么必须先审核：聊天和联网检索里学到的东西，有相当一部分是错的、过时的、
// 或者只是某个人随口一说。直接进提示词等于把它固化进人格里，而且事后没法撤回。
// 所以这里所有新条目一律 pending，只有人工批准后才进检索池。
//
// 检索有两种模式：
//   1. 向量（backend = local | cloud）：把条目和查询都送进 embedding 端点，算余弦相似度；
//   2. 关键词（backend = off，或向量调用失败/超时的降级路径）：中文按二元组、英文按词，
//      算查询词的命中比例。
// 两种模式共用同一套过滤规则（只看 approved；private 条目只在来源会话里可见）。

import fs from 'node:fs';
import path from 'node:path';
import { isDevBlockedWrite } from './dev-guard.js';
import crypto from 'node:crypto';

export const KNOWLEDGE_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
});

export const KNOWLEDGE_SOURCES = Object.freeze(['chat', 'web', 'manual']);

const MAX_TEXT_CHARS = 2000;
const MAX_TAGS = 8;
const EMBED_BATCH = 16;

function idOf() {
  return `k_${crypto.randomBytes(6).toString('hex')}`;
}

/** 去掉空白与标点后的小写形式，只用来比对「是不是同一句话」。 */
export function normalizeForHash(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function fingerprint(text) {
  return crypto.createHash('sha1').update(normalizeForHash(text)).digest('hex').slice(0, 16);
}

/** Float32 向量 ↔ base64：JSON 里存浮点数组会让文件膨胀到 20 倍，且精度没意义。 */
export function encodeVector(vec) {
  const f = Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

export function decodeVector(b64) {
  const buf = Buffer.from(String(b64), 'base64');
  const f = new Float32Array(buf.byteLength / 4);
  Buffer.from(f.buffer).set(buf);
  return f;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return -1;
  return dot / Math.sqrt(na * nb);
}

/**
 * 关键词分词：中文没有空格，按二元组切；英文/数字按词切。
 * 单字也留着 —— 「猫」「狗」这种短查询，二元组切不出来。
 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) ?? []) out.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fff]+/gu, ' ');
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    if (seg.length === 1) out.add(seg);
    for (let i = 0; i < seg.length - 1; i += 1) out.add(seg.slice(i, i + 2));
  }
  return out;
}

/** 查询词在条目里的覆盖率（0~1）。 */
export function keywordScore(query, text) {
  const q = tokenize(query);
  if (q.size === 0) return 0;
  const t = tokenize(text);
  let hit = 0;
  for (const token of q) if (t.has(token)) hit += 1;
  return hit / q.size;
}

function clampText(text) {
  return String(text ?? '').trim().slice(0, MAX_TEXT_CHARS);
}

function cleanTags(tags) {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,，\s]+/) : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw ?? '').trim().slice(0, 24);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function normalizeBaseUrl(baseUrl) {
  let url = String(baseUrl ?? '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');
  // 允许只写到主机端口（Ollama 的常见写法），补上 /v1
  if (!/\/v\d+$/i.test(url)) url += '/v1';
  return url;
}

/**
 * embedding 客户端。
 *
 * 支持两种 OpenAI 兼容形状：`{data:[{embedding:[...]}]}`（OpenAI / Ollama /v1）
 * 和 `{embeddings:[[...]]}`（Ollama 原生 /api/embed）。两种都认，省得用户猜。
 */
export function createEmbedder({ backend = 'off', local = {}, cloud = {}, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const mode = backend === 'local' || backend === 'cloud' ? backend : 'off';
  const conf = mode === 'local'
    ? { baseUrl: normalizeBaseUrl(local.baseUrl || 'http://127.0.0.1:11434/v1'), apiKey: '', model: String(local.model || 'nomic-embed-text') }
    : mode === 'cloud'
      ? { baseUrl: normalizeBaseUrl(cloud.baseUrl), apiKey: String(cloud.apiKey ?? ''), model: String(cloud.model ?? '') }
      : { baseUrl: '', apiKey: '', model: '' };

  let lastDim = 0;
  let lastError = '';

  async function embed(texts, { timeoutMs = 8000 } = {}) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? ''));
    if (list.length === 0) return [];
    if (!conf.baseUrl || !conf.model) throw new Error('embedding 端点未配置（baseUrl / model 为空）');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`embedding 请求超时（${timeoutMs}ms）`)), timeoutMs);
    try {
      const res = await fetchImpl(`${conf.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(conf.apiKey ? { authorization: `Bearer ${conf.apiKey}` } : {})
        },
        body: JSON.stringify({ model: conf.model, input: list.length === 1 ? list[0] : list }),
        signal: controller.signal
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`embedding HTTP ${res.status}: ${raw.slice(0, 200)}`);
      let body = null;
      try { body = JSON.parse(raw); } catch { throw new Error(`embedding 返回的不是 JSON：${raw.slice(0, 120)}`); }
      const rows = Array.isArray(body?.data)
        ? body.data.map((row) => row?.embedding)
        : Array.isArray(body?.embeddings) ? body.embeddings : null;
      if (!rows || rows.length !== list.length) throw new Error(`embedding 返回条数不符（要 ${list.length}，给 ${rows?.length ?? 0}）`);
      const vectors = rows.map((row) => (Array.isArray(row) ? row.map(Number) : null));
      if (vectors.some((v) => !v || v.length === 0 || v.some((n) => !Number.isFinite(n)))) throw new Error('embedding 返回了空向量或非数值');
      lastDim = vectors[0].length;
      lastError = '';
      return vectors;
    } catch (error) {
      lastError = String(error?.message ?? error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mode,
    model: conf.model,
    baseUrl: conf.baseUrl,
    get dim() { return lastDim; },
    get lastError() { return lastError; },
    get enabled() { return mode !== 'off' && Boolean(conf.baseUrl && conf.model); },
    embed,
    /** 一次最小调用，验证地址/模型/key 是否可用。 */
    async probe({ timeoutMs = 10000 } = {}) {
      const started = Date.now();
      try {
        const [vec] = await embed(['ping'], { timeoutMs });
        return { ok: true, ms: Date.now() - started, dim: vec.length, model: conf.model, baseUrl: conf.baseUrl, mode };
      } catch (error) {
        return { ok: false, ms: Date.now() - started, error: String(error?.message ?? error), model: conf.model, baseUrl: conf.baseUrl, mode };
      }
    }
  };
}

function isUsableItem(item) {
  return item && typeof item === 'object' && typeof item.id === 'string' && typeof item.text === 'string'
    && Object.values(KNOWLEDGE_STATUS).includes(item.status);
}

/** 对外暴露的形状：不带上万维的向量。 */
export function publicItem(item) {
  if (!item) return null;
  return {
    id: item.id,
    text: item.text,
    tags: item.tags ?? [],
    source: item.source ?? 'manual',
    group: item.group ?? '',
    private: item.private === true,
    status: item.status,
    note: item.note ?? '',
    proposedBy: item.proposedBy ?? '',
    createdAt: item.createdAt ?? 0,
    reviewedAt: item.reviewedAt ?? 0,
    hasVector: Boolean(item.embedding),
    embeddingModel: item.embeddingModel ?? '',
    hits: item.hits ?? 0,
    lastHitAt: item.lastHitAt ?? 0,
    // 自动批准代理留下的痕迹：拦截命中了哪些词、谁在什么时候放行。
    // 这两个字段是审计入口，别为了「形状干净」删掉。
    autoBlocked: item.autoBlocked ?? null,
    autoApproved: item.autoApproved ?? null,
    // 采集流直连入库（未经代理/人格审读）；控制台据此区分「直采」与「审核过」
    directIngested: item.directIngested === true,
    // 放行依据：knowledge-base（库里已有）/ no-domain-term（无需核实）/ web（联网核实过）/ 人工为空
    verifiedBy: item.verifiedBy ?? '',
    // 核实细节：verdict + 来源列表，出问题能回答「当时凭什么信它」
    verification: item.verification ?? null,
    // 豁免：人格自己联网查证后发的回复。判据是「它查过」，不是「它可信」，
    // 所以照样进待审，由人定。
    exempt: item.exempt ?? null,
    // 归档痕迹：拦截太久没人处理 → 挪去「已拒绝」，但拦截凭据一条不丢，可原样放回待审。
    archivedAt: item.archivedAt ?? 0,
    archivedFrom: item.archivedFrom ?? '',
    restoredAt: item.restoredAt ?? 0
  };
}

/**
 * 知识库存储。
 *
 * @param file - 落盘路径（bridge/state/knowledge.json）
 * @param embedder - createEmbedder 的返回值
 */
export function createKnowledgeStore({ file, embedder, getEmbedder, log = () => {}, maxEntries = 3000, minScore = 0.25, now = Date.now, scanItem = null } = {}) {
  let state = { version: 1, items: [] };
  const vectorCache = new Map();
  // 换后端/换模型只需要重建 embedder，存储这边通过 getEmbedder 拿最新的那个，
  // 不用把已建好的 store 丢掉（丢掉就得重新解码整个向量缓存）。
  const emb = () => (typeof getEmbedder === 'function' ? getEmbedder() : embedder);

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw?.items)) state = { version: 1, items: raw.items.filter(isUsableItem) };
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`知识库读取失败（按空库启动）：${error?.message ?? error}`);
    }
  }

  function save() {
    // 开发者模式：知识库属于 AI 产生的落盘，一律不写。
    if (isDevBlockedWrite(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
  }

  load();

  function find(id) {
    return state.items.find((item) => item.id === id) ?? null;
  }

  function dropVector(id) {
    vectorCache.delete(id);
  }

  /**
   * 新增一条（默认进 pending）。
   * 同一句话（去空白标点后）已经存在时直接返回既有条目，避免各群重复提同一条。
   */
  /**
   * 豁免凭据：必须是「查过什么」，空的查询列表一律当没有凭据（免得凭空豁免）。
   */
  function cleanExempt(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const queries = (Array.isArray(raw.queries) ? raw.queries : [])
      .map((q) => String(q ?? '').trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 6);
    if (!queries.length) return null;
    return { kind: String(raw.kind ?? 'web-search').slice(0, 24), queries, at: Number(raw.at) || now() };
  }

  function add({ text, tags, source = 'manual', group = '', private: isPrivate = false, proposedBy = '', note = '', exempt = null, lines = null } = {}) {
    const clean = clampText(text);
    if (!clean) return { ok: false, error: '内容不能为空' };
    const fp = fingerprint(clean);
    const dup = state.items.find((item) => (item.fingerprint ?? fingerprint(item.text)) === fp && item.status !== KNOWLEDGE_STATUS.REJECTED);
    if (dup) return { ok: false, duplicate: true, id: dup.id, status: dup.status };
    if (state.items.length >= maxEntries) return { ok: false, error: `知识库已满（${maxEntries} 条），请先清理` };

    const item = {
      id: idOf(),
      text: clean,
      fingerprint: fp,
      tags: cleanTags(tags),
      source: KNOWLEDGE_SOURCES.includes(source) ? source : 'manual',
      group: String(group ?? ''),
      private: isPrivate === true,
      status: KNOWLEDGE_STATUS.PENDING,
      note: String(note ?? '').slice(0, 300),
      exempt: cleanExempt(exempt),
      proposedBy: String(proposedBy ?? '').slice(0, 80),
      createdAt: now(),
      reviewedAt: 0,
      embedding: null,
      embeddingModel: '',
      hits: 0,
      lastHitAt: 0,
      // 采集包的原始行（带编号），审批代理据此剥离无关内容；普通条目为空
      lines: Array.isArray(lines) ? lines.slice(0, 100).map((line, index) => ({
        i: Number(line?.i ?? index + 1),
        sender: String(line?.sender ?? '').slice(0, 80),
        text: String(line?.text ?? '').slice(0, 500)
      })) : null
    };
    // 入库即过闸门：命中违禁词先打标记，控制台立刻能看见「已拦截」，
    // 而不是等代理攒够 20 条才扫（那样前 19 条看起来像还没审过）。
    if (typeof scanItem === 'function') {
      try {
        const verdict = scanItem({ text: item.text, tags: item.tags });
        if (verdict?.blocked) {
          item.autoBlocked = {
            at: now(),
            reason: 'banned-term',
            hits: (verdict.hits ?? []).slice(0, 20).map((hit) => ({ term: hit.term, category: hit.category }))
          };
        }
      } catch (error) {
        log(`知识库：入库扫描失败（${error?.message ?? error}），该条按未拦截处理`);
      }
    }
    state.items.push(item);
    save();
    return { ok: true, item: publicItem(item) };
  }

  /** 自动批准代理专用：给待审条目打「已拦截」标记（不改状态，仍留在待审队列等人工）。 */
  function markBlocked(id, { hits = [], reason = 'banned-term', verification = null } = {}) {
    const item = find(id);
    if (!item) return { ok: false, error: '条目不存在' };
    if (item.status !== KNOWLEDGE_STATUS.PENDING) return { ok: false, error: '只有待审条目会被拦截' };
    item.autoBlocked = {
      at: now(),
      reason,
      hits: (hits ?? []).slice(0, 20).map((hit) => ({ term: hit.term, category: hit.category }))
    };
    if (verification) item.verification = verification;
    save();
    return { ok: true, item: publicItem(item) };
  }

  /**
   * 直接入库并向量化（群聊采集专用）：不经过代理/人格审读。
   *
   * - 命中违禁词：add() 已打 autoBlocked 标记，保持 pending、不做向量，
   *   留给人工或自动批准代理处理（直采路径不替人放行敏感内容）。
   * - 其余：直接 approved + 写 embedding，下一次检索就能用。
   * - 库满时优先淘汰最旧的直采条目（采集流本来就要滚动），不因为「满了」静默停止学习。
   */
  async function ingest({ text, tags, source = 'chat', group = '', private: isPrivate = false, proposedBy = 'chat-collector', note = '', exempt = null, lines = null } = {}) {
    // 库满：先给直采条目腾位置（人工加的不动）
    let evicted = 0;
    while (state.items.length >= maxEntries) {
      const victim = state.items
        .filter((item) => item.directIngested && item.status === KNOWLEDGE_STATUS.APPROVED)
        .sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0))[0];
      if (!victim) break;
      dropVector(victim.id);
      state.items = state.items.filter((item) => item.id !== victim.id);
      evicted += 1;
    }
    const added = add({ text, tags, source, group, private: isPrivate, proposedBy, note, exempt, lines });
    if (!added.ok) return { ...added, evicted };
    const item = find(added.item.id);
    if (!item) return { ok: false, error: '条目不存在', evicted };
    if (item.autoBlocked) {
      save();
      return { ok: true, id: item.id, status: item.status, embedded: false, blocked: true, evicted };
    }
    item.status = KNOWLEDGE_STATUS.APPROVED;
    item.reviewedAt = now();
    item.directIngested = true;
    let embedded = false;
    if (emb()?.enabled) {
      try {
        const [vec] = await emb().embed([item.text]);
        item.embedding = encodeVector(vec);
        item.embeddingModel = emb().model;
        vectorCache.set(item.id, Float32Array.from(vec));
        embedded = true;
      } catch (error) {
        log(`知识库条目 ${item.id} 向量化失败（先用关键词检索）：${error?.message ?? error}`);
      }
    }
    save();
    return { ok: true, id: item.id, status: item.status, embedded, blocked: false, evicted, item: publicItem(item) };
  }

  /**
   * 把「拦截后超过 N 天没人处理」的待审条目归档到已拒绝。
   * 只动被拦截的：正常待审还在等自动批准排队，不该被时间清走。
   * 凭据全留（autoBlocked / verification / note 追加一句），restore() 能原样放回。
   */
  function archiveStaleBlocked({ olderThanMs = 0, at = now() } = {}) {
    if (!(olderThanMs > 0)) return { ok: true, archived: 0, at };
    const cutoff = at - olderThanMs;
    const days = Math.max(1, Math.round(olderThanMs / 86400000));
    const stale = state.items.filter((item) => item.status === KNOWLEDGE_STATUS.PENDING
      && item.autoBlocked
      && Number(item.autoBlocked.at ?? 0) > 0
      && Number(item.autoBlocked.at) < cutoff);
    for (const item of stale) {
      item.status = KNOWLEDGE_STATUS.REJECTED;
      item.reviewedAt = at;
      item.archivedAt = at;
      item.archivedFrom = KNOWLEDGE_STATUS.PENDING;
      const stamp = new Date(Number(item.autoBlocked.at)).toISOString().slice(0, 10);
      const line = `超期未确认：拦截于 ${stamp}，${days} 天无人处理，已自动归档（可放回待审）`;
      item.note = item.note ? `${item.note} ｜ ${line}` : line;
    }
    if (stale.length) save();
    return { ok: true, archived: stale.length, at, days };
  }

  /** 把归档条目放回待审（拦截标记与核实凭据都还在）。 */
  function restore(id, { at = now() } = {}) {
    const item = find(id);
    if (!item) return { ok: false, error: '条目不存在' };
    if (!item.archivedAt) return { ok: false, error: '只有自动归档的条目可以放回待审' };
    item.status = KNOWLEDGE_STATUS.PENDING;
    item.restoredAt = at;
    item.archivedAt = 0;
    item.archivedFrom = '';
    save();
    return { ok: true, item: publicItem(item) };
  }

  function update(id, patch = {}) {
    const item = find(id);
    if (!item) return { ok: false, error: '条目不存在' };
    if (patch.text !== undefined) {
      const clean = clampText(patch.text);
      if (!clean) return { ok: false, error: '内容不能为空' };
      if (clean !== item.text) {
        item.text = clean;
        item.fingerprint = fingerprint(clean);
        item.embedding = null;
        item.embeddingModel = '';
        item.autoBlocked = null; // 改过正文就重新过闸，别让旧标记赖着不走
        dropVector(id);
      }
    }
    if (patch.tags !== undefined) {
      const nextTags = cleanTags(patch.tags);
      if (JSON.stringify(nextTags) !== JSON.stringify(item.tags)) item.autoBlocked = null;
      item.tags = nextTags;
    }
    if (patch.autoApproved !== undefined) item.autoApproved = patch.autoApproved;
    if (patch.verifiedBy !== undefined) item.verifiedBy = String(patch.verifiedBy ?? '');
    if (patch.verification !== undefined) item.verification = patch.verification;
    if (patch.note !== undefined) item.note = String(patch.note ?? '').slice(0, 300);
    if (patch.private !== undefined) item.private = patch.private === true;
    if (patch.group !== undefined) item.group = String(patch.group ?? '');
    save();
    return { ok: true, item: publicItem(item) };
  }

  /** 批准：先改状态再补向量；向量失败不影响批准（降级到关键词检索）。 */
  async function approve(id, patch = {}) {
    const item = find(id);
    if (!item) return { ok: false, error: '条目不存在' };
    if (patch && Object.keys(patch).length) {
      const applied = update(id, patch);
      if (!applied.ok) return applied;
    }
    item.status = KNOWLEDGE_STATUS.APPROVED;
    item.reviewedAt = now();
    // 放行即解除拦截标记：已批准条目还挂着 autoBlocked 会让审计看不明白
    delete item.autoBlocked;
    let embedded = false;
    if (emb()?.enabled) {
      try {
        const [vec] = await emb().embed([item.text]);
        item.embedding = encodeVector(vec);
        item.embeddingModel = emb().model;
        vectorCache.set(id, Float32Array.from(vec));
        embedded = true;
      } catch (error) {
        log(`知识库条目 ${id} 向量化失败（先用关键词检索）：${error?.message ?? error}`);
      }
    }
    save();
    return { ok: true, item: publicItem(item), embedded };
  }

  function reject(id, note = '') {
    const item = find(id);
    if (!item) return { ok: false, error: '条目不存在' };
    item.status = KNOWLEDGE_STATUS.REJECTED;
    item.reviewedAt = now();
    if (note) item.note = String(note).slice(0, 300);
    dropVector(id);
    save();
    return { ok: true, item: publicItem(item) };
  }

  function remove(id) {
    const index = state.items.findIndex((item) => item.id === id);
    if (index < 0) return { ok: false, error: '条目不存在' };
    state.items.splice(index, 1);
    dropVector(id);
    save();
    return { ok: true };
  }

  /** 把多条合并成一条（保留最早那条的 id），其余进 rejected 以便追溯。 */
  function merge(ids, { text, tags } = {}) {
    const list = (Array.isArray(ids) ? ids : []).map((id) => find(id)).filter(Boolean);
    if (list.length < 2) return { ok: false, error: '至少选两条才能合并' };
    const keep = list[0];
    const mergedText = clampText(text || list.map((item) => item.text).join('；'));
    keep.text = mergedText;
    keep.fingerprint = fingerprint(mergedText);
    keep.tags = cleanTags(tags ?? [...new Set(list.flatMap((item) => item.tags ?? []))]);
    keep.embedding = null;
    keep.embeddingModel = '';
    dropVector(keep.id);
    for (const item of list.slice(1)) {
      item.status = KNOWLEDGE_STATUS.REJECTED;
      item.reviewedAt = now();
      item.note = `已合并到 ${keep.id}`;
      dropVector(item.id);
    }
    save();
    return { ok: true, item: publicItem(keep), merged: list.length };
  }

  /** 取一条原始条目（审批代理读 lines 用；不要给控制台/模型）。 */
  function get(id) {
    const item = find(String(id ?? ''));
    return item ? { ...item, lines: item.lines ?? null } : null;
  }

  function list({ status, q = '', limit = 200 } = {}) {
    let items = state.items;
    if (status) items = items.filter((item) => item.status === status);
    const needle = String(q ?? '').trim().toLowerCase();
    if (needle) items = items.filter((item) => item.text.toLowerCase().includes(needle) || (item.tags ?? []).some((tag) => tag.toLowerCase().includes(needle)));
    items = [...items].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return items.slice(0, Math.max(1, limit)).map(publicItem);
  }

  function stats() {
    const count = (status) => state.items.filter((item) => item.status === status).length;
    return {
      total: state.items.length,
      pending: count(KNOWLEDGE_STATUS.PENDING),
      approved: count(KNOWLEDGE_STATUS.APPROVED),
      rejected: count(KNOWLEDGE_STATUS.REJECTED),
      withVector: state.items.filter((item) => item.status === KNOWLEDGE_STATUS.APPROVED && item.embedding).length,
      embedder: { mode: emb()?.mode ?? 'off', model: emb()?.model ?? '', enabled: Boolean(emb()?.enabled) }
    };
  }

  function searchable(key) {
    return state.items.filter((item) => item.status === KNOWLEDGE_STATUS.APPROVED
      && item.text
      && (item.private !== true || (key && item.group === key)));
  }

  /**
   * 检索。优先向量，失败/超时/未启用时退回关键词。
   * @returns {Promise<Array<{id,text,tags,source,group,private,score,mode}>>}
   */
  async function search(query, { k = 5, key = '', timeoutMs = 1500 } = {}) {
    const text = String(query ?? '').trim();
    if (!text) return [];
    const pool = searchable(key);
    if (pool.length === 0) return [];
    const limit = Math.max(1, Math.min(50, Number(k) || 5));

    if (emb()?.enabled) {
      try {
        const [qv] = await emb().embed([text], { timeoutMs });
        if (qv?.length) {
          const activeModel = String(emb()?.model ?? '');
          const scored = [];
          for (const item of pool) {
            // 换过模型却没重建的条目：旧向量与当前查询不在同一个空间，余弦值没有意义。
            // 维度相同也救不了（不同模型的 1024 维互不可比），只能让它退回关键词参与，
            // 否则排序和阈值会被静默污染。
            if (activeModel && item.embeddingModel && item.embeddingModel !== activeModel) continue;
            let vec = vectorCache.get(item.id);
            if (!vec && item.embedding) {
              vec = decodeVector(item.embedding);
              vectorCache.set(item.id, vec);
            }
            if (!vec || vec.length !== qv.length) continue;
            const score = cosine(qv, vec);
            if (score >= minScore) scored.push({ item, score });
          }
          if (scored.length) {
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, limit).map(({ item, score }) => withScore(item, score, 'vector'));
          }
        }
      } catch (error) {
        log(`知识库向量检索失败，退回关键词：${error?.message ?? error}`);
      }
    }

    const scored = [];
    for (const item of pool) {
      const score = keywordScore(text, `${item.text} ${(item.tags ?? []).join(' ')}`);
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ item, score }) => withScore(item, score, 'keyword'));
  }

  function withScore(item, score, mode) {
    return {
      id: item.id,
      text: item.text,
      tags: item.tags ?? [],
      source: item.source ?? 'manual',
      group: item.group ?? '',
      private: item.private === true,
      score: Number(score.toFixed(4)),
      mode,
      createdAt: Number(item.createdAt ?? 0)
    };
  }

  /** 记一次命中，用于「哪些知识真的有用」的排序参考。 */
  function touch(ids) {
    let dirty = false;
    for (const id of ids ?? []) {
      const item = find(id);
      if (!item) continue;
      item.hits = (item.hits ?? 0) + 1;
      item.lastHitAt = now();
      dirty = true;
    }
    if (dirty) save();
  }

  /** 重新向量化所有已批准条目（换模型/首次接上 embedding 时用）。 */
  async function reindex({ limit = 500 } = {}) {
    if (!emb()?.enabled) return { ok: false, error: 'embedding 未启用' };
    const approvedAll = state.items.filter((item) => item.status === KNOWLEDGE_STATUS.APPROVED);
    const targets = approvedAll.slice(0, limit);
    let done = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i += EMBED_BATCH) {
      const batch = targets.slice(i, i + EMBED_BATCH);
      try {
        const vectors = await emb().embed(batch.map((item) => item.text));
        batch.forEach((item, index) => {
          item.embedding = encodeVector(vectors[index]);
          item.embeddingModel = emb().model;
          vectorCache.set(item.id, Float32Array.from(vectors[index]));
        });
        done += batch.length;
        save();
      } catch (error) {
        failed += batch.length;
        log(`知识库重建向量失败（第 ${i / EMBED_BATCH + 1} 批）：${error?.message ?? error}`);
        break;
      }
    }
    return {
      ok: true, done, failed, total: targets.length,
      // 单次有上限（默认 500）：还有没处理的就明确告诉控制台，别让用户以为已经全量重建
      remaining: Math.max(0, approvedAll.length - targets.length),
      model: emb().model
    };
  }

  return {
    add, ingest, update, approve, reject, remove, merge, get, list, stats, search, touch, reindex, markBlocked,
  archiveStaleBlocked, restore,
    get file() { return file; },
    /** 仅供测试/诊断 */
    _raw: () => state.items
  };
}

/** 拼进提示词的块。只在有问题的时候才拼，别让每条消息都多几百字。 */
/**
 * 注入上下文前的重排：向量分只代表"语义相近"，但原始「群聊片段」和超长条目
 * 对任何话题都相似，会把真正的新事实挤出 topK（表现就是「知识库参考永远是旧的」）。
 * 这里按类型/长度/新鲜度做温和加权，不改变检索本身。
 */
export function rankHitsForContext(hits, { now = Date.now() } = {}) {
  const list = Array.isArray(hits) ? hits.filter((h) => h && typeof h === 'object') : [];
  const ranked = list.map((hit) => {
    const text = String(hit.text ?? '');
    let score = Number(hit.score) || 0;
    if (text.startsWith('群聊片段')) score *= 0.55;
    if (text.length > 400) score *= 0.85;
    else if (text.length > 200) score *= 0.95;
    if (text.length <= 120) score *= 1.05;
    const created = Number(hit.createdAt ?? 0);
    if (created > 0) {
      const days = (now - created) / 86400000;
      if (days <= 3) score *= 1.2;
      else if (days <= 14) score *= 1.08;
    }
    return { ...hit, score: Number(score.toFixed(4)) };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

export function buildKnowledgeBlock(items, { maxChars = 1200, currentKey = '' } = {}) {
  const list = Array.isArray(items) ? items.filter((item) => item?.text) : [];
  if (list.length === 0) return '';
  const lines = [
    '【知识库参考】以下是从以往聊天/检索里记下的内容（有的经过人工审核，有的按「群聊片段」原样入库、未改写）。只在和当前话题相关时使用；'
    + '不要逐条复述，也不要把它们当成用户刚说的话。与当前话题无关就忽略。'
    + '带「来自 group:xxx」标记的是**别的群**的事，不要当成当前群的情况。'
  ];
  let used = lines[0].length;
  for (const item of list) {
    const tags = item.tags?.length ? `（${item.tags.join('/')}）` : '';
    // 来源群只在跨群时标注：同群的知识标了是噪音，跨群的标了才知道「这不是咱群的事」
    const fromOther = item.group && currentKey && item.group !== currentKey
      ? `［来自 ${item.group}］`
      : '';
    const line = `- ${item.text}${tags}${fromOther}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? lines.join('\n') : '';
}
