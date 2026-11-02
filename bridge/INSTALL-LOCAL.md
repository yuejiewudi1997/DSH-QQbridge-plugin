# qq-bridge 本机安装说明（DSH 桌面版）

安装位置：`C:\Users\server2\Documents\deepseek-harness\default-workspace\qq-bridge`
DSH profile：`desktop`（`C:\Users\server2\.dsh\profiles\desktop`）

## 已经装好的部分

| 项目 | 状态 | 位置 |
| --- | --- | --- |
| 桥接依赖（152 个包） | 已安装 | `node_modules/` |
| `@snowluma/sdk` ESM 修补（postinstall） | 已执行（13 个文件） | `node_modules/@snowluma/sdk` |
| DSH agent preset `qq-chat` / `qq-chat-v2` | 已注册为 bundle | `plugins/qq-agent-presets` |
| 三个 MCP server | 已写入 profile patch | `src/mcp-snowluma-safe.js`、`src/mcp-host-server.js`、`src/mcp-web-search-safe.js` |
| 桥接配置 | 已生成并可读 | `config.json` |
| SnowLuma v2.1.1（win-x64 完整版） | 已下载、校验 SHA256、解压 | `../SnowLuma/` |
| SnowLuma 的 Node 运行时完整性标签 | 已从 Low 修正为 Medium | `../SnowLuma/node.exe` 等 88 个文件 |
| 桥接启动器 | 已添加（自动同步 DSH 随机端口） | `start-bridge.bat` → `start-desktop.ps1` |
| SnowLuma 启动器 | 已添加（固定用自带 node.exe） | `../SnowLuma/start-snowluma.bat` |

**尚未填**：`snowluma.accessToken`、`allow.private` / `allow.groups`、`ownerQQ`
（空白名单 = 谁都不回，这是仓库的 fail-closed 默认值）。

## 还差的步骤

1. **启动 SnowLuma**：双击 `../SnowLuma/start-snowluma.bat`（或 `launcher.bat`，已改成优先用自带的
   `node.exe`）。浏览器开 `http://localhost:5099`，登录后打开 **WebSocket 服务端（3001）** 和
   **HTTP API（3000）**，两端 accessToken 设成同一个值。
2. **回填 `config.json`**：
   ```json
   "snowluma": { "wsUrl": "ws://127.0.0.1:3001", "httpUrl": "http://127.0.0.1:3000", "accessToken": "..." },
   "ownerQQ": 你的QQ号,
   "allow": { "private": [你的QQ号], "groups": [允许的群号] }
   ```
3. **启动桥接**：双击 `start-bridge.bat`（或 `powershell -ExecutionPolicy Bypass -File .\start-desktop.ps1`）。
   控制台：`http://127.0.0.1:3100`。

DSH 端（preset 与 MCP）在 **DSH 重启后**才加载；若还没重启过，先重启 DeepSeek Harness。

## 这台机器上的四个特殊处理

### 1. pnpm 必须用 hoisted 布局

默认的 junction 布局下 Node 的 ESM 解析器无法穿透，`@modelcontextprotocol/sdk` 会报找不到
`zod-to-json-schema`，三个 MCP server 一启动就崩。已写入 `pnpm-workspace.yaml` 的
`nodeLinker: hoisted`；重装依赖时：

```powershell
node <dsh>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe `
     <dsh>\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs install --ignore-scripts
node scripts/patch-snowluma-sdk.mjs   # pnpm 默认不跑 postinstall，需要手工补
```

### 2. SnowLuma 的 node.exe 被打成 Low 完整性标签

DSH 的沙箱进程本身跑在 Low 完整性（`S-1-16-4096`），它解压出来的文件默认继承 Low 标签。
从 Explorer（Medium）启动这样的 `node.exe` 时，进程会被镜像标签**降权到 Low**，SnowLuma 于是报：

```
WARN [App] Node integrity: pid=..., process=Low (RID=4096); EXE=Low (RID=4096), inherited=true, policy=1
```

修复（已做过，`icacls` 需要普通权限，Low 进程改不了标签）：

```powershell
icacls "<...>\SnowLuma" /setintegritylevel "(OI)(CI)M" /T
```

验证方法：普通权限下 `SnowLuma\node.exe` 启动的进程 integrity 应为
`Mandatory Label\Medium`（`S-1-16-8192`）。

**注意**：以后任何在 DSH 沙箱里解压/复制、又要双击运行的程序，都会带同样的 Low 标签，
需要重做这一步。

### 3. DSH 桌面版端口每次启动都变

宿主用 `--port 0`，`dsh.baseUrl` 会过期。`start-desktop.ps1` 的检测顺序：

1. `-Port <n>` 参数
2. `$env:DSH_WEB_URL`（从 DSH 终端里启动时存在）
3. 扫描本机 loopback 监听端口，认 DSH 的未授权指纹：`401` + body
   `dsh web authentication required`
4. 都失败就沿用 `config.json` 里的值

写回 `config.json` 时用 **UTF-8 无 BOM**（`JSON.parse` 不接受 BOM）。

另外：当前 DSH web 端口是 `54361`，`config.json` 已同步到这个值。

### 4. PowerShell 执行策略

`CurrentUser` 是 `RemoteSigned`。如果 `.ps1` 被拦，用 `start-bridge.bat`
（内部 `powershell -ExecutionPolicy Bypass -File`）。

## 怎么回滚

- 安装前的 profile 原件：`backup-enabledesktop/*.20261023-104938`
- setup-dsh 自己的备份：`C:\Users\server2\.dsh\profiles\desktop\cordis.patch.yml.qq-bridge.bak`
- 移除：删掉 `cordis.patch.yml` 里 `# === qq-bridge MCP BEGIN/END ===` 整个区块，
  `package.json` 删掉 `qq-mode-console` / `qq-agent-presets` 两条依赖与两个 bundle 名，重启 DSH。

## 风险提示

- 桥接让 QQ 消息可以驱动本机 DSH agent。空白名单时不回任何人；填了群号后群里任何人都能触发
  agent（只有 `qq-tool-restrict` 这层工具白名单，没有沙箱）。
- SnowLuma 是第三方 QQ 客户端，真实号登录存在风控/封号风险。
