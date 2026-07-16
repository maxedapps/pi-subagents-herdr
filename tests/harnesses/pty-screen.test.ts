import assert from "node:assert/strict";
import test from "node:test";
import { harnessAdapter } from "../../src/harnesses/index.ts";
import { createFakePtyCliFixture } from "../support/fake-pty-cli.ts";

const KEY_BYTES: Readonly<Record<string, string>> = {
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  escape: "\x1b",
  enter: "\r",
};

function sendKeys(process: NodeJS.WritableStream, keys: readonly string[]): void {
  process.write(keys.map((key) => KEY_BYTES[key] ?? key).join(""));
}

test("PTY/screen fixture exercises Pi Control-C interrupt and graceful EOF exit without a model or fake socket", async () => {
  const fixture = await createFakePtyCliFixture();
  try {
    assert.equal(fixture.transport, "pty");
    const adapter = harnessAdapter("pi");
    sendKeys(fixture.process.stdin, adapter.capabilities.interruptKeys);
    await fixture.waitFor("SCREEN:INTERRUPTED:CTRL_C");
    assert.equal(adapter.capabilities.gracefulExit.kind, "keys");
    if (adapter.capabilities.gracefulExit.kind === "keys") sendKeys(fixture.process.stdin, adapter.capabilities.gracefulExit.keys);
    await fixture.waitFor("SCREEN:EXIT:CTRL_D");
  } finally { await fixture.cleanup(); }
});

test("PTY/screen fixture exercises Claude Escape interrupt and Ctrl-D exit", async () => {
  const fixture = await createFakePtyCliFixture();
  try {
    const adapter = harnessAdapter("claude");
    sendKeys(fixture.process.stdin, adapter.capabilities.interruptKeys);
    await fixture.waitFor("SCREEN:INTERRUPTED:ESCAPE");
    assert.equal(adapter.capabilities.gracefulExit.kind, "keys");
    if (adapter.capabilities.gracefulExit.kind === "keys") sendKeys(fixture.process.stdin, adapter.capabilities.gracefulExit.keys);
    await fixture.waitFor("SCREEN:EXIT:CTRL_D");
  } finally { await fixture.cleanup(); }
});

test("PTY/screen fixture exercises Codex Escape interrupt and /exit graceful action", async () => {
  const fixture = await createFakePtyCliFixture();
  try {
    const adapter = harnessAdapter("codex");
    sendKeys(fixture.process.stdin, adapter.capabilities.interruptKeys);
    await fixture.waitFor("SCREEN:INTERRUPTED:ESCAPE");
    assert.equal(adapter.capabilities.gracefulExit.kind, "input");
    if (adapter.capabilities.gracefulExit.kind === "input") {
      fixture.process.stdin.write(adapter.capabilities.gracefulExit.text);
      sendKeys(fixture.process.stdin, adapter.capabilities.gracefulExit.keys);
    }
    await fixture.waitFor("SCREEN:EXIT:SLASH");
  } finally { await fixture.cleanup(); }
});
