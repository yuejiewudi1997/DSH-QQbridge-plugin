"""把要当作 QQ 表情发送的图片压到表情渲染尺寸。

由 src/media-normalize.js 的 normalizeStickerForSend() 调用（ffmpeg 不可用时的兜底）。
参数：src dst width height

取舍：
- 统一转 RGBA：收藏表情大量带透明通道，转 RGB/JPEG 会出现白底方块。
- 动图只取首帧：回退路径本来就只发一张静态图。
- 先存 WEBP 再退 PNG：QQ 收藏表情本来就是 webp，PNG 会比原图大 3~4 倍。
"""
import sys

from PIL import Image


def main() -> int:
    src, dst, width, height = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    im = Image.open(src)
    try:
        im.seek(0)  # 动图：只要第一帧
    except Exception:
        pass
    im = im.convert("RGBA")
    im = im.resize((width, height), Image.LANCZOS)
    try:
        im.save(dst, "WEBP", quality=90, method=6)
    except Exception:
        im.save(dst, "PNG", optimize=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
