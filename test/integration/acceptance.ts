#!/usr/bin/env tsx
/**
 * Acceptance script for 修复清单-pi-jupyter.md 附 B — runs against the LIVE
 * server with the dev sources. Not part of `npm test`.
 */
import { readFileSync } from "node:fs";
import { CONFIG_HINT } from "../../src/config";
import { formatResult } from "../../extensions/format";
import { JupyterServer } from "../../src/kernel/server";
import { RemoteSession } from "../../src/session";
import type { ShimConfig } from "../../src/config";

const BASE: ShimConfig = {
  url: "http://192.168.105.1:57002",
  token: "123456",
  kernelName: "ir",
  tlsInsecure: false,
  defaultTimeoutMs: 60_000,
  installTimeoutMs: 300_000,
  workingDir: "/tmp/pj-accept",
  timeoutRestartKernel: false,
  remoteAutoSave: false,
};

const ok = (m: string) => console.log(`   ✓ ${m}`);
const fail = (m: string) => {
  console.error(`   ✗ ${m}`);
  process.exitCode = 1;
};

async function main() {
  console.log("=== acceptance: 修复清单 附 B ===\n");

  // ── 1. legal R kernel name works (UX-7 must not block it) ──
  console.log("1. kernelName 'ir' initializes and runs R code");
  const s = new RemoteSession(new JupyterServer(BASE), BASE, { notebookId: "accept-r" });
  await s.initialize();
  ok("initialized (kernelspec validated)");
  const r1 = await s.runCell("cat(R.version.string); 1+1");
  if (r1.status !== "done") fail(`expected done, got ${r1.status}`);
  else ok(`runCell done, exec #${r1.executionCount}`);

  // ── 4. state persistence ──
  console.log("\n2. state persists across calls");
  await s.runCell("x <- 41");
  const r2 = await s.runCell("x + 1");
  // IRkernel auto-prints values as display_data (not execute_result).
  const val = JSON.parse(
    r2.outputs?.find(
      (o) => o.outputType === "execute_result" || o.outputType === "display_data",
    )?.dataJson ?? "{}",
  )["text/plain"]?.value;
  if (String(val).trim() === "[1] 42") ok(`x + 1 = ${String(val).trim()}`);
  else fail(`expected [1] 42, got ${val}`);

  // ── 5. error captured, kernel survives ──
  console.log("\n3. stop('x') is captured; kernel survives");
  const r3 = await s.runCell('stop("boom")');
  if (r3.status === "error") ok("error captured");
  else fail(`expected error, got ${r3.status}`);
  const r4 = await s.runCell("2+2");
  if (r4.status === "done") ok("kernel still alive");
  else fail(`kernel dead after error: ${r4.status}`);

  // ── 6. BUG-5: plot() yields exactly ONE image to the model ──
  console.log("\n4. BUG-5: plot() → single image (png preferred)");
  const r5 = await s.runCell("plot(1:10)");
  const { content } = formatResult(r5);
  const images = content.filter((c) => c.type === "image");
  if (images.length === 1) ok(`1 image attached (mime: ${(images[0] as any).mimeType})`);
  else fail(`expected 1 image, got ${images.length}`);

  // ── 7. BUG-6: timeout then next call must not hang ──
  console.log("\n5. BUG-6: Sys.sleep(10) + timeout 2s, next call responsive");
  const rt = await s.runCell("Sys.sleep(10)", { timeoutMs: 2_000 });
  if (rt.status === "timeout") ok("timeout reported");
  else fail(`expected timeout, got ${rt.status}`);
  const t0 = Date.now();
  const r6 = await s.runCell("5+5");
  const elapsed = Date.now() - t0;
  if (elapsed < 8_000 && (r6.status === "done" || /still busy/.test(r6.outputs?.[0]?.evalue ?? "")))
    ok(`next call settled in ${elapsed}ms with status=${r6.status} (no silent 8s+ hang)`);
  else fail(`next call took ${elapsed}ms, status=${r6.status}`);

  // ── 3. BUG-1: R install path ──
  console.log("\n6. BUG-1: bogus R package → real error (never 'Installed')");
  try {
    await s.addDependencies(["definitely_not_a_real_pkg_xyz123"]);
    await s.syncEnvironment();
    fail("expected install failure, got success");
  } catch (err) {
    const msg = (err as Error).message;
    if (/failed to install/.test(msg)) ok(`real failure surfaced: ${msg.split("\n")[0]}`);
    else fail(`unexpected error: ${msg}`);
  }

  console.log("\n7. BUG-1: real R package install → real result (install or real error)");
  const s2 = new RemoteSession(new JupyterServer(BASE), BASE, { notebookId: "accept-r2" });
  await s2.initialize();
  try {
    await s2.addDependencies(["mime"]);
    await s2.syncEnvironment();
    ok("install.packages('mime') succeeded");
  } catch (err) {
    const msg = (err as Error).message;
    if (/failed to install/.test(msg)) ok(`real error surfaced (e.g. no CRAN access): ${msg.split("\n")[0]}`);
    else fail(`unexpected error: ${msg}`);
  }

  // ── 8. BUG-2/BUG-3: notebook metadata + absolute path ──
  console.log("\n8. BUG-2/BUG-3: save_notebook → R kernelspec header, absolute path");
  const savePath = "/tmp/pj-accept/accept-r.ipynb";
  const written = await s.saveNotebook(savePath);
  const nb = JSON.parse(readFileSync(savePath, "utf-8"));
  if (nb.metadata.kernelspec.name === "ir") ok(`kernelspec.name=${nb.metadata.kernelspec.name}`);
  else fail(`kernelspec.name=${nb.metadata.kernelspec.name}`);
  if (nb.metadata.language_info.name === "r") ok(`language=${nb.metadata.language_info.name}`);
  else fail(`language=${nb.metadata.language_info.name}`);
  if (Array.isArray(nb.cells) && nb.cells.length > 0) ok(`cells recorded: ${nb.cells.length}`);
  else fail(`no cells recorded: ${nb.cells?.length}`);
  if (written === savePath && written.startsWith("/")) ok(`absolute path returned: ${written}`);
  else fail(`path: ${written}`);

  await s.shutdown();
  await s2.shutdown();

  // ── 2. UX-7: bad kernelName → helpful listing ──
  console.log("\n9. UX-7: kernelName 'R' (display name) → clear error with listing");
  const bad = new RemoteSession(new JupyterServer({ ...BASE, kernelName: "R" }), { ...BASE, kernelName: "R" });
  try {
    await bad.initialize();
    fail("expected initialize to reject");
  } catch (err) {
    const msg = (err as Error).message;
    if (/not found/.test(msg) && /ir \(R\)/.test(msg) && /not a display name/.test(msg))
      ok(`clear error:\n${msg.split("\n").slice(0, 4).join("\n")}`);
    else fail(`unhelpful error: ${msg.slice(0, 200)}`);
  }

  // ── 9. UX-8: hint mentions env AND config file ──
  console.log("\n10. UX-8: CONFIG_HINT mentions env vars and config file");
  if (CONFIG_HINT.includes("JUPYTER_REMOTE_URL") && CONFIG_HINT.includes("config.json"))
    ok("hint covers env + ~/.pi-jupyter/config.json");
  else fail(`hint: ${CONFIG_HINT}`);

  // ── python regression sanity ──
  console.log("\n11. python3 regression: bootstrap + run still work");
  const py = new RemoteSession(new JupyterServer({ ...BASE, kernelName: "python3" }), { ...BASE, kernelName: "python3" });
  await py.initialize();
  const rp = await py.runCell("1+1");
  if (rp.status === "done") ok("python3 runCell done");
  else fail(`python3 status=${rp.status}`);
  await py.shutdown();

  console.log(process.exitCode ? "\n=== ✗ some acceptance checks failed ===" : "\n=== ✓ all acceptance checks passed ===");
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error("\n=== ✗ acceptance crashed ===");
  console.error(err);
  process.exit(1);
});
