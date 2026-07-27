/**
 * RemoteSession — the Session contract, implemented against the KernelPort seam.
 *
 * Owns the kernel lifecycle, cell history (for .ipynb export and the remote
 * autosave snapshot), the dependency set, and the executionViewChanges$
 * subject.  All execution goes through `KernelPort.execute()` — this class
 * never imports `@jupyterlab/services`, which is what makes it unit-testable
 * with a mock port.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ShimConfig } from "./config";
import { BOOTSTRAP_CODE, MISSING_PACKAGES_PROBE, parseMissingPackages } from "./domain/bootstrap";
import { buildInstallCode, installProbeCode, isRepoReachable, R_CRAN_REPO } from "./domain/deps";
import { buildNotebook, type CellRecord, type NotebookMeta } from "./domain/notebook";
import { stripAnsi } from "./domain/output";
import { Subject } from "./domain/subject";
import {
  type AutoSaveEvent,
  type AutoSaveInfo,
  type CellResult,
  type CreateSessionOpts,
  type JsOutput,
  type RuntimeStatus,
  type RunCellOpts,
  type Session,
  KernelInterruptedError,
  RepoUnreachableError,
  TimeoutError,
} from "./domain/types";
import type {
  ExecuteOutcome,
  KernelPort,
  KernelSpecInfo,
  KernelSpecList,
  ServerPort,
} from "./kernel/port";

/** Cap on waiting for the final auto-save during shutdown (R9.2). */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 30_000;

/** Default cap for an explicit `flushAutoSave()` call. */
const FLUSH_TIMEOUT_MS = 30_000;

export class RemoteSession implements Session {
  readonly notebookId: string;

  /** Side-channel notified after every remote auto-save attempt (FR-6.2). */
  onAutoSave?: (event: AutoSaveEvent) => void;

  private kernel: KernelPort | null = null;
  /**
   * FIFO serialization of kernel executions (BUG-7). runCell and install both
   * await this chain so parallel tool calls never interleave two requestExecute
   * on the single-threaded kernel — otherwise one cell's timeout interrupt
   * cancels the other's in-flight future. The chain swallows each rejection so
   * a failed call never wedges the ones queued behind it.
   */
  private kernelChain: Promise<void> = Promise.resolve();
  private kernelSpec: KernelSpecInfo | null = null;
  private execCount = 0;
  private cells: CellRecord[] = [];
  private deps = new Set<string>();
  private warnings: string[] = [];
  /** Outcome of the most recent remote auto-save (FR-6.4). */
  private lastAutoSave?: AutoSaveInfo;

  // ── remote auto-save worker (FR-5): single serial loop, dirty-flag coalesce ──
  /** Contents path shared by bind-session and auto-save (INV-1). */
  private effectivePath: string | null = null;
  /** Path-config warning, re-appended after every bootstrap (which resets warnings). */
  private effectivePathWarning?: string;
  private autoSaveDirty = false;
  private autoSaveRunning = false;
  private autoSaveChain: Promise<void> = Promise.resolve();

  private viewChanges = new Subject<CellResult>();

  constructor(
    private server: ServerPort,
    private config: ShimConfig,
    private opts: CreateSessionOpts = {},
  ) {
    this.notebookId =
      opts.notebookId ?? `remote-${Date.now()}-${randomUUID().slice(0, 8)}`;
    for (const d of opts.dependencies ?? []) this.deps.add(d.trim());
  }

  /** Kernel language (lower-cased); "python" when the kernelspec is unknown. */
  get language(): string {
    return (this.kernelSpec?.language ?? "python").toLowerCase();
  }

  /** Connect to the server, start a kernel, bootstrap, and pre-install deps. */
  async initialize(): Promise<void> {
    await this.server.ping();
    // Validate kernelName against the server's kernelspecs *before* starting,
    // so a typo (or a display name like "R" instead of "ir") fails with a
    // clear, actionable message (UX-7).
    this.kernelSpec = await this.resolveKernelSpec();
    // effectivePath is the single source of truth shared by the bind-session
    // row and the remote auto-save target (INV-1).
    this.effectivePath = this.computeEffectivePath();
    this.kernel = await this.server.startKernel(this.config.kernelName, {
      sessionPath: this.effectivePath,
      sessionName: this.notebookId,
    });
    await this.kernel.waitConnected();

    // Idempotent bootstrap + missing-package warnings (python-only, BUG-4).
    await this.bootstrap();
    if (this.effectivePathWarning) this.warnings.push(this.effectivePathWarning);

    if (this.deps.size > 0) await this.install([...this.deps]);
  }

  // ── core: execute code ────────────────────────────────────────────────────

  async runCell(source: string, opts: RunCellOpts = {}): Promise<CellResult> {
    // Fail fast when there is no kernel — before queueing on the lock.
    this.requireKernel();
    // Serialize on the shared kernel so parallel calls cannot collide (BUG-7).
    return this.withKernelLock(() => this.executeCell(source, opts));
  }

  /**
   * Run `fn` exclusively on the kernel (FIFO). A rejecting call is handed to
   * its caller but never breaks the queue for the calls behind it.
   */
  private withKernelLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.kernelChain.then(fn, fn);
    this.kernelChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The actual cell execution; always runs under the kernel lock. */
  private async executeCell(source: string, opts: RunCellOpts): Promise<CellResult> {
    let kernel = this.requireKernel();
    const cellId = `cell-${randomUUID().slice(0, 8)}`;
    const executionId = `exec-${randomUUID().slice(0, 8)}`;
    const timeoutMs = opts.timeoutMs ?? this.config.defaultTimeoutMs;

    const partial: CellResult = {
      cellId,
      executionId,
      executionCount: this.execCount + 1,
      status: "done",
      success: true,
      outputs: [],
    };

    try {
      // A previous execution may have timed out on a kernel that ignores
      // interrupts and never returned to idle (BUG-6). Rather than silently
      // queueing behind leftover computation, recover or fail fast. Checked
      // under the lock, so it sees the state the prior cell left behind.
      if (kernel.status === "busy") {
        if (this.config.timeoutRestartKernel) {
          await this.restartKernel("kernel was still busy after a previous timeout");
          kernel = this.requireKernel();
        } else {
          throw new Error(
            "[pi-jupyter] kernel still busy after a previous timeout. " +
              "Run /jupyter-reset to start fresh, or set timeoutRestartKernel " +
              "(JUPYTER_TIMEOUT_RESTART_KERNEL=1) to auto-recover (state will be lost).",
          );
        }
      }
      const { outputs, executionCount, status } = await kernel.execute(source, {
        timeoutMs,
        onUpdate: (outs: JsOutput[]) => {
          partial.outputs = outs;
          opts.onUpdate?.({ ...partial });
        },
      });
      partial.outputs = outputs;
      partial.status = status === "ok" ? "done" : "error";
      partial.success = status === "ok";
      if (executionCount != null) {
        partial.executionCount = executionCount;
        this.execCount = executionCount;
      }
    } catch (err) {
      const isTimeout = err instanceof TimeoutError;
      partial.status = isTimeout ? "timeout" : "error";
      partial.success = false;
      partial.outputs = [
        {
          outputType: "error",
          // Use the real error class name (e.g. KernelInterruptedError) so the
          // model sees a precise cause instead of a blanket "ShimError" (BUG-7).
          ename: isTimeout ? "TimeoutError" : (err as Error).name || "ShimError",
          evalue: (err as Error).message,
          traceback: [(err as Error).stack ?? (err as Error).message],
        },
      ];
    }

    this.cells.push({ source, result: partial });
    this.viewChanges.next(partial);
    // Snapshot auto-save after every cell record — done/error/timeout alike
    // (FR-1.2). Runs in the background and is never awaited, so a failure can
    // never change this result (FR-6.1).
    this.scheduleAutoSave();
    return partial;
  }

  // ── dependency management ─────────────────────────────────────────────────

  async addDependencies(packages: string[]): Promise<void> {
    for (const p of packages) this.deps.add(p.trim());
  }

  async syncEnvironment(): Promise<void> {
    if (this.deps.size) await this.install([...this.deps]);
  }

  // ── save to disk ──────────────────────────────────────────────────────────

  /**
   * Serialize the current cell history to a nbformat object (pure JSON).
   * Shared by the local `saveNotebook` and the remote auto-save worker so
   * both snapshots stay byte-for-byte consistent (FR-8.2). The worker calls
   * this afresh before every PUT, so a stale snapshot can never clobber a
   * newer one (FR-5.2).
   */
  toNotebookObject(): Record<string, unknown> {
    return buildNotebook(this.cells, this.notebookMeta());
  }

  /**
   * Write the session to an `.ipynb`.  Returns the path actually written
   * (callers should pass an absolute path; BUG-3).  The notebook header
   * reflects the real kernelspec/language (BUG-2).
   */
  async saveNotebook(path?: string): Promise<string> {
    const savePath = path ?? `${this.notebookId}.ipynb`;
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, JSON.stringify(this.toNotebookObject(), null, 1));
    return savePath;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    // Flush the final snapshot before tearing down kernel/server (FR-9).
    // By-passed on failure and capped, so shutdown cannot hang (R9.2).
    await this.flushAutoSave(SHUTDOWN_FLUSH_TIMEOUT_MS);
    try {
      if (this.kernel && !this.kernel.isDisposed) await this.kernel.shutdown();
    } finally {
      this.disposeKernel();
      try { this.server.dispose(); } catch { /* ignore */ } // 释放 SessionManager，防监听/轮询泄漏
    }
  }

  async close(): Promise<void> {
    this.disposeKernel();
  }

  async getRuntimeStatus(): Promise<RuntimeStatus | undefined> {
    if (!this.kernel) return { status: "stopped", lifecycle: "stopped" };
    return {
      status: this.kernel.connectionStatus,
      lifecycle: this.kernel.isDisposed ? "stopped" : "running",
      warnings: this.warnings,
      lastAutoSave: this.lastAutoSave,
    };
  }

  get executionViewChanges$() {
    return this.viewChanges;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private requireKernel(): KernelPort {
    if (!this.kernel || this.kernel.isDisposed) {
      throw new Error("[pi-jupyter] kernel not available");
    }
    return this.kernel;
  }

  /**
   * Fetch the kernelspec for `config.kernelName`, validating it exists (UX-7).
   * Returns null when the server cannot list specs — we then degrade to the
   * old behavior and let `startKernel` fail on its own.
   */
  private async resolveKernelSpec(): Promise<KernelSpecInfo | null> {
    let list: KernelSpecList;
    try {
      list = await this.server.listKernelSpecs();
    } catch {
      return null;
    }
    const spec = list.specs.find((s) => s.name === this.config.kernelName);
    if (!spec) throw new Error(formatKernelSpecMismatch(this.config.kernelName, list));
    return spec;
  }

  /** Python-only kernel prep; other languages skip it cleanly (BUG-4). */
  private async bootstrap(): Promise<void> {
    if (this.language !== "python") {
      this.warnings = [];
      return;
    }
    const kernel = this.requireKernel();
    await kernel.execute(BOOTSTRAP_CODE, { timeoutMs: 30_000, silent: true });
    this.warnings = await this.probeMissingPackages();
  }

  private async install(packages: string[]): Promise<void> {
    // Serialize with running cells on the same kernel (BUG-7).
    await this.withKernelLock(() => this.runInstall(packages));
  }

  private async runInstall(packages: string[]): Promise<void> {
    const kernel = this.requireKernel();
    const code = buildInstallCode(packages, this.language);
    if (!code) return;
    // Fail fast when the package repo is unreachable, instead of letting the
    // install block on the network until installTimeoutMs (BUG-8). R only;
    // %pip already surfaces a quick, readable network error.
    const probe = installProbeCode(this.language);
    if (probe) {
      const outcome = await kernel.execute(probe, {
        timeoutMs: Math.min(30_000, this.config.installTimeoutMs),
        // BUG-9: must be silent:false — the probe reports reachability via cat()
        // stdout on iopub, which a silent execution suppresses (→ empty stdout →
        // false 'unreachable', even when the repo is perfectly reachable).
        // storeHistory:false keeps the probe out of kernel history and avoids
        // consuming an execution_count.
        silent: false,
        storeHistory: false,
      });
      const stdout = outcome.outputs
        .filter((o) => o.outputType === "stream" && o.text)
        .map((o) => o.text!)
        .join("\n");
      // A hard probe error (e.g. warn=2 promoted the connection failure) or an
      // explicit FALSE both mean the repo cannot be reached.
      if (outcome.status !== "ok" || !isRepoReachable(stdout)) {
        throw new RepoUnreachableError(R_CRAN_REPO);
      }
    }
    const outcome = await kernel.execute(code, { timeoutMs: this.config.installTimeoutMs });
    // `%pip` / install.packages failures must surface — never report success
    // on a failed or errored install (BUG-1).
    assertInstallSucceeded(outcome, packages);
  }

  private async probeMissingPackages(): Promise<string[]> {
    const kernel = this.requireKernel();
    const { outputs } = await kernel.execute(MISSING_PACKAGES_PROBE, {
      timeoutMs: 15_000,
      silent: true,
    });
    const stdout = outputs
      .filter((o) => o.outputType === "stream" && o.text)
      .map((o) => o.text!)
      .join("\n");
    return parseMissingPackages(stdout);
  }

  /** Notebook header metadata from the live kernelspec (BUG-2). */
  private notebookMeta(): NotebookMeta {
    const spec = this.kernelSpec;
    return {
      kernelName: spec?.name ?? this.config.kernelName,
      displayName: spec?.displayName ?? this.config.kernelName,
      language: this.language,
    };
  }

  // ── remote auto-save (FR-1 … FR-6, FR-9) ───────────────────────────────────

  /**
   * Resolve the single contents path used for BOTH the bind-session row and
   * the remote auto-save target (INV-1). Defaults to `${notebookId}.ipynb` at
   * the contents root, which in a default jupyter_server deployment equals the
   * REMOTE user's $HOME (§9.1: root_dir == $HOME). The LOCAL home directory is
   * never consulted here (red line, §9.2).
   */
  private computeEffectivePath(): string {
    const fallback = `${this.notebookId}.ipynb`;
    const raw = this.config.remoteSavePath;
    if (!raw) return fallback;
    // Contents paths are relative to root_dir — drop any leading slashes.
    const relative = raw.replace(/^\/+/, "");
    if (relative.split("/").some((segment) => segment === "..")) {
      // bootstrap() resets this.warnings, so keep the warning for re-append.
      this.effectivePathWarning =
        `remoteSavePath "${raw}" contains a ".." segment — path traversal is ` +
        `not allowed; falling back to ${fallback}`;
      return fallback;
    }
    return relative;
  }

  /**
   * Mark the snapshot dirty and wake the serial worker (FR-5.3). Never
   * awaits: auto-save must not add latency to `runCell` (R5.1). A complete
   * no-op when `remoteAutoSave` is off (R7.1).
   */
  private scheduleAutoSave(): void {
    if (!this.config.remoteAutoSave || !this.effectivePath) return;
    this.autoSaveDirty = true;
    this.pumpAutoSave();
  }

  private pumpAutoSave(): void {
    if (this.autoSaveRunning) return; // the loop re-checks the dirty flag each round
    this.autoSaveRunning = true;
    this.autoSaveChain = this.autoSaveChain
      .catch(() => undefined) // keep the chain alive after an unexpected throw
      .then(() => this.autoSaveLoop());
  }

  /**
   * Serial worker: at most one PUT in flight. Each round clears the dirty
   * flag and THEN serializes, so any later PUT carries the same-or-newer
   * cells — an older snapshot can never overwrite a newer one (FR-5.2).
   * Consecutive triggers therefore coalesce into at most an in-flight plus a
   * trailing PUT (FR-5.3).
   */
  private async autoSaveLoop(): Promise<void> {
    try {
      while (this.autoSaveDirty && this.effectivePath) {
        this.autoSaveDirty = false;
        const path = this.effectivePath;
        const snapshot = this.toNotebookObject(); // fresh AFTER the flag, BEFORE the PUT
        try {
          await this.server.uploadNotebook(path, snapshot);
          this.lastAutoSave = { path, at: new Date().toISOString(), ok: true };
          this.onAutoSave?.({ ok: true, path });
        } catch (err) {
          const message = (err as Error).message;
          this.lastAutoSave = { path, at: new Date().toISOString(), ok: false, error: message };
          this.warnings.push(`remote autosave to "${path}" failed: ${message}`);
          this.onAutoSave?.({ ok: false, path, error: message });
        }
      }
    } finally {
      this.autoSaveRunning = false;
    }
  }

  /**
   * Force a final round and wait for the worker to drain (FR-9 / tests).
   * No-op when `remoteAutoSave` is off — never sends a request (R7.1).
   * Times out instead of hanging forever (R9.2).
   */
  async flushAutoSave(timeoutMs: number = FLUSH_TIMEOUT_MS): Promise<void> {
    if (!this.config.remoteAutoSave) return;
    if (this.cells.length > 0) {
      this.autoSaveDirty = true;
      this.pumpAutoSave();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.autoSaveChain,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("flush timed out")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      this.warnings.push(
        "remote autosave flush timed out; the latest snapshot may not be persisted",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Restart the kernel to escape an unrecoverable busy state (BUG-6 recovery
   * policy).  Re-runs bootstrap and reinstalls deps; in-memory state is lost.
   */
  private async restartKernel(reason: string): Promise<void> {
    const old = this.kernel;
    this.kernel = null;
    if (old) {
      try {
        if (!old.isDisposed) await old.shutdown();
      } catch {
        /* ignore */
      }
      old.dispose();
    }
    this.kernel = await this.server.startKernel(this.config.kernelName, {
      sessionPath: this.effectivePath ?? `${this.notebookId}.ipynb`,
      sessionName: this.notebookId,
    });
    await this.kernel.waitConnected();
    await this.bootstrap();
    if (this.effectivePathWarning) this.warnings.push(this.effectivePathWarning);
    if (this.deps.size > 0) {
      try {
        await this.install([...this.deps]);
      } catch (err) {
        this.warnings.push(`reinstall after restart failed: ${(err as Error).message}`);
      }
    }
    this.warnings.push(`kernel restarted (${reason}); in-memory state was lost`);
  }

  private disposeKernel(): void {
    this.kernel?.dispose();
    this.kernel = null;
  }
}

/**
 * Build a clear error for a kernelName that matches no kernelspec (UX-7):
 * lists the available kernels grouped by language and reminds the user that
 * kernelName is the spec *name* (e.g. "ir"), not the display name ("R").
 */
export function formatKernelSpecMismatch(requested: string, list: KernelSpecList): string {
  const byLanguage = new Map<string, KernelSpecInfo[]>();
  for (const spec of list.specs) {
    const lang = spec.language || "unknown";
    const bucket = byLanguage.get(lang);
    if (bucket) bucket.push(spec);
    else byLanguage.set(lang, [spec]);
  }
  const groups = [...byLanguage.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([lang, specs]) =>
        `  ${lang}: ${specs.map((s) => `${s.name} (${s.displayName})`).join(", ")}`,
    )
    .join("\n");
  return [
    `[pi-jupyter] kernel "${requested}" not found on the Jupyter server.`,
    'kernelName must be a kernelspec *name* (e.g. "ir"), not a display name (e.g. "R").',
    "Available kernels:",
    groups,
    list.default ? `default: ${list.default}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Throw when an install run failed or produced error outputs (BUG-1). */
function assertInstallSucceeded(outcome: ExecuteOutcome, packages: string[]): void {
  const errorOutputs = outcome.outputs.filter((o) => o.outputType === "error");
  if (outcome.status === "ok" && errorOutputs.length === 0) return;
  const errorText = errorOutputs
    .map((o) => [`${o.ename ?? "Error"}: ${o.evalue ?? ""}`, ...(o.traceback ?? [])].join("\n"))
    .join("\n");
  const stderrText = outcome.outputs
    .filter((o) => o.outputType === "stream" && o.name === "stderr" && o.text)
    .map((o) => o.text)
    .join("");
  const detail = stripAnsi((errorText || stderrText).trim());
  throw new Error(
    `[pi-jupyter] failed to install ${packages.join(", ")} (status: ${outcome.status})` +
      (detail ? `:\n${detail}` : ""),
  );
}
