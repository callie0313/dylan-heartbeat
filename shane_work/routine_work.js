const fs = require("fs");
const path = require("path");
const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");

const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const FILE = path.join(WORK_DIR, "routine_work.json");
const RETAIN_DAYS = 14;

function emptyStore() { return { schema_version: 1, records: [] }; }

function loadRoutineWork() {
  if (!fs.existsSync(FILE)) return emptyStore();
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return value && Array.isArray(value.records) ? { schema_version: 1, records: value.records } : emptyStore();
  } catch (error) {
    console.error("Shane Work 读取 routine_work.json 失败:", error.message);
    return emptyStore();
  }
}

function saveRoutineWork(store) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJsonAtomicSync(FILE, store);
}

function recordDate(record) { return String(record.completed_at || record.started_at || "").slice(0, 10); }

function addRoutineRecord(store, record) {
  if (store.records.some(item => item.id === record.id)) return false;
  store.records.push(record);
  const keepDates = [...new Set(store.records.map(recordDate).filter(Boolean))].sort().slice(-RETAIN_DAYS);
  store.records = store.records.filter(item => keepDates.includes(recordDate(item)));
  return true;
}

module.exports = { loadRoutineWork, saveRoutineWork, addRoutineRecord };