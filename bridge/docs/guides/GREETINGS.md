# 定时问候

到点自动发一条「文字 + 图片」问候，不经过 AI、不花 token。

## 工作方式

| 项 | 说明 |
|---|---|
| 时区/时间 | `greetings.timeZone`（默认 `Asia/Shanghai`）+ `times.morning/noon/evening`（`HH:MM`） |
| 真实网络时间 | `useNetworkTime` 打开时请求 `networkTimeUrls`（默认 baidu/microsoft）的 HTTP `Date` 头，算本机时钟偏移并在 10 分钟内复用；全部失败才退回本机时钟，日志会标注 |
| 触发窗口 | 到点后 `windowMs`（默认 300000 = 5 分钟）内允许发送；错过窗口不补发；同一天同一时段只发一次 |
| 发送方式 | 桥接直接调 OneBot `send_group_msg`/`send_private_msg`，消息段是 `[text, image]` —— **文字和图片在同一个气泡**，不是两条 |
| 配图缩放 | 发送前把图片长边缩到 `greetings.imageMaxEdge`（默认 260，控制台「配图长边」可改），透明背景保留 PNG、其余转 JPEG。注意 QQ 会把超过自身显示上限的图压到同一尺寸渲染，默认设到上限以下才看得出「缩了」 |
| 随机挑选 | 优先挑同一时段（morning/noon/evening）的条目，其次 `any`，只挑启用的 |
| 目标 | `greetings.targets`，如 `["group:1098011551"]`；未配置时不会自动发 |

## 问候包体

- 状态文件：`state/greetings.json`（条目 + 当日触发记录）。
- 图片：`state/greetings/images/`（控制台上传）或 `assets/`（随包图片）；发送时只允许这两个目录。
- 控制台「二代仿真」页新增「定时问候」卡片：
  - `人格分支生成`：独立会话（通用系统预设 + 当前人格模板）生成一批 JSON 问候；配图**不随机**，由人格按文字意思从图池选，选不出就按图片「含义」贴合度兜底，仍不贴合就留空（只发文字）；
  - 图池每张图可写一句含义（控制台输入框）；没写的，桥接启动后/生成前让视觉模型看图自动补写，存在 `state/greetings/images/pool.json`；
  - 每条可改文字/时段/启用、上传换图、删除；
  - 每条右侧「测试」按「测试目标」发一条，验证同气泡效果。

- 只改文字保存不会清掉已配的图（`imagePath` 省略 = 保留原值）。
- 生成口吻是**营业/服务号**：直接对群友打招呼、带一句安排，读起来像正常说话；禁止出现「播报/报时/报到/值班/上岗」等自述字眼。

## 配置示例

```json
"greetings": {
  "enabled": true,
  "timeZone": "Asia/Shanghai",
  "times": { "morning": "08:30", "noon": "12:00", "evening": "21:30" },
  "targets": ["group:1098011551"],
  "windowMs": 300000,
  "useNetworkTime": true,
  "generate": { "count": 6, "style": "轻松一点", "preset": "" }
}
```

接口：`GET /api/greetings`、`POST /api/greetings/{config,entry,upload,generate,test,reset-fired}`。
