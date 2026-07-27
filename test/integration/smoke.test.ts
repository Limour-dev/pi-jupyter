#!/usr/bin/env node
/**
 * Integration smoke test — against a REAL Jupyter Server (marked `slow`).
 *
 * Usage:
 *   export JUPYTER_REMOTE_URL=http://192.168.105.1:57002
 *   export JUPYTER_REMOTE_TOKEN=123456
 *   npm run test:integration
 *
 * Requires a live server; the offline unit suite (`npm test`) does NOT.
 */
import { loadConfig } from "../../src/config";
import { JupyterServer } from "../../src/kernel/server";
import { RemoteSession } from "../../src/session";

async function main() {
  console.log("=== pi-jupyter v2 integration smoke test ===\n");

  console.log("1. Loading config...");
  const config = loadConfig();
  console.log(`   ✓ url: ${config.url}`);
  console.log(`   ✓ kernel: ${config.kernelName}\n`);

  console.log("2. Creating remote session...");
  const server = new JupyterServer(config);
  const session = new RemoteSession(server, config, { peerLabel: "smoke-test" });
  await session.initialize();
  console.log(`   ✓ notebookId: ${session.notebookId}`);
  console.log(`   ✓ status: ${JSON.stringify(await session.getRuntimeStatus())}\n`);

  console.log("3. Executing code...");
  const r1 = await session.runCell("x = 41\nprint('hello', x)\nx + 1");
  console.log(`   ✓ status: ${r1.status}, exec_count: ${r1.executionCount}`);
  for (const o of r1.outputs ?? []) {
    if (o.outputType === "stream") console.log(`     stream(${o.name}): ${o.text?.trim()}`);
    if (o.outputType === "execute_result") {
      console.log(`     execute_result: ${JSON.parse(o.dataJson ?? "{}")["text/plain"]?.value}`);
    }
  }

  console.log("\n4. State persistence...");
  const r2 = await session.runCell("x + 100");
  for (const o of r2.outputs ?? []) {
    if (o.outputType === "execute_result") {
      const val = JSON.parse(o.dataJson ?? "{}")["text/plain"]?.value;
      console.log(`   ✓ x + 100 = ${val} (expected 141)`);
      if (val !== "141") throw new Error("State persistence failed");
    }
  }

  console.log("\n5. Error handling...");
  const r3 = await session.runCell("1/0");
  console.log(`   ✓ status: ${r3.status} (expected "error")`);
  if (r3.status !== "error") throw new Error("Error handling failed");

  console.log("\n6. Matplotlib inline...");
  const r4 = await session.runCell(
    'import matplotlib.pyplot as plt\nplt.plot([1,2,3,4],[1,4,9,16])\nplt.title("smoke")\nplt.gca()',
  );
  const hasImage = (r4.outputs ?? []).some((o) => {
    if (o.outputType !== "display_data" && o.outputType !== "execute_result") return false;
    return Object.keys(JSON.parse(o.dataJson ?? "{}")).some((k) => k.startsWith("image/"));
  });
  console.log(`   ✓ image output: ${hasImage ? "yes" : "no (matplotlib may be absent)"}`);

  console.log("\n7. Save notebook...");
  const savePath = "/tmp/pi-jupyter-v2-smoke.ipynb";
  await session.saveNotebook(savePath);
  console.log(`   ✓ saved to ${savePath}`);

  console.log("\n8. Shutdown...");
  await session.shutdown();
  console.log("   ✓ kernel shut down");

  console.log("\n=== ✓ All integration tests passed ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n=== ✗ Integration test failed ===");
  console.error(err);
  process.exit(1);
});
