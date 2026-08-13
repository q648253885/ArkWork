#!/usr/bin/env python3
"""
ArkWork — 应用图标生成器 v4（胖 A + 笑脸）
读取：build-resources/icon-source.svg 中规定的几何规范
输出：build-resources/icon.png 1024×1024
      build-resources/icon_1x.png 256×256
      build-resources/icon_2x.png 512×512
      build-resources/icon-16.png
      build-resources/icon-32.png
      build-resources/icon-128.png
      build-resources/icon.iconset/icon_*.png（macOS .iconset，供 iconutil 转换 .icns）
      app/src/renderer/assets/brand/arkwork-icon.svg  （应用内主品牌 SVG）
      app/src/renderer/assets/brand/arkwork-icon.png  （应用内主品牌 PNG）

设计原则（与 icon-source.svg 严格对应）：
- 风格：浅色底 + 黑色实心 logo（Trae / MiniMax Code 类）
- 背景：#EEF0FF（淡紫白）squircle rx=22.5%
- 主标记：#0F0F12（深炭黑）实心 A + 圆角胖造型
- 笑脸：与背景同色，用负空间呈现
"""
from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]  # build-resources/
ASSETS = ROOT.parent / "src" / "renderer" / "assets" / "brand"


# ---------- 颜色 ----------
BG_COLOR = (238, 240, 255, 255)   # #EEF0FF
MARK_COLOR = (15, 15, 18, 255)    # #0F0F12


# ---------- 几何（1024 坐标系，与 icon-source.svg 严格对应） ----------
# A 字母外轮廓（顺时针）
A_OUTER = [
    (220, 856),   # 左下脚外
    (470, 232),   # 左斜上
    (512, 168),   # 顶部圆弧顶点
    (554, 232),   # 圆弧下到右斜
    (804, 856),   # 右下脚外
    (644, 856),   # 右下脚内
    (596, 720),   # 横线右
    (428, 720),   # 横线左
    (380, 856),   # 左下脚内
]

# A 字母横线上方镂空三角（让 A 中间有个洞）
A_INNER = [
    (512, 384),   # 顶部尖
    (600, 660),   # 右下
    (424, 660),   # 左下
]

# 笑脸
EYE_L = (448, 512, 22)  # cx, cy, r
EYE_R = (576, 512, 22)

# 嘴（弧形）—— 二次贝塞尔控制点
MOUTH_P0 = (462, 580)   # 起点
MOUTH_P1 = (512, 632)   # 第一段 Q 控制点
MOUTH_P2 = (562, 580)   # 第一段 Q 终点 / 第二段 Q 起点
MOUTH_P3 = (512, 610)   # 第二段 Q 控制点（回程）
MOUTH_P4 = (462, 580)   # 第二段 Q 终点


# ---------- 工具函数 ----------
def squircle_mask(size: int, radius_ratio: float = 0.225) -> Image.Image:
    """macOS 风格 squircle 遮罩：rounded_rectangle 近似"""
    r = int(size * radius_ratio)
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=255)
    return mask


def draw_a(size: int) -> Image.Image:
    """在 1024 坐标系下画 A 字母（实心黑，镂空上方三角）"""
    s = size / 1024.0
    outer = [(int(x * s), int(y * s)) for x, y in A_OUTER]
    inner = [(int(x * s), int(y * s)) for x, y in A_INNER]

    # 用 alpha mask 复合：外多边形填黑，内多边形镂空
    final_mask = Image.new("L", (size, size), 0)
    fmd = ImageDraw.Draw(final_mask)
    fmd.polygon(outer, fill=255)
    fmd.polygon(inner, fill=0)
    a_filled = Image.new("RGBA", (size, size), MARK_COLOR)
    a_filled.putalpha(final_mask)
    return a_filled


def draw_face(size: int) -> Image.Image:
    """画笑脸（眼睛 + 嘴），用与背景同色"""
    s = size / 1024.0
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 眼睛
    for cx, cy, r in [EYE_L, EYE_R]:
        cx_s = int(cx * s)
        cy_s = int(cy * s)
        r_s = max(1, int(r * s))
        d.ellipse((cx_s - r_s, cy_s - r_s, cx_s + r_s, cy_s + r_s), fill=BG_COLOR)

    # 嘴（解析 path 中的 M/Q 命令，缩放坐标后重画）
    mouth_pts = []
    cur = None
    for cmd in MOUTH_OUTLINE.replace("Z", "").split():
        if cmd == "M":
            cur = "M"
        elif cmd == "Q":
            cur = "Q"
        elif cmd in ("L",):
            cur = "L"
        else:
            x, y = map(float, cmd.split(","))
            x_s, y_s = x * s, y * s
            mouth_pts.append((x_s, y_s))

    # 直接按 path 节点画（Q 二次贝塞尔采样）
    if len(mouth_pts) >= 6:
        # M P0 Q P1 P2 Q P3 P4  →  P0(0), P1(1), P2(2), P3(3), P4(4)
        p0, p1, p2, p3, p4 = mouth_pts[:5]
        # 采样第一个 Q 曲线
        samples1 = []
        for t_i in range(0, 41):
            t = t_i / 40
            x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0]
            y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1]
            samples1.append((x, y))
        # 采样第二个 Q 曲线（回程）
        samples2 = []
        for t_i in range(0, 41):
            t = t_i / 40
            x = (1 - t) ** 2 * p2[0] + 2 * (1 - t) * t * p3[0] + t ** 2 * p4[0]
            y = (1 - t) ** 2 * p2[1] + 2 * (1 - t) * t * p3[1] + t ** 2 * p4[1]
            samples2.append((x, y))
        # 闭合
        polygon = samples1 + samples2
        d.polygon(polygon, fill=BG_COLOR)

    return layer


def render(size: int) -> Image.Image:
    """合成最终图标：squircle 背景 + A 字母 + 笑脸"""
    # 1. 背景 squircle
    mask = squircle_mask(size, 0.225)
    bg = Image.new("RGBA", (size, size), BG_COLOR)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), mask)

    # 2. A 字母
    a_layer = draw_a(size)
    canvas.alpha_composite(a_layer)

    # 3. 笑脸
    face_layer = draw_face(size)
    canvas.alpha_composite(face_layer)

    return canvas


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG", optimize=True)
    print(f"[icon] wrote {path}  ({img.size[0]}x{img.size[1]})")


def write_in_app_svg() -> None:
    """将源 SVG 复制到应用内 assets，便于 renderer 引用"""
    src = ROOT / "icon-source.svg"
    dst = ASSETS / "arkwork-icon.svg"
    ASSETS.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(src.read_bytes())
    print(f"[icon] wrote {dst}")


def write_in_app_png() -> None:
    """renderer/assets/brand/arkwork-icon.png = 256px 主源"""
    dst = ASSETS / "arkwork-icon.png"
    save_png(render(256), dst)


def main():
    sizes = [
        (1024, ROOT / "icon.png"),
        (512, ROOT / "icon_2x.png"),
        (256, ROOT / "icon_1x.png"),
        (16, ROOT / "icon-16.png"),
        (32, ROOT / "icon-32.png"),
        (128, ROOT / "icon-128.png"),
    ]
    for size, path in sizes:
        save_png(render(size), path)

    # .iconset：macOS 多分辨率，供 iconutil 生成 .icns
    iconset = ROOT / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    iconset_sizes = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for size, name in iconset_sizes:
        save_png(render(size), iconset / name)

    # 应用内品牌资源
    write_in_app_svg()
    write_in_app_png()

    print("[icon] done")


if __name__ == "__main__":
    main()
