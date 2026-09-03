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
  /**
   * Override `store_history` independently of `silent`. Defaults to `!silent`.
   * Needed by the R repo-reachability probe (BUG-9): the probe must run with
   * `silent: false` so its `cat()` stdout reaches iopub (silent executions have
   * their stream output suppressed by the kernel), yet `store_history: false` so
   * it neither consumes an execution_count nor pollutes kernel history.
   */
  storeHistory?: boolean;
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

/** A live server-side session (the /api/sessions model pi cares about). */
export type ServerSessionModel = {
  id: string;
  /** Contents path the session is bound to, e.g. "notes/pi.ipynb". */
  path: string;
  name: string;
  type: string;
  kernelId: string;
  kernelName: string;
};

/** Options for starting a kernel, optionally binding it to a Jupyter session. */
export type StartKernelOpts = {
  /** 绑定的虚拟 notebook 路径；提供时建 /api/sessions 行，使内核出现在 Running UI。 */
  sessionPath?: string;
  /** Running UI 里显示的 name。 */
  sessionName?: string;
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
  /** 起内核；传 opts.sessionPath 时额外建一个 session，使其出现在 Jupyter Running UI。 */
  startKernel(name: string, opts?: StartKernelOpts): Promise<KernelPort>;
  /**
   * Look up a LIVE session bound to `contentsPath` (GET /api/sessions).
   * Resolves null when nothing is running there — the caller then resumes from
   * the file with a new kernel instead of attaching.
   */
  findLiveSession(contentsPath: string): Promise<ServerSessionModel | null>;
  /** All live sessions on the server (GET /api/sessions) — for listing candidates. */
  listSessions(): Promise<ServerSessionModel[]>;
  /**
   * Attach a NEW client to an already-running session's kernel (no new
   * kernel on the server — in-memory state is preserved).
   */
  connectToSession(model: ServerSessionModel): Promise<KernelPort>;
  /**
   * Read an nbformat model from a remote contents path
   * (GET /api/contents/<path>). Resolves null when the file is missing or is
   * not a notebook.
   */
  readNotebook(contentsPath: string): Promise<Record<string, unknown> | null>;
  /**
   * Write an nbformat model to a remote contents path via
   * `PUT /api/contents/<path>` (create-or-update: 201 when new, 200 when it
   * already exists). Used by the session's remote auto-save (FR-2). Throws on
   * a non-ok response; the caller by-passes the failure.
   */
  uploadNotebook(contentsPath: string, model: Record<string, unknown>): Promise<void>;
  /**
   * Shut down a LIVE server-side session by its model row (DELETE
   * /api/sessions/<id>): kills its kernel and drops the session row. The
   * notebook FILE at `model.path` stays on the server. Used by
   * `jupyter_shutdown_notebook` for kernels this conversation never opened
   * (left running by an earlier conversation, the browser, or an
   * auto-materialized anonymous session).
   */
  shutdownSession(model: ServerSessionModel): Promise<void>;
  dispose(): void;
}
