#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""watch-qq.py —— QQ 客户端守护：没在运行就弹窗提醒。

为什么需要它：桥接的全部能力都依赖 QQ 客户端活着（hook DLL 注入在 QQ 进程里）。
QQ 一关，SnowLuma 还在跑、3000/3001 还在监听，但再也收不到任何消息——
从外面看就是「机器人在线，但不回话」，而且日志里不会报错。
这个脚本把这种沉默的失败变成一次看得见的弹窗。

用法：
    python watch-qq.py                     常驻，默认 30 秒查一次
    python watch-qq.py --interval 10       查得更勤
    python watch-qq.py --once              只查一次：在跑退出码 0，没在跑退出码 1
    python watch-qq.py --test              弹一次真实弹窗（手动关掉）
    python watch-qq.py --start-qq "D:\\QQ\\QQ.exe"
                                           弹窗里多一个「要现在帮你打开吗」

    python watch-qq.py --log watch-qq.log  同时写日志文件

退出码：0 正常；带 --once 时，1 表示 QQ 没在运行。
"""

from __future__ import annotations

import argparse
import csv
import io
import os
import subprocess
import sys
import threading
import time
from datetime import datetime

DEFAULT_PROCESS_NAMES = ("qq.exe", "qqnt.exe")
DEFAULT_TITLE = "QQ 没有在运行"


def log(message: str, log_file: str = "") -> None:
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {message}"
    print(line, flush=True)
    if log_file:
        try:
            with open(log_file, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except OSError:
            pass


def list_processes() -> list[tuple[str, str]]:
    """用 tasklist 枚举进程，不依赖 psutil（目标机器不一定装了）。"""
    try:
        completed = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            capture_output=True,
            timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return []
    # tasklist 在中文系统上是 GBK 输出，但进程名是 ASCII，用 replace 兜住解码失败
    text = completed.stdout.decode("mbcs", errors="replace")
    rows = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) >= 2:
            rows.append((row[0].strip(), row[1].strip()))
    return rows


def find_targets(names: tuple[str, ...]) -> list[tuple[str, str]]:
    wanted = {name.lower() for name in names}
    return [(name, pid) for name, pid in list_processes() if name.lower() in wanted]


def _dialog_ctypes(title: str, message: str) -> None:
    """没有 tkinter 时的兜底：直接调 user32 的 MessageBoxW。"""
    import ctypes

    MB_OK = 0x0
    MB_ICONWARNING = 0x30
    MB_TOPMOST = 0x40000
    MB_SETFOREGROUND = 0x10000
    ctypes.windll.user32.MessageBoxW(
        None, message, title, MB_OK | MB_ICONWARNING | MB_TOPMOST | MB_SETFOREGROUND
    )


def show_dialog(title: str, message: str, start_qq: str = "") -> None:
    """弹一个置顶对话框；--start-qq 时给一个「帮我打开」的按钮。"""
    try:
        import tkinter as tk
        from tkinter import messagebox
    except Exception:
        _dialog_ctypes(title, message)
        return

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        if start_qq:
            if messagebox.askyesno(title, f"{message}\n\n要现在帮你打开 QQ 吗？", parent=root):
                try:
                    subprocess.Popen([start_qq], close_fds=True)
                except OSError as error:
                    messagebox.showerror(title, f"打不开 QQ：{error}", parent=root)
        else:
            messagebox.showwarning(title, message, parent=root)
    finally:
        try:
            root.destroy()
        except Exception:
            pass


class Notifier:
    """弹窗放在后台线程：MainLoop 不该被一个模态框卡住（否则恢复后不会重置状态）。"""

    def __init__(self, title: str, start_qq: str) -> None:
        self.title = title
        self.start_qq = start_qq
        self._thread: threading.Thread | None = None

    def notify(self, message: str) -> None:
        if self._thread and self._thread.is_alive():
            return  # 上一个还没关掉，别叠窗口

        def run() -> None:
            try:
                show_dialog(self.title, message, self.start_qq)
            except Exception as error:  # 弹窗失败不能影响守护本身
                log(f"弹窗失败：{error}")

        self._thread = threading.Thread(target=run, name="qq-watch-dialog", daemon=True)
        self._thread.start()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="QQ 客户端守护：没在运行就弹窗提醒",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--interval", type=float, default=30, help="检查间隔秒数（默认 30）")
    parser.add_argument(
        "--debounce",
        type=int,
        default=2,
        help="连续多少次查不到才算真关了（默认 2；QQ 退出时会有进程残留）",
    )
    parser.add_argument("--once", action="store_true", help="只查一次，没在运行返回退出码 1")
    parser.add_argument("--test", action="store_true", help="弹一次测试弹窗后退出")
    parser.add_argument("--no-dialog", action="store_true", help="只打日志，不弹窗")
    parser.add_argument("--title", default=DEFAULT_TITLE, help="弹窗标题")
    parser.add_argument("--start-qq", default="", help="QQ.exe 路径；给了就在弹窗里加「帮我打开」")
    parser.add_argument("--log", default="", help="额外写一份日志文件")
    parser.add_argument(
        "--process",
        default=",".join(DEFAULT_PROCESS_NAMES),
        help="要监视的进程名，逗号分隔（默认 qq.exe,qqnt.exe）",
    )
    parser.add_argument(
        "--repeat-minutes",
        type=float,
        default=0,
        help="QQ 一直没开时，多少分钟后再提醒一次（默认 0=只提醒一次）",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    names = tuple(name.strip() for name in args.process.split(",") if name.strip())

    if args.test:
        log("弹一次测试弹窗（关掉它即退出）", args.log)
        show_dialog(args.title, "这是一次测试：QQ 没在运行时会看到这个窗口。", args.start_qq)
        return 0

    notifier = Notifier(args.title, args.start_qq)
    offline_streak = 0
    alerted = False
    last_alert = 0.0

    log(f"开始监视：{', '.join(names)}（每 {args.interval:g}s 检查一次）", args.log)
    while True:
        hits = find_targets(names)
        running = bool(hits)

        if running:
            if alerted or offline_streak:
                log(f"QQ 已恢复运行（{len(hits)} 个进程）", args.log)
            offline_streak = 0
            alerted = False
        else:
            offline_streak += 1
            if offline_streak >= max(1, args.debounce) and not alerted:
                log("QQ 没在运行 —— 桥接此刻收不到任何 QQ 消息", args.log)
                if not args.no_dialog:
                    notifier.notify(
                        "QQ 客户端没有在运行。\n\n"
                        "桥接现在收不到任何 QQ 消息，机器人看起来在线但不会回话。\n"
                        "请打开 QQ 并确认已登录。"
                    )
                alerted = True
                last_alert = time.time()
            elif (
                alerted
                and args.repeat_minutes > 0
                and time.time() - last_alert >= args.repeat_minutes * 60
            ):
                log(f"QQ 仍未运行，再次提醒（已过 {args.repeat_minutes:g} 分钟）", args.log)
                if not args.no_dialog:
                    notifier.notify("QQ 客户端仍未运行，桥接还是收不到消息。")
                last_alert = time.time()

        if args.once:
            return 0 if running else 1
        time.sleep(max(0.5, args.interval))


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    raise SystemExit(main())
