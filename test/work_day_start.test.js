const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shane-work-day-start-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";

const { runtimeDirectory } = require("../runtime_paths");
const { tick } = require("../shane_work/shane_work");
const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const STATE_PATH = path.join(WORK_DIR, "state.json");
const EVENTS_PATH = path.join(WORK_DIR, "events.json");
const TASKS_PATH = path.join(WORK_DIR, "tasks.json");
const LOG_PATH = path.join(WORK_DIR, "state_changes.jsonl");

function reset() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

function readJson(file, fallback = null) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("工作日 08:30 后首次 tick 初始化 Day 1 工作上下文", () => {
  reset();
  const state = tick(new Date("2026-09-07T08:30:00+08:00"));
  assert.equal(state.work_day_started_date, "2026-09-07");
  assert.equal(state.onboarding_day, 1);
  assert.equal(state.onboarding_phase, "DAY_1");
  assert.equal(state.work_state, "ON_DUTY");
});

test("同一天后续 tick 保持同一工作开始记录，且只写一次开始日志", () => {
  reset();
  tick(new Date("2026-09-07T08:30:00+08:00"));
  const first = readJson(STATE_PATH);
  tick(new Date("2026-09-07T10:00:00+08:00"));
  const second = readJson(STATE_PATH);
  const starts = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n").map(JSON.parse).filter(entry => entry.type === "WORK_DAY_STARTED");
  assert.equal(second.work_day_started_at, first.work_day_started_at);
  assert.equal(starts.length, 1);
});

test("当日首次工作开始不生成到期的普通 event 或 task", () => {
  reset();
  tick(new Date("2026-09-04T09:00:00+08:00"));
  const state = readJson(STATE_PATH);
  state.employment_started_at = "2026-09-03T09:00:00+08:00";
  state.event_schedule = { sequence: 1, next_candidate_date: "2026-09-07" };
  state.task_schedule = { sequence: 1, next_candidate_date: "2026-09-07" };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  fs.writeFileSync(EVENTS_PATH, "[]");
  fs.writeFileSync(TASKS_PATH, "[]");
  tick(new Date("2026-09-07T08:30:00+08:00"));
  assert.deepEqual(readJson(EVENTS_PATH), []);
  assert.deepEqual(readJson(TASKS_PATH), []);
});

test("周末不初始化工作日上下文", () => {
  reset();
  const state = tick(new Date("2026-09-12T09:00:00+08:00"));
  assert.equal(state.work_day_started_date, null);
  assert.equal(state.work_state, "OFF_DUTY");
});

test("请假工作日不初始化工作日上下文", () => {
  reset();
  fs.writeFileSync(path.join(WORK_DIR, "leave.json"), JSON.stringify([{ status: "APPROVED", start_date: "2026-09-07", end_date: "2026-09-07" }]));
  const state = tick(new Date("2026-09-07T09:00:00+08:00"));
  assert.equal(state.work_day_started_date, null);
  assert.equal(state.work_state, "LEAVE");
});
