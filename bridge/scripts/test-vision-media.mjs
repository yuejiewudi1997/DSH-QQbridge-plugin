// 视觉 / 识图链路自检脚本：
// 1. 校验默认主模型是「4.1 识图组」，回退组是「推荐免费组」，辅助识图已配置
// 2. 校验 safe-fetch 的 SSRF 防护（本机地址应被拒绝）
// 3. 实测辅助识图网关：拿一张真实图片让视觉模型描述，返回非空才算通
// 4. 若桥接运行中，校验 /api/model/config 与 /api/status 的模型状态
// 运行：node scripts/test-vision-media.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetchBuffer } from '../src/safe-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

const config = readJson(path.join(ROOT, 'config.json'));
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 1. 配置：主模型 / 回退组 / 辅助识图
check('config.dsh.model 为 4.1 识图组', config.dsh?.model === 'combo:vision-41', `当前 ${config.dsh?.model}`);
check('config.dsh.fallbackModel 为推荐免费组', config.dsh?.fallbackModel === 'combo:recommended-free', `当前 ${config.dsh?.fallbackModel}`);
check('回退模型与主模型不同', Boolean(config.dsh?.fallbackModel) && config.dsh.fallbackModel !== config.dsh.model);
check('辅助识图已开启且指定了模型', config.dsh?.vision?.enabled !== false && Boolean(config.dsh?.vision?.model), `当前 ${config.dsh?.vision?.model}`);
check('辅助识图上限在合法区间', Number(config.dsh?.vision?.maxImages) >= 1 && Number(config.dsh?.vision?.maxChars) >= 40);

// 2. safe-fetch SSRF
try {
  await safeFetchBuffer('http://127.0.0.1/');
  check('safe-fetch 拒绝本机地址', false, '未抛出异常');
} catch (error) {
  check('safe-fetch 拒绝本机地址', /内网|本机|禁止/.test(String(error?.message ?? error)), error?.message);
}

// 3. 辅助识图网关实测（凭据缺省时从 our-free-model 插件配置读取）
function resolveGateway() {
  const vision = config.dsh?.vision ?? {};
  if (vision.baseUrl && vision.apiKey) return { baseUrl: vision.baseUrl, apiKey: vision.apiKey, model: vision.model };
  try {
    const settings = readJson(path.join(os.homedir(), '.dsh', 'our-free-model', 'settings.json'));
    const lane = settings?.aggregate?.providers?.tokenrouter;
    if (lane?.baseUrl && lane?.apiKey) return { baseUrl: lane.baseUrl, apiKey: lane.apiKey, model: vision.model };
  } catch { /* 跳过 */ }
  return null;
}

const fixture = path.join(__dirname, 'fixtures', 'vision-test.png');
const gateway = resolveGateway();
if (gateway && fs.existsSync(fixture)) {
  const base64 = fs.readFileSync(fixture).toString('base64');
  try {
    const res = await fetch(`${String(gateway.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${gateway.apiKey}` },
      body: JSON.stringify({
        model: gateway.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '用一句话客观描述这张图片里的主体颜色与形状。' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }
          ]
        }],
        max_tokens: 120,
        stream: false
      }),
      signal: AbortSignal.timeout(60000)
    });
    const body = await res.json().catch(() => ({}));
    const text = String(body?.choices?.[0]?.message?.content ?? '').trim();
    check('辅助识图模型能看图并返回描述', res.ok && text.length > 4, `${gateway.model} → ${text.slice(0, 60) || '空响应'}`);
  } catch (error) {
    check('辅助识图模型能看图并返回描述', false, `${gateway.model} → ${error?.message ?? error}`);
  }
} else {
  console.log('⚠️ 跳过辅助识图实测：缺少网关凭据或测试图片');
}

// 4. 桥接运行中的模型状态（可选）
const consoleTokenFile = path.join(ROOT, 'state', 'console-token');
const port = config.consolePort || 3100;
if (fs.existsSync(consoleTokenFile)) {
  try {
    const token = fs.readFileSync(consoleTokenFile, 'utf8').trim();
    const res = await fetch(`http://127.0.0.1:${port}/api/model/config`, {
      headers: { 'x-console-token': token }, signal: AbortSignal.timeout(8000)
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.model) {
      check('桥接 /api/model/config 可用', true, `当前生效 ${body.model.effective?.model ?? '-'}（${body.model.active}）`);
      check('识别到识图能力', typeof body.model.visionCapable === 'boolean', `visionCapable=${body.model.visionCapable}`);
    } else {
      console.log(`⚠️ 跳过桥接模型状态检查：HTTP ${res.status}`);
    }
  } catch (error) {
    console.log(`⚠️ 桥接模型状态检查跳过：${error?.message ?? error}`);
  }
} else {
  console.log('⚠️ 跳过桥接模型状态检查：缺少 state/console-token');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
