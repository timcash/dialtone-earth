import assert from "node:assert/strict";
import test from "node:test";
import {
  SIMULATED_NETWORKS,
  SIMULATED_TOUR_STEPS,
  summarizeSystemResources,
} from "../src/simulation.ts";

test("simulated tour covers overview, network, host, plugins/blobs, recovery, tests, and logs", () => {
  const views = new Set(SIMULATED_TOUR_STEPS.map((s) => s.view));
  for (const required of ["overview", "network", "host", "tests", "log"]) {
    assert.ok(views.has(required), `simulated tour missing view ${required}`);
  }
  const tabs = new Set(
    SIMULATED_TOUR_STEPS.map((s) => s.networkTab).filter(Boolean),
  );
  for (const requiredTab of ["hosts", "plugins", "recovery"]) {
    assert.ok(
      tabs.has(requiredTab),
      `simulated tour missing network focus tab ${requiredTab}`,
    );
  }
});

test("system-wide simulated resource stats aggregate CPU, RAM, Disk, GPU, blobs, plugins, shells, and tests", () => {
  const summary = summarizeSystemResources(SIMULATED_NETWORKS);
  assert.equal(summary.networks, 3);
  assert.ok(summary.totalNodes >= 8);
  assert.equal(summary.onlineNodes, summary.totalNodes);
  assert.ok(summary.cpuCores > 0);
  assert.ok(summary.memTotalGb > 0 && summary.memUsedGb > 0);
  assert.ok(summary.diskTotalTb > 0 && summary.diskUsedTb > 0);
  assert.ok(summary.gpuTotalGb > 0 && summary.gpuUsedGb > 0);
  assert.ok(summary.blobObjects > 0 && summary.blobTotalMb > 0);
  assert.ok(summary.activePlugins > 0);
  assert.ok(summary.activeShellSessions > 0);
  assert.ok(summary.recoveryEventsCount > 0);
  assert.ok(summary.totalTests > 0 && summary.passingTests === summary.totalTests);
});

test("simulated data contains valid 32-hex test-ids and zero real private identifiers", () => {
  const serialized = JSON.stringify({
    networks: SIMULATED_NETWORKS,
    steps: SIMULATED_TOUR_STEPS,
  }).toLowerCase();

  for (const forbidden of [
    "metal.json",
    "grok-bot-metal",
    "legion-metal",
    "vm-us",
    "vm-eu",
    "vm-asia",
    "rosie",
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `simulated tour must not leak private identifier ${forbidden}`,
    );
  }

  for (const net of SIMULATED_NETWORKS) {
    assert.equal(net.simulated, true);
    for (const run of net.tests) {
      assert.match(
        run.testId,
        /^[a-f0-9]{32}$/,
        `invalid testId on ${run.name}: ${run.testId}`,
      );
      assert.ok(run.log.includes("[SIMULATED]"));
    }
  }
});
