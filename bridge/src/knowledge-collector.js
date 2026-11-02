// 聊天采集器：把群聊里「别人说的话」按分钟打包成一条待审知识。
//
// 三条硬规则（都有对应测试）：
//   1. 绝不采集自己（AI）的发言——否则等于让模型把自己的幻觉当成群友事实收进知识库；
//   2. 只要文字消息——图片/表情/语音/合并转发不进包（它们没有可核实的事实文本）；
//   3. 每分钟每会话最多一包、每包最多 20 条，宁可漏也不灌水。
//
// 打包仍然保留原始说话人和原话：这是个「候选事实」，不是结论。要不要变成结论由
// 审核环节（自动批准代理 + 联网核实）判断，采集器不做归纳，也不做删改。

const PUNCT_ONLY_RE = /^[\s\p{P}\p{S}]+$/u;
const CMD_PREFIX_RE = /^[/!！]/;

const DEFAULTS = {
  enabled: true,
  windowMs: 60000,
  maxMessages: 20,
  // 默认 1：群里多是「一两句就停」，阈值卡 3 条会把整包丢掉（实测 8 包全丢）。
  // 噪声靠 minChars(6) 与包装上限压住，碎片由自动批准/人工筛。
  minMessages: 1,
  minChars: 6,
  maxPacksPerHour: 60,
  maxPackChars: 600,
  // true = 打包后直接进 embedding 检索池（桥接读取此开关，不经代理审读）
  direct: false
};

function cleanConfig(raw) {
  const cfg = raw ?? {};
  const int = (value, fallback, min, max) => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    enabled: cfg.enabled !== false,
    windowMs: int(cfg.windowMs, DEFAULTS.windowMs, 5000, 3600000),
    maxMessages: int(cfg.maxMessages, DEFAULTS.maxMessages, 1, 100),
    minMessages: int(cfg.minMessages, DEFAULTS.minMessages, 1, 100),
    minChars: int(cfg.minChars, DEFAULTS.minChars, 1, 200),
    maxPacksPerHour: int(cfg.maxPacksPerHour, DEFAULTS.maxPacksPerHour, 1, 600),
    maxPackChars: int(cfg.maxPackChars, DEFAULTS.maxPackChars, 100, 4000),
    direct: cfg.direct === true
  };
}

function formatClock(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function createKnowledgeCollector({ onFlush, getConfig = () => ({}), now = Date.now, log = () => {} } = {}) {
  const buffers = new Map(); // key -> { startAt, messages: [{sender, text, at}] }
  const packTimes = new Map(); // key -> number[]（最近一小时的打包时间）
  const stats = {
    received: 0, dropped: 0, packs: 0, rejected: 0, lastFlushAt: 0, lastPackAt: 0, hourLimited: 0,
    // 人格联网回复：收了几条、因为没查过网丢了几条
    replies: 0, replyDropped: 0
  };

  const config = () => cleanConfig(getConfig());

  function shouldDrop(text, cfg, last) {
    // 顺序有讲究：命令/媒体占位即使很长也没有事实价值，必须在长度判断之前拦掉
    if (!text) return 'empty';
    if (CMD_PREFIX_RE.test(text)) return 'command';
    if (/^\[(图片|表情|语音|视频|文件|转发消息)/.test(text)) return 'media-placeholder';
    if (text.length < cfg.minChars) return 'too-short';
    if (PUNCT_ONLY_RE.test(text)) return 'punct-only';
    if (last && last.text === text && last.sender) return 'repeat';
    return '';
  }

  function recentPacks(key, cfg) {
    const cutoff = now() - 60 * 60 * 1000;
    const list = (packTimes.get(key) ?? []).filter((at) => at > cutoff);
    packTimes.set(key, list);
    return list;
  }

  /** 把缓冲区打包成一条候选知识；返回 false 表示这一包被丢弃。 */
  function flushKey(key, reason = 'window') {
    const buf = buffers.get(key);
    if (!buf) return null;
    buffers.delete(key);
    const cfg = config();
    const messages = buf.messages.slice(0, cfg.maxMessages);
    if (messages.length < cfg.minMessages) {
      stats.dropped += 1;
      log(`知识采集：${key} 只有 ${messages.length} 条，不足 ${cfg.minMessages} 条，丢弃`);
      return null;
    }
    const list = recentPacks(key, cfg);
    if (list.length >= cfg.maxPacksPerHour && reason !== 'manual') {
      stats.hourLimited += 1;
      log(`知识采集：${key} 一小时已打包 ${list.length} 次，超出上限，丢弃这一包`);
      return null;
    }

    const participants = [...new Set(messages.map((msg) => msg.sender))];
    // 每条带编号：审批代理可以只保留 [2][4] 这类相关行、把唠嗑剥掉
    const lines = messages.map((msg, index) => ({ i: index + 1, sender: msg.sender, text: String(msg.text ?? '') }));
    let body = `群聊片段（${formatClock(buf.startAt)}，${participants.length} 人 ${messages.length} 条）：`
      + `${lines.map((line) => `[${line.i}] ${line.sender}：${line.text}`).join('；')}`;
    if (body.length > cfg.maxPackChars) body = `${body.slice(0, cfg.maxPackChars)}…（截断）`;

    const pack = {
      key,
      source: 'chat',
      text: body,
      lines,
      count: messages.length,
      participants,
      startAt: buf.startAt,
      endAt: messages[messages.length - 1]?.at ?? now(),
      reason,
      tags: ['聊天汇总'],
      note: `自动采集：${key} 的 ${messages.length} 条他人文字消息（${formatClock(buf.startAt)}）`
    };
    stats.packs += 1;
    stats.lastPackAt = now();
    list.push(now());
    packTimes.set(key, list);

    if (typeof onFlush === 'function') {
      try {
        const accepted = onFlush(pack);
        if (accepted === false) {
          stats.rejected += 1;
          return null;
        }
      } catch (error) {
        stats.rejected += 1;
        log(`知识采集：写入失败：${error?.message ?? error}`);
        return null;
      }
    }
    return pack;
  }

  /**
   * 收一条消息。isSelf 为真时直接丢（AI 自己的发言绝不入库）。
   */
  function feed(key, { sender = '', text = '', isSelf = false, isOwner = false } = {}) {
    const cfg = config();
    if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
    const conversation = String(key ?? '').trim();
    if (!conversation) return { ok: false, skipped: 'no-key' };
    const body = String(text ?? '').trim();
    stats.received += 1;
    if (isSelf) {
      stats.dropped += 1;
      return { ok: false, skipped: 'self' };
    }

    const buf = buffers.get(conversation) ?? { startAt: now(), messages: [] };
    const last = buf.messages[buf.messages.length - 1];
    const drop = shouldDrop(body, cfg, last);
    if (drop) {
      stats.dropped += 1;
      return { ok: false, skipped: drop };
    }
    if (!buffers.has(conversation)) buffers.set(conversation, buf);
    buf.messages.push({
      sender: String(sender || (isOwner ? '群主' : '群友')).slice(0, 24),
      text: body.slice(0, 120),
      at: now()
    });

    // 满 20 条立即打包：不等窗口结束，避免长窗口把「每分钟最多 20 条」撑破
    if (buf.messages.length >= cfg.maxMessages) {
      return { ok: true, flushed: flushKey(conversation, 'full') };
    }
    return { ok: true, buffered: buf.messages.length };
  }

  /**
   * 收一条「人格自己的回复」，但只在**它这一轮查过网**时才收。
   *
   * 为什么不是「AI 回复一律收」：没收据的 AI 回复就是幻觉的高发区，和以前一样丢掉。
   * 判据只有一条——这一轮里真的调用过联网搜索（queries 非空），于是这条回复是
   * 「有据可查」的候选事实，豁免「自己想说的话不入库」，直接进待审队列等人工定。
   *
   * 不进缓冲、不打包、不和别人的发言合并：AI 的回复本身就是一条独立陈述，
   * 混进「群聊片段」里既读不懂也审不了。
   */
  function feedReply(key, { text = '', queries = [] } = {}) {
    const cfg = config();
    if (!cfg.enabled) return { ok: false, skipped: 'disabled' };
    const conversation = String(key ?? '').trim();
    if (!conversation) return { ok: false, skipped: 'no-key' };
    const body = String(text ?? '').trim();
    const queryList = (Array.isArray(queries) ? queries : [queries])
      .map((q) => String(q ?? '').trim())
      .filter(Boolean);

    // 没有搜索凭据 → 和普通 AI 发言一样丢掉
    if (!queryList.length) {
      stats.dropped += 1;
      stats.replyDropped += 1;
      return { ok: false, skipped: 'no-search' };
    }
    const drop = shouldDrop(body, cfg, null);
    if (drop) {
      stats.dropped += 1;
      stats.replyDropped += 1;
      return { ok: false, skipped: drop };
    }

    // 与群聊包共用每会话每小时额度，防止人格把知识库刷满
    const list = (packTimes.get(conversation) ?? []).filter((ts) => now() - ts < 3600000);
    if (list.length >= cfg.maxPacksPerHour) {
      stats.hourLimited += 1;
      stats.replyDropped += 1;
      return { ok: false, skipped: 'hour-limit' };
    }
    list.push(now());
    packTimes.set(conversation, list);

    const pack = {
      key: conversation,
      text: body.slice(0, cfg.maxPackChars),
      count: 1,
      participants: ['AI'],
      startAt: now(),
      endAt: now(),
      reason: 'web-reply',
      // 来源仍是 chat：它是在聊天里说出来的事实，只是有了联网凭据
      source: 'chat',
      group: conversation,
      tags: ['联网回复'],
      exempt: { kind: 'web-search', queries: queryList.slice(0, 6), at: now() },
      note: `人格联网查证后的回复（${queryList.length} 次搜索：${queryList.slice(0, 2).join('、')}）`
    };
    stats.packs += 1;
    stats.replies += 1;
    stats.lastPackAt = now();

    if (typeof onFlush === 'function') {
      try {
        const accepted = onFlush(pack);
        if (accepted === false) {
          stats.rejected += 1;
          return { ok: false, skipped: 'rejected' };
        }
      } catch (error) {
        stats.rejected += 1;
        log(`知识采集：写入失败：${error?.message ?? error}`);
        return { ok: false, skipped: 'error' };
      }
    }
    return { ok: true, flushed: pack };
  }

  /** 由定时器调用：把超窗的缓冲都打包。 */
  function tick() {
    const cfg = config();
    const flushed = [];
    for (const [key, buf] of buffers) {
      if (now() - buf.startAt >= cfg.windowMs) {
        const pack = flushKey(key, 'window');
        if (pack) flushed.push(pack);
      }
    }
    if (flushed.length) stats.lastFlushAt = now();
    return flushed;
  }

  function stats_() {
    const buffered = {};
    for (const [key, buf] of buffers) buffered[key] = buf.messages.length;
    return { ...stats, buffered, keys: buffers.size, config: config() };
  }

  function reset() {
    buffers.clear();
    packTimes.clear();
  }

  return { feed, feedReply, tick, flushKey, stats: stats_, reset, config };
}

export { DEFAULTS as COLLECTOR_DEFAULTS };
