"""静态图缩放：给「喂给模型看」的那一份用。

由 src/media-normalize.js 的 normalizeImageForModel() 在 ffmpeg 不可用时调用。
参数：src dst width height ext（输出容器，".png" 或 ".jpg"）

有 alpha 走 PNG（保住透明），没有就走 JPEG（体积小）；动图只取首帧。
"""
import sys

from PIL import Image


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    width, height, ext = int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
    im = Image.open(src)
    try:
        im.seek(0)
    except Exception:
        pass
    im = im.convert("RGBA" if ext == ".png" else "RGB")
    im = im.resize((width, height), Image.LANCZOS)
    if ext == ".png":
        im.save(dst, "PNG", optimize=True)
    else:
        im.save(dst, "JPEG", quality=86, optimize=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
