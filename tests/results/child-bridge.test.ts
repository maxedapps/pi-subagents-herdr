import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createChildBridgeState,
  ensureResultExchangeLayout,
  extractAssistantText,
  writeResultRequestFile,
} from "../../src/results/child-bridge.ts";
import { formatResultRequestWire } from "../../src/results/contracts.ts";

test("assistant text joins text blocks and ignores thinking/tool calls", () => {
  const candidate = extractAssistantText({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "secret" },
      { type: "text", text: "Hello" },
      { type: "toolCall", id: "1", name: "read", arguments: {} },
      { type: "text", text: " world" },
    ],
    stopReason: "stop",
    timestamp: 1,
  });
  assert.equal(candidate?.rawText, "Hello world");
  assert.equal(candidate?.emptyFinal, false);
});

test("empty assistant text remains structured-empty", () => {
  const candidate = extractAssistantText({
    role: "assistant",
    content: [{ type: "thinking", thinking: "only thinking" }],
    stopReason: "stop",
    timestamp: 1,
  });
  assert.equal(candidate?.rawText, "");
  assert.equal(candidate?.emptyFinal, true);
});

test("child bridge state machine correlates marker, replaces candidates, and publishes on settled", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-"));
  try {
    const layout = await ensureResultExchangeLayout(join(root, "result-exchange"));
    const exchange = layout.directory;
    const marker = { runId: "run-1", runNonce: "nonce", generation: 1, requestNonce: "req-1" };
    await writeResultRequestFile(exchange, marker);
    const bridge = createChildBridgeState({ runId: "run-1", runNonce: "nonce", resultExchangeDirectory: exchange });

    await bridge.onUserMessage(formatResultRequestWire(marker, "task"));
    assert.equal(bridge.state, "active");
    bridge.onAssistantMessage({ role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "toolUse", timestamp: 1 });
    bridge.onAssistantMessage({ role: "assistant", content: [{ type: "text", text: "final answer" }], stopReason: "stop", timestamp: 2 });
    const response = await bridge.onSettled();
    assert.equal(response?.rawText, "final answer");
    assert.equal(bridge.state, "idle");
    const disk = JSON.parse(await readFile(join(exchange, "responses", "000001.json"), "utf8")) as { rawText: string };
    assert.equal(disk.rawText, "final answer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unmarked user input while active invalidates correlation", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-invalid-"));
  try {
    const layout = await ensureResultExchangeLayout(join(root, "result-exchange"));
    const exchange = layout.directory;
    const marker = { runId: "run-1", runNonce: "nonce", generation: 1, requestNonce: "req-1" };
    await writeResultRequestFile(exchange, marker);
    const bridge = createChildBridgeState({ runId: "run-1", runNonce: "nonce", resultExchangeDirectory: exchange });
    await bridge.onUserMessage(formatResultRequestWire(marker, "task"));
    await bridge.onUserMessage("typed by human");
    assert.equal(bridge.state, "invalid");
    bridge.onAssistantMessage({ role: "assistant", content: [{ type: "text", text: "should not publish" }], stopReason: "stop", timestamp: 1 });
    const response = await bridge.onSettled();
    assert.equal(response, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settled without an assistant candidate does not invent an empty success final", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-empty-"));
  try {
    const layout = await ensureResultExchangeLayout(join(root, "result-exchange"));
    const exchange = layout.directory;
    const marker = { runId: "run-1", runNonce: "nonce", generation: 1, requestNonce: "req-1" };
    await writeResultRequestFile(exchange, marker);
    const bridge = createChildBridgeState({ runId: "run-1", runNonce: "nonce", resultExchangeDirectory: exchange });
    await bridge.onUserMessage(formatResultRequestWire(marker, "task"));
    const response = await bridge.onSettled();
    assert.equal(response, undefined);
    assert.equal(bridge.state, "idle");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
