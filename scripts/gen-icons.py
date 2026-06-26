#!/usr/bin/env python3
"""gen-icons.py — 一次性生成 PWA 图标 (医 字蓝底白字)

设计:
  - 蓝底 (#2563eb) 全填充 (maskable 友好, 任意 crop 都纯色)
  - 中央白色"医"字, 占 ~65% 高度
  - 字体: Noto Sans CJK SC Bold (Linux) 或 Microsoft YaHei Bold (Windows)

运行:
  python3 scripts/gen-icons.py
  产物: public/icons/icon-{192,512}.png
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

PRIMARY = (37, 99, 235, 255)  # #2563eb
WHITE = (255, 255, 255, 255)

# 图标尺寸
SIZES = [192, 512]

# 字体候选 (优先级降序)
FONT_CANDIDATES = [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
    '/mnt/c/Windows/Fonts/msyhbd.ttc',  # Microsoft YaHei Bold
    '/mnt/c/Windows/Fonts/simhei.ttf',  # SimHei 兜底
    '/usr/share/fonts/truetype/noto/NotoSansSC-Bold.otf',
]


def find_font(size_px: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size=size_px)
        except (OSError, IOError):
            continue
    # 兜底: 默认字体 (bitmap, 会丑但能跑)
    print(f'WARN: no CJK font found, fallback to default (will look bad)')
    return ImageFont.load_default()


def render_icon(px: int, out_path: Path) -> None:
    img = Image.new('RGBA', (px, px), PRIMARY)
    draw = ImageDraw.Draw(img)

    # 字符大小: ~65% 画布
    font_size = int(px * 0.65)
    font = find_font(font_size)

    text = '医'
    # 测量文字宽高 (Pillow: textbbox 返回 (l, t, r, b))
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    # 居中 (注意 textbbox 的 left/top 不一定从 0 开始)
    x = (px - tw) // 2 - bbox[0]
    y = (px - th) // 2 - bbox[1]
    draw.text((x, y), text, fill=WHITE, font=font)

    img.save(out_path, 'PNG', optimize=True)
    print(f'  saved {out_path} ({px}x{px})')


def main():
    out_dir = Path(__file__).resolve().parent.parent / 'public' / 'icons'
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f'Output dir: {out_dir}')
    for size in SIZES:
        out = out_dir / f'icon-{size}.png'
        render_icon(size, out)
    print('done.')


if __name__ == '__main__':
    main()
