# Validation

- 提交前（仓库 hook 同款）：`pnpm run format:check && pnpm run lint:check && pnpm run typecheck`。
- 构建：`pnpm prepare --x64 && pnpm build:win --x64` 产出 7z；解压后能启动 App。
- MCP 功能：opencode 侧能列出并调用工具；只读工具返回与 App UI 一致的数据；写工具改动后 App UI 同步、重启内核后设置保留（持久化闭环）。
- 回归：MCP 关闭时 App 行为与官方版一致（不崩、日志无新增报错）。
- 环境规则：构建依赖 GitHub（走代理）；自编译版与官方版共用配置目录，测试前关闭官方版。
