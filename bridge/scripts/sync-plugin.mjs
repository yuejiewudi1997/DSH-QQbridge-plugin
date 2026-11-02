#!/usr/bin/env node
// 把仓库里的桥接源码同步进插件（plugins/qq-bridge-launcher/bridge/）。
//
// 为什么要这一步：插件是可移植的发布物，自带一份桥接本体；但开发还是在仓库根目录做。
// 两边各有一份 src/，不靠脚本同步就一定会漂移。
//
// 不会被覆盖的东西（它们是「运行态」而不是「代码」）：
//   bridge/config.json    —— 这台机器的令牌、白名单、端口
//   bridge/state/         —— 表情库、会话、日志
//   bridge/node_modules/  —— 依赖（只有 --with-deps 才动）
//
// 用法：
//   node scripts/sync-plugin.mjs                # 同步代码
//   node scripts/sync-plugin.mjs --check        # 只报告差异，不写
//   node scripts/sync-plugin.mjs --with-deps    # 连 node_modules 一起同步
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const DST = path.join(SRC, 'plugins', 'qq-bridge-launcher', 'bridge');

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const WITH_DEPS = args.has('--with-deps');

// 目录/文件级白名单：只同步这些东西，不在名单里的一律不动
const DIRS = ['src', 'public', 'roles', 'assets', 'dsh', 'scripts', 'docs'];
const FILES = [
  'package.json', 'package-lock.json', 'config.example.json',
  'README.md', 'README.en.md', 'INSTALL-LOCAL.md', 'RULES.md', 'LICENSE',
  'start-bridge.bat', 'restart.bat'
];

// 别把 Python 字节码缓存同步进去（跑过一次 first-run.py 就会有）
const SKIP_DIRS = new Set(['__pycache__', '.pytest_cache']);
const SKIP_EXT = new Set(['.pyc', '.pyo']);

const stats = { copied: 0, same: 0, missing: 0 };

function sameFile(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    // 大小相同再比 mtime（秒级），避免每次都读全文
    return Math.floor(sa.mtimeMs / 1000) === Math.floor(sb.mtimeMs / 1000);
  } catch {
    return false;
  }
}

function syncDir(rel) {
  const from = path.join(SRC, rel);
  const to = path.join(DST, rel);
  if (!fs.existsSync(from)) return;
  if (!CHECK) fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const childRel = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      syncDir(childRel);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    const src = path.join(SRC, childRel);
    const dst = path.join(DST, childRel);
    if (sameFile(src, dst)) {
      stats.same += 1;
      continue;
    }
    if (CHECK) {
      console.log(`  差异 ${childRel}`);
      stats.copied += 1;
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    stats.copied += 1;
  }
}

console.log(`源  : ${SRC}`);
console.log(`目标: ${DST}${CHECK ? '   (只检查，不写)' : ''}`);
if (!fs.existsSync(DST)) {
  console.error('目标目录不存在：先跑一次 install 或手动建 plugins/qq-bridge-launcher/bridge');
  process.exit(1);
}

for (const d of DIRS) syncDir(d);

for (const f of FILES) {
  const src = path.join(SRC, f);
  if (!fs.existsSync(src)) {
    stats.missing += 1;
    continue;
  }
  const dst = path.join(DST, f);
  if (sameFile(src, dst)) {
    stats.same += 1;
    continue;
  }
  if (CHECK) {
    console.log(`  差异 ${f}`);
    stats.copied += 1;
    continue;
  }
  fs.copyFileSync(src, dst);
  stats.copied += 1;
}

if (WITH_DEPS) {
  const from = path.join(SRC, 'node_modules');
  const to = path.join(DST, 'node_modules');
  if (fs.existsSync(from)) {
    console.log('同步 node_modules（慢，只在依赖变了时用 --with-deps）…');
    if (!CHECK) fs.cpSync(from, to, { recursive: true, force: true, dereference: true });
    stats.copied += 1;
  }
}

console.log('');
console.log(`更新 ${stats.copied} 个 · 未变 ${stats.same} 个 · 源缺失 ${stats.missing} 个`);
if (!CHECK && stats.copied === 0) console.log('已经是最新，插件内的桥接副本与仓库一致。');
