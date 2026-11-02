// 按人格生成 DSH preset：
//   - 每个有系统层模板的人格生成一个 qq-chat-v2-<slug> preset；
//   - 系统层模板直接写进 preset 的 persona.prefix，不再每条/每会话下发；
//   - 现有与新增人格都会被覆盖：脚本每次全量重建，删除已不存在人格的旧 patch。
//
// 用法：node scripts/build-persona-presets.mjs [state/persona-config.json]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'js-yaml';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 这个脚本既会在仓库根运行，也会被桥接从 plugins/qq-bridge-launcher/bridge 里调用。
// 往上找真正的仓库根（含 plugins/qq-agent-presets），避免在插件副本里找不存在的目录。
function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'plugins', 'qq-agent-presets', 'presets'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
const REPO_ROOT = findRepoRoot(ROOT);
const PRESET_DIR = path.join(REPO_ROOT, 'plugins', 'qq-agent-presets', 'presets');
const BASE_PATCH = path.join(PRESET_DIR, 'qq-chat-v2.patch.yml');
const BUNDLE_PKG = path.join(REPO_ROOT, 'plugins', 'qq-agent-presets', 'package.json');
const ROLES_DIR = path.join(REPO_ROOT, 'roles');
const DEFAULT_CONFIG = fs.existsSync(path.join(ROOT, 'state', 'persona-config.json'))
  ? path.join(ROOT, 'state', 'persona-config.json')
  : path.join(REPO_ROOT, 'plugins', 'qq-bridge-launcher', 'bridge', 'state', 'persona-config.json');

const MARK = '# 本文件由 scripts/build-persona-presets.mjs 生成，请勿手工编辑。';

function slugFor(role) {
  const ascii = String(role).replace(/[^\w-]/g, '');
  if (ascii && ascii === String(role)) return ascii.toLowerCase();
  return 'p' + crypto.createHash('sha1').update(String(role)).digest('hex').slice(0, 6);
}

function loadPersonaConfig(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function roleCardContent(role) {
  try {
    return fs.readFileSync(path.join(ROLES_DIR, `${role}.md`), 'utf8').trim();
  } catch {
    return '';
  }
}

function buildPatch(role, systemText) {
  const baseText = fs.readFileSync(BASE_PATCH, 'utf8');
  const doc = YAML.load(baseText);
  const insert = doc?.[0]?.insert?.[0];
  if (!insert) throw new Error('base patch 结构不是预期的 insert 列表');
  const slug = slugFor(role);
  const presetId = `qq-chat-v2-${slug}`;
  insert.id = `preset-${presetId}`;
  insert.config.id = presetId;
  insert.config.name = `QQ 聊天角色（${role}）`;
  insert.config.description = `通用系统预设 · 人格「${role}」专用：人格模板已注入 preset。`;
  insert.config.order = 12;
  const persona = Array.isArray(insert.config.plugins)
    ? insert.config.plugins.find((row) => row?.id === 'persona')
    : null;
  if (!persona?.config) throw new Error('base patch 缺少 persona 行');
  const basePrefix = String(persona.config.prefix || '').trim();
  let extra = String(systemText || '').replace(/\r\n?/g, '\n').trim();
  // 兼容旧数据：人格模板里若还带着通用系统预设前缀，只补真正的人格部分，避免重复
  if (basePrefix && extra.startsWith(basePrefix)) extra = extra.slice(basePrefix.length).trim();
  if (extra) {
    persona.config.prefix = `${String(persona.config.prefix || '').trimEnd()}\n\n## 人格系统层（${role}）\n${extra}`;
  }
  const header = `${MARK}\n# 人格：${role}（slug=${slug}）\n`;
  return { presetId, slug, text: header + YAML.dump(doc, { lineWidth: 200, noRefs: true }) };
}

function main() {
  const configFile = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CONFIG;
  const configs = loadPersonaConfig(configFile);
  const roles = Object.keys(configs);
  const existing = fs.readdirSync(PRESET_DIR).filter((name) => /^qq-chat-v2-p|^qq-chat-v2-[\w-]+\.patch\.yml$/.test(name) && name !== 'qq-chat-v2.patch.yml');
  const generated = [];
  for (const role of roles) {
    const conf = configs[role] && typeof configs[role] === 'object' ? configs[role] : {};
    let system = String(conf.system ?? '').trim();
    if (!system) {
      // 迁移：老角色卡内容直接作为系统层模板
      system = roleCardContent(role);
      if (system) {
        conf.system = system;
        console.log(`[persona-presets] 迁移角色卡到系统层：${role}`);
      }
    }
    // 兼容只写了标题/一句话的 system：角色正文在 roles/<role>.md，不要把它丢掉。
    const roleText = roleCardContent(role);
    if (system && roleText && system.length < 200 && !system.includes('# 角色卡')) {
      system = `${system}\n\n${roleText}`;
      console.log(`[persona-presets] 补全角色卡正文：${role}`);
    }
    const { presetId, slug, text } = buildPatch(role, system);
    const file = path.join(PRESET_DIR, `${presetId}.patch.yml`);
    fs.writeFileSync(file, text, 'utf8');
    generated.push({ role, slug, presetId, file: path.basename(file), systemChars: system.length });
    console.log(`[persona-presets] ✓ ${role} -> ${presetId}（系统层 ${system.length} 字）`);
  }
  // 清理已不存在人格的旧 patch
  const keep = new Set(generated.map((g) => g.file));
  for (const name of existing) {
    if (!keep.has(name) && fs.existsSync(path.join(PRESET_DIR, name))) {
      fs.unlinkSync(path.join(PRESET_DIR, name));
      console.log(`[persona-presets] - 删除过期 ${name}`);
    }
  }
  // 回写迁移后的配置
  fs.writeFileSync(configFile, JSON.stringify(configs, null, 2) + '\n', 'utf8');

  // 更新 bundle patch 列表：基础 preset + 人格 preset
  const pkg = JSON.parse(fs.readFileSync(BUNDLE_PKG, 'utf8'));
  const basePatches = ['./presets/qq-chat-v2.patch.yml']; // 一代 preset 不再注册
  const personaPatches = generated.map((g) => `./presets/${g.file}`);
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.bundle = pkg.dsh.bundle || {};
  pkg.dsh.bundle.patch = [...basePatches, ...personaPatches];
  fs.writeFileSync(BUNDLE_PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`[persona-presets] bundle patch 已更新：${pkg.dsh.bundle.patch.length} 个`);
  console.log(`[persona-presets] Done（${generated.length} 个人格）`);
}

main();
