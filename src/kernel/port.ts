/**
 * KernelPort / ServerPort — the hexagonal seam.
 *
 * The domain (session) depends ONLY on these interfaces.  The concrete
 * implementations in `kernel.ts` / `server.ts` carry every line of
 * `@jupyterlab/services` complexity.  This is what makes the session testable
 * offline: inject a mock KernelPort and no real Jupyter Server is needed.
 */
import type { JsOutput } from "../domain/types";

export type ExecuteOptions = {
  timeoutMs?: number;
  silent?: boolean;
  /** Called with the accumulated outputs after each iopub message. */
  onUpdate?: (outputs: JsOutput[]) => void;
};

export type ExecuteOutcome = {
  outputs: JsOutput[];
  executionCount?: number;
  /** "ok" | "error" | "abort" — the authoritative shell-reply status. */
  status: "ok" | "error" | "abort";
};

/** What the session needs from a live kernel. */
export interface KernelPort {
  execute(code: string, opts?: ExecuteOptions): Promise<ExecuteOutcome>;
  interrupt(): Promise<void>;
  shutdown(): Promise<void>;
  dispose(): void;
  readonly isDisposed: boolean;
  readonly connectionStatus: string;
  /** Resolves when the WebSocket reaches "connected"; rejects on timeout. */
  waitConnected(timeoutMs?: number): Promise<void>;
}

/** What the session needs to reach a Jupyter Server. */
export interface ServerPort {
  /** GET /api — verify reachability + token. */
  ping(): Promise<void>;
  /** POST /api/kernels — start a kernel, return a live port. */
  startKernel(name: string): Promise<KernelPort>;
  dispose(): void;
}
