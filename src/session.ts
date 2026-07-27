/**
 * RemoteSession — the Session contract, implemented against the KernelPort seam.
 *
 * Owns the kernel lifecycle, cell history (for .ipynb export), the dependency
 * set, and the executionViewChanges$ subject.  All execution goes through
 * `KernelPort.execute()` — this class never imports `@jupyterlab/services`,
 * which is what makes it unit-testable with a mock port.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ShimConfig } from "./config";
import { BOOTSTRAP_CODE, MISSING_PACKAGES_PROBE, parseMissingPackages } from "./domain/bootstrap";
import { buildInstallCode } from "./domain/deps";
import { buildNotebook, type CellRecord, type NotebookMeta } from "./domain/notebook";
import { stripAnsi } from "./domain/output";
import { Subject } from "./domain/subject";
import {
  type CellResult,
  type CreateSessionOpts,
  type JsOutput,
  type RuntimeStatus,
  type RunCellOpts,
  type Session,
  TimeoutError,
} from "./domain/types";
import type {
  ExecuteOutcome,
  KernelPort,
  KernelSpecInfo,
  KernelSpecList,
  ServerPort,
} from "./kernel/port";

export class RemoteSession implements Session {
  readonly notebookId: string;

  private kernel: KernelPort | null = null;
  private kernelSpec: KernelSpecInfo | null = null;
  private execCount = 0;
  private cells: CellRecord[] = [];
  private deps = new Set<string>();
  private warnings: string[] = [];
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
    this.kernel = await this.server.startKernel(this.config.kernelName, {
      sessionPath: `${this.notebookId}.ipynb`,
      sessionName: this.notebookId,
    });
    await this.kernel.waitConnected();

    // Idempotent bootstrap + missing-package warnings (python-only, BUG-4).
    await this.bootstrap();

    if (this.deps.size > 0) await this.install([...this.deps]);
  }

  // ── core: execute code ────────────────────────────────────────────────────

  async runCell(source: string, opts: RunCellOpts = {}): Promise<CellResult> {
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
      // interrupts and never returned to idle (BUG-6).  Rather than silently
      // queueing behind leftover computation, recover or fail fast.
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
          ename: isTimeout ? "TimeoutError" : "ShimError",
          evalue: (err as Error).message,
          traceback: [(err as Error).stack ?? (err as Error).message],
        },
      ];
    }

    this.cells.push({ source, result: partial });
    this.viewChanges.next(partial);
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
   * Write the session to an `.ipynb`.  Returns the path actually written
   * (callers should pass an absolute path; BUG-3).  The notebook header
   * reflects the real kernelspec/language (BUG-2).
   */
  async saveNotebook(path?: string): Promise<string> {
    const savePath = path ?? `${this.notebookId}.ipynb`;
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(
      savePath,
      JSON.stringify(buildNotebook(this.cells, this.notebookMeta()), null, 1),
    );
    return savePath;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
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
    const kernel = this.requireKernel();
    const code = buildInstallCode(packages, this.language);
    if (!code) return;
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
      sessionPath: `${this.notebookId}.ipynb`,
      sessionName: this.notebookId,
    });
    await this.kernel.waitConnected();
    await this.bootstrap();
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
