// qq-bridge 启动器（DSH host 插件）。
//
// 干的事很简单：DSH 装配这个 entry 时，把桥接（src/bridge.js）作为子进程拉起来；
// DSH 卸载/退出时，把它连同子进程树一起杀掉。桥接崩了按退避重启。
//
// 几个刻意的设计：
//   1. 只 spawn，不接管桥接的 stdout 文件——桥接自己写 state/bridge.log，
//      这里额外记一份 state/launcher.log 专门记「拉起/退出/重启」这种生命周期事件。
//   2. 启动前先探一下控制台端口：如果已经有一份桥接在跑（手动起的、上一次没退干净的），
//      就不要再起第二个——两个实例会抢 OneBot WS 和 state 锁。
//   3. 把父进程 pid 通过 QQ_BRIDGE_PARENT_PID 传给桥接，桥接那边有看门狗：
//      DSH 被强杀时子进程不会变成孤儿。
//   4. 尽量把 DSH 的真实端口用 DSH_BASE_URL 传下去，省掉桥接启动时那一轮端口探测
//      （DSH 每次启动端口都变）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

export const name = 'qq-bridge-launcher';

// 桥接本体位置：插件自带一份（<插件>/bridge），这样插件本身就是完整可移植的。
// 优先级 内置副本 > 环境变量 > 从本文件位置上溯推断（开发态：仓库里的 plugins/...） > 常见默认。
function detectBridgeHome() {
  const candidates = [];
  try {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
    // <plugin>/lib/index.js → <plugin>/bridge
    candidates.push(path.resolve(here, '..', 'bridge'));
    // 开发态：<repo>/plugins/qq-bridge-launcher/lib/index.js → 上溯 3 层就是 <repo>
    candidates.push(path.resolve(here, '..', '..', '..'));
  } catch {}
  candidates.push(process.env.QQ_BRIDGE_HOME);
  candidates.push('C:/Users/server2/Documents/deepseek-harness/default-workspace/qq-bridge');
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.existsSync(path.join(c, 'src', 'bridge.js'))) return path.resolve(c);
    } catch {}
  }
  return path.resolve(candidates.find(Boolean) || '.');
}

const DEFAULTS = {
  enabled: true,
  bridgeHome: detectBridgeHome(),
  script: 'src/bridge.js',
  autoRestart: true,
  restartDelayMs: 3000,
  maxRestartDelayMs: 60000,
  // 连续这么多次「起来没几秒就死」就进入长退避，避免把日志刷爆
  fastCrashLimit: 5,
  // 首次启动（还没有 config.json）时，弹一个安装向导窗口显示进度。
  // 设 false 就不弹，桥接自己会静默完成同样的初始化。
  firstRunGui: true,
};

function createLogger(home) {
  const file = path.join(home, 'state', 'launcher.log');
  return (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line + '\n');
    } catch {}
  };
}

/** 找一个能跑 ESM 的 node：配置 > 环境变量 > DSH 自带的运行时 > 当前进程。 */
function pickNode(cfg) {
  const candidates = [
    cfg.nodePath,
    process.env.QQ_BRIDGE_NODE,
    process.resourcesPath
      ? path.join(process.resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
      : '',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  // 当前进程就是 DSH 本体（Electron）：用 ELECTRON_RUN_AS_NODE 当 node 用。
  return process.execPath;
}

/** 从桥接 config.json 里读控制台端口/令牌，用来判断「是不是已经有一份在跑」。 */
function readBridgeConsole(home) {
  let port = 3100;
  try {
    const raw = fs.readFileSync(path.join(home, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw);
    if (Number(cfg.consolePort) > 0) port = Number(cfg.consolePort);
  } catch {}
  let token = '';
  try {
    const raw = fs.readFileSync(path.join(home, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw);
    if (cfg.consoleToken) token = String(cfg.consoleToken);
  } catch {}
  if (!token) {
    try {
      token = fs.readFileSync(path.join(home, 'state', 'console-token'), 'utf8').trim();
    } catch {}
  }
  return { port, token };
}

/** 探一下已有实例：能拿到 /api/status 就认为已经在跑。 */
function probeExisting(port, token) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/status', timeout: 800, headers: token ? { 'x-console-token': token } : {} },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** 找 DSH 自带的 python（首启向导要用；优先 pythonw，免得留黑框）。 */
function pickPython() {
  const base = path.join(
    process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    'dsh-runtimes',
    'dsh-primary-runtime',
    'dependencies',
    'python'
  );
  for (const name of ['pythonw.exe', 'python.exe']) {
    const candidate = path.join(base, name);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return process.platform === 'win32' ? 'pythonw' : 'python3';
}

/**
 * 首次启动向导：只在「还没有 config.json」时弹一次。
 *
 * 为什么不放在桥接里：桥接是后台进程，弹窗得有个前台窗口；而且这一步本来就发生在
 * 桥接之前（要先把 config 生成好）。向导和桥接会同时跑：向导第 6、7 步就是等桥接就绪。
 */
function openFirstRunGui(home, diag, cfg) {
  if (cfg.firstRunGui === false) return;
  if (process.platform !== 'win32') return;
  if (fs.existsSync(path.join(home, 'config.json'))) return; // 不是首启
  const script = path.join(home, 'scripts', 'first-run.py');
  if (!fs.existsSync(script)) {
    diag(`没找到首启向导脚本：${script}`);
    return;
  }
  const python = pickPython();
  try {
    const child = spawn(python, [script], {
      cwd: home,
      stdio: 'ignore',
      detached: true,
      windowsHide: false,
    });
    child.unref();
    diag(`首次启动：已打开安装向导（python: ${python}, pid=${child.pid}）`);
  } catch (error) {
    diag(`首启向导启动失败：${error?.message ?? error}`);
  }
}

/** 用 taskkill 杀掉整棵子进程树（Windows 下 kill() 只杀直接子进程）。 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {}
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const home = path.resolve(String(cfg.bridgeHome || DEFAULTS.bridgeHome));
  const log = createLogger(home);
  const scriptPath = path.resolve(home, String(cfg.script || DEFAULTS.script));

  let child = null;
  let stopping = false;
  let restarts = 0;
  let restartTimer = null;
  let startedAt = 0;

  const diag = (msg) => {
    log(msg);
    try { ctx?.logger?.('qq-bridge')?.info?.(msg); } catch {}
  };

  if (cfg.enabled === false) {
    diag('插件被禁用（config.enabled=false），不启动桥接');
    return;
  }

  // DSH 自己的端口：插件跑在 DSH 进程里，能直接拿到 http server 的监听端口。
  let dshBaseUrl = '';
  try {
    const srv = ctx?.server ?? ctx?.get?.('server');
    const addr = srv?.httpServer?.address?.() ?? srv?.address?.();
    const port = srv?.port ?? (addr && typeof addr === 'object' ? addr.port : undefined);
    if (Number(port) > 0) dshBaseUrl = `http://127.0.0.1:${Number(port)}`;
  } catch {}
  if (process.env.DSH_BASE_URL) dshBaseUrl = process.env.DSH_BASE_URL;

  function start() {
    if (stopping) return;
    if (!fs.existsSync(scriptPath)) {
      diag(`桥接脚本不存在：${scriptPath}（检查 config.bridgeHome / 环境变量 QQ_BRIDGE_HOME）`);
      return;
    }
    const node = pickNode(cfg);
    const env = { ...process.env, QQ_BRIDGE_PARENT_PID: String(process.pid) };
    if (dshBaseUrl) env.DSH_BASE_URL = dshBaseUrl;
    // Electron 的可执行文件加上这个变量就等价于 node
    if (process.versions?.electron) env.ELECTRON_RUN_AS_NODE = '1';

    startedAt = Date.now();
    child = spawn(node, [scriptPath], {
      cwd: home,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    diag(`已拉起桥接 pid=${child.pid}（node: ${node}${dshBaseUrl ? `，DSH: ${dshBaseUrl}` : ''}）`);

    const relay = (prefix) => (buf) => {
      const text = String(buf ?? '').trimEnd();
      if (!text) return;
      // 桥接自己会写 bridge.log；这里只留尾部，方便对齐时间线
      try {
        fs.appendFileSync(path.join(home, 'state', 'launcher.log'), text.split(/\r?\n/).map((l) => `${prefix} ${l}`).join('\n') + '\n');
      } catch {}
    };
    child.stdout?.on('data', relay('[out]'));
    child.stderr?.on('data', relay('[err]'));

    child.on('error', (error) => {
      diag(`桥接进程启动失败：${error?.message ?? error}`);
      child = null;
      scheduleRestart();
    });

    child.on('exit', (code, signal) => {
      const alive = Date.now() - startedAt;
      diag(`桥接进程退出（code=${code} signal=${signal}，存活 ${Math.round(alive / 1000)}s）`);
      child = null;
      if (stopping) return;
      if (alive < 8000) restarts += 1;
      else restarts = 0;
      scheduleRestart();
    });
  }

  function scheduleRestart() {
    if (stopping || cfg.autoRestart === false) return;
    if (restartTimer) return;
    const fast = restarts >= (cfg.fastCrashLimit ?? 5);
    const delay = Math.min(
      Number(cfg.restartDelayMs) || 3000,
      Number(cfg.maxRestartDelayMs) || 60000
    ) * (fast ? Math.min(restarts, 10) : 1);
    diag(`将在 ${Math.round(delay / 1000)}s 后重启桥接${fast ? '（连续快速崩溃，已加长退避）' : ''}`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, delay);
    restartTimer.unref?.();
  }

  function stop() {
    stopping = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (child?.pid) {
      diag(`DSH 正在退出，收掉桥接 pid=${child.pid}`);
      killTree(child.pid);
      child = null;
    }
  }

  // 首启先弹向导，再起桥接（向导会等桥接，两边并行不冲突）
  openFirstRunGui(home, diag, cfg);

  // 启动前先看是不是已经有一份在跑（手动起的 / 上次残留）
  const { port, token } = readBridgeConsole(home);
  probeExisting(port, token)
    .then((alive) => {
      if (stopping) return;
      if (alive) {
        diag(`检测到已有桥接在 ${port} 端口运行，本次不重复启动；会盯着它，等它退出后接管`);
        // 别人起的实例我们不抢，但也不能永远放手：它退出后由本插件接管生命周期。
        const watch = setInterval(async () => {
          if (stopping) return;
          if (child) return void clearInterval(watch);
          if (await probeExisting(port, token)) return;
          clearInterval(watch);
          diag('外部桥接实例已退出，改由插件接管');
          start();
        }, 30000);
        watch.unref?.();
        return;
      }
      start();
    })
    .catch(() => start());

  // 卸载钩子：cordis 的 dispose 事件 + effect 双保险（不同版本只保证其中一个）。
  // 注意 ctx.effect(fn) 是「立刻执行 fn，用它的返回值当清理函数」，所以这里必须
  // 返回一个函数，不能直接写 stop —— 那会在装配瞬间就把桥接杀掉。
  try {
    ctx?.on?.('dispose', stop);
  } catch {}
  try {
    ctx?.effect?.(() => () => stop());
  } catch {}
}

export default { name, apply };
