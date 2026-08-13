# bugfix

目标驱动多轮续跑缺陷修复技能。用户提供 bug 现象（symptom）、复现路径（repro，可选）与期望行为（expected）后：

1. 技能自动解析为可验证目标（Given/When/Then 形式）与验收标准（测试断言 / 行为校验）。
2. 进入多轮续跑循环：**评估当前状态 → 决定下一步修复动作（LLM）→ 执行修复（shell / file tools / 委派编码 Agent）→ 验证目标（跑测试/检查）**。
3. 验证达成验收标准即停止（status=achieved）；推进路径耗尽（LLM 判定无新路径）停止（status=exhausted）；⌘K 切到「单 attempt 模式」时只走单轮定位→修复→验证，未达成直接汇报不静默重试（status=failed）。
4. 工具执行失败走容错 5 档链路（重试 → 替代方案 → 影响分析 → 用户决策 / 继续）。
5. 产物落盘 `<workspace>/.arkwork/bugfix/<taskName>/`：goal.md、attempts.jsonl、diff.patch、result.md。

## 使用方式

调用参数：

- `symptom`（必填）：bug 现象描述
- `repro`（可选）：复现路径 —— 可直接给命令（如 `` `npm run build` ``），也可给步骤描述
- `expected`（必填）：期望行为
- `taskName`（可选）：产物目录名（缺省由 symptom 派生）

## 输出

返回 `{ goal, status, attempts, diffSummary, testOutput, resultDir }`，并推送 `bugfix:progress` 进度事件（goal-defined → fixing → verifying → achieved / not-achieved）供 Inspector 操作岛台实时刷新。
