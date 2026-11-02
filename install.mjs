#!/usr/bin/env node
// qq-bridge-launcher 安装器：把插件挂进一个 DSH profile。
//
// 做三件事（和 scripts/setup-dsh.mjs 对另外两个 bundle 做的事一致）：
//   1. <DSH_HOME>/plugins/qq-bridge-launcher  → 本包目录（可读的安装位）
//   2. <profile>/node_modules/qq-bridge-launcher → 上面那个 junction（Node 解析路径）
//   3. profile 的 package.json：加 link: 依赖 + dsh.profile.bundles 里加一条
//
// 用法：
//   node install.mjs                    # 装进默认 profile（desktop）
//   node install.mjs --profile <名字>    # 装进指定 profile
//   node install.mjs --uninstall        # 反向操作（只摘配置，不删你的文件）
//
// 环境变量：DSH_HOME（默认 ~/.dsh）、QQ_BRIDGE_HOME（桥接仓库位置，缺省自动推断）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_NAME = 'qq-bridge-launcher';
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here);

const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const uninstall = args.includes('--uninstall');
const profileName = argOf('--profile') || process.env.DSH_PROFILE || 'desktop';
const dshHome = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const profileDir = path.join(dshHome, 'profiles', profileName);
const pluginsDir = path.join(dshHome, 'plugins');
const linkDir = path.join(pluginsDir, PKG_NAME);
const nodeModulesLink = path.join(profileDir, 'node_modules', PKG_NAME);

function log(msg) {
  console.log(`[qq-bridge-launcher] ${msg}`);
}

function fail(msg) {
  console.error(`[qq-bridge-launcher] ✗ ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(profileDir)) {
  fail(`找不到 profile：${profileDir}（先用 DSH 启动一次，或用 --profile 指定名字）`);
}

function readProfilePkg() {
  const file = path.join(profileDir, 'package.json');
  if (!fs.existsSync(file)) return { file, data: { name: `dsh-profile-${profileName}`, private: true } };
  const raw = fs.readFileSync(file, 'utf8');
  return { file, data: JSON.parse(raw.replace(/^\uFEFF/, '')) };
}

function writeProfilePkg(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Windows 用 junction（不需要管理员），其它平台用 symlink。 */
function ensureLink(target, link) {
  try {
    if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) return 'exists';
  } catch {}
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return 'created';
  } catch (error) {
    fail(`建链接失败 ${link} → ${target}：${error?.message ?? error}`);
  }
}

function removeLink(link) {
  try {
    if (!fs.lstatSync(link, { throwIfNoEntry: false })) return 'absent';
    fs.unlinkSync(link);
    return 'removed';
  } catch (error) {
    return `failed: ${error?.message ?? error}`;
  }
}

const { file, data } = readProfilePkg();

if (uninstall) {
  if (data.dependencies) delete data.dependencies[PKG_NAME];
  const bundles = data.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) {
    const i = bundles.indexOf(PKG_NAME);
    if (i >= 0) bundles.splice(i, 1);
  }
  writeProfilePkg(file, data);
  log(`已从 profile 摘除 ${PKG_NAME}`);
  log(`node_modules 链接：${removeLink(nodeModulesLink)}`);
  log(`plugins 链接：${removeLink(linkDir)}（本包文件没删）`);
  process.exit(0);
}

// 1) 安装位
log(`安装位：${linkDir} → ${pkgRoot}（${ensureLink(pkgRoot, linkDir)}）`);
// 2) Node 解析路径
log(`profile 链接：${nodeModulesLink}（${ensureLink(linkDir, nodeModulesLink)}）`);

// 3) profile 注册
data.dependencies = data.dependencies || {};
data.dependencies[PKG_NAME] = `link:${linkDir.replace(/\\/g, '/')}`;
data.dsh = data.dsh || {};
data.dsh.profile = data.dsh.profile || {};
data.dsh.profile.bundles = data.dsh.profile.bundles || [];
if (!data.dsh.profile.bundles.includes(PKG_NAME)) data.dsh.profile.bundles.push(PKG_NAME);
writeProfilePkg(file, data);
log(`已注册到 profile：${file}`);

// 4) 体检
const bridgeHome = process.env.QQ_BRIDGE_HOME || path.resolve(pkgRoot, '..', '..');
const script = path.join(bridgeHome, 'src', 'bridge.js');
log(`桥接位置：${bridgeHome}（src/bridge.js ${fs.existsSync(script) ? '存在' : '不存在！检查 QQ_BRIDGE_HOME'}）`);
log('完成。重启 DSH 后生效：桥接会被自动拉起，日志看 state/launcher.log。');
