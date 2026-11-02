"""QQ 收藏表情联动：把情绪/梗标签写进 QQ 表情备注（desc），可选把图片上传成收藏表情。

为什么单独一个文件：主程序（meme_renamer.py）只负责改名和归档，不联网；
所有「碰 QQ」的动作集中在这里，坏掉也只是这一块不可用，不影响改名。

两条通道，各管一段：

  1) 直连 SnowLuma 的 OneBot HTTP（默认 127.0.0.1:3000）
     - fetch_custom_face_detail 读收藏表情（id / md5 / url / desc）
     - modify_custom_face       写 QQ 官方备注（desc）
     - add_custom_face          把本地图片上传成收藏表情
     - delete_custom_face       撤销时把上传的那张删掉
     这是真正改变「QQ 里看到什么」的地方。

  2) 桥接控制台（默认 127.0.0.1:3100，可选）
     - POST /api/stickers/note  写 AI 侧的本地笔记 localNote / tags
     桥接的提示词里列表情时会带 localNote 和 tags，写上模型更容易挑中。

只用标准库，便携版 Python 直接能跑。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable

DESC_MAX = 50          # QQ 表情备注上限（桥接侧也是 50）
NOTE_MAX = 200         # localNote 上限
DEFAULT_TIMEOUT = 20   # 秒


class QQError(Exception):
    """连不上、被拒绝、返回 retcode != 0 时抛这个，调用方按普通错误处理。"""


# --------------------------------------------------------------------------- #
#  基础工具
# --------------------------------------------------------------------------- #

def file_md5(path: str | Path, chunk: int = 1 << 20) -> str:
    """流式算 md5：大图不会一次性读进内存。"""
    digest = hashlib.md5()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest().upper()


def normalize_face(raw: Any) -> dict | None:
    """把 OneBot 返回的一条收藏表情整理成固定字段；缺 id 的直接丢弃。"""
    if not isinstance(raw, dict):
        return None
    emoji_id = str(raw.get("emoji_id") or raw.get("id") or raw.get("resId") or "").strip()
    if not emoji_id:
        return None
    return {
        "id": emoji_id,
        "md5": str(raw.get("md5") or "").strip().upper(),
        "url": str(raw.get("url") or "").strip(),
        "desc": str(raw.get("desc") or "").strip(),
    }


def build_md5_index(faces: Iterable[dict]) -> dict[str, dict]:
    """md5 -> face。同一张图可能被收藏两次，保留第一个即可。"""
    index: dict[str, dict] = {}
    for face in faces:
        md5 = (face.get("md5") or "").upper()
        if md5 and md5 not in index:
            index[md5] = face
    return index


def compose_desc(tag: str, level: int | None, with_level: bool) -> str:
    """写进 QQ 备注的文本：默认就是标签本身。"""
    text = tag if not (with_level and level) else f"{tag}·{level}"
    return text[:DESC_MAX]


def compose_note(tag: str, level: int | None) -> str:
    """写进桥接本地笔记的文本：这里可以更啰嗦，模型看得到。"""
    text = tag if level is None else f"{tag}，强度 {level}/10"
    return text[:NOTE_MAX]


def _post_json(url: str, payload: dict, token: str = "", timeout: float = DEFAULT_TIMEOUT) -> Any:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = error.read().decode("utf-8", "replace")[:300]
        except Exception:  # noqa: BLE001
            pass
        raise QQError(f"HTTP {error.code}：{detail or error.reason}") from None
    except urllib.error.URLError as error:
        raise QQError(f"连不上 {url}（{error.reason}）") from None
    except TimeoutError:
        raise QQError(f"请求超时：{url}") from None

    text = raw.decode("utf-8", "replace").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise QQError(f"返回的不是 JSON：{text[:200]}") from None


# --------------------------------------------------------------------------- #
#  OneBot 通道（真正改 QQ 收藏表情）
# --------------------------------------------------------------------------- #

class OneBot:
    def __init__(self, base_url: str, token: str = "", timeout: float = DEFAULT_TIMEOUT):
        self.base_url = (base_url or "").rstrip("/")
        self.token = (token or "").strip()
        self.timeout = timeout

    # -- 底层 -------------------------------------------------------------
    def call(self, action: str, payload: dict | None = None) -> Any:
        if not self.base_url:
            raise QQError("还没配置 OneBot 地址（形如 http://127.0.0.1:3000）")
        data = _post_json(f"{self.base_url}/{action}", payload or {}, self.token, self.timeout)
        if not isinstance(data, dict):
            raise QQError(f"{action} 返回异常：{str(data)[:200]}")
        status = str(data.get("status") or "")
        retcode = data.get("retcode")
        if status != "ok" or (retcode not in (0, None)):
            wording = data.get("wording") or data.get("message") or retcode
            raise QQError(f"{action} 失败：{wording}")
        return data.get("data")

    # -- 业务 -------------------------------------------------------------
    def faces(self, count: int = 500) -> list[dict]:
        """读收藏表情。count 是请求上限，实际条数以账号为准。"""
        data = self.call("fetch_custom_face_detail", {"count": max(1, int(count))})
        if not isinstance(data, list):
            raise QQError("fetch_custom_face_detail 返回的 data 不是数组")
        return [face for face in (normalize_face(raw) for raw in data) if face]

    def set_desc(self, emoji_id: str, desc: str) -> None:
        """改 QQ 官方备注。空字符串表示清空备注。"""
        self.call("modify_custom_face", {"emoji_id": emoji_id, "desc": desc[:DESC_MAX]})

    def add_face(self, path: str | Path) -> str:
        """把本地图片上传成收藏表情，返回新的 emoji_id。"""
        raw = Path(path).read_bytes()
        data = self.call("add_custom_face", {"file": "base64://" + base64.b64encode(raw).decode("ascii")})
        emoji_id = ""
        if isinstance(data, dict):
            emoji_id = str(data.get("emoji_id") or "").strip()
        if not emoji_id:
            raise QQError("add_custom_face 没返回 emoji_id（可能图片格式/体积不被接受）")
        return emoji_id

    def delete_face(self, emoji_id: str) -> None:
        """删除一张收藏表情（撤销上传时用）。"""
        self.call("delete_custom_face", {"emoji_id": emoji_id})


# --------------------------------------------------------------------------- #
#  桥接控制台通道（可选：写 AI 本地笔记）
# --------------------------------------------------------------------------- #

class Bridge:
    def __init__(self, base_url: str, console_token: str = "", timeout: float = 10):
        self.base_url = (base_url or "").rstrip("/")
        self.token = (console_token or "").strip()
        self.timeout = timeout

    def note(self, sticker_id: str, note: str, tags: list[str] | None = None) -> bool:
        """写桥接的 localNote / tags。失败返回 False，不抛——这不是关键路径。"""
        if not self.base_url or not self.token:
            return False
        try:
            request = urllib.request.Request(
                f"{self.base_url}/api/stickers/note",
                data=json.dumps({
                    "stickerId": sticker_id,
                    "note": note[:NOTE_MAX],
                    "tags": (tags or [])[:20],
                }, ensure_ascii=False).encode("utf-8"),
                headers={"content-type": "application/json", "x-console-token": self.token},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = json.loads(response.read().decode("utf-8", "replace") or "{}")
            return bool(body.get("ok"))
        except Exception:  # noqa: BLE001 - 本地笔记写不上不影响 QQ 备注
            return False

    def sync_remote(self) -> bool:
        """让桥接重新拉一遍 QQ 表情库，避免它那边缓存过期看不到新备注。"""
        if not self.base_url or not self.token:
            return False
        try:
            request = urllib.request.Request(
                f"{self.base_url}/api/stickers/sync",
                data=b"{}",
                headers={"content-type": "application/json", "x-console-token": self.token},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return 200 <= response.status < 300
        except Exception:  # noqa: BLE001
            return False


# --------------------------------------------------------------------------- #
#  配置发现
# --------------------------------------------------------------------------- #

def _token_from_onebot_config(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:  # noqa: BLE001
        return None
    networks = data.get("networks") if isinstance(data, dict) else None
    if not isinstance(networks, dict):
        return None
    for server in networks.get("httpServers") or []:
        if not isinstance(server, dict):
            continue
        host = str(server.get("host") or "127.0.0.1")
        port = server.get("port")
        token = str(server.get("accessToken") or "").strip()
        if port:
            return {"http_url": f"http://{host}:{port}", "token": token, "source": str(path)}
    return None


def _bridge_config(root: Path) -> dict | None:
    config_path = root / "qq-bridge" / "config.json"
    if not config_path.exists():
        config_path = root / "config.json"
    if not config_path.exists():
        return None
    try:
        data = json.loads(config_path.read_text(encoding="utf-8-sig"))
    except Exception:  # noqa: BLE001
        return None
    snow = data.get("snowluma") or {}
    http_url = str(snow.get("httpUrl") or "").rstrip("/")
    token = str(snow.get("accessToken") or "").strip()
    console_port = data.get("consolePort") or 3100
    console_token = str(data.get("consoleToken") or "").strip()
    if not console_token:
        token_file = config_path.parent / "state" / "console-token"
        if token_file.exists():
            try:
                console_token = token_file.read_text(encoding="utf-8").strip()
            except Exception:  # noqa: BLE001
                console_token = ""
    out = {"http_url": http_url, "token": token,
           "console_url": f"http://127.0.0.1:{console_port}" if console_token else "",
           "console_token": console_token, "source": str(config_path)}
    return out


def discover_config(hints: Iterable[str | Path] = ()) -> dict:
    """按常见位置找 SnowLuma / qq-bridge 的配置，填好地址和令牌。

    找不到就返回空串，调用方自己弹设置窗让用户填。
    """
    roots: list[Path] = [Path(p) for p in hints if p]
    roots += [
        Path.cwd(),
        Path(__file__).resolve().parent,
        Path.home() / "Documents" / "deepseek-harness" / "default-workspace",
        Path("D:/AI"),
    ]
    seen: set[str] = set()
    for root in roots:
        if not root.exists():
            continue
        # 1) qq-bridge 的 config.json（同时带 OneBot 和 console 令牌）
        for candidate in (root, root / "qq-bridge", root.parent):
            if str(candidate).lower() in seen:
                continue
            seen.add(str(candidate).lower())
            found = _bridge_config(candidate)
            if found and found.get("http_url"):
                if not found.get("console_token"):
                    found["console_url"] = ""
                found["via"] = "qq-bridge/config.json"
                return found
        # 2) SnowLuma 的 onebot_*.json
        for snow_dir in (root / "SnowLuma", root):
            config_dir = snow_dir / "config"
            if not config_dir.is_dir():
                continue
            for path in sorted(config_dir.glob("onebot_*.json")):
                found = _token_from_onebot_config(path)
                if found:
                    found.update({"console_url": "", "console_token": "", "via": "SnowLuma onebot 配置"})
                    return found
    return {"http_url": "", "token": "", "console_url": "", "console_token": "", "via": ""}


# --------------------------------------------------------------------------- #
#  写手：把一次批处理里的每张图落到 QQ
# --------------------------------------------------------------------------- #

class QQWriter:
    """每处理一张图调一次 apply()，返回要写进日志的记录（撤销时靠它回滚）。

    匹配靠 md5：QQ 收藏表情的 emoji_id 里嵌着上传文件的 md5，
    fetch_custom_face_detail 也会直接给 md5。所以只有「本机这张图确实被上传过」
    才能对上——对不上说明它不在收藏里，是否上传由 upload 决定。
    """

    def __init__(self, client: OneBot | None = None, bridge: Bridge | None = None,
                 upload: bool = False, cap: int = 100, delay_ms: int = 1200):
        self.client = client
        self.bridge = bridge
        self.upload = upload
        self.cap = max(0, int(cap))
        self.delay = max(0, int(delay_ms)) / 1000.0
        self.index: dict[str, dict] = {}
        self.total_faces = 0
        self.uploaded = 0
        self.stats = {"matched": 0, "remarked": 0, "uploaded": 0, "skipped": 0,
                      "absent": 0, "capped": 0, "failed": 0}

    # -- 连接 -------------------------------------------------------------
    def connect(self) -> int:
        """拉一遍收藏表情，返回张数。"""
        if self.client is None:
            raise QQError("没有可用的 OneBot 连接")
        faces = self.client.faces(500)
        self.index = build_md5_index(faces)
        self.total_faces = len(faces)
        return self.total_faces

    def match_count(self, paths: Iterable[str | Path]) -> tuple[int, int]:
        """(能匹配上的数量, 检查的总数)——给界面预估用，不发任何写请求。"""
        matched = checked = 0
        for path in paths:
            checked += 1
            try:
                if file_md5(path) in self.index:
                    matched += 1
            except OSError:
                continue
        return matched, checked

    # -- 单张 -------------------------------------------------------------
    def apply(self, path: str | Path, desc: str, tags: Iterable[str] = ()) -> dict:
        """desc 就是要写进 QQ 备注的最终文本（已由调用方决定，不再拼接）。"""
        path = Path(path)
        new_desc = (desc or "").strip()[:DESC_MAX]
        note = new_desc
        tag_list = [str(t) for t in tags if str(t).strip()] or ([new_desc] if new_desc else [])

        try:
            md5 = file_md5(path)
        except OSError as error:
            self.stats["failed"] += 1
            return {"action": "error", "error": f"读不到文件：{error}"}

        face = self.index.get(md5)
        if face is None:
            self.stats["absent"] += 1
            if not self.upload:
                return {"action": "absent", "md5": md5}
            if self.uploaded >= self.cap:
                self.stats["capped"] += 1
                return {"action": "capped", "md5": md5}

        try:
            if face is None:
                assert self.client is not None
                emoji_id = self.client.add_face(path)
                self.uploaded += 1
                face = {"id": emoji_id, "md5": md5, "url": "", "desc": ""}
                self.index[md5] = face
                action = "upload"
                self.stats["uploaded"] += 1
                self._sleep()
            else:
                if (face.get("desc") or "") == new_desc:
                    self.stats["skipped"] += 1
                    # 字段与 remark/upload 保持一致：撤销逻辑和日志检查都按 new_desc 读
                    current = face.get("desc") or ""
                    return {"action": "skip", "id": face["id"], "md5": md5,
                            "prev_desc": current, "new_desc": new_desc}
                action = "remark"
                self.stats["matched"] += 1

            assert self.client is not None
            previous = face.get("desc") or ""
            self.client.set_desc(face["id"], new_desc)
            face["desc"] = new_desc
            self.stats["remarked"] += 1
            if self.bridge is not None:
                self.bridge.note(face["id"], note, tag_list)
            self._sleep()
            return {"action": action, "id": face["id"], "md5": md5,
                    "prev_desc": previous, "new_desc": new_desc}
        except QQError as error:
            self.stats["failed"] += 1
            return {"action": "error", "id": (face or {}).get("id", ""), "md5": md5,
                    "error": str(error)}
        except Exception as error:  # noqa: BLE001 - 单张失败不影响整批
            self.stats["failed"] += 1
            return {"action": "error", "md5": md5, "error": f"{type(error).__name__}: {error}"}

    def _sleep(self):
        if self.delay:
            time.sleep(self.delay)


def undo_qq_record(client: OneBot, record: dict) -> str:
    """撤销一条 QQ 记录：上传的删掉，改过备注的改回去。返回动作说明。"""
    action = str(record.get("action") or "")
    emoji_id = str(record.get("id") or "")
    if not emoji_id:
        raise QQError("记录里没有 emoji_id，无法回滚")
    if action == "upload":
        client.delete_face(emoji_id)
        return "deleted"
    if action in ("remark", "skip"):
        previous = str(record.get("prev_desc") or "")
        current = str(record.get("new_desc") or "")
        if previous == current:
            return "unchanged"
        client.set_desc(emoji_id, previous)
        return "restored"
    return "noop"
