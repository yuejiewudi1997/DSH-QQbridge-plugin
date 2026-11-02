// 群聊消息收件箱：按「发起人」分队列、按时间段过期、给提示词做分组渲染。
//
// 以前的提示词是一锅「最近 15 条」平铺，模型分不清：
//   1. 同一句话被谁说的、说了几次；
//   2. 隔了多久（同一句话 8 秒前说和 3 分钟前说是两种语境）；
//   3. 中间别人插进来的图片、随口一句，到底算不算「跟我说的话」。
// 结果是 AI 拿别人的图和无关闲聊当回应依据，或者把隔了很久的话接成一句话。
//
// 现在的模型：
//   - 每个群友一个队列（`senderId` 维度），同一个人在一段时间内说的话全在一条队列里；
//   - 队列有过期时间：超过 `ttlMs` 的条目逐步丢弃，队列空了就把这个人从名单里删掉；
//   - 每个队列有条数上限、每个会话有人数上限，防止刷屏群把上下文撑爆；
//   - 渲染时先定「当前话题对象」：**最后一条带文字的发言者**（纯图片/表情不抢话题），
//     并给出「最后发言 / 最后一条文字」距现在多久，方便模型判断该不该接、隔了多久；
//   - 其他人的文字只在**和当前话题相似度达标**时才作为背景带上，否则直接丢；
//   - 其他人的图片/表情一律不进「回应依据」，只在末尾报一个数量。
//
// 这里全是纯函数式状态 + 可注入配置，方便离线测试（scripts/test-social-inbox.mjs）。

export const INBOX_DEFAULTS = Object.freeze({
  // 一条消息在上下文里最多活多久：10 分钟。更早的彻底丢弃。
  ttlMs: 10 * 60 * 1000,
  // 单个人最多保留多少条（同一时段连续刷屏时丢最旧的）。
  perSenderMax: 12,
  // 一个会话最多保留几个人的队列。
  maxSenders: 16,
  // 一个会话所有队列加起来最多多少条。
  maxTotal: 80,
  // 「当前话题对象」只有在最近这段时间内说过话才算数（更早的只当背景）。
  focusWindowMs: 90 * 1000,
  // 其他群友的文字和当前话题的最低相似度（0~1），低于这个值不进上下文。
  topicMinSim: 0.1,
  // 渲染后的上下文块最长字符数。
  maxChars: 1400
});

const TEXT_LIMIT = 200;
const MEDIA_KINDS = new Set(['image', 'sticker', 'face', 'video', 'record', 'flash', 'file']);

/** 取一条消息里的媒体种类（去重），用于判断「纯图片消息」。 */
export function mediaKinds(media) {
  const kinds = new Set();
  for (const item of Array.isArray(media) ? media : []) {
    const kind = String(item?.type ?? item?.kind ?? 'image').toLowerCase();
    if (MEDIA_KINDS.has(kind)) kinds.add(kind);
  }
  return [...kinds];
}

/** 文本归一化：去掉标点/空白，用于相似度比较。 */
function normalizeForSim(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\[cq:[^\]]*\]/gi, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 切成「中文二元组 + 英文/数字单词」的集合。 */
export function textTokens(text) {
  const norm = normalizeForSim(text);
  const tokens = new Set();
  for (const word of norm.match(/[a-z0-9]+/g) ?? []) tokens.add(word);
  const cjk = [...norm].filter((ch) => /[\u3400-\u9fff\uf900-\ufaff]/.test(ch));
  for (let i = 0; i + 1 < cjk.length; i += 1) tokens.add(cjk[i] + cjk[i + 1]);
  if (cjk.length === 1) tokens.add(cjk[0]);
  return tokens;
}

/** 话题相似度（Jaccard），0~1。任一方为空返回 0。 */
export function topicSimilarity(a, b) {
  const left = textTokens(a);
  const right = textTokens(b);
  if (!left.size || !right.size) return 0;
  let inter = 0;
  for (const token of left) if (right.has(token)) inter += 1;
  return inter / (left.size + right.size - inter);
}

function truncate(text, limit = TEXT_LIMIT) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function fmtGap(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `-${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `-${minutes}m`;
  return `-${Math.round(minutes / 60)}h`;
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveInboxOptions(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    ttlMs: num(src.ttlMs, INBOX_DEFAULTS.ttlMs),
    perSenderMax: Math.max(1, Math.round(num(src.perSenderMax, INBOX_DEFAULTS.perSenderMax))),
    maxSenders: Math.max(1, Math.round(num(src.maxSenders, INBOX_DEFAULTS.maxSenders))),
    maxTotal: Math.max(1, Math.round(num(src.maxTotal, INBOX_DEFAULTS.maxTotal))),
    focusWindowMs: num(src.focusWindowMs, INBOX_DEFAULTS.focusWindowMs),
    topicMinSim: Math.min(1, num(src.topicMinSim, INBOX_DEFAULTS.topicMinSim)),
    maxChars: Math.max(200, Math.round(num(src.maxChars, INBOX_DEFAULTS.maxChars)))
  };
}

/**
 * 创建收件箱。
 * @param {object} [initial] 固定配置；也可传 `options: () => object` 让配置热更新。
 */
export function createSocialInbox(initial = {}) {
  const provider = typeof initial.options === 'function' ? initial.options : null;
  const fixed = provider ? {} : resolveInboxOptions(initial);
  /** @type {Map<string, Map<string, {name:string,id:string,items:object[]}>>} */
  const boxes = new Map();

  const options = () => (provider ? resolveInboxOptions(provider()) : fixed);

  function boxFor(key) {
    let box = boxes.get(key);
    if (!box) {
      box = new Map();
      boxes.set(key, box);
    }
    return box;
  }

  function prune(box, opts, now) {
    for (const [id, queue] of box) {
      queue.items = queue.items.filter((item) => now - item.at <= opts.ttlMs);
      if (queue.items.length === 0) box.delete(id);
    }
    // 人太多：丢最后发言最早的那个人
    while (box.size > opts.maxSenders) {
      let oldest = null;
      for (const [id, queue] of box) {
        const lastAt = queue.items[queue.items.length - 1]?.at ?? 0;
        if (!oldest || lastAt < oldest.lastAt) oldest = { id, lastAt };
      }
      if (!oldest) break;
      box.delete(oldest.id);
    }
    // 总条数太多：全局丢最旧的条目
    let total = 0;
    for (const queue of box.values()) total += queue.items.length;
    while (total > opts.maxTotal) {
      let oldest = null;
      for (const queue of box.values()) {
        const first = queue.items[0];
        if (first && (!oldest || first.at < oldest.at)) oldest = first;
      }
      if (!oldest) break;
      for (const queue of box.values()) {
        const index = queue.items.indexOf(oldest);
        if (index >= 0) {
          queue.items.splice(index, 1);
          total -= 1;
          break;
        }
      }
    }
    for (const [id, queue] of box) if (queue.items.length === 0) box.delete(id);
  }

  return {
    /**
     * 记一条消息。同一个人（senderId）进同一条队列。
     * @param {string} key 会话 key（group:xxx / private:xxx）
     */
    append(key, message = {}, now = Date.now()) {
      const opts = options();
      const sender = String(message.sender ?? '').trim() || '群友';
      const senderId = String(message.senderId ?? '').trim() || sender;
      const box = boxFor(key);
      let queue = box.get(senderId);
      if (!queue) {
        queue = { name: sender, id: senderId, items: [] };
        box.set(senderId, queue);
      }
      queue.name = sender;
      queue.items.push({
        at: now,
        text: truncate(message.text ?? ''),
        plain: truncate(message.plain ?? message.text ?? ''),
        isOwner: message.isOwner === true,
        media: Array.isArray(message.media) ? mediaKinds(message.media) : [],
        mediaCount: Array.isArray(message.media) ? message.media.length : 0,
        messageId: message.messageId ? String(message.messageId) : '',
        quoteTargetIsSelf: message.quoteTargetIsSelf === true
      });
      if (queue.items.length > opts.perSenderMax) queue.items.splice(0, queue.items.length - opts.perSenderMax);
      prune(box, opts, now);
      return this;
    },

    /** 过期清理（定时器可周期调用；读的时候也会自动清理）。 */
    prune(key = null, now = Date.now()) {
      const opts = options();
      if (key) {
        const box = boxes.get(key);
        if (box) prune(box, opts, now);
      } else {
        for (const box of boxes.values()) prune(box, opts, now);
      }
    },

    /**
     * 当前视角：谁是话题对象、他这轮说了什么、别人的文字是否相关、别人的图片有几条。
     */
    snapshot(key, now = Date.now()) {
      const opts = options();
      const box = boxFor(key);
      prune(box, opts, now);

      const all = [];
      for (const queue of box.values()) for (const item of queue.items) all.push({ ...item, sender: queue.name, senderId: queue.id });
      all.sort((a, b) => a.at - b.at);

      const withText = all.filter((item) => String(item.plain ?? '').trim());
      // 话题对象：最后一条「带文字」的发言者；全是图片时才退回到最后发言的人
      const focusItem = withText.length ? withText[withText.length - 1] : all[all.length - 1];
      if (!focusItem) {
        return { focus: null, others: [], imageCount: 0, omittedText: 0, total: 0, expired: 0 };
      }
      const focusQueue = box.get(focusItem.senderId);
      const focusItems = (focusQueue?.items ?? []).map((item) => ({ ...item, sender: focusQueue.name }));
      const focusTexts = focusItems.map((item) => item.plain).filter(Boolean);
      const lastText = focusItems.filter((item) => String(item.plain ?? '').trim()).pop() ?? null;

      const others = [];
      let imageCount = 0;
      let omittedText = 0;
      for (const [id, queue] of box) {
        if (id === focusItem.senderId) continue;
        const images = queue.items.filter((item) => !String(item.plain ?? '').trim());
        imageCount += images.reduce((sum, item) => sum + Math.max(1, item.mediaCount ?? 0), 0);

        const texts = queue.items.filter((item) => String(item.plain ?? '').trim());
        if (!texts.length) continue;
        // 话题相似度：和话题对象的任一句比，取最高
        const similar = texts.filter((item) => {
          const best = focusTexts.reduce((max, text) => Math.max(max, topicSimilarity(item.plain, text)), 0);
          return best >= opts.topicMinSim;
        });
        omittedText += texts.length - similar.length;
        if (similar.length) {
          others.push({ sender: queue.name, senderId: id, items: similar, lastAt: similar[similar.length - 1].at });
        }
      }
      others.sort((a, b) => a.lastAt - b.lastAt);

      return {
        focus: {
          sender: focusQueue?.name ?? focusItem.sender,
          senderId: focusItem.senderId,
          items: focusItems,
          lastAt: focusItems[focusItems.length - 1]?.at ?? focusItem.at,
          lastTextAt: lastText?.at ?? 0
        },
        others,
        imageCount,
        omittedText,
        total: all.length,
        expired: 0
      };
    },

    /** 渲染成提示词块；没有任何消息时返回 ''。 */
    contextBlock(key, { now = Date.now(), header = '【最近消息（按人分组）】' } = {}) {
      const opts = options();
      const snap = this.snapshot(key, now);
      if (!snap.focus) return '';
      const lines = [header];
      const lastGap = now - snap.focus.lastAt;
      const textGap = snap.focus.lastTextAt ? now - snap.focus.lastTextAt : 0;
      const recent = lastGap <= opts.focusWindowMs;
      const focusNote = recent ? '（最近还在说话）' : `（已 ${fmtGap(lastGap).slice(1)} 没说话，可能已经翻篇）`;
      lines.push(`当前话题对象：${snap.focus.sender}${focusNote}；最后一条文字 ${textGap ? fmtGap(textGap) : '无'}`);
      lines.push('（回应以当前话题对象为主；别人插的图片不要当回应依据，标「背景」的文字只在相关时参考；注意相对时间，隔太久的话别硬接。）');

      const renderLine = (item) => {
        const body = String(item.text ?? '').trim() ? item.text : '［图片/表情］';
        return `  ${fmtGap(now - item.at)} ${item.sender}：${body}${item.quoteTargetIsSelf ? '（引用你）' : ''}`;
      };
      for (const item of snap.focus.items.slice(-opts.perSenderMax)) lines.push(renderLine(item));
      for (const other of snap.others) {
        lines.push(`（背景）${other.sender} 的发言与当前话题相关：`);
        for (const item of other.items.slice(-3)) lines.push(`  ${fmtGap(now - item.at)} ${other.sender}：${item.text}`);
      }
      if (snap.imageCount > 0) lines.push(`（另有 ${snap.imageCount} 条图片/表情，不作为回应依据）`);

      // 超长时从最旧的非标题行开始丢，保证最新的话留下
      let text = lines.join('\n');
      while (text.length > opts.maxChars && lines.length > 3) {
        lines.splice(2, 1);
        text = lines.join('\n');
      }
      return text;
    },

    /** 把一批新消息按人分组渲染（用于「新消息」段），带相对时间戳。 */
    groupBlock(messages, { now = Date.now(), header = '【新消息（按人分组）】', mediaHint = null } = {}) {
      const list = (Array.isArray(messages) ? messages : []).filter(Boolean);
      if (!list.length) return '';
      const groups = new Map();
      for (const message of list) {
        const sender = String(message.sender ?? '群友');
        const id = String(message.senderId ?? '') || sender;
        if (!groups.has(id)) groups.set(id, { sender, items: [] });
        groups.get(id).items.push(message);
      }
      const lines = [header];
      for (const group of groups.values()) {
        lines.push(`${group.sender}：`);
        for (const item of group.items.slice(-8)) {
          const isImageOnly = !String(item.plain ?? item.text ?? '').trim();
          const body = isImageOnly ? '［图片/表情］' : String(item.text ?? item.plain ?? '');
          const hint = typeof mediaHint === 'function' ? String(mediaHint(item) ?? '') : '';
          lines.push(`  ${fmtGap(now - (item.time ?? now))} ${body}${hint}`);
        }
      }
      const text = lines.join('\n');
      return text.length > INBOX_DEFAULTS.maxChars ? `${text.slice(0, INBOX_DEFAULTS.maxChars - 1)}…` : text;
    },

    stats(key, now = Date.now()) {
      const snap = this.snapshot(key, now);
      return {
        focus: snap.focus?.sender ?? '',
        total: snap.total,
        senders: (snap.focus ? 1 : 0) + snap.others.length,
        imageCount: snap.imageCount,
        omittedText: snap.omittedText
      };
    },

    clear(key) {
      boxes.delete(key);
    }
  };
}
