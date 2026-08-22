const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveDataDir,
  runtimeFile,
  writeJsonAtomicSync
} = require("../runtime_paths");

test("DATA_DIR 优先于 Railway 自动挂载路径", () => {
  assert.equal(
    resolveDataDir({ DATA_DIR: "/tmp/custom-data", RAILWAY_VOLUME_MOUNT_PATH: "/tmp/railway" }),
    "/tmp/custom-data"
  );
  assert.equal(
    runtimeFile("state.json", { DATA_DIR: "/tmp/custom-data" }),
    path.join("/tmp/custom-data", "state.json")
  );
});

test("原子写入在覆盖前保留上一版 JSON", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dylan-heartbeat-data-"));
  const file = path.join(directory, "state.json");

  try {
    writeJsonAtomicSync(file, { version: 1 });
    writeJsonAtomicSync(file, { version: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")), { version: 1 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
