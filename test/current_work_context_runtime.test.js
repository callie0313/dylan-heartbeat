const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "current-work-runtime-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";
const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");
const { loadCurrentWorkContext } = require("../shane_work/context_builder");
const WORK_DIR = runtimeDirectory("shane_work", "shane_work");

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("运行时 Current Work Context 只读，不推进 Work 或创建 Wake", () => {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJsonAtomicSync(path.join(WORK_DIR, "state.json"), {
    work_state: "ON_DUTY", activity: "inspection", location: "A区", with: [],
    onboarding_phase: "NORMAL", is_workday: true, on_call: false, work_session: null
  });
  writeJsonAtomicSync(path.join(WORK_DIR, "daily_life.json"), { schema_version: 1, events: [] });
  writeJsonAtomicSync(path.join(WORK_DIR, "events.json"), [{ event_id: "KEEP-EVENT" }]);
  writeJsonAtomicSync(path.join(WORK_DIR, "tasks.json"), [{ task_id: "KEEP-TASK" }]);
  writeJsonAtomicSync(path.join(WORK_DIR, "knowledge.json"), { schema_version: 1, facts: [{ fact_key: "TASK:KEEP-TASK", subject_type: "TASK", last_known_at: "2026-09-14T12:00:00+08:00", known_snapshot: { category: "PLANNED_INSPECTION", status: "DONE" } }] });
  writeJsonAtomicSync(path.join(WORK_DIR, "work_hours.json"), [{ record_id: "KEEP-HOURS" }]);
  writeJsonAtomicSync(path.join(WORK_DIR, "wake_requests.json"), { schema_version: 1, requests: [] });
  const before = new Map(["state.json", "daily_life.json", "events.json", "tasks.json", "knowledge.json", "work_hours.json", "wake_requests.json"].map(name => [name, fs.readFileSync(path.join(WORK_DIR, name), "utf8")]));
  const context = loadCurrentWorkContext(new Date("2026-09-14T17:31:00+08:00"));
  assert.match(context, /工作状态：已下班/);
  assert.match(context, /最近完成：例行检查已完成/);
  for (const [name, content] of before) assert.equal(fs.readFileSync(path.join(WORK_DIR, name), "utf8"), content);
});
