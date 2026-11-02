#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""first-run.py —— 首次启动安装向导（tkinter 窗口，带进度）。

它做的是「让插件第一次能跑起来」这件事，顺序和桥接自己启动时一致：

    1  环境自检        找到桥接目录、node、config.example.json
    2  准备 config      没有就从示例生成（不动已有的）
    3  识别 QQ          读注册表，把安装路径写进 config.json
    4  安装 SnowLuma    没有就按固定版本下载 → 校验 sha256 → 解压
    5  写网关配置       hookAutoLoad / webuiPort
    6  等桥接就绪       轮询 /api/status 直到 dshReady
    7  等网关上线       轮询到 snowluma.connected（QQ 需已登录）

用法：
    python first-run.py               打开窗口，自动开始
    python first-run.py --no-gui      不开窗口，同样的步骤打日志（排查用）
    python first-run.py --lite        下载 6MB 的 lite 版而不是 40MB 的 full 版
    python first-run.py --snowluma-dir D:\\tmp\\sl   装到指定目录（测试用）

窗口只是「看得见」，所有判断都跟桥接运行时一致；重复运行是安全的，
已经就绪的步骤会直接跳过。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

CONSOLE_URL = 'http://127.0.0.1:3100'
GITHUB_API = 'https://api.github.com/repos/SnowLuma/SnowLuma/releases/tags/v{version}'
SNOWLUMA_VERSION = '2.1.1'
# 顺序有讲究：直连 github 在国内经常卡在 DNS/TLS 上（socket 超时管不到 DNS），
# 放最后，镜像先试——字节一样，sha256 校验兜底。
MIRRORS = ['https://ghproxy.net/', 'https://gh-proxy.com/', 'https://ghfast.top/', '']
PRIMARY = '#4d6bfe'
# 单个下载源连不上的话最多等这么久就换下一个（直连 github 往往纯挂）
CONNECT_TIMEOUT = 8
OK_COLOR = '#1a7f37'
FAIL_COLOR = '#d9534f'
MUTED = '#6b7280'

STEP_TITLES = [
    '环境自检',
    '准备 config.json',
    '识别 QQ 安装路径',
    '安装 SnowLuma 网关',
    '写入网关配置',
    '等待桥接就绪',
    '等待网关上线',
]


# ── 小工具 ────────────────────────────────────────────────────────────────────


def find_bridge_root() -> Path:
    return Path(__file__).resolve().parent.parent


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, ValueError):
        return default


def write_json(path: Path, data) -> None:
    """原子写。临时名必须唯一：首次启动时向导和桥接会同时写 config.json，
    固定叫 config.json.tmp 会让两边互相截断，最后 replace 出一个坏文件。"""
    tmp = path.with_name(f'{path.name}.{os.getpid()}.{os.urandom(4).hex()}.tmp')
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def human_bytes(num: float) -> str:
    for unit in ('B', 'KB', 'MB', 'GB'):
        if num < 1024 or unit == 'GB':
            return f'{num:.1f}{unit}' if unit != 'B' else f'{int(num)}B'
        num /= 1024
    return f'{num:.1f}GB'


def find_node(root: Path) -> str:
    candidates = [
        os.environ.get('QQ_BRIDGE_NODE', ''),
        str(Path(os.environ.get('DSH_HOME', Path.home() / '.dsh')) / 'dsh-runtimes' / 'dsh-primary-runtime'
            / 'dependencies' / 'node' / 'bin' / 'node.exe'),
        str(root.parent / 'SnowLuma' / 'node.exe'),
    ]
    for item in candidates:
        if item and Path(item).is_file():
            return item
    found = shutil.which('node')
    return found or ''


def scan_qq_path() -> tuple[str, str, str]:
    """读注册表找 QQ 安装路径，返回 (exe, 来源, 版本)。只用标准库 winreg。"""
    if sys.platform != 'win32':
        return '', '', ''
    try:
        import winreg
    except ImportError:
        return '', '', ''

    def read(key_path: str, value: str = '') -> str:
        for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(root, key_path) as key:
                    data, _ = winreg.QueryValueEx(key, value)
                    if data:
                        return str(data)
            except OSError:
                continue
        return ''

    candidates: list[tuple[str, str]] = []
    for key in (
        r'SOFTWARE\WOW6432Node\Tencent\QQNT',
        r'SOFTWARE\Tencent\QQNT',
    ):
        install = read(key, 'Install')
        if install:
            candidates.append((install, 'registry:QQNT'))
    for key in (
        r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\QQ.exe',
        r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\QQ.exe',
    ):
        exe = read(key, '')
        if exe:
            candidates.append((exe, 'registry:AppPaths'))
    for key in (
        r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\QQ',
        r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ',
    ):
        icon = read(key, 'DisplayIcon')
        if icon:
            candidates.append((icon, 'registry:uninstall'))
    for guess in ('C:/Program Files/Tencent/QQNT', 'C:/Program Files (x86)/Tencent/QQNT', 'D:/QQ'):
        candidates.append((guess, 'known-dir'))

    version = read(r'SOFTWARE\WOW6432Node\Tencent\QQNT', 'version') or read(r'SOFTWARE\Tencent\QQNT', 'version')
    for raw, source in candidates:
        cleaned = re.sub(r',\s*-?\d+$', '', raw.strip().strip('"'))
        exe = cleaned if cleaned.lower().endswith('.exe') else os.path.join(cleaned, 'QQ.exe')
        if exe.lower().endswith('qq.exe') and Path(exe).is_file():
            return str(Path(exe).resolve()), source, version
    return '', '', version


def find_snowluma(root: Path, cfg: dict) -> str:
    """和桥接里的 snowlumaDir 同样的查找顺序。"""
    configured = str(((cfg.get('tools') or {}).get('snowluma') or {}).get('dir') or '').strip()
    if configured:
        return configured if (Path(configured) / 'index.mjs').is_file() else ''
    candidates = [root.parent / 'snowluma']
    env_home = os.environ.get('SNOWLUMA_HOME')
    if env_home:
        candidates.append(Path(env_home))
    probe = root
    for _ in range(5):
        probe = probe.parent
        candidates.extend([probe / 'SnowLuma', probe / 'snowluma'])
    for item in candidates:
        if (item / 'index.mjs').is_file():
            return str(item)
    return ''


def http_json(url: str, timeout: float = 3.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as res:
            return json.loads(res.read().decode('utf-8'))
    except (urllib.error.URLError, OSError, ValueError):
        return None


# ── 安装动作 ──────────────────────────────────────────────────────────────────


def fetch_release_asset(version: str, lite: bool) -> dict:
    asset_name = f'SnowLuma-v{version}-win-x64{"-lite" if lite else ""}.zip'
    req = urllib.request.Request(
        GITHUB_API.format(version=version),
        headers={'user-agent': 'qq-bridge-first-run', 'accept': 'application/vnd.github+json'},
    )
    with urllib.request.urlopen(req, timeout=25) as res:
        release = json.loads(res.read().decode('utf-8'))
    for asset in release.get('assets') or []:
        if asset.get('name') == asset_name:
            digest = str(asset.get('digest') or '').removeprefix('sha256:').lower()
            if not re.fullmatch(r'[a-f0-9]{64}', digest):
                raise RuntimeError(f'{asset_name} 缺少官方 sha256，拒绝安装')
            return {
                'name': asset_name,
                'url': asset['browser_download_url'],
                'size': int(asset.get('size') or 0),
                'sha256': digest,
            }
    raise RuntimeError(f'v{version} 的发布里没有 {asset_name}')


def download_asset(asset: dict, dest: Path, progress) -> None:
    """带进度下载 + 边下边算 sha256；体积或哈希不对就不落盘。"""
    digest = hashlib.sha256()
    received = 0
    stage = dest.with_suffix('.part')
    with urllib.request.urlopen(asset['url'], timeout=CONNECT_TIMEOUT) as res, open(stage, 'wb') as fh:
        total = int(res.headers.get('content-length') or asset['size'] or 0)
        while True:
            chunk = res.read(256 * 1024)
            if not chunk:
                break
            fh.write(chunk)
            digest.update(chunk)
            received += len(chunk)
            progress(received, total)
    if asset['size'] and stage.stat().st_size != asset['size']:
        stage.unlink(missing_ok=True)
        raise RuntimeError(f"体积不符：{stage.stat().st_size} != {asset['size']}")
    if digest.hexdigest() != asset['sha256']:
        stage.unlink(missing_ok=True)
        raise RuntimeError(f"sha256 不符：{digest.hexdigest()[:12]}…")
    os.replace(stage, dest)


def install_snowluma(target: Path, version: str, lite: bool, log, progress) -> Path:
    asset = fetch_release_asset(version, lite)
    log(f"官方发布：{asset['name']} {human_bytes(asset['size'])} sha256 {asset['sha256'][:12]}…")
    workdir = Path(tempfile.mkdtemp(prefix='snowluma-'))
    try:
        zip_path = workdir / asset['name']
        last_error = ''
        for mirror in MIRRORS:
            url = f'{mirror.rstrip("/")}/{asset["url"]}' if mirror else asset['url']
            label = mirror.rstrip('/') or 'github.com'
            try:
                log(f'下载中（{label}）…')
                download_asset({**asset, 'url': url}, zip_path, progress)
                log('下载完成，sha256 校验通过')
                break
            except Exception as error:  # noqa: BLE001 - 逐个源试，最后统一报错
                last_error = f'{label}: {error}'
                log(f'{label} 不通（{error}），换下一个源')
        if not zip_path.exists():
            raise RuntimeError(f'所有下载源都失败：{last_error}')

        stage = workdir / 'stage'
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(stage)
        root = None
        for depth0 in [stage, *[p for p in stage.iterdir() if p.is_dir()]]:
            if (depth0 / 'index.mjs').is_file():
                root = depth0
                break
        if not root:
            raise RuntimeError('解压结果里找不到 index.mjs')

        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(root, target)
        write_json(target / 'installed.json', {
            'version': version,
            'distribution': 'lite' if lite else 'full',
            'sha256': asset['sha256'],
            'installedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        })
        return target
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def ensure_runtime_config(snow_dir: Path) -> None:
    runtime_file = snow_dir / 'config' / 'runtime.json'
    runtime_file.parent.mkdir(parents=True, exist_ok=True)
    runtime = read_json(runtime_file, {}) or {}
    if not isinstance(runtime, dict):
        runtime = {}
    runtime['hookAutoLoad'] = True
    runtime.setdefault('webuiPort', 5099)
    write_json(runtime_file, runtime)


# ── 主流程（UI 与无界面共用）───────────────────────────────────────────────────


class Runner:
    def __init__(self, args, ui):
        self.args = args
        self.ui = ui  # 需要实现 step(i, status, detail) / log(msg) / progress(ratio, text)
        self.root = find_bridge_root()

    def log(self, message: str) -> None:
        self.ui.log(message)

    def step(self, index: int, status: str, detail: str = '') -> None:
        self.ui.step(index, status, detail)

    def run(self) -> bool:
        root = self.root

        # 1 环境自检
        self.step(0, 'run', '检查目录与运行时…')
        files = {'bridge.js': root / 'src' / 'bridge.js', 'config.example.json': root / 'config.example.json'}
        missing = [name for name, p in files.items() if not p.is_file()]
        if missing:
            self.step(0, 'fail', '缺少 ' + '、'.join(missing))
            return False
        node = find_node(root)
        self.step(0, 'ok', f'桥接目录 {root}；node {"已找到" if node else "未找到（由 DSH 提供）"}')
        self.log(f'桥接目录：{root}')
        if node:
            self.log(f'node：{node}')

        # 2 config
        self.step(1, 'run', '准备 config.json…')
        cfg_path = root / 'config.json'
        cfg = read_json(cfg_path, None)
        if isinstance(cfg, dict):
            self.step(1, 'ok', '已存在，保持不改')
        else:
            example = read_json(root / 'config.example.json', None)
            if not isinstance(example, dict):
                self.step(1, 'fail', 'config.example.json 不可用')
                return False
            write_json(cfg_path, example)
            cfg = example
            self.step(1, 'ok', '已按 config.example.json 生成')
            self.log('已生成新的 config.json（白名单还是空的，稍后在控制台填）')

        # 3 QQ 路径
        self.step(2, 'run', '扫描注册表…')
        tools = cfg.setdefault('tools', {}) if isinstance(cfg, dict) else {}
        current = ((tools.get('qq') or {}).get('path') or '').strip()
        if current and Path(current).is_file():
            self.step(2, 'ok', f'已在配置里：{current}')
            qq_path, qq_source, qq_version = current, 'config', str((tools.get('qq') or {}).get('version') or '')
        else:
            qq_path, qq_source, qq_version = scan_qq_path()
            if qq_path:
                tools['qq'] = {'path': qq_path, 'source': qq_source, 'version': qq_version,
                               'detectedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
                write_json(cfg_path, cfg)
                self.step(2, 'ok', f'{qq_path}（{qq_source}）')
                self.log(f'识别到 QQ：{qq_path}（{qq_source}，v{qq_version or "?"}）')
            else:
                self.step(2, 'warn', '没找到，可稍后手填 tools.qq.path')

        # 4 SnowLuma
        self.step(3, 'run', '检查网关…')
        live_tools = http_json(f'{CONSOLE_URL}/api/tools/status') or {}
        live_dir = str((live_tools.get('snowluma') or {}).get('dir') or '')
        snow_dir = self.args.snowluma_dir or (
            live_dir if live_dir and (Path(live_dir) / 'index.mjs').is_file() else find_snowluma(root, cfg)
        )
        if snow_dir and (Path(snow_dir) / 'index.mjs').is_file() and not self.args.force_download:
            self.step(3, 'ok', f'已安装：{snow_dir}')
            self.log(f'SnowLuma 已存在：{snow_dir}')
        else:
            target = Path(self.args.snowluma_dir) if self.args.snowluma_dir else root.parent / 'snowluma'
            started = time.time()
            throttle = {'pct': -1.0, 'at': 0.0}

            def on_progress(got: int, total: int) -> None:
                """下载进度：百分比 + 已下/总量 + 平均速度，限流到每 2% 或每 0.4 秒一次。"""
                ratio = (got / total) if total else 0.0
                pct = ratio * 100
                if pct - throttle['pct'] < 2 and time.time() - throttle['at'] < 0.4:
                    return
                throttle['pct'] = pct
                throttle['at'] = time.time()
                speed = got / max(time.time() - started, 0.001)
                text = f'下载中 {human_bytes(got)} / {human_bytes(total)}（{pct:.0f}%，{human_bytes(speed)}/s）'
                self.step(3, 'run', text)
                self.ui.progress(ratio, text)

            try:
                install_snowluma(target, self.args.version, self.args.lite, self.log, on_progress)
                self.ui.progress(1.0, '下载完成')
                snow_dir = str(target)
                self.step(3, 'ok', f'已安装到 {snow_dir}')
            except Exception as error:  # noqa: BLE001 - 装不上就把原因摆出来
                self.step(3, 'fail', str(error))
                self.log(f'安装失败：{error}')
                return False

        # 5 网关配置
        self.step(4, 'run', '写 runtime.json…')
        ensure_runtime_config(Path(snow_dir))
        self.step(4, 'ok', 'hookAutoLoad=true')

        # 6 等桥接
        self.step(5, 'run', '等待桥接…')
        deadline = time.time() + self.args.bridge_timeout
        status = None
        while time.time() < deadline:
            status = http_json(f'{CONSOLE_URL}/api/status')
            if status:
                break
            time.sleep(1.5)
        if not status:
            self.step(5, 'fail', f'桥接没起来（{CONSOLE_URL} 连不上）')
            self.log('桥接由 DSH 启动：请先启动 DSH，或手动运行 start-bridge.bat 后点「重试」')
            return False
        self.step(5, 'ok', f"dshReady={status.get('dshReady')} 模式={status.get('mode')}")

        # 7 等网关
        self.step(6, 'run', '等待 SnowLuma 连上…')
        deadline = time.time() + self.args.gateway_timeout
        last_note = ''
        while time.time() < deadline:
            status = http_json(f'{CONSOLE_URL}/api/status') or {}
            tools_state = http_json(f'{CONSOLE_URL}/api/tools/status') or {}
            connected = bool((status.get('snowluma') or {}).get('connected'))
            gateway = (tools_state.get('snowluma') or {})
            qq = (tools_state.get('qq') or {})
            if connected:
                self.log('初始化完成。')
                self.step(6, 'ok', '网关已连上' + ('' if qq.get('running') else '（注意：QQ 客户端当前没运行）'))
                return True
            note = '网关进程{}；QQ 客户端{}'.format(
                '在跑' if gateway.get('running') else '没在跑',
                '在跑' if qq.get('running') else '没在跑',
            )
            if note != last_note:
                self.step(6, 'run', '等待中：' + note)
                last_note = note
            time.sleep(2.0)
        self.step(6, 'warn', '还没连上（QQ 是否已登录？）')
        self.log('网关未连接：确认 QQ 已登录，hook 才会被注入并启动 OneBot。')
        return False


# ── 无界面模式 ────────────────────────────────────────────────────────────────


class ConsoleUI:
    def step(self, index, status, detail=''):
        print(f'[{status:4}] {STEP_TITLES[index]}  {detail}', flush=True)

    def log(self, message):
        print(f'       {message}', flush=True)

    def progress(self, ratio, text):
        pass


# ── 窗口 ──────────────────────────────────────────────────────────────────────


def make_window(args):
    import tkinter as tk
    from tkinter import ttk

    root = tk.Tk()
    root.title('QQ Bridge · 首次启动')
    root.geometry('820x620+120+120')
    root.minsize(720, 520)
    root.configure(bg='#f7f8fa')

    header = tk.Frame(root, bg='white')
    header.pack(fill='x')
    tk.Label(header, text='QQ Bridge 首次启动', font=('Microsoft YaHei UI', 16, 'bold'),
             bg='white', fg='#111827').pack(anchor='w', padx=20, pady=(16, 2))
    tk.Label(header, text='按顺序检查并安装运行所需的组件；已就绪的步骤会直接跳过。',
             font=('Microsoft YaHei UI', 9), bg='white', fg=MUTED).pack(anchor='w', padx=20, pady=(0, 14))

    body = tk.Frame(root, bg='#f7f8fa')
    body.pack(fill='both', expand=True, padx=16, pady=12)

    rows = []
    for title in STEP_TITLES:
        row = tk.Frame(body, bg='#f7f8fa')
        row.pack(fill='x', pady=3)
        icon = tk.Label(row, text='○', width=2, bg='#f7f8fa', fg=MUTED,
                        font=('Segoe UI Symbol', 11, 'bold'))
        icon.pack(side='left')
        name = tk.Label(row, text=title, bg='#f7f8fa', fg='#111827', width=20, anchor='w',
                        font=('Microsoft YaHei UI', 10))
        name.pack(side='left')
        detail = tk.Label(row, text='', bg='#f7f8fa', fg=MUTED, anchor='w',
                          font=('Microsoft YaHei UI', 9))
        detail.pack(side='left', fill='x', expand=True)
        rows.append({'icon': icon, 'name': name, 'detail': detail})

    bar_row = tk.Frame(root, bg='#f7f8fa')
    bar_row.pack(fill='x', padx=16)
    bar = ttk.Progressbar(bar_row, mode='determinate', maximum=100)
    bar.pack(fill='x', side='top')
    bar_text = tk.Label(bar_row, text='', bg='#f7f8fa', fg=MUTED, anchor='w',
                        font=('Microsoft YaHei UI', 9))
    bar_text.pack(fill='x', pady=(4, 0))

    log_frame = tk.Frame(root, bg='#f7f8fa')
    log_frame.pack(fill='both', expand=True, padx=16, pady=(10, 0))
    log_text = tk.Text(log_frame, height=9, bg='#0f172a', fg='#d7e0f5', insertbackground='white',
                       relief='flat', font=('Consolas', 9), wrap='word', padx=10, pady=8)
    log_text.pack(side='left', fill='both', expand=True)
    scroll = ttk.Scrollbar(log_frame, command=log_text.yview)
    scroll.pack(side='right', fill='y')
    log_text.configure(yscrollcommand=scroll.set, state='disabled')

    footer = tk.Frame(root, bg='#f7f8fa')
    footer.pack(fill='x', padx=16, pady=12)
    open_btn = tk.Button(footer, text='打开控制台', state='disabled',
                         font=('Microsoft YaHei UI', 9), relief='flat', bg='#e8ecf7')
    open_btn.pack(side='left')
    retry_btn = tk.Button(footer, text='重试', state='disabled',
                          font=('Microsoft YaHei UI', 9), relief='flat', bg='#e8ecf7')
    retry_btn.pack(side='left', padx=8)
    close_btn = tk.Button(footer, text='关闭', font=('Microsoft YaHei UI', 9), relief='flat',
                          bg='#e8ecf7', command=root.destroy)
    close_btn.pack(side='right')

    import queue
    events: queue.Queue = queue.Queue()
    state = {'done': False, 'ratio': 0.0, 'steps': [''] * len(STEP_TITLES)}

    def overall_ratio() -> float:
        """总进度 =（已完成步数 + 第 4 步的下载比例）/ 总步数，单调、不来回跳。"""
        if state['done']:
            return 1.0
        done = sum(1 for s in state['steps'] if s in ('ok', 'warn'))
        partial = state['ratio'] if state['steps'][3] == 'run' else 0.0
        return min(1.0, (done + partial) / len(STEP_TITLES))

    def refresh_overall():
        bar['value'] = overall_ratio() * 100

    def apply_step(index, status, detail):
        row = rows[index]
        glyph = {'run': '◐', 'ok': '●', 'fail': '✕', 'warn': '!'}.get(status, '○')
        color = {'run': PRIMARY, 'ok': OK_COLOR, 'fail': FAIL_COLOR, 'warn': '#b45309'}.get(status, MUTED)
        row['icon'].configure(text=glyph, fg=color)
        row['name'].configure(fg='#111827' if status != 'run' else PRIMARY)
        row['detail'].configure(text=detail, fg=color if status in ('fail', 'warn') else MUTED)
        state['steps'][index] = status
        if index == 3 and status != 'run':
            state['ratio'] = 0.0
        refresh_overall()

    def apply_log(message):
        log_text.configure(state='normal')
        log_text.insert('end', message.rstrip() + '\n')
        log_text.see('end')
        log_text.configure(state='disabled')

    def pump():
        try:
            while True:
                kind, payload = events.get_nowait()
                if kind == 'step':
                    apply_step(*payload)
                elif kind == 'log':
                    apply_log(payload)
                elif kind == 'progress':
                    ratio, text = payload
                    state['ratio'] = ratio
                    refresh_overall()
                    bar_text.configure(text=text)
                elif kind == 'done':
                    state['done'] = payload
                    refresh_overall()
                    bar_text.configure(text='全部完成' if payload else '未完成，可查看日志后重试')
                    open_btn.configure(state='normal' if payload else 'disabled')
                    retry_btn.configure(state='normal')
        except queue.Empty:
            pass
        root.after(80, pump)

    class GuiUI:
        def step(self, index, status, detail=''):
            events.put(('step', (index, status, detail)))

        def log(self, message):
            events.put(('log', message))

        def progress(self, ratio, text):
            events.put(('progress', (ratio, text)))

    def run_once():
        retry_btn.configure(state='disabled')
        state['done'] = False
        state['ratio'] = 0.0
        state['steps'] = [''] * len(STEP_TITLES)
        for row in rows:
            row['icon'].configure(text='○', fg=MUTED)
            row['detail'].configure(text='', fg=MUTED)
        bar['value'] = 0
        bar_text.configure(text='')

        def work():
            ok = False
            try:
                ok = Runner(args, GuiUI()).run()
            except Exception as error:  # noqa: BLE001 - 任何异常都要显示出来
                events.put(('log', f'意外错误：{error}'))
            finally:
                events.put(('done', ok))

        threading.Thread(target=work, daemon=True).start()

    def open_console():
        import webbrowser
        webbrowser.open(CONSOLE_URL)

    open_btn.configure(command=open_console)
    retry_btn.configure(command=run_once)

    root.after(120, pump)
    root.after(200, run_once)
    return root


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='QQ Bridge 首次启动安装向导')
    parser.add_argument('--no-gui', action='store_true', help='不开窗口，只打日志')
    parser.add_argument('--lite', action='store_true', help='下载 lite 版网关（6MB，要求 node ^24.22.1）')
    parser.add_argument('--version', default=SNOWLUMA_VERSION, help='网关版本，默认 2.1.1')
    parser.add_argument('--snowluma-dir', default='', help='网关安装目录（默认插件同级 snowluma）')
    parser.add_argument('--force-download', action='store_true', help='即使已安装也重新下载')
    parser.add_argument('--bridge-timeout', type=float, default=90, help='等桥接就绪的秒数')
    parser.add_argument('--gateway-timeout', type=float, default=180, help='等网关连上的秒数')
    args = parser.parse_args(argv)

    if args.no_gui:
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
        return 0 if Runner(args, ConsoleUI()).run() else 1

    window = make_window(args)
    window.mainloop()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
