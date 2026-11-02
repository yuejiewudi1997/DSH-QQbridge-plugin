# -*- coding: utf-8 -*-
"""合并后核对：备注条数、长度、缺失、抽样最终备注。"""
import json, sys
from pathlib import Path

ROOT = Path(r"D:\AI\image\DeepSeek娘")
data = json.loads((ROOT / "_合集.json").read_text(encoding="utf-8"))
notes = data.get("notes", {})
tags = {}
for name, block in data["collections"].items():
    for rel in block["images"]:
        tags.setdefault(rel, []).append(name)

print(f"有标签的图 {len(tags)} 张，其中已写备注 {sum(1 for r in tags if notes.get(r))} 张")
gif = [r for r in tags if r.lower().endswith(".gif")]
print(f"动图（按你说的没看图）{len(gif)} 张：{', '.join(sorted(gif))}")

no_note = [r for r in tags if not notes.get(r) and not r.lower().endswith(".gif")]
if no_note:
    print(f"⚠ 静态图缺备注 {len(no_note)} 张：{', '.join(sorted(no_note))}")

merged = {}
for rel, note in notes.items():
    t = "、".join(sorted(set(tags.get(rel, [])), key=lambda s: s))
    merged[rel] = f"{t}\uff5c{note}" if t else note

over = {r: len(v) for r, v in merged.items() if len(v) > 50}
print(f"最终备注超过 50 字（QQ 会截断）{len(over)} 条")

lens = sorted(len(v) for v in merged.values())
print(f"长度分布：最短 {lens[0]}，中位 {lens[len(lens)//2]}，最长 {lens[-1]}")

print("\n抽样最终备注：")
for rel in sorted(merged)[:8]:
    print(f"  {rel:12s} {merged[rel]}")
