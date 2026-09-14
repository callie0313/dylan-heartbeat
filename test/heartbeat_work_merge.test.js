const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-work-merge-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";
process.env.TARGET_API_URL = "http://model.test/v1/chat/completions";
process.env.TARGET_API_KEY = "test-key";
process.env.MODEL_NAME = "test-model";
process.env.PUSH_PROVIDER = "ntfy";
process.env.NTFY_TOPIC = "test-topic";
process.env.NTFY_SERVER_URL = "http://push.test";
process.env.WEATHER_ENABLED = "false";

// 本仓库当前未安装 node_modules；仅让 fixture 跳过 dotenv 的配置读取，不替换任何业务依赖。
const originalModuleLoad = Module._load;
Module._load = function fixtureModuleLoad(request, parent, isMain) {
  if (request === "dotenv") return { config() {} };
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { runtimeDirectory } = require("../runtime_paths");
const {
  loadWakeRequests,
  saveWakeRequests,
  queueWorkWake,
  recoverExpiredInFlight,
  selectDispatchableRequest,
  markInFlight,
  completeRequest,
  retryRequest,
  WORK_WAKE_COOLDOWN_MS
} = require("../shane_work/wake_requests");
const { loadKnowledge, saveKnowledge, learnFact } = require("../shane_work/knowledge");
const { tick: tickShaneWork } = require("../shane_work/shane_work");
const { prepareWorkSyncContext, markWorkSyncDelivered } = require("../shane_work/context_builder");
const { buildWakePrompt, buildWorkContext, dispatchWorkWake, extractDiaryFromResponse, runWakeUp } = require("../wake_up");
Module._load = originalModuleLoad;

const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const TIMELINE = path.join(DATA_DIR, "enhanced_messages.json");

let modelReply = "[NO_ACTION] 测试";
let modelError = null;
let pushOk = true;
let gatewayOk = true;
let calls = [];
const originalFetch = global.fetch;

global.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  if (String(url).startsWith("http://model.test")) {
    if (modelError) throw modelError;
    return new Response(JSON.stringify({ choices: [{ message: { content: modelReply } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  if (String(url).startsWith("http://push.test")) {
    return new Response(pushOk ? "{}" : "push failed", { status: pushOk ? 200 : 500 });
  }
  if (String(url).includes("/internal/wake-event")) return new Response(gatewayOk ? "{}" : "gateway failed", { status: gatewayOk ? 200 : 500 });
  throw new Error(`unexpected fetch: ${url}`);
};

function isoNow() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function reset() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(TIMELINE, JSON.stringify([
    { role: "system", content: "人格提示" },
    { role: "user", content: `（${isoNow()}）最近消息` }
  ]));
  modelReply = "[NO_ACTION] 测试";
  modelError = null;
  pushOk = true;
  gatewayOk = true;
  calls = [];
}

function seriousEvent(id = "EV-1", status = "CHECKING") {
  return { event_id: id, equipment_id: "B02", category: "SENSOR", severity: "SERIOUS", status };
}

function knownEvent(event, channel = "DIRECT_WORK") {
  const knowledge = loadKnowledge();
  learnFact(knowledge, "EVENT", event, channel, new Date().toISOString());
  saveKnowledge(knowledge);
  return `EVENT:${event.event_id}`;
}

function queuedKnownEvent(id = "EV-1") {
  const event = seriousEvent(id);
  const factKey = knownEvent(event);
  const store = loadWakeRequests();
  assert.equal(queueWorkWake(store, id, factKey, new Date().toISOString()), true);
  saveWakeRequests(store);
  return { event, factKey };
}

test.after(() => {
  global.fetch = originalFetch;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test("1. 默认 prompt 保留协议并在正确位置插入 Work context", () => {
  reset();
  const prompt = buildWakePrompt("2026-09-07T09:00:00+08:00", 90, "## 天气信息", "## 当前已知工作事实\n- EVENT:EV-1");
  assert.match(prompt, /没有需要回复的新消息/);
  assert.ok(prompt.indexOf("## 当前已知工作事实") > prompt.indexOf("## 天气信息"));
  assert.ok(prompt.indexOf("## 当前已知工作事实") < prompt.indexOf("## 输出格式"));
  assert.match(prompt, /\[NO_ACTION\]/);
  assert.match(prompt, /\[DIARY\]/);
});

test("2. 旧自定义模板也把 Work context 插在输出格式前", () => {
  reset();
  const oldTemplate = "## 唤醒信息\n- 当前时间：${currentTime}\n\n## 输出格式\n- [NO_ACTION]";
  process.env.WAKE_PROMPT_TEMPLATE = oldTemplate;
  const prompt = buildWakePrompt("2026-09-07T09:00:00+08:00", 90, "", "## 当前已知工作事实\n- EVENT:EV-1");
  delete process.env.WAKE_PROMPT_TEMPLATE;
  assert.ok(prompt.indexOf("## 当前已知工作事实") < prompt.indexOf("## 输出格式"));
});

test("3. diary 与 NO_ACTION 的既有解析协议不变", () => {
  reset();
  const result = extractDiaryFromResponse("[DIARY]记录[/DIARY]\n[NO_ACTION] 忙碌");
  assert.equal(result.diaryContent, "记录");
  assert.equal(result.remainingText, "[NO_ACTION] 忙碌");
});

test("4. request 的 event ID 去重覆盖已完成 request", () => {
  reset();
  const key = knownEvent(seriousEvent("EV-3"));
  const store = loadWakeRequests();
  assert.equal(queueWorkWake(store, "EV-3", key, new Date().toISOString()), true);
  assert.equal(store.requests.length, 1);
  assert.equal(queueWorkWake(store, "EV-3", key, new Date().toISOString()), false);
});

test("5. 实际 tick 只为 serious DIRECT_WORK 或本人 DIRECT_CALL_OUT 创建 request", () => {
  reset();
  const callOut = { ...seriousEvent("EV-3B"), severity: "NORMAL" };
  const ordinary = { ...seriousEvent("EV-3C"), severity: "NORMAL" };
  fs.writeFileSync(path.join(WORK_DIR, "events.json"), JSON.stringify([callOut, ordinary]));
  knownEvent(callOut, "DIRECT_CALL_OUT");
  knownEvent(ordinary, "DIRECT_WORK");
  tickShaneWork(new Date("2026-09-07T09:00:00+08:00"));
  const sources = loadWakeRequests().requests.flatMap(request => request.source_event_ids);
  assert.deepEqual(sources, ["EV-3B"]);
});

test("5. 相邻 PENDING facts 合并为一个 batch", () => {
  reset();
  const store = loadWakeRequests();
  const now = new Date().toISOString();
  assert.equal(queueWorkWake(store, "EV-4A", "EVENT:EV-4A", now), true);
  assert.equal(queueWorkWake(store, "EV-4B", "EVENT:EV-4B", now), true);
  assert.equal(store.requests.length, 1);
  assert.deepEqual(store.requests[0].source_event_ids, ["EV-4A", "EV-4B"]);
});

test("6. Work request 绕过 inactivity，且一次 dispatch 只调用一个模型出口", async () => {
  reset();
  queuedKnownEvent("EV-5");
  await dispatchWorkWake(new Date());
  assert.equal(calls.filter(call => call.url.startsWith("http://model.test")).length, 1);
  assert.equal(loadWakeRequests().requests[0].outcome, "NO_ACTION");
});

test("7. SENT 完成 request 并写 cooldown 时间", async () => {
  reset();
  queuedKnownEvent("EV-6");
  modelReply = "标题\n正文";
  await dispatchWorkWake(new Date());
  const store = loadWakeRequests();
  assert.equal(store.requests[0].status, "COMPLETED");
  assert.equal(store.requests[0].outcome, "SENT");
  assert.ok(store.last_work_wake_at);
});

test("8. EMPTY_RESPONSE 完成 request", async () => {
  reset();
  queuedKnownEvent("EV-7");
  modelReply = "";
  await dispatchWorkWake(new Date());
  assert.equal(loadWakeRequests().requests[0].outcome, "EMPTY_RESPONSE");
});

test("9. SEND_FAILED 完成 request，不重复模型调用", async () => {
  reset();
  queuedKnownEvent("EV-8");
  modelReply = "标题\n正文";
  pushOk = false;
  await dispatchWorkWake(new Date());
  const store = loadWakeRequests();
  assert.equal(store.requests[0].outcome, "SEND_FAILED");
  await dispatchWorkWake(new Date(Date.now() + WORK_WAKE_COOLDOWN_MS + 1));
  assert.equal(calls.filter(call => call.url.startsWith("http://model.test")).length, 1);
});

test("10. 模型失败恢复 PENDING，并设置 retry cooldown", async () => {
  reset();
  queuedKnownEvent("EV-9");
  modelError = new Error("model unavailable");
  await dispatchWorkWake(new Date());
  const request = loadWakeRequests().requests[0];
  assert.equal(request.status, "PENDING");
  assert.ok(request.retry_after_at);
  assert.equal(request.attempt_count, 1);
});

test("11. 过期 IN_FLIGHT 会恢复 PENDING", () => {
  reset();
  const store = loadWakeRequests();
  const now = new Date();
  store.requests.push({ request_id: "WORK-EV-10", source_event_ids: ["EV-10"], fact_keys: ["EVENT:EV-10"], status: "IN_FLIGHT", in_flight_at: new Date(now.getTime() - 16 * 60 * 1000).toISOString() });
  assert.equal(recoverExpiredInFlight(store, now), true);
  assert.equal(store.requests[0].status, "PENDING");
});

test("12. cooldown 只限制 dispatch，不阻止创建 PENDING", () => {
  reset();
  const store = loadWakeRequests();
  store.last_work_wake_at = new Date().toISOString();
  assert.equal(queueWorkWake(store, "EV-11", "EVENT:EV-11", new Date().toISOString()), true);
  assert.equal(store.requests[0].status, "PENDING");
  assert.equal(selectDispatchableRequest(store, new Date()), null);
});

test("13. cooldown 到期后 pending batch 可 dispatch", async () => {
  reset();
  queuedKnownEvent("EV-12");
  const store = loadWakeRequests();
  store.last_work_wake_at = new Date().toISOString();
  saveWakeRequests(store);
  await dispatchWorkWake(new Date());
  assert.equal(calls.filter(call => call.url.startsWith("http://model.test")).length, 0);
  await dispatchWorkWake(new Date(Date.now() + WORK_WAKE_COOLDOWN_MS + 1));
  assert.equal(calls.filter(call => call.url.startsWith("http://model.test")).length, 1);
});

test("14. dispatch 时读取最新 allowlist snapshot，不读取 world 文件", async () => {
  reset();
  queuedKnownEvent("EV-13");
  const knowledge = loadKnowledge();
  knowledge.facts[0].known_snapshot.status = "RESOLVED";
  knowledge.facts[0].known_snapshot.hidden_world_field = undefined;
  saveKnowledge(knowledge);
  fs.writeFileSync(path.join(WORK_DIR, "events.json"), JSON.stringify([{ event_id: "EV-13", hidden_world_field: "DO_NOT_LEAK" }]));
  await dispatchWorkWake(new Date());
  const modelCall = calls.find(call => call.url.startsWith("http://model.test"));
  const prompt = JSON.parse(modelCall.options.body).messages[0].content;
  assert.match(prompt, /当前已知状态：RESOLVED/);
  assert.doesNotMatch(prompt, /DO_NOT_LEAK/);
});

test("15. 不存在的 fact_key 安全消费，不调用模型", async () => {
  reset();
  const store = loadWakeRequests();
  store.requests.push({ request_id: "WORK-EV-14", source_event_ids: ["EV-14"], fact_keys: ["EVENT:EV-14"], status: "PENDING", created_at: new Date().toISOString() });
  saveWakeRequests(store);
  await dispatchWorkWake(new Date());
  assert.equal(loadWakeRequests().requests[0].outcome, "NO_VALID_CONTEXT");
  assert.equal(calls.filter(call => call.url.startsWith("http://model.test")).length, 0);
});

test("16. COMPLETED event 不会因 snapshot 更新产生第二个 request", () => {
  reset();
  const store = loadWakeRequests();
  const now = new Date().toISOString();
  assert.equal(queueWorkWake(store, "EV-15", "EVENT:EV-15", now), true);
  completeRequest(store, store.requests[0], "NO_ACTION", now);
  assert.equal(queueWorkWake(store, "EV-15", "EVENT:EV-15", new Date().toISOString()), false);
});

test("17. 普通 inactivity gate 仍跳过且不发模型请求", async () => {
  reset();
  const result = await runWakeUp();
  assert.equal(result.outcome, "SKIPPED_INACTIVITY");
  assert.equal(calls.filter(call => call.url.startsWith("http://model.test")).length, 0);
});

test("18. timeline 写入失败不让已消费 request 重试模型", async () => {
  reset();
  queuedKnownEvent("EV-18");
  gatewayOk = false;
  await dispatchWorkWake(new Date());
  assert.equal(loadWakeRequests().requests[0].outcome, "NO_ACTION");
  await dispatchWorkWake(new Date(Date.now() + WORK_WAKE_COOLDOWN_MS + 1));
  assert.equal(calls.filter(call => call.url.startsWith("http://model.test")).length, 1);
});

test("19. 有 Work request 时普通 inactivity 同时命中仍只调用一次模型", async () => {
  reset();
  fs.writeFileSync(TIMELINE, JSON.stringify([
    { role: "system", content: "人格提示" },
    { role: "user", content: "（2020-01-01 09:00）很久以前的消息" }
  ]));
  queuedKnownEvent("EV-19");
  await dispatchWorkWake(new Date());
  assert.equal(calls.filter(call => call.url.startsWith("http://model.test")).length, 1);
});

test("20. UNKNOWN/NPC 事实与普通 task 不会自行成为 Work request", () => {
  reset();
  const knowledge = loadKnowledge();
  learnFact(knowledge, "EVENT", seriousEvent("EV-20"), "HANDOFF", new Date().toISOString());
  learnFact(knowledge, "TASK", { task_id: "TASK-20", category: "RECHECK", status: "ACTIVE" }, "DIRECT_WORK", new Date().toISOString());
  saveKnowledge(knowledge);
  const store = loadWakeRequests();
  assert.equal(store.requests.length, 0);
  assert.equal(buildWorkContext({ fact_keys: ["EVENT:EV-20"] }).includes("HANDOFF"), false);
});

test("21. Wake 模型请求使用共享工作同步纸条", async () => {
  reset();
  fs.writeFileSync(TIMELINE, JSON.stringify([
    { role: "system", content: "人格提示" },
    { role: "user", content: "（2020-01-01 09:00）很久以前的消息" }
  ]));
  fs.writeFileSync(path.join(WORK_DIR, "state.json"), JSON.stringify({
    work_state: "ON_DUTY", activity: "inspection", location: "A区", with: [],
    onboarding_phase: "NORMAL", is_workday: true, on_call: false, work_session: null
  }));
  await runWakeUp({ workRequest: { fact_keys: [] } });
  const modelCall = calls.find(call => call.url.startsWith("http://model.test"));
  const prompt = JSON.parse(modelCall.options.body).messages[0].content;
  assert.match(prompt, /【工作同步】/);
  assert.match(prompt, /现在：/);
  assert.match(prompt, /班次边界：/);
});

test("22. Wake Work Sync 诊断日志只记录摘要，覆盖 injected true 与 false", async () => {
  reset();
  fs.writeFileSync(TIMELINE, JSON.stringify([
    { role: "system", content: "人格提示" },
    { role: "user", content: "（2020-01-01 09:00）很久以前的消息" }
  ]));
  fs.writeFileSync(path.join(WORK_DIR, "state.json"), JSON.stringify({
    work_state: "ON_DUTY", activity: "inspection", location: "A区", with: [],
    onboarding_phase: "NORMAL", is_workday: true, on_call: false, work_session: null
  }));
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await runWakeUp({ workRequest: { fact_keys: [] } });
    const first = prepareWorkSyncContext(new Date());
    markWorkSyncDelivered(first.cursor, new Date());
    await runWakeUp();
  } finally {
    console.log = originalLog;
  }
  const diagnostics = logs
    .filter(line => line.includes('"event":"work_sync"'))
    .map(line => JSON.parse(line));
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].source, "wake");
  assert.equal(diagnostics[0].injected, true);
  assert.equal(diagnostics[1].injected, false);
  for (const entry of diagnostics) {
    assert.ok(Number.isInteger(entry.work_sync_chars));
    assert.ok(Number.isInteger(entry.messages_before_work_sync));
    assert.ok(Number.isInteger(entry.messages_sent_upstream));
    assert.doesNotMatch(JSON.stringify(entry), /inspection|A区|工作同步/);
  }
});
