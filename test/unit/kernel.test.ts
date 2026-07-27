/**
 * Unit tests: JupyterKernel dual-channel executor — OFFLINE, via a mock
 * Kernel.IKernelConnection + mock IFuture.
 *
 * This is the test the v1 analysis report flagged as missing (§9.3 #1):
 * every output-normalization branch and the timeout path are covered without
 * a real Jupyter Server.
 */
import { describe, expect, it, vi } from "vitest";
import { JupyterKernel } from "../../src/kernel/kernel";
import type { JsOutput } from "../../src/domain/types";
import { KernelInterruptedError } from "../../src/domain/types";

// ── message factories (shaped so KernelMessage.is*Msg guards pass) ──────────

function iopub(msg_type: string, content: Record<string, unknown> = {}): any {
  return { header: { msg_type }, parent_header: {}, metadata: {}, content, channel: "iopub" };
}
const stream = (name: string, text: string) => iopub("stream", { name, text });
const execResult = (data: Record<string, unknown>, count: number) =>
  iopub("execute_result", { data, execution_count: count });
const displayData = (data: Record<string, unknown>) => iopub("display_data", { data });
const errorMsg = (ename: string, evalue: string) =>
  iopub("error", { ename, evalue, traceback: [`Traceback: ${ename}`] });
const statusMsg = (state: string) => iopub("status", { execution_state: state });
const clearOutput = () => iopub("clear_output", { wait: false });

function reply(status: "ok" | "error" | "abort", count: number): any {
  return {
    header: { msg_type: "execute_reply" },
    content: { status, execution_count: count },
    channel: "shell",
  };
}

// ── mock kernel / future ────────────────────────────────────────────────────

type Scenario = {
  ioPub?: any[];
  reply?: any;
  /** reject `done` instead of resolving (e.g. simulate a hang for timeout). */
  neverDone?: boolean;
};

function makeMockKernel(scenario: Scenario) {
  const future: any = {
    onIOPub: null,
    onReply: null,
    onStdin: null,
    dispose: vi.fn(),
    // Deliver queued messages once handlers are attached, then settle `done`.
    done: new Promise<void>((resolve) => {
      setTimeout(() => {
        for (const m of scenario.ioPub ?? []) future.onIOPub?.(m);
        if (scenario.reply) future.onReply?.(scenario.reply);
        if (!scenario.neverDone) resolve();
      }, 0);
    }),
  };

  // Minimal status / statusChanged support so waitIdle() can settle (BUG-6).
  const statusHandlers = new Set<(k: unknown, status: string) => void>();
  const mock: any = {
    requestExecute: vi.fn(() => future),
    interrupt: vi.fn().mockImplementation(async () => {
      // An interruptible kernel returns to idle right after SIGINT.
      mock.status = "idle";
      for (const h of statusHandlers) h(mock, "idle");
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    isDisposed: false,
    connectionStatus: "connected",
    status: "idle",
    connectionStatusChanged: { connect: vi.fn(), disconnect: vi.fn() },
    statusChanged: {
      connect: (h: (k: unknown, status: string) => void) => statusHandlers.add(h),
      disconnect: (h: (k: unknown, status: string) => void) => statusHandlers.delete(h),
    },
    _future: future,
  };
  return mock;
}

const dataOf = (o: JsOutput) => JSON.parse(o.dataJson ?? "{}");

describe("JupyterKernel.execute (mock IFuture)", () => {
  it("collects a stream output", async () => {
    const k = makeMockKernel({
      ioPub: [statusMsg("busy"), stream("stdout", "hello\n"), statusMsg("idle")],
      reply: reply("ok", 1),
    });
    const out = await new JupyterKernel(k as any).execute("print('hello')");
    expect(out.status).toBe("ok");
    expect(out.executionCount).toBe(1);
    expect(out.outputs).toEqual([
      { outputType: "stream", name: "stdout", text: "hello\n" },
    ]);
  });

  it("normalizes an execute_result mimebundle to {type,value}", async () => {
    const k = makeMockKernel({
      ioPub: [execResult({ "text/plain": "42" }, 2)],
      reply: reply("ok", 2),
    });
    const out = await new JupyterKernel(k as any).execute("40+2");
    const o = out.outputs[0];
    expect(o.outputType).toBe("execute_result");
    expect(o.executionCount).toBe(2);
    expect(dataOf(o)["text/plain"]).toEqual({ type: "text", value: "42" });
  });

  it("marks raster images as binary", async () => {
    const k = makeMockKernel({
      ioPub: [displayData({ "image/png": "iVBORw0=", "text/plain": "<Figure>" })],
      reply: reply("ok", 3),
    });
    const out = await new JupyterKernel(k as any).execute("plt.show()");
    const data = dataOf(out.outputs[0]);
    expect(data["image/png"]).toEqual({ type: "binary", value: "iVBORw0=" });
    expect(data["text/plain"]).toEqual({ type: "text", value: "<Figure>" });
  });

  it("dedupes an image emitted as both execute_result and display_data", async () => {
    const k = makeMockKernel({
      ioPub: [
        execResult({ "image/png": "SAME" }, 4),
        displayData({ "image/png": "SAME" }),
      ],
      reply: reply("ok", 4),
    });
    const out = await new JupyterKernel(k as any).execute("fig");
    expect(out.outputs).toHaveLength(1);
  });

  it("captures error outputs and reports error status from the reply", async () => {
    const k = makeMockKernel({
      ioPub: [errorMsg("ZeroDivisionError", "division by zero")],
      reply: reply("error", 5),
    });
    const out = await new JupyterKernel(k as any).execute("1/0");
    expect(out.status).toBe("error");
    expect(out.outputs[0]).toMatchObject({
      outputType: "error",
      ename: "ZeroDivisionError",
    });
  });

  it("ignores status / lifecycle messages", async () => {
    const k = makeMockKernel({
      ioPub: [statusMsg("busy"), statusMsg("idle")],
      reply: reply("ok", 6),
    });
    const out = await new JupyterKernel(k as any).execute("x = 1");
    expect(out.outputs).toEqual([]);
    expect(out.status).toBe("ok");
  });

  it("clears accumulated outputs on clear_output", async () => {
    const k = makeMockKernel({
      ioPub: [stream("stdout", "gone\n"), clearOutput(), stream("stdout", "kept\n")],
      reply: reply("ok", 7),
    });
    const out = await new JupyterKernel(k as any).execute("...");
    expect(out.outputs).toEqual([{ outputType: "stream", name: "stdout", text: "kept\n" }]);
  });

  it("streams progress via onUpdate after each iopub message", async () => {
    const k = makeMockKernel({
      ioPub: [stream("stdout", "a"), stream("stdout", "b")],
      reply: reply("ok", 8),
    });
    const snapshots: number[] = [];
    await new JupyterKernel(k as any).execute("...", {
      onUpdate: (outs) => snapshots.push(outs.length),
    });
    expect(snapshots).toEqual([1, 2]);
  });

  it("times out: interrupts the kernel and rejects with TimeoutError", async () => {
    const k = makeMockKernel({ neverDone: true });
    const kernel = new JupyterKernel(k as any);
    await expect(kernel.execute("while True: pass", { timeoutMs: 20 })).rejects.toThrow(
      /timed out/,
    );
    // The timeout guard fires kernel.interrupt().
    await vi.waitFor(() => expect(k.interrupt).toHaveBeenCalled());
  });

  it("disposes the future after execution", async () => {
    const k = makeMockKernel({ ioPub: [stream("stdout", "x")], reply: reply("ok", 9) });
    await new JupyterKernel(k as any).execute("x");
    expect(k.requestExecute).toHaveBeenCalledTimes(1);
    // the future returned by requestExecute is disposed after execution
    expect(k._future.dispose).toHaveBeenCalled();
  });

  it("translates a canceled shell future into KernelInterruptedError (BUG-7)", async () => {
    const future: any = {
      onIOPub: null,
      onReply: null,
      onStdin: null,
      dispose: vi.fn(),
      // jupyterlab rejects with this exact string when a future is disposed
      // before its execute_reply arrives (interrupt / dropped connection).
      done: Promise.reject(
        new Error("Canceled future for execute_request message before replies were done"),
      ),
    };
    const k: any = {
      requestExecute: vi.fn(() => future),
      interrupt: vi.fn().mockResolvedValue(undefined),
      isDisposed: false,
      status: "idle",
      statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
    };
    await expect(new JupyterKernel(k).execute("x")).rejects.toBeInstanceOf(
      KernelInterruptedError,
    );
  });
});
