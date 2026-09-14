const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shane-lunch-activity-"));
process.env.DATA_DIR = DATA_DIR;
process.env.TIME_ZONE = "Asia/Shanghai";

const { tick } = require("../shane_work/shane_work");
const WORK_DIR = path.join(DATA_DIR, "shane_work");

function reset() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
}
function readJson(name, fallback = null) {
  const file = path.join(WORK_DIR, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
}

test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test("同一天午休重复 tick 保持相同 activity", () => {
  reset();
  const first = tick(new Date("2026-09-10T12:15:00+08:00"));
  const second = tick(new Date("2026-09-10T13:30:00+08:00"));
  assert.equal(first.work_state, "LUNCH");
  assert.equal(second.work_state, "LUNCH");
  assert.equal(second.activity, first.activity);
  assert.equal(second.location, first.location);
});

test("不同日期可以产生不同的午休 activity", () => {
  reset();
  const activities = new Set();
  for (let day = 10; day <= 20; day++) {
    const state = tick(new Date(`2026-09-${String(day).padStart(2, "0")}T12:15:00+08:00`));
    if (state.work_state === "LUNCH") activities.add(state.activity);
  }
  assert.ok(activities.size >= 2, `expected at least two lunch activities, got ${[...activities]}`);
  assert.ok([...activities].every(activity => ["eating", "resting", "chatting", "reading_manual"].includes(activity)));
});

test("午休扩展不创建 Work event/task/knowledge/wake request", () => {
  reset();
  const state = tick(new Date("2026-09-10T12:15:00+08:00"));
  assert.equal(state.work_state, "LUNCH");
  assert.deepEqual(readJson("events.json", []), []);
  assert.deepEqual(readJson("tasks.json", []), []);
  assert.equal(readJson("knowledge.json"), null);
  assert.equal(readJson("wake_requests.json"), null);
});
