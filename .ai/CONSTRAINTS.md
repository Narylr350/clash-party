# Constraints and Working Rules

## 上游项目指令（继承）

- 提交必须通过 `format:check` / `lint:check` / `typecheck`，不得绕过 git hooks（`--no-verify` 等）。
- 不改 `pnpm-lock.yaml`（依赖改动走 pnpm）；不改 `extra/sidecar/`、`node_modules/.temp/`（`scripts/prepare.mjs` 生成）。

## 全局指令与本项目的关系

- 全局 `AGENTS.md` 的「Clash Party 保护」继续有效：禁止直接编辑 `%APPDATA%\mihomo-party` 下配置文件、禁止未经授权的内核 API 写操作。
- 本项目产出的 MCP 是用户明确授权的"通过 App 改设置"通道；MCP 可用后，设置读写走它或 App UI。

## 交付与运行

- 自编译版以 7z 免安装形式与官方版并存；共用配置目录，不能同时运行（测试前先关官方版）。
- 分支 `smart_core`（fork 默认分支）为项目主线。
- 构建需要 GitHub 网络访问（下载 mihomo 内核与原生绑定），必要时走本机代理。

## 工作规则

- 更新策略：官方更新**仅提示不安装**；维护 = 同步上游 `mihomo-party-org/clash-party` 后重新 `pnpm build:win --x64` 并热替换安装（先退应用与内核，装完重启）。
- 主进程（ESM 输出）新增 import 时，包必须在 `dependencies`（用 `pnpm add`）——不在依赖里的包会被打包进 bundle，可能注入 CJS interop shim（`const __dirname = import.meta.dirname`）触发 TDZ 崩溃（已实际发生：zod 未入 deps 导致启动崩溃）。
- 执行层 skill：`mcp-builder`；未接入 finish 层 skill。
- 上游 README / docs / CI / changelog 为上游参考，不作为本项目进度事实源；本项目不维护上游 README/changelog。
- 未经用户明确要求，不 commit / push / release。
- Maintenance Surface：`package.json`（依赖/版本）、`electron-builder.yml`（构建配置）。
