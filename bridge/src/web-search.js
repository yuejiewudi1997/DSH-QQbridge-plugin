// 联网搜索（MCP `web_search` 的实现）。
//
// 设计目标：**优先复用 DSH 原本的联网搜索能力**，而不是自己抓 Bing 的搜索结果页。
//
// DSH 的 `web_search` 工具背后是 `@deepseek-ai/dsh-web-search-deepseek`：
// 向 DeepSeek 的 Anthropic 兼容 Messages 端点发一次带 `web_search_20250305`
// 服务端工具的请求，从 `web_search_tool_result` 里取结构化结果。本模块照同一
// 端点/模型/工具参数实现一份最小客户端，于是 QQ 里的 AI 和 DSH 里的 AI 拿到的是
// **同一路搜索结果**；搜索词只发给 DeepSeek（也就是本来就在处理这段对话的同一家），
// 不再把群聊里提炼出来的词发给 Bing。
//
// 凭据解析顺序与 DSH 一致：
//   1. config.json 的 `webSearch.apiKey`（不推荐，明文）
//   2. 环境变量 `DEEPSEEK_API_KEY`（可用 `webSearch.apiKeyEnv` 改）
//   3. DSH 的 `$DSH_HOME/.credentials.yaml` → `refs.<ref>`（DSH 的 Models 页写入的 key）
// 都没有时：回退 Bing（`cn.bing.com` 的 RSS，失败再退回 HTML），保证"永远有一个能用的搜索"。
//
// 安全边界：
// - API key 只发往**校验过**的 HTTPS 端点：必须是 https、必须解析到公网地址
//   （防止把 key 发到 localhost/内网），且禁止跟随重定向（`redirect: error`）。
// - key 永远不写日志、不进错误信息、不进返回结果。
// - 响应体有大小上限；请求有总超时；查询词在 MCP 层已清洗。
// - Bing 走 safe-fetch（SSRF 防护 + 多地址故障切换）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { URL } from 'node:url';
import YAML from 'js-yaml';
import { resolveSafeAddresses, safeFetch } from './safe-fetch.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const DEFAULT_TIMEOUT_MS = 35000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
// Anthropic 兼容响应里文本块/结果块都可能有；这里只要结构化结果。
const SEARCH_TOOL_TYPE = 'web_search_20250305';

const defaultConfig = Object.freeze({
  provider: 'auto',
  apiKey: '',
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  baseURL: '',
  model: DEFAULT_MODEL,
  maxUses: 5,
  maxTokens: 4096,
  maxResults: 8,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  // 结果来源策略（见 applySearchPolicy）：
  // - excludeHosts：国内靠 AI 批量灌水的资讯站，命中就整条丢弃，不交给模型；
  // - gameForumHosts：游戏类查询时把论坛/社区结果排到前面（玩家实测比资讯稿可靠）；
  // - gameQueryHints：判定「这是游戏类查询」的关键词。
  excludeHosts: [
    'baijiahao.baidu.com',   // 百家号
    'sohu.com/a/',           // 搜狐号
    '163.com/dy/',           // 网易号
    'new.qq.com/omn/',       // 腾讯内容开放平台
    'toutiao.com',           // 头条号
    'yidianzixun.com',       // 一点资讯
    'k.sina.com.cn',         // 新浪看点
    'mini.eastday.com',      // 东方头条
    'dayu.uc.cn'             // 大鱼号
  ],
  gameForumHosts: [
    'nga.178.com', 'ngabbs.com', 'bbs.nga.cn',   // NGA
    'tieba.baidu.com',                            // 贴吧
    'gamer.com.tw',                               // 巴哈姆特
    'reddit.com',
    'steamcommunity.com',
    'keylol.com',                                 // 其乐
    'bbs.3dmgame.com',
    'bbs.ali213.net',                             // 游侠论坛
    'bbs.tgbus.com',
    'resetera.com', 'neogaf.com'
  ],
  gameQueryHints: [
    '游戏', '攻略', '版本', '更新公告', '赛季', '卡池', '抽卡', '掉率',
    'steam', 'ps5', 'psn', 'switch', 'xbox', 'ns版', '主机', '手游', '端游', '网游', '联机',
    'dlc', 'mod', '补丁', '平衡性', '数值', '开荒', '毕业装', '配装', 'build',
    '原神', '崩铁', '崩坏', '绝区零', '鸣潮', '明日方舟', '英雄联盟', 'lol', 'dota', '魔兽',
    '怪物猎人', '艾尔登', '黑神话', '塞尔达', '宝可梦', '最终幻想', '无畏契约', 'cs2', 'apex'
  ],
  // Tavily：官方 REST 接口。keyless 模式免 key（有速率限制），配了 API Key 则走正式额度。
  tavily: Object.freeze({
    enabled: true,
    apiKey: '',
    keyless: true,
    searchDepth: 'basic',
    minScore: 0.2,
    maxResults: 6,
    timeoutMs: 20000
  })
});

function stringList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const list = value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : fallback;
}

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 读取 config.json 里的 webSearch 段（不存在就用默认值）。 */
export function loadSearchConfig(root) {
  let file = {};
  try {
    const text = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    file = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {}
  const raw = file?.webSearch && typeof file.webSearch === 'object' && !Array.isArray(file.webSearch) ? file.webSearch : {};
  const provider = ['tavily', 'deepseek', 'bing'].includes(raw.provider) ? raw.provider : 'auto';
  return {
    ...defaultConfig,
    provider,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() ? raw.apiKeyEnv.trim() : DEFAULT_API_KEY_ENV,
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim().replace(/\/+$/, '') : '',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL,
    maxUses: num(raw.maxUses, defaultConfig.maxUses, 1, 5),
    maxTokens: num(raw.maxTokens, defaultConfig.maxTokens, 256, 8192),
    maxResults: num(raw.maxResults, defaultConfig.maxResults, 1, 20),
    timeoutMs: num(raw.timeoutMs, defaultConfig.timeoutMs, 5000, 120000),
    excludeHosts: stringList(raw.excludeHosts, defaultConfig.excludeHosts),
    gameForumHosts: stringList(raw.gameForumHosts, defaultConfig.gameForumHosts),
    gameQueryHints: stringList(raw.gameQueryHints, defaultConfig.gameQueryHints),
    tavily: { ...defaultConfig.tavily, ...(raw.tavily && typeof raw.tavily === 'object' && !Array.isArray(raw.tavily) ? raw.tavily : {}) }
  };
}

/** DSH home：与 dsh-client 的判定保持一致（`DSH_HOME` 优先）。 */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 从 DSH 的凭据文件里取 key。
 * 结构：`refs: { <名称>: <明文值> }`（实测；不是记录 id）。只看指定 ref，绝不遍历其它凭据。
 */
export function readDshCredential(ref) {
  const name = String(ref ?? '').trim();
  if (!name) return '';
  try {
    const doc = YAML.load(fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8'));
    const value = doc?.refs?.[name];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** 解析搜索用的 DeepSeek key；返回 { key, source } —— key 只在这里出现，不落日志。 */
export function resolveSearchApiKey(config) {
  const literal = String(config?.apiKey ?? '').trim();
  if (literal) return { key: literal, source: 'config' };
  const envName = String(config?.apiKeyEnv || DEFAULT_API_KEY_ENV);
  const fromEnv = String(process.env[envName] ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromDsh = readDshCredential(envName);
  if (fromDsh) return { key: fromDsh, source: 'dsh-credentials' };
  return { key: '', source: 'none' };
}

function normalizeSearchUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  // DeepSeek 的结果 URL 会带 `#1` 这类"第几条"的锚点（不是页面真实片段），去掉更干净；
  // 但真实的 `#section` 也可能有意义，所以只去纯数字锚点。
  const cleaned = s.replace(/#\d+$/, '');
  try {
    const url = new URL(cleaned);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** 把 Anthropic Messages 响应映射成统一结果（参照 dsh-web-search-deepseek 的实现）。 */
export function mapDeepSeekResponse(response, maxResults = 8) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result');
  if (!resultBlocks.length) {
    throw Object.assign(new Error('DeepSeek 没有返回 web_search_tool_result（可能未触发联网搜索）'), { code: 'NO_RESULT_BLOCK' });
  }
  const snippets = new Map();
  for (const block of blocks) {
    if (block?.type !== 'text') continue;
    for (const cite of block.citations ?? []) {
      const url = normalizeSearchUrl(cite?.url);
      if (!url || snippets.has(url)) continue;
      const text = String(cite?.cited_text ?? '').trim();
      if (text) snippets.set(url, text);
    }
  }
  const seen = new Set();
  const results = [];
  for (const block of resultBlocks) {
    for (const item of block?.content ?? []) {
      if (item?.type !== 'web_search_result') continue;
      const url = normalizeSearchUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = String(item.title ?? '').trim().slice(0, 200);
      const snippet = String(snippets.get(url) ?? '').trim().slice(0, 500);
      results.push({
        title,
        url,
        ...(snippet ? { snippet } : {}),
        ...(item.page_age ? { publishedAt: String(item.page_age).slice(0, 40) } : {})
      });
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

/** 校验搜索端点：https + 公网地址。返回 { url, addresses }。 */
async function validateSearchEndpoint(baseURL) {
  let url;
  try {
    url = new URL(String(baseURL ?? '').trim());
  } catch {
    throw new Error('webSearch.baseURL 无效');
  }
  if (url.protocol !== 'https:') throw new Error('webSearch.baseURL 必须是 https（API key 只能发给加密端点）');
  if (url.username || url.password) throw new Error('webSearch.baseURL 不能包含凭据');
  const addresses = await resolveSafeAddresses(url.hostname);
  return { url, addresses };
}

/**
 * 向搜索端点 POST JSON（单个已校验地址）。
 * 不复用 safeFetch（它只做 GET）：这里需要 POST、禁止重定向，并把 key 只交给校验过的地址。
 * 网络层失败（连接/超时/中断）由 postJson() 换地址重试；HTTP 状态是结果，不在这里重试。
 */
function postJsonOnce(url, address, { headers, body, timeoutMs, maxBytes = MAX_RESPONSE_BYTES }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`联网搜索请求超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, timeoutMs);
    try {
      req = https.request({
        hostname: address,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          host: url.host,
          'content-length': Buffer.byteLength(body)
        },
        // 证书校验用真实域名（SNI/Host 与站点一致），连接目标才是固定 IP。
        servername: url.hostname,
        rejectUnauthorized: true,
        timeout: timeoutMs
      }, (res) => {
        response = res;
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          finish(new Error(`联网搜索端点返回重定向（HTTP ${status}），已拒绝跟随`));
          res.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            finish(new Error('联网搜索响应体过大，已中止'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('联网搜索响应中断')));
        res.on('close', () => { if (!res.complete) finish(new Error('联网搜索响应中断')); });
        res.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString('utf8');
          finish(null, { status, text });
        });
      });
      req.on('timeout', () => {
        const error = new Error(`联网搜索请求超时（${Math.round(timeoutMs / 1000)}s）`);
        finish(error);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

/** 依次尝试前两个已校验地址（同一失败形态：DNS 先给 IPv6、本机没有 IPv6 出口）。 */
async function postJson(url, addresses, options) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (!list.length) throw new Error('没有任何可用地址');
  const deadline = Date.now() + options.timeoutMs;
  const attempts = Math.min(list.length, 2);
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) break;
    const budget = attempts === 1 ? options.timeoutMs : Math.min(remaining, Math.ceil(options.timeoutMs / 2));
    try {
      return await postJsonOnce(url, list[i], { ...options, timeoutMs: budget });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('联网搜索请求失败');
}

/** DeepSeek 原生联网搜索。失败时抛出带稳定 code 的错误，由调用方决定是否回退。 */
export async function deepseekSearch(query, config = defaultConfig) {
  const { key } = resolveSearchApiKey(config);
  if (!key) {
    throw Object.assign(new Error('没有可用的 DeepSeek API key'), { code: 'NO_KEY' });
  }
  const baseURL = config.baseURL || process.env.DEEPSEEK_SEARCH_BASE_URL || DEFAULT_BASE_URL;
  const { url, addresses } = await validateSearchEndpoint(baseURL);
  const endpoint = new URL(`${url.toString().replace(/\/+$/, '')}/messages`);
  const body = JSON.stringify({
    model: config.model || DEFAULT_MODEL,
    max_tokens: config.maxTokens || defaultConfig.maxTokens,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }]
    }],
    tools: [{
      type: SEARCH_TOOL_TYPE,
      name: 'web_search',
      max_uses: config.maxUses || defaultConfig.maxUses
    }]
  });
  const response = await postJson(endpoint, addresses, {
    headers: {
      'x-api-key': key,
      authorization: `Bearer ${key}`,
      'anthropic-version': DEFAULT_API_VERSION,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'qq-bridge-web-search/0.2.0'
    },
    body,
    timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS
  });
  if (response.status < 200 || response.status >= 300) {
    // 只回显 HTTP 状态与主体里的简短错误，绝不拼接请求头（里面是 key）。
    let detail = '';
    try {
      const parsed = JSON.parse(response.text);
      const message = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message;
      if (typeof message === 'string') detail = message.slice(0, 200);
    } catch {}
    throw Object.assign(
      new Error(`DeepSeek 搜索接口 HTTP ${response.status}${detail ? `：${detail}` : ''}`),
      { code: 'HTTP_ERROR', status: response.status }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw Object.assign(new Error('DeepSeek 搜索接口返回了无法解析的响应'), { code: 'BAD_BODY' });
  }
  return mapDeepSeekResponse(parsed, config.maxResults || defaultConfig.maxResults);
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match ? decodeEntities(match[1]) : '';
}

/** Bing 的 RSS 结果（比 HTML 页面稳定：没有 JS、结构固定）。 */
export function parseBingRss(xml, maxResults = 8) {
  const results = [];
  const seen = new Set();
  for (const match of String(xml ?? '').matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const url = normalizeSearchUrl(pickTag(block, 'link'));
    if (!url || seen.has(url)) continue;
    const title = pickTag(block, 'title').slice(0, 200);
    const snippet = pickTag(block, 'description').slice(0, 500);
    seen.add(url);
    results.push({ title: title || url, url, ...(snippet ? { snippet } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing 的 HTML 结果页（RSS 不可用时的兜底，保持旧实现的解析口径）。 */
export function parseBingHtml(html, maxResults = 8) {
  const results = [];
  const seen = new Set();
  const blocks = String(html ?? '').split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const url = normalizeSearchUrl(decodeEntities(hrefMatch[1]));
    if (!url || seen.has(url)) continue;
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeEntities(titleMatch[1]).slice(0, 200) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeEntities(snippetMatch[1]).slice(0, 500) : '';
    seen.add(url);
    results.push({ title: title || url, url, ...(snippet ? { snippet } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing 搜索（RSS 优先，HTML 兜底）。 */
export async function bingSearch(query, config = defaultConfig) {
  const maxResults = config.maxResults || defaultConfig.maxResults;
  const rss = new URL('https://cn.bing.com/search');
  rss.searchParams.set('q', query);
  rss.searchParams.set('format', 'rss');
  rss.searchParams.set('count', String(Math.min(20, maxResults)));
  rss.searchParams.set('setlang', 'zh-hans');
  rss.searchParams.set('cc', 'CN');
  try {
    const res = await safeFetch(rss.toString(), 512000);
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const results = parseBingRss(res.body, maxResults);
      if (results.length) return results;
    }
  } catch {}
  const html = new URL('https://cn.bing.com/search');
  html.searchParams.set('q', query);
  html.searchParams.set('count', String(Math.min(20, maxResults)));
  html.searchParams.set('setlang', 'zh-hans');
  html.searchParams.set('cc', 'CN');
  const res = await safeFetch(html.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Bing 搜索 HTTP ${res.statusCode}`);
  return parseBingHtml(res.body, maxResults);
}

// ── Tavily ───────────────────────────────────────────────────────────────
// 官方 REST：POST https://api.tavily.com/search
// 两种身份：有 API Key 走 Bearer；没有就走 keyless（加 X-Tavily-Access-Mode: keyless，
// 免 key 但有速率限制）。keyless 是本机目前唯一开箱可用的联网搜索，优先于需要凭据的后端。
const TAVILY_BASE_URL = 'https://api.tavily.com';

export const TAVILY_DEFAULTS = defaultConfig.tavily;

function tavilyConfig(config) {
  const raw = config?.tavily && typeof config.tavily === 'object' ? config.tavily : {};
  const minScore = Number(raw.minScore);
  return {
    enabled: raw.enabled !== false,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    keyless: raw.keyless !== false,
    searchDepth: raw.searchDepth === 'advanced' ? 'advanced' : 'basic',
    minScore: Number.isFinite(minScore) ? Math.min(1, Math.max(0, minScore)) : TAVILY_DEFAULTS.minScore,
    maxResults: num(raw.maxResults, TAVILY_DEFAULTS.maxResults, 1, 20),
    timeoutMs: num(raw.timeoutMs, TAVILY_DEFAULTS.timeoutMs, 3000, 60000)
  };
}

/** Tavily 是否可用（关了、或者既没 key 又关了 keyless，都算不可用）。 */
export function isTavilyEnabled(config) {
  const tv = tavilyConfig(config);
  return tv.enabled && (Boolean(tv.apiKey) || tv.keyless);
}

/** 把 Tavily 响应转成统一形状；低分结果丢掉（keyless 偶尔会混进不相干的页面）。 */
export function mapTavilyResponse(payload, { maxResults = 6, minScore = 0.2 } = {}) {
  const list = Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const url = String(item?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const score = Number(item?.score);
    if (Number.isFinite(score) && score < minScore) continue;
    seen.add(url);
    const title = String(item?.title ?? '').trim() || url;
    const snippet = String(item?.content ?? '').trim();
    out.push({
      title: title.slice(0, 200),
      url,
      ...(snippet ? { snippet: snippet.slice(0, 500) } : {}),
      ...(Number.isFinite(score) ? { score } : {})
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

export async function tavilySearch(query, config = defaultConfig) {
  const tv = tavilyConfig(config);
  if (!tv.enabled) throw new Error('Tavily 已关闭');
  if (!tv.apiKey && !tv.keyless) throw new Error('Tavily 未配置 API Key 且 keyless 已关闭');

  const headers = { 'Content-Type': 'application/json' };
  if (tv.apiKey) headers.Authorization = `Bearer ${tv.apiKey}`;
  else headers['X-Tavily-Access-Mode'] = 'keyless';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tv.timeoutMs);
  let res;
  try {
    res = await fetch(`${TAVILY_BASE_URL}/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: String(query),
        max_results: tv.maxResults,
        search_depth: tv.searchDepth,
        include_answer: false,
        include_raw_content: false
      }),
      signal: controller.signal
    });
  } catch (error) {
    const reason = controller.signal.aborted
      ? `Tavily 搜索超时（${tv.timeoutMs}ms）`
      : `Tavily 搜索失败：${error?.message ?? error}`;
    throw new Error(reason);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) throw new Error('Tavily 限流（keyless 模式有速率限制，配置 API Key 可解除）');
  if (res.status === 401 || res.status === 403) throw new Error(`Tavily 凭据无效（HTTP ${res.status}）`);
  if (!res.ok) throw new Error(`Tavily 搜索 HTTP ${res.status}`);
  const payload = await res.json().catch(() => null);
  return mapTavilyResponse(payload, { maxResults: tv.maxResults, minScore: tv.minScore });
}

const cache = new Map(); // `${provider}|${query}` -> { at, value }

/** 把 URL 归一成「主机名+路径」（小写），用于来源策略匹配。 */
export function hostPathOf(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 搜索结果来源策略：
 * 1) 命中 excludeHosts 的结果整条丢弃（国内靠 AI 灌水的资讯站，不当依据也不引用）；
 * 2) 游戏类查询把论坛/社区结果排到前面（稳定排序，其余保持原顺序）。
 * @returns {{results:object[], dropped:number, isGameQuery:boolean}}
 */
export function applySearchPolicy(results, query, config = defaultConfig) {
  const list = Array.isArray(results) ? results : [];
  // 空数组按「没配置」处理，回落到默认名单（配置写 [] 不会把过滤关掉）
  const pick = (value, fallback) => (Array.isArray(value) && value.length ? value : fallback);
  const exclude = pick(config.excludeHosts, defaultConfig.excludeHosts);
  const forums = pick(config.gameForumHosts, defaultConfig.gameForumHosts);
  const hints = pick(config.gameQueryHints, defaultConfig.gameQueryHints);

  const kept = [];
  let dropped = 0;
  for (const item of list) {
    const hostPath = hostPathOf(item?.url);
    if (hostPath && exclude.some((pattern) => hostPath.includes(pattern))) {
      dropped += 1;
      continue;
    }
    kept.push(item);
  }

  const isGameQuery = hints.some((hint) => String(query ?? '').toLowerCase().includes(hint));
  let ordered = kept;
  if (isGameQuery && forums.length) {
    const isForum = (item) => {
      const hostPath = hostPathOf(item?.url);
      return Boolean(hostPath) && forums.some((pattern) => hostPath.includes(pattern));
    };
    const forumFirst = kept.filter(isForum);
    ordered = [...forumFirst, ...kept.filter((item) => !isForum(item))];
    return { results: ordered, dropped, isGameQuery, promoted: forumFirst.length };
  }
  return { results: ordered, dropped, isGameQuery, promoted: 0 };
}

export function clearSearchCache() {
  cache.clear();
}

/**
 * 统一入口：按配置选择 provider；`auto` 依次试 Tavily（keyless 免 key）→ DeepSeek → Bing。
 * @returns {{query:string, provider:'tavily'|'deepseek'|'bing', results:object[], fallbackFrom?:string, note?:string}}
 */
export async function webSearch(query, options = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('查询词为空');
  const config = { ...loadSearchConfig(options.root ?? process.cwd()), ...(options.config ?? {}) };
  const wanted = options.provider ?? config.provider;
  const cacheKey = `${wanted}|${q}|${config.maxResults}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const attemptTavily = async () => {
    const results = await tavilySearch(q, config);
    return { query: q, provider: 'tavily', results };
  };
  const attemptDeepSeek = async () => {
    const results = await deepseekSearch(q, config);
    return { query: q, provider: 'deepseek', results };
  };
  const attemptBing = async () => {
    const results = await bingSearch(q, config);
    return { query: q, provider: 'bing', results };
  };

  let value;
  if (wanted === 'tavily') {
    value = await attemptTavily();
  } else if (wanted === 'deepseek') {
    value = await attemptDeepSeek();
  } else if (wanted === 'bing') {
    value = await attemptBing();
  } else {
    // auto：Tavily（keyless 免 key）→ DeepSeek（需凭据）→ Bing（抓页面，最不稳定）
    const chain = [['tavily', attemptTavily], ['deepseek', attemptDeepSeek], ['bing', attemptBing]];
    const reasons = [];
    for (const [name, attempt] of chain) {
      try {
        value = await attempt();
        break;
      } catch (error) {
        reasons.push(error?.code === 'NO_KEY'
          ? `${name}：未配置凭据`
          : `${name} 不可用：${error?.message ?? error}`);
      }
    }
    if (!value) throw new Error(`所有搜索后端都失败：${reasons.join('；')}`);
    if (reasons.length) {
      value = {
        ...value,
        fallbackFrom: chain[0][0],
        note: `${reasons.join('；')}，已回退 ${value.provider}`
      };
    }
  }
  // 来源策略：先剔除 AI 灌水资讯站，游戏类查询再把论坛结果排前面。
  const policy = applySearchPolicy(value.results, q, config);
  if (policy.dropped > 0 || policy.isGameQuery) {
    const notes = [];
    if (policy.dropped > 0) notes.push(`已过滤 ${policy.dropped} 条国内 AI 灌水资讯站结果`);
    if (policy.promoted > 0) notes.push('游戏类查询已优先论坛/社区来源');
    value = {
      ...value,
      results: policy.results,
      note: [value.note, ...notes].filter(Boolean).join('；')
    };
  }
  // 空结果必须显式说明：以前直接返回 `results: []`，模型分不清「真没搜到」和
  // 「搜索接口静默失效」，会一直换关键词重试（issue #17）。现在给出可操作的下一步。
  // ⚠️ 这段必须在 `cache.set` **之前**：note 走的是「新建对象」而不是原地改，
  // 而缓存里存的是**引用**。反过来写（先缓存、后加 note）时，5 分钟内的重复查询会命中
  // 那个没有 note 的旧对象 —— 恰好是模型最容易开始重试的场景（同一句 query 连着问）。
  if (Array.isArray(value.results) && value.results.length === 0) {
    value = { ...value, note: [value.note, '没有搜到结果（可换个说法/加限定词；仍为空就不要再重复搜索）'].filter(Boolean).join('；') };
  }
  cache.set(cacheKey, { at: Date.now(), value });
  if (cache.size > CACHE_MAX_ENTRIES) {
    for (const key of [...cache.keys()].slice(0, cache.size - CACHE_MAX_ENTRIES)) cache.delete(key);
  }
  return value;
}
