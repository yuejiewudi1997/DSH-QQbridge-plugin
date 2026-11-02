# QQ ↔ DeepSeek Harness

**中文** · [English](README.en.md)

把 QQ 私聊和群聊接入 DeepSeek Harness（DSH）：消息进入 agent，agent 能自主看消息、看图片、按人格说话，回复、提问和工具审批再回到 QQ。

![QQ ↔ DeepSeek Harness](assets/deepseek娘.png)

> 当前分支适配 DSH `0.2.1-rc.2`（兼容 `0.2.0-rc.2`）。SnowLuma 是独立上游项目，本项目不二次分发网关本体。

## 主要功能

- **双向消息**：QQ 群聊/私聊与 DSH 会话互通，支持文本、图片、表情、动图、引用、@、拍一拍和合并转发。
- **人格代理**：每个群绑定独立人格和独立会话，人格提示词分层下发，不同群之间互不串味。
- **系统托管发言**：何时开口由桥接调度，不由模型自唤醒。默认每小时最多主动接话 4 次、每段最多回复 5 条，可按概率和安静时长放宽或收紧。
- **群聊语境**：主会话按“最近一包”派发，默认每包 50 条、繁忙时动态扩容；专属话题代理另带最近 10 分钟内最多 20 条上下文，帮它判断发起人前文。
- **多模态理解**：图片和表情会作为视觉输入交给模型，动图抽帧；回退模型不支持图片时自动走辅助识图。
- **本地控制台**：`http://127.0.0.1:3100`，管理群/好友、人格、调度、工具开关、知识库、令牌与花费、日志和运行模式，支持浅色/深色主题。
- **群记忆**：共享知识库从群聊中采集事实，经审批后进入人格上下文；也支持黑话学习和联网查证。
- **安全边界**：白名单/黑名单、工具白名单、发送硬闸门、控制台令牌和开发者模式，默认不把 QQ 控制权直接交给模型。

## 运行模式

- **智能模式（默认）**：AI 通过 QQ 工具自主看消息、自主回答；开口次数、回复预算和消息包由系统调度。适合群聊人格。
- **封闭 Agent**：仅 owner 私聊可用，工具能力更完整，可以在 QQ 上操作 DSH。适合自己使用。
- **开发者模式**：拦截落盘和 QQ 发送，或停用全部调度，用于测试和调试。

## 安装

### 方式一：DSH 插件（推荐）

前置：DSH 已安装并启动、Node.js ≥ 22.13、QQ 已登录。

```bash
git clone https://github.com/Derpyu520/qq-bridge.git
cd qq-bridge/plugins/qq-bridge-launcher
node install.mjs
```

然后重启 DSH。首次启动会自动拉起桥接；没有 `config.json` 时会生成一份模板，并弹出首次配置向导，依次完成 QQ 识别、SnowLuma 安装/启动和网关配置。

安装完成后打开控制台：

```text
http://127.0.0.1:3100
```

在控制台填写允许的 QQ 号/群号，再在 QQ 上发一条消息验证。

### 方式二：源码运行

```bash
git clone https://github.com/Derpyu520/qq-bridge.git
cd qq-bridge
npm install
cp config.example.json config.json
node scripts/setup-dsh.mjs
npm start
```

Windows CMD 用 `copy config.example.json config.json`。`setup-dsh.mjs` 会安装 `qq-chat-v2` preset 和 MCP 工具，装完必须重启 DSH。

最小配置：

```json
{
  "dsh": { "baseUrl": "http://127.0.0.1:3080" },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": ""
  },
  "allow": {
    "private": [12345678],
    "groups": [123456789]
  }
}
```

`wsUrl` 是 OneBot WebSocket 端口，`httpUrl` 是 HTTP API 端口，两者不要填成同一个。SnowLuma 的安装、登录和 OneBot 配置需在它自己的 WebUI 完成：[下载 SnowLuma](https://github.com/SnowLuma/SnowLuma/releases)。

## 验证

```bash
npm run test:audit
npm start
```

启动日志出现 `SnowLuma 已连接` 后，在 QQ 上给机器人账号发消息，确认 DSH 会收到并回复。首次接入建议先只放行自己的小号或测试群。

## 文档

- [文档索引](docs/README.md)
- [DSH 安装与 preset/MCP 配置](docs/guides/DSH_SETUP.md)
- [安全与权限边界](RULES.md)

## 许可与合规

本项目使用 MIT 许可（见 [LICENSE](LICENSE)）。SnowLuma 网关、QQ 客户端及第三方模型服务由其各自作者和条款约束；本项目只连接你已有的服务，不代替你部署或授权。
