/**
 * Unit tests: RemoteSession against a MOCK KernelPort/ServerPort.
 *
 * Demonstrates the payoff of the hexagonal seam: the entire session lifecycle
 * (init, run, deps, save, shutdown, observable) is verified with zero Jupyter
 * Server and zero network.
 */
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShimConfig } from "../../src/config";
import { TimeoutError } from "../../src/domain/types";
import type { ExecuteOptions, KernelPort, ServerPort } from "../../src/kernel/port";
import { RemoteSession } from "../../src/session";

const CONFIG: ShimConfig = {
  url: "http://x",
  token: "t",
  kernelName: "python3",
  tlsInsecure: false,
  defaultTimeoutMs: 1000,
  installTimeoutMs: 1000,
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
    waitConnected: vi.fn().mockResolvedValue(undefined),
  };
}

function makeServerPort(kernel: KernelPort): ServerPort & { ping: ReturnType<typeof vi.fn> } {
  return {
    ping: vi.fn().mockResolvedValue(undefined),
    startKernel: vi.fn().mockResolvedValue(kernel),
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
    expect(server.startKernel).toHaveBeenCalledWith("python3");
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
