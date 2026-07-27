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
  saveNotebook(path?: string): Promise<void>;
  shutdown(): Promise<void>;
  close(): Promise<void>;
  getRuntimeStatus(): Promise<RuntimeStatus | undefined>;
  readonly executionViewChanges$: ObservableLike<CellResult>;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Thrown when a cell execution exceeds its deadline. */
export class TimeoutError extends Error {
  constructor(message = "execution timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}
