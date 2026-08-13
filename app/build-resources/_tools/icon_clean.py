#!/usr/bin/env python3
"""最终处理:flood-fill 移除白底 → 检查内容 bbox → 若贴边则缩至 88% 居中留边距 → 输出透明 PNG。"""
from PIL import Image
from collections import deque

SRC = "/Users/gongzheng/ai/ArkWork/app/build-resources/icon-variant-2-smile.png"
DST = "/Users/gongzheng/ai/ArkWork/app/build-resources/_tools/icon-smile-final.png"
TOLERANCE = 120
SCALE = 0.88  # 内容缩放到画布的 88%,四周留 6% 透明边距

im = Image.open(SRC).convert("RGBA")
w, h = im.size
px = im.load()

corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
corner_colors = [px[x, y] for x, y in corners]
print("corner colors:", corner_colors)

visited = [[False] * w for _ in range(h)]
dq = deque()
for (cx, cy), bg in zip(corners, corner_colors):
    if not visited[cy][cx]:
        visited[cy][cx] = True
        dq.append((cx, cy, bg[:3]))

def close(c1, c2):
    return (c1[0]-c2[0])**2 + (c1[1]-c2[1])**2 + (c1[2]-c2[2])**2 <= TOLERANCE**2

removed = 0
while dq:
    x, y, bg = dq.popleft()
    r, g, b, a = px[x, y]
    if a and close((r, g, b), bg):
        px[x, y] = (r, g, b, 0)
        removed += 1
        for nx, ny in ((x+1, y), (x-1, y), (x, y+1), (x, y-1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[ny][nx]:
                visited[ny][nx] = True
                dq.append((nx, ny, bg))
print("removed:", removed)

bbox = im.getbbox()
print("bbox after flood:", bbox)

content_w = bbox[2] - bbox[0]
content_h = bbox[3] - bbox[1]
margins = (bbox[0], bbox[1], w - bbox[2], h - bbox[3])
print("content:", content_w, "x", content_h, "margins:", margins)

final = im
if min(margins) < int(w * 0.015):
    print(f"content touches edge -> scaling to {SCALE*100:.0f}% centered")
    size = (int(w * SCALE), int(h * SCALE))
    final = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    layer = im.resize(size, Image.LANCZOS)
    final.paste(layer, ((w - size[0]) // 2, (h - size[1]) // 2), layer)

print("final bbox:", final.getbbox())
final.save(DST)
print("saved:", DST)
