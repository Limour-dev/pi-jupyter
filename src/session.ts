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
import { basename, dirname } from "node:path";
import type { ShimConfig } from "./config";
import { BOOTSTRAP_CODE, MISSING_PACKAGES_PROBE, parseMissingPackages } from "./domain/bootstrap";
import { buildInstallCode, installProbeCode, isRepoReachable, parseInstallOutput, R_CRAN_REPO, type InstallOutputReport } from "./domain/deps";
import {
  buildNotebookFromSlots,
  notebookMetaOf,
  parseNotebook,
  type NotebookMeta,
  type NotebookSlot,
} from "./domain/notebook";
import { stripAnsi } from "./domain/output";
import { Subject } from "./domain/subject";
import {
  type AutoSaveEvent,
  type AutoSaveInfo,
  type CellResult,
  type CreateSessionOpts,
  type DocumentCell,
  type JsOutput,
  type ResumeOutcome,
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
  /** Kernel (kernelspec name) this session runs on — agent-decided. */
  private _kernelName = "";
  get kernelName(): string {
    return this._kernelName;
  }
  get contentsPath(): string {
    // effectivePath is assigned at initialize()/resume(); before that, show the
    // path the session WILL use (the same fallback chain, unvalidated).
    return this.effectivePath ?? this.contentsPathFallback();
  }

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
  /** Kernelspec header of the ADOPTED notebook file (used when no live spec is fetched). */
  private adoptedMeta?: NotebookMeta;
  private execCount = 0;
  /**
   * The live document: restored file cells (verbatim raw + mirrored records)
   * followed by the cells run in this session. Serialization keeps restored,
   * never-re-run cells byte-for-byte (`buildNotebookFromSlots`).
   */
  private slots: NotebookSlot[] = [];
  /** Number of cells executed in this session (drives the autosave flush guard). */
  private executedCells = 0;
  /**
   * Outcome of the latest `resume()` — how this session attached to its path
   * ("attached" keeps the live kernel; "started" began a new one). Set by
   * resume(); undefined for anonymous sessions.
   */
  resumeOutcome?: ResumeOutcome;
  /**
   * Desired environment that is KNOWN to be installed. Only a package whose
   * install succeeded is ever committed here (issue "poisoned deps set",
   * Option 1): a name that fails to install is dropped, so it can never poison
   * a later call. This set is the restart-recovery source of truth —
   * `restartKernel` reinstalls exactly these names.
   */
  private deps = new Set<string>();
  /**
   * Packages requested via addDependencies() but not yet confirmed installed.
   * syncEnvironment() installs them and commits only the successes to `deps`,
   * then clears this buffer — a failure here never leaks into `deps`.
   */
  private pending = new Set<string>();
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
    this.notebookId = opts.notebookId ?? notebookIdFromPath(opts.contentsPath) ?? `remote-${Date.now()}-${randomUUID().slice(0, 8)}`;
    // The kernel is chosen by the agent per call (ARCHITECTURE.md);
    // config.kernelName is only the optional fallback default. resume() may
    // re-derive it from the adopted file / the live kernel.
    this._kernelName = opts.kernelName ?? config.kernelName ?? "";
    for (const d of opts.dependencies ?? []) this.deps.add(d.trim());
  }

  /**
   * Kernel language (lower-cased): the live kernelspec when known; for an
   * attached session the adopted file's header; else a kernel-name guess.
   */
  get language(): string {
    return (
      this.kernelSpec?.language ??
      this.adoptedMeta?.language ??
      (this.kernelName?.toLowerCase() === "ir" ? "r" : "python")
    ).toLowerCase();
  }

  /** Connect to the server, start a kernel, bootstrap, and pre-install deps. */
  async initialize(): Promise<void> {
    if (!this.kernelName) {
      throw new Error(
        "[pi-jupyter] no kernel selected for this session. The agent " +
          'should pick a kernel from `jupyter_list_kernels` and pass it as the ' +
          "`kernel` parameter (a kernelspec name like \"python3\" or \"ir\").",
      );
    }
    await this.server.ping();
    // Validate kernelName against the server's kernelspecs *before* starting,
    // so a typo (or a display name like "R" instead of "ir") fails with a
    // clear, actionable message (UX-7).
    this.kernelSpec = await this.resolveKernelSpec();
    // effectivePath is the single source of truth shared by the bind-session
    // row and the remote auto-save target (INV-1).
    this.effectivePath = this.computeEffectivePath();
    this.kernel = await this.server.startKernel(this.kernelName, {
      sessionPath: this.effectivePath,
      sessionName: this.notebookId,
    });
    await this.kernel.waitConnected();

    // Idempotent bootstrap + missing-package warnings (python-only, BUG-4).
    await this.bootstrap();
    if (this.effectivePathWarning) this.warnings.push(this.effectivePathWarning);

    await this.preInstallDeps();
  }

  /**
   * Open a notebook at a remote contents path and CONTINUE it:
   *
   *   1. If a live /api/sessions row is bound to `path`, ATTACH to its running
   *      kernel — no new kernel is started, so the in-memory variables from the
   *      previous conversation/browser survive (mode "attached").
   *   2. Otherwise start a NEW kernel bound to the same path, seeding the
   *      document from the file's existing cells so the same file keeps growing
   *      (mode "started"; a missing file just starts the document empty).
   *
   * The kernel of a fresh start comes from (in order): the agent's explicit
   * `kernelName` opt, the kernelspec recorded in the file, the config fallback,
   * then "python3". An attach ignores the opt — it reuses whatever kernel the
   * live session is running.
   */
  async resume(contentsPath: string): Promise<ResumeOutcome> {
    if (this.kernel) {
      throw new Error("[pi-jupyter] session already has a kernel; close it before resuming another path");
    }
    const path = normalizeContentsPath(contentsPath);
    await this.server.ping(); // bad token/unreachable → the clear hint, not a swallowed read failure
    this.effectivePath = path;
    // Notes gathered before a fresh kernel's bootstrap (bootstrap() resets
    // warnings) — emitted after it so the user still sees them.
    const resumeNotes: string[] = [];

    // Best-effort read of the existing file (a hiccup must not lose the kernel).
    let model: Record<string, unknown> | null = null;
    try {
      model = await this.server.readNotebook(path);
    } catch (err) {
      this.warnings.push(`could not read the existing notebook "${path}": ${(err as Error).message}`);
    }
    const parsed = parseNotebook(model);
    this.adoptedMeta = parsed.meta;
    this.slots = parsed.slots;

    // 1) Live session on the server → attach (no new kernel, state preserved).
    const live = (this.config.bindSession ?? true) !== false
      ? await this.server.findLiveSession(path).catch(() => null)
      : null;
    if (live) {
      try {
        this.kernel = await this.server.connectToSession(live);
        this._kernelName = live.kernelName || this._kernelName;
        // An attached kernel is already bootstrapped; validate it answers.
        await this.kernel.waitConnected();
      } catch (err) {
        // Stale row / kernel died between the listing and the attach: fall back
        // to starting a fresh kernel bound to the same path.
        resumeNotes.push(`could not attach to the live session (${(err as Error).message}); starting a fresh kernel instead`);
        const failed = this.kernel;
        this.kernel = null;
        if (failed) { try { failed.dispose(); } catch { /* ignore */ } }
      }
    }
    const mode = this.kernel ? "attached" : "started";

    // 2) No live kernel → start one bound to the same path (resume from file).
    if (!this.kernel) {
      const fileKernel = this.adoptedMeta?.kernelName;
      const requested = this.opts.kernelName ?? fileKernel ?? this.config.kernelName ?? "python3";
      if (!requested.trim()) {
        throw new Error(
          "[pi-jupyter] no kernel selected for this session. Pass `kernel` (a kernelspec name " +
            "like \"python3\" or \"ir\"), or let the notebook file decide.",
        );
      }
      this._kernelName = requested;
      // Validate against the server's kernelspecs before starting (UX-7).
      this.kernelSpec = await this.resolveKernelSpec();
      if (this.opts.kernelName && fileKernel && this.opts.kernelName !== fileKernel) {
        resumeNotes.push(
          `notebook "${path}" records kernel "${fileKernel}" but you asked for "${this.opts.kernelName}" — using "${this.opts.kernelName}"`,
        );
      }
      this.kernel = await this.server.startKernel(this._kernelName, {
        sessionPath: path,
        sessionName: this.notebookId,
      });
      await this.kernel.waitConnected();
      // Fresh kernel → idempotent bootstrap + missing-package warnings.
      await this.bootstrap();
      if (this.effectivePathWarning) this.warnings.push(this.effectivePathWarning);
      await this.preInstallDeps();
    }
    for (const note of resumeNotes) this.warnings.push(note);

    const outcome: ResumeOutcome = {
      mode,
      fileExisted: model !== null,
      path,
      kernel: this._kernelName,
      codeCells: this.listCells(),
    };
    this.resumeOutcome = outcome;
    return outcome;
  }

  /**
   * Install the constructor-recorded dependencies into the kernel, committing
   * only the successes (issue "poisoned deps set"). Shared by initialize() and
   * the resume-from-file path.
   */
  private async preInstallDeps(): Promise<void> {
    if (this.deps.size === 0) return;
    const { installed, failed } = await this.install([...this.deps]);
    if (failed.length) {
      for (const p of failed) this.deps.delete(p);
      this.warnings.push(
        `pre-install failed for: ${failed.join(", ")}` +
          (installed.length ? ` (installed: ${installed.join(", ")})` : ""),
      );
    }
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
    // In-place re-run: a restored file cell whose source matches is executed
    // back into ITS slot (like JupyterLab re-running a cell) instead of
    // appending a duplicate. Only the first still-restored match is targeted;
    // identical code run again appends a new cell.
    const restoreTarget = this.slots.find(
      (s): s is Extract<NotebookSlot, { kind: "code" }> =>
        s.kind === "code" && s.restored && s.source === source,
    );
    const cellId = restoreTarget?.cellId ?? `cell-${randomUUID().slice(0, 8)}`;
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

    if (restoreTarget) {
      // The restored slot now carries THIS kernel's result; from here on the
      // cell serializes from the fresh record, not the stale file raw.
      restoreTarget.result = partial;
      restoreTarget.restored = false;
      restoreTarget.raw = undefined;
    } else {
      this.slots.push({ kind: "code", cellId, source, result: partial, restored: false });
    }
    this.executedCells += 1;
    this.viewChanges.next(partial);
    // Snapshot auto-save after every cell record — done/error/timeout alike
    // (FR-1.2). Runs in the background and is never awaited, so a failure can
    // never change this result (FR-6.1).
    this.scheduleAutoSave();
    return partial;
  }

  // ── dependency management ─────────────────────────────────────────────────

  /**
   * Record packages as *requested*. They are not committed to the persistent
   * desired set until syncEnvironment() confirms they actually installed
   * (issue "poisoned deps set", Option 1) — so a name that later fails to
   * install never poisons a future call or a restart-recovery reinstall.
   */
  async addDependencies(packages: string[]): Promise<void> {
    for (const p of packages) this.pending.add(p.trim());
  }

  /**
   * Install everything requested-but-uncommitted and commit only the packages
   * that installed to the persistent desired set. Failed names are dropped (not
   * committed), so they are never reinstalled on a later call or after a
   * restart. Resolves to the packages now known to be available. Throws when
   * one or more requested packages could not be installed — but any packages
   * that DID install remain committed (partial success is preserved).
   */
  async syncEnvironment(): Promise<string[]> {
    const requested = [...this.pending];
    this.pending.clear();
    // Install only names not already known to be installed.
    const toInstall = [...new Set(requested)].filter((p) => p && !this.deps.has(p));
    if (toInstall.length) {
      const { installed, failed } = await this.install(toInstall);
      for (const p of installed) this.deps.add(p); // commit successes only
      if (failed.length) {
        throw new Error(installFailureMessage(failed, installed));
      }
    }
    return [...this.deps];
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
    return buildNotebookFromSlots(this.slots, this.notebookMeta());
  }

  /**
   * Ordered code cells of the live document: restored file cells first (still
   * marked `restored`) followed by the cells run in this session. The agent
   * uses this after resuming a notebook to decide which cells to re-run.
   */
  listCells(): DocumentCell[] {
    const out: DocumentCell[] = [];
    for (const s of this.slots) {
      if (s.kind !== "code") continue;
      out.push({
        cellId: s.cellId,
        source: s.source,
        executionCount: s.result.executionCount,
        restored: s.restored,
      });
    }
    return out;
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

  /**
   * Detach WITHOUT killing the server-side kernel/session: flush the snapshot,
   * then drop THIS client's kernel/server connections. The kernel keeps running
   * on the server so a later conversation (or a browser tab) can re-attach to
   * the same contents path — used on conversation end when `keepKernels` is on.
   */
  async detach(): Promise<void> {
    await this.flushAutoSave(SHUTDOWN_FLUSH_TIMEOUT_MS);
    this.disposeKernel();
    try { this.server.dispose(); } catch { /* ignore */ }
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
   * Fetch the kernelspec for `kernelName` (the agent-chosen kernel), validating
   * it exists (UX-7). Returns null when the server cannot list specs — we then
   * degrade to the old behavior and let `startKernel` fail on its own.
   */
  private async resolveKernelSpec(): Promise<KernelSpecInfo | null> {
    let list: KernelSpecList;
    try {
      list = await this.server.listKernelSpecs();
    } catch {
      return null;
    }
    const spec = list.specs.find((s) => s.name === this.kernelName);
    if (!spec) throw new Error(formatKernelSpecMismatch(this.kernelName, list));
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

  /**
   * Install packages and report which ones actually installed. A partial
   * failure does NOT throw — the caller commits `installed` and handles
   * `failed` (issue "poisoned deps set", Option 1). Only a whole-batch failure
   * (nothing installed) throws, so a lone bad name can never block the
   * loadable packages beside it.
   */
  private async install(packages: string[]): Promise<{ installed: string[]; failed: string[] }> {
    // Serialize with running cells on the same kernel (BUG-7).
    return this.withKernelLock(() => this.runInstall(packages));
  }

  private async runInstall(packages: string[]): Promise<{ installed: string[]; failed: string[] }> {
    if (packages.length === 0) return { installed: [], failed: [] };
    const kernel = this.requireKernel();
    const code = buildInstallCode(packages, this.language);
    if (!code) return { installed: [], failed: [] };
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
    const stdout = outcome.outputs
      .filter((o: JsOutput) => o.outputType === "stream" && o.text)
      .map((o: JsOutput) => o.text!)
      .join("\n");
    const report = parseInstallOutput(stdout);
    const installed = reconcileInstalled(packages, report, outcome.status);
    const installedSet = new Set(installed.map(basePackageName));
    const failed = packages.filter((p) => !installedSet.has(basePackageName(p)));
    // `%pip` / install.packages failures must still surface (BUG-1) — but only
    // when NOTHING installed. A partial failure resolves with `failed` set so
    // the caller keeps the loadable packages (issue "poisoned deps set").
    if (installed.length === 0) {
      throw new Error(installFailureMessage(failed, installed, outcome, report));
    }
    return { installed, failed };
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

  /**
   * Notebook header metadata: the live kernelspec when known (BUG-2); for an
   * ATTACHED session we do not fetch a spec, so the kernelspec recorded in the
   * adopted file is the most faithful header.
   */
  private notebookMeta(): NotebookMeta {
    const spec = this.kernelSpec;
    if (spec) {
      return {
        kernelName: spec.name,
        displayName: spec.displayName,
        language: spec.language.toLowerCase(),
      };
    }
    if (this.adoptedMeta) return this.adoptedMeta;
    return {
      kernelName: this.kernelName || "python3",
      displayName: this.kernelName || "Python 3",
      language: this.kernelName?.toLowerCase() === "ir" ? "r" : "python",
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
    // An explicitly requested contents path (notebook adoption / creation)
    // wins over the config override — resuming `notes/pi.ipynb` must keep
    // snapshotting exactly that file even when remoteSavePath is set.
    if (this.opts.contentsPath) return normalizeContentsPath(this.opts.contentsPath);
    const fallback = `${this.notebookId}.ipynb`;
    const raw = this.config.remoteSavePath;
    if (!raw) return fallback;
    // Contents paths are relative to root_dir — drop any leading slashes.
    const relative = raw.replace(/^\/+/g, "");
    if (relative.split("/").some((segment) => segment === "..")) {
      // bootstrap() resets this.warnings, so keep the warning for re-append.
      this.effectivePathWarning =
        `remoteSavePath "${raw}" contains a ".." segment — path traversal is ` +
        `not allowed; falling back to ${fallback}`;
      return fallback;
    }
    return relative;
  }

  /** Same chain as computeEffectivePath, unvalidated — display before init. */
  private contentsPathFallback(): string {
    if (this.opts.contentsPath) return this.opts.contentsPath;
    return this.config.remoteSavePath ?? `${this.notebookId}.ipynb`;
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
    if (this.executedCells > 0) {
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
    this.kernel = await this.server.startKernel(this.kernelName, {
      sessionPath: this.effectivePath ?? `${this.notebookId}.ipynb`,
      sessionName: this.notebookId,
    });
    await this.kernel.waitConnected();
    await this.bootstrap();
    if (this.effectivePathWarning) this.warnings.push(this.effectivePathWarning);
    if (this.deps.size > 0) {
      try {
        // Reinstall the desired set; drop any name that no longer installs so
        // the set stays installable (issue "poisoned deps set").
        //
        // Call runInstall DIRECTLY, not install(): restartKernel runs inside
        // executeCell, which already holds the FIFO kernel lock. install() would
        // re-enter withKernelLock and deadlock — runInstall would queue behind a
        // chain that is itself waiting on this very execution to finish.
        const { failed } = await this.runInstall([...this.deps]);
        for (const p of failed) this.deps.delete(p);
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
 * Normalize a user-supplied remote contents path: relative to the contents
 * root (leading slashes dropped), no `..` segments, non-empty. Throws on an
 * invalid path — resuming an explicit notebook path must never silently fall
 * back the way a mis-configured `remoteSavePath` does.
 */
export function normalizeContentsPath(path: string): string {
  const raw = path.trim();
  if (!raw) throw new Error("[pi-jupyter] a notebook contents path is required");
  const relative = raw.replace(/^\/+/g, "");
  if (!relative) throw new Error(`[pi-jupyter] invalid notebook path "${raw}"`);
  if (relative.split("/").some((segment) => segment === "..")) {
    throw new Error(`[pi-jupyter] notebook path "${raw}" contains a ".." segment — not allowed`);
  }
  return relative;
}

/** Human-friendly session id for a contents path: `notes/pi.ipynb` → `pi`. */
function notebookIdFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const file = basename(path.replace(/\\/g, "/"));
  const name = file.replace(/\.ipynb$/i, "");
  return name && name !== "." ? name : undefined;
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

/**
 * Map a requested spec back to whether it installed. When the per-package
 * markers are present we trust the kernel's requireNamespace verdict and match
 * by base name (a pip spec like `numpy>=2` installs as `numpy`). Without
 * markers we fall back to the legacy whole-batch view: success only when the
 * execution was ok.
 */
function reconcileInstalled(
  packages: string[],
  report: InstallOutputReport,
  status: string,
): string[] {
  if (report.hasMarkers) {
    const ok = new Set(report.ok);
    return packages.filter((p) => ok.has(basePackageName(p)));
  }
  return status === "ok" ? [...packages] : [];
}

/** Base package name from a spec: `numpy>=2` → `numpy`, `dplyr` → `dplyr`. */
function basePackageName(spec: string): string {
  return spec.split(/[<>=!~\[]/)[0].trim();
}

/**
 * Build the install-failure error. Names the packages that could not be
 * installed and, when available, the trimmed kernel detail. Notes any partial
 * success so the message is not mistaken for a total failure (BUG-1 surface).
 */
function installFailureMessage(
  failed: string[],
  installed: string[],
  outcome?: ExecuteOutcome,
  report?: InstallOutputReport,
): string {
  const names = failed.length ? failed.join(", ") : "the requested packages";
  let detail = "";
  if (outcome) {
    const errorOutputs = outcome.outputs.filter((o) => o.outputType === "error");
    const errorText = errorOutputs
      .map((o) => [`${o.ename ?? "Error"}: ${o.evalue ?? ""}`, ...(o.traceback ?? [])].join("\n"))
      .join("\n");
    const stderrText = outcome.outputs
      .filter((o) => o.outputType === "stream" && o.name === "stderr" && o.text)
      .map((o) => o.text)
      .join("");
    const raw = stripAnsi((errorText || stderrText).trim());
    detail = raw.length > 1200 ? `${raw.slice(0, 1200)}…` : raw;
  }
  // R per-package failures are caught in-kernel (tryCatch), so the execution
  // can be status "ok" with no error output — fall back to the marker verdict.
  if (!detail && report && report.failed.length) {
    detail = `not installable / not loadable: ${report.failed.join(", ")}`;
  }
  const partial = installed.length
    ? ` (these installed and were kept: ${installed.join(", ")})`
    : "";
  return (
    `[pi-jupyter] failed to install ${names}${partial}` +
    (detail ? `:\n${detail}` : "")
  );
}
