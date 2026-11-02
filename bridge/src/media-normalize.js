// 媒体归一化：把「QQ 给我们的原始图片」压成「DSH 与模型真能吃下的形状」。
//
// ── 为什么需要这一层（2026-10-18 审计结论，见 docs/audits/AUDIT_2026-10-18_MEDIA_AND_WATERMARK.md）
//
// ① 体积悬崖：DSH 的 MCP 图片入口会用正则校验 base64
//    （dsh-mcp-client 的 CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:…)?$/）。
//    这条正则在长输入上会压爆 V8 的 regexp 回溯栈，实测：
//        base64 ≥ 4,474,880 字符（原始字节 ≥ 3.20 MiB）→ RangeError: Maximum call stack size exceeded
//    而 DSH 把这个异常原样降级成 `[image unavailable: image/gif; Maximum call stack size exceeded; …]`
//    —— 模型只看到一行错误，图一个字节都没进上下文。
//    桥接侧的抓取上限（socialV2.media.maxBytes，默认 8 MiB）远在这条线之上，
//    于是「3.2–8 MiB 的图」就成了「桥接认为合法、DSH 必然拒绝」的死区。
//
// ② 动图变单帧：DSH 的 canPassThroughNormalization() 显式排除 image/gif，
//    一律交给 sharp 归一化，而 sharp 默认只解 page 0 —— 一张 48 帧、4.8 MB 的动图，
//    模型最终只看到「第 1 帧压成的 12 KB 静态 JPEG」，而且上下文里没有任何「这是动图」的提示。
//    模型于是只能瞎猜（实测会话里它连着两次给出的解释都是错的）。
//
// ── 本模块的取舍
//
// · **只动喂给模型的那一份**。收集表情（add_custom_face）必须用原始字节，
//   所以归一化只接在 fetchMediaData / resolveMediaList / sticker-image 这些「给模型看」的出口，
//   不去改 fetchOneBotImage / fetchFaceMedia 的返回值。
// · **动图抽帧拼图**而不是发多张图：一条消息 5 张图 = 5 次 DSH admission + 5 份 token，
//   而 3×2 拼图信息密度更高、只算一张图（实测 4.83 MB / 200 帧 → 92 KB / 269 ms）。
// · **能不动就不动**：小图（≤ maxModelBytes 且长边够小）原样放行，零延迟。
// · **ffmpeg 缺失也不硬塞**：超线又压不动的，宁可回一句「太大，看不了」，也不发注定被 DSH 丢掉
//   的字节（那样模型只会看到一行看不懂的错误）。
//
// 依赖：只用 node 内置 + voice-core 的 resolveFfmpeg（ffmpeg 定位的唯一实现）。
// 子进程一律 `stdio: 'ignore'` + 写文件：受限沙箱里 pipe 会 EPERM（见 voice-core.js 开头的说明）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveFfmpeg } from './voice-core.js';

/** 默认值集中一处，bridge.js 只做 config 覆盖（见 modelMediaLimits）。 */
export const MEDIA_DEFAULTS = Object.freeze({
  // 交给 DSH 的单张图片原始字节上限。DSH 的炸栈线是 ≈3.20 MiB，
  // 这里取 1 MiB：留 3 倍余量，顺带把 token 成本压一个数量级（1 MiB 图 ≈ 1.33 MB base64）。
  maxModelBytes: 1024 * 1024,
  // 长边上限：手机直出 4000×3000 缩到 1280 后约 150–250 KB，肉眼描述完全够用。
  maxLongEdge: 1280,
  // 动图抽几帧：6 帧正好 3×2，超过 9 帧拼图会小到看不清单帧。
  gifFrames: 6,
  // 每一格的目标宽度（px）：240 一格，3×2 拼图约 736×492，实测 92 KB。
  gifTile: 240,
  // 单张 ffmpeg 调用的硬超时。实测 200 帧 GIF 拼图 269 ms、4K 重编码 < 1 s，25 s 是兜底。
  timeoutMs: 25000
});

/** 硬上限：不管 config 怎么写，都不允许超过 DSH 的实测炸栈线下沿。 */
const HARD_MAX_MODEL_BYTES = Math.floor(3.0 * 1024 * 1024);

// ── 格式探测（纯函数，可单测） ────────────────────────────────────────────

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** GIF 子块链跳过：每个子块首字节是长度，0 结束。返回新游标（越界返回 -1）。 */
function skipGifSubBlocks(buf, pos) {
  let p = pos;
  let guard = 0;
  while (p < buf.length) {
    const size = buf[p];
    p += 1;
    if (size === 0) return p;
    p += size;
    if (++guard > 1_000_000) return -1;
  }
  return -1;
}

/**
 * 解析 GIF 的帧数与总时长（以及是否有透明帧）。
 *
 * 为什么不直接问 ffprobe：a) ffmpeg 可能没装，而「这是动图，N 帧」这句话就算没 ffmpeg
 * 也要能告诉模型；b) 每次看图都 spawn 一次 ffprobe 是白花的时间（这里纯内存解析）。
 * GIF 的块结构很实在：0x2C = 图像描述符（一帧），0x21 0xF9 = 图形控制扩展（带 delay）。
 */
function parseGif(buf) {
  if (buf.length < 13) return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  let pos = 13;
  if (packed & 0x80) pos += 3 * (2 << (packed & 0x07)); // 全局颜色表
  let frames = 0;
  let durationCs = 0;
  let alpha = false;
  let delayCs = 0;
  let guard = 0;
  while (pos >= 0 && pos < buf.length) {
    if (++guard > 5_000_000) break;
    const block = buf[pos];
    pos += 1;
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      if (pos >= buf.length) break;
      const label = buf[pos];
      pos += 1;
      if (label === 0xf9 && pos + 4 <= buf.length) {
        // 块长(1) 打包位(1) delay(2) 透明色索引(1) 终结符(1)
        const size = buf[pos];
        if (size >= 4 && pos + 4 < buf.length) {
          const gcePacked = buf[pos + 1];
          delayCs = buf.readUInt16LE(pos + 2);
          if (gcePacked & 0x01) alpha = true;
        }
      }
      pos = skipGifSubBlocks(buf, pos);
      continue;
    }
    if (block === 0x2c) {
      if (pos + 9 > buf.length) break;
      const descPacked = buf[pos + 8];
      pos += 9;
      if (descPacked & 0x80) pos += 3 * (2 << (descPacked & 0x07)); // 局部颜色表
      pos += 1; // LZW 最小码长
      pos = skipGifSubBlocks(buf, pos);
      frames += 1;
      durationCs += delayCs || 0;
      delayCs = 0;
      continue;
    }
    break; // 解析不了就别硬猜
  }
  return {
    width,
    height,
    frames: Math.max(1, frames),
    durationMs: durationCs > 0 ? durationCs * 10 : 0,
    alpha
  };
}

/** WebP：解析尺寸，并识别动图（ANIM 块 / ANMF 帧块）。 */
function parseWebp(buf) {
  if (buf.length < 30) return null;
  const fourcc = buf.toString('ascii', 12, 16);
  let width = 0;
  let height = 0;
  if (fourcc === 'VP8X') {
    width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
    height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
  } else if (fourcc === 'VP8L') {
    const b = [buf[21], buf[22], buf[23], buf[24]];
    width = 1 + (((b[1] & 0x3f) << 8) | b[0]);
    height = 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
  } else if (fourcc === 'VP8 ') {
    width = buf.readUInt16LE(26) & 0x3fff;
    height = buf.readUInt16LE(28) & 0x3fff;
  } else {
    return null;
  }
  // 动图：RIFF 里出现 ANIM（动画头）与若干个 ANMF（帧）。只数块头，不解析负载。
  let frames = 0;
  let pos = 12;
  let guard = 0;
  while (pos + 8 <= buf.length && ++guard < 1_000_000) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'ANMF') frames += 1;
    pos += 8 + size + (size & 1);
  }
  const alpha = fourcc === 'VP8X' ? (buf[20] & 0x10) !== 0 : true;
  return { width, height, frames: Math.max(1, frames), durationMs: 0, alpha };
}

function parsePng(buf) {
  if (buf.length < 26) return null;
  const colorType = buf[25];
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    frames: 1,
    durationMs: 0,
    alpha: colorType === 4 || colorType === 6
  };
}

function parseJpeg(buf) {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const len = buf.readUInt16BE(offset + 2);
    if (len < 2) return null;
    // SOF0–SOF15（排除 DHT C4 / JPG C8 / DAC CC）
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5), frames: 1, durationMs: 0, alpha: false };
    }
    offset += 2 + len;
  }
  return null;
}

/**
 * 从字节里认出格式/尺寸/帧数。
 *
 * @returns null（认不出）或
 *   { format:'gif'|'png'|'jpeg'|'webp', width, height, frames, durationMs, animated, alpha }
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  let format = null;
  let parsed = null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    format = 'png'; parsed = parsePng(buf);
  } else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    format = 'jpeg'; parsed = parseJpeg(buf);
  } else if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
    format = 'gif'; parsed = parseGif(buf);
  } else if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    format = 'webp'; parsed = parseWebp(buf);
  }
  if (!parsed || !parsed.width || !parsed.height) return null;
  return {
    format,
    width: parsed.width,
    height: parsed.height,
    frames: Math.max(1, parsed.frames || 1),
    durationMs: parsed.durationMs || 0,
    animated: (parsed.frames || 1) > 1,
    alpha: !!parsed.alpha
  };
}

// ── 决策（纯函数，可单测） ────────────────────────────────────────────────

/**
 * 要不要动这张图？返回 null = 原样放行。
 *
 * @param info sniffImage() 的结果（null 表示认不出 → 一律放行，交给下游）
 * @param bytes 原始字节数
 * @param limits 归一化上限
 */
export function planNormalization(info, bytes, limits = {}) {
  const maxBytes = clampInt(limits.maxModelBytes, 64 * 1024, HARD_MAX_MODEL_BYTES, MEDIA_DEFAULTS.maxModelBytes);
  const maxLongEdge = clampInt(limits.maxLongEdge, 256, 2048, MEDIA_DEFAULTS.maxLongEdge);
  if (!info) {
    // 认不出的格式：能放就放（下游 mimeFromBuffer 会兜底），太大就拒绝——绝不硬塞。
    return bytes > maxBytes ? { action: 'reject', reason: `未知图片格式且 ${bytes} 字节超过上限` } : null;
  }
  if (info.animated) {
    return { action: 'animate', maxBytes, maxLongEdge };
  }
  const longEdge = Math.max(info.width, info.height);
  if (bytes <= maxBytes && longEdge <= maxLongEdge) return null;
  return { action: 'shrink', maxBytes, maxLongEdge, bytes, longEdge };
}

/** 动图拼图布局：帧数 → { cols, rows, fps, sampleFrames }。纯函数。 */
export function planAnimation(info, limits = {}) {
  const wanted = clampInt(limits.gifFrames, 2, 12, MEDIA_DEFAULTS.gifFrames);
  const frames = Math.max(1, info?.frames || 1);
  // 帧比想要的多才有意思抽帧；帧本来就少就全用上（不重复填充没信息量的格子）。
  const sample = Math.min(wanted, frames);
  // 布局偏好：6→3×2、9→3×3、8→4×2（都填满），其余按接近正方形算。
  const layout = { 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2], 9: [3, 3], 10: [5, 2], 11: [4, 3], 12: [4, 3] }[sample]
    ?? [Math.ceil(Math.sqrt(sample)), Math.ceil(sample / Math.ceil(Math.sqrt(sample)))];
  const [cols, rows] = layout;
  // fps 必须让 ffmpeg 恰好产出 sample 帧；时长未知时按每帧 100 ms 估（QQ 表情的常见默认）。
  const durationMs = info?.durationMs > 0 ? info.durationMs : frames * 100;
  const seconds = Math.max(0.05, durationMs / 1000);
  const fps = Math.min(30, Math.max(0.05, Number((sample / seconds).toFixed(4))));
  return { cols, rows, fps, sampleFrames: sample, totalFrames: frames, durationMs };
}

// ── ffmpeg 调用 ──────────────────────────────────────────────────────────

/**
 * 跑一次 ffmpeg：输入/输出都走文件，stdio 全 ignore。
 *
 * 为什么不用管道：受限沙箱里 `spawn` + stdio:'pipe' 会直接 EPERM（voice-core.js 开头有同样记录）。
 * 代价是拿不到 ffmpeg 的 stderr —— 所以调用方只报「退出码 + 动作名」，不假装能诊断具体原因。
 */
function runFfmpeg(ffmpeg, args, { timeoutMs = MEDIA_DEFAULTS.timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: `ffmpeg 启动失败：${error?.message ?? error}` });
      return;
    }
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      settle({ ok: false, error: `ffmpeg 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.on('error', (error) => settle({
      ok: false,
      error: error?.code === 'ENOENT'
        ? '找不到 ffmpeg（设置 FFMPEG_PATH 或 config.json 的 socialV2.voice.ffmpegPath）'
        : `ffmpeg 不可用：${error?.message ?? error}`
    }));
    child.on('close', (code) => settle(code === 0 ? { ok: true } : { ok: false, error: `ffmpeg 退出码 ${code}` }));
  });
}

function makeTempWorkspace(tmpDir) {
  const base = tmpDir ? path.resolve(tmpDir) : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'qqb-media-'));
}

function cleanupWorkspace(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** 按扩展名挑输出容器：有 alpha 用 PNG（保透明），否则 JPEG（体积小得多）。 */
function pickOutputExt(info) {
  return info?.alpha ? '.png' : '.jpg';
}

function readIfExists(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return null;
    return fs.readFileSync(file);
  } catch { return null; }
}

// ── 主入口 ──────────────────────────────────────────────────────────────

/**
 * 把一张图整理成「可以安全交给 DSH / 模型」的形态。
 *
 * @param buf       原始字节
 * @param mimeType  调用方已知的 MIME（可能与实际不符，以字节探测为准）
 * @param opts      { maxModelBytes, maxLongEdge, gifFrames, gifTile, enabled, ffmpegPath, tmpDir, label, timeoutMs }
 * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, note?:string, error?:string, skipped?:boolean}>}
 *   ok=false 只在「超大且压不动」时出现；调用方应把它变成一句可读的失败原因，而不是发空图。
 */
export async function normalizeImageForModel(buf, mimeType, opts = {}) {
  const bytes = Buffer.isBuffer(buf) ? buf.length : 0;
  if (!bytes) return { ok: false, error: '图片字节为空' };
  if (opts.enabled === false) return { ok: true, buffer: buf, mimeType, note: '' };

  const info = sniffImage(buf);
  const plan = planNormalization(info, bytes, opts);
  if (!plan) {
    // 原样放行：这是绝大多数情况（小图），零额外延迟。
    return { ok: true, buffer: buf, mimeType: mimeType || (info ? `image/${info.format === 'jpeg' ? 'jpeg' : info.format}` : 'image/jpeg'), note: '' };
  }
  if (plan.action === 'reject') {
    return { ok: false, error: plan.reason, skipped: true };
  }

  const ffmpeg = resolveFfmpeg({ ffmpegPath: opts.ffmpegPath ?? null });
  const maxBytes = plan.maxBytes;
  const maxLongEdge = plan.maxLongEdge;

  const dir = makeTempWorkspace(opts.tmpDir);
  let lastPillowError = '';
  try {
    const inExt = info.format === 'jpeg' ? '.jpg' : `.${info.format}`;
    const inFile = path.join(dir, `in${inExt}`);
    fs.writeFileSync(inFile, buf);

    if (plan.action === 'animate') {
      const layout = planAnimation(info, opts);
      const tileWidth = clampInt(opts.gifTile, 64, 400, MEDIA_DEFAULTS.gifTile);
      const outFile = path.join(dir, 'strip.jpg');
      const vf = `fps=${layout.fps},scale=${tileWidth}:-1:flags=lanczos,` +
        `tile=${layout.cols}x${layout.rows}:padding=4:margin=4:color=white`;
      const run = await runFfmpeg(ffmpeg, [
        '-v', 'error', '-y', '-i', inFile,
        '-filter_complex', `[0:v]${vf}[out]`, '-map', '[out]',
        '-frames:v', '1', '-q:v', '4', outFile
      ], { timeoutMs: opts.timeoutMs });
      let out = run.ok ? readIfExists(outFile) : null;
      if (!out) {
        // 没有 ffmpeg：用 Pillow 自己拼同一套网格（等间隔抽帧、白底、8px 间距）
        const scriptFile = path.join(dir, 'collage.py');
        fs.writeFileSync(scriptFile, loadPyHelper('image_collage.py', PILLOW_COLLAGE_SCRIPT).code, 'utf8');
        const pyRun = await runProgram(resolvePython(), [
          scriptFile, inFile, outFile,
          String(layout.cols), String(layout.rows), String(tileWidth), String(layout.sampleFrames)
        ], { timeoutMs: opts.timeoutMs });
        if (pyRun.ok) out = readIfExists(outFile);
        else lastPillowError = pyRun.error;
      }
      if (out && out.length <= maxBytes) {
        const seconds = (layout.durationMs / 1000).toFixed(1);
        return {
          ok: true,
          buffer: out,
          mimeType: 'image/jpeg',
          // 这段文字会原样出现在工具结果里（外面还会再包一层括号），所以**不要用嵌套括号**。
          note: `动图 ${layout.totalFrames} 帧/${seconds}s，已抽 ${layout.sampleFrames} 帧拼成 ${layout.cols}×${layout.rows} 网格，行优先 左上→右下；原图 ${(bytes / 1024 / 1024).toFixed(2)}MB`
        };
      }
      // 拼图失败（没 ffmpeg / 超时 / 还是太大）：退化到「能看多少算多少」。
      if (bytes <= maxBytes) {
        return {
          ok: true,
          buffer: buf,
          mimeType: mimeType || 'image/gif',
          note: `动图 ${layout.totalFrames} 帧（抽帧拼图失败：${run.ok ? '输出仍超限' : run.error}，只提供首帧）`
        };
      }
      return { ok: false, error: `动图 ${(bytes / 1024 / 1024).toFixed(2)}MB 无法压缩（${run.ok ? '输出仍超限' : run.error}）` };
    }

    // action === 'shrink'：静态图降采样 + 重编码，最多试三轮（逐步缩小尺寸/降质量）。
    const outExt = pickOutputExt(info);
    let edge = maxLongEdge;
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const scale = Math.min(1, edge / Math.max(info.width, info.height));
      const width = Math.max(2, Math.round(info.width * scale) & ~1);
      const height = Math.max(2, Math.round(info.height * scale) & ~1);
      const outFile = path.join(dir, `out-${attempt}${outExt}`);
      const args = ['-v', 'error', '-y', '-i', inFile, '-vf', `scale=${width}:${height}:flags=lanczos`];
      if (outExt === '.jpg') args.push('-q:v', String(3 + attempt * 3));
      args.push(outFile);
      const run = await runFfmpeg(ffmpeg, args, { timeoutMs: opts.timeoutMs });
      let out = run.ok ? readIfExists(outFile) : null;
      if (!out) {
        // 没有 ffmpeg：Pillow 顶上（同一尺寸、同一容器选择：有 alpha 存 PNG，否则 JPEG）
        const scriptFile = path.join(dir, `shrink-${attempt}.py`);
        fs.writeFileSync(scriptFile, loadPyHelper('image_shrink.py', PILLOW_SHRINK_SCRIPT).code, 'utf8');
        const pyRun = await runProgram(resolvePython(), [
          scriptFile, inFile, outFile, String(width), String(height), outExt
        ], { timeoutMs: opts.timeoutMs });
        if (pyRun.ok) out = readIfExists(outFile);
        else lastPillowError = pyRun.error;
      }
      if (!out) { lastError = lastPillowError || run.error; }
      else {
        if (out && out.length <= maxBytes) {
          return {
            ok: true,
            buffer: out,
            mimeType: outExt === '.jpg' ? 'image/jpeg' : 'image/png',
            note: `原图 ${info.width}×${info.height} ${(bytes / 1024).toFixed(0)}KB → ${width}×${height} ${(out.length / 1024).toFixed(0)}KB`
          };
        }
        lastError = '压缩后仍超限';
      }
      edge = Math.max(320, Math.round(edge * 0.7));
    }
    // 压不动：小图照发，大图明确拒绝（绝不发注定被 DSH 丢掉的东西）。
    if (bytes <= maxBytes) return { ok: true, buffer: buf, mimeType, note: `压缩失败（${lastError}），按原图提供` };
    return { ok: false, error: `${(bytes / 1024 / 1024).toFixed(2)}MB 压不到 ${(maxBytes / 1024).toFixed(0)}KB 以内（${lastError}）` };
  } finally {
    cleanupWorkspace(dir);
  }
}

// ── 表情「回退图片段」时的尺寸钳制 ────────────────────────────────────────
//
// 背景：正常路径走网关的 send_custom_face，QQ 按表情渲染（小图）。但需要 @ 时
// send_custom_face 用不了，只能退回 image 段——那在 QQ 里是一张**普通图片**，
// 原图多大就铺多大。所以这里在发送前把图压到表情渲染尺寸（默认长边 240），
// 让「回退」和「正路」在观感上尽量一致。

// 这台机器很可能根本没有 ffmpeg（resolveFfmpeg 只认显式路径和 PATH），
// 所以缩放不能只押在 ffmpeg 上：找不到就用 Python + Pillow 兜底。
// 两者都是「写文件 + spawn + stdio:ignore」，沙箱里 pipe 会 EPERM（见文件头）。
function resolvePython() {
  const candidates = [
    process.env.QQ_BRIDGE_PYTHON,
    process.env.PYTHON,
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

const PILLOW_RESIZE_SCRIPT = [
  'import sys',
  'from PIL import Image',
  'src, dst, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])',
  'im = Image.open(src)',
  'try:',
  '    im.seek(0)',            // 动图只取首帧
  'except Exception:',
  '    pass',
  'im = im.convert("RGBA")',   // 统一转 RGBA，透明底不会变黑块
  'im = im.resize((w, h), Image.LANCZOS)',
  'try:',
  '    im.save(dst, "WEBP", quality=90, method=6)',
  'except Exception:',
  '    im.save(dst, "PNG", optimize=True)'
].join('\n');

// ── Python 兜底脚本的来源 ────────────────────────────────────────────────
//
// 脚本本体以 .py 文件形式放在插件里（plugins/qq-bridge-launcher/runtime/python/），
// 好处是能单独改、单独测、能被 npm pack 带走；下面三个常量只是**最后兜底**：
// 插件没装、被裁剪、或者文件被删了，桥接自己也能跑起来，不至于功能整个消失。
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '..');
const PY_HELPER_DIRS = [
  process.env.QQ_BRIDGE_PY_HELPERS,
  path.join(REPO_ROOT, 'plugins', 'qq-bridge-launcher', 'runtime', 'python')
].filter(Boolean);

/** 读插件里的 .py；读不到就用内联兜底。返回 { code, source }。 */
const PILLOW_SEND_RESIZE_SCRIPT = [
  'import sys',
  'from PIL import Image',
  'src, dst, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])',
  'im = Image.open(src)',
  'try:',
  '    im.seek(0)',            // 动图只取首帧
  'except Exception:',
  '    pass',
  'if dst.lower().endswith(".png"):',
  '    im = im.convert("RGBA")',
  '    im = im.resize((w, h), Image.LANCZOS)',
  '    im.save(dst, "PNG", optimize=True)',
  'else:',
  '    im = im.convert("RGB")',
  '    im = im.resize((w, h), Image.LANCZOS)',
  '    im.save(dst, "JPEG", quality=86, optimize=True)'
].join('\n');

function loadPyHelper(fileName, fallback) {
  for (const dir of PY_HELPER_DIRS) {
    try {
      const code = fs.readFileSync(path.join(dir, fileName), 'utf8');
      if (code.trim()) return { code, source: path.join(dir, fileName) };
    } catch {}
  }
  return { code: fallback, source: 'inline' };
}

/** 诊断用：某个脚本最终是从文件读的还是走内联。 */
export function pyHelperSource(fileName) {
  const known = {
    'sticker_resize.py': PILLOW_RESIZE_SCRIPT,
    'image_shrink.py': PILLOW_SHRINK_SCRIPT,
    'image_collage.py': PILLOW_COLLAGE_SCRIPT
  };
  if (!known[fileName]) return 'unknown';
  return loadPyHelper(fileName, known[fileName]).source;
}

// 静态图缩放（ffmpeg 的 shrink 分支兜底）
const PILLOW_SHRINK_SCRIPT = [
  'import sys',
  'from PIL import Image',
  'src, dst, w, h, ext = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]',
  'im = Image.open(src)',
  'try:',
  '    im.seek(0)',
  'except Exception:',
  '    pass',
  'im = im.convert("RGBA" if ext == ".png" else "RGB")',
  'im = im.resize((w, h), Image.LANCZOS)',
  'if ext == ".png":',
  '    im.save(dst, "PNG", optimize=True)',
  'else:',
  '    im.save(dst, "JPEG", quality=86, optimize=True)'
].join('\n');

// 动图抽帧拼图（ffmpeg 的 animate 分支兜底）：等间隔取 count 帧，按 cols×rows 铺成白底网格
const PILLOW_COLLAGE_SCRIPT = [
  'import sys',
  'from PIL import Image',
  'src, dst = sys.argv[1], sys.argv[2]',
  'cols, rows, tile, count = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6])',
  'im = Image.open(src)',
  'frames = getattr(im, "n_frames", 1) or 1',
  'n = max(1, min(count, frames))',
  'idx = [0] if n == 1 else [round(i * (frames - 1) / (n - 1)) for i in range(n)]',
  'tiles = []',
  'for i in idx:',
  '    try:',
  '        im.seek(i)',
  '    except Exception:',
  '        pass',
  '    f = im.convert("RGBA").copy()',
  '    w, h = f.size',
  '    s = tile / max(w, h)',
  '    tiles.append(f.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS))',
  'cell_h = max(t.height for t in tiles)',
  'grid = Image.new("RGB", (cols * (tile + 8) + 8, rows * (cell_h + 8) + 8), "white")',
  'for k, t in enumerate(tiles):',
  '    c, r = k % cols, k // cols',
  '    grid.paste(t, (8 + c * (tile + 8), 8 + r * (cell_h + 8)), t)',
  'grid.save(dst, "JPEG", quality=82, optimize=True)'
].join('\n');

function runProgram(exe, args, { timeoutMs = MEDIA_DEFAULTS.timeoutMs, cwd = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: 'ignore', cwd: cwd ?? undefined });
    } catch (error) {
      resolve({ ok: false, error: `启动失败：${error?.message ?? error}` });
      return;
    }
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      settle({ ok: false, error: `超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.on('error', (error) => settle({ ok: false, error: error?.code === 'ENOENT' ? `找不到 ${path.basename(exe)}` : `不可用：${error?.message ?? error}` }));
    child.on('close', (code) => settle(code === 0 ? { ok: true } : { ok: false, error: `退出码 ${code}` }));
  });
}

/** QQ 表情面板的常见渲染尺寸：长边 240 已经比实际显示大一点，够清晰。 */
const STICKER_MAX_EDGE = 240;
const STICKER_MAX_BYTES = 256 * 1024;

/**
 * 把要当作表情发送的图片压到表情尺寸。
 *
 * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, resized?:boolean, note?:string, error?:string}>}
 *   ok=false 只在字节为空时出现；压不动就返回原图（resized=false + note），
 *   因为「稍微大一点的表情」也比「发不出去」好。
 */
export async function normalizeStickerForSend(buf, opts = {}) {
  const bytes = Buffer.isBuffer(buf) ? buf.length : 0;
  if (!bytes) return { ok: false, error: '图片字节为空' };
  const maxEdge = clampInt(opts.maxEdge, 64, 512, STICKER_MAX_EDGE);
  const maxBytes = clampInt(opts.maxBytes, 8 * 1024, 2 * 1024 * 1024, STICKER_MAX_BYTES);
  const info = sniffImage(buf);
  const longEdge = info ? Math.max(info.width, info.height) : 0;
  // 已经够小又不超体积：原样放行，不做任何重编码（绝大多数收藏表情都是这种）。
  if (info && info.frames === 1 && longEdge <= maxEdge && bytes <= maxBytes) {
    return { ok: true, buffer: buf, mimeType: `image/${info.format === 'jpeg' ? 'jpeg' : info.format}`, resized: false, note: '' };
  }

  const ffmpeg = resolveFfmpeg({ ffmpegPath: opts.ffmpegPath ?? null });
  const dir = makeTempWorkspace(opts.tmpDir);
  try {
    const inExt = info?.format === 'jpeg' ? '.jpg' : `.${info?.format ?? 'png'}`;
    const inFile = path.join(dir, `in${inExt}`);
    fs.writeFileSync(inFile, buf);
    // 缩放比例：认不出尺寸就按正方形钳到 maxEdge 兜底。
    const scale = longEdge > 0 ? Math.min(1, maxEdge / longEdge) : 1;
    const width = Math.max(2, Math.round((info?.width ?? maxEdge) * scale));
    const height = Math.max(2, Math.round((info?.height ?? maxEdge) * scale));
    const outFile = path.join(dir, 'sticker.webp');
    // 输出 PNG 而不是 JPEG：收藏表情大量带透明通道，转 JPEG 会出现白底方块。
    // -frames:v 1 顺手把动图收敛成首帧（回退路径本来就只发一张静态图）。
    let via = 'ffmpeg';
    let lastError = '';
    const run = await runFfmpeg(ffmpeg, [
      '-v', 'error', '-y', '-i', inFile,
      '-frames:v', '1',
      '-vf', `scale=${width}:${height}:flags=lanczos`,
      '-compression_level', '9',
      outFile
    ], { timeoutMs: opts.timeoutMs });
    let out = run.ok ? readIfExists(outFile) : null;
    if (!out) {
      lastError = run.error;
      // ffmpeg 不可用（这台机器就没装）：换 Pillow 再试一次。
      const scriptFile = path.join(dir, 'resize.py');
      fs.writeFileSync(scriptFile, loadPyHelper('sticker_resize.py', PILLOW_RESIZE_SCRIPT).code, 'utf8');
      const pyRun = await runProgram(resolvePython(), [scriptFile, inFile, outFile, String(width), String(height)], { timeoutMs: opts.timeoutMs });
      if (pyRun.ok) {
        out = readIfExists(outFile);
        via = 'pillow';
      } else {
        lastError = `${lastError || 'ffmpeg 失败'}；pillow ${pyRun.error}`;
      }
    }
    if (out && out.length) {
      const outInfo = sniffImage(out);
      return {
        ok: true,
        buffer: out,
        mimeType: outInfo ? `image/${outInfo.format === 'jpeg' ? 'jpeg' : outInfo.format}` : 'image/webp',
        resized: true,
        note: `表情尺寸钳制 ${info ? `${info.width}×${info.height}` : '未知'} ${(bytes / 1024).toFixed(0)}KB → ${width}×${height} ${(out.length / 1024).toFixed(0)}KB（${via}）`
      };
    }
    return { ok: true, buffer: buf, mimeType: info ? `image/${info.format}` : 'image/png', resized: false, note: `缩放失败（${lastError || '输出为空'}），按原图发送` };
  } finally {
    cleanupWorkspace(dir);
  }
}

/** 普通图片（问候配图等）发送前的默认上限：长边 720、体积 1.5 MB。 */
const SEND_IMAGE_DEFAULTS = Object.freeze({ maxEdge: 260, maxBytes: 1536 * 1024 });

/**
 * 把「要当普通图片发出去」的图缩到合适尺寸。
 *
 * 为什么不用 normalizeStickerForSend：那条按表情尺寸（240）设计，普通配图会糊；
 * 而原图直发（比如 1000×1000 PNG / 552×770 表情包）在 QQ 里会按像素铺很大。
 * 但 QQ 会把超过自身显示宽度的图统一按上限渲染（实测 344 和 552 宽看起来一样大），
 * 所以「缩了却看不出变化」；这里默认直接缩到长边 ≤ 260（≈ QQ 里普通聊天图片的显示尺寸），
 * 低于客户端上限才真正体现大小差。透明背景保留 PNG，其余转 JPEG。
 *
 * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, resized?:boolean, note?:string, error?:string}>}
 *   ok=false 只在字节为空时出现；缩不动就返回原图（resized=false + note），
 *   宁可大一点也不要发不出去。
 */
export async function normalizeImageForSend(buf, opts = {}) {
  const bytes = Buffer.isBuffer(buf) ? buf.length : 0;
  if (!bytes) return { ok: false, error: '图片字节为空' };
  const maxEdge = clampInt(opts.maxEdge, 120, 2048, SEND_IMAGE_DEFAULTS.maxEdge);
  const maxBytes = clampInt(opts.maxBytes, 32 * 1024, 4 * 1024 * 1024, SEND_IMAGE_DEFAULTS.maxBytes);
  const info = sniffImage(buf);
  const longEdge = info ? Math.max(info.width, info.height) : 0;
  // 尺寸和体积都在线：原样放行，零延迟。
  if (info && info.frames === 1 && longEdge > 0 && longEdge <= maxEdge && bytes <= maxBytes) {
    return {
      ok: true,
      buffer: buf,
      mimeType: `image/${info.format === 'jpeg' ? 'jpeg' : info.format}`,
      resized: false,
      note: ''
    };
  }

  const ffmpeg = resolveFfmpeg({ ffmpegPath: opts.ffmpegPath ?? null });
  const dir = makeTempWorkspace(opts.tmpDir);
  try {
    const srcExt = info?.format === 'jpeg' ? '.jpg' : `.${info?.format ?? 'png'}`;
    const inFile = path.join(dir, `in${srcExt}`);
    fs.writeFileSync(inFile, buf);
    const scale = longEdge > 0 ? Math.min(1, maxEdge / longEdge) : 1;
    const width = Math.max(2, Math.round((info?.width ?? maxEdge) * scale));
    const height = Math.max(2, Math.round((info?.height ?? maxEdge) * scale));
    // 有透明通道就继续 PNG，否则 JPEG 压体积；动图只取首帧（发静态图）。
    const outExt = pickOutputExt(info);
    const outFile = path.join(dir, `send${outExt}`);
    const vf = `scale=${width}:${height}:flags=lanczos`;
    const args = outExt === '.jpg'
      ? ['-v', 'error', '-y', '-i', inFile, '-frames:v', '1', '-vf', vf, '-q:v', '3', outFile]
      : ['-v', 'error', '-y', '-i', inFile, '-frames:v', '1', '-vf', vf, '-compression_level', '9', outFile];
    let via = 'ffmpeg';
    let lastError = '';
    const run = await runFfmpeg(ffmpeg, args, { timeoutMs: opts.timeoutMs });
    let out = run.ok ? readIfExists(outFile) : null;
    if (!out) {
      lastError = run.error;
      // ffmpeg 不在：退回 Pillow（sticker_resize.py 固定输出 PNG，能缩就行）
      const scriptFile = path.join(dir, 'resize.py');
      fs.writeFileSync(scriptFile, PILLOW_SEND_RESIZE_SCRIPT, 'utf8');
      const pyOut = path.join(dir, `send${outExt}`);
      const pyRun = await runProgram(resolvePython(), [scriptFile, inFile, pyOut, String(width), String(height)], { timeoutMs: opts.timeoutMs });
      if (pyRun.ok) { out = readIfExists(pyOut); via = 'pillow'; } else {
        lastError = `${lastError || 'ffmpeg 失败'}；pillow ${pyRun.error}`;
      }
    }
    if (out && out.length) {
      const outInfo = sniffImage(out);
      return {
        ok: true,
        buffer: out,
        mimeType: outInfo ? `image/${outInfo.format === 'jpeg' ? 'jpeg' : outInfo.format}` : (outExt === '.jpg' ? 'image/jpeg' : 'image/png'),
        resized: true,
        note: `图片缩放 ${info ? `${info.width}×${info.height}` : '未知'} ${(bytes / 1024).toFixed(0)}KB → ${width}×${height} ${(out.length / 1024).toFixed(0)}KB（${via}）`
      };
    }
    return {
      ok: true,
      buffer: buf,
      mimeType: info ? `image/${info.format}` : 'image/png',
      resized: false,
      note: `缩放失败（${lastError || '输出为空'}），按原图发送`
    };
  } finally {
    cleanupWorkspace(dir);
  }
}

/** 供日志/提示用的一句话摘要（不含 base64）。 */
export function describeImage(buf) {
  const info = sniffImage(buf);
  if (!info) return `未知格式 ${buf?.length ?? 0}B`;
  const parts = [`${info.format} ${info.width}×${info.height}`, `${(buf.length / 1024).toFixed(0)}KB`];
  if (info.animated) parts.push(`动图 ${info.frames} 帧${info.durationMs ? `/${(info.durationMs / 1000).toFixed(1)}s` : ''}`);
  return parts.join(' ');
}
