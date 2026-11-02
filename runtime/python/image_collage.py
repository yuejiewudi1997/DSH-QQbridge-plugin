"""动图抽帧拼图：把 GIF/动态 WebP 等间隔抽 count 帧，铺成 cols×rows 白底网格。

由 src/media-normalize.js 的 normalizeImageForModel() 在 ffmpeg 不可用时调用。
参数：src dst cols rows tile_px count

为什么拼图而不是发多帧：一条消息多张图 = 多次模型准入 + 多份 token，
而一张 3×2 拼图信息密度更高、只算一张图。
"""
import sys

from PIL import Image


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    cols, rows = int(sys.argv[3]), int(sys.argv[4])
    tile, count = int(sys.argv[5]), int(sys.argv[6])

    im = Image.open(src)
    frames = getattr(im, "n_frames", 1) or 1
    n = max(1, min(count, frames))
    # 等间隔取样：首帧和末帧都拿到，避免只看到开头
    idx = [0] if n == 1 else [round(i * (frames - 1) / (n - 1)) for i in range(n)]

    tiles = []
    for i in idx:
        try:
            im.seek(i)
        except Exception:
            pass
        frame = im.convert("RGBA").copy()
        w, h = frame.size
        scale = tile / max(w, h)
        tiles.append(frame.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS))

    cell_h = max(t.height for t in tiles)
    gap = 8
    grid = Image.new("RGB", (cols * (tile + gap) + gap, rows * (cell_h + gap) + gap), "white")
    for k, t in enumerate(tiles):
        c, r = k % cols, k // cols
        grid.paste(t, (gap + c * (tile + gap), gap + r * (cell_h + gap)), t)

    grid.save(dst, "JPEG", quality=82, optimize=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
