#!/usr/bin/env python3
"""
生成应用图标与安装向导图片。

    python tools/make-icons.py

产出（都在 resources/ 下）：

    icon.ico              应用图标。exe、任务栏、开始菜单、桌面快捷方式都用它。
                          手工组装的多尺寸 ICO，16/24/32/48/64/128/256 每个尺寸
                          **独立渲染** —— 比让 Pillow 从大图统一缩放清晰得多。
    icon.png              512x512，给仓库 / 社交预览用。
    installerSidebar.bmp  164x314，NSIS 欢迎页与完成页左边的竖图。
    installerHeader.bmp   150x57，NSIS 内页右上角的小图。

设计：**蓝色斜向渐变圆角方块 + 白色几何 C**。

C 是手画的**等宽环段**（外扇形挖掉内圆），两端是沿半径方向的平切口 ——
不用字体，所以换台机器、换个系统字体都不会变形。它同时是
**C**Make 和 **C**onfigurator，也是这个应用一直以来的标记。

配色沿用应用里原本那个文字标记的 CSS：
`linear-gradient(135deg, #4f8ef7, #7c5cff)`。

改了参数后重新打包才会生效：

    npm run dist:installer

依赖 Pillow：  pip install Pillow
"""

from __future__ import annotations

import math
import os
import struct
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow：pip install Pillow")


# --------------------------------------------------------------------------
# 设计参数
# --------------------------------------------------------------------------

BRIGHT = (79, 142, 247)  # #4f8ef7 渐变起点（左上）
PURPLE = (124, 92, 255)  # #7c5cff 渐变终点（右下）
WHITE = (255, 255, 255)
SUBTLE = (209, 220, 254)  # 侧边栏版本号那种淡蓝

SS = 4  # 超采样倍数，抗锯齿全靠它

ROUND_RADIUS = 0.22  # 圆角方块的圆角比例，跟着 Windows 11 的图标观感走

# C 的几何（都相对画布边长，所以任意尺寸共用一套参数）
C_R_OUTER = 0.300  # 外半径
C_STROKE = 0.185  # 笔画粗细（内半径 = 外半径 - 粗细）
C_GAP_DEG = 42  # 两侧各让开的度数，所以开口总宽 = 2 * 42 = 84 度

APP_NAME_LINES = ("CMake / VSCode", "工程配置器")
VERSION = "v1.0.0"


# --------------------------------------------------------------------------
# 基础绘制
# --------------------------------------------------------------------------


def diagonal_gradient(size: int, c1: tuple, c2: tuple) -> Image.Image:
    """135 度渐变（左上 → 右下），和 CSS 的 linear-gradient(135deg, ...) 一致。"""
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    span = 2 * (size - 1)
    for y in range(size):
        for x in range(size):
            t = (x + y) / span
            draw.point((x, y), tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)))
    return img


def rounded_rect_mask(size: int, radius_ratio: float = ROUND_RADIUS) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=max(1, int(size * radius_ratio)), fill=255
    )
    return mask


def c_mask(size: int) -> Image.Image:
    """
    几何 C 的掩膜：外扇形挖掉同心的内圆，得到一条等宽环段。

    用 pieslice 而不是 ImageDraw.arc，是因为 arc 的线帽只能是圆的或是斜切的；
    扇形相减拿到的两端是**沿半径的平切口**，上下两端严丝合缝对齐。
    """
    mask = Image.new("L", (size, size), 0)
    c = size / 2
    r_out = size * C_R_OUTER
    r_in = r_out - size * C_STROKE
    box = [c - r_out, c - r_out, c + r_out, c + r_out]

    shape = Image.new("L", (size, size), 0)
    ImageDraw.Draw(shape).pieslice(box, start=C_GAP_DEG, end=360 - C_GAP_DEG, fill=255)

    inner = Image.new("L", (size, size), 0)
    ImageDraw.Draw(inner).ellipse([c - r_in, c - r_in, c + r_in, c + r_in], fill=255)

    return Image.composite(Image.new("L", (size, size), 0), shape, inner)


def _color_layer(size: int, color: tuple) -> Image.Image:
    return Image.new("RGBA", (size, size), color + (255,))


def render_icon(size: int) -> Image.Image:
    """完整图标：渐变圆角方块 + 白色几何 C。"""
    big = size * SS
    tile = diagonal_gradient(big, BRIGHT, PURPLE).convert("RGBA")
    tile.putalpha(rounded_rect_mask(big))
    out = Image.composite(_color_layer(big, WHITE), tile, c_mask(big))
    return out.resize((size, size), Image.LANCZOS)


def render_bare_c(size: int) -> Image.Image:
    """只有白色的 C，没有背景方块 —— 贴在本来就有渐变底的侧边栏上，避免方块套方块。"""
    big = size * SS
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    out = Image.composite(_color_layer(big, WHITE), out, c_mask(big))
    return out.resize((size, size), Image.LANCZOS)


# --------------------------------------------------------------------------
# ICO：手工组装
# --------------------------------------------------------------------------


def write_ico(path: str, sizes: list[int]) -> None:
    """
    写多尺寸 ICO。

    Pillow 自带的 `save(format="ICO", sizes=[...])` 是拿**同一张**大图缩放出所有尺寸，
    小尺寸会糊。这里每个尺寸重新画一遍，再按 ICO 容器格式手工拼起来
    （Vista 以后支持把 PNG 直接塞进 ICO，所以不用转 BMP）。
    """
    images: list[tuple[int, bytes]] = []
    for s in sizes:
        tmp = f"._ico_{s}.png"
        render_icon(s).save(tmp, "PNG")
        with open(tmp, "rb") as fh:
            images.append((s, fh.read()))
        os.remove(tmp)

    count = len(images)
    # ICONDIR: reserved(2) type(2) count(2)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries = b""
    blobs = b""
    for s, data in images:
        dim = 0 if s >= 256 else s  # 256 在 ICONDIRENTRY 里用 0 表示
        # ICONDIRENTRY: w h colors reserved planes bpp size offset
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)

    with open(path, "wb") as fh:
        fh.write(header + entries + blobs)


# --------------------------------------------------------------------------
# NSIS 图片
# --------------------------------------------------------------------------


def _find_font(names: list[str]) -> str | None:
    fonts = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    for name in names:
        path = os.path.join(fonts, name)
        if os.path.exists(path):
            return path
    return None


def write_installer_sidebar(path: str) -> None:
    """164x314 的竖图，出现在向导的欢迎页和完成页左侧。"""
    w, h = 164, 314
    img = Image.new("RGB", (w, h))
    strip = diagonal_gradient(h, BRIGHT, PURPLE)
    for y in range(h):
        row = strip.getpixel((0, y))
        for x in range(w):
            img.putpixel((x, y), row)

    logo = render_bare_c(112)
    img.paste(logo, ((w - 112) // 2, 58), logo)

    # 中文得用雅黑；退化到 Segoe UI / Arial 的话中文会变方块
    font_path = _find_font(["msyhbd.ttc", "msyh.ttc", "seguibl.ttf", "arialbd.ttf"])
    draw = ImageDraw.Draw(img)
    if font_path:
        f_name = ImageFont.truetype(font_path, 15)
        f_cn = ImageFont.truetype(font_path, 16)
        f_ver = ImageFont.truetype(font_path, 11)
    else:  # pragma: no cover
        f_name = f_cn = f_ver = ImageFont.load_default()

    for text, font, y, color in (
        (APP_NAME_LINES[0], f_name, 192, WHITE),
        (APP_NAME_LINES[1], f_cn, 214, WHITE),
        (VERSION, f_ver, 250, SUBTLE),
    ):
        tw = draw.textlength(text, font=font)
        draw.text(((w - tw) / 2, y), text, font=font, fill=color)

    draw.line([(w * 0.25, 286), (w * 0.75, 286)], fill=(150, 170, 255), width=1)
    img.save(path, "BMP")


def write_installer_header(path: str) -> None:
    """
    150x57 的页头小图。

    NSIS 的 BMP 没有透明度，向导页头又是白的 —— 所以白 C 直接画会看不见，
    得先垫一个渐变的圆角小方块。
    """
    w, h = 150, 57
    img = Image.new("RGB", (w, h), (255, 255, 255))
    box, pad = 38, 12
    x, y = w - box - pad, (h - box) // 2

    tile = diagonal_gradient(box, BRIGHT, PURPLE).convert("RGBA")
    tile.putalpha(rounded_rect_mask(box))
    img.paste(tile, (x, y), tile)
    c = render_bare_c(box)
    img.paste(c, (x, y), c)
    img.save(path, "BMP")


# --------------------------------------------------------------------------


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    res = os.path.join(root, "resources")
    os.makedirs(res, exist_ok=True)

    ico = os.path.join(res, "icon.ico")
    write_ico(ico, [16, 24, 32, 48, 64, 128, 256])
    print(f"  icon.ico              {os.path.getsize(ico) / 1024:.1f} KB  (7 个尺寸)")

    png = os.path.join(res, "icon.png")
    render_icon(512).save(png, "PNG")
    print(f"  icon.png              {os.path.getsize(png) / 1024:.1f} KB  (512x512)")

    bar = os.path.join(res, "installerSidebar.bmp")
    write_installer_sidebar(bar)
    print(f"  installerSidebar.bmp  {os.path.getsize(bar) / 1024:.1f} KB  (164x314)")

    head = os.path.join(res, "installerHeader.bmp")
    write_installer_header(head)
    print(f"  installerHeader.bmp   {os.path.getsize(head) / 1024:.1f} KB  (150x57)")

    print("\n改完记得重新打包：npm run dist:installer")


if __name__ == "__main__":
    main()
