/**
 * Domain types — the vocabulary shared across every layer.
 *
 * This module has ZERO external dependencies. Everything downstream
 * (kernel adapters, session, pi extension) speaks these types.
 */

// ── Mimebundle ──────────────────────────────────────────────────────────────

/**
 * A single mimebundle entry after normalization.
 *
 * Jupyter sends raw values (`"image/png": "<base64>"`); the rendering /
 * serialization layers expect `{ type, value }`.  Normalization is the
 * adapter's job (see `domain/output.ts`).
 */
export type MimeEntry = { type: "binary" | "text"; value: string };

/** A mimebundle with every entry normalized. */
export type NormalizedMimebundle = Record<string, MimeEntry>;

// ── Outputs ─────────────────────────────────────────────────────────────────

/**
 * A single normalized output produced by a cell execution.
 *
 * `dataJson` is a JSON string of a {@link NormalizedMimebundle} so the struct
 * stays serializable and cheap to copy across the streaming boundary.
 */
export type JsOutput = {
  outputType: "stream" | "execute_result" | "display_data" | "error";
  /** "stdout" | "stderr" — stream only. */
  name?: string;
  /** Text content — stream only. */
  text?: string;
  /** JSON string of a NormalizedMimebundle — execute_result / display_data. */
  dataJson?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  executionCount?: number;
};

// ── Cell execution ──────────────────────────────────────────────────────────

export type CellStatus = "done" | "error" | "timeout" | "kernel_error";

export type CellResult = {
  cellId: string;
  executionId: string;
  executionCount?: number;
  status: CellStatus;
  success: boolean;
  outputs?: JsOutput[];
};

export type RunCellOpts = {
  timeoutMs?: number;
  onUpdate?: (progress: CellResult) => void;
};

// ── Observable ──────────────────────────────────────────────────────────────

/** Minimal Observable contract (execution-count tracking, view changes). */
export type ObservableLike<T> = {
  subscribe(next: (value: T) => void): { unsubscribe(): void };
};

// ── Session ─────────────────────────────────────────────────────────────────

export type CreateSessionOpts = {
  runtime?: string;
  workingDir?: string;
  peerLabel?: string;
  description?: string;
  dependencies?: string[];
  notebookId?: string;
};

export type RuntimeStatus = {
  status: string;
  lifecycle: string;
  warnings?: string[];
  /** Outcome of the most recent remote auto-save (FR-6.4), if any. */
  lastAutoSave?: AutoSaveInfo;
};

/** Emitted to `Session.onAutoSave` after each remote auto-save attempt. */
export type AutoSaveEvent = {
  ok: boolean;
  /** The remote contents path written to. */
  path: string;
  error?: string;
};

/** Record of the latest remote auto-save attempt (observability, FR-6.4). */
export type AutoSaveInfo = {
  path: string;
  /** ISO timestamp of the attempt. */
  at: string;
  ok: boolean;
  error?: string;
};

/**
 * The session contract.  The pi extension depends only on this interface;
 * the concrete {@link RemoteSession} lives behind a {@link KernelPort}.
 */
export interface Session {
  readonly notebookId: string;
  runCell(code: string, opts?: RunCellOpts): Promise<CellResult>;
  addDependencies(packages: string[]): Promise<void>;
  syncEnvironment(): Promise<void>;
  /** Write the session to an .ipynb; resolves to the path written. */
  saveNotebook(path?: string): Promise<string>;
  shutdown(): Promise<void>;
  close(): Promise<void>;
  getRuntimeStatus(): Promise<RuntimeStatus | undefined>;
  readonly executionViewChanges$: ObservableLike<CellResult>;
  /**
   * Optional side-channel notified after each remote auto-save attempt
   * (FR-6.2). Failures are by-passed — they never affect `runCell`.
   */
  onAutoSave?: (event: AutoSaveEvent) => void;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Thrown when a cell execution exceeds its deadline. */
export class TimeoutError extends Error {
  constructor(message = "execution timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Thrown when the kernel's execute_reply never arrives because the underlying
 * future was canceled — e.g. an interrupt (SIGINT) fired by a concurrent or
 * preceding timeout, or the kernel/WebSocket dropping mid-execution.
 * Translated from jupyterlab's opaque `"Canceled future for execute_request
 * message before replies were done"` so callers can surface a readable error
 * instead of the raw client-library string (BUG-7).
 */
export class KernelInterruptedError extends Error {
  constructor(
    message = "kernel execution was interrupted before it replied (an interrupt " +
      "or a dropped connection canceled the request)",
  ) {
    super(message);
    this.name = "KernelInterruptedError";
  }
}

/**
 * Thrown by the pre-install reachability probe when the package repository
 * (CRAN for R) cannot be reached from the remote kernel, so the install fails
 * fast with a clear message instead of hanging until `installTimeoutMs` (BUG-8).
 */
export class RepoUnreachableError extends Error {
  constructor(repo: string) {
    super(
      `cannot reach the package repository ${repo} from the remote kernel — ` +
        "check the remote host's network/proxy, or use a reachable mirror",
    );
    this.name = "RepoUnreachableError";
  }
}
