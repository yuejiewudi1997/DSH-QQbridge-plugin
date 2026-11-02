# qq-bridge-launcher

把 QQ 接入 DeepSeek Harness 的 DSH 插件。桥接本体、控制台、人格 preset、梗图管理器和内置 Python 兜底脚本都在包里；SnowLuma 网关不随包分发，首次启动时从官方 Release 下载并校验安装。

![QQ ↔ DeepSeek Harness](bridge/assets/deepseek娘.png)

## 主要功能

- DSH 启动即自动拉起桥接，崩溃自动重启，不再手动开 `start-bridge.bat`。
- 自带 Web 控制台 `http://127.0.0.1:3100`：群/好友、人格、调度、工具开关、知识库、令牌花费和日志。
- 首次启动向导：识别 QQ、生成 `config.json`、安装 SnowLuma、写网关配置、等待上线。
- 智能模式与封闭 Agent 两种运行方式；人格分支和 MCP 工具随插件一起安装。
- 适配 DSH `0.2.1-rc.2`（兼容 `0.2.0-rc.2`）。

## 安装

前置：DSH 已安装并启动、Node.js ≥ 22.13、QQ 已登录。

```bash
node install.mjs                    # 装进默认 profile
node install.mjs --profile desktop  # 指定 profile
```

安装器做三件事：

1. 把插件目录链到 `<DSH_HOME>/plugins/qq-bridge-launcher`；
2. 在 profile 的 `node_modules` 下建解析链接；
3. 在 profile 的 `package.json` 注册 `link:` 依赖和 `dsh.profile.bundles`。

然后重启 DSH。缺少 `bridge/config.json` 时会按 `config.example.json` 自动生成，并弹出首次配置向导。

打开控制台，填上允许的 QQ 号/群号，再从 QQ 发一条消息验证。

## SnowLuma

网关由上游独立维护，本项目不二次分发。插件只负责：

- 按固定版本从 SnowLuma 官方 GitHub Release 下载；
- 校验体积和 sha256，失败自动切换镜像；
- 解压到 `<插件>/snowluma`，写 `hookAutoLoad` 和 WebUI 端口；
- 启动网关并等待 `snowluma.connected`。

QQ 登录、扫码和 OneBot 端口/token 在 SnowLuma 自己的 WebUI 里完成。

## 常用位置

| 内容 | 位置 |
| --- | --- |
| 桥接配置 | `bridge/config.json` |
| 控制台 | `http://127.0.0.1:3100` |
| 运行日志 | `bridge/state/bridge.log` |
| 插件日志 | `bridge/state/launcher.log` |
| SnowLuma | `<插件>/snowluma`（安装产物，重装插件不会删） |

## 卸载

```bash
node install.mjs --uninstall
```

只摘除 profile 里的链接和注册项，不删除你的配置、状态或 SnowLuma。

## 文档

- 项目介绍、源码安装和配置：[项目 README](https://github.com/Derpyu520/qq-bridge)
- DSH 安装与 preset/MCP：[DSH_SETUP.md](bridge/docs/guides/DSH_SETUP.md)
- 安全边界：[RULES.md](bridge/RULES.md)

## 许可

MIT。SnowLuma、QQ 客户端及第三方模型服务由其各自作者和条款约束。
