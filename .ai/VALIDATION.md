# Validation

- 提交前（仓库 hook 同款）：`pnpm run format:check && pnpm run lint:check && pnpm run typecheck`。
- 构建：`pnpm prepare --x64 && pnpm build:win --x64` 产出 7z/setup；冒烟测试用 `PORTABLE` 标记隔离数据目录，避免触碰真实配置。
- MCP 功能：opencode 侧能列出并调用工具；只读工具返回与 App UI 一致的数据；写工具改动后 App UI 同步、重启内核后设置保留（持久化闭环）。
- 回归：MCP 关闭时 App 行为与官方版一致（不崩、日志无新增报错）。
- 环境规则：构建依赖 GitHub（走代理）；自编译版与官方版共用配置目录，**绝不能与官方版同时运行**——自编译版启动时会检测到官方高权限内核，按其设计停掉内核并提权重启；测试/联调前必须关闭官方版，或与用户确认后再开。
