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
  /**
   * Scratch switch: when false the execution runs on the kernel but its result
   * is NOT written into the notebook document — no append when the source
   * matches no cell, no in-place update when it does. The result is still
   * returned to the caller, so exploratory code never pollutes the saved file.
   * Default true (record it); the `jupyter_repl` tool passes the agent's
   * explicit `persist` choice, whose default is false (scratch).
   */
  persist?: boolean;
  /**
   * When this run RECORDS A NEW CELL, insert it directly after the code cell
   * with this id instead of appending at the end of the document (issue 1-4:
   * "promote" a scratch probe into position, or place a fresh cell where it
   * belongs). Ignored when the source matches an existing cell (that cell is
   * re-run in place) and when `persist` is off. An unknown id is rejected
   * BEFORE anything runs.
   */
  afterCellId?: string;
};

// ── Remote contents ─────────────────────────────────────────────────────────

/** One entry of a remote contents directory listing (GET /api/contents/<dir>). */
export type ContentsEntry = {
  name: string;
  /** Contents path relative to the server root, e.g. "notes/pi.ipynb". */
  path: string;
  /** Content type as reported by the server: "notebook" | "file" | "directory" | "unknown". */
  type: string;
  /** ISO timestamp reported by the server, when present. */
  lastModified?: string;
  size?: number;
};

/** Result of listing a remote contents directory. */
export type DirectoryListing = {
  /** False when the directory itself does not exist on the server (HTTP 404). */
  exists: boolean;
  entries: ContentsEntry[];
};

// ── Observable ──────────────────────────────────────────────────────────────

/** Minimal Observable contract (execution-count tracking, view changes). */
export type ObservableLike<T> = {
  subscribe(next: (value: T) => void): { unsubscribe(): void };
};

// ── Session ─────────────────────────────────────────────────────────────────

export type CreateSessionOpts = {
  runtime?: string;
  /**
   * The kernel (kernelspec name, e.g. "python3" / "ir") this session runs on.
   * It is fixed when the notebook is opened (ARCHITECTURE.md): `resume()` uses
   * this opt first, then the kernelspec recorded in the notebook file, then
   * `ShimConfig.kernelName`, then "python3". A live bound kernel always wins.
   */
  kernelName?: string;
  workingDir?: string;
  peerLabel?: string;
  description?: string;
  dependencies?: string[];
  notebookId?: string;
  /**
   * Remote contents path this session is bound to (the /api/sessions row AND
   * the auto-save target). When set, it wins over `remoteSavePath` so a
   * resumed notebook keeps growing as exactly that file.
   */
  contentsPath?: string;
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
  /** Kernel (kernelspec name) this session runs on, as decided by the agent. */
  readonly kernelName: string;
  /**
   * Remote contents path this session lives at — the /api/sessions bind row and
   *   the auto-save target (a session created without an explicit path defaults to `<notebookId>.ipynb`).
   */
  readonly contentsPath: string;
  runCell(code: string, opts?: RunCellOpts): Promise<CellResult>;
  addDependencies(packages: string[]): Promise<void>;
  /**
   * Install requested-but-uncommitted packages, committing only the ones that
   * succeed (issue "poisoned deps set"). Resolves to the packages now known to
   * be available; throws when one or more requested packages could not install
   * (any partial success stays committed).
   */
  syncEnvironment(): Promise<string[]>;
  /** Write the session to an .ipynb; resolves to the path written. */
  saveNotebook(path?: string): Promise<string>;
  shutdown(): Promise<void>;
  close(): Promise<void>;
  /**
   * Detach WITHOUT killing the server-side kernel/session row: flush the
   * snapshot, then drop this client's connections. The kernel keeps running so
   * a later conversation (or the browser) can re-attach to the same path.
   * This is what pi calls on conversation end when `keepKernels` is on.
   */
  detach(): Promise<void>;
  /** Ordered code cells of the live document (file-restored + run this session). */
  listCells(): DocumentCell[];
  /**
   * Edit the live document (issue 1-2): delete / replace / move / insert a code
   * cell, then persist the result through the remote auto-save. This is the
   * in-plugin write path that makes editing an `.ipynb` during a session
   * possible without touching the file from the outside.
   */
  editCell(opts: CellEditOpts): Promise<CellEditOutcome>;
  /**
   * How this session attached to its contents path (set by resume(); undefined
   * for sessions created directly with initialize()): "attached" reused a live
   * kernel, "started" began a new one.
   */
  readonly resumeOutcome?: ResumeOutcome;
  getRuntimeStatus(): Promise<RuntimeStatus | undefined>;
  readonly executionViewChanges$: ObservableLike<CellResult>;
  /**
   * Optional side-channel notified after each remote auto-save attempt
   * (FR-6.2). Failures are by-passed — they never affect `runCell`.
   */
  onAutoSave?: (event: AutoSaveEvent) => void;
}

/** One code cell of a session's live document (see {@link Session.listCells}). */
export type DocumentCell = {
  /** Cell id as saved in the notebook (kept across in-place re-runs). */
  cellId: string;
  source: string;
  executionCount?: number;
  /** True while the cell came from the file and has not run on this kernel yet. */
  restored: boolean;
  /**
   * True when the cell was restored from the file AND that file recorded an
   * error output for it. Lets the open/replay summary tell a PRE-EXISTING
   * failing cell (the file's old debt) apart from a failure this replay
   * produced (issue 1-3).
   */
  fileError?: boolean;
};

// ── Cell editing (issue 1-2) ────────────────────────────────────────────────

/** The structural edits `jupyter_edit_cell` can apply to an open document. */
export type CellEditAction = "delete" | "replace" | "move" | "insert";

export type CellEditOpts = {
  action: CellEditAction;
  /** Target cell id for `delete` / `replace` / `move`. */
  cellId?: string;
  /** New source for `replace` / `insert`. */
  source?: string;
  /** 0-based index among CODE cells — the target for `move`, an optional insert point for `insert`. */
  position?: number;
  /** For `insert`: place the new cell directly after this cell id (wins over `position`). */
  afterCellId?: string;
};

export type CellEditOutcome = {
  action: CellEditAction;
  /** Id of the affected cell (kept for replace/move; fresh for insert). */
  cellId?: string;
  /** 0-based index of the affected cell among code cells AFTER the edit. */
  index?: number;
  /** The document's code cells after the edit, in order. */
  cells: DocumentCell[];
};

/** How {@link RemoteSession.resume} attached to a notebook path. */
export type ResumeMode = "attached" | "started";

export type ResumeOutcome = {
  mode: ResumeMode;
  /** False when no file existed at the path — the document started empty. */
  fileExisted: boolean;
  /** The adopted contents path. */
  path: string;
  /** Kernel now serving this session (the live kernel, or the newly started one). */
  kernel: string;
  /** Code cells restored from the existing file, in document order. */
  codeCells: DocumentCell[];
};

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
