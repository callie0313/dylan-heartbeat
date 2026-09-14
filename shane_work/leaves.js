const fs = require("fs");
const path = require("path");
const { runtimeDirectory, writeJsonAtomicSync } = require("../runtime_paths");

const WORK_DIR = runtimeDirectory("shane_work", "shane_work");
const LEAVES_PATH = path.join(WORK_DIR, "leave.json");

function loadLeaves() {
  if (!fs.existsSync(LEAVES_PATH)) return [];
  try { const leaves = JSON.parse(fs.readFileSync(LEAVES_PATH, "utf-8")); return Array.isArray(leaves) ? leaves : []; }
  catch (error) { console.error("Shane Work 读取 leave.json 失败:", error.message); return []; }
}
function saveLeaves(leaves) { fs.mkdirSync(WORK_DIR, { recursive: true }); writeJsonAtomicSync(LEAVES_PATH, leaves); }
function isOnApprovedLeave(leaves, dateKey) { return leaves.some(leave => leave && leave.status === "APPROVED" && leave.start_date <= dateKey && leave.end_date >= dateKey); }

module.exports = { loadLeaves, saveLeaves, isOnApprovedLeave };