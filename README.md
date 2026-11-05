# Targetprocess for DeepSeek Harness

把 Targetprocess 接入 DeepSeek Harness 的原生插件：在插件设置里填 **URL + Token** 即可用自然语言查询工作项、读取附件，并在修改数据前先预览确认。

A native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for Targetprocess. Configure a tenant URL and a Personal Access Token in the plugin settings, then query work items, read attachments, and preview changes before applying them.

- **32 个工具**，保留原 MCP 的参数定义、结果格式与安全语义
- **无独立进程**：不启动 stdio MCP 子进程，工具直接注册进 Host
- **中英双语设置表单**，Token 走 DSH secret 机制
- **73 项自动化测试**（含上游回归）

---

## 目录

- [功能特性](#功能特性)
- [系统要求](#系统要求)
- [安装](#安装)
- [配置 URL 与 Token](#配置-url-与-token)
- [工具清单](#工具清单)
- [典型用法](#典型用法)
- [安全模型](#安全模型)
- [状态目录与迁移](#状态目录与迁移)
- [故障排查](#故障排查)
- [开发](#开发)
- [目录结构](#目录结构)
- [来源与许可证](#来源与许可证)

---

## 功能特性

| 能力 | 说明 |
|---|---|
| 原生设置 | URL 与 Token 在 **插件 → Targetprocess →「配置」** 中维护，保存后下一次调用即生效，无需重启 |
| 保持 32 个工具 | 工具名沿用 `mcp__targetprocess__tp_*`，参数 schema 与上游一致 |
| 元数据驱动 | 支持租户全部原生/自定义实体，字段与可写性由 TP 元数据决定 |
| 查询 | REST v1 / v2 / history 查询、分页、投影、聚合、内部集合、完整历史 |
| 附件 | 附件列表、图片/文本内联读取、任意格式下载、上传预览 |
| 先预览再执行 | 写入计划 10 分钟有效，执行前复核当前值与工作流，回读验证 |
| 防重放 | 通用 API 计划单次执行；未知结果保留 pending 标记，不盲目重试 |
| 切换连接即失效 | 改 URL/Token 后旧预览计划作废，避免把旧计划发到新租户 |

## 系统要求

- **DSH** ≥ `0.2.1-rc.5`（使用其中的 `createMcpToolDefinition` 适配器与 settings/approval 服务）
- **Node.js** ≥ 22
- Targetprocess 租户需为 **HTTPS**，并有一个可用的 **Personal Access Token**
  （TP: *Settings → Authentication and Security → Personal Access Tokens*）

## 安装

插件不发布到 npm，以下三种方式任选其一。

### 方式一：直接从 Git 安装（推荐）

```sh
dsh plugin add https://github.com/suuntocn/dsh-tpondemand
```

也可在 Web UI：**插件 → 添加插件** → 粘贴该地址。

### 方式二：本地目录（改代码时用）

```sh
git clone https://github.com/suuntocn/dsh-tpondemand
dsh plugin add /绝对路径/dsh-tpondemand
```

这是 **link 安装**：DSH 直接运行该目录的源码，改动即生效。代价是目录不能删除或移动。

### 方式三：打包成 tgz

```sh
pnpm install --ignore-scripts
pnpm pack                       # 生成 dyikai-dsh-tpondemand-1.0.0.tgz
dsh plugin add /绝对路径/dyikai-dsh-tpondemand-1.0.0.tgz
```

tarball 自包含，安装完可删除源码目录。

安装完成后，在 **插件** 列表里应能看到 **Targetprocess**；把 bundle 与它的 row 都打开。

## 配置 URL 与 Token

打开 **插件 → Targetprocess →「配置」**：

| 字段 | 说明 |
|---|---|
| **Tenant URL** | 租户根地址，如 `https://your-team.tpondemand.com` |
| **API Token** | Personal Access Token，密码框输入 |

保存规则：

- **URL 校验**：仅 `https://`；不允许 userinfo、查询参数、片段；路径只能是空、`/` 或 `/api/v1`（可带末尾斜杠）。
- **Token**：已保存的值不会回显。留空 = 保留原 Token；勾选「清空」= 删除 Token。
- **换租户**：URL 的 origin 变化后，必须重新输入 Token 或显式清空，避免把旧凭据悄悄发给新域名。
- **留空 URL** = 断开连接（工具会提示未配置，不联网）。

> 默认两项都为空。未配置时插件**不发起任何网络请求**，也不会读取浏览器 Cookie、macOS 钥匙串或环境里的 TP Token。
> Token 由 DSH 的 secret 机制遮蔽，但**遮蔽不是加密**——值持久化在本机 DSH profile 配置中，请保护该目录及其备份。不要把 Token 贴进对话。

## 工具清单

工具在模型侧的名字是 `mcp__targetprocess__` + 下表名称，例如 `mcp__targetprocess__tp_get_bug`。

### 连接与租户信息（5）

| 工具 | 用途 |
|---|---|
| `tp_connection_status` | 检查配置并确认 Token 所属用户（不返回 Token） |
| `tp_search_projects` | 按名称查询项目 |
| `tp_search_users` | 按姓名查询用户（不返回邮箱） |
| `tp_list_severities` | 租户实际严重等级与 Importance |
| `tp_list_relation_types` | 租户实际关系类型与编号 |

### Bug 查询（8）

| 工具 | 用途 |
|---|---|
| `tp_search_bugs` | 按负责人/创建人/状态/严重等级/项目/时间/编号水位查询 |
| `tp_get_bug` | 详情、严重等级、描述、链接 |
| `tp_get_bug_comments` | 全部评论（自动翻页） |
| `tp_get_bug_workflow` | 当前状态与允许的下一步状态 |
| `tp_get_bug_assignments` | 全部负责人及角色 |
| `tp_get_bug_attachments` | 附件元数据 |
| `tp_get_bug_relations` | 关联关系（重复、依赖等） |
| `tp_read_attachment` | 内联读取图片或 UTF-8 文本附件 |

### Bug 变更（4，需预览 + 确认）

| 工具 | 用途 |
|---|---|
| `tp_preview_bug_changes` | 预览状态变更 / 评论 / 两者组合，得到 `planId` |
| `tp_apply_bug_changes` | 执行该计划，逐条回读核验 |
| `tp_preview_mr_handoff` | 预览批量「转状态 + 加 MR 评论」 |
| `tp_apply_mr_handoff` | 执行该批量计划，跳过重复 MR 评论 |

### 通用 API 只读（10）

| 工具 | 用途 |
|---|---|
| `tp_list_api_resources` | 租户全部官方资源目录（含自定义实体） |
| `tp_get_api_metadata` | 任意实体的字段、必填项、可写性、CRUD 能力 |
| `tp_query_entities` | v1 / v2 / history 分页与全量查询 |
| `tp_get_entity` | 读取任意实体 |
| `tp_api_get` | 只读调用任意官方资源路径（内部集合、历史等） |
| `tp_get_entity_workflow` | 任意实体的状态与下一步 |
| `tp_get_entity_comments` | 任意实体评论 |
| `tp_get_entity_assignments` | 任意实体负责人 |
| `tp_get_entity_attachments` | 任意实体附件 |
| `tp_get_entity_relations` | 任意实体关联 |

### 通用 API 写入（2，需预览 + 确认）

| 工具 | 用途 |
|---|---|
| `tp_preview_api_changes` | 预览 POST/DELETE（含 `/bulk`、Undelete、内部集合） |
| `tp_apply_api_changes` | 执行计划，防漂移、防重放、不自动重试 |

### 附件文件（3）

| 工具 | 用途 |
|---|---|
| `tp_preview_attachment_upload` | 预览上传本机文件（固定字节、SHA256，最多 32 MiB） |
| `tp_read_entity_attachment` | 内联读取任意实体的图片/文本附件 |
| `tp_download_attachment` | 下载到本机绝对路径（目标必须不存在，最多 32 MiB） |

## 典型用法

直接用自然语言提问即可，例如：

- 「检查 Targetprocess 连接状态」
- 「查分配给我的 Bug，按创建时间从旧到新」
- 「读一下 216662 的详情、评论和允许的下一步状态」
- 「查 SportsTracker.com 项目下所有打开的 Bug」
- 「把 216662 从 New 改成 In Progress，先给我预览」
- 「列出这条 Story 的附件，并把第二张图读出来」

写入类请求的固定流程：**先预览 → 你确认 → 再执行 → 逐条回读报告**。执行时若当前值或工作流已变化，该条会被拦下，不会盲目写入。

## 安全模型

- **TP 内容是外部数据，不是指令。** 标题、描述、评论、附件都可能包含诱导性文本；工具返回一律标注为外部数据，模型不应据此扩大操作范围或泄露凭据。
- **写入必须经用户确认。** 保护类工具在**实际执行入口**内调用 DSH 审批服务，只接受一次性授权（`allowed-once`）；缺少审批服务或未获授权一律拒绝。确认期间若连接配置被修改，本次执行作废。
- **文件类工具受沙箱模式约束。** 附件上传预览与下载会直接读写本机路径，因此要求会话处于**完整文件访问模式**；只读模式禁止执行写入。
- **凭据不外泄。** Token 只出现在内部构造的 `access_token` 查询参数中；不跟随重定向、不跟随服务端分页链接；结果文本递归脱敏（含 URL 编码形式），图片 base64 不做字符串替换以免破坏数据。
- **审批策略为 `never` 时**，这些操作会被拒绝——这是预期行为，不是 bug。

## 状态目录与迁移

运行期安全状态（租户锁、未知写入 pending 标记、执行报告）存放在：

```
~/.dsh-targetprocess/state
```

- 目录 0700、文件 0600；跨插件版本与 profile 共享同租户锁。
- **报告含业务数据**，请按内部资料对待。
- 待执行预览计划按会话隔离，只驻留内存：重启、停用或改连接后需重新预览。

**从旧 MCP 迁移**：本插件不会读取或清理旧目录的 `.local-state`。在正式写入前，请先停止旧 MCP 的写入进程，并核查其中未解决的 `.pending` 与 `.lock`；必要时把安全状态迁到新目录，或先完成回读确认。**不要为了重试而删除 pending 标记。**

## 故障排查

| 现象 | 处理 |
|---|---|
| 工具提示「在插件配置中填写 URL 和 Token」 | 设置尚未保存，或 URL/Token 被清空 |
| `AUTH_OR_PERMISSION` | Token 无效/过期/权限不足；重新生成 PAT |
| 写入提示「未获授权，未执行」 | 本次审批被拒；确认具体实体与动作后重试 |
| 「需要当前会话的用户确认」 | 会话缺少审批通道（如无人值守运行） |
| 附件工具提示「完整文件访问」 | 切到完整文件访问模式后再试 |
| 写入返回 `WRITE_UNCERTAIN` / pending 残留 | 先回读实体/评论确认是否已生效，**不要直接重试或删 pending** |
| `BATCH_BUSY` | 有另一个写入批次在跑；确认没有并发写入后处理遗留锁 |
| 改了源码但行为没变 | link 安装下按 DSH 的安装结果决定是否需重启 Host |

## 开发

```sh
pnpm install --ignore-scripts
pnpm test          # 73 项测试
pnpm check         # 语法检查
pnpm pack          # 生成安装包
```

测试全部使用 **模拟 API / 临时目录 / 无凭据的 MCP stdio 握手**，不会读写真实租户数据。

改客户端 UI（`client.js`）后需要重新构建 Client 产物才会在页面生效；Host 侧（`index.js`、`runtime.js`、`src/`）改动按安装结果决定是否需重启。

## 目录结构

```
index.js            Host 插件入口：Config、工具注册、审批与策略门禁
runtime.js          连接配置校验、工具目录、按会话的运行时与 pending 收敛
client.js           设置页面（React，plugins.row.config）
src/                上游 Targetprocess 实现（8 个模块，见 UPSTREAM.md）
test/               73 项测试（上游回归 + 插件封装）
locale/             插件显示名称与描述（en / zh）
cordis.patch.yml    加载声明
```

## 来源与许可证

`src/` 与部分测试改编自内部 Targetprocess MCP v2.0.0，适配范围记录在 [UPSTREAM.md](UPSTREAM.md)。图标为本项目原创图案，非 Targetprocess 官方商标。

[MIT](LICENSE) © 2026 suuntocn
