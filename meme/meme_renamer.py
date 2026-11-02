#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
梗图合集整理器 (Meme Collections)

功能
----
1. 选一个文件夹作为工程目录，递归扫出里面所有图片，网格显示缩略图。
2. 「合集」是纯数据标签：工程目录下只有一个 _合集.json 记录
   「哪个合集包含哪些图片」+「每张图的手写备注」。
   不建文件夹、不复制、不移动任何文件。
3. 一张图可以同时属于多个合集（多个标签）。
   它的备注 = 手写备注；没手写就把所有标签合并起来，例如「破防、开心」。
4. 侧栏合集列表：新建、删除、单击选中、双击进入（只显示该合集图片）、退出。
5. 「备注列表」窗口列出所有被归过类的图片，逐张查看合并后的标签并改手写备注。
6. 可选把备注同步进 QQ 收藏表情的官方备注（desc），未收藏的还能一并上传。
   由 qq_sync.py 负责，连不上 QQ 不影响本地操作。

依赖：Python 3.9+，Pillow（缩略图；缺失时仍可用）
"""
from __future__ import annotations

import json
import os
import queue
import re
import sys
import threading
import time
import traceback
from pathlib import Path

import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk

try:
    from PIL import Image, ImageTk

    HAS_PIL = True
except Exception:  # pragma: no cover - 环境缺 Pillow 时降级
    HAS_PIL = False

try:  # QQ 联动是可选的：模块缺失 / 单文件拷贝出去时自动降级
    import qq_sync

    HAS_QQ = True
except Exception:  # pragma: no cover
    qq_sync = None
    HAS_QQ = False

APP_TITLE = "梗图合集整理器"
VERSION = "3.11"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"}
META_FILE = "_合集.json"        # 唯一的数据库：合集 → 图片清单，以及每张图的手写备注
ADD_LOG = "_加入日志.jsonl"     # 每次「加入合集」的记录，供撤销用

QQ_DEFAULTS = {
    "http_url": "http://127.0.0.1:3000",
    "token": "",
    "console_url": "",
    "console_token": "",
    "upload": False,
    "delay_ms": 1200,
    "cap": 100,
}

# 情绪标签（名称, 颜色）
EMOTIONS = [
    ("开心", "#F6C445"), ("生气", "#E4572E"), ("惊讶", "#29B6A8"),
    ("悲伤", "#4C7BD9"), ("害怕", "#8E6FD8"), ("厌恶", "#7C8798"),
    ("疑惑", "#E0913F"), ("得意", "#D96A3C"), ("害羞", "#F39BB0"),
    ("无语", "#9AA0A6"), ("委屈", "#B36BE0"), ("期待", "#2FB344"),
    ("满足", "#6FBF4A"), ("焦虑", "#E39A20"), ("兴奋", "#E63E8B"),
    ("温柔", "#F2A7BE"), ("冷漠", "#667085"), ("尴尬", "#D99A6C"),
    ("无奈", "#8A97A8"), ("治愈", "#2FC08A"), ("嘲讽", "#E8702A"),
    ("心碎", "#C2185B"), ("恋爱", "#F0629B"), ("疯狂", "#C62828"),
    ("安心", "#2EA8D8"), ("厌世", "#4E5A66"),
]

# 梗标签（网络梗 / 打工人 / AI 梗）
MEME_TAGS = [
    ("打工人", "#94A3B8"), ("破防", "#F97316"), ("摆烂", "#A8A29E"),
    ("躺平", "#7DD3FC"), ("内卷", "#FBBF24"), ("内耗", "#A78BFA"),
    ("摸鱼", "#22D3EE"), ("嘴替", "#38BDF8"), ("真香", "#FCD34D"),
    ("老六", "#CBD5E1"), ("大冤种", "#FB7185"), ("社死", "#F472B6"),
    ("社恐", "#818CF8"), ("社牛", "#34D399"), ("阴阳怪气", "#FACC15"),
    ("凡尔赛", "#FDBA74"), ("抽象", "#C084FC"), ("整活", "#F0ABFC"),
    ("拷打", "#F87171"), ("绷不住", "#EF4444"), ("电子木鱼", "#2DD4BF"),
    ("赛博", "#60A5FA"), ("幻觉", "#A78BFA"), ("对齐", "#4ADE80"),
    ("提示词", "#38BDF8"), ("token", "#2DD4BF"), ("算力", "#FB923C"),
    ("显卡", "#86EFAC"), ("训练", "#FDE047"), ("开源", "#4ADE80"),
    ("卷王", "#FDA4AF"), ("纯爱", "#F9A8D4"),
]

TAG_GROUPS = [("情绪", EMOTIONS), ("梗", MEME_TAGS)]
EMOTION_COLOR = {name: color for _, group in TAG_GROUPS for name, color in group}

# 原始标签：可以拿来建合集，但永远不许删
BUILTIN_TAGS = [name for _, group in TAG_GROUPS for name, _ in group]

# 自定义标签没有预设色，按名字哈希从这套里取一个
CUSTOM_PALETTE = ["#7C8798", "#4C7BD9", "#D96A3C", "#2FB344", "#B36BE0",
                  "#E0913F", "#29B6A8", "#E63E8B"]

PAGE_SIZE = 100          # 每页图片数

REMARK_SEP = "、"          # 多个标签合并时的分隔符
REMARK_JOIN = "｜"         # 标签和手写备注之间的分隔符


# --------------------------------------------------------------------------- #
#  基础工具
# --------------------------------------------------------------------------- #


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def natural_key(text: str):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def is_hidden(name: str) -> bool:
    """以 . 或 _ 开头的是程序自己的东西（数据库、日志），不扫进去。"""
    return name.startswith(".") or name.startswith("_")


def sanitize_name(name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", (name or "").strip()).strip().strip(".")
    return cleaned or "未命名"


def scan_images(project: Path) -> list[Path]:
    """递归扫出工程目录下所有图片（跳过 _ . 开头的目录）。"""
    found: list[tuple[str, Path]] = []
    if not project or not project.exists():
        return []
    for root, dirs, files in os.walk(project):
        dirs[:] = [d for d in dirs if not is_hidden(d)]
        head = Path(root)
        for name in files:
            candidate = head / name
            if is_image(candidate):
                found.append((candidate.relative_to(project).as_posix(), candidate))
    found.sort(key=lambda item: natural_key(item[0]))
    return [path for _rel, path in found]


def to_rel(project: Path, path: Path) -> str:
    """统一成相对工程目录的 posix 风格路径，便于写进 json、换机器也能用。

    先用便宜的 relative_to（扫目录时每条都要算，resolve() 太慢），
    只有跨界/相对路径不太好使的时候才退回 resolve()。
    """
    text_path = str(path)
    prefix = str(project)
    if not prefix.endswith(("\\", "/")):
        prefix += os.sep
    if text_path.startswith(prefix):
        # 最常见的路径：直接切前缀，比 pathlib 快 70 倍
        return text_path[len(prefix):].replace("\\", "/")
    try:
        return os.path.relpath(text_path, str(project)).replace("\\", "/")
    except Exception:  # noqa: BLE001
        return Path(path).name


# --------------------------------------------------------------------------- #
#  数据层：合集就是 _合集.json 里的一组相对路径
# --------------------------------------------------------------------------- #


class Library:
    """工程目录的合集数据库。全部数据只存在 _合集.json 里，不碰图片文件。"""

    def __init__(self, project: Path):
        self.project = project
        self.path = project / META_FILE
        self.collections: dict[str, list[str]] = {}
        self.notes: dict[str, str] = {}
        self.custom_tags: list[str] = []
        self._index: dict[str, list[str]] | None = None
        self.load()

    # -- 读写 -------------------------------------------------------------
    def load(self) -> None:
        data: dict = {}
        if self.path.exists():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8-sig"))
                if isinstance(loaded, dict):
                    data = loaded
            except Exception:  # noqa: BLE001 - 数据库坏了也不该打不开
                data = {}
        raw = data.get("collections")
        self.collections = {}
        if isinstance(raw, dict):
            for name, value in raw.items():
                items = value.get("images") if isinstance(value, dict) else value
                if isinstance(items, list):
                    self.collections[str(name)] = [str(item) for item in items]
        raw_notes = data.get("notes")
        self.notes = {}
        if isinstance(raw_notes, dict):
            self.notes = {str(k): str(v) for k, v in raw_notes.items() if str(v).strip()}

        self._index = None
        raw_tags = data.get("tags")
        custom = raw_tags.get("custom") if isinstance(raw_tags, dict) else None
        self.custom_tags = []
        if isinstance(custom, list):
            seen = {name.casefold() for name in BUILTIN_TAGS}
            for item in custom:
                name = str(item).strip()
                if name and name.casefold() not in seen:
                    seen.add(name.casefold())
                    self.custom_tags.append(name)

    def save(self) -> None:
        self.project.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 3,
            "collections": {name: {"images": rels} for name, rels in self.collections.items()},
            "notes": {k: v for k, v in self.notes.items() if v.strip()},
            "tags": {"custom": list(self.custom_tags)},
        }
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    # -- 查询 -------------------------------------------------------------
    def names(self) -> list[str]:
        return sorted(self.collections, key=natural_key)

    def rels_of(self, name: str) -> list[str]:
        return list(self.collections.get(name, []))

    def paths_of(self, name: str) -> list[Path]:
        """合集里的图片，只返回磁盘上真的还在的那些。

        用字符串拼路径 + os.path.isfile，比 Path 运算快一倍多
        （1800 张的合集从 ~90 ms 降到 ~40 ms）。
        """
        base = str(self.project)
        if not base.endswith(("\\", "/")):
            base += os.sep
        out: list[Path] = []
        for rel in self.collections.get(name, []):
            full = base + rel.replace("/", os.sep)
            if os.path.isfile(full):
                out.append(Path(full))
        return out

    def count(self, name: str) -> int:
        """记录条数。不逐张检查磁盘——切标签/刷新列表要快，
        实际取图走 paths_of()，那里才过滤已删除的文件。"""
        return len(self.collections.get(name, []))

    def _reverse_index(self) -> dict[str, list[str]]:
        """rel（小写）→ [合集名]。每次改合集才重建，查一次是 O(1)。

        不建索引的话，遍历一遍全库要 2000×1800 次字符串比较（约 0.6 秒）。
        """
        if self._index is None:
            index: dict[str, list[str]] = {}
            for name, rels in self.collections.items():
                for rel in rels:
                    index.setdefault(rel.casefold(), []).append(name)
            for names in index.values():
                names.sort(key=natural_key)
            self._index = index
        return self._index

    def tags_of(self, rel: str) -> list[str]:
        """这张图属于哪些合集（标签）。"""
        return list(self._reverse_index().get(rel.casefold(), []))

    def merged_remark(self, rel: str) -> str:
        """没有手写备注时，把所有标签合并成一句话。"""
        return REMARK_SEP.join(self.tags_of(rel))

    def remark_of(self, rel: str) -> str:
        """标签在前，手写备注接在后面补充；没有标签就只用备注。"""
        manual = (self.notes.get(rel) or "").strip()
        merged = self.merged_remark(rel)
        if manual and merged:
            return f"{merged}{REMARK_JOIN}{manual}"
        return manual or merged

    def is_manual(self, rel: str) -> bool:
        return bool((self.notes.get(rel) or "").strip())

    def tagged(self) -> list[str]:
        """所有至少属于一个合集的图片（备注列表用）。"""
        rels: set[str] = set()
        for items in self.collections.values():
            for rel in items:
                if (self.project / rel).is_file():
                    rels.add(rel)
        return sorted(rels, key=natural_key)

    # -- 标签 -------------------------------------------------------------
    def all_tags(self) -> list[str]:
        """原始标签 + 自定义标签 + json 里出现但没登记的合集名（手改文件的兜底）。"""
        seen = {name.casefold() for name in BUILTIN_TAGS}
        tags = list(BUILTIN_TAGS)
        for name in self.custom_tags:
            if name.casefold() not in seen:
                seen.add(name.casefold())
                tags.append(name)
        for name in self.collections:
            if name.casefold() not in seen:
                seen.add(name.casefold())
                tags.append(name)
        return tags

    def is_builtin(self, name: str) -> bool:
        return any(name.casefold() == item.casefold() for item in BUILTIN_TAGS)

    def add_tag(self, name: str) -> str:
        clean = sanitize_name(name)
        for existing in self.all_tags():
            if existing.casefold() == clean.casefold():
                raise ValueError(f"标签「{clean}」已经存在")
        self.custom_tags.append(clean)
        self.save()
        return clean

    def remove_tag(self, name: str) -> None:
        """删自定义标签：连同它的合集一起删，图片不动。原始标签不允许删。"""
        if self.is_builtin(name):
            raise ValueError(f"「{name}」是原始标签，不能删除")
        self._index = None
        self.custom_tags = [t for t in self.custom_tags if t.casefold() != name.casefold()]
        for key in [k for k in self.collections if k.casefold() == name.casefold()]:
            self.collections.pop(key, None)
        self.save()

    # -- 修改 -------------------------------------------------------------
    def create(self, name: str) -> str:
        self._index = None
        name = sanitize_name(name)
        if name in self.collections:
            raise ValueError(f"合集「{name}」已经存在")
        self.collections[name] = []
        self.save()
        return name

    def delete(self, name: str) -> None:
        self._index = None
        self.collections.pop(name, None)
        self.save()

    def add(self, name: str, rels: list[str]) -> int:
        self._index = None
        bucket = self.collections.setdefault(name, [])
        existing = {item.casefold() for item in bucket}
        added = 0
        for rel in rels:
            if rel.casefold() in existing:
                continue
            bucket.append(rel)
            existing.add(rel.casefold())
            added += 1
        if added:
            self.save()
        return added

    def remove(self, name: str, rels: list[str]) -> int:
        self._index = None
        bucket = self.collections.get(name)
        if not bucket:
            return 0
        drop = {rel.casefold() for rel in rels}
        keep = [rel for rel in bucket if rel.casefold() not in drop]
        removed = len(bucket) - len(keep)
        if removed:
            self.collections[name] = keep
            self.save()
        return removed

    def set_note(self, rel: str, text: str) -> None:
        text = (text or "").strip()
        if text:
            self.notes[rel] = text
        else:
            self.notes.pop(rel, None)
        self.save()


# --------------------------------------------------------------------------- #
#  加入日志（撤销用）
# --------------------------------------------------------------------------- #


def log_added(project: Path, batch: str, collection: str, rels: list[str]) -> None:
    if not rels:
        return
    with open(project / ADD_LOG, "a", encoding="utf-8") as handle:
        for rel in rels:
            payload = {"batch": batch, "time": time.strftime("%Y-%m-%dT%H:%M:%S"),
                       "collection": collection, "path": rel}
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def read_add_log(project: Path) -> list[dict]:
    path = project / ADD_LOG
    if not path.exists():
        return []
    records: list[dict] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def undo_last_add(lib: Library) -> tuple[int, list[tuple[str, str]]]:
    """撤销上一次「加入合集」：只从 json 里摘掉记录，不动图片。"""
    records = read_add_log(lib.project)
    if not records:
        return 0, []
    batch = records[-1].get("batch")
    entries = [r for r in records if r.get("batch") == batch]
    removed = 0
    errors: list[tuple[str, str]] = []
    for entry in entries:
        name = str(entry.get("collection") or "")
        rel = str(entry.get("path") or "")
        if not name or not rel:
            continue
        try:
            removed += lib.remove(name, [rel])
        except Exception as error:  # noqa: BLE001
            errors.append((rel, f"{type(error).__name__}: {error}"))
    remaining = [r for r in records if r.get("batch") != batch]
    path = lib.project / ADD_LOG
    with open(path, "w", encoding="utf-8") as handle:
        for record in remaining:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return removed, errors


# --------------------------------------------------------------------------- #
#  配色与小工具
# --------------------------------------------------------------------------- #

BG = "#131519"
PANEL = "#1a1e25"
PANEL_2 = "#21262f"
BORDER = "#2c333d"
TEXT = "#e6edf3"
MUTED = "#8b95a3"
ACCENT = "#3b82f6"
ACCENT_DIM = "#1e3a5f"
OK_GREEN = "#6FBF4A"
WARN_ORANGE = "#E0913F"

CELL_W = 148
CELL_H = 176
THUMB = 128
FONT = "Microsoft YaHei UI"

SIDEBAR_W = 392
TAG_COLS = 6
CHIP_H = 26


def _hex_rgb(color: str) -> tuple[int, int, int]:
    color = color.lstrip("#")
    return int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)


def _rgb_hex(rgb) -> str:
    return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(value)))) for value in rgb)


def mix_color(color: str, base: str, ratio: float) -> str:
    """把 color 按比例混进 base：ratio=0 是 base，1 是 color。"""
    ratio = max(0.0, min(1.0, ratio))
    a, b = _hex_rgb(color), _hex_rgb(base)
    return _rgb_hex(tuple(b[i] + (a[i] - b[i]) * ratio for i in range(3)))


def color_luminance(color: str) -> float:
    def channel(value: float) -> float:
        value /= 255
        return value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4

    r, g, b = _hex_rgb(color)
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


DARK_TEXT = "#10131a"
LIGHT_TEXT = "#ffffff"


def contrast_ratio(lum_a: float, lum_b: float) -> float:
    high, low = max(lum_a, lum_b), min(lum_a, lum_b)
    return (high + 0.05) / (low + 0.05)


def tag_color(name: str) -> str:
    """原始标签用既定配色，自定义标签按名字哈希取一个稳定颜色。"""
    if name in EMOTION_COLOR:
        return EMOTION_COLOR[name]
    total = 0
    for char in name:
        total = (total * 131 + ord(char)) % 100000
    return CUSTOM_PALETTE[total % len(CUSTOM_PALETTE)]


def text_on_color(color: str) -> str:
    """亮色底用深字，暗色底用白字——按实际对比度选。"""
    background = color_luminance(color)
    dark_ratio = contrast_ratio(background, color_luminance(DARK_TEXT))
    light_ratio = contrast_ratio(background, color_luminance(LIGHT_TEXT))
    return DARK_TEXT if dark_ratio >= light_ratio else LIGHT_TEXT


def page_count(files: list) -> int:
    return max(1, (len(files) + PAGE_SIZE - 1) // PAGE_SIZE)


def page_range(files: list, page: int) -> tuple[int, int]:
    start = max(0, page) * PAGE_SIZE
    return start, min(len(files), start + PAGE_SIZE)


def enable_dpi_awareness():
    try:
        import ctypes

        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass


# --------------------------------------------------------------------------- #
#  界面
# --------------------------------------------------------------------------- #


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        enable_dpi_awareness()
        self.title(f"{APP_TITLE}  v{VERSION}")
        self.geometry("1360x900")
        self.minsize(1120, 720)
        self.configure(bg=BG)

        # ---- 状态 ----
        self.project: Path | None = None
        self.lib: Library | None = None
        self.images: list[Path] = []          # 工程目录里的全部图片
        self._existing: set[str] = set()      # 上面这些图片的相对路径（小写），进合集时免 stat
        self.current: str | None = None       # 已进入的合集名
        self.selected_collection: str | None = None
        self.files: list[Path] = []           # 当前视图里的全部图片（分页前的全集）
        self.selected: set[int] = set()       # 选中的是全集下标，翻页不丢
        self.page = 0                         # 当前页（0 起）
        self.page_var = tk.StringVar(value="1")

        self._bricks: dict[str, dict] = {}
        self._editor: dict | None = None      # 格内改备注时的输入框
        self._closing = False
        self._poll_id = None
        self.tag_var = tk.StringVar(value=EMOTIONS[0][0])
        self.tag_filter = tk.StringVar(value="")
        self.qq_on = tk.BooleanVar(value=False)
        self.qq_upload = tk.BooleanVar(value=False)
        self.qq_cfg = dict(QQ_DEFAULTS)
        self.qq_ready = False
        self.qq_faces = 0

        self._thumbs: dict[int, object] = {}
        self._pending: set[int] = set()
        self._tiles: dict[int, dict] = {}
        self._results: list[tuple] = []
        self._gen = 0
        self._busy = False
        self._cols = 1
        self._layout_width = 0
        self._anchor: int | None = None

        self._thumb_queue: queue.Queue = queue.Queue()
        self._thumb_lock = threading.Lock()
        self._workers = []
        for _ in range(2):
            worker = threading.Thread(target=self._thumb_worker, daemon=True)
            worker.start()
            self._workers.append(worker)

        self._build_style()
        self._build_ui()
        self._load_prefs()
        self.after(40, self._poll_thumbs)
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.bind("<Escape>", lambda _e: self.exit_collection())

    # ------------------------------------------------------------------ 外观
    def _build_style(self):
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("TFrame", background=BG)
        style.configure("TLabel", background=BG, foreground=TEXT, font=(FONT, 10))
        style.configure("TButton", font=(FONT, 9), padding=(10, 5))
        style.configure("Accent.TButton", font=(FONT, 10, "bold"), padding=(14, 7))
        style.configure("TCheckbutton", background=PANEL, foreground=TEXT, font=(FONT, 9))
        style.map("TCheckbutton", background=[("active", PANEL)])
        style.configure("Vertical.TScrollbar", background=PANEL_2, troughcolor=BG,
                        bordercolor=BG, arrowcolor=MUTED)
        style.configure("Horizontal.TProgressbar", thickness=6, background=ACCENT,
                        troughcolor=PANEL_2, bordercolor=PANEL, lightcolor=ACCENT,
                        darkcolor=ACCENT)
        style.configure("Treeview", background=PANEL, fieldbackground=PANEL, foreground=TEXT,
                        rowheight=24, font=(FONT, 9), borderwidth=0)
        style.map("Treeview", background=[("selected", ACCENT_DIM)],
                  foreground=[("selected", TEXT)])
        style.configure("Treeview.Heading", background=PANEL_2, foreground=MUTED,
                        font=(FONT, 8, "bold"), relief="flat")

    def _build_ui(self):
        self.grid_rowconfigure(1, weight=1)
        self.grid_columnconfigure(1, weight=1)
        self._build_header()
        self._build_sidebar()
        self._build_gallery()
        self._build_footer()

    # ------------------------------------------------------------------ 顶栏
    def _build_header(self):
        bar = tk.Frame(self, bg=PANEL, height=62)
        bar.grid(row=0, column=0, columnspan=2, sticky="ew")
        bar.grid_propagate(False)

        left = tk.Frame(bar, bg=PANEL)
        left.pack(side="left", padx=16)
        tk.Label(left, text=APP_TITLE, bg=PANEL, fg=TEXT,
                 font=(FONT, 13, "bold")).pack(anchor="w")
        self.lbl_path = tk.Label(left, text="还没有选择工程目录", bg=PANEL, fg=MUTED,
                                 font=(FONT, 8), anchor="w")
        self.lbl_path.pack(anchor="w")

        right = tk.Frame(bar, bg=PANEL)
        right.pack(side="right", padx=16)
        ttk.Button(right, text="选择工程目录", command=self.on_choose_dir).pack(side="right")

        self.lbl_mode = tk.Label(right, text="", bg=PANEL, fg=ACCENT, font=(FONT, 9, "bold"),
                                 width=24, anchor="e")
        self.lbl_mode.pack(side="right", padx=(0, 10))
        self.btn_exit = ttk.Button(right, text="← 退出合集", command=self.exit_collection,
                                   state="disabled")
        self.btn_exit.pack(side="right")

    # ------------------------------------------------------------------ 侧栏
    def _build_sidebar(self):
        panel = tk.Frame(self, bg=PANEL, width=SIDEBAR_W)
        panel.grid(row=1, column=0, sticky="ns")
        panel.grid_propagate(False)

        # ① 合集
        box = tk.Frame(panel, bg=PANEL)
        box.pack(fill="x", padx=12, pady=(10, 0))
        head = tk.Frame(box, bg=PANEL)
        head.pack(fill="x")
        tk.Label(head, text="① 合集", bg=PANEL, fg=TEXT,
                 font=(FONT, 10, "bold")).pack(side="left")
        tk.Label(head, text="双击进入", bg=PANEL, fg=MUTED,
                 font=(FONT, 8)).pack(side="right")

        list_wrap = tk.Frame(box, bg=PANEL_2, highlightthickness=1, highlightbackground=BORDER)
        list_wrap.pack(fill="x", pady=(5, 0))
        self.list_coll = tk.Listbox(
            list_wrap, height=5, bg=PANEL_2, fg=TEXT, font=(FONT, 9),
            selectbackground=ACCENT_DIM, selectforeground=TEXT,
            activestyle="none", highlightthickness=0, bd=0,
            exportselection=False, cursor="hand2")
        self.list_coll.pack(side="left", fill="both", expand=True, padx=(2, 0), pady=2)
        coll_bar = ttk.Scrollbar(list_wrap, orient="vertical", command=self.list_coll.yview)
        coll_bar.pack(side="right", fill="y")
        self.list_coll.configure(yscrollcommand=coll_bar.set)
        self.list_coll.bind("<<ListboxSelect>>", self._on_collection_pick)
        self.list_coll.bind("<Double-Button-1>", self._on_collection_open)

        row = tk.Frame(box, bg=PANEL)
        row.pack(fill="x", pady=(5, 0))
        ttk.Button(row, text="新建", command=self.on_new_collection).pack(side="left")
        ttk.Button(row, text="删除", command=self.on_delete_collection).pack(side="left", padx=5)
        ttk.Button(row, text="打开 json", command=self.on_open_meta).pack(side="left")
        self.lbl_coll_sel = tk.Label(box, text="未选中合集", bg=PANEL, fg=MUTED,
                                     font=(FONT, 8), anchor="w", wraplength=SIDEBAR_W - 40,
                                     justify="left")
        self.lbl_coll_sel.pack(fill="x", pady=(4, 0))

        # ② 标签
        tag_box = tk.Frame(panel, bg=PANEL)
        tag_box.pack(fill="both", expand=True, padx=12, pady=(10, 0))
        head2 = tk.Frame(tag_box, bg=PANEL)
        head2.pack(fill="x")
        tk.Label(head2, text="② 标签", bg=PANEL, fg=TEXT,
                 font=(FONT, 10, "bold")).pack(side="left")
        tk.Label(head2, text="合集名 = 标签名", bg=PANEL, fg=MUTED,
                 font=(FONT, 8)).pack(side="left", padx=(8, 0))

        self.entry_search = ttk.Entry(tag_box, textvariable=self.tag_filter)
        self.entry_search.pack(fill="x", pady=(5, 0))
        self.tag_filter.trace_add("write", lambda *_: self._render_tags())

        tag_bar_row = tk.Frame(tag_box, bg=PANEL)
        tag_bar_row.pack(fill="x", pady=(5, 0))
        ttk.Button(tag_bar_row, text="新建标签", command=self.on_new_tag).pack(side="left")
        ttk.Button(tag_bar_row, text="删除标签", command=self.on_delete_tag).pack(side="left", padx=5)
        self.lbl_tag_info = tk.Label(tag_bar_row, text="", bg=PANEL, fg=MUTED, font=(FONT, 8))
        self.lbl_tag_info.pack(side="left", padx=(4, 0))

        tag_wrap = tk.Frame(tag_box, bg=PANEL)
        tag_wrap.pack(fill="both", expand=True, pady=(5, 0))
        self.tag_canvas = tk.Canvas(tag_wrap, bg=PANEL, highlightthickness=0,
                                    width=SIDEBAR_W - 40)
        tag_bar = ttk.Scrollbar(tag_wrap, orient="vertical", command=self.tag_canvas.yview)
        self.tag_canvas.configure(yscrollcommand=tag_bar.set)
        self.tag_canvas.pack(side="left", fill="both", expand=True)
        tag_bar.pack(side="right", fill="y")
        self.tag_inner = tk.Frame(self.tag_canvas, bg=PANEL)
        self.tag_window = self.tag_canvas.create_window((0, 0), window=self.tag_inner, anchor="nw")
        self.tag_inner.bind("<Configure>", lambda e: self.tag_canvas.configure(
            scrollregion=self.tag_canvas.bbox("all")))
        self._tag_width = 0
        self.tag_canvas.bind("<Configure>", self._on_tag_canvas_resize)
        self.tag_canvas.bind("<MouseWheel>", self._on_tag_wheel)
        self.tag_inner.bind("<MouseWheel>", self._on_tag_wheel)
        self._render_tags()

        # ③ QQ
        qq_box = tk.Frame(panel, bg=PANEL)
        qq_box.pack(fill="x", padx=12, pady=(10, 10))
        tk.Label(qq_box, text="③ QQ 备注", bg=PANEL, fg=TEXT,
                 font=(FONT, 10, "bold")).pack(anchor="w")
        checks = tk.Frame(qq_box, bg=PANEL)
        checks.pack(fill="x", pady=(4, 0))
        ttk.Checkbutton(checks, text="同步备注", variable=self.qq_on,
                        command=self._on_qq_toggle).pack(side="left")
        ttk.Checkbutton(checks, text="未收藏的也上传", variable=self.qq_upload,
                        command=self._update_qq_label).pack(side="left", padx=(8, 0))
        row = tk.Frame(qq_box, bg=PANEL)
        row.pack(fill="x", pady=(4, 0))
        ttk.Button(row, text="连接设置", command=self.on_qq_settings).pack(side="left")
        ttk.Button(row, text="同步全部已归类",
                   command=self.on_sync_all_tagged).pack(side="left", padx=(6, 0))
        self.lbl_qq = tk.Label(row, text="未连接", bg=PANEL, fg=MUTED,
                               font=(FONT, 8), wraplength=250, justify="left")
        self.lbl_qq.pack(side="left", padx=(8, 0))

    # ------------------------------------------------------------------ 网格
    def _build_gallery(self):
        wrap = tk.Frame(self, bg=BG)
        wrap.grid(row=1, column=1, sticky="nsew", padx=(10, 12), pady=(10, 0))
        wrap.grid_rowconfigure(1, weight=1)
        wrap.grid_columnconfigure(0, weight=1)

        bar = tk.Frame(wrap, bg=PANEL, height=38)
        bar.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        bar.grid_propagate(False)
        self.lbl_count = tk.Label(bar, text="请选择工程目录", bg=PANEL, fg=MUTED,
                                  font=(FONT, 9))
        self.lbl_count.pack(side="left", padx=(12, 10))

        pager = tk.Frame(bar, bg=PANEL)
        pager.pack(side="left")
        self.btn_prev = ttk.Button(pager, text="◀", width=3, command=self.prev_page)
        self.btn_prev.pack(side="left")
        self.entry_page = ttk.Entry(pager, textvariable=self.page_var, width=4, justify="center")
        self.entry_page.pack(side="left", padx=3)
        self.entry_page.bind("<Return>", lambda _e: self.goto_page())
        self.lbl_pages = tk.Label(pager, text="/ 1 页", bg=PANEL, fg=MUTED, font=(FONT, 9))
        self.lbl_pages.pack(side="left")
        self.btn_next = ttk.Button(pager, text="▶", width=3, command=self.next_page)
        self.btn_next.pack(side="left", padx=(3, 0))

        ttk.Button(bar, text="刷新", command=self.on_rescan).pack(side="right", padx=(6, 12))
        ttk.Button(bar, text="清空", command=self.select_none).pack(side="right", padx=6)
        ttk.Button(bar, text="反选本页", command=self.select_invert).pack(side="right", padx=6)
        ttk.Button(bar, text="全选本页", command=self.select_all).pack(side="right", padx=6)

        holder = tk.Frame(wrap, bg=BG)
        holder.grid(row=1, column=0, sticky="nsew")
        holder.grid_rowconfigure(0, weight=1)
        holder.grid_columnconfigure(0, weight=1)

        self.canvas = tk.Canvas(holder, bg=BG, highlightthickness=0)
        self.bar_gallery = ttk.Scrollbar(holder, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=self._on_yview)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        self.bar_gallery.grid(row=0, column=1, sticky="ns")
        self.canvas.bind("<Configure>", self._on_canvas_resize)
        self.canvas.bind("<MouseWheel>", self._on_mousewheel)
        self.canvas.bind("<Button-1>", self._on_canvas_click)
        self.canvas.bind("<Motion>", self._on_canvas_motion)
        self.canvas.bind("<Double-Button-1>", self._on_canvas_double)
        self.canvas.bind("<Button-3>", self._on_canvas_menu)
        self.bind("<F2>", lambda e: self._edit_selected())

        self.empty_label = tk.Label(
            self.canvas, text="这里还没有图片\n\n选择工程目录后，目录里的图片都会列在这里。\n"
                              "选中它们再点「加入合集 →」打标签。",
            bg=BG, fg=MUTED, font=(FONT, 10), justify="center")

    # ------------------------------------------------------------------ 底栏
    def _build_footer(self):
        bar = tk.Frame(self, bg=PANEL, height=78)
        bar.grid(row=2, column=0, columnspan=2, sticky="ew")
        bar.grid_propagate(False)

        left = tk.Frame(bar, bg=PANEL)
        left.pack(side="left", padx=16, pady=8)
        self.lbl_status = tk.Label(left, text="双击图片加入合集 · 点图下方的说明可直接改备注",
                                   bg=PANEL, fg=MUTED, font=(FONT, 9), anchor="w")
        self.lbl_status.pack(anchor="w")
        self.progress = ttk.Progressbar(left, mode="determinate", length=420)
        self.progress.pack(anchor="w", pady=(6, 0))

        right = tk.Frame(bar, bg=PANEL)
        right.pack(side="right", padx=16)
        self.btn_add = ttk.Button(right, text="加入合集 →", style="Accent.TButton", width=13,
                                  command=self.on_add_to_collection)
        self.btn_add.pack(side="right", padx=(8, 0))
        self.btn_remove = ttk.Button(right, text="移出合集",
                                     command=self.on_remove_from_collection, state="disabled")
        self.btn_remove.pack(side="right", padx=(8, 0))
        self.btn_notes = ttk.Button(right, text="备注列表", command=self.on_open_notes)
        self.btn_notes.pack(side="right", padx=(8, 0))
        self.btn_qq = ttk.Button(right, text="同步 QQ 备注", command=self.on_sync_qq)
        self.btn_qq.pack(side="right", padx=(8, 0))
        self.btn_undo = ttk.Button(right, text="撤销加入", command=self.on_undo_add)
        self.btn_undo.pack(side="right")

    # ------------------------------------------------------------------ 标签
    def _on_tag_wheel(self, event):
        first, last = self.tag_canvas.yview()
        if first <= 0.0 and last >= 1.0:
            return "break"                      # 已经全露出来了，别抢事件
        self.tag_canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")
        return "break"

    def _scroll_tag_into_view(self, name: str):
        """选中靠下的标签时把它滚进视野，不然点合集名称也不知道选中了啥。"""
        brick = self._bricks.get(name)
        if not brick:
            return
        frame = brick["frame"]
        inner = self.tag_inner.winfo_reqheight()
        visible = self.tag_canvas.winfo_height()
        if inner <= visible:
            return
        top = self.tag_canvas.canvasy(0)
        y = frame.winfo_y()
        height = frame.winfo_height() or CHIP_H
        if top <= y and y + height <= top + visible:
            return
        self.tag_canvas.yview_moveto(max(0.0, (y - height) / inner))

    def _on_tag_canvas_resize(self, event):
        if abs(event.width - self._tag_width) < 2:
            return
        self._tag_width = event.width
        self.tag_canvas.itemconfigure(self.tag_window, width=event.width)

    def _tag_groups(self):
        """内置两组 + 自定义一组；json 里手写的陌生合集名也归到自定义。"""
        custom = list(self.lib.custom_tags) if self.lib else []
        known = {name.casefold() for name in BUILTIN_TAGS} | {name.casefold() for name in custom}
        extra = [name for name in (self.lib.collections if self.lib else [])
                 if name.casefold() not in known]
        groups = [("情绪", [name for name, _ in EMOTIONS]), ("梗", [name for name, _ in MEME_TAGS])]
        if custom or extra:
            groups.append(("自定义", custom + extra))
        return groups

    def _render_tags(self):
        """标签画成一格格彩色积木：等宽网格、整块填色、名字居中。

        只在标签增删/搜索过滤时整体重建；单纯换选中项走 _select_tag，
        只重画新旧两块，不然点一下闪一片。
        """
        if not hasattr(self, "_bricks"):
            self._bricks = {}
        self._bricks.clear()
        for child in self.tag_inner.winfo_children():
            child.destroy()
        for column in range(TAG_COLS):
            self.tag_inner.grid_columnconfigure(column, weight=1, uniform="chip")

        needle = self.tag_filter.get().strip()
        current = self.tag_var.get()
        all_names = [name for _title, names in self._tag_groups() for name in names]
        self.lbl_tag_info.configure(text=f"共 {len(all_names)} 个")
        row = 0
        for group_title, group in self._tag_groups():
            entries = [name for name in group if not needle or needle in name]
            if not entries:
                continue
            header = tk.Frame(self.tag_inner, bg=PANEL)
            header.grid(row=row, column=0, columnspan=TAG_COLS, sticky="ew", pady=(6, 3))
            tk.Label(header, text=f"{group_title} · {len(entries)}", bg=PANEL, fg=MUTED,
                     font=(FONT, 8, "bold"), anchor="w").pack(side="left", padx=2)
            tk.Frame(header, bg=BORDER, height=1).pack(side="left", fill="x",
                                                      expand=True, padx=(8, 2), pady=5)
            row += 1
            for index, name in enumerate(entries):
                self._make_brick(name, tag_color(name), row + index // TAG_COLS,
                                 index % TAG_COLS, active=(name == current))
            row += (len(entries) + TAG_COLS - 1) // TAG_COLS

    def _make_brick(self, name: str, color: str, row: int, col: int, active: bool):
        idle_bg = mix_color(color, PANEL_2, 0.26)
        hover_bg = mix_color(color, PANEL_2, 0.46)
        idle_border = mix_color(color, PANEL, 0.62)
        idle_fg = mix_color(TEXT, color, 0.22)
        active_fg = text_on_color(color)
        background = color if active else idle_bg

        brick = tk.Frame(self.tag_inner, bg=background, height=CHIP_H,
                         highlightbackground=idle_fg if active else idle_border,
                         highlightthickness=1, cursor="hand2")
        brick.grid(row=row, column=col, sticky="nsew", padx=2, pady=1)
        brick.grid_propagate(False)

        tk.Frame(brick, bg=mix_color(color, "#ffffff", 0.42), height=2).place(
            relx=0, rely=0, relwidth=1)
        label = tk.Label(brick, text=name, bg=background,
                         fg=active_fg if active else idle_fg,
                         font=(FONT, 8), cursor="hand2")
        label.place(relx=0.5, rely=0.55, anchor="center")

        state = {"active": active, "hover": False}

        def paint(is_active=None):
            if is_active is not None:
                state["active"] = is_active
            if state["active"]:
                background = color
            elif state["hover"]:
                background = hover_bg
            else:
                background = idle_bg
            brick.configure(bg=background,
                            highlightbackground=color if state["active"] else idle_border)
            label.configure(bg=background,
                            fg=active_fg if state["active"] else idle_fg)

        def on_enter(_event=None):
            state["hover"] = True
            paint()

        def on_leave(_event=None):
            state["hover"] = False
            paint()

        for widget in (brick, label):
            widget.bind("<Button-1>", lambda e, n=name: self._choose_tag(n))
            widget.bind("<Enter>", on_enter)
            widget.bind("<Leave>", on_leave)

        for widget in (brick, label):
            widget.bind("<MouseWheel>", self._on_tag_wheel)
        self._bricks[name] = {"paint": paint, "frame": brick}

    def _paint_tag(self, name: str, active: bool):
        brick = self._bricks.get(name)
        if brick:
            brick["paint"](active)

    def _select_tag(self, name: str):
        """切当前标签：只改两块积木的样子，不重建整个标签区。"""
        old = self.tag_var.get()
        if old == name:
            return
        self.tag_var.set(name)
        self._paint_tag(old, False)
        self._paint_tag(name, True)
        self._scroll_tag_into_view(name)
        self._update_coll_sel_label()

    def _choose_tag(self, name: str):
        self._select_tag(name)

    # ------------------------------------------------------------------ 合集
    def _refresh_collections(self, keep: str | None = None):
        names = self.lib.names() if self.lib else []
        keep_name = keep or self.selected_collection
        self.list_coll.delete(0, "end")
        for name in names:
            mark = "▶ " if self.current == name else "   "
            self.list_coll.insert("end", f"{mark}{name}   {self.lib.count(name)}")

        self.selected_collection = None
        for index, name in enumerate(names):
            if keep_name and name == keep_name:
                self.list_coll.selection_set(index)
                self.list_coll.see(index)
                self.selected_collection = name
                break
        self._update_coll_sel_label()
        self._update_mode_label()

    def _update_coll_sel_label(self):
        name = self._target_name()
        if name is None:
            self.lbl_coll_sel.configure(text="未选中合集（加入时可选新建）", fg=MUTED)
        else:
            total = self.lib.count(name) if self.lib else 0
            exists = bool(self.lib and name in self.lib.collections)
            note = f"{total} 张" if exists else "还没建合集，双击图片自动建"
            self.lbl_coll_sel.configure(text=f"目标：{name} · {note}", fg=TEXT)

    def _update_mode_label(self):
        """只改文字和可用状态。pack/pack_forget 会触发整个底栏重排（实测 300+ ms）。"""
        if self.current is not None:
            count = self.lib.count(self.current) if self.lib else 0
            shown = self.current if len(self.current) <= 10 else self.current[:9] + "…"
            self.lbl_mode.configure(text=f"🏷 {shown} · {count} 张")
            self.btn_exit.configure(state="normal")
            self.btn_remove.configure(state="normal")
        else:
            self.lbl_mode.configure(text="全部图片")
            self.btn_exit.configure(state="disabled")
            self.btn_remove.configure(state="disabled")

    def _target_name(self) -> str | None:
        """当前操作对象：进了合集就是它，否则侧栏选中的合集，再否则选中的标签。

        合集名只能是标签名，所以标签本身就是合法的目标。
        """
        return self.current or self.tag_var.get() or None

    def _on_collection_pick(self, _event=None):
        selection = self.list_coll.curselection()
        if not selection:
            self.selected_collection = None
        else:
            names = self.lib.names() if self.lib else []
            index = selection[0]
            if 0 <= index < len(names):
                self.selected_collection = names[index]
                self._select_tag(names[index])
        self._update_coll_sel_label()

    def _on_collection_open(self, _event=None):
        selection = self.list_coll.curselection()
        if not selection or not self.lib:
            return
        names = self.lib.names()
        index = selection[0]
        if 0 <= index < len(names):
            self.enter_collection(names[index])

    def enter_collection(self, name: str):
        self.current = name
        self.selected_collection = name
        self._select_tag(name)
        self._apply_view()

    def exit_collection(self):
        if self.current is None:
            return
        self.current = None
        self._apply_view()

    def on_new_collection(self):
        if not self.lib:
            messagebox.showinfo(APP_TITLE, "请先选择工程目录。")
            return
        name = self.tag_var.get()
        if not name:
            messagebox.showinfo(APP_TITLE, "先在侧栏选一个标签，合集名就是它。")
            return
        if name in self.lib.collections:
            messagebox.showinfo(APP_TITLE, f"合集「{name}」已经存在（合集名只能是标签名）")
            self._refresh_collections(keep=name)
            return
        self.lib.create(name)
        self._refresh_collections(keep=name)
        self._update_status(f"已为标签「{name}」建合集，双击图片就能加进去", OK_GREEN)

    def on_new_tag(self):
        if not self.lib:
            messagebox.showinfo(APP_TITLE, "请先选择工程目录。")
            return
        name = simpledialog.askstring(
            "新建标签", "标签名（会成为合集名，不能和已有标签重名）：", parent=self)
        if not name:
            return
        try:
            created = self.lib.add_tag(name)
        except ValueError as error:
            messagebox.showwarning(APP_TITLE, str(error))
            return
        self.tag_var.set(created)
        self._render_tags()
        self.selected_collection = None
        self._refresh_collections()
        self.list_coll.selection_clear(0, "end")
        self._update_coll_sel_label()
        self._update_status(f"已新建标签「{created}」，双击图片就能直接加", OK_GREEN)

    def on_delete_tag(self):
        if not self.lib:
            return
        name = self.tag_var.get()
        if not name:
            return
        if self.lib.is_builtin(name):
            messagebox.showwarning(
                "原始标签",
                f"「{name}」是原始标签，不能删除。\n\n只能删自己新建的标签。")
            return
        if name not in self.lib.custom_tags:
            messagebox.showinfo(APP_TITLE, f"「{name}」不是自定义标签。")
            return
        count = self.lib.count(name)
        if not messagebox.askokcancel(
            "删除标签",
            f"删除自定义标签「{name}」？\n\n"
            f"它的合集（{count} 条记录）会一起删掉，\n"
            "图片文件不会被删除，也不会移动。",
        ):
            return
        self.lib.remove_tag(name)
        if self.current == name:
            self.current = None
        if self.selected_collection == name:
            self.selected_collection = None
        self.tag_var.set(BUILTIN_TAGS[0])
        self._render_tags()
        self._refresh_collections()
        self.on_rescan()
        self._update_status(f"已删除标签「{name}」", OK_GREEN)

    def on_delete_collection(self):
        name = self._target_name()
        if not name or not self.lib:
            messagebox.showinfo(APP_TITLE, "先在侧栏选中一个合集。")
            return
        if name not in self.lib.collections:
            messagebox.showinfo(APP_TITLE, f"标签「{name}」还没有合集，没什么可删。")
            return
        count = self.lib.count(name)
        if not messagebox.askokcancel(
            "删除合集",
            f"删除合集「{name}」？\n\n"
            f"只是从 _合集.json 里删掉这个分组（{count} 条记录），\n"
            "图片文件不会被删除，也不会移动。",
        ):
            return
        self.lib.delete(name)
        if self.current == name:
            self.current = None
        self.selected_collection = None
        self._refresh_collections()
        self.on_rescan()
        self._update_status(f"已删除合集「{name}」（图片都还在）")

    def on_open_meta(self):
        if not self.project:
            return
        target = self.project / META_FILE
        if not target.exists():
            messagebox.showinfo(APP_TITLE, "还没有 _合集.json，先建一个合集吧。")
            return
        try:
            os.startfile(str(target))
        except Exception as error:  # noqa: BLE001
            messagebox.showerror(APP_TITLE, f"打不开：{error}")

    # ------------------------------------------------------------------ 目录
    def on_choose_dir(self):
        chosen = filedialog.askdirectory(title="选择工程目录（图片所在的根文件夹）")
        if not chosen:
            return
        self.project = Path(chosen)
        self.lib = Library(self.project)
        self.current = None
        self.selected_collection = None
        self.lbl_path.configure(text=str(self.project))
        self._save_prefs()
        self._refresh_collections()
        self.on_rescan()

    def on_rescan(self):
        if self._busy or not self.project:
            self._files_update([])
            return
        if self.lib is None:
            self.lib = Library(self.project)
        try:
            self.images = scan_images(self.project)
            self._existing = {to_rel(self.project, p).casefold() for p in self.images}
        except Exception as error:  # noqa: BLE001
            messagebox.showerror(APP_TITLE, f"读取目录失败：{error}")
            return
        self._apply_view()

    def _apply_view(self):
        """只切换网格显示的内容，不碰磁盘（进/退合集走这里）。"""
        if not self.lib:
            return
        if self.current is not None:
            existing = getattr(self, "_existing", None)
            rels = self.lib.rels_of(self.current)
            if existing is None:
                files = self.lib.paths_of(self.current)
            else:
                files = [self.project / rel for rel in rels if rel.casefold() in existing]
        else:
            files = list(self.images)
        self._files_update(files)
        self._refresh_collections()
        self._update_mode_label()

    def _files_update(self, files: list[Path]):
        self.files = files
        self._tagged_in_view = 0
        if self.current is None and self.lib and self.project:
            index = self.lib._reverse_index()
            self._tagged_in_view = sum(
                1 for path in files if to_rel(self.project, path).casefold() in index)
        self.selected.clear()
        self._anchor = None
        self._gen += 1
        self._thumbs.clear()
        self._pending.clear()
        self._reset_gallery()
        self._update_count()
        self._update_coll_sel_label()

    # ------------------------------------------------------------------ 分页
    def _page_count(self) -> int:
        return page_count(self.files)

    def _page_range(self) -> tuple[int, int]:
        return page_range(self.files, self.page)

    def prev_page(self):
        self.set_page(self.page - 1)

    def next_page(self):
        self.set_page(self.page + 1)

    def goto_page(self):
        try:
            wanted = int(self.page_var.get().strip() or "1")
        except ValueError:
            wanted = self.page + 1
        self.set_page(wanted - 1)

    def set_page(self, page: int):
        self._commit_note_edit()
        total = self._page_count()
        page = max(0, min(total - 1, page))
        if page == self.page:
            self._sync_pager()
            return
        self.page = page
        self._render_page()
        self._update_count()

    def _sync_pager(self):
        total = self._page_count()
        self.page = max(0, min(total - 1, self.page))
        self.page_var.set(str(self.page + 1))
        self.lbl_pages.configure(text=f"/ {total} 页")
        self.btn_prev.configure(state="normal" if self.page > 0 else "disabled")
        self.btn_next.configure(state="normal" if self.page < total - 1 else "disabled")

    # ------------------------------------------------------------------ 网格渲染
    # 每格都是画布图形项（矩形+图+两行字），不是 widget。翻页/滚动只增删可见行。
    def _reset_gallery(self):
        self.page = 0
        self._render_page()

    def _on_canvas_resize(self, event):
        if abs(event.width - self._layout_width) < 4:
            return
        self._layout_width = event.width
        if self.files:
            self._render_page()

    def _page_rows(self) -> int:
        start, end = self._page_range()
        return max(1, (end - start + max(1, self._cols) - 1) // max(1, self._cols))

    def _render_page(self):
        self._commit_note_edit()
        for index in list(self._tiles):
            self._drop_tile(index)
        self.canvas.delete("tile")
        self.empty_label.place_forget()
        self._sync_pager()

        if not self.files:
            self.canvas.configure(scrollregion=(0, 0, 0, 0))
            self.canvas.yview_moveto(0)
            self.empty_label.place(relx=0.5, rely=0.4, anchor="center")
            return

        width = max(self.canvas.winfo_width(), CELL_W)
        self._cols = max(1, width // CELL_W)
        rows = self._page_rows()
        self.canvas.configure(scrollregion=(0, 0, self._cols * CELL_W, rows * CELL_H))
        self.canvas.yview_moveto(0)
        self._refresh_visible()

    def _row_window(self) -> tuple[int, int]:
        """当前可视到第几行（含上下各一行缓冲）。"""
        top = self.canvas.canvasy(0)
        height = max(self.canvas.winfo_height(), CELL_H)
        first = max(0, int(top // CELL_H) - 1)
        last = int((top + height) // CELL_H) + 1
        return first, min(last, self._page_rows() - 1)

    def _refresh_visible(self):
        if not self.files:
            return
        start, end = self._page_range()
        first_row, last_row = self._row_window()
        low = start + first_row * self._cols
        high = min(end - 1, start + (last_row + 1) * self._cols - 1)
        for index in list(self._tiles):
            if index < low or index > high:
                self._drop_tile(index)
        for index in range(low, high + 1):
            if index not in self._tiles:
                self._create_tile(index)
        self._evict_thumbs()

    def _caption_for(self, path: Path) -> str:
        rel = to_rel(self.project, path) if self.project else path.name
        caption = path.name
        if self.lib:
            tags = self.lib.tags_of(rel)
            if tags:
                caption = f"[{REMARK_SEP.join(tags)}] {path.name}"
            if self.lib.is_manual(rel):
                caption = "✎ " + caption
        return caption

    def _create_tile(self, index: int):
        start, _end = self._page_range()
        row, col = divmod(index - start, self._cols)
        x = col * CELL_W
        y = row * CELL_H
        pad = 6
        selected = index in self.selected
        frame_fill = PANEL_2 if selected else PANEL
        outline = ACCENT if selected else BORDER

        rect = self.canvas.create_rectangle(
            x + pad, y + pad, x + CELL_W - pad, y + CELL_H - pad,
            fill=frame_fill, outline=outline, width=2, tags=("tile",))
        holder = self.canvas.create_text(
            x + CELL_W / 2, y + pad + THUMB / 2 + 4, text="…",
            fill=MUTED, font=(FONT, 8), tags=("tile",))
        bx, by = x + CELL_W - pad - 20, y + pad + 3
        badge = self.canvas.create_rectangle(
            bx, by, bx + 18, by + 14, fill=PANEL_2, outline="", tags=("tile",))
        badge_txt = self.canvas.create_text(
            bx + 9, by + 7, text="✎", fill=MUTED, font=(FONT, 8), tags=("tile",))
        text_item = self.canvas.create_text(
            x + CELL_W / 2, y + pad + THUMB + 10,
            text=self._caption_for(self.files[index]),
            fill=TEXT if selected else "#c3cbd6",
            font=(FONT, 7, "bold" if selected else "normal"),
            width=CELL_W - 18, anchor="n", justify="center", tags=("tile",))
        self._tiles[index] = {"rect": rect, "img": holder, "text": text_item,
                              "badge": badge, "badge_txt": badge_txt,
                              "img_xy": (x + CELL_W / 2, y + pad + THUMB / 2 + 4)}

        thumb = self._thumbs.get(index)
        if thumb is not None:
            self._show_thumb(index, thumb)
        else:
            self._request_thumb(index)

    def _show_thumb(self, index: int, photo):
        """把占位文字换成真正的图像项（文本项没有 -image 选项）。"""
        tile = self._tiles.get(index)
        if not tile:
            return
        x, y = tile["img_xy"]
        self.canvas.delete(tile["img"])
        tile["img"] = self.canvas.create_image(x, y, image=photo, tags=("tile",))

    def _drop_tile(self, index: int):
        tile = self._tiles.pop(index, None)
        if tile:
            for key in ("rect", "img", "text"):
                self.canvas.delete(tile[key])

    def _refresh_tile(self, index: int):
        """只改这一格的外观，不重建（保留滚动位置）。"""
        tile = self._tiles.get(index)
        if not tile:
            return
        selected = index in self.selected
        self.canvas.itemconfigure(
            tile["rect"], fill=PANEL_2 if selected else PANEL,
            outline=ACCENT if selected else BORDER)
        self.canvas.itemconfigure(
            tile["text"], text=self._caption_for(self.files[index]),
            fill=TEXT if selected else "#c3cbd6",
            font=(FONT, 7, "bold" if selected else "normal"))
        rel = to_rel(self.project, self.files[index]) if self.project else ""
        has_note = bool(self.lib and self.lib.is_manual(rel))
        if "badge" in tile:
            self.canvas.itemconfigure(
                tile["badge"], fill=ACCENT_DIM if has_note else PANEL_2)
            self.canvas.itemconfigure(
                tile["badge_txt"], fill=ACCENT if has_note else "#6b7684")

    # ------------------------------------------------------------------ 命中
    def _index_at(self, event) -> int | None:
        """由鼠标坐标反推是第几张（画布项没有独立 widget，只能算）。"""
        x = self.canvas.canvasx(event.x)
        y = self.canvas.canvasy(event.y)
        col = int(x // CELL_W)
        row = int(y // CELL_H)
        if not (0 <= col < self._cols):
            return None
        start, end = self._page_range()
        index = start + row * self._cols + col
        return index if start <= index < end else None

    def _badge_hit(self, event, index: int) -> bool:
        """点在格子右上角那个笔上了吗。"""
        start, _end = self._page_range()
        row, col = divmod(index - start, self._cols)
        bx = col * CELL_W + CELL_W - 6 - 20
        by = row * CELL_H + 6 + 3
        x = self.canvas.canvasx(event.x)
        y = self.canvas.canvasy(event.y)
        return bx - 3 <= x <= bx + 21 and by - 3 <= y <= by + 17

    def _caption_hit(self, event, index: int) -> bool:
        """点在缩略图下面那行说明上了吗（那块能直接改备注）。"""
        start, _end = self._page_range()
        row, col = divmod(index - start, self._cols)
        x = self.canvas.canvasx(event.x)
        y = self.canvas.canvasy(event.y)
        left = col * CELL_W + 6
        return (left <= x <= left + CELL_W - 12
                and row * CELL_H + 6 + THUMB + 2 <= y <= row * CELL_H + CELL_H - 4)

    def _begin_note_edit(self, index: int):
        """在格子里放一个输入框改手写备注，回车/失去焦点保存。"""
        self._commit_note_edit()
        if not (self.lib and self.project) or not (0 <= index < len(self.files)):
            return
        rel = to_rel(self.project, self.files[index])
        start, _end = self._page_range()
        row, col = divmod(index - start, self._cols)
        entry = tk.Entry(self.canvas, bg="#0d1117", fg=TEXT, insertbackground=TEXT,
                         relief="flat", font=(FONT, 8), highlightthickness=1,
                         highlightbackground=ACCENT, highlightcolor=ACCENT)
        entry.insert(0, (self.lib.notes.get(rel) or ""))
        entry.icursor("end")
        entry.xview_moveto(1.0)
        window = self.canvas.create_window(
            col * CELL_W + 8, row * CELL_H + 6 + THUMB + 8, anchor="nw",
            window=entry, width=CELL_W - 16, height=22, tags=("inline",))
        self._editor = {"index": index, "rel": rel, "entry": entry, "window": window}
        tile = self._tiles.get(index)
        if tile:
            self.canvas.itemconfigure(tile["text"], state="hidden")
        entry.bind("<Return>", lambda e: self._commit_note_edit())
        entry.bind("<KP_Enter>", lambda e: self._commit_note_edit())
        entry.bind("<Escape>", lambda e: self._cancel_note_edit())
        entry.bind("<FocusOut>", self._on_editor_focusout)
        self._update_status("改备注：回车或点别处保存 · Esc 取消 · 清空即删除", ACCENT)
        entry.focus_set()

    def _close_editor(self):
        editor, self._editor = self._editor, None
        if not editor:
            return None
        try:
            self.canvas.delete(editor["window"])
        except tk.TclError:
            pass
        try:
            editor["entry"].destroy()
        except tk.TclError:
            pass
        tile = self._tiles.get(editor["index"])
        if tile:
            try:
                self.canvas.itemconfigure(tile["text"], state="normal")
            except tk.TclError:
                pass
        return editor

    def _on_editor_focusout(self, _event=None):
        """推迟一点再判断：窗口刚被点激活时焦点会抖一下，直接存会秒关。"""
        if self._editor:
            self.after(200, self._commit_if_really_unfocused)

    def _commit_if_really_unfocused(self):
        editor = self._editor
        if not editor:
            return
        try:
            focused = self.focus_get()
        except Exception:  # noqa: BLE001
            focused = None
        if focused is editor["entry"]:
            return                      # 焦点回来了，继续编辑
        self._commit_note_edit()

    def _commit_note_edit(self):
        """失去焦点也保留内容：FocusOut 就写回 json。"""
        editor = self._editor
        if not editor:
            return
        text = editor["entry"].get()
        editor = self._close_editor()
        if editor is None:
            return
        if self.lib and self.project:
            old = (self.lib.notes.get(editor["rel"]) or "")
            if text.strip() != old.strip():
                self.lib.set_note(editor["rel"], text)
                self._update_status(f"备注已保存：{editor['rel']}", TEXT)
        self._refresh_tile(editor["index"])

    def _cancel_note_edit(self):
        editor = self._close_editor()
        if editor:
            self._refresh_tile(editor["index"])

    def _on_canvas_motion(self, event):
        index = self._index_at(event)
        want = ""
        if index is not None and (self._badge_hit(event, index)
                                  or self._caption_hit(event, index)):
            want = "hand2"
        if self.canvas.cget("cursor") != want:
            self.canvas.configure(cursor=want)

    def _edit_selected(self):
        """F2：改当前选中第一张的备注。"""
        if not self.selected:
            return
        index = min(self.selected)
        self.set_page(index // PAGE_SIZE)
        start, _end = self._page_range()
        row = (index - start) // self._cols
        rows = self._page_rows()
        if rows:
            self.canvas.yview_moveto(max(0.0, (row - 1) * CELL_H / (rows * CELL_H)))
            self._refresh_visible()
        self._begin_note_edit(index)

    def _on_canvas_click(self, event):
        if self._editor:
            self._commit_note_edit()
        index = self._index_at(event)
        if index is None:
            return
        self._on_tile_click(index, event)
        if self._badge_hit(event, index) or self._caption_hit(event, index):
            self._begin_note_edit(index)

    def _on_canvas_double(self, event):
        index = self._index_at(event)
        if index is None or self._caption_hit(event, index):
            return                           # 说明那行留给改备注，别当成双击加合集
        self._on_tile_double(index)

    def _on_canvas_menu(self, event):
        index = self._index_at(event)
        if index is not None:
            self._on_tile_menu(index, event)

    def _request_thumb(self, index: int):
        if index in self._pending or index in self._thumbs or not HAS_PIL:
            return
        self._pending.add(index)
        self._thumb_queue.put((self._gen, index, str(self.files[index])))

    def _thumb_worker(self):
        while True:
            item = self._thumb_queue.get()
            if item is None:
                return
            gen, index, path = item
            image = None
            if HAS_PIL:
                try:
                    with Image.open(path) as src:
                        src.thumbnail((THUMB, THUMB), Image.LANCZOS)
                        if src.mode not in ("RGB", "RGBA"):
                            src = src.convert("RGBA")
                        image = src.copy()
                except Exception:
                    image = None
            with self._thumb_lock:
                self._results.append((gen, index, image))

    def _poll_thumbs(self):
        if self._closing:
            return
        batch = []
        with self._thumb_lock:
            if self._results:
                batch, self._results = self._results, []
        for gen, index, image in batch:
            if gen != self._gen:
                continue
            self._pending.discard(index)
            tile = self._tiles.get(index)
            if image is None:
                if tile:
                    self.canvas.itemconfigure(tile["img"], text="无法预览")
                continue
            try:
                photo = ImageTk.PhotoImage(image, master=self)
            except Exception:
                continue
            self._thumbs[index] = photo
            if tile:
                self._show_thumb(index, photo)
            if len(self._thumbs) > PAGE_SIZE * 3:
                self._evict_thumbs()
        try:
            self._poll_id = self.after(40, self._poll_thumbs)
        except tk.TclError:
            pass

    def _evict_thumbs(self):
        if not self._thumbs:
            return
        keep_from = (self.page - 1) * PAGE_SIZE
        keep_to = (self.page + 2) * PAGE_SIZE
        for index in list(self._thumbs.keys()):
            if index < keep_from or index >= keep_to:
                self._thumbs.pop(index, None)

    # ------------------------------------------------------------------ 交互
    def _on_tile_click(self, index: int, event):
        if event.state & 0x0001:  # Shift = 范围选
            if self._anchor is not None and self.files:
                lo, hi = sorted((self._anchor, index))
                for i in range(lo, hi + 1):
                    self.selected.add(i)
                self._anchor = index
                self._after_selection()
                return
        if index in self.selected:
            self.selected.discard(index)
        else:
            self.selected.add(index)
        self._anchor = index
        self._after_selection()

    def _sync_tiles(self):
        for index in list(self._tiles):
            self._refresh_tile(index)

    def _on_yview(self, *args):
        self._commit_note_edit()
        self.bar_gallery.set(*args)
        self._refresh_scheduled()

    def _refresh_scheduled(self):
        """合并同一帧里的多次滚动，避免每个事件都重算。"""
        if getattr(self, "_refresh_pending", False):
            return
        self._refresh_pending = True

        def run():
            self._refresh_pending = False
            self._refresh_visible()

        self.after_idle(run)

    def _on_mousewheel(self, event):
        if self.files:
            self.canvas.yview_scroll(int(-event.delta / 120), "units")

    def _on_tile_double(self, index: int):
        """双击 = 直接把这图加进当前标签的合集。"""
        self._quick_add(index)

    def _quick_add(self, index: int):
        if self._busy or not self.lib or not self.project:
            return
        name = self._target_name()
        if not name:
            messagebox.showinfo(APP_TITLE, "先在侧栏选一个标签。")
            return
        path = self.files[index]
        rel = to_rel(self.project, path)
        if name not in self.lib.collections:
            self.lib.create(name)          # 合集名只能是标签名，所以直接建
        if name in self.lib.tags_of(rel):
            self._update_status(f"「{path.name}」已经在「{name}」里了", WARN_ORANGE)
            return
        self.lib.add(name, [rel])
        log_added(self.project, time.strftime("%Y%m%d-%H%M%S"), name, [rel])
        self._refresh_tile(index)
        self._refresh_collections(keep=self.current or name)
        self._update_status(f"双击加入：「{path.name}」→「{name}」", OK_GREEN)

    def _quick_remove(self, index: int):
        if not self.lib or self.current is None:
            return
        rel = to_rel(self.project, self.files[index])
        if self.lib.remove(self.current, [rel]):
            self._update_status(f"已从「{self.current}」移出", OK_GREEN)
            self.on_rescan()

    def _on_tile_menu(self, index: int, event):
        name = self._target_name() or ""
        menu = tk.Menu(self, tearoff=0, bg=PANEL, fg=TEXT,
                       activebackground=ACCENT_DIM, activeforeground=TEXT, bd=0)
        menu.add_command(label="预览大图", command=lambda: self._open_preview(index))
        if name:
            menu.add_command(label=f"加入「{name}」", command=lambda: self._quick_add(index))
        if self.current is not None:
            menu.add_command(label=f"从「{self.current}」移出",
                             command=lambda: self._quick_remove(index))
        menu.add_separator()
        menu.add_command(label="改备注（格内直接编辑）",
                         command=lambda: self._begin_note_edit(index))
        menu.add_command(label="复制文件名",
                         command=lambda: self._copy_name(index))
        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()

    def _copy_name(self, index: int):
        self.clipboard_clear()
        self.clipboard_append(self.files[index].name)
        self._update_status(f"已复制 {self.files[index].name}", OK_GREEN)

    def select_all(self):
        start, end = self._page_range()
        self.selected |= set(range(start, end))
        self._after_selection()

    def select_none(self):
        self.selected.clear()
        self._after_selection()

    def select_invert(self):
        start, end = self._page_range()
        current = set(range(start, end))
        self.selected = (self.selected - current) | (current - self.selected)
        self._after_selection()

    def _after_selection(self):
        self._sync_tiles()
        self._update_count()

    def _update_count(self):
        picked = len(self.selected)
        if not self.project:
            text = "请选择工程目录"
        elif self.current is not None:
            text = (f"合集「{self.current}」· {len(self.files)} 张 · "
                    f"第 {self.page + 1}/{self._page_count()} 页 · 已选 {picked} 张")
        else:
            tagged = getattr(self, "_tagged_in_view", 0)
            text = (f"全部 {len(self.files)} 张（已归类 {tagged}）· "
                    f"第 {self.page + 1}/{self._page_count()} 页 · 已选 {picked} 张")
        self.lbl_count.configure(text=text)

    def _update_status(self, text: str, color: str = MUTED):
        self.lbl_status.configure(text=text, fg=color)

    def _on_progress(self, done: int, total: int):
        self.progress.configure(maximum=max(1, total), value=done)
        self._update_status(f"正在处理 {done}/{total} …")

    def _ui(self, func, *args):
        """工作线程里回到主线程执行；窗口已经关掉时静默放弃，不要炸线程。"""
        try:
            self.after(0, lambda: func(*args))
        except Exception:  # noqa: BLE001 - 关窗/退出时属正常情况
            pass

    # ------------------------------------------------------------------ 加入 / 移出 / 撤销
    def _picked_rels(self) -> list[str]:
        return [to_rel(self.project, self.files[i]) for i in sorted(self.selected)]

    def on_add_to_collection(self):
        if self._busy:
            return
        if not self.project or not self.lib:
            messagebox.showinfo(APP_TITLE, "请先选择工程目录。")
            return
        if not self.selected:
            messagebox.showinfo(APP_TITLE, "先在网格里选中图片（单击选中，Shift 连选）。")
            return

        name = self._target_name()
        if name is None:
            messagebox.showinfo(APP_TITLE, "先在侧栏选一个标签（双击图片也能直接加）。")
            return
        if name not in self.lib.collections:
            try:
                self.lib.create(name)
            except ValueError as error:
                messagebox.showwarning(APP_TITLE, str(error))
                return

        rels = self._picked_rels()
        already = [rel for rel in rels if name in self.lib.tags_of(rel)]
        fresh = [rel for rel in rels if rel not in already]
        if not fresh:
            messagebox.showinfo(APP_TITLE,
                                f"选中的图已经都在合集「{name}」里了。\n"
                                "一张图可以属于多个合集，要加别的标签就选别的合集。")
            return

        if not messagebox.askokcancel(
            "加入合集",
            f"把 {len(fresh)} 张图归到合集「{name}」？\n\n"
            "只往 _合集.json 里记一笔，不复制、不移动、不改名任何文件。\n"
            + (f"（另有 {len(already)} 张本来就在这个合集里，会跳过）\n" if already else "")
            + f"这 {len(fresh)} 张的备注会变成「{name}」，"
              "如果它们还有别的标签，备注会把标签合起来。",
        ):
            return

        batch = time.strftime("%Y%m%d-%H%M%S")
        added = self.lib.add(name, fresh)
        log_added(self.project, batch, name, fresh)
        self._refresh_collections(keep=name)
        self.on_rescan()
        self._update_status(f"已加入「{name}」{added} 张", OK_GREEN)

    def on_remove_from_collection(self):
        if self._busy or not self.lib:
            return
        if self.current is None:
            messagebox.showinfo(APP_TITLE, "先双击进入一个合集，再选图移出。")
            return
        if not self.selected:
            messagebox.showinfo(APP_TITLE, "先在网格里选中要移出的图片。")
            return
        rels = self._picked_rels()
        if not messagebox.askokcancel(
            "移出合集",
            f"把选中的 {len(rels)} 张从合集「{self.current}」里移出？\n\n"
            "只删 json 里的记录，图片文件不会动。",
        ):
            return
        removed = self.lib.remove(self.current, rels)
        self.on_rescan()
        self._update_status(f"已从「{self.current}」移出 {removed} 张", OK_GREEN)

    def on_undo_add(self):
        if self._busy or not self.lib:
            return
        if not read_add_log(self.project):
            messagebox.showinfo(APP_TITLE, "没有可以撤销的「加入」记录。")
            return
        if not messagebox.askokcancel("撤销加入",
                                      "撤销上一次「加入合集」？\n\n只从 json 里摘掉那批记录。"):
            return
        removed, errors = undo_last_add(self.lib)
        self._refresh_collections(keep=self.current)
        self.on_rescan()
        self._update_status(f"已撤销：摘掉 {removed} 条记录", OK_GREEN)
        if errors:
            detail = "\n".join(f"• {n}: {r}" for n, r in errors[:8])
            messagebox.showwarning("部分失败", detail)

    # ------------------------------------------------------------------ 备注
    def on_open_notes(self):
        if not self.lib:
            messagebox.showinfo(APP_TITLE, "请先选择工程目录。")
            return
        rels = self.lib.tagged()

        win = tk.Toplevel(self)
        win.title(f"备注列表 · {len(rels)} 张")
        win.configure(bg=BG)
        win.geometry("940x620")
        win.transient(self)

        head = tk.Frame(win, bg=PANEL)
        head.pack(fill="x", padx=14, pady=(12, 8))
        tk.Label(head, text="所有归过类的图片。手写备注是补充：会接在标签后面，不覆盖标签。",
                 bg=PANEL, fg=TEXT, font=(FONT, 9)).pack(anchor="w")
        tk.Label(head, text="直接点「手写补充」那一格就能改；也可以选中一行在下面改。",
                 bg=PANEL, fg=MUTED, font=(FONT, 8)).pack(anchor="w", pady=(2, 6))
        search = tk.Frame(head, bg=PANEL)
        search.pack(fill="x")
        tk.Label(search, text="筛选", bg=PANEL, fg=MUTED, font=(FONT, 8)).pack(side="left")
        var_filter = tk.StringVar(value="")
        ttk.Entry(search, textvariable=var_filter).pack(side="left", fill="x", expand=True,
                                                        padx=(6, 0))

        body = tk.Frame(win, bg=BG)
        body.pack(fill="both", expand=True, padx=14, pady=(0, 8))
        body.grid_rowconfigure(0, weight=1)
        body.grid_columnconfigure(0, weight=1)

        tree = ttk.Treeview(body, columns=("tags", "note"), selectmode="browse")
        tree.heading("#0", text="图片")
        tree.heading("tags", text="标签（自动合并）")
        tree.heading("note", text="手写补充")
        tree.column("#0", width=420, anchor="w")
        tree.column("tags", width=230, anchor="w")
        tree.column("note", width=220, anchor="w")
        tree.grid(row=0, column=0, sticky="nsew")
        bar = ttk.Scrollbar(body, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=bar.set)
        bar.grid(row=0, column=1, sticky="ns")
        tree.tag_configure("manual", foreground=OK_GREEN)

        bottom = tk.Frame(win, bg=BG)
        bottom.pack(fill="x", padx=14, pady=(0, 12))
        tk.Label(bottom, text="备注", bg=BG, fg=MUTED, font=(FONT, 9)).pack(side="left")
        var_note = tk.StringVar(value="")
        entry = ttk.Entry(bottom, textvariable=var_note)
        entry.pack(side="left", fill="x", expand=True, padx=(8, 8))
        var_hint = tk.Label(bottom, text="", bg=BG, fg=MUTED, font=(FONT, 8))

        state = {"rel": None}

        def fill_tree():
            tree.delete(*tree.get_children())
            needle = var_filter.get().strip().lower()
            shown = 0
            for rel in rels:
                tags = self.lib.tags_of(rel)
                merged = REMARK_SEP.join(tags)
                note = self.lib.notes.get(rel, "")
                if needle and needle not in rel.lower() and needle not in merged.lower() \
                        and needle not in note.lower():
                    continue
                tree.insert("", "end", iid=rel, text=rel, values=(merged, note),
                            tags=("manual",) if note else ())
                shown += 1
            win.title(f"备注列表 · {shown}/{len(rels)} 张")

        def on_select(_event=None):
            picked = tree.selection()
            if not picked:
                state["rel"] = None
                return
            rel = picked[0]
            state["rel"] = rel
            var_note.set(self.lib.notes.get(rel, ""))
            merged = REMARK_SEP.join(self.lib.tags_of(rel)) or "（无标签）"
            var_hint.configure(text=f"留空 → {merged}   填写 → {merged}{REMARK_JOIN}你写的")

        def save_note(_event=None):
            rel = state["rel"]
            if not rel:
                messagebox.showinfo(APP_TITLE, "先选中一行。", parent=win)
                return
            self.lib.set_note(rel, var_note.get())
            fill_tree()
            if tree.exists(rel):
                tree.selection_set(rel)
                tree.see(rel)
            on_select()
            self.on_rescan()
            self._update_status("备注已保存", OK_GREEN)

        def clear_note():
            var_note.set("")
            save_note()

        def edit_cell(event=None):
            """点「手写补充」那一列就在格子里改，跟图片网格里一样。"""
            if event is None:
                return
            row = tree.identify_row(event.y)
            column = tree.identify_column(event.x)
            if not row or column != "#2":          # #0 图片 / #1 标签 / #2 手写补充
                return
            bbox = tree.bbox(row, column)
            if not bbox:
                return
            x, y, width, height = bbox
            cell = tk.Entry(tree, bg="#0d1117", fg=TEXT, insertbackground=TEXT,
                            relief="flat", font=(FONT, 9), highlightthickness=1,
                            highlightbackground=ACCENT, highlightcolor=ACCENT)
            cell.insert(0, tree.set(row, "note"))
            cell.icursor("end")
            cell.place(x=x, y=y, width=width, height=height)
            cell.focus_set()
            done = {"closed": False}

            def commit(_event=None):
                if done["closed"]:
                    return
                done["closed"] = True
                value = cell.get()
                cell.destroy()
                self.lib.set_note(row, value)
                fill_tree()
                if tree.exists(row):
                    tree.selection_set(row)
                    tree.see(row)
                on_select()
                self.on_rescan()
                self._update_status(f"备注已保存：{row}", OK_GREEN)

            def cancel(_event=None):
                if done["closed"]:
                    return
                done["closed"] = True
                cell.destroy()

            cell.bind("<Return>", commit)
            cell.bind("<KP_Enter>", commit)
            cell.bind("<Escape>", cancel)
            cell.bind("<FocusOut>", commit)
            return "break"

        tree.bind("<Button-1>", edit_cell)
        tree.bind("<Double-Button-1>", edit_cell)
        tree.bind("<<TreeviewSelect>>", on_select)
        tree.bind("<Return>", save_note)
        var_filter.trace_add("write", lambda *_: fill_tree())

        ttk.Button(bottom, text="保存", style="Accent.TButton",
                   command=save_note).pack(side="right")
        ttk.Button(bottom, text="清空", command=clear_note).pack(side="right", padx=(0, 8))
        var_hint.pack(side="right", padx=(0, 12))

        fill_tree()
        if rels:
            first = tree.get_children()
            if first:
                tree.selection_set(first[0])
                tree.see(first[0])
                on_select()
        win.grab_set()

    # ------------------------------------------------------------------ QQ
    def _qq_client(self):
        if not HAS_QQ:
            return None
        cfg = self.qq_cfg
        if not cfg.get("http_url") or not cfg.get("token"):
            return None
        return qq_sync.OneBot(cfg["http_url"], cfg.get("token", ""))

    def _qq_bridge(self):
        if not HAS_QQ:
            return None
        cfg = self.qq_cfg
        if not cfg.get("console_url") or not cfg.get("console_token"):
            return None
        return qq_sync.Bridge(cfg["console_url"], cfg.get("console_token", ""))

    def _on_qq_toggle(self):
        if not self.qq_on.get():
            self._update_qq_label()
            return
        if not HAS_QQ:
            self.qq_on.set(False)
            messagebox.showwarning(APP_TITLE, "缺少 qq_sync.py，QQ 备注功能不可用。")
            return
        if self._qq_client() is None:
            self.qq_on.set(False)
            if messagebox.askyesno(APP_TITLE, "还没配置 QQ 连接，现在设置？"):
                self.on_qq_settings()
            return
        if not self.qq_ready:
            self._test_qq(silent=True)
        self._update_qq_label()

    def _update_qq_label(self):
        if not self.qq_on.get():
            self.lbl_qq.configure(text="未启用", fg=MUTED)
            return
        if self.qq_ready:
            mode = "含上传" if self.qq_upload.get() else "仅改备注"
            self.lbl_qq.configure(text=f"已连接 · 收藏 {self.qq_faces} 张 · {mode}", fg=OK_GREEN)
        else:
            self.lbl_qq.configure(text="已启用，尚未连上（点连接设置测试）", fg=WARN_ORANGE)

    def _test_qq(self, silent: bool = False):
        client = self._qq_client()
        if client is None:
            self.qq_ready = False
            if not silent:
                messagebox.showinfo(APP_TITLE, "还没配置 OneBot 地址或令牌。")
            return
        self.lbl_qq.configure(text="正在连接 QQ …", fg=MUTED)

        def worker():
            try:
                faces = client.faces(500)
                self._ui(self._on_qq_tested, True, len(faces), 0, 0, "", silent)
            except Exception as error:  # noqa: BLE001
                self._ui(self._on_qq_tested, False, 0, 0, 0, str(error), silent)

        threading.Thread(target=worker, daemon=True).start()

    def _on_qq_tested(self, ok: bool, faces: int, matched: int, checked: int,
                      error: str, silent: bool = False):
        self.qq_ready = ok
        self.qq_faces = faces
        self._update_qq_label()
        if silent:
            return
        if ok:
            messagebox.showinfo("QQ 连接正常", f"收藏表情 {faces} 张。")
        else:
            messagebox.showerror("QQ 连接失败", error or "未知错误")

    def on_qq_settings(self):
        if not HAS_QQ:
            messagebox.showwarning(APP_TITLE, "缺少 qq_sync.py，QQ 备注功能不可用。")
            return
        win = tk.Toplevel(self)
        win.title("QQ 连接设置")
        win.configure(bg=BG)
        win.transient(self)
        win.resizable(False, False)

        cfg = dict(self.qq_cfg)
        var_url = tk.StringVar(value=cfg.get("http_url", ""))
        var_token = tk.StringVar(value=cfg.get("token", ""))
        var_console_url = tk.StringVar(value=cfg.get("console_url", ""))
        var_console_token = tk.StringVar(value=cfg.get("console_token", ""))
        # 跟侧栏共用同一个变量，勾哪边都同步，不会互相覆盖
        var_upload = self.qq_upload
        var_delay = tk.IntVar(value=int(cfg.get("delay_ms", 1200) or 0))
        var_cap = tk.IntVar(value=int(cfg.get("cap", 100) or 0))

        body = tk.Frame(win, bg=BG)
        body.pack(fill="both", expand=True, padx=18, pady=14)

        def field(label, variable, hint=""):
            tk.Label(body, text=label, bg=BG, fg=TEXT, font=(FONT, 9)).pack(anchor="w", pady=(8, 2))
            ttk.Entry(body, textvariable=variable, width=52).pack(fill="x")
            if hint:
                tk.Label(body, text=hint, bg=BG, fg=MUTED, font=(FONT, 8),
                         justify="left", wraplength=420).pack(anchor="w", pady=(2, 0))

        field("OneBot HTTP 地址", var_url, "SnowLuma 的 HTTP API，形如 http://127.0.0.1:3000")
        field("OneBot accessToken", var_token, "SnowLuma WebUI 里给 http-default 配的令牌")

        auto = tk.Frame(body, bg=BG)
        auto.pack(fill="x", pady=(8, 0))
        ttk.Button(auto, text="自动读取配置", command=lambda: _auto_fill()).pack(side="left")
        tk.Label(auto, text="（读 SnowLuma / qq-bridge 的配置文件）", bg=BG, fg=MUTED,
                 font=(FONT, 8)).pack(side="left", padx=6)

        field("桥接控制台地址（可选）", var_console_url,
              "填了就把备注同时写进 AI 的本地笔记 localNote/tags")
        field("控制台 consoleToken（可选）", var_console_token, "在 qq-bridge/state/console-token 里")

        opt = tk.Frame(body, bg=BG)
        opt.pack(fill="x", pady=(10, 0))
        ttk.Checkbutton(opt, text="未收藏的图片也上传成收藏表情",
                        variable=self.qq_upload,
                        command=self._update_qq_label).pack(anchor="w")

        row = tk.Frame(body, bg=BG)
        row.pack(fill="x", pady=(10, 0))
        tk.Label(row, text="每张间隔(ms)", bg=BG, fg=TEXT, font=(FONT, 9)).pack(side="left")
        ttk.Spinbox(row, from_=0, to=10000, increment=200, width=6,
                    textvariable=var_delay).pack(side="left", padx=(6, 18))
        tk.Label(row, text="每批上传上限", bg=BG, fg=TEXT, font=(FONT, 9)).pack(side="left")
        ttk.Spinbox(row, from_=0, to=500, width=6, textvariable=var_cap).pack(side="left", padx=(6, 0))

        tk.Label(body, text="上传会真的往 QQ 收藏里加图，受账号名额和频控限制。",
                 bg=BG, fg=MUTED, font=(FONT, 8), justify="left",
                 wraplength=430).pack(anchor="w", pady=(10, 0))

        def _auto_fill():
            hints = [str(self.project)] if self.project else []
            found = qq_sync.discover_config(hints)
            if found.get("http_url"):
                var_url.set(found["http_url"])
            if found.get("token"):
                var_token.set(found["token"])
            if found.get("console_url"):
                var_console_url.set(found["console_url"])
            if found.get("console_token"):
                var_console_token.set(found["console_token"])
            if found.get("via"):
                messagebox.showinfo("已读取", f"来源：{found['via']}", parent=win)
            else:
                messagebox.showinfo("没找到", "没在常见位置找到配置，请手动填写。", parent=win)

        def _save():
            self.qq_cfg = {
                "http_url": var_url.get().strip(),
                "token": var_token.get().strip(),
                "console_url": var_console_url.get().strip(),
                "console_token": var_console_token.get().strip(),
                "upload": bool(var_upload.get()),
                "delay_ms": max(0, int(var_delay.get() or 0)),
                "cap": max(0, int(var_cap.get() or 0)),
            }
            self._save_prefs()
            win.destroy()
            self.qq_ready = False
            if self.qq_on.get():
                self._test_qq(silent=True)

        def _test_from_dialog():
            client = qq_sync.OneBot(var_url.get().strip(), var_token.get().strip())

            def worker():
                try:
                    faces = client.faces(500)
                    self._ui(lambda: messagebox.showinfo(
                        "连接正常", f"读到 {len(faces)} 张收藏表情。", parent=win))
                except Exception as error:  # noqa: BLE001
                    self._ui(lambda e=error: messagebox.showerror("连接失败", str(e), parent=win))

            threading.Thread(target=worker, daemon=True).start()

        buttons = tk.Frame(body, bg=BG)
        buttons.pack(fill="x", pady=(14, 0))
        ttk.Button(buttons, text="保存", style="Accent.TButton", command=_save).pack(side="right")
        ttk.Button(buttons, text="取消", command=win.destroy).pack(side="right", padx=(0, 8))
        ttk.Button(buttons, text="测试连接", command=_test_from_dialog).pack(side="left")
        win.grab_set()

    def _ensure_qq_enabled(self) -> bool:
        """同步前确认「同步备注」开着——它是唯一的总开关，别让按钮绕过它。"""
        if not HAS_QQ:
            messagebox.showwarning(APP_TITLE, "缺少 qq_sync.py，无法同步。")
            return False
        if self.qq_on.get():
            return True
        if messagebox.askyesno("同步备注未启用",
                               "「同步备注」还没勾选，这次会真的上传/改写 QQ 收藏。\n"
                               "现在启用并继续吗？"):
            self.qq_on.set(True)
            self._on_qq_toggle()
            return True
        return False

    def on_sync_qq(self):
        if self._busy:
            return
        if not self._ensure_qq_enabled():
            return
        name = self._target_name()
        if not name or not self.lib:
            messagebox.showinfo(APP_TITLE, "先选中或进入一个合集。")
            return
        images = self.lib.paths_of(name)
        if not images:
            messagebox.showinfo(APP_TITLE, f"合集「{name}」里还没有图片。")
            return
        self._sync_qq_images(f"合集「{name}」", images)

    def on_sync_all_tagged(self):
        """把所有归过类的图片去重后一次性同步（这批图往往散在很多合集里）。"""
        if self._busy:
            return
        if not self._ensure_qq_enabled():
            return
        if not self.lib:
            messagebox.showinfo(APP_TITLE, "请先选择工程目录。")
            return
        seen: set[str] = set()
        images: list[Path] = []
        for name in self.lib.names():
            for path in self.lib.paths_of(name):
                key = str(path).casefold()
                if key not in seen:
                    seen.add(key)
                    images.append(path)
        if not images:
            messagebox.showinfo(APP_TITLE, "还没有任何图片归过类。")
            return
        self._sync_qq_images(f"全部已归类（{len(images)} 张）", images)

    def _sync_qq_images(self, label: str, images: list[Path]):
        client = self._qq_client()
        if client is None:
            if messagebox.askyesno(APP_TITLE, "还没配置 QQ 连接，现在设置？"):
                self.on_qq_settings()
            return

        try:
            writer = qq_sync.QQWriter(
                client, self._qq_bridge(), upload=bool(self.qq_upload.get()),
                cap=int(self.qq_cfg.get("cap", 100) or 0),
                delay_ms=int(self.qq_cfg.get("delay_ms", 1200) or 0))
            faces = writer.connect()
        except Exception as error:  # noqa: BLE001
            messagebox.showerror("QQ 连不上", f"{error}\n\n本地操作不受影响。")
            return
        self.qq_ready = True
        self.qq_faces = faces
        self._update_qq_label()

        matched, checked = writer.match_count(images)
        manual = sum(1 for p in images if self.lib.is_manual(to_rel(self.project, p)))
        lines = [f"{label} 共 {len(images)} 张，收藏里有 {faces} 张表情。",
                 f"其中 {matched}/{checked} 张能对上。"]
        if manual:
            lines.append(f"{manual} 张有手写备注，其余用合并后的标签。")
        if matched < len(images):
            if self.qq_upload.get():
                lines.append(f"对不上的 {len(images) - matched} 张会上传（上限 {writer.cap} 张）。")
            else:
                lines.append(f"对不上的 {len(images) - matched} 张不会上传（未勾选上传）。")
        if not messagebox.askokcancel("同步 QQ 备注", "\n".join(lines) + "\n\n继续吗？"):
            return

        payload = []
        for image in images:
            rel = to_rel(self.project, image)
            payload.append((image, self.lib.remark_of(rel), self.lib.tags_of(rel)))

        self._busy = True
        self.progress.configure(maximum=max(1, len(payload)), value=0)

        def worker():
            errors = []
            for index, (image, text, tags) in enumerate(payload, start=1):
                record = writer.apply(image, text, tags)
                if record.get("action") == "error":
                    errors.append((image.name, record.get("error", "")))
                self._ui(self._on_progress, index, len(payload))
            self._ui(self._on_sync_done, label, dict(writer.stats), errors)

        threading.Thread(target=worker, daemon=True).start()

    def _on_sync_done(self, name: str, stats: dict, errors: list):
        self._busy = False
        bits = []
        if stats.get("remarked"):
            bits.append(f"改了 {stats['remarked']} 张备注")
        if stats.get("uploaded"):
            bits.append(f"上传 {stats['uploaded']} 张")
        if stats.get("skipped"):
            bits.append(f"{stats['skipped']} 张本来就对")
        if stats.get("absent"):
            bits.append(f"{stats['absent']} 张不在收藏里")
        if stats.get("capped"):
            bits.append(f"{stats['capped']} 张超上限")
        if stats.get("failed"):
            bits.append(f"{stats['failed']} 张失败")
        summary = "，".join(bits) or "没有需要写的内容"
        self._update_status(f"QQ 同步「{name}」：{summary}", OK_GREEN)
        text = f"合集「{name}」同步完成：\n\n{summary}"
        if errors:
            detail = "\n".join(f"• {n}: {r}" for n, r in errors[:8])
            messagebox.showwarning("部分失败", f"{text}\n\n{detail}")
        else:
            messagebox.showinfo("同步完成", text)

    # ------------------------------------------------------------------ 预览
    def _open_preview(self, index: int):
        if not (0 <= index < len(self.files)):
            return
        path = self.files[index]
        win = tk.Toplevel(self)
        win.title(path.name)
        win.configure(bg=BG)
        image = None
        width = height = 0
        if HAS_PIL:
            try:
                with Image.open(path) as src:
                    width, height = src.size
                    preview = src.copy()
                    preview.thumbnail((900, 700), Image.LANCZOS)
                    image = ImageTk.PhotoImage(preview, master=self)
            except Exception:
                image = None
        label = tk.Label(win, bg=BG, image=image, text="" if image else "无法预览这张图",
                         fg=MUTED, font=(FONT, 10))
        label.image = image
        label.pack(padx=8, pady=8)
        caption = f"{path.name}   {width}×{height}"
        if self.lib:
            rel = to_rel(self.project, path)
            tags = self.lib.tags_of(rel)
            if tags:
                caption += f"\n标签：{REMARK_SEP.join(tags)}"
            caption += f"\n备注：{self.lib.remark_of(rel) or '（无）'}"
        tk.Label(win, text=caption, bg=BG, fg=MUTED, font=(FONT, 9),
                 wraplength=880, justify="center").pack(pady=(0, 8))

    # ------------------------------------------------------------------ 偏好
    def _prefs_path(self) -> Path:
        # 允许用环境变量换一个偏好文件，方便测试时不动用户配置
        override = os.environ.get("MEME_RENAMER_PREFS")
        return Path(override) if override else Path.home() / ".meme-renamer.json"

    def _save_prefs(self):
        data = {
            "project": str(self.project) if self.project else "",
            "tag": self.tag_var.get(),
            "collection": self.current or "",
            "qq_on": bool(self.qq_on.get()),
            "qq_upload": bool(self.qq_upload.get()),
            "qq": dict(self.qq_cfg),
        }
        try:
            self._prefs_path().write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    def _load_prefs(self):
        try:
            data = json.loads(self._prefs_path().read_text(encoding="utf-8"))
        except Exception:
            return
        saved_qq = data.get("qq")
        if isinstance(saved_qq, dict):
            cfg = dict(QQ_DEFAULTS)
            cfg.update({k: v for k, v in saved_qq.items() if k in QQ_DEFAULTS})
            self.qq_cfg = cfg
        self.qq_upload.set(bool(data.get("qq_upload", self.qq_cfg.get("upload", False))))
        self.qq_on.set(bool(data.get("qq_on", False)))
        self._update_qq_label()

        wanted = data.get("collection") or ""
        project = data.get("project")
        if project and Path(project).is_dir():
            self.project = Path(project)
            self.lib = Library(self.project)      # 先有 lib，标签区才画得出自定义组
            self.lbl_path.configure(text=str(self.project))
            if wanted and wanted in self.lib.collections:
                self.current = wanted
                self.selected_collection = wanted
            self._refresh_collections(keep=wanted or None)

        # 标签可以是内置的，也可以是自定义的
        tag = data.get("tag")
        if tag:
            self.tag_var.set(tag)
        if self.lib:
            self.on_rescan()
        self._render_tags()

    def _on_close(self):
        self._commit_note_edit()
        self._closing = True
        if self._poll_id:
            try:
                self.after_cancel(self._poll_id)
            except Exception:  # noqa: BLE001
                pass
            self._poll_id = None
        self._save_prefs()
        # 让缩略图线程停下来，避免退出瞬间还握着文件句柄
        for _ in self._workers:
            try:
                self._thumb_queue.put(None)
            except Exception:
                pass
        self.destroy()


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--selftest" in argv:
        return run_selftest()

    if not HAS_PIL:
        print("警告：未检测到 Pillow，缩略图将不可用（pip install pillow）", file=sys.stderr)

    try:
        app = App()
    except Exception:  # noqa: BLE001 - pythonw 下没有控制台，用对话框兜底
        detail = traceback.format_exc()
        try:
            from tkinter import messagebox as _mb

            root = tk.Tk()
            root.withdraw()
            _mb.showerror(APP_TITLE, f"启动失败：\n\n{detail[-1500:]}")
            root.destroy()
        except Exception:
            print(detail, file=sys.stderr)
        return 1

    app.mainloop()
    return 0


def run_selftest() -> int:
    """无界面自检：json 数据层 / 多标签合并 / 备注优先级 / 撤销 / QQ 写手。"""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        def make_image(name: str, color=(80, 120, 200)) -> Path:
            path = root / name
            if HAS_PIL:
                Image.new("RGB", (48, 48), color).save(path)
            else:
                path.write_bytes(b"\x89PNG\r\n\x1a\n" + name.encode())
            return path

        for index in range(5):
            make_image(f"img{index}.png", (index * 40, 90, 140))
        (root / "sub").mkdir()
        make_image("sub/deep.png", (10, 200, 60))

        # ---- 扫描（递归）----
        images = scan_images(root)
        assert len(images) == 6, [p.name for p in images]
        rels = [to_rel(root, p) for p in images]
        assert "sub/deep.png" in rels, rels

        # ---- 新建 / 保存 / 重载 ----
        lib = Library(root)
        lib.create("破防")
        lib.create("开心")
        assert lib.names() == ["开心", "破防"], lib.names()           # 按 natural_key 排序
        assert (root / META_FILE).exists()

        # ---- 加入（纯 json，不动文件）----
        before = sorted(p.name for p in root.iterdir())
        added = lib.add("破防", ["img0.png", "img1.png", "sub/deep.png"])
        assert added == 3, added
        assert sorted(p.name for p in root.iterdir()) == before, "不应该产生任何文件变动"
        assert lib.count("破防") == 3
        # 重复加入不算新增
        assert lib.add("破防", ["img0.png"]) == 0
        # 一张图可以属于多个合集
        assert lib.add("开心", ["img0.png", "img2.png"]) == 2

        # ---- 多标签合并备注 ----
        assert lib.tags_of("img0.png") == ["开心", "破防"], lib.tags_of("img0.png")
        assert lib.merged_remark("img0.png") == "开心、破防", lib.merged_remark("img0.png")
        assert lib.remark_of("img1.png") == "破防"
        assert lib.remark_of("img3.png") == ""            # 没归类就没备注

        # ---- 手写备注是补充，不覆盖标签 ----
        lib.set_note("img0.png", "笑死")
        assert lib.remark_of("img0.png") == "开心、破防｜笑死", lib.remark_of("img0.png")
        assert lib.is_manual("img0.png")
        # 没标签的图，手写备注就是全部
        lib.set_note("img3.png", "单独一句")
        assert lib.remark_of("img3.png") == "单独一句"
        lib.set_note("img0.png", "")                       # 清空 → 只剩标签
        assert lib.remark_of("img0.png") == "开心、破防"
        lib.set_note("img3.png", "")

        # ---- 持久化 ----
        lib2 = Library(root)
        assert lib2.count("破防") == 3 and lib2.count("开心") == 2
        assert lib2.tags_of("img0.png") == ["开心", "破防"]

        # ---- 移出 / 删除 ----
        assert lib2.remove("破防", ["img1.png"]) == 1
        assert lib2.remark_of("img1.png") == ""
        assert lib2.remove("破防", ["img1.png"]) == 0
        lib2.delete("开心")
        assert "开心" not in lib2.names()
        assert lib2.tags_of("img0.png") == ["破防"]        # 只剩破防
        assert (root / "img0.png").is_file(), "删合集不能删图片"

        # ---- 撤销加入 ----
        log_added(root, "b1", "破防", ["img3.png", "img4.png"])
        assert lib2.add("破防", ["img3.png", "img4.png"]) == 2
        removed, errors = undo_last_add(lib2)
        assert not errors and removed == 2, (removed, errors)
        assert lib2.tags_of("img3.png") == []
        assert (root / "img3.png").is_file()

        # ---- 备注列表覆盖所有归过类的图 ----
        tagged = lib2.tagged()
        assert "img0.png" in tagged and "sub/deep.png" in tagged, tagged
        assert "img3.png" not in tagged

        # ---- QQ 写手（假客户端，不联网）----
        if HAS_QQ:
            class FakeClient:
                def __init__(self, known):
                    self.faces_by_md5 = {m: {"id": f"id-{m}", "md5": m, "url": "", "desc": d}
                                         for m, d in known.items()}
                    self.calls = []

                def faces(self, count=500):
                    return [dict(f) for f in self.faces_by_md5.values()]

                def set_desc(self, emoji_id, desc):
                    self.calls.append(("desc", desc))
                    for face in self.faces_by_md5.values():
                        if face["id"] == emoji_id:
                            face["desc"] = desc

                def add_face(self, path):
                    digest = qq_sync.file_md5(path)
                    self.faces_by_md5[digest] = {"id": f"id-{digest}", "md5": digest,
                                                 "url": "", "desc": ""}
                    self.calls.append(("add", digest))
                    return f"id-{digest}"

                def delete_face(self, emoji_id):
                    self.calls.append(("del", emoji_id))
                    self.faces_by_md5 = {k: v for k, v in self.faces_by_md5.items()
                                         if v["id"] != emoji_id}

            path0 = root / "img0.png"
            known = qq_sync.file_md5(path0)
            client = FakeClient({known: "旧备注"})
            writer = qq_sync.QQWriter(client, upload=True, cap=5, delay_ms=0)
            writer.connect()
            writer.apply(path0, lib2.remark_of("img0.png"), lib2.tags_of("img0.png"))
            assert client.faces_by_md5[known]["desc"] == "破防", client.faces_by_md5[known]
            # 多标签合并后写进 QQ
            lib2.add("破防", ["img0.png"])
            lib2.create("无语")
            lib2.add("无语", ["img0.png"])
            assert lib2.remark_of("img0.png") == "无语、破防", lib2.remark_of("img0.png")
            writer2 = qq_sync.QQWriter(client, delay_ms=0)
            writer2.connect()
            writer2.apply(path0, lib2.remark_of("img0.png"), lib2.tags_of("img0.png"))
            assert client.faces_by_md5[known]["desc"] == "无语、破防"
            # 幂等
            calls_before = len(client.calls)
            writer3 = qq_sync.QQWriter(client, delay_ms=0)
            writer3.connect()
            writer3.apply(path0, lib2.remark_of("img0.png"), lib2.tags_of("img0.png"))
            assert len(client.calls) == calls_before, client.calls

        # ---- 标签：原始不可删，自定义可删（连同合集）----
        assert lib2.is_builtin("破防") and not lib2.is_builtin("我的梗")
        lib2.add_tag("我的梗")
        assert "我的梗" in lib2.all_tags()
        try:
            lib2.add_tag("破防")
            raise AssertionError("重复标签应该报错")
        except ValueError:
            pass
        lib2.create("我的梗")
        lib2.add("我的梗", ["img0.png"])
        assert set(lib2.tags_of("img0.png")) == {"我的梗", "无语", "破防"}, lib2.tags_of("img0.png")
        assert "我的梗" in lib2.remark_of("img0.png")
        lib2.remove_tag("我的梗")
        assert "我的梗" not in lib2.all_tags()
        assert "我的梗" not in lib2.collections
        assert set(lib2.tags_of("img0.png")) == {"无语", "破防"}
        assert (root / "img0.png").is_file(), "删标签不能删图片"
        try:
            lib2.remove_tag("破防")
            raise AssertionError("原始标签应该不允许删除")
        except ValueError:
            pass

        # ---- 分页：每页 100 ----
        class Pager:
            files = list(range(250))
            page = 0

        assert page_count(Pager.files) == 3
        Pager.page = 0; assert page_range(Pager.files, Pager.page) == (0, 100)
        Pager.page = 1; assert page_range(Pager.files, Pager.page) == (100, 200)
        Pager.page = 2; assert page_range(Pager.files, Pager.page) == (200, 250)
        Pager.files = list(range(100)); Pager.page = 0
        assert page_count(Pager.files) == 1 and page_range(Pager.files, Pager.page) == (0, 100)
        Pager.files = []; assert page_count(Pager.files) == 1 and page_range(Pager.files, Pager.page) == (0, 0)

        print("selftest ok: 扫描 / json 合集 / 多标签合并 / 备注 / 移出 / 撤销 / 标签增删 / 分页"
              + (" / QQ备注" if HAS_QQ else "") + " 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
