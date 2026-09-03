/**
 * Unit tests: RemoteSession against a MOCK KernelPort/ServerPort.
 *
 * Demonstrates the payoff of the hexagonal seam: the entire session lifecycle
 * (init, run, deps, save, shutdown, observable) is verified with zero Jupyter
 * Server and zero network.
 */
import { readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShimConfig } from "../../src/config";
import { TimeoutError } from "../../src/domain/types";
import type { ExecuteOptions, KernelPort, ServerPort } from "../../src/kernel/port";
import { normalizeContentsPath, RemoteSession } from "../../src/session";

const CONFIG: ShimConfig = {
  url: "http://x",
  token: "t",
  kernelName: "python3",
  tlsInsecure: false,
  defaultTimeoutMs: 1000,
  installTimeoutMs: 1000,
  workingDir: "/tmp",
  timeoutRestartKernel: false,
  keepKernels: true,
  remoteAutoSave: true,
};

/** CONFIG with an R kernelspec selected. */
const CONFIG_R: ShimConfig = { ...CONFIG, kernelName: "ir" };

const SPECS = {
  default: "python3",
  specs: [
    { name: "python3", displayName: "Python 3", language: "python" },
    { name: "ir", displayName: "R", language: "r" },
  ],
};

function makeKernelPort(): KernelPort & { execute: ReturnType<typeof vi.fn> } {
  return {
    // Default: a no-op silent ok. Individual tests override via mockImplementation.
    execute: vi.fn(async (_code: string, _opts?: ExecuteOptions) => ({
      outputs: [],
      executionCount: undefined,
      status: "ok" as const,
    })),
    interrupt: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    isDisposed: false,
    connectionStatus: "connected",
    status: "idle",
    waitConnected: vi.fn().mockResolvedValue(undefined),
    waitIdle: vi.fn().mockResolvedValue(true),
  };
}

function makeServerPort(kernel: KernelPort): ServerPort & {
  ping: ReturnType<typeof vi.fn>;
  listKernelSpecs: ReturnType<typeof vi.fn>;
  startKernel: ReturnType<typeof vi.fn>;
  findLiveSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  connectToSession: ReturnType<typeof vi.fn>;
  readNotebook: ReturnType<typeof vi.fn>;
  uploadNotebook: ReturnType<typeof vi.fn>;
} {
  return {
    ping: vi.fn().mockResolvedValue(undefined),
    listKernelSpecs: vi.fn().mockResolvedValue(SPECS),
    startKernel: vi.fn().mockResolvedValue(kernel),
    findLiveSession: vi.fn().mockResolvedValue(null),
    listSessions: vi.fn().mockResolvedValue([]),
    connectToSession: vi.fn().mockResolvedValue(kernel),
    readNotebook: vi.fn().mockResolvedValue(null),
    uploadNotebook: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

describe("RemoteSession", () => {
  let kernel: ReturnType<typeof makeKernelPort>;
  let server: ReturnType<typeof makeServerPort>;

  beforeEach(() => {
    kernel = makeKernelPort();
    server = makeServerPort(kernel);
  });

  it("initialize: pings, starts kernel, waits connected, bootstraps", async () => {
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    expect(server.ping).toHaveBeenCalledTimes(1);
    expect(server.startKernel).toHaveBeenCalledWith(
      "python3",
      expect.objectContaining({ sessionPath: expect.any(String) }),
    );
    expect(kernel.waitConnected).toHaveBeenCalledTimes(1);
    // bootstrap + missing-package probe = at least 2 silent executes
    expect(kernel.execute.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("initialize: pre-installs constructor dependencies via %pip", async () => {
    const s = new RemoteSession(server, CONFIG, { dependencies: ["pandas"] });
    await s.initialize();
    const codes = kernel.execute.mock.calls.map((c) => c[0] as string);
    expect(codes.some((c) => c.includes("%pip install --quiet pandas"))).toBe(true);
  });

  it("runCell: maps ok status to done + tracks executionCount", async () => {
    kernel.execute.mockImplementation(async (code: string) => {
      if (code.includes('"missing"')) {
        return { outputs: [], status: "ok" as const, executionCount: undefined };
      }
      return {
        outputs: [{ outputType: "stream" as const, name: "stdout", text: "hi\n" }],
        status: "ok" as const,
        executionCount: 1,
      };
    });
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    const r = await s.runCell("print('hi')");
    expect(r.status).toBe("done");
    expect(r.success).toBe(true);
    expect(r.executionCount).toBe(1);
    expect(r.outputs?.[0]).toMatchObject({ outputType: "stream", text: "hi\n" });
  });

  it("runCell: maps error reply to error result", async () => {
    kernel.execute.mockResolvedValue({
      outputs: [{ outputType: "error", ename: "ValueError", evalue: "bad" }],
      status: "error" as const,
      executionCount: 2,
    });
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    const r = await s.runCell("raise ValueError('bad')");
    expect(r.status).toBe("error");
    expect(r.success).toBe(false);
  });

  it("runCell: TimeoutError surfaces as timeout status", async () => {
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    // Queue a single rejection for the NEXT execute call (the runCell) so the
    // bootstrap/probe during initialize still succeed.
    kernel.execute.mockRejectedValueOnce(new TimeoutError());
    const r = await s.runCell("while True: pass");
    expect(r.status).toBe("timeout");
    expect(r.success).toBe(false);
    expect(r.outputs?.[0].ename).toBe("TimeoutError");
  });

  it("runCell: streams progress through onUpdate", async () => {
    kernel.execute.mockImplementation(async (_code: string, opts?: ExecuteOptions) => {
      opts?.onUpdate?.([{ outputType: "stream", name: "stdout", text: "partial" }]);
      return { outputs: [], status: "ok" as const, executionCount: 1 };
    });
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    const progress: number[] = [];
    await s.runCell("...", { onUpdate: (p) => progress.push(p.outputs?.length ?? 0) });
    expect(progress.length).toBeGreaterThan(0);
  });

  it("executionViewChanges$ emits after each runCell", async () => {
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    const seen: string[] = [];
    s.executionViewChanges$.subscribe((r) => seen.push(r.status));
    await s.runCell("a");
    await s.runCell("b");
    expect(seen).toEqual(["done", "done"]);
  });

  it("addDependencies + syncEnvironment issues a %pip install", async () => {
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    kernel.execute.mockClear();
    await s.addDependencies(["numpy", "numpy", " "]);
    await s.syncEnvironment();
    const code = kernel.execute.mock.calls[0][0] as string;
    expect(code).toBe("%pip install --quiet numpy");
  });

  it("saveNotebook writes a valid nbformat file", async () => {
    kernel.execute.mockResolvedValue({
      outputs: [{ outputType: "stream", name: "stdout", text: "x\n" }],
      status: "ok" as const,
      executionCount: 1,
    });
    const s = new RemoteSession(server, CONFIG, { notebookId: "nb-test" });
    await s.initialize();
    await s.runCell("print('x')");
    const path = join(tmpdir(), `pi-jupyter-test-${Date.now()}.ipynb`);
    await s.saveNotebook(path);
    const nb = JSON.parse(readFileSync(path, "utf-8"));
    expect(nb.nbformat).toBe(4);
    expect(nb.cells).toHaveLength(1);
    rmSync(path, { force: true });
  });

  it("shutdown disposes the kernel", async () => {
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    await s.shutdown();
    expect(kernel.shutdown).toHaveBeenCalledTimes(1);
    expect(kernel.dispose).toHaveBeenCalledTimes(1);
  });

  it("runCell after shutdown throws kernel-not-available", async () => {
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    await s.close();
    await expect(s.runCell("x")).rejects.toThrow(/kernel not available/);
  });

  it("getRuntimeStatus reports running before shutdown, stopped after", async () => {
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    expect((await s.getRuntimeStatus())?.lifecycle).toBe("running");
    await s.close();
    expect((await s.getRuntimeStatus())?.lifecycle).toBe("stopped");
  });
});

describe("RemoteSession — bug fixes", () => {
  let kernel: ReturnType<typeof makeKernelPort>;
  let server: ReturnType<typeof makeServerPort>;

  beforeEach(() => {
    kernel = makeKernelPort();
    server = makeServerPort(kernel);
  });

  // ── BUG-1: install failures must surface, R uses install.packages ──

  it("install failure (error status) rejects syncEnvironment, not silent success", async () => {
    kernel.execute.mockImplementation(async (code: string) => {
      if (code.includes("%pip")) {
        return {
          outputs: [
            { outputType: "error", ename: "CalledProcessError", evalue: "pip failed" },
          ],
          status: "error" as const,
          executionCount: 1,
        };
      }
      return { outputs: [], status: "ok" as const, executionCount: undefined };
    });
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    await s.addDependencies(["does-not-exist"]);
    await expect(s.syncEnvironment()).rejects.toThrow(/failed to install/);
  });

  it("R kernel installs via install.packages, not %pip", async () => {
    const s = new RemoteSession(server, CONFIG_R);
    await s.initialize();
    kernel.execute.mockClear();
    // The reachability probe runs first (BUG-8) — let it report the repo reachable.
    kernel.execute.mockResolvedValueOnce({
      outputs: [{ outputType: "stream", name: "stdout", text: "TRUE" }],
      status: "ok" as const,
      executionCount: undefined,
    });
    await s.addDependencies(["ggplot2"]);
    await s.syncEnvironment();
    const codes = kernel.execute.mock.calls.map((c) => c[0] as string);
    // The reachability probe runs first (BUG-8), then the install itself.
    expect(codes.some((c) => c.includes("install.packages") && c.includes('"ggplot2"'))).toBe(true);
    expect(codes.every((c) => !c.includes("%pip"))).toBe(true);
  });

  it("R install fails fast when the repo probe reports unreachable (BUG-8)", async () => {
    const s = new RemoteSession(server, CONFIG_R);
    await s.initialize();
    kernel.execute.mockClear();
    // The CRAN reachability probe prints FALSE.
    kernel.execute.mockResolvedValueOnce({
      outputs: [{ outputType: "stream", name: "stdout", text: "FALSE" }],
      status: "ok" as const,
      executionCount: undefined,
    });
    await s.addDependencies(["ggplot2"]);
    await expect(s.syncEnvironment()).rejects.toThrow(/cannot reach the package repository/);
    const codes = kernel.execute.mock.calls.map((c) => c[0] as string);
    // The install itself must never run behind an unreachable repo.
    expect(codes.some((c) => c.includes("install.packages"))).toBe(false);
  });

  it("R install proceeds when the repo probe reports reachable (BUG-8)", async () => {
    const s = new RemoteSession(server, CONFIG_R);
    await s.initialize();
    kernel.execute.mockClear();
    kernel.execute.mockResolvedValueOnce({
      outputs: [{ outputType: "stream", name: "stdout", text: "TRUE" }],
      status: "ok" as const,
      executionCount: undefined,
    });
    await s.addDependencies(["ggplot2"]);
    await s.syncEnvironment();
    const codes = kernel.execute.mock.calls.map((c) => c[0] as string);
    expect(codes.some((c) => c.includes("install.packages") && c.includes('"ggplot2"'))).toBe(true);
  });

  it("R reachability probe runs non-silent so its cat() stdout survives (BUG-9)", async () => {
    const s = new RemoteSession(server, CONFIG_R);
    await s.initialize();
    kernel.execute.mockClear();
    kernel.execute.mockResolvedValueOnce({
      outputs: [{ outputType: "stream", name: "stdout", text: "TRUE" }],
      status: "ok" as const,
      executionCount: undefined,
    });
    await s.addDependencies(["ggplot2"]);
    await s.syncEnvironment();
    const probeCall = kernel.execute.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("cat(isTRUE"),
    );
    expect(probeCall, "probe execute call not found").toBeDefined();
    const opts = probeCall![1] as ExecuteOptions;
    // silent:true suppresses the cat() stream on iopub -> empty stdout -> a false
    // 'unreachable' verdict even when the repo is reachable. storeHistory:false
    // keeps the probe out of kernel history / execution_count.
    expect(opts.silent).toBe(false);
    expect(opts.storeHistory).toBe(false);
  });

  it("unsupported kernel language refuses hot-install", async () => {
    server.listKernelSpecs.mockResolvedValue({
      default: "julia",
      specs: [{ name: "julia", displayName: "Julia", language: "julia" }],
    });
    const s = new RemoteSession(server, { ...CONFIG, kernelName: "julia" });
    await s.initialize();
    await s.addDependencies(["Foo"]);
    await expect(s.syncEnvironment()).rejects.toThrow(/unsupported language/);
  });

  // ── BUG-2: notebook metadata reflects the real kernelspec ──

  it("R session saves an .ipynb with an R kernelspec header", async () => {
    const s = new RemoteSession(server, CONFIG_R, { notebookId: "nb-r" });
    await s.initialize();
    const path = join(tmpdir(), `pi-jupyter-r-${Date.now()}.ipynb`);
    const written = await s.saveNotebook(path);
    expect(written).toBe(path);
    const nb = JSON.parse(readFileSync(path, "utf-8"));
    expect(nb.metadata.kernelspec.name).toBe("ir");
    expect(nb.metadata.kernelspec.display_name).toBe("R");
    expect(nb.metadata.kernelspec.language).toBe("r");
    expect(nb.metadata.language_info.name).toBe("r");
    rmSync(path, { force: true });
  });

  // ── BUG-4: python-only bootstrap / probe ──

  it("R kernel skips the python bootstrap and package probe", async () => {
    const s = new RemoteSession(server, CONFIG_R);
    await s.initialize();
    const codes = kernel.execute.mock.calls.map((c) => c[0] as string);
    expect(codes.some((c) => c.includes("matplotlib"))).toBe(false);
    expect(codes.some((c) => c.includes('"missing"'))).toBe(false);
  });

  it("python kernel still runs the bootstrap and probe", async () => {
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    const codes = kernel.execute.mock.calls.map((c) => c[0] as string);
    expect(codes.some((c) => c.includes("matplotlib"))).toBe(true);
  });

  // ── BUG-7: serialize concurrent kernel executions ──

  it("runCell serializes concurrent calls — no overlapping kernel.execute", async () => {
    let active = 0;
    let overlapped = false;
    kernel.execute.mockImplementation(async () => {
      active += 1;
      if (active > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return { outputs: [], status: "ok" as const, executionCount: 1 };
    });
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    // Fire several cells in parallel; with the lock they must not overlap.
    await Promise.all([s.runCell("a"), s.runCell("b"), s.runCell("c")]);
    expect(overlapped).toBe(false);
  });

  it("runCell: KernelInterruptedError surfaces with its own name, not ShimError", async () => {
    const { KernelInterruptedError } = await import("../../src/domain/types");
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    kernel.execute.mockRejectedValueOnce(new KernelInterruptedError());
    const r = await s.runCell("1+1");
    expect(r.status).toBe("error");
    expect(r.success).toBe(false);
    expect(r.outputs?.[0].ename).toBe("KernelInterruptedError");
  });

  it("a rejecting cell does not wedge the queue for later cells (BUG-7)", async () => {
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    kernel.execute.mockRejectedValueOnce(new Error("boom"));
    const bad = await s.runCell("x");
    expect(bad.success).toBe(false);
    // The next cell still runs through the same (now healthy) chain.
    const good = await s.runCell("y");
    expect(good.status).toBe("done");
    expect(good.success).toBe(true);
  });

  // ── BUG-6: busy kernel after timeout ──

  it("runCell on a still-busy kernel fails fast with a clear error", async () => {
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    (kernel as { status: string }).status = "busy";
    const r = await s.runCell("1+1");
    expect(r.status).toBe("error");
    expect(r.success).toBe(false);
    expect(r.outputs?.[0].evalue).toMatch(/still busy/);
  });

  it("timeoutRestartKernel policy restarts a busy kernel and recovers", async () => {
    const s = new RemoteSession(server, { ...CONFIG, timeoutRestartKernel: true });
    await s.initialize();
    expect(server.startKernel).toHaveBeenCalledTimes(1);
    (kernel as { status: string }).status = "busy";
    const r = await s.runCell("1+1");
    expect(server.startKernel).toHaveBeenCalledTimes(2);
    expect(r.status).toBe("done");
    expect(r.success).toBe(true);
  });

  // ── UX-7: kernelName validation ──

  it("rejects an unknown kernelName with the list of available kernels", async () => {
    const s = new RemoteSession(server, { ...CONFIG, kernelName: "R" });
    await expect(s.initialize()).rejects.toThrow(/not found on the Jupyter server/);
    await expect(
      new RemoteSession(server, { ...CONFIG, kernelName: "R" }).initialize(),
    ).rejects.toThrow(/ir \(R\)/);
  });

  it("degrades gracefully when the server cannot list kernelspecs", async () => {
    server.listKernelSpecs.mockRejectedValue(new Error("403"));
    const s = new RemoteSession(server, CONFIG);
    await expect(s.initialize()).resolves.toBeUndefined();
    expect(server.startKernel).toHaveBeenCalledWith(
      "python3",
      expect.objectContaining({ sessionPath: expect.any(String) }),
    );
  });
});

describe("RemoteSession — remote auto-save (PRD 远端自动落盘)", () => {
  let kernel: ReturnType<typeof makeKernelPort>;
  let server: ReturnType<typeof makeServerPort>;

  beforeEach(() => {
    kernel = makeKernelPort();
    server = makeServerPort(kernel);
  });

  it("AC-1: runCell uploads the snapshot to effectivePath with the cell content", async () => {
    kernel.execute.mockResolvedValue({
      outputs: [{ outputType: "stream", name: "stdout", text: "hi\n" }],
      status: "ok" as const,
      executionCount: 1,
    });
    const s = new RemoteSession(server, CONFIG, { notebookId: "nb-auto" });
    await s.initialize();
    // INV-1: the bind-session path equals the default auto-save target.
    expect(server.startKernel).toHaveBeenCalledWith(
      "python3",
      expect.objectContaining({ sessionPath: "nb-auto.ipynb" }),
    );
    await s.runCell("print('hi')");
    await s.flushAutoSave();
    expect(server.uploadNotebook).toHaveBeenCalled();
    const [path, model] = server.uploadNotebook.mock.calls.at(-1) ?? [];
    expect(path).toBe("nb-auto.ipynb");
    const cells = (model as { cells: any[] }).cells;
    expect(cells).toHaveLength(1);
    expect(cells[0].source.join("")).toBe("print('hi')");
    expect(JSON.stringify(cells[0].outputs)).toContain("hi");
  });

  it("AC-2: error/timeout cells still trigger an upload with an error output", async () => {
    const s = new RemoteSession(server, CONFIG, { notebookId: "nb-err" });
    await s.initialize();
    kernel.execute.mockRejectedValueOnce(new TimeoutError());
    const r = await s.runCell("while True: pass");
    expect(r.status).toBe("timeout");
    await s.flushAutoSave();
    expect(server.uploadNotebook).toHaveBeenCalled();
    const model = server.uploadNotebook.mock.calls.at(-1)?.[1] as { cells: any[] };
    const last = model.cells[model.cells.length - 1];
    expect(last.outputs.some((o: any) => o.output_type === "error")).toBe(true);
  });

  it("AC-3: remoteAutoSave=false never uploads (switch off, R7.1)", async () => {
    const s = new RemoteSession(
      server,
      { ...CONFIG, remoteAutoSave: false },
      { notebookId: "nb-off" },
    );
    await s.initialize();
    await s.runCell("x = 1");
    await s.flushAutoSave();
    await s.shutdown();
    expect(server.uploadNotebook).not.toHaveBeenCalled();
  });

  it("AC-4: rapid cells coalesce — at most in-flight + trailing PUT, newest snapshot wins", async () => {
    const s = new RemoteSession(server, CONFIG, { notebookId: "nb-coal" });
    await s.initialize();
    server.uploadNotebook.mockClear();
    // A slow upload keeps a PUT in flight while the (now serialized, BUG-7)
    // cells run, so their triggers coalesce into in-flight + trailing (FR-5.3).
    server.uploadNotebook.mockImplementation(
      () => new Promise<void>((r) => setTimeout(() => r(), 25)),
    );
    await Promise.all([s.runCell("a = 1"), s.runCell("b = 2"), s.runCell("c = 3")]);
    await s.flushAutoSave();
    const calls = server.uploadNotebook.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(2);
    const lastModel = calls.at(-1)?.[1] as { cells: unknown[] };
    expect(lastModel.cells).toHaveLength(3);
  });

  it("AC-5: upload failure is by-passed — runCell returns, warning + onAutoSave{ok:false}", async () => {
    server.uploadNotebook.mockRejectedValue(new Error("boom 500"));
    const events: Array<{ ok: boolean; path: string; error?: string }> = [];
    const s = new RemoteSession(server, CONFIG, { notebookId: "nb-fail" });
    s.onAutoSave = (e) => events.push(e);
    await s.initialize();
    const r = await s.runCell("x = 1");
    expect(r.status).toBe("done");
    expect(r.success).toBe(true);
    await s.flushAutoSave();
    const status = await s.getRuntimeStatus();
    expect(status?.warnings?.some((w) => w.includes("boom 500"))).toBe(true);
    expect(events.some((e) => e.ok === false && /boom 500/.test(e.error ?? ""))).toBe(true);
    expect(status?.lastAutoSave?.ok).toBe(false);
  });

  it("AC-6: shutdown flushes the final snapshot", async () => {
    const s = new RemoteSession(server, CONFIG, { notebookId: "nb-shut" });
    await s.initialize();
    server.uploadNotebook.mockClear();
    await s.runCell("final = 42");
    await s.shutdown();
    expect(server.uploadNotebook).toHaveBeenCalled();
    const lastModel = server.uploadNotebook.mock.calls.at(-1)?.[1] as { cells: unknown[] };
    expect(lastModel.cells).toHaveLength(1);
  });

  it("AC-7: remoteSavePath overrides the path for BOTH upload and bind-session (INV-1)", async () => {
    const s = new RemoteSession(
      server,
      { ...CONFIG, remoteSavePath: "a/b.ipynb" },
      { notebookId: "nb-path" },
    );
    await s.initialize();
    expect(server.startKernel).toHaveBeenCalledWith(
      "python3",
      expect.objectContaining({ sessionPath: "a/b.ipynb" }),
    );
    await s.runCell("x = 1");
    await s.flushAutoSave();
    expect(server.uploadNotebook.mock.calls.length).toBeGreaterThan(0);
    expect(server.uploadNotebook.mock.calls.every((c) => c[0] === "a/b.ipynb")).toBe(true);
  });

  it("AC-8: paths never contain the LOCAL home directory (red line, §9.2)", async () => {
    const s = new RemoteSession(server, CONFIG, { notebookId: "nb-home" });
    await s.initialize();
    await s.runCell("x = 1");
    await s.flushAutoSave();
    const home = homedir();
    const boundPath = (server.startKernel.mock.calls[0][1] as { sessionPath: string }).sessionPath;
    expect(boundPath).not.toContain(home);
    for (const [p] of server.uploadNotebook.mock.calls) {
      expect(String(p)).not.toContain(home);
    }
  });

  it("AC-8b: a remoteSavePath with a .. segment is rejected with a warning", async () => {
    const s = new RemoteSession(
      server,
      { ...CONFIG, remoteSavePath: "../escape.ipynb" },
      { notebookId: "nb-dotdot" },
    );
    await s.initialize();
    expect(server.startKernel).toHaveBeenCalledWith(
      "python3",
      expect.objectContaining({ sessionPath: "nb-dotdot.ipynb" }),
    );
    await s.runCell("x = 1");
    await s.flushAutoSave();
    expect(server.uploadNotebook.mock.calls.every((c) => c[0] === "nb-dotdot.ipynb")).toBe(true);
    expect((await s.getRuntimeStatus())?.warnings?.some((w) => w.includes('".."'))).toBe(true);
  });

  it("AC-9: local saveNotebook and the remote snapshot share one serializer", async () => {
    const s = new RemoteSession(server, CONFIG, { notebookId: "nb-shared" });
    await s.initialize();
    await s.runCell("y = 2");
    await s.flushAutoSave();
    const p = join(tmpdir(), `pi-jupyter-shared-${Date.now()}.ipynb`);
    await s.saveNotebook(p);
    const local = JSON.parse(readFileSync(p, "utf-8"));
    const remote = server.uploadNotebook.mock.calls.at(-1)?.[1];
    expect(local).toEqual(remote);
    rmSync(p, { force: true });
  });
});

// ── issue "poisoned deps set": a failed name must not block future installs ──

/**
 * Mock an R kernel install where `failedPkgs` never become loadable and every
 * other requested package installs. The CRAN reachability probe always reports
 * TRUE; install code is answered with PI_INSTALL_* markers mirroring the
 * per-package requireNamespace() verdict the real R code emits.
 */
function mockRInstallOutcomes(
  kernel: ReturnType<typeof makeKernelPort>,
  failedPkgs: string[],
): void {
  const bad = new Set(failedPkgs);
  kernel.execute.mockImplementation(async (code: string) => {
    if (code.includes("cat(isTRUE")) {
      return {
        outputs: [{ outputType: "stream" as const, name: "stdout", text: "TRUE" }],
        status: "ok" as const,
        executionCount: undefined,
      };
    }
    if (code.includes("install.packages")) {
      // The install loop runs over `pkgs <- c("a", "b")`; extract that vector.
      const vector = code.match(/pkgs <- c\(([^)]*)\)/)?.[1] ?? "";
      const requested = [...vector.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      const ok = requested.filter((p) => !bad.has(p));
      const fail = requested.filter((p) => bad.has(p));
      const lines = [
        ...(ok.length ? [`PI_INSTALL_OK ${ok.join(" ")}`] : []),
        ...(fail.length ? [`PI_INSTALL_FAILED ${fail.join(" ")}`] : []),
      ];
      return {
        outputs: [{ outputType: "stream" as const, name: "stdout", text: lines.join("\n") }],
        // warn=2 + tryCatch means the cell completes; the verdict is in stdout.
        status: "ok" as const,
        executionCount: 1,
      };
    }
    return { outputs: [], status: "ok" as const, executionCount: undefined };
  });
}

describe("RemoteSession — poisoned deps set (failed install must not block future installs)", () => {
  let kernel: ReturnType<typeof makeKernelPort>;
  let server: ReturnType<typeof makeServerPort>;

  beforeEach(() => {
    kernel = makeKernelPort();
    server = makeServerPort(kernel);
  });

  it("a failed package does not poison a later call with a valid package (issue repro)", async () => {
    kernel.execute.mockImplementation(async (code: string) => {
      if (code.includes("%pip")) {
        const ok = code.includes("does-not-exist") ? [] : ["zeallot"];
        const failed = code.includes("does-not-exist") ? ["does-not-exist"] : [];
        const lines = [
          ...(ok.length ? [`PI_INSTALL_OK ${ok.join(" ")}`] : []),
          ...(failed.length ? [`PI_INSTALL_FAILED ${failed.join(" ")}`] : []),
        ];
        return {
          outputs: [{ outputType: "stream" as const, name: "stdout", text: lines.join("\n") }],
          status: "error" as const,
          executionCount: 1,
        };
      }
      return { outputs: [], status: "ok" as const, executionCount: undefined };
    });
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();

    await s.addDependencies(["nonexistent-pkg-zzz-test"]);
    await expect(s.syncEnvironment()).rejects.toThrow(/nonexistent-pkg-zzz-test/);

    // The valid package now installs on its own — the stale bad name is gone.
    await s.addDependencies(["zeallot"]);
    await expect(s.syncEnvironment()).resolves.toEqual(["zeallot"]);
  });

  it("R: a bad name beside a valid one keeps the valid package (per-package isolation)", async () => {
    mockRInstallOutcomes(kernel, ["nonexistent-pkg-zzz-test"]);
    const s = new RemoteSession(server, CONFIG_R);
    await s.initialize();
    kernel.execute.mockClear();

    await s.addDependencies(["nonexistent-pkg-zzz-test", "zeallot"]);
    // The call reports the bad name…
    await expect(s.syncEnvironment()).rejects.toThrow(/nonexistent-pkg-zzz-test/);
    // …but the loadable package was installed and committed, so a follow-up
    // call requesting just it succeeds with nothing left to install.
    await s.addDependencies(["zeallot"]);
    await expect(s.syncEnvironment()).resolves.toEqual(["zeallot"]);
    const codes = kernel.execute.mock.calls.map((c) => c[0] as string);
    expect(codes.some((c) => c.includes("install.packages") && c.includes('"zeallot"'))).toBe(true);
  });

  it("an all-failed install commits nothing and rejects", async () => {
    mockRInstallOutcomes(kernel, ["bad-a", "bad-b"]);
    const s = new RemoteSession(server, CONFIG_R);
    await s.initialize();
    kernel.execute.mockClear();

    await s.addDependencies(["bad-a", "bad-b"]);
    await expect(s.syncEnvironment()).rejects.toThrow(/bad-a, bad-b/);
    await expect(s.syncEnvironment()).resolves.toEqual([]); // nothing committed

    // A later valid package still installs.
    mockRInstallOutcomes(kernel, []);
    await s.addDependencies(["good"]);
    await expect(s.syncEnvironment()).resolves.toEqual(["good"]);
  });

  it("restart-recovery reinstalls the desired set and drops any name that no longer installs", async () => {
    const s = new RemoteSession(server, { ...CONFIG_R, timeoutRestartKernel: true });
    await s.initialize();
    mockRInstallOutcomes(kernel, ["bad"]);
    await s.addDependencies(["good", "bad"]);
    await expect(s.syncEnvironment()).rejects.toThrow(/bad/); // good committed, bad dropped

    // Force a restart (busy kernel); recovery reinstalls the desired set.
    (kernel as { status: string }).status = "busy";
    const r = await s.runCell("1+1");
    expect(r.status).toBe("done");

    // The desired set now excludes the dropped "bad": a follow-up sync of the
    // good package needs nothing reinstalled.
    mockRInstallOutcomes(kernel, []);
    await s.addDependencies(["good"]);
    await expect(s.syncEnvironment()).resolves.toEqual(["good"]);
  });

  it("python without markers still reports success and commits the package", async () => {
    kernel.execute.mockImplementation(async (code: string) => {
      if (code.includes("%pip")) {
        return {
          outputs: [{ outputType: "stream" as const, name: "stdout", text: "PI_INSTALL_OK numpy" }],
          status: "ok" as const,
          executionCount: 1,
        };
      }
      return { outputs: [], status: "ok" as const, executionCount: undefined };
    });
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    await s.addDependencies(["numpy"]);
    await expect(s.syncEnvironment()).resolves.toEqual(["numpy"]);
  });

  it("legacy kernel with no markers falls back to whole-batch success when status is ok", async () => {
    kernel.execute.mockImplementation(async (code: string) => {
      if (code.includes("%pip")) {
        return {
          outputs: [{ outputType: "stream" as const, name: "stdout", text: "Successfully installed" }],
          status: "ok" as const,
          executionCount: 1,
        };
      }
      return { outputs: [], status: "ok" as const, executionCount: undefined };
    });
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    await s.addDependencies(["requests"]);
    await expect(s.syncEnvironment()).resolves.toEqual(["requests"]);
  });
});

describe("RemoteSession — agent-decided kernel", () => {
  let kernel: ReturnType<typeof makeKernelPort>;
  let server: ReturnType<typeof makeServerPort>;

  beforeEach(() => {
    kernel = makeKernelPort();
    server = makeServerPort(kernel);
  });

  it("opts.kernelName (the agent's choice) overrides the config fallback", async () => {
    const s = new RemoteSession(server, CONFIG, { kernelName: "ir" });
    await s.initialize();
    expect(s.kernelName).toBe("ir");
    expect(server.startKernel).toHaveBeenCalledWith(
      "ir",
      expect.objectContaining({ sessionPath: expect.any(String) }),
    );
  });

  it("falls back to config.kernelName when no kernelName opt is passed", async () => {
    const s = new RemoteSession(server, CONFIG);
    await s.initialize();
    expect(s.kernelName).toBe("python3");
  });

  it("initialize fails fast with a clear message when no kernel is selected", async () => {
    const noKernel = { ...CONFIG, kernelName: undefined };
    const s = new RemoteSession(server, noKernel);
    await expect(s.initialize()).rejects.toThrow(/no kernel selected/);
    // Never touched the network/server.
    expect(server.ping).not.toHaveBeenCalled();
  });
});

// ── resume: continue an existing notebook (attach live kernel or start bound) ──

const FILE_NB = (extra: Record<string, unknown> = {}) => ({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } },
  cells: [
    { cell_type: "markdown", id: "md-1", metadata: {}, source: ["# analysis"] },
    {
      cell_type: "code",
      id: "cell-a",
      metadata: {},
      source: "import numpy as np",
      execution_count: 2,
      outputs: [],
    },
  ],
  ...extra,
});

describe("RemoteSession — resume (continue an existing notebook path)", () => {
  let kernel: ReturnType<typeof makeKernelPort>;
  let server: ReturnType<typeof makeServerPort>;

  beforeEach(() => {
    kernel = makeKernelPort();
    server = makeServerPort(kernel);
  });

  it("ATTACHES to a live session: no new kernel, cells loaded, autosave bound to the path", async () => {
    const live = {
      id: "sess-1",
      path: "notes/pi.ipynb",
      name: "pi",
      type: "notebook",
      kernelId: "k-1",
      kernelName: "python3",
    };
    server.findLiveSession.mockResolvedValue(live);
    server.readNotebook.mockResolvedValue(FILE_NB());
    const s = new RemoteSession(server, CONFIG, { kernelName: "ir" /* ignored on attach */ });
    const outcome = await s.resume("notes/pi.ipynb");
    expect(outcome.mode).toBe("attached");
    expect(outcome.fileExisted).toBe(true);
    expect(outcome.kernel).toBe("python3"); // the LIVE kernel wins, not the opt
    expect(server.connectToSession).toHaveBeenCalledWith(live);
    expect(server.startKernel).not.toHaveBeenCalled();
    expect(s.kernelName).toBe("python3");
    // no bootstrap on an attached kernel (state is already there)
    expect(kernel.waitConnected).toHaveBeenCalled();
    // code cells from the file are loaded for the model to see
    expect(outcome.codeCells).toHaveLength(1);
    expect(outcome.codeCells[0].source).toBe("import numpy as np");
    expect(outcome.codeCells[0].restored).toBe(true);
    expect(s.contentsPath).toBe("notes/pi.ipynb");
    await s.detach();
  });

  it("attach failure falls back to starting a fresh kernel bound to the path", async () => {
    const live = { id: "sess-x", path: "notes/pi.ipynb", name: "pi", type: "notebook", kernelId: "k-x", kernelName: "python3" };
    server.findLiveSession.mockResolvedValue(live);
    server.connectToSession.mockRejectedValue(new Error("kernel died"));
    server.readNotebook.mockResolvedValue(FILE_NB());
    const s = new RemoteSession(server, CONFIG, { contentsPath: "notes/pi.ipynb" });
    const outcome = await s.resume("notes/pi.ipynb");
    expect(outcome.mode).toBe("started");
    expect(server.startKernel).toHaveBeenCalledWith(
      "python3",
      expect.objectContaining({ sessionPath: "notes/pi.ipynb" }),
    );
    expect((await s.getRuntimeStatus())?.warnings?.some((w) => w.includes("could not attach"))).toBe(true);
  });

  it("resume-from-file starts a new kernel bound to the SAME path and uses the file's kernel", async () => {
    const file = {
      ...FILE_NB(),
      metadata: { kernelspec: { name: "ir", display_name: "R", language: "r" }, language_info: { name: "r" } },
      cells: [{ cell_type: "code", id: "r-1", metadata: {}, source: "x <- 1", execution_count: 1, outputs: [] }],
    };
    server.readNotebook.mockResolvedValue(file);
    const s = new RemoteSession(server, CONFIG, { contentsPath: "notes/stats.ipynb" });
    const outcome = await s.resume("notes/stats.ipynb");
    expect(outcome.mode).toBe("started");
    expect(outcome.kernel).toBe("ir"); // from the file's kernelspec
    expect(server.startKernel).toHaveBeenCalledWith("ir", { sessionPath: "notes/stats.ipynb", sessionName: "stats" });
    expect(outcome.codeCells).toHaveLength(1);
    // snapshot target is the adopted path even when remoteSavePath is configured
    await s.runCell("x + 1");
    await s.flushAutoSave();
    expect(server.uploadNotebook.mock.calls.every((c) => c[0] === "notes/stats.ipynb")).toBe(true);
  });

  it("resume of a missing file creates the document empty at that path", async () => {
    const s = new RemoteSession(server, CONFIG, { contentsPath: "scratch/new.ipynb" });
    const outcome = await s.resume("scratch/new.ipynb");
    expect(outcome.mode).toBe("started");
    expect(outcome.fileExisted).toBe(false);
    expect(outcome.codeCells).toEqual([]);
    expect(server.startKernel).toHaveBeenCalledWith("python3", expect.objectContaining({ sessionPath: "scratch/new.ipynb" }));
  });

  it("re-running a restored cell executes it IN PLACE (id kept, no duplicate cell)", async () => {
    kernel.execute.mockImplementation(async (code: string) => {
      if (code.includes('"missing"')) {
        return { outputs: [], status: "ok" as const, executionCount: undefined };
      }
      return {
        outputs: [{ outputType: "stream", name: "stdout", text: "fresh\n" }],
        status: "ok" as const,
        executionCount: 5,
      };
    });
    server.readNotebook.mockResolvedValue(FILE_NB());
    const s = new RemoteSession(server, CONFIG, { contentsPath: "notes/pi.ipynb" });
    await s.resume("notes/pi.ipynb");
    // run the same source as the loaded cell
    const r = await s.runCell("import numpy as np");
    expect(r.cellId).toBe("cell-a"); // kept the file's cell id
    await s.flushAutoSave();
    const model = server.uploadNotebook.mock.calls.at(-1)?.[1] as { cells: any[] };
    // markdown cell + one code cell: re-run did NOT append a duplicate
    expect(model.cells).toHaveLength(2);
    expect(model.cells[1].id).toBe("cell-a");
    expect(model.cells[1].execution_count).toBe(5);
    // the loaded cell is no longer "restored"
    expect(s.listCells()[0].restored).toBe(false);
  });

  it("detach() keeps the kernel running (no shutdown) and disposes the client", async () => {
    const s = new RemoteSession(server, CONFIG, { notebookId: "nb-detach" });
    await s.initialize();
    (kernel.shutdown as ReturnType<typeof vi.fn>).mockClear();
    await s.detach();
    expect(kernel.shutdown).not.toHaveBeenCalled();
    expect(server.dispose).toHaveBeenCalled();
    expect(s.contentsPath).toBe("nb-detach.ipynb");
  });
});

describe("normalizeContentsPath", () => {
  it("strips leading slashes (contents paths are relative to the root)", () => {
    expect(normalizeContentsPath("/notes/pi.ipynb")).toBe("notes/pi.ipynb");
  });
  it("rejects .. segments and empty paths", () => {
    expect(() => normalizeContentsPath("../escape.ipynb")).toThrow(/"\.\."/);
    expect(() => normalizeContentsPath("  ")).toThrow(/required/);
  });
});
