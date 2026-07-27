/**
 * JupyterKernel — the dual-channel executor, implementing KernelPort.
 *
 * All `@jupyterlab/services` IFuture protocol detail lives here:
 *
 *   iopub channel  →  the output stream (onIOPub)
 *   shell channel  →  authoritative execution_count + terminal status (onReply)
 *   future.done    →  resolves once BOTH channels complete
 *
 * The authoritative execution_count and terminal status ("ok" | "error" |
 * "abort") come from the shell-channel execute_reply, NOT from iopub.  Some
 * failures (e.g. KeyboardInterrupt) only surface in the reply.
 */
import { type Kernel, KernelMessage } from "@jupyterlab/services";
import { dedupeImages } from "../domain/output";
import { type JsOutput, TimeoutError } from "../domain/types";
import { fromIOPub } from "./convert";
import type { ExecuteOptions, ExecuteOutcome, KernelPort } from "./port";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export class JupyterKernel implements KernelPort {
  constructor(private kernel: Kernel.IKernelConnection) {}

  async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteOutcome> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const silent = opts.silent ?? false;
    const outputs: JsOutput[] = [];
    let executionCount: number | undefined;
    let replyStatus: "ok" | "error" | "abort" = "ok";

    const future = this.kernel.requestExecute({
      code,
      silent,
      store_history: !silent,
      user_expressions: {},
      allow_stdin: false,
      stop_on_error: true,
    });

    // ── iopub channel: the output stream ──
    future.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
      if (KernelMessage.isClearOutputMsg(msg)) {
        outputs.length = 0;
        opts.onUpdate?.([]);
        return;
      }
      const converted = fromIOPub(msg);
      if (converted) {
        outputs.push(converted);
        opts.onUpdate?.([...outputs]);
      }
    };

    // ── shell channel: authoritative execution_count + status ──
    future.onReply = (msg: KernelMessage.IExecuteReplyMsg) => {
      executionCount = msg.content.execution_count ?? undefined;
      replyStatus = msg.content.status;
    };

    // allow_stdin is false, so no input_request should arrive.
    future.onStdin = () => {};

    // ── timeout guard: interrupt, then let the race reject ──
    const timer = setTimeout(() => {
      void this.kernel.interrupt().catch(() => {});
    }, timeoutMs);

    try {
      await raceTimeout(future.done, timeoutMs);
    } finally {
      clearTimeout(timer);
      future.dispose();
    }

    return {
      outputs: dedupeImages(outputs),
      executionCount,
      status: replyStatus,
    };
  }

  interrupt(): Promise<void> {
    return this.kernel.interrupt();
  }

  async shutdown(): Promise<void> {
    if (!this.kernel.isDisposed) await this.kernel.shutdown();
  }

  dispose(): void {
    try {
      this.kernel.dispose();
    } catch {
      /* already disposed */
    }
  }

  get isDisposed(): boolean {
    return this.kernel.isDisposed;
  }

  get connectionStatus(): string {
    return this.kernel.connectionStatus;
  }

  /**
   * Wait for the WebSocket to reach "connected".
   *
   * lumino v2 note: `signal.connect()` returns void — you MUST keep a handler
   * reference and call `signal.disconnect(handler)`.  (v1 returned a dispose
   * function; relying on that breaks under v2.)
   */
  waitConnected(timeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.kernel.connectionStatus === "connected") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kernel.connectionStatusChanged.disconnect(handler);
        reject(new Error("[pi-jupyter] kernel connect timeout"));
      }, timeoutMs);
      const handler = (_k: Kernel.IKernelConnection, status: string) => {
        if (status === "connected") {
          clearTimeout(timer);
          this.kernel.connectionStatusChanged.disconnect(handler);
          resolve();
        }
      };
      this.kernel.connectionStatusChanged.connect(handler);
    });
  }
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new TimeoutError()), ms),
    ),
  ]);
}
