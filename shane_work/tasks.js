const fs = require("fs");
const path = require("path");
const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");

const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const TASKS_PATH = path.join(WORK_DIR, "tasks.json");

function loadTasks() {
  if (!fs.existsSync(TASKS_PATH)) return [];
  try {
    const tasks = JSON.parse(fs.readFileSync(TASKS_PATH, "utf-8"));
    return Array.isArray(tasks) ? tasks : [];
  } catch (error) {
    console.error("Shane Work 读取 tasks.json 失败:", error.message);
    return [];
  }
}

function saveTasks(tasks) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJsonAtomicSync(TASKS_PATH, tasks);
}

module.exports = { loadTasks, saveTasks };
