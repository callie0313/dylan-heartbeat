const fs = require("fs");
const path = require("path");
const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");

const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const HOURS_PATH = path.join(WORK_DIR, "work_hours.json");

function loadWorkHours() {
  if (!fs.existsSync(HOURS_PATH)) return [];
  try {
    const entries = JSON.parse(fs.readFileSync(HOURS_PATH, "utf-8"));
    return Array.isArray(entries) ? entries : [];
  } catch (error) {
    console.error("Shane Work 读取 work_hours.json 失败:", error.message);
    return [];
  }
}

function saveWorkHours(entries) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJsonAtomicSync(HOURS_PATH, entries);
}

module.exports = { loadWorkHours, saveWorkHours };
