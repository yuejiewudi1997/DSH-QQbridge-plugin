# 模型组、回退与辅助识图

> 面向运维：为什么默认模型换成「4.1 识图组」、主模型挂了怎么自动回退、
> 回退组（推荐免费组）没有图像输入时靠什么「看见」群友发的图。

---

## 1. 为什么人格以前看不懂群友发的图片

不是桥接没传图，而是**模型组本身没有图像输入**。

- 桥接会把消息里的图片/表情取字节、归一化后作为 `{type:'image', mediaType, data}` 内容段发进 DSH（`resolveMediaList`）。
- DSH 侧能不能吃这段内容，取决于该模型声明的输入模态。我们的 `our-free-model` 插件里，
  **组合（combo）的视觉能力是「组内成员全部支持」才算**（`combos.js`：`vision: members.every(e => e.vision === true)`）。
- 旧默认 `combo:recommended-free`（推荐免费组）5 个成员里有纯文本模型（`tokenrouter/qoder/dfmodel`、
  `tokenrouter/trae/DeepSeek-V4-Flash-Official` 等），因此整组声明为「text input」，
  图片喂进去等于白喂 —— 人格只能看到 `[图片]` 占位，回一句「我看不到图」。

DSH 的模型目录 RPC（`session/modelCatalog`）**已经把这件事写清楚了**，例如：

```text
combo:recommended-free | 推荐免费组 | text input · 128K context · 5-model chain: …
combo:vision-41        | 4.1 识图组 | vision + text input · 128K context · 2-model chain: …
```

桥接现在读这个描述来判断「当前模型能不能直接看图」，不再靠猜。

## 2. 默认配置

`config.json` 的 `dsh` 段（`config.example.json` 同步）：

```jsonc
"dsh": {
  "provider": "our-free-model",
  "model": "combo:vision-41",              // 主模型：4.1 识图组（成员全部支持 image 输入）
  "fallbackModel": "combo:recommended-free", // 回退组：推荐免费组
  "fallbackProvider": "",                  // 空 = 与主模型同 provider
  "modelRetryCooldownMs": 600000,          // 回退后每 10 分钟试一次主模型
  "vision": {                              // 回退期间的辅助识图
    "enabled": true,
    "baseUrl": "",                         // 空 = 自动读取 ~/.dsh/our-free-model 的 tokenrouter 配置
    "apiKey": "",                          // 空 = 同上（只在回环地址上使用）
    "model": "trae/deepseek-v4.1-flash",
    "timeoutMs": 45000,
    "maxImages": 3,
    "maxChars": 500
  }
}
```

> `baseUrl` / `apiKey` 留空即可：桥接会从 `~/.dsh/our-free-model/settings.json` 的
> `aggregate.providers.tokenrouter` 里读，且**只接受回环地址**，不会把插件 key 发到外部主机。

## 3. 回退机制

| 时机 | 行为 |
| --- | --- |
| selectModel 连续 3 次失败 | 立刻切到回退组（`applyChatModel` 失败路径） |
| 生成阶段失败（上游 429/5xx/模型不可用等） | `promptWithModelFallback` 当场切回退组，**用回退组重投本条消息** |
| 切到回退组 | 递增 `modelSelectionEpoch` 并清空已应用记录 → 所有会话在下一条消息都重新 selectModel |
| 冷却期（`modelRetryCooldownMs`）满 | `ensureChatModel` 先试主模型；成功则 `restorePrimaryModel` 并重新声明「可识图」 |
| 控制台保存模型设置 | 直接复位到主模型重试 |

回退是**粘性**的：只要没恢复，所有消息都走回退组，不会每条消息在主/回退之间抖动。
`/api/status` 的 `model` 字段与控制台「DSH 模型与思考强度」卡片都会显示
`active=primary|fallback`、`degradedAt`、`lastError`，出问题先看这两处。

## 4. 辅助识图（推荐免费组的「眼睛」）

回退组没有图像输入，所以回退期间桥接**先用一个能看图的模型把图片转成文字**，再当普通文字发给主对话模型：

```text
[图片1：图片主体是一个橙色的圆形，中心印有黑色的“ORANGE”字样。]
```

- 触发条件：`modelRuntime.visionCapable === false`（当前模型目录描述里没有 vision）。
- 主模型能直接看图时**不会**多花这次调用 —— 原图照旧直传。
- 取图沿用原有链路（`fetchMediaData`：`get_image` / URL / 收藏表情），失败就保留 `[图片（获取失败）]` 占位。
- 同一个 `sha256(图片字节)` 10 分钟内只描述一次（`visionCache`，上限 40 条）。
- 单条消息最多描述 `maxImages` 张，描述截断到 `maxChars`；超出的保留 `[图片2（未识图）]`。
- 识图失败只记日志并留 `[图片N（识图失败）]`，**不会**阻塞这条消息的回复。
- 回退期间 `mediaHintFor` 不再让模型去调 `qq_get_message_images`（那会拿回它读不了的原图），
  改成「已附文字描述，直接据此回应」。

### 选模型的标准（实测）

| 模型 | 结果 |
| --- | --- |
| `trae/deepseek-v4.1-flash` | ✅ 约 2 秒返回「橙色的圆形，黑色 ORANGE 字样」（当前默认） |
| `qoder/dfmodel` | ❌ 超时（60 秒无响应），目录虽标 vision 也不要用 |
| `deepseek-official/deepseek-flash` | ❌ 网关 401（该 lane 没配 key） |

## 5. 控制台

「运行总览 → DSH 模型与思考强度」卡片新增：

- 状态行：当前生效模型 / 识图方式（原生·辅助·关闭）/ 回退组；回退时标红并提示「回退中」。
- **主模型、回退模型、辅助识图三个都是下拉**，选项来自：
  - 主/回退：`GET /api/model/catalog`（DSH `session/modelCatalog`，按 provider 分组，带「（识图）」标记）；
  - 辅助识图：`GET /api/model/vision-catalog`（插件网关 `/v1/models` 里 `input` 含 `image` 的模型）；
  - 目录读不到时自动退回手填输入框，并提示读取失败；当前配置不在目录里时会补一条「（当前配置）」选项。
- 回退模型下拉第一项是「不回退」（空值）。
- `保存模型设置` 写 `POST /api/model/config`，立即让所有会话下一条消息重新应用模型。
- 保存走 `POST /api/model/config`，写回 `config.json` 并立即让所有会话下一条消息重新应用模型。

## 6. API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/model/catalog` | DSH 模型目录：`{ ok, groups: [{ id, models: [{ id, name, vision }] }], count }`，读不到时 `ok:false` 且 `groups:[]` |
| GET | `/api/model/vision-catalog` | 识图网关的视觉模型：`{ ok, models: [{ id, name }], count }`，只列 `input` 含 `image` 的 |
| GET | `/api/model/config` | 返回 `{ model: { primary, fallback, active, effective, visionCapable, degradedAt, lastError, vision } }` |
| POST | `/api/model/config` | 可写 `model` / `fallbackModel` / `visionModel` / `visionEnabled` / `visionTimeoutMs` / `visionMaxChars`；主模型为空、主/回退同名、超时或字数越界都返回 400 |
| GET | `/api/status` | 操作者视图里带同一个 `model` 块 |

## 7. 自测

```bash
node scripts/test-vision-media.mjs     # 配置 + SSRF + 辅助识图实测（真发一张图给视觉模型）+ 桥接状态
node scripts/test-audit-regressions.mjs # R24：默认主模型/回退组/辅助识图与字段校验
```

`scripts/fixtures/vision-test.png` 是自测用的固定图片（橙圆 + ORANGE 字样），别把它当截图产物删掉。

## 8. 排障

| 现象 | 检查 |
| --- | --- |
| 人格还是说看不到图 | `/api/status` 的 `model.visionCapable`；日志里有没有 `[media] 已附带 N 张图片`（原生）或 `[media] 当前模型无图像输入`（辅助） |
| 日志只有 `[media] 辅助识图失败` | 网关是否在跑（`127.0.0.1:8326`）、key 是否被插件换过、换 `vision.model` |
| 一直停在回退组 | `model.lastError` / `degradedAt`；主模型组是否整体不可用（成员全挂） |
| 明明配了识图却没生效 | `modelRuntime.visionCapable` 为 true 时**不会**走辅助识图；这是设计行为，省一次调用 |
