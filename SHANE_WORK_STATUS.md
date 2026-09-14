# Shane Work 状态

## 已封板阶段

- Stage 1：基础工作时钟、班次状态、持久化、Heartbeat tick 接入 —— PASS
- Stage 2A：公司世界、设备、NPC 基础、onboarding、普通活动、familiarity —— PASS
- Stage 2B：低频故障事件、event ID、生命周期、WAITING_PARTS、跨日/周末/重启连续性、pending 上限、确定性事件候选日调度 —— PASS
- Stage 2C：计划任务与日常工作流、task 生命周期、task/event 抢占、RECHECK、普通 task 调度、跨午休/下班恢复、task familiarity —— PASS
- Stage 2D：on-call 轮值、低频 off-hours emergency、CALL_OUT、受上限保护的 OVERTIME、工时持久化与跨重启去重、TEMP_FIXED 后续 RECHECK —— PASS
- Stage 2D.1：George / Miguel 值班 off-hours emergency 的客观 response 留痕、稳定 event 关联与重启去重 —— PASS
- Stage 2E：全天请假、LEAVE 状态、task/event 暂停与恢复、onboarding 排除、有效值班 responder fallback —— PASS
- Knowledge Layer：World facts 与 Shane known facts 分离、allowlist snapshot、稳定 fact_key 去重与本人实际接触渠道 —— PASS
- Heartbeat × Shane Work 合流：单一 `runWakeUp()` 出口、已知 serious Work event / CALL_OUT 请求、PENDING/IN_FLIGHT/COMPLETED 生命周期、15 分钟 dispatch cooldown、knowledge allowlist 上下文、普通 wake 合并与重试去重 —— PASS
- Canteen Menu V1：工作日确定性早餐/午餐供应菜单、周末无员工菜单、零运行时持久化与零角色进食事实 —— PASS

Stage 2B 最终包含 2B.1 / 2B.2 修正；Stage 2C 最终包含 2C.1 修正。Stage 2D 已完成 hard-deadline 截断、跨重启去重与时间边界验收。Stage 2D.1 仅记录其他值班人的客观 response，不代表 Shane 自动知道该事件。当前代码为封板版本。

## 当前明确未实现

- overtime / on-call（已实现 2D 的受上限 OVERTIME、on-call 与 CALL_OUT；不包含 2D.1 的后续可见性/传播）
- 主动分享
- MCP / OB / Kelivo 状态注入
- GM / 人物化事件
- 工资、银行、inventory、经济系统
- UI / API / 桌宠本体

以上仅为阶段边界记录，不代表后续计划或实现。

## 已知技术债

`runtime_paths.test.js` 在 Windows 环境下存在路径分隔符断言问题：测试预期 `/tmp/custom-data`，而 Windows `path.join` 返回 `\tmp\custom-data`，导致当前 `node --test` 为 46/47。该问题与 Shane Work 功能无关，Railway Linux 运行不受影响。优先级 LOW，暂不修复，后续进行跨平台测试清理时处理。

## 规则

- 本文件只是开发状态/技术债记录，不是运行时数据。
- Shane Work 不读取本文件。
- 不加入运行时 prompt。
- 不写入 Railway Volume。
- 不修改任何 `.js` 文件。
- 不进入 2D。
