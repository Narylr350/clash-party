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

- 更新策略：官方更新**仅提示不安装**；维护 = 合并上游正式版并重新 `pnpm build:win --x64`。保留旧安装包、交付新版安装包供用户手动安装，不自动退出或替换当前运行的应用与内核。
- TUN 稳定运行依赖四项配置：`tun.auto-detect-interface: false`、`tun.route-exclude-address`（含 10/8、172.16/12、192.168/16、169.254/16、210.47.178/24）、顶层 `interface-name`（钉园区以太网卡）、`dns.nameserver-policy`（`+.bhu.edu.cn` → 校园 DNS，需同时开 `useNameserverPolicy`）；配置重置后需重新应用，可全部通过 MCP 完成。
- 主进程（ESM 输出）新增 import 时，包必须在 `dependencies`（用 `pnpm add`）——不在依赖里的包会被打包进 bundle，可能注入 CJS interop shim（`const __dirname = import.meta.dirname`）触发 TDZ 崩溃（已实际发生：zod 未入 deps 导致启动崩溃）。
- 执行层 skill：`mcp-builder`；未接入 finish 层 skill。
- 上游 README / docs / CI / changelog 为上游参考，不作为本项目进度事实源；本项目不维护上游 README/changelog。
- 用户已授权：每轮任务完成且验证通过后，自动提交并推送本轮归属明确的改动。发现历史未提交改动时，先核对归属和完成度；能确认且验证通过的，按独立主题提交推送，不与本轮无关改动混合。归属不明、仍在进行或验证失败的改动保留并说明，不擅自丢弃或推送。发布 release 仍需用户明确要求。
- Maintenance Surface：`package.json`（依赖/版本）、`electron-builder.yml`（构建配置）。
- 无线优先只检查物理 Wi-Fi 的连接、IPv4 与默认路由，不读取 SSID、不要求定位、不做外部探测；手机无信号但 Wi-Fi 仍连接时不会自动回退。有线和无线都连接时代理走无线、直连走有线；仅剩无线时允许直连临时使用无线。
- 无线优先不改变受控 DNS/TUN 设置和 Windows 全局网卡跃点。关闭时恢复原配置生成结果；动态出口也必须纳入现有 TUN 回环保护。切换失败不得循环重启核心；只主动关闭受影响的代理连接。
