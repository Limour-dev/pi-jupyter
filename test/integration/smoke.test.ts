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

  console.log("\n8. Remote auto-save (IT-1: snapshot lands on the server)...");
  const base = config.url.replace(/\/?$/, "/");
  const authHeaders = { Authorization: `token ${config.token}` };
  const effectivePath = `${session.notebookId}.ipynb`;
  await session.flushAutoSave(); // deterministic: drain the background worker
  const contentsRes = await fetch(`${base}api/contents/${effectivePath}`, {
    headers: authHeaders,
  });
  console.log(`   ✓ GET /api/contents/${effectivePath} -> HTTP ${contentsRes.status}`);
  if (contentsRes.status !== 200) throw new Error("auto-saved notebook not found on the server");
  const remoteNb = (await contentsRes.json()) as { type?: string; content?: { cells?: unknown[] } };
  if (remoteNb.type !== "notebook") throw new Error("remote file is not a notebook");
  const remoteCells = remoteNb.content?.cells?.length ?? -1;
  console.log(`   ✓ remote snapshot cells: ${remoteCells} (expected 4)`);
  if (remoteCells !== 4) throw new Error(`expected 4 remote cells, got ${remoteCells}`);

  console.log("\n9. Sync invariant (IT-2: /api/sessions row shares the same path)...");
  const sessionsRes = await fetch(`${base}api/sessions`, { headers: authHeaders });
  const sessions = (await sessionsRes.json()) as Array<{
    path?: string;
    kernel?: { id?: string; name?: string; execution_state?: string };
  }>;
  const row = sessions.find((s) => s.path === effectivePath);
  if (!row?.kernel?.id) throw new Error(`no /api/sessions row for ${effectivePath}`);
  console.log(
    `   ✓ session row: path=${row.path}, kernel=${row.kernel.id} (${row.kernel.name ?? "?"}, ${row.kernel.execution_state ?? "?"})`,
  );

  console.log("\n10. Sub-directory target (IT-3: remoteSavePath auto-creates dirs)...");
  const subConfig = { ...config, remoteSavePath: `pi-test-${Date.now()}/auto.ipynb` };
  const subServer = new JupyterServer(subConfig);
  const subSession = new RemoteSession(subServer, subConfig, { peerLabel: "smoke-subdir" });
  await subSession.initialize();
  await subSession.runCell("z = 7");
  await subSession.flushAutoSave();
  const subRes = await fetch(`${base}api/contents/${subConfig.remoteSavePath}`, {
    headers: authHeaders,
  });
  console.log(`   ✓ GET /api/contents/${subConfig.remoteSavePath} -> HTTP ${subRes.status}`);
  if (subRes.status !== 200) throw new Error("sub-directory auto-save target not created");
  await subSession.shutdown();

  console.log("\n11. Shutdown...");
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
