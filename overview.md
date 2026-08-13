# ArkWork v0.17.0 — UI 视觉与交互大升级（v4.2 暖夜色 + 紫罗兰）

> **日期** 2026-08-12 ｜ **状态** 设计完成，待用户视觉确认
> **v4.2 重制**：v4.1（GitHub 冷黑 + Indigo）被用户反馈"比之前难看"。回归暖夜色 + 紫罗兰，取「有温度的深色」路线。

---

## 本次做了什么

- **色板** — 深色 `#17171C 暖夜色`（微暖、柔和，非纯黑）+ 主色 `#8B5CF6 紫罗兰`（深邃耐看）
- **圆角** — 加大到 16/20px 现代感，对齐 Trae Work / Arc
- **交互区** — 思考块（3px 紫罗兰条 + 流式光晕）/ ToolCard 5 态 / TodoPanel / Shell（#121216 深底）
- **Composer** — 圆角 20 + 玻璃感；用户气泡紫罗兰 soft 底
- **图标** — 全部 SVG，零 emoji

## 交付物清单

| 路径 | 用途 |
|------|------|
| `docs/versions/v0.17.0/README.md` | 文档导航 |
| `docs/versions/v0.17.0/01-prd.md` | 目标 /范围 |
| `docs/versions/v0.17.0/02-ui-diagnosis.md` | 12 项问题清单 |
| `docs/versions/v0.17.0/03-ui-design-v4.md` | v4.2 设计方案 |
| `docs/versions/v0.17.0/04-design-tokens.css` | **可直接复制到 globals.css 的 token** |
| `docs/versions/v0.17.0/prototype/index.html` | **设计基准总览（先看）** |
| `docs/versions/v0.17.0/prototype/page-01-home.html` | Home · 空态 |
| `docs/versions/v0.17.0/prototype/page-02-task.html` | **Task · 对话流（交互区完整）** |
| `docs/versions/v0.17.0/prototype/page-03-settings.html` | Settings |
| `docs/versions/v0.17.0/prototype/page-04-agent-editor.html` | Agent Editor · 宽弹窗 |

## 关键决策（v4.1 → v4.2）

| 维度 | v4.1（被否） | v4.2 |
|------|------|------|
| 深色 canvas | `#0D1117` 冷黑 | `#17171C` 暖夜色 |
| 主色 | `#6366F1` Indigo | `#8B5CF6` 紫罗兰 |
| 浅色 canvas | `#FAFBFC` | `#F7F6F4` 微暖白 |
| 卡片圆角 | 12px | 16 / 20px |
| 用户气泡 | 灰底 | 紫罗兰 soft 底 |
| Composer | r=12 | r=20 + 玻璃感 |
| Shell | #0D1117 | #121216 更深 |

## 视觉确认路径

1. **打开 `prototype/index.html`** — 顶部右侧「浅色」切双主题
2. **看交互区预览** — 思考块 / ToolCard 5 态 / TodoPanel / Shell 完整样例
3. **打开 `prototype/page-02-task.html`** — 真实对话流，交互区完整呈现
4. 依次看 Home / Settings / Agent Editor

## 下一步（编码阶段，本次不做）

视觉确认后：冻结原型 → 按 `04-design-tokens.css` 升级 globals.css → 按设计方案逐组件实施 → UI 测试。

## 不做的事

- ❌ 不重构三栏骨架 / 不动交互逻辑 / 不引入新依赖 / 不编码