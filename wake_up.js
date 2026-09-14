require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { buildNtfyPayload } = require("./ntfy_priority");
const { ensureDataDir, runtimeDirectory, runtimeFile } = require("./runtime_paths");
const { tick: tickShaneWork, getCurrentOnboardingContext } = require("./shane_work/shane_work");
const { loadKnowledge } = require("./shane_work/knowledge");
const { prepareWorkSyncContext, markWorkSyncDelivered, loadBaselineAwarenessContext, buildObjectiveFactBoundaryContext } = require("./shane_work/context_builder");
const {
  loadWakeRequests,
  saveWakeRequests,
  recoverExpiredInFlight,
  selectDispatchableRequest,
  markInFlight,
  completeRequest,
  retryRequest
} = require("./shane_work/wake_requests");
const { parseChatCompletionResponse } = require("./upstream_response");
const {
  formatDateTimeInTimeZone,
  getDatePartsInTimeZone,
  getHourInTimeZone,
  resolveTimeZone,
  zonedWallTimeToDate
} = require("./time_utils");

// 批注 2026-08-10：与 Gateway 共用同一 DATA_DIR；未配置时仍落回项目目录，保护旧 VPS/本机部署。
const DATA_DIR = ensureDataDir();
const TIMELINE_PATH = runtimeFile("enhanced_messages.json");
const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TIME_ZONE = resolveTimeZone();
const WEATHER_TIMEOUT_MS = 5000;
const DIARY_DIR_NAME = process.env.DIARY_DIR || "diary";
const DIARY_DIR_PATH = runtimeDirectory(DIARY_DIR_NAME, "diary");
const PUSH_TIMEOUT_MS = readPositiveTimeout("PUSH_TIMEOUT_MS", 15_000);
const WAKE_UPSTREAM_TIMEOUT_MS = readPositiveTimeout("WAKE_UPSTREAM_TIMEOUT_MS", 300_000);
const WORK_TICK_INTERVAL_MS = 30 * 60 * 1000;
let wakeRunInProgress = false;
let workWakeDispatchInProgress = false;

function readPositiveTimeout(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 1000 ? Math.floor(value) : fallback;
}

function readNumberEnv(key, fallback, options = {}) {
  const value = Number(process.env[key]);
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  return fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function getDiaryDateString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDiaryTimeString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// 批注 2026-07-11：日记只接受模型显式输出的 [DIARY] 块，避免把普通推送内容误写进本地日记。
function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  const remainingText = String(text || "").replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
    const diary = String(content || "").trim();
    if (diary) diaryBlocks.push(diary);
    return "";
  }).trim();
  return {
    diaryContent: diaryBlocks.join("\n\n").trim(),
    remainingText
  };
}

function appendDiaryEntry(content) {
  if (!readBooleanEnv("DIARY_ENABLED", true)) {
    console.log("模型写了日记，但 DIARY_ENABLED=false，本次不保存");
    return false;
  }

  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;

  fs.mkdirSync(DIARY_DIR_PATH, { recursive: true });
  const diaryFile = path.join(DIARY_DIR_PATH, `${getDiaryDateString()}.md`);
  const entry = `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
  fs.appendFileSync(diaryFile, entry, "utf-8");
  console.log(`已保存日记：${diaryFile}`);
  return true;
}

// 批注 2026-07-11：推送层扩展为 Bark/ntfy；默认仍走 Bark，保护旧部署不改 .env 也能继续运行。
async function sendPushNotification({ title, body }) {
  const provider = (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase();

  if (provider === "ntfy") {
    const topic = String(process.env.NTFY_TOPIC || "").trim();
    if (!topic) return { ok: false, providerLabel: "ntfy", reason: "NTFY_TOPIC 未配置" };

    const server = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json"
    };
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
    const payload = buildNtfyPayload({
      topic,
      title,
      message: body,
      priority: process.env.NTFY_PRIORITY,
      tags: process.env.NTFY_TAGS
    });

    const response = await fetch(server, {
      method: "POST",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      headers,
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    if (!response.ok) {
      return { ok: false, providerLabel: "ntfy", reason: responseText || `HTTP ${response.status}` };
    }
    return { ok: true, providerLabel: "ntfy" };
  }

  if (provider !== "bark") {
    return { ok: false, providerLabel: provider || "未知渠道", reason: `不支持的 PUSH_PROVIDER：${provider}` };
  }

  if (!process.env.BARK_KEY) {
    return { ok: false, providerLabel: "Bark", reason: "Bark Key 未配置" };
  }

  const barkPayload = {
    title,
    body,
    device_key: process.env.BARK_KEY,
    icon: process.env.CUSTOM_ICON_URL
  };

  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(barkPayload)
  });

  const responseText = await response.text();
  let result = {};
  try {
    result = JSON.parse(responseText);
  } catch {}
  console.log("\nBark Result:\n", result || responseText);

  if (!response.ok || (result.code && result.code !== 200)) {
    return { ok: false, providerLabel: "Bark", reason: result.message || `HTTP ${response.status}` };
  }
  return { ok: true, providerLabel: "Bark" };
}

function isDayTime(date = new Date()) {
  const hour = getHourInTimeZone(date, TIME_ZONE);
  const start = readNumberEnv("WAKE_DAY_START_HOUR", 10, { min: 0, max: 23 });
  const end = readNumberEnv("WAKE_DAY_END_HOUR", 24, { min: 1, max: 24 });
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function getWakeAfterMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_WAKE_AFTER_MINUTES", 60, { min: 1 })
    : readNumberEnv("NIGHT_WAKE_AFTER_MINUTES", 120, { min: 1 });
}

function getCheckIntervalMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_CHECK_INTERVAL_MINUTES", 10, { min: 1 })
    : readNumberEnv("NIGHT_CHECK_INTERVAL_MINUTES", 120, { min: 1 });
}

function isWorkTickWindow(date = new Date()) {
  const parts = getDatePartsInTimeZone(date, TIME_ZONE);
  const weekday = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay();
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  // 保留 17:30 后首个半小时结算窗口，让低频 Heartbeat 之外的 Work Tick 及时刷新下班状态。
  return weekday >= 1 && weekday <= 5 && minutes >= 495 && minutes < 1080;
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text") return part.text || part.content || "";
        if (part.image_url || type.includes("image")) return "[图片]";
        if (part.file || type.includes("file")) return "[文件]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (content.image_url || type.includes("image")) return "[图片]";
    if (content.file || type.includes("file")) return "[文件]";
  }

  return "[非文本内容]";
}

function summarizeWakeMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let chars = 0;
  for (const msg of list) {
    roles[msg?.role || ""] = (roles[msg?.role || ""] || 0) + 1;
    chars += normalizeContentToText(msg?.content).length;
  }
  return { total: list.length, roles, text_chars: chars };
}

function weatherCodeText(code) {
  const table = {
    0: "晴朗",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴天",
    45: "有雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "中等毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹"
  };
  return table[code] || `天气代码 ${code}`;
}

async function fetchWeatherContext() {
  if (!readBooleanEnv("WEATHER_ENABLED", false)) return "";

  const lat = Number(process.env.WEATHER_LAT);
  const lon = Number(process.env.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.log("已启用 WEATHER_ENABLED，但 WEATHER_LAT / WEATHER_LON 未正确配置，跳过天气注入");
    return "";
  }

  const location = process.env.WEATHER_LOCATION_NAME || "当前位置";
  const units = (process.env.WEATHER_UNITS || "metric").trim().toLowerCase();
  const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windSpeedUnit = units === "fahrenheit" ? "mph" : "kmh";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "sunrise,sunset");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("wind_speed_unit", windSpeedUnit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const unitsInfo = data.current_units || {};
    const lines = [
      "## 天气信息",
      `- 位置：${location}`,
      `- 当前：${weatherCodeText(current.weather_code)}，${current.temperature_2m}${unitsInfo.temperature_2m || "°C"}，体感 ${current.apparent_temperature}${unitsInfo.apparent_temperature || "°C"}`,
      `- 湿度：${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- 降雨：${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- 风速：${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
    ];
    if (Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
      lines.push(`- 日出/日落：${daily.sunrise[0]} / ${daily.sunset[0]}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.log("天气注入失败，跳过本次天气信息:", err.message);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function loadTimelineMessages() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("未找到 enhanced_messages.json");
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("enhanced_messages.json 格式错误：顶层不是数组");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("读取 enhanced_messages.json 失败:", err.message);
    return null;
  }
}

function getNow() {
  return new Date();
}

function getChinaTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function getLocalTimeString() {
  return formatDateTimeInTimeZone(new Date(), TIME_ZONE);
}

function shouldWake(lastUserTime) {
  const now = getNow();
  const diffMinutes = Math.floor((now - new Date(lastUserTime)) / 1000 / 60);
  return diffMinutes >= getWakeAfterMinutes(now);
}

function parseTimelineTimestamp(value) {
  const text = String(value || "");
  const match = text.match(/（?\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]?)(\d{1,2})[:：](\d{2})/);
  if (!match) return null;
  const [, yyyy, , month, day, hour, minute] = match;
  return zonedWallTimeToDate({ year: yyyy, month, day, hour, minute }, TIME_ZONE);
}

function getLastUserTime(messages) {
  const reversed = [...messages].reverse();
  for (const msg of reversed) {
    if (msg.role === "user") {
      const content = normalizeContentToText(msg.content);
      // 批注 2026-07-15：兼容 Kelivo 时间前缀 "YYYY-MM-DDHH:mm"；
      // 旧的 "YYYY-MM-DD HH:mm" 仍然可用，避免无空格时间导致 wake-up 误判没有用户时间。
      const parsed = parseTimelineTimestamp(content);
      if (parsed) return parsed;
    }
  }
  return null;
}

function stripPosition(messages) {
  return messages.map(({ position, ...rest }) => rest);
}

function buildWorkContext(request) {
  const factsByKey = new Map(loadKnowledge().facts.map(fact => [fact.fact_key, fact]));
  const facts = (request.fact_keys || []).map(key => factsByKey.get(key)).filter(Boolean);
  if (facts.length === 0) return "";

  const lines = facts.map(fact => {
    const snapshot = fact.known_snapshot || {};
    const details = [
      snapshot.day && `入职第 ${snapshot.day} 天`,
      snapshot.current && `当前：${snapshot.current}`,
      snapshot.recent && `刚刚经历：${snapshot.recent}`,
      snapshot.next && `下一步：${snapshot.next}`,
      snapshot.equipment_id && `设备：${snapshot.equipment_id}`,
      snapshot.category && `类别：${snapshot.category}`,
      snapshot.severity && `严重程度：${snapshot.severity}`,
      snapshot.status && `当前已知状态：${snapshot.status}`,
      snapshot.result && `结果：${snapshot.result}`
    ].filter(Boolean);
    return `- ${fact.fact_key}${details.length ? `（${details.join("；")}）` : ""}`;
  });

  return `## 当前已知工作事实\n以下仅为你本人已经知道的客观工作事实。这不是要求你汇报工作，也不代表你必须联系小北。\n不要补充、猜测或提及未提供的后台事件。是否联系小北、如何表达、是否提到这些工作事实，仍由你自行决定。\n\n${lines.join("\n")}`;
}

function buildOnboardingContext() {
  const context = getCurrentOnboardingContext();
  if (!context) return "";
  const lines = [`- 当前：${context.current || "入职适应中"}`, context.recent && `- 刚刚经历：${context.recent}`, context.next && `- 下一步：${context.next}`].filter(Boolean);
  return `## 当前入职状态\n这是你本人正在经历的入职适应阶段，不是后台任务要求。\n- 入职第 ${context.day} 天（${context.phase}）\n${lines.join("\n")}`;
}

function applyWakeTemplate(template, currentTime, diffMinutes, weatherContext, workContext) {
  const hasWorkPlaceholder = template.includes("${workContext}");
  let rendered = template
    .replace(/\\n/g, "\n")
    .replace(/\$\{currentTime\}/g, currentTime)
    .replace(/\$\{diffMinutes\}/g, diffMinutes)
    .replace(/\$\{weatherContext\}/g, weatherContext)
    .replace(/\$\{weather\}/g, weatherContext)
    .replace(/\$\{workContext\}/g, workContext);
  // 兼容旧自定义模板：优先放在输出格式前，保持与默认模板一致的阅读顺序。
  if (workContext && !hasWorkPlaceholder) {
    const outputMarker = "## 输出格式";
    rendered = rendered.includes(outputMarker)
      ? rendered.replace(outputMarker, `${workContext}\n\n${outputMarker}`)
      : `${rendered}\n\n${workContext}`;
  }
  return rendered;
}

function buildWakePrompt(currentTime, diffMinutes, weatherContext = "", workContext = "") {
  // 优先读取独立的提示词文件（推荐方式）
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    return applyWakeTemplate(template, currentTime, diffMinutes, weatherContext, workContext);
  }

  // 如果文件不存在，尝试从环境变量读取（兼容旧配置）
  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return applyWakeTemplate(process.env.WAKE_PROMPT_TEMPLATE, currentTime, diffMinutes, weatherContext, workContext);
  }

  // 默认理智版本（开源通用），可自行修改提示词
  return `
## 最高优先级规则
1. 这是一次后台自动唤醒。现在是你自己的时间，没有需要回复的新消息。
2. 你可以根据当下的情况，自行决定是否想主动联系小北、写一篇日记，或者什么都不做。
3. 这不是正在进行的实时对话。不要把最近聊天记录当作小北刚刚发来的新消息，也不要生成对话式回复。
4. 输出格式必须严格遵守下方规则。

## 唤醒信息
- 当前时间：${currentTime}
- 距离小北最后一条消息：${diffMinutes} 分钟
${weatherContext ? `\n${weatherContext}\n` : ""}
${workContext ? `\n${workContext}\n` : ""}

## 输出格式
- 如果想联系小北，直接写你想对她说的话。系统会自动打包成手机推送发送。可以是一句话，也可以第一行作为标题、第二行作为正文。
- 如果不想联系小北，只输出：[NO_ACTION]，可附带简短原因（10字以内）。
- 如果想写日记，可以额外输出 [DIARY]...[/DIARY]。只有想写时才写，不必每次都写。
- 日记和主动联系可以同时发生；如果只想写日记而不联系小北，则输出日记内容，并在其余文本中使用 [NO_ACTION]。
`;
}

async function runWakeUp({ workRequest = null } = {}) {
  if (wakeRunInProgress) return { outcome: "WAKE_IN_PROGRESS" };
  wakeRunInProgress = true;
  try {
  console.log("\n==========================");
  console.log("开始自动唤醒");
  console.log("==========================\n");

  const messages = loadTimelineMessages();
  if (!messages) return { outcome: "MODEL_FAILED", reason: "TIMELINE_UNAVAILABLE" };

  const lastUserTime = getLastUserTime(messages);
  if (!lastUserTime) {
    console.log("未找到用户时间");
    return { outcome: "MODEL_FAILED", reason: "LAST_USER_TIME_UNAVAILABLE" };
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

  if (!workRequest && !shouldWake(lastUserTime)) {
    console.log("\n暂不需要唤醒\n");
    return { outcome: "SKIPPED_INACTIVITY" };
  }

   const weatherContext = await fetchWeatherContext();
   const workContext = workRequest ? buildWorkContext(workRequest) : "";
   const workSync = prepareWorkSyncContext(now, { force: Boolean(workRequest), channel: "wake" });
   const currentWorkContext = workSync.context;
   const baselineAwareness = loadBaselineAwarenessContext();
   const baselineFactBoundary = baselineAwareness && !currentWorkContext ? buildObjectiveFactBoundaryContext() : "";
   const onboardingContext = buildOnboardingContext();
   const wakeContext = [baselineAwareness, baselineFactBoundary, currentWorkContext, workContext, onboardingContext].filter(Boolean).join("\n\n");
  const wakePrompt = buildWakePrompt(getChinaTimeString(), diffMinutes, weatherContext, wakeContext);
  const cleanMessages = stripPosition(messages);

  const historyText = cleanMessages
    .filter(msg => msg.role !== "system")
    .filter(msg => {
      const c = normalizeContentToText(msg.content);
      return !c.includes("<memories>") && !c.includes("记忆库使用策略");
    })
    .map(msg => {
      const userDisplay = process.env.USER_DISPLAY_NAME || "用户";
      const aiDisplay = process.env.AI_DISPLAY_NAME || "AI";
      const role = msg.role === "user" ? userDisplay : aiDisplay;
      let content = normalizeContentToText(msg.content);
      if (content.includes("## Memories")) {
        content = content.split("## Memories")[0];
      }
      return `[${role}] ${content}`;
    })
    .join("\n\n");

  const baseSystemPrompt = cleanMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt 
    ? normalizeContentToText(baseSystemPrompt.content).split("## Memories")[0].trim()
    : "";

  const wakeMessages = [
    {
      role: "system",
      content: [wakePrompt, cleanSP].filter(Boolean).join("\n\n")
    },
    {
      // 批注 2026-07-15：Claude/部分 New API 适配器会把 system 抽成独立字段；
      // 唤醒请求如果全是 system，上游 messages 会变空，因此最近记录必须作为 user 任务输入发送。
      role: "user",
      content: `以下是你与小北最近的聊天记录，仅供回忆和参考。

这些内容不是正在发生的实时对话，也不是小北刚刚发来的新消息。

你现在处于后台自主唤醒状态。

最近记录：

${historyText}`
    }
  ];

   console.log(JSON.stringify({
     event: "work_sync",
     source: "wake",
     injected: Boolean(baselineAwareness || currentWorkContext),
     work_sync_chars: [baselineAwareness, baselineFactBoundary, currentWorkContext].filter(Boolean).join("\n\n").length,
     messages_before_work_sync: cleanMessages.length,
     messages_sent_upstream: wakeMessages.length
   }));

  // 批注 2026-07-15：wake-up prompt 会包含最近聊天记录；
  // 默认日志只写摘要，避免公开部署时把完整上下文刷进 pm2 日志。
  console.log("\n===== WAKE MESSAGES SUMMARY =====\n");
  console.log(JSON.stringify(summarizeWakeMessages(wakeMessages)));

  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    console.log("缺少 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME，跳过本次唤醒");
    return { outcome: "MODEL_FAILED", reason: "MODEL_CONFIGURATION_UNAVAILABLE" };
  }

  const response = await fetch(process.env.TARGET_API_URL, {
    method: "POST",
    // 批注 2026-08-10：上游只建连不结束时，旧循环永远不会安排下一次检查；
    // 五分钟默认总超时只作兜底，可由 WAKE_UPSTREAM_TIMEOUT_MS 调整。
    signal: AbortSignal.timeout(WAKE_UPSTREAM_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TARGET_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.MODEL_NAME,
      messages: wakeMessages,
      temperature: 0.8,
      top_p: 0.95,
      stream: false
    })
  });

  const responseText = await response.text();
  let data;
  try {
    data = parseChatCompletionResponse(responseText, response.headers.get("content-type") || "");
  } catch (error) {
    throw new Error(`模型响应无法解析（HTTP ${response.status}）：${error.message || responseText.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }
  // 上游已成功接收本次模型调用后才移动游标；失败请求不会吞掉待同步经历。
  markWorkSyncDelivered(workSync.cursor, now, "wake");

  const rawAiText = normalizeContentToText(data.choices?.[0]?.message?.content).trim();
  console.log("\nWake Result Summary:\n");
  console.log(JSON.stringify({ choices: Array.isArray(data.choices) ? data.choices.length : 0, ai_text_chars: rawAiText.length }));

  const diaryResult = extractDiaryFromResponse(rawAiText);
  const diarySaved = appendDiaryEntry(diaryResult.diaryContent);
  const aiText = diaryResult.remainingText;

  let eventContent;
  let outcome;

  if (!aiText) {
    console.log("\nAI 未返回推送内容，本次不发送推送\n");
    eventContent = diarySaved
      ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：只写日记）`
      : `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：模型空回复）`;
    outcome = "EMPTY_RESPONSE";
  // 判断 AI 是否明确要静默
  } else if (aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/)) {
    const noActionMatch = aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/);
    // AI 选择不发送推送
    console.log("\nAI 选择不发送推送\n");
    let reason = (noActionMatch[1] || "").trim();
    if (reason.startsWith("原因：") || reason.startsWith("原因:")) {
      reason = reason.replace(/^原因[：:]\s*/, "").trim();
    }
    eventContent = reason
      ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${reason}）`
      : `（${getLocalTimeString()} 自动唤醒：本次未发送推送）`;
    outcome = "NO_ACTION";
  } else {
    // 没有 [NO_ACTION] 就视为想发推送
    console.log("\nAI 选择发送推送\n");
    let barkText = aiText;

    // 如果 AI 还是写了 [BARK] ... [/BARK] 标签，就剥掉
    const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
    if (barkMatch) {
      barkText = barkMatch[1].trim();
    } else {
      barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
      barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
    }

    // 清洗“标题：”、“正文：”前缀（如果有）
    barkText = barkText
      .replace(/^标题[：:]\s*/gm, "")
      .replace(/^正文[：:]\s*/gm, "");

    // 按行处理
    const lines = barkText.split("\n").filter(line => line.trim() !== "");

    let title, body;
    if (lines.length === 0) {
      console.log("\n推送内容清洗后为空，本次不发送推送\n");
      eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：推送内容为空）`;
      outcome = "EMPTY_RESPONSE";
    } else if (lines.length === 1) {
      title = "来自AI";
      body = lines[0].trim();
    } else if (lines.length === 2) {
      title = lines[0].trim();
      body = lines[1].trim();
    } else {
      // ≥3 行：第一行标题，剩余用空格拼接成正文
      title = lines[0].trim();
      body = lines.slice(1).map(l => l.trim()).join(" ");
    }

    if (!eventContent) {
      // 保护：截断过长正文，兼容 Bark 和 ntfy 的移动端展示。
      const safeBody = body.length > 500 ? body.substring(0, 497) + "..." : body;
      // 若标题为空或以数字开头，加个前缀，可自行修改
      let safeTitle = title || "来自伴侣";
      if (/^\d/.test(safeTitle)) safeTitle = "来自伴侣｜" + safeTitle;

      const pushResult = await sendPushNotification({ title: safeTitle, body: safeBody });
      if (!pushResult.ok) {
        console.log(`\n${pushResult.providerLabel} 推送失败，本次不发送推送\n`);
        eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${pushResult.providerLabel} 推送失败：${pushResult.reason}）`;
        outcome = "SEND_FAILED";
      } else {
        eventContent = `（${getLocalTimeString()} 刚刚给用户发了${pushResult.providerLabel}推送：${safeTitle}｜${safeBody}）`;
        outcome = "SENT";
      }
    }
  }

  try {
    const eventResponse = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: eventContent })
    });
    if (!eventResponse.ok) {
      throw new Error(`Gateway 返回 HTTP ${eventResponse.status}`);
    }
    console.log("\n已通过 Gateway 记录唤醒事件\n");
  } catch (err) {
    console.error("\n记录唤醒事件失败（Gateway 是否运行？）:\n", err.message);
  }
  return { outcome: outcome || "EMPTY_RESPONSE" };
  } finally {
    wakeRunInProgress = false;
  }
}

async function dispatchWorkWake(now = new Date()) {
  if (workWakeDispatchInProgress) return true;
  const store = loadWakeRequests();
  let changed = recoverExpiredInFlight(store, now);
  const request = selectDispatchableRequest(store, now);
  if (!request) {
    if (changed) saveWakeRequests(store);
    return false;
  }

  // 只按 fact_key 读取 allowlist knowledge；不存在的事实不会回退到世界状态。
  if (!buildWorkContext(request)) {
    completeRequest(store, request, "NO_VALID_CONTEXT", now.toISOString());
    saveWakeRequests(store);
    return true;
  }

  const attemptedAt = now.toISOString();
  try {
    workWakeDispatchInProgress = true;
    markInFlight(request, attemptedAt);
    saveWakeRequests(store);
    const result = await runWakeUp({ workRequest: request });
    const outcome = result?.outcome || "MODEL_FAILED";
    if (["SENT", "NO_ACTION", "EMPTY_RESPONSE", "SEND_FAILED"].includes(outcome)) {
      completeRequest(store, request, outcome, new Date().toISOString());
    } else {
      retryRequest(request, outcome, new Date().toISOString());
    }
  } catch (error) {
    retryRequest(request, error, new Date().toISOString());
  } finally {
    workWakeDispatchInProgress = false;
  }
  saveWakeRequests(store);
  return true;
}

async function runWorkTick(now = new Date()) {
  if (!isWorkTickWindow(now)) return { ran: false, dispatched: false };
  try {
    tickShaneWork(now);
  } catch (error) {
    console.error("Shane Work tick 失败，继续执行 Work Tick:", error.message);
    return { ran: false, dispatched: false };
  }
  return { ran: true, dispatched: await dispatchWorkWake(now) };
}

async function scheduleWorkTick() {
  try {
    await runWorkTick();
  } catch (error) {
    console.error("Shane Work Tick 出错:", error.message);
  }
  setTimeout(scheduleWorkTick, WORK_TICK_INTERVAL_MS);
}

// 从第一个有效坐标开始，所有路径都指向同一处。此阈值已锁定。
function getCheckIntervalMs() {
  // 批注 2026-06-26：公开版允许用户在管理页调整唤醒检查频率；默认值保持旧版白天10分钟、夜间2小时。
  return getCheckIntervalMinutes(new Date()) * 60 * 1000;
}

async function scheduleNextCheck() {
  try {
    // 发送心跳
    try {
      await fetch(HEARTBEAT_URL, { method: "POST" });
    } catch {}
    try {
      tickShaneWork();
    } catch (error) {
      console.error("Shane Work tick 失败，继续执行 Heartbeat:", error.message);
    }
    const dispatchedWorkWake = await dispatchWorkWake();
    if (!dispatchedWorkWake) await runWakeUp();
  } catch (err) {
    console.error("唤醒检查出错:", err);
  }
  setTimeout(scheduleNextCheck, getCheckIntervalMs());
}

// 潮水记得第一次没过礁石的时间。之后每一次涨落，都是同一片海在确认边界。
// 启动第一次检查（延迟10秒）
if (require.main === module) {
  setTimeout(scheduleNextCheck, 10_000);
  setTimeout(scheduleWorkTick, 10_000);
}

if (require.main === module) {
  console.log("\n==================================");
  console.log("Dylan Heartbeat Runtime 已启动（动态间隔）");
  console.log(JSON.stringify({
    event: "wake_runtime_config_summary",
    railway: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID),
    persistent_data: Boolean(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH),
    target_url_configured: Boolean(process.env.TARGET_API_URL),
    target_key_configured: Boolean(process.env.TARGET_API_KEY),
    model_configured: Boolean(process.env.MODEL_NAME),
    push_provider_configured: Boolean(process.env.BARK_KEY || process.env.NTFY_TOPIC),
    data_dir_ready: fs.existsSync(DATA_DIR)
  }));
  console.log("==================================\n");
}

module.exports = {
  buildWakePrompt,
  buildWorkContext,
  buildOnboardingContext,
  dispatchWorkWake,
  extractDiaryFromResponse,
  isWorkTickWindow,
  runWorkTick,
  WORK_TICK_INTERVAL_MS,
  runWakeUp
};
