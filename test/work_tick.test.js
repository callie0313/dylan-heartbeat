const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shane-work-tick-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";
process.env.TARGET_API_URL = "http://model.test/v1/chat/completions";
process.env.TARGET_API_KEY = "test-key";
process.env.MODEL_NAME = "test-model";

const originalModuleLoad = Module._load;
Module._load = function fixtureModuleLoad(request, parent, isMain) {
  if (request === "dotenv") return { config() {} };
  return originalModuleLoad.call(this, request, parent, isMain);
};
const { runtimeDirectory } = require("../runtime_paths");
const { WORK_TICK_INTERVAL_MS, isWorkTickWindow, runWorkTick, runWakeUp } = require("../wake_up");
Module._load = originalModuleLoad;
const TIMELINE = path.join(DATA_DIR, "enhanced_messages.json");
const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const originalFetch = global.fetch;

function reset() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(TIMELINE, JSON.stringify([
    { role: "system", content: "人格提示" },
    { role: "user", content: "（2020-01-01 10:00）旧消息" }
  ]));
}

test.after(() => {
  global.fetch = originalFetch;
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test("Work Tick 在正常工作窗口及 17:30–17:59 结算窗口运行", () => {
  assert.equal(WORK_TICK_INTERVAL_MS, 30 * 60 * 1000);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T08:14:00+08:00")), false);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T08:15:00+08:00")), true);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T08:20:00+08:00")), true);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T08:29:00+08:00")), true);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T08:30:00+08:00")), true);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T17:29:00+08:00")), true);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T17:30:00+08:00")), true);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T17:59:00+08:00")), true);
  assert.equal(isWorkTickWindow(new Date("2026-09-07T18:00:00+08:00")), false);
  assert.equal(isWorkTickWindow(new Date("2026-09-12T10:00:00+08:00")), false);
});

test("班前 Work Tick 只刷新 PRE_WORK / COMMUTING_TO_WORK，不创建模型调用或 Wake", async () => {
  reset();
  let modelCalls = 0;
  global.fetch = async url => {
    if (String(url).includes("model.test")) modelCalls++;
    throw new Error(`unexpected fetch: ${url}`);
  };
  await runWorkTick(new Date("2026-09-07T08:15:00+08:00"));
  const stateFile = path.join(WORK_DIR, "state.json");
  let state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual([state.work_state, state.activity, state.location], ["PRE_WORK", "preparing_for_work", "OFF_SITE"]);
  await runWorkTick(new Date("2026-09-07T08:20:00+08:00"));
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual([state.work_state, state.activity, state.location], ["COMMUTING_TO_WORK", "commuting_to_work", "COMMUTE"]);
  await runWorkTick(new Date("2026-09-07T08:30:00+08:00"));
  state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.work_state, "ON_DUTY");
  assert.equal(modelCalls, 0);
});

test("没有 Work request 的 Work Tick 不调用模型或普通 wake", async () => {
  reset();
  let modelCalls = 0;
  global.fetch = async url => {
    if (String(url).includes("model.test")) modelCalls++;
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await runWorkTick(new Date("2026-09-07T10:00:00+08:00"));
  assert.deepEqual(result, { ran: true, dispatched: false });
  assert.equal(modelCalls, 0);
});

test("17:30 后结算窗口刷新 OFF_DUTY，重复 tick 不重复工时或工作数据", async () => {
  reset();
  await runWorkTick(new Date("2026-09-07T17:29:00+08:00"));
  await runWorkTick(new Date("2026-09-07T17:31:00+08:00"));
  const stateFile = path.join(WORK_DIR, "state.json");
  const hoursFile = path.join(WORK_DIR, "work_hours.json");
  const eventsFile = path.join(WORK_DIR, "events.json");
  const tasksFile = path.join(WORK_DIR, "tasks.json");
  const wakeFile = path.join(WORK_DIR, "wake_requests.json");
  const first = {
    state: JSON.parse(fs.readFileSync(stateFile, "utf8")),
    hours: JSON.parse(fs.readFileSync(hoursFile, "utf8")),
    events: JSON.parse(fs.readFileSync(eventsFile, "utf8")),
    tasks: JSON.parse(fs.readFileSync(tasksFile, "utf8")),
    wake: fs.existsSync(wakeFile) ? fs.readFileSync(wakeFile, "utf8") : null
  };
  await runWorkTick(new Date("2026-09-07T17:45:00+08:00"));
  const second = {
    hours: JSON.parse(fs.readFileSync(hoursFile, "utf8")),
    events: JSON.parse(fs.readFileSync(eventsFile, "utf8")),
    tasks: JSON.parse(fs.readFileSync(tasksFile, "utf8")),
    wake: fs.existsSync(wakeFile) ? fs.readFileSync(wakeFile, "utf8") : null
  };
  assert.equal(first.state.work_state, "OFF_DUTY");
  assert.equal(first.state.activity, "off_duty");
  assert.equal(first.hours.filter(item => item.type === "NORMAL").length, 1);
  assert.deepEqual(second, { hours: first.hours, events: first.events, tasks: first.tasks, wake: first.wake });
});

test("并发 wake 只允许一次模型调用", async () => {
  reset();
  let modelCalls = 0;
  global.fetch = async url => {
    if (String(url).includes("model.test")) {
      modelCalls++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ choices: [{ message: { content: "[NO_ACTION] 测试" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("/internal/wake-event")) return new Response("{}", { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  };
  const [first, second] = await Promise.all([runWakeUp(), runWakeUp()]);
  assert.equal(modelCalls, 1);
  assert.deepEqual([first.outcome, second.outcome].sort(), ["NO_ACTION", "WAKE_IN_PROGRESS"]);
});
