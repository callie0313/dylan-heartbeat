const assert = require("node:assert/strict");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const test = require("node:test");

test("模型列表返回配置的 MODEL_NAME", async () => {
  const port = 3101;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, MODEL_NAME: "step-3.7-flash", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await new Promise((resolve, reject) => {
      let output = "";
      server.stdout.on("data", chunk => {
        output += chunk;
        if (output.includes("Server listening")) resolve();
      });
      server.once("error", reject);
      server.once("exit", code => reject(new Error(`Gateway 启动失败，退出码：${code}`)));
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data[0].id, "step-3.7-flash");
  } finally {
    server.kill();
    await once(server, "exit");
  }
});
