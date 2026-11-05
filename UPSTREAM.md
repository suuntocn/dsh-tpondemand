# 来源与适配说明

## 来源

本项目的 `src/*.mjs` 与六个上游测试文件改编自内部 `targetprocess-mcp` v2.0.0（Targetprocess MCP，基于官方 MCP TypeScript SDK 2.3.1）。

上游项目本身为内部私有工程、未单独声明许可证。本仓库的 MIT 许可（见 [LICENSE](LICENSE)）由版权持有者 suuntocn 授予**本仓库的封装与文档**；上游实现逻辑的著作权仍归其原作者。

公开前已清理内部信息：原测试中的内网 GitLab 地址已替换为 `gitlab.example.com` 示例域名。

## 适配范围

保持上游行为不变的前提下，仅做以下改动：

- **提取 `registerTools` 共享注册函数**：原 stdio `createServer` 与本插件的 Host 适配器走同一注册路径，未访问 MCP SDK 私有注册表。
- **移除隐式凭据**：删除固定租户默认值与 macOS 钥匙串自动读取；配置只来自插件设置。保留仅供独立协议测试使用的显式环境变量入口。
- **配置提示改写**：由「运行配置脚本」改为「在 DSH 插件设置中填写」。
- **结果适配**：使用 DSH 公共 `createMcpToolDefinition` 保留标准 MCP 结果与图片投递；参数校验仍由上游 Zod schema 负责，对外 JSON Schema 以 input 模式导出，保留可省略的默认值。
- **连接与计划**：连接配置按调用读取（保存即生效），预览计划按会话隔离，连接变化即作废旧计划。
- **权限边界**：写入与文件类工具要求 DSH 审批（仅接受一次性授权），文件类工具还要求完整文件访问模式。
- **脱敏加固**：结果文本额外经上游 sanitizer 处理（含 URL 编码形式）；图片 base64 不做字符串替换。
- **状态目录**：从包内 `.local-state` 移至 `~/.dsh-targetprocess/state`；不自动迁移或清理旧状态。

## 第三方许可证

依赖许可证由各依赖包保留：

| 依赖 | 许可证 |
|---|---|
| `@modelcontextprotocol/server` | Apache-2.0 |
| `zod` | MIT |
| `@deepseek-ai/schemastery` | MIT |
| `@deepseek-ai/dsh-mcp-client` | MIT |

图标为本项目原创的目标图案，**并非** Targetprocess 官方商标或标识。
