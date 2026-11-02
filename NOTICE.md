# 来源与第三方组件

## 本项目从哪来

- 上游项目：**qq-bridge** —— <https://github.com/Derpyu520/qq-bridge>
- 上游作者：**Derpyu520**（及 qq-bridge / QSH 贡献者）
- 上游许可：MIT（`Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors`）

本仓库（`dsh-QQbridge-plugin`，作者 **yuejiewudi1997**）是在 qq-bridge 之上做的**插件化改造**，
自身同样以 MIT 发布，并保留上游的版权声明。相对上游的主要改动：

| 改动 | 说明 |
| --- | --- |
| 打包成 DSH 插件 | `cordis.patch.yml` + `lib/index.js`：DSH 装配时拉起桥接、退出时收掉 |
| 自带桥接本体 | 上游按「仓库 + plugins 子目录」开发；这里把 `bridge/` 作为插件的一部分分发 |
| 首次启动向导 | `bridge/scripts/first-run.py`：tkinter 窗口，七步进度，装完为止 |
| SnowLuma 按需安装 | **不随包分发**，首次启动时从官方 Release 按固定版本下载 + sha256 校验 |
| 梗图管理器 | `meme/`（独立 Python 桌面程序，与 QQ 无关） |
| 网关拉起方式 | 去掉 `detached`：Windows 上它会顶掉 `CREATE_NO_WINDOW`，导致 SnowLuma 自己 spawn 的 node 弹出控制台窗口 |
| 并发保护 | `ensureSnowlumaRunning` 加单飞，避免并发请求各拉起一个网关抢端口 |
| 安全修复 | 无令牌智能体不得走操作者语音通道；`/tools?token=` 的 302 不再透传令牌；删掉重复且会明文回令牌的 `/api/console/token` 分支；语音 dryRun 不再回绝对路径；长轮询加连接数上限 |

## 第三方组件

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness) | MIT | DeepSeek Harness 本体与官方 API 客户端 |
| [SnowLuma](https://github.com/SnowLuma/SnowLuma) 本体 | 源码可见的非商业许可（非 OSI 开源） | **本仓库不包含、也不分发**它的源码或二进制；只在首次启动时从官方 Release 下载到你自己的机器上。版权归其作者 |
| `@snowluma/sdk` / `@snowluma/mcp` | 声明 `SEE LICENSE IN LICENSE`，但包内未附 LICENSE 文件 | 仅作 npm 依赖使用；`npm install` 后对**本机安装副本**做一次机械修补（给相对导入补 `.js` 扩展名），不进入本仓库 |
| `@modelcontextprotocol/sdk`、`js-yaml`、`zod` | MIT / ISC | 见各自包内 LICENSE |

## 风险提示

- SnowLuma 是独立第三方项目，与腾讯公司及 QQ **无任何隶属、合作、授权或背书关系**。
- 用非官方协议接入第三方平台**可能违反其服务条款并导致账号受限**，风险由使用者自负。
- 桥接会把 QQ 消息交给大语言模型处理，也可能让模型代替账号发言。请按
  [`bridge/RULES.md`](bridge/RULES.md) 说明的白名单/审计机制使用，不要在未配置白名单时
  直接暴露给任意群聊或陌生人。
