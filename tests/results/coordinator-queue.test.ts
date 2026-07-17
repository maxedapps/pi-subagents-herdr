import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("a rejected per-run operation cannot escape and later queued work continues in order", async () => {
  const coordinatorUrl = pathToFileURL(resolve("src/results/coordinator.ts")).href;
  const script = `
    import assert from "node:assert/strict";
    import { setImmediate as waitForImmediate } from "node:timers/promises";
    import { ResultCoordinator } from ${JSON.stringify(coordinatorUrl)};

    const coordinator = new ResultCoordinator({
      getCheckout: () => undefined,
      listRuns: () => [],
      getRun: () => undefined,
      persistRunMetadata: async () => undefined,
    });
    const order = [];
    let releaseFirst;
    const firstBlocked = new Promise((resolveFirst) => { releaseFirst = resolveFirst; });
    const expectedError = new Error("expected queue rejection");
    const expectedValue = { continued: true };

    const first = coordinator.runExclusive("same-run", async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:reject");
      throw expectedError;
    });
    const observedError = first.then(
      () => assert.fail("the first operation unexpectedly fulfilled"),
      (error) => error,
    );
    const second = coordinator.runExclusive("same-run", async () => {
      order.push("second:start");
      return expectedValue;
    });
    const independent = coordinator.runExclusive("other-run", async () => {
      order.push("other:start");
      return "independent";
    });

    assert.equal(await independent, "independent");
    assert.deepEqual(order, ["first:start", "other:start"]);
    releaseFirst();
    assert.equal(await observedError, expectedError);
    assert.equal(await second, expectedValue);
    assert.deepEqual(order, ["first:start", "other:start", "first:reject", "second:start"]);

    const thirdValue = await coordinator.runExclusive("same-run", async () => {
      order.push("third:start");
      return 3;
    });
    assert.equal(thirdValue, 3);
    await waitForImmediate();
    assert.deepEqual(order, ["first:start", "other:start", "first:reject", "second:start", "third:start"]);
    console.log("QUEUE_CONTINUED_AFTER_REJECTION");
  `;

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--throw-deprecation",
    "--unhandled-rejections=strict",
    "--no-warnings",
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    script,
  ], { timeout: 10_000 });

  assert.match(stdout, /QUEUE_CONTINUED_AFTER_REJECTION/);
  assert.equal(stderr, "");
});
