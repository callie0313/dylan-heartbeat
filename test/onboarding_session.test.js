const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shane-onboarding-session-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";

const { runtimeDirectory } = require("../runtime_paths");
const { tick, getCurrentOnboardingContext } = require("../shane_work/shane_work");
const originalModuleLoad = Module._load;
Module._load = function onboardingFixtureModuleLoad(request, parent, isMain) { if (request === "dotenv") return { config() {} }; return originalModuleLoad.call(this, request, parent, isMain); };
const { buildWakePrompt, buildOnboardingContext } = require("../wake_up");
Module._load = originalModuleLoad;
const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const STATE_PATH = path.join(WORK_DIR, "state.json");
const KNOWLEDGE_PATH = path.join(WORK_DIR, "knowledge.json");
const REQUESTS_PATH = path.join(WORK_DIR, "wake_requests.json");
const EVENTS_PATH = path.join(WORK_DIR, "events.json");
const TASKS_PATH = path.join(WORK_DIR, "tasks.json");

function reset() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
}
function readJson(file, fallback = null) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
function at(value) { return new Date(value); }

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("Day 1 initializes temporary context and creates one unique 11:00 report request", () => {
  reset();
  let state = tick(at("2026-09-08T10:30:00+08:00"));
  assert.equal(state.onboarding_session.active, true);
  assert.equal(state.onboarding_context.current, "已入职，准备开始熟悉公司。");
  assert.equal(fs.existsSync(REQUESTS_PATH), false);

  state = tick(at("2026-09-08T11:00:00+08:00"));
  const knowledge = readJson(KNOWLEDGE_PATH);
  const requests = readJson(REQUESTS_PATH);
  assert.equal(state.onboarding_context.current_step_id, "ONBOARDING_DAY1_REPORT");
  assert.equal(knowledge.facts.filter(fact => fact.fact_key === "ONBOARDING:SHANE-ONBOARDING-2026-09-08").length, 1);
  assert.equal(requests.requests.length, 1);
  assert.equal(requests.requests[0].reason, "ONBOARDING_DAY1_REPORT");
  assert.deepEqual(readJson(EVENTS_PATH, []), []);
  assert.deepEqual(readJson(TASKS_PATH, []), []);

  tick(at("2026-09-08T11:00:00+08:00"));
  assert.equal(readJson(REQUESTS_PATH).requests.length, 1);
  assert.equal(readJson(KNOWLEDGE_PATH).facts.filter(fact => fact.subject_type === "ONBOARDING").length, 1);
});

test("Day 1 milestones update current self context without creating additional wake requests", () => {
  reset();
  tick(at("2026-09-08T10:30:00+08:00"));
  const state = tick(at("2026-09-08T13:30:00+08:00"));
  const steps = state.onboarding_session.history.map(item => item.step_id);
  assert.deepEqual(steps, ["ONBOARDING_DAY1_REPORT", "MEET_ERIN_AND_GEORGE", "LUNCH_DAY1", "FACTORY_ORIENTATION"]);
  assert.equal(state.work_state, "ON_DUTY");
  assert.equal(state.activity, "factory_orientation");
  assert.equal(state.onboarding_context.current_step_id, "FACTORY_ORIENTATION");
  assert.equal(readJson(REQUESTS_PATH).requests.length, 1);
});

test("Day 1 17:00 remains on duty in the maintenance room until the normal 17:30 boundary", () => {
  reset();
  tick(at("2026-09-08T10:30:00+08:00"));
  const state = tick(at("2026-09-08T17:00:00+08:00"));
  assert.equal(state.work_state, "ON_DUTY");
  assert.equal(state.activity, "organizing_tools");
  assert.equal(state.location, "MAINTENANCE_ROOM");
});

test("Day 2 completes and archives the session while preserving its one knowledge fact", () => {
  reset();
  tick(at("2026-09-08T10:30:00+08:00"));
  tick(at("2026-09-09T17:00:00+08:00"));
  const state = readJson(STATE_PATH);
  const knowledge = readJson(KNOWLEDGE_PATH);
  assert.equal(state.onboarding_session.status, "COMPLETED");
  assert.equal(state.onboarding_session.active, false);
  assert.ok(state.onboarding_session.archived_at);
  assert.equal(state.onboarding_context, null);
  assert.equal(getCurrentOnboardingContext(), null);
  const fact = knowledge.facts.find(item => item.fact_key === "ONBOARDING:SHANE-ONBOARDING-2026-09-08");
  assert.equal(fact.known_snapshot.current_step_id, "ONBOARDING_COMPLETED");
  assert.equal(readJson(REQUESTS_PATH).requests.length, 1);
});

test("the completed session does not run again or alter later normal work state", () => {
  reset();
  tick(at("2026-09-08T10:30:00+08:00"));
  tick(at("2026-09-09T17:00:00+08:00"));
  const state = tick(at("2026-09-10T13:30:00+08:00"));
  assert.equal(state.onboarding_session.active, false);
  assert.equal(state.work_state, "LUNCH");
  assert.equal(state.onboarding_context, null);
  assert.equal(readJson(REQUESTS_PATH).requests.length, 1);
});

test("active onboarding context is inserted into the existing wake prompt without a second model path", () => {
  reset();
  tick(at("2026-09-08T11:00:00+08:00"));
  const context = buildOnboardingContext();
  const prompt = buildWakePrompt("2026-09-08 11:00", 120, "", context);
  assert.match(context, /入职第 1 天/);
  assert.match(prompt, /当前入职状态/);
  assert.ok(prompt.indexOf("当前入职状态") < prompt.indexOf("## 输出格式"));
});
