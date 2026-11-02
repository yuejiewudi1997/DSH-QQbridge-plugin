# QQ ↔ DeepSeek Harness

[中文](README.md) · **English**

Connect QQ private chats and groups to DeepSeek Harness (DSH). Messages reach an agent that can read chats, understand images, speak in a chosen persona, and send replies, questions, and tool approvals back to QQ.

![QQ ↔ DeepSeek Harness](assets/deepseek娘.png)

> This branch targets DSH `0.2.1-rc.2` (also compatible with `0.2.0-rc.2`). SnowLuma is an independent upstream project; this repository does not redistribute its gateway.

## Highlights

- **Two-way messaging**: QQ groups and private chats with text, images, stickers, GIFs, quotes, mentions, pokes, and forwarded chats.
- **Persona agents**: each group gets its own persona and session, with layered system prompts and no cross-group leakage.
- **System-managed speech**: the bridge decides when the agent may speak instead of self-waking. Defaults: up to 4 proactive starts per conversation per rolling hour, up to 5 replies per thread, with configurable probability and quiet time.
- **Chat context**: the main session receives the latest message pack (50 messages by default, expanding under load); topic agents receive up to 20 messages from the last 10 minutes for the initiator's context.
- **Multimodal input**: images and stickers are passed to the vision model, with GIF frame sampling and a fallback describer when the main model cannot see images.
- **Local console**: `http://127.0.0.1:3100` for conversations, personas, scheduling, tool switches, knowledge, token spend, logs, and light/dark themes.
- **Shared knowledge**: facts collected from group chats are reviewed before entering persona context; slang learning and web verification are supported.
- **Safety boundaries**: allow/deny lists, tool allowlists, a send-time gate, console token, and developer mode. The model does not get QQ control by default.

## Modes

- **Smart mode (default)**: the agent reads and answers through QQ tools; timing, reply budget, and message packs are scheduled by the bridge.
- **Closed agent**: owner-only private chat with fuller DSH control from QQ.
- **Developer mode**: block writes and QQ sends, or stop all scheduling, for testing.

## Installation

### Option 1: DSH plugin (recommended)

Requirements: DSH installed and running, Node.js ≥ 22.13, QQ logged in.

```bash
git clone https://github.com/Derpyu520/qq-bridge.git
cd qq-bridge/plugins/qq-bridge-launcher
node install.mjs
```

Restart DSH. On first launch the plugin starts the bridge and, if `config.json` is missing, generates it and opens the setup wizard for QQ detection, SnowLuma installation, and gateway configuration.

Open the console at `http://127.0.0.1:3100`, add your QQ account/group IDs, then send a test message from QQ.

### Option 2: Run from source

```bash
git clone https://github.com/Derpyu520/qq-bridge.git
cd qq-bridge
npm install
cp config.example.json config.json
node scripts/setup-dsh.mjs
npm start
```

On Windows CMD use `copy config.example.json config.json`. `setup-dsh.mjs` installs the `qq-chat-v2` preset and MCP tools; restart DSH afterward.

Minimal configuration:

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

`wsUrl` is the OneBot WebSocket port and `httpUrl` is the HTTP API port; do not use the same port for both. Install, log in, and configure OneBot in SnowLuma's own WebUI: [download SnowLuma](https://github.com/SnowLuma/SnowLuma/releases).

## Verify

```bash
npm run test:audit
npm start
```

When the log shows `SnowLuma 已连接`, send a message from QQ and confirm DSH receives and answers it. Start with a test account or a small test group.

## Docs

- [Documentation index](docs/README.md)
- [DSH setup, presets, and MCP](docs/guides/DSH_SETUP.md)
- [Security and permission boundaries](RULES.md)

## License and compliance

MIT licensed (see [LICENSE](LICENSE)). SnowLuma, the QQ client, and third-party model services are governed by their own terms. This project connects to services you already run; it does not deploy or authorize them for you.
