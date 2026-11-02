# -*- coding: utf-8 -*-
"""把若干批次结果合并进 _合集.json 的 notes，先备份。"""
import json, shutil, sys, time
from pathlib import Path

ROOT = Path(r"D:\AI\image\DeepSeek娘")
META = ROOT / "_合集.json"
JOIN = "\uff5c"

def main(paths):
    notes = {}
    for p in paths:
        data = json.loads(Path(p).read_text(encoding="utf-8"))
        for row in data:
            rel, note = row.get("file"), (row.get("note") or "").strip()
            if rel and note:
                notes[rel] = note
    print(f"读入 {len(notes)} 条备注")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = META.with_suffix(f".json.bak-{stamp}")
    shutil.copy2(META, backup)
    print("备份:", backup.name)

    data = json.loads(META.read_text(encoding="utf-8"))
    data.setdefault("notes", {})
    tags = {}
    for name, block in data["collections"].items():
        for rel in block["images"]:
            tags.setdefault(rel, []).append(name)

    added = 0
    too_long = []
    for rel, note in sorted(notes.items()):
        if rel in data["notes"] and data["notes"][rel].strip():
            continue                      # 已有的不覆盖
        data["notes"][rel] = note
        added += 1
        merged = "\u3001".join(sorted(set(tags.get(rel, [])), key=lambda s: s))
        full = f"{merged}{JOIN}{note}" if merged else note
        if len(full) > 50:
            too_long.append((rel, len(full), full))

    META.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"写入 {added} 条，notes 共 {len(data['notes'])} 条")
    if too_long:
        print(f"超 50 字（QQ 会截断）{len(too_long)} 张：")
        for rel, n, full in too_long:
            print(f"  {rel} {n}字 {full}")

if __name__ == "__main__":
    main(sys.argv[1:])
