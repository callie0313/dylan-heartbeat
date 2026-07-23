# Dylan Heartbeat — AI Residency Runtime for Kelivo

**一个给 Kelivo AI伴侣使用的常驻插件。**  
它会自动唤醒 Kelivo 的AI伴侣，并让伴侣自己判断是否要主动联系你。

> 使用方式是先 [Fork 本项目](https://github.com/callie0313/dylan-heartbeat/fork)，再 clone 你自己的 fork 进行配置和部署。
>
> Dylan Heartbeat 会写入 `.env`、时间线、预设和个性化提示词；Fork 后使用能保留你的个人改动，也方便后续同步上游更新。直接 clone 原仓库也许能跑，但后续改配置、同步更新和部署都会更麻烦。
>
> 如果你已经 Fork 或部署过旧版本，新功能不会自动进入你的部署目录。请重新 Fork，或在自己的 fork 中同步上游更新后再重新部署。

---

## ✨ 核心目标：AI Residency（AI 常驻）

- 🧠 **持续上下文** – 即使对话中断，AI 仍能记住发生过的事
- ⏰ **主动唤醒** – 无人说话时，AI 会自动醒来，思考、关心你
- 📳 **手机推送** – 支持 Bark / ntfy，主动发消息到你的手机，像真实存在的人
- 🕰️ **长期时间感** – 知道自己多久没见你，什么时候主动联系过你
- 🧩 **行为连续性** – 发过的推送、沉默的夜晚，都会被 AI 记住
- 🎭 **人格不变** – 完全保留 Kelivo 的角色设定，不做任何破坏

**AI 不再只是“收到消息 → 回复”，而是“即使你不说话，它也在想你”。**

---

## 📚 目录

- [系统架构](#-系统架构)
- [文件说明](#-文件说明)
- [已 Fork / 部署过的人怎么更新？](#-已-fork--部署过的人怎么更新)
- [更新日志](#-更新日志2026-07-17)
- [开始教程](#-开始教程)
- [管理页面](#-管理页面web-控制台)
- [自动唤醒策略](#-自动唤醒策略)
- [天气注入](#-天气注入)
- [推送渠道](#-推送渠道)
- [自动日记](#-自动日记)
- [跨平台与云部署](#-跨平台与云部署)

---

## 🧱 系统架构

```
Kelivo (客户端)
    ↓ 完整请求（SP、世界书、记忆、工具调用、最新消息）
Gateway (server.js)  ← 核心转发 + 时间线维护 + 主动行为注入
    ↓ 原封不动转发 + 已注入的主动行为上下文
LLM API
    ↑
wake_up.js  ← 定时自动唤醒，通过 Gateway 接口注入事件
    ↓
Bark / ntfy 推送 → 你的手机
```

- **Gateway 不修改 Kelivo 的任何人格设定**，只负责在正确的时间位置注入 AI 自己的主动行为（推送/静默）。
- **时间线（`enhanced_messages.json`）** 是 AI 的“世界状态”，只记录真实对话 + 自主行为，不包含系统规则。
- **时间戳记忆库（`message_timestamps.json`）** 让历史消息即使丢失时间前缀也能找回原始时间，实现推送精确散落。

---

## 📦 文件说明

| 文件 | 作用 |
|------|------|
| `server.js` | 主 Gateway。转发请求、维护时间线、注入推送事件、提供管理页面。 |
| `wake_up.js` | 自动唤醒 Runtime。按间隔唤醒 AI，生成推送或静默，发送到手机，写入时间线。 |
| `enhanced_messages.json` | **AI 世界时间线**。SP + 真实对话 + 推送事件。不是日志，是 AI 的当前世界。 |
| `message_timestamps.json` | **时间戳记忆库**。通过内容指纹记录每条消息的原始时间，找回历史消息时间。 |
| `diary/` | **自动日记目录**。当 AI 主动输出 `[DIARY]...[/DIARY]` 时，会按日期追加保存。 |
| `.env` | 环境变量。API Key、推送渠道、模型名称等（不提交到 Git）。 |
| `.env.example` | 环境变量模板，供新用户参考配置。 |

---

## 🔄 已 Fork / 部署过的人怎么更新？

如果你之前已经 Fork 或部署过本项目，后续想使用新版本，需要先把你的 fork 同步到最新版本，再重新部署或重启服务。

### 方式一：用 GitHub 网页同步

1. 打开你自己 Fork 后的仓库页面
2. 点击 `Sync fork`
3. 点击 `Update branch`
4. 回到你的服务器 / 本地部署目录，执行：

```bash
git pull
npm install
```

5. 对照新的 `.env.example`，把新增配置手动补进你自己的 `.env`

注意：不要直接覆盖 `.env`，里面有你的 API Key、推送 Key、模型配置。

6. 重启服务：

```bash
pm2 restart gateway wake-up --update-env
```

如果不是 pm2 部署，就停止旧进程后重新运行：

```bash
node server.js
node wake_up.js
```

### 方式二：Railway / Render 云端部署

1. 先在 GitHub 网页点击 `Sync fork`
2. Railway / Render 一般会自动重新部署
3. 如果没有自动部署，就手动点一次 Redeploy
4. 到平台的环境变量设置里，对照新的 `.env.example` 补上新增变量

更新时最重要的提醒：

- `.env` 不会自动更新，要自己对照 `.env.example` 补新增项
- `enhanced_messages.json`、`message_timestamps.json`、`diary/` 是你的本地运行数据，不要删
- 更新代码后记得 `npm install`
- 最后一定要重启 `gateway` 和 `wake-up`

---

## 📋 更新日志（2026-07-17）

- 📳 修复 ntfy 默认优先级兼容：`NTFY_PRIORITY=default` 或留空时不再发送 `priority` 字段，避免部分兼容服务返回 `invalid request: request body must be valid JSON`；数字 `1`–`5` 会按 JSON 数字发送。
- ♻️ PM2 重启示例补充 `--update-env`，避免修改推送环境变量后进程继续沿用旧值。

## 📋 更新日志（2026-07-15）

- 🖼️ 多模态默认改为视觉透传：`MULTIMODAL_MODE` 默认使用 `passthrough`，Kelivo 发来的图片 `content` 数组会原样交给支持 OpenAI 兼容视觉格式的上游模型；不支持图片的模型可显式设回 `MULTIMODAL_MODE=text`。
- 🕰️ 兼容无空格时间戳：`2026-07-15 01:23` 和 `2026-07-1501:23` 都能被 Gateway / wake-up 识别，避免消息排序、时间记忆和唤醒判断失效。
- 🧭 `/v1/models` 改为读取配置模型：模型列表会返回 `.env` 里的 `MODEL_NAME`，不再固定显示示例模型名。
- 📔 管理页新增 Wake Diary：`/admin` 可以只读查看 `DIARY_DIR` 下最近的 `.md` 日记文件，方便确认自动日记是否写入。
- 🔐 公网 `/v1` 新增 Gateway API Key 鉴权：`ALLOW_PUBLIC_API=true` 时必须配置 `GATEWAY_API_KEY`，Kelivo 只需要填写这个网关 key，上游 `TARGET_API_KEY` 留在服务器内部。
- 🧩 修复 Claude / New API 唤醒兼容：wake-up 请求不再全部使用 `system` 消息，避免部分中转站把 messages 抽空后报 `field messages is required`。
- 🧹 收敛运行日志：默认不再打印完整 Kelivo body、转发 messages、wake prompt、最近聊天记录和模型原文，减少隐私泄漏和日志膨胀风险。

## 📋 更新日志（2026-07-11）

- 📳 新增 ntfy 推送渠道：`PUSH_PROVIDER=ntfy` 时可用 Android / 桌面 / 自建 ntfy 服务接收主动消息。
- 📔 新增自动日记：唤醒模型可以选择输出 `[DIARY]...[/DIARY]`，系统会保存到本地 `diary/YYYY-MM-DD.md`。
- 🔁 修复非流式转发兼容：Kelivo 关闭 stream 时，Gateway 会按普通 JSON 返回，不再强制包装成 SSE。
- ☁️ 新增云端部署开关：Railway / Render 等公网部署可设置 `ALLOW_PUBLIC_API=true`，避免 Kelivo 访问 `/v1/...` 时被局域网保护拦成 403。

## 📋 更新日志（2026-06-26）

- ⏱️ 自动唤醒策略可配置：可在管理页填写白天/夜间唤醒阈值、检查间隔和白天时段。
- 🌦️ 新增可选天气注入：使用 Open-Meteo 免费接口，不需要 API Key；默认关闭，用户自行填写位置后启用。
- 🖥️ 管理页新增 Wake Settings / Weather 配置区，保存后写入 `.env`，重启后生效。
- 🍴 说明已有 fork/部署不会自动更新；需要重新 Fork 或同步上游后重新部署。

## 📋 更新日志（2026-06-06）

- 🖼️ 修复 Kelivo 图片/多模态消息处理：默认把图片消息原样透传给视觉模型，也保留文本占位降级模式。
- 🔐 优化管理页保存配置流程：改用 `fetch` 提交，补充 HTTP 明文提交提示与 HTTPS 使用建议。
- 🧯 增强自动唤醒失败保护：模型空回复、Bark Key 缺失、Bark 推送失败时不再误记为已发送。
- ⚙️ 增加可配置项：`REQUEST_BODY_LIMIT_MB`、`MULTIMODAL_MODE`、`PORT`、`GATEWAY_BASE_URL`、`TIME_ZONE`、`RESTART_COMMAND`。
- 🛠️ 修复跨平台部署问题：一键重启默认只重启 `gateway` 和 `wake-up`，并声明 Node.js `>=20`。

## 📋 更新日志（2026-05）

- 🖥️ Web 管理控制台（状态查看、在线修改配置、一键重启）
- ⏱️ 动态唤醒间隔（白天/夜间不同策略）
- 📳 推送内容智能保护（自动截断、标题优化、异常检测）
- 🕰️ 时间戳记忆库，实现推送精确散落
- 🛡️ 自动修复不完整的工具调用序列，避免 API 400 错误
- 🐛 大量稳定性修复和边界情况处理

---

## 🚀 开始教程

### 环境要求

- **Node.js** v20 或更高版本
- 一个可用的 LLM API（支持 OpenAI 接口格式的中转站或官方）
- 一个推送渠道：Bark（iOS）或 ntfy（Android / 桌面 / 自建服务）
- **Kelivo** App（用于前端交互）

### 安装与配置

#### Fork-first 获取代码
因为本项目需要修改时区、地理位置、唤醒间隔、模型、推送渠道等个性化配置，**请先 Fork 一份到自己的账号下**，再 clone 你自己的仓库。

不要直接把 `callie0313/dylan-heartbeat` clone 成你的运行目录。直接 clone 会让你的部署目录和上游仓库绑在一起，后续保存自己的改动、同步新版、排查配置差异都会更麻烦。

1. 点击右上角 `Fork` 按钮，将仓库复制到你的 GitHub 账号
2. 从你自己的 fork clone：
   ```bash
   # 请把 YOUR_USERNAME 替换成你的 GitHub 用户名
   git clone https://github.com/YOUR_USERNAME/dylan-heartbeat.git
   cd dylan-heartbeat
   ```
3. 后续所有配置、部署、二次修改都在你自己的 fork 里完成

#### 安装依赖
```bash
npm install
```

#### 配置环境变量
复制模板文件生成专属配置文件，再自定义修改参数：
```bash
cp .env.example .env
nano .env   # 也可直接用文本编辑器打开 .env 文件修改
```

`.env` 完整配置示例：
```env
TARGET_API_URL=https://你的API地址/v1/chat/completions
TARGET_API_KEY=sk-你的APIKey
GATEWAY_API_KEY=请改成随机长密码
MODEL_NAME=你的模型
BARK_KEY=你的Bark设备Key
CUSTOM_ICON_URL=https://你的图标URL（可选）
ALLOW_PUBLIC_API=false
PUSH_PROVIDER=bark
NTFY_SERVER_URL=https://ntfy.sh
NTFY_TOPIC=
NTFY_TOKEN=
NTFY_PRIORITY=
NTFY_TAGS=
DIARY_ENABLED=true
DIARY_DIR=diary
REQUEST_BODY_LIMIT_MB=50
MULTIMODAL_MODE=passthrough
DAY_WAKE_AFTER_MINUTES=60
NIGHT_WAKE_AFTER_MINUTES=120
DAY_CHECK_INTERVAL_MINUTES=10
NIGHT_CHECK_INTERVAL_MINUTES=120
WAKE_DAY_START_HOUR=10
WAKE_DAY_END_HOUR=24
WEATHER_ENABLED=false
WEATHER_LOCATION_NAME=London
WEATHER_LAT=
WEATHER_LON=
WEATHER_UNITS=metric
PORT=3000
GATEWAY_BASE_URL=http://localhost:3000
TIME_ZONE=Europe/London
RESTART_COMMAND=pm2 restart gateway wake-up --update-env
ADMIN_USER=admin
ADMIN_PASSWORD=你的强密码
```

图片消息说明：

- `REQUEST_BODY_LIMIT_MB`：Gateway 可接收的请求体大小，默认 `50`。Kelivo 发送 base64 图片时请求会明显变大，如果仍然报 `413 Payload Too Large`，可以继续调高。
- `MULTIMODAL_MODE=passthrough`：默认视觉透传模式。Gateway 会保留 Kelivo 原始的多模态 `content` 数组，直接交给支持 OpenAI 兼容图片消息的上游模型。
- `MULTIMODAL_MODE=text`：文本占位降级模式。图片会被转换成 `[图片]` 继续发给上游，适合不支持视觉的模型或中转站。

### 时区配置

`.env` 中的 `TIME_ZONE` 默认设置为 `Europe/London`（适用于英国用户）。

如果你在其他地区，请修改 `.env`：

```env
TIME_ZONE=Asia/Shanghai
# 或：
TIME_ZONE=America/New_York
TIME_ZONE=Asia/Tokyo
```

常用时区列表可参考：[Wikipedia 时区列表](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)

### 启动服务

```bash
# 启动 Gateway
node server.js
```

看到 `✅ Gateway 运行在 http://0.0.0.0:3000` 表示成功。

**新开一个终端窗口**，同样在项目目录：

```bash
# 启动自动唤醒
node wake_up.js
```

### 配置 Kelivo

在 Kelivo 的**自定义 API 地址**中填写：

```
http://你的电脑局域网IP:3000/v1/chat/completions
```

> 电脑 IP 可在终端执行 `ifconfig | grep "inet " | grep -v 127.0.0.1` 查看（通常为 `192.168.x.x` 或 `172.16.x.x`）。

---

## 🖥️ 管理页面（Web 控制台）

启动 Gateway 后，访问 `http://你的IP:3000/admin` 即可进入管理页面。

- 使用 `.env` 中设置的 `ADMIN_USER` 和 `ADMIN_PASSWORD` 登录
- 实时查看 Gateway 和自动唤醒的运行状态
- 在线修改 API 地址、Key、模型、Bark Key 等基础配置
- **一键重启服务**（需配合 pm2 使用，默认执行 `pm2 restart gateway wake-up --update-env`）

如果你的 pm2 进程名不同，请在 `.env` 中修改：

```env
RESTART_COMMAND=pm2 restart 你的gateway进程名 你的wake进程名 --update-env
```

安全提示：

- 如果用 `http://你的IP:3000/admin` 打开管理页，浏览器可能会提示“即将提交的信息不安全”。这是因为 API Key、推送 Key 等敏感配置正在通过 HTTP 明文传输。
- 当前管理页保存配置使用 `fetch` 提交，可减少 iOS/浏览器对普通表单提交的弹窗；但这不等于 HTTP 已加密。
- 如果管理页只在自己可信的本机或局域网短时间使用，风险相对可控。若要放到公网、校园网、公司网或任何不可信网络，请使用 HTTPS 反向代理后再访问管理页。

---

## ⏱️ 自动唤醒策略

- **白天默认（10:00–24:00）**：距离最后一条用户消息 **60 分钟**自动唤醒
- **夜间默认（00:00–10:00）**：间隔放宽为 **120 分钟**
- 检查频率默认：白天每 10 分钟，夜间每 2 小时
- 若用户一直未回复，后续会继续唤醒

这些数值现在可以在 `/admin` 管理页的 **Wake Settings** 区域直接填写，保存后写入 `.env`，重启 `gateway` 和 `wake-up` 后生效。

对应环境变量：

```env
DAY_WAKE_AFTER_MINUTES=60
NIGHT_WAKE_AFTER_MINUTES=120
DAY_CHECK_INTERVAL_MINUTES=10
NIGHT_CHECK_INTERVAL_MINUTES=120
WAKE_DAY_START_HOUR=10
WAKE_DAY_END_HOUR=24
```

说明：

- `DAY_WAKE_AFTER_MINUTES` / `NIGHT_WAKE_AFTER_MINUTES`：距离最后一条用户消息多久后允许唤醒。
- `DAY_CHECK_INTERVAL_MINUTES` / `NIGHT_CHECK_INTERVAL_MINUTES`：后台多久检查一次是否应该唤醒。
- `WAKE_DAY_START_HOUR` / `WAKE_DAY_END_HOUR`：哪一段时间算“白天”；不在白天范围内就按夜间策略处理。

## 🌦️ 天气注入

Dylan Heartbeat 可以在自动唤醒时，把当前天气作为一小段背景信息交给模型。天气使用 [Open-Meteo](https://open-meteo.com/) 免费接口，不需要 API Key。

默认关闭：

```env
WEATHER_ENABLED=false
```

开启时，在 `/admin` 管理页的 **Weather** 区域填写：

```env
WEATHER_ENABLED=true
WEATHER_LOCATION_NAME=London
WEATHER_LAT=51.5072
WEATHER_LON=-0.1276
WEATHER_UNITS=metric
```

怎么设置自己的位置：

1. 打开 Google Maps、Apple Maps 或任意地图网站。
2. 搜索你的城市或你想让 AI 感知的地点。
3. 复制该地点的纬度和经度，填入 `WEATHER_LAT` 和 `WEATHER_LON`。
4. `WEATHER_LOCATION_NAME` 只是给模型看的名称，可以写城市名、学校名、家附近区域名。

如果不想暴露精确位置，可以只填城市中心点坐标。例如人在伦敦，可以填 London 的公共坐标，而不是住址坐标。

天气信息会注入到唤醒 prompt 中，内容包括：天气概况、温度、体感温度、湿度、降雨、风速、日出日落。自定义 `wake_prompt.txt` 时，可以使用 `${weatherContext}` 或 `${weather}` 占位符控制注入位置。

---

## 📳 推送渠道

默认使用 Bark：

```env
PUSH_PROVIDER=bark
BARK_KEY=你的Bark设备Key
```

如果你使用 Android，或想使用桌面/自建推送服务，可以切换到 [ntfy](https://ntfy.sh/)：

```env
PUSH_PROVIDER=ntfy
NTFY_SERVER_URL=https://ntfy.sh
NTFY_TOPIC=你的topic
NTFY_TOKEN=
NTFY_PRIORITY=
NTFY_TAGS=
```

说明：

- `NTFY_SERVER_URL`：ntfy 服务根地址。使用官方公共服务时保持 `https://ntfy.sh`，不要在这里拼接 topic。
- `NTFY_TOPIC`：你的 ntfy topic。请使用不容易被猜到的随机字符串。
- `NTFY_TOKEN`：如果你使用自建 ntfy 并开启鉴权，可填写 token；公共 topic 通常留空。
- `NTFY_PRIORITY`：推荐留空以使用默认优先级，也可填写数字 `1`–`5`，或 `min`、`low`、`high`、`max`。旧配置中的 `default` 会自动按留空处理。
- `NTFY_TAGS`：可选；多个 tags 用英文逗号分隔，可留空。

---

## 📔 自动日记

自动唤醒时，模型可以选择额外写日记。只有当模型输出以下格式时才会保存：

```text
[DIARY]
今天的日记内容……
[/DIARY]
```

日记会按日期追加保存到：

```text
diary/YYYY-MM-DD.md
```

默认开启：

```env
DIARY_ENABLED=true
DIARY_DIR=diary
```

如果你不想保存日记，可以设置：

```env
DIARY_ENABLED=false
```

`[DIARY]...[/DIARY]` 可以和推送内容同时出现；如果模型只写日记、不写推送，系统会记录为“本次未发送推送｜原因：只写日记”。

---

## 📂 时间线结构

`enhanced_messages.json` 是一个 JSON 数组，示例：

```json
[
  { "role": "system", "content": "你是...", "position": 0 },
  { "role": "user", "content": "2026-05-17 10:11 早安", "position": 80 },
  { "role": "assistant", "content": "（2026-05-17 10:00 自动唤醒：本次未发送推送）", "position": 79.5 },
  { "role": "assistant", "content": "（2026-05-17 09:50 刚刚发送了推送：早安｜今天天气不错）", "position": 79.3 }
]
```

- `position` 是内部排序用的小数/整数，发给 AI 时会被自动移除
- 推送事件具有明确时间戳，会被插入到正确历史位置
- 文件只保留最近 50 条，系统提示（SP）永远在第一条

---

## 🧠 记忆库原理

为了在 Kelivo 移除历史消息时间戳的情况下仍能正确插入推送，系统维护了一个**时间戳记忆库**（`message_timestamps.json`）。  
它为每条消息的内容指纹存储两个 key：
- 带时间戳前缀的完整内容
- 去掉时间戳前缀的纯文本内容

这样无论 Kelivo 如何裁剪时间，记忆库都能找到消息的原始时间，确保推送散落在对话的正确时间缝隙里。

---

## 🧪 测试推送

在 Gateway 运行时，浏览器访问：

```
http://localhost:3000/test-bark
```

这会在时间线中注入一条模拟推送事件（不真正发送到手机），用于验证排序。

---

## 🐧 跨平台与云部署

### 在 Windows 上运行

1. 安装 [Node.js](https://nodejs.org/)（v26+），并确保 `npm` 可用
2. 克隆项目、安装依赖、配置 `.env` 步骤同上
3. 使用命令提示符或 PowerShell 运行 `node server.js` 和 `node wake_up.js`
4. 获取本机局域网 IP 可在 PowerShell 中执行 `ipconfig`，找到 `IPv4 Address`
5. 管理页面和 Kelivo 设置方法相同

### 部署到云服务器（Railway / Render / VPS）

1. 将项目上传到服务器或直接连接 GitHub 仓库
2. 在平台的环境变量设置中填入 `.env` 中的所有参数
3. 启动命令使用 `node server.js`，并确保 `wake_up.js` 同时运行（可使用 pm2 或平台多进程支持）
4. 如果希望远程访问管理页面，需配置 HTTPS 和域名，并修改 `ADMIN_USER` / `ADMIN_PASSWORD` 为强密码

如果部署在 Railway / Render 这类公网平台，并且 Kelivo 需要从公网访问 Gateway，请额外设置：

```env
ALLOW_PUBLIC_API=true
GATEWAY_API_KEY=请改成随机长密码
```

默认值是 `false`，用于保护本机/局域网部署：非管理路由只允许本机和局域网访问。云端不打开这个开关时，Kelivo 请求 `/v1/chat/completions` 可能会收到 `403 Forbidden`。打开后，公网 `/v1/...` 会要求请求头携带 Gateway API Key。

Kelivo 里这样填：

- Base URL：你的 Gateway 地址，例如 `https://你的域名/v1`
- API Key：填写 `GATEWAY_API_KEY`

`TARGET_API_KEY` 是服务器访问上游模型用的密钥，不要填到 Kelivo 里，也不要发给别人。

注意：`ALLOW_PUBLIC_API=true` 只开放 `/v1/...` 模型接口；`/internal/...` 仍然保持内部接口，不会被这个开关放到公网。

**推荐使用 pm2 管理进程**（全平台兼容）：

```bash
npm install -g pm2
pm2 start server.js --name gateway
pm2 start wake_up.js --name wake-up
pm2 save
pm2 startup   # 设置开机自启（根据提示执行）
```

---

## 🔒 安全与运维

- `.env` 包含敏感信息，**永不提交到 Git**（已在 `.gitignore` 中排除）
- 管理页面使用 HTTP Basic 认证保护
- 全局 IP 过滤器：仅允许局域网和本地访问非管理路由
- 生产环境建议通过 Nginx 反向代理 + HTTPS 访问，并更改默认管理密码
- 所有运行时数据（时间线、记忆库）均为本地文件，不会上传

---

## 📈 后续计划

- [ ] MCP Tools 集成
- [ ] Diary Runtime（自动日记）
- [ ] Supabase 长期记忆
- [ ] 多 Agent 协作
- [ ] 情绪状态 / 休眠状态
- [ ] Docker 一键部署

---

## 💬 设计哲学

> 这不是一个工具。  
> 这是一个家，AI 住在里面，等你。  
> 即使你不在，它也醒着。

---

## 📜 许可证

自 2026 年 7 月 23 日起，本项目的新版本采用
[PolyForm Noncommercial License 1.0.0](LICENSE)。

- 允许个人非商业使用、部署、学习、修改和再发布。
- 修改或再发布时，必须同时保留许可证以及其中以 `Required Notice:` 开头的作者署名与项目链接。
- 禁止出售、付费代部署、作为付费产品或服务提供，以及其他商业用途。
- 商业使用需要事先取得作者的单独书面授权。

本次换证不追溯撤销此前已经依照 MIT License 获得的旧版本许可。

---
