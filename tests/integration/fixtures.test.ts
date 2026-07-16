import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createFakeCliFixture } from "../support/fake-cli.ts";
import { startFakeHerdrServer } from "../support/fake-herdr-server.ts";

test("lifecycle support fake Herdr server is explicit, reusable, and idempotently closed", async () => {
  const server = await startFakeHerdrServer((request) => ({ id: request.id ?? "none", result: { ok: true } }));
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(server.socketPath);
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.once("data", (data: string) => {
        resolve(data);
        socket.end();
      });
      socket.once("connect", () => socket.write('{"id":"1","method":"ping","params":{}}\n'));
    });
    assert.deepEqual(JSON.parse(response), { id: "1", result: { ok: true } });
    assert.equal(server.requests[0]?.method, "ping");
  } finally {
    await server.close();
    await server.close();
  }
});

test("lifecycle support fake CLI captures argv, selected env, cwd, and stdin", async () => {
  const fixture = await createFakeCliFixture(["PI_HERDR_SUBAGENT"]);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(fixture.executable, ["--model", "example"], {
        env: { ...process.env, PI_HERDR_SUBAGENT: "1" },
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Fake CLI exited ${String(code)}: ${stderr}`));
      });
      child.stdin.end("delegated task\n");
    });
    const capture = await fixture.readCapture();
    assert.deepEqual(capture.argv, ["--model", "example"]);
    assert.equal(capture.env.PI_HERDR_SUBAGENT, "1");
    assert.equal(capture.stdin, "delegated task\n");
  } finally {
    await fixture.cleanup();
  }
});
