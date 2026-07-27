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
import { buildNotebook, type CellRecord } from "./domain/notebook";
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
import type { KernelPort, ServerPort } from "./kernel/port";

export class RemoteSession implements Session {
  readonly notebookId: string;

  private kernel: KernelPort | null = null;
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

  /** Connect to the server, start a kernel, bootstrap, and pre-install deps. */
  async initialize(): Promise<void> {
    await this.server.ping();
    this.kernel = await this.server.startKernel(this.config.kernelName);
    await this.kernel.waitConnected();

    // Idempotent bootstrap: matplotlib inline + missing-package warnings.
    await this.kernel.execute(BOOTSTRAP_CODE, { timeoutMs: 30_000, silent: true });
    this.warnings = await this.probeMissingPackages();

    if (this.deps.size > 0) await this.install([...this.deps]);
  }

  // ── core: execute code ────────────────────────────────────────────────────

  async runCell(source: string, opts: RunCellOpts = {}): Promise<CellResult> {
    const kernel = this.requireKernel();
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

  async saveNotebook(path?: string): Promise<void> {
    const savePath = path ?? `${this.notebookId}.ipynb`;
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, JSON.stringify(buildNotebook(this.cells), null, 1));
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    try {
      if (this.kernel && !this.kernel.isDisposed) await this.kernel.shutdown();
    } finally {
      this.disposeKernel();
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

  private async install(packages: string[]): Promise<void> {
    const kernel = this.requireKernel();
    const code = buildInstallCode(packages);
    if (!code) return;
    await kernel.execute(code, { timeoutMs: this.config.installTimeoutMs });
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

  private disposeKernel(): void {
    this.kernel?.dispose();
    this.kernel = null;
  }
}
