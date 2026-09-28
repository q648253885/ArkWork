#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""清理 app/release/ 下的**旧版本**构建产物（v0.40.0 新产物一律保留）。

安全约束：
  ① 只处理 `app/release/` 顶层文件 + 已知的构建临时目录，**不递归**任何源码目录；
  ② 只删文件名匹配 `ArkWork-*` / `ArkWork-Portable-*` / `ArkWork-Setup-*` 且
     版本段**不是** KEEP 的产物（含 `.blockmap` 伴生文件）；
  ③ 目录 `mac/`（本次交付的 .app）与 `win-unpacked/`（若存在）按 KEEP_DIRS 处理；
  ④ 先打印清单（含大小与合计），再执行；每一步都有前缀二次校验。
"""
import io
import json
import os
import re
import shutil
import sys

# 本脚本位于 app/scripts/ 下 → 向上两级即 app/，release 是它的子目录
RELEASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "release")
# 当前交付版本：默认读 app/package.json 的 version（唯一版本真源），可用 --keep 覆盖
def _default_keep():
    try:
        with io.open(os.path.join(os.path.dirname(RELEASE), "package.json"), encoding="utf-8") as f:
            return json.load(f)["version"]
    except Exception:
        return "0.0.0"


KEEP = _default_keep()
# 交付目录：本次要保留的 .app 就在这里（不递归，只按名字放行）
KEEP_DIRS = {"mac"}

# 可安全重建的构建中间/临时目录。`win-unpacked/` 是 electron-builder 解包后的
# Windows 目录（里面就是 ArkWork.exe 等可执行文件）—— 用户明确要求清掉旧可执行
# 文件，且它下次打 win 包时会重新生成。
TMP_DIRS = {".icon-ico", "win-unpacked", ".DS_Store"}
# electron-builder 打包失败留下的陈旧快照目录（实测 5 个，最早 09-26）
STALE_PREFIX = "_stale-"
# 过期的构建快照与自动更新清单（新打包会重建）
STALE_FILES = {"latest-mac.yml", "latest.yml", "builder-debug.yml", "builder-effective-config.yaml"}

PAT = re.compile(r"^ArkWork-(?:Portable-|Setup-)?([0-9]+\.[0-9]+\.[0-9]+).*\.(dmg|zip|exe|blockmap|yml)$")


def human(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024 or u == "GB":
            return f"{n:.1f} {u}" if u != "B" else f"{n} B"
        n /= 1024


def main():
    if not os.path.isdir(RELEASE):
        print("release 目录不存在：", RELEASE)
        sys.exit(1)

    victims = []
    kept = []
    for name in sorted(os.listdir(RELEASE)):
        p = os.path.join(RELEASE, name)
        if os.path.isdir(p):
            size = sum(os.path.getsize(os.path.join(r, f))
                       for r, _, fs in os.walk(p) for f in fs)
            if name in TMP_DIRS:
                victims.append((p, size, "构建中间目录（可重建）"))
            elif name.startswith(STALE_PREFIX):
                victims.append((p, size, "打包失败留下的陈旧快照"))
            elif name in KEEP_DIRS:
                kept.append((name, "★ 交付目录（保留）"))
            else:
                kept.append((name, "目录（保留）"))
            continue
        if name in STALE_FILES:
            victims.append((p, os.path.getsize(p), "过期构建快照/更新清单"))
            continue
        m = PAT.match(name)
        if not m:
            kept.append((name, "未匹配产物命名（保留）"))
            continue
        ver = m.group(1)
        size = os.path.getsize(p)
        if ver == KEEP:
            kept.append((name, "★ 当前版本（保留）"))
        else:
            victims.append((p, size, f"旧版本 v{ver}"))

    total = sum(s for _, s, _ in victims)
    print(f"=== 待删除（{len(victims)} 项，合计 {human(total)}）===")
    for p, s, why in victims:
        print(f"  {human(s):>10}  {os.path.basename(p):<44} ({why})")
    print()
    print(f"=== 保留（{len(kept)} 项）===")
    for n, why in kept:
        print(f"  {'':>10}  {n:<44} ({why})")

    if "--dry-run" in sys.argv:
        print("\n[dry-run] 未执行删除")
        return

    removed = 0
    for p, _, _ in victims:
        base = os.path.basename(p)
        real = os.path.realpath(p)
        # 二次校验：必须在 RELEASE 下、且名字符合产物命名或已知临时目录
        if os.path.dirname(real) != os.path.realpath(RELEASE):
            print("  跳过（不在 release 根）：", p)
            continue
        if not (PAT.match(base) or base in TMP_DIRS or base in STALE_FILES
                or base.startswith(STALE_PREFIX)):
            print("  跳过（命名不符）：", base)
            continue
        if base in KEEP_DIRS:
            print("  跳过（交付目录）：", base)
            continue
        if PAT.match(base) and PAT.match(base).group(1) == KEEP:
            print("  跳过（当前版本）：", base)
            continue
        try:
            if os.path.isdir(real):
                shutil.rmtree(real)
            else:
                os.remove(real)
            removed += 1
        except OSError as e:
            print(f"  删除失败 {base}: {e}")

    print(f"\n已删除 {removed} 项，释放 {human(total)}")
    print("=== 删除后 release/ 顶层 ===")
    for name in sorted(os.listdir(RELEASE)):
        p = os.path.join(RELEASE, name)
        if os.path.isdir(p):
            print(f"  [dir]  {name}")
        else:
            print(f"  {human(os.path.getsize(p)):>10}  {name}")


if __name__ == "__main__":
    main()
