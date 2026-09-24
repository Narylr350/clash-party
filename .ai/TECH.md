# Tech Direction

- 基于上游 `mihomo-party-org/clash-party`（fork，主线分支 `smart_core`，版本 2.0.3），沿用其 Electron + React + TypeScript + electron-vite + electron-builder 构建链。
- MCP 服务器：内嵌 App 主进程的 TypeScript 模块，使用 `@modelcontextprotocol/sdk` 的 Streamable HTTP（stateless），仅监听 127.0.0.1，Bearer token 鉴权；端口与 token 存 App 配置，设置页可见。
- 写入路径：只调用 App 现有函数（`patchAppConfig`、`patchControledMihomoConfig`、核心管理器、`mihomoApi` 等）；不直接读写配置文件、不直连内核写接口。
- 模块边界：新增 `src/main/mcp/`（服务器与工具）；生命周期在 App 启动/退出时启停；设置页新增独立卡片，不改既有卡片逻辑。
- 新增依赖：`@modelcontextprotocol/sdk`（经 pnpm 添加，不手改 lockfile）。
- 交付：Windows 7z 免安装产物，与官方版并存；appId / 名称 / 配置目录不改（共用 `%APPDATA%\mihomo-party`，两版不能同时运行）。

已确认：fork 方案；7z 免安装版并存；只接 mcp-builder skill。
