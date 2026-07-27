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

/** A single kernelspec, as reported by GET /api/kernelspecs (UX-7). */
export type KernelSpecInfo = {
  /** The spec *name* used to start a kernel, e.g. "python3" or "ir". */
  name: string;
  /** Human display name, e.g. "Python 3" or "R". */
  displayName: string;
  /** Kernel language, lower-cased, e.g. "python" or "r". */
  language: string;
};

/** The server's kernelspec listing. */
export type KernelSpecList = {
  /** Default kernelspec name (may be "" if the server reports none). */
  default: string;
  specs: KernelSpecInfo[];
};

/** What the session needs from a live kernel. */
export interface KernelPort {
  execute(code: string, opts?: ExecuteOptions): Promise<ExecuteOutcome>;
  interrupt(): Promise<void>;
  shutdown(): Promise<void>;
  dispose(): void;
  readonly isDisposed: boolean;
  readonly connectionStatus: string;
  /** Execution state: "idle" | "busy" | "starting" | "unknown" | … (BUG-6). */
  readonly status: string;
  /** Resolves when the WebSocket reaches "connected"; rejects on timeout. */
  waitConnected(timeoutMs?: number): Promise<void>;
  /** Resolves true once the kernel reaches "idle"; false on timeout (BUG-6). */
  waitIdle(timeoutMs?: number): Promise<boolean>;
}

/** What the session needs to reach a Jupyter Server. */
export interface ServerPort {
  /** GET /api — verify reachability + token. */
  ping(): Promise<void>;
  /** GET /api/kernelspecs — list available kernels (UX-7). */
  listKernelSpecs(): Promise<KernelSpecList>;
  /** POST /api/kernels — start a kernel, return a live port. */
  startKernel(name: string): Promise<KernelPort>;
  dispose(): void;
}
