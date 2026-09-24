# Clash Party MCP 外部控制（自用 fork）

## Goal

在 Clash Party（mihomo-party）的自用 fork 中内置 MCP 服务器，让 AI 通过 App 自身的逻辑读写设置与运行状态，替代"直接改配置文件 / 绕过 App 的内核 API 写操作"这类会破坏状态一致性的做法。

## Users and Scenarios

- 用户本人（Narylr）与其 AI 工具（opencode）。
- 场景：AI 需要查看或调整 Clash Party 配置（TUN、DNS、节点、系统代理、订阅等）时，经 MCP 调用 App 内部函数完成；改动在 App UI 可见、可持久化，App 不会因状态不一致而崩溃。

## MVP

- App 主进程内嵌 MCP 服务器：仅监听 127.0.0.1，Streamable HTTP，Bearer token 鉴权。
- 只读工具：运行状态、App 配置、受控内核配置、连接、核心日志、订阅列表。
- 写工具（全部调用 App 现有函数）：App 设置、内核设置（含 TUN/DNS）、内核启停/重启、订阅切换、节点切换、系统代理开关、TUN 开关。
- 设置页新增 MCP 卡片：开关 + 端口 + token 显示/复制。
- opencode 通过 remote MCP 接入，完成一次"改设置 → UI 同步 → 重启内核不丢"的闭环验证。

## Inputs and Outputs

- 输入：opencode 发来的 MCP 工具调用（HTTP JSON-RPC + Bearer token）。
- 输出：JSON 结果（状态/配置/连接/日志）；副作用为 App 设置、内核设置与运行状态变更（经 App 函数持久化到 App 配置）。
- 数据来源：App 内部状态 + App 已封装的 mihomo 内核接口。

## Non-goals

- 不做独立 MCP 服务器（旁路内核 API 路线已否决）。
- 不直接编辑任何配置文件。
- MVP 不含破坏性操作（重置配置、删除订阅/覆写）。
- 不做 macOS / Linux 构建。
- 不向上游提 PR、不发布 release、不维护上游 README/changelog。
- 不改上游现有 UI 结构与既有功能。
- 未接入 finish 层 skill。

## Seed Tasks

1. 跑通构建链：`pnpm install` → `pnpm prepare --x64` → `pnpm build:win --x64`，产出 7z 免安装版并启动成功（先不接 MCP）。
2. 实现 MCP 服务器模块（`src/main/mcp/`）：Streamable HTTP + token + 工具注册，先接 3 个只读工具（状态/配置/连接）并随 App 启停。
3. 接入写操作工具：App 设置、内核设置、内核启停/重启、订阅切换、节点切换、系统代理/TUN 开关。
4. 设置页 MCP 卡片：开关 + 端口 + token（zh-CN/en-US 文案）。
5. opencode 接入与联调：注册 remote MCP，验证只读与写工具，完成持久化闭环。
