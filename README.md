# Targetprocess for DeepSeek Harness

在 DeepSeek Harness 里直接使用 Targetprocess：**在插件设置中填写租户 URL 和 Token 即可**，无需环境变量、无需另外配置 MCP 服务、无需重启。

A native Targetprocess plugin for DeepSeek Harness. Configure the tenant URL and a Personal Access Token in the plugin settings — no environment variables, no separate MCP server, no restart.

---

## 这个插件的重点

### 1. 配置就在设置里

URL 与 Token 是插件自带的原生设置项，在 **插件 → Targetprocess →「配置」** 中维护：

- Token 走 DSH 的 secret 机制，界面上不回显已保存的值
- 保存后**下一次调用即生效**，不用改配置文件、不用重启 Host
- 切换租户时强制重新输入 Token，避免把旧凭据发给新域名

### 2. 不是外挂 MCP 进程

传统做法要跑一个 stdio MCP 子进程，再让 DSH 代理过去。本插件把这层去掉了：工具直接注册进 DSH 的 ToolRuntime，随插件启停，没有孤儿进程、没有端口、没有额外日志。

### 3. 改动数据前一定先给你看

所有写入都是两段式：

```
预览（生成 10 分钟有效的计划） → 你确认 → 执行 → 逐条回读核验
```

- 执行时重新读取当前值与工作流，**预览后若数据被改过，该条会被拦下**
- 结果是「已确认 / 待人工核实 / 结果不明」分档上报，不把 HTTP 200 当成成功
- 结果不明时保留 pending 标记，**不会自动重发**

### 4. 写入权限由 DSH 把关

- 写入类工具在执行入口内调用 DSH 审批，**只接受一次性授权**
- 会话审批策略为 `never` 时直接拒绝（这是设计行为）
- 只读模式下禁止执行写入
- 涉及本机文件的工具额外要求**完整文件访问模式**

### 5. 30+ 个工具，覆盖真实工作流

从「查分配给我的 Bug」到「批量转状态并附 MR 评论」，再到「任意实体的字段级查询与修改」都能做。工具名统一为 `mcp__targetprocess__tp_*`，具体清单可以让 Agent 直接列出来。

---

## 系统要求

| 项 | 要求 |
|---|---|
| DeepSeek Harness | ≥ `0.2.1-rc.5` |
| Node.js | ≥ 22 |
| Targetprocess | HTTPS 租户 + 一个 Personal Access Token |

Token 获取：TP 里进 **Settings → Authentication and Security → Personal Access Tokens** 生成。若看不到该页面，需要管理员为你的角色开启 `Allow creating and using access tokens`。

---

## 安装

```sh
dsh plugin add https://github.com/suuntocn/dsh-tpondemand
```

也可以在 Web UI 里：**插件 → 添加插件** → 粘贴同一个地址。

### 安装后确认

1. **插件** 列表里出现 **Targetprocess**
2. 打开它的 bundle 开关，以及下方的 row 开关
3. 回到对话，让 Agent 检查连接状态，应返回你的 TP 用户名

---

## 配置 URL 与 Token

打开 **插件 → Targetprocess →「配置」**：

| 字段 | 说明 |
|---|---|
| **Tenant URL** | 租户根地址，如 `https://your-team.tpondemand.com` |
| **API Token** | Personal Access Token，密码框输入，粘贴后不再显示 |

保存规则：

- **URL**：必须是 `https://`；不能带账号密码、查询参数或片段；路径只能是空、`/` 或 `/api/v1`（可带末尾斜杠）
- **Token 留空** = 保留原来保存的值；勾选「清空」= 删除 Token
- **换租户**：URL 的域名变化后，必须重新输入 Token 或显式清空
- **URL 留空** = 断开连接，工具会提示未配置，且**不会联网**

> 未配置时插件不发起任何网络请求，也不会去读浏览器 Cookie、系统钥匙串或环境变量里的 Token。
> Token 的遮蔽**不等于加密**——值保存在本机 DSH profile 配置中，请保护该目录及其备份。不要把 Token 贴进对话。

---

## 用起来是什么样

直接说人话就行：

- 「检查 Targetprocess 连接状态」
- 「查分配给我的 Bug，按创建时间从旧到新」
- 「读一下 216662 的详情、评论和允许的下一步状态」
- 「把 216662 从 New 改成 In Progress，先给我预览」
- 「查某个项目下所有打开的 Bug」

写入类请求会先返回预览，你确认后才会真正执行。

---

## 故障排查

| 现象 | 处理 |
|---|---|
| 提示「在插件配置中填写 URL 和 Token」 | 设置还没保存，或 URL/Token 被清空 |
| `AUTH_OR_PERMISSION` | Token 无效、过期或权限不足，重新生成 PAT |
| 写入提示「未获授权，未执行」 | 本次审批被拒；确认具体实体和动作后重试 |
| 「需要当前会话的用户确认」 | 当前会话没有审批通道（如无人值守运行） |
| 附件工具提示「完整文件访问」 | 先切到完整文件访问模式 |
| 写入返回 `WRITE_UNCERTAIN` | 先回读实体确认是否已生效，**不要直接重试** |
| 改了源码但行为没变 | 以 DSH 的安装结果为准：需要重启 Host 时按提示重启 |

---

## 开发

```sh
pnpm install --ignore-scripts
pnpm test      # 73 项测试
pnpm check     # 语法检查
```

测试全部使用模拟 API、临时目录和无凭据的 MCP 握手，**不会读写真实租户数据**。

改动 `client.js`（设置界面）需要重新构建 Client 产物才会在页面生效；`index.js`、`runtime.js`、`src/` 的改动按安装结果决定是否需重启。

---

## 许可证

[MIT](LICENSE) © 2026 suuntocn
