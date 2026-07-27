/**
 * pi-jupyter — public API.
 *
 * Layered architecture (see ARCHITECTURE.md):
 *
 *   domain/   pure logic, zero external deps   (types, output, notebook, deps, bootstrap, subject)
 *   kernel/   @jupyterlab/services adapters    (port, convert, kernel, server)
 *   config    env > file > default
 *   session   Session impl behind KernelPort
 */

// ── domain (pure) ───────────────────────────────────────────────────────────
export {
  type CellResult,
  type CellStatus,
  type CreateSessionOpts,
  type JsOutput,
  type MimeEntry,
  type NormalizedMimebundle,
  type ObservableLike,
  type RunCellOpts,
  type RuntimeStatus,
  type Session,
  TimeoutError,
} from "./domain/types";
export { dedupeImages, denormalizeMimebundle, isRasterImage, normalizeMimebundle } from "./domain/output";
export { buildNotebook, splitLines, type CellRecord } from "./domain/notebook";
export { buildInstallCode } from "./domain/deps";
export { BOOTSTRAP_CODE, MISSING_PACKAGES_PROBE, parseMissingPackages } from "./domain/bootstrap";
export { Subject } from "./domain/subject";

// ── kernel (adapters) ───────────────────────────────────────────────────────
export type { ExecuteOptions, ExecuteOutcome, KernelPort, ServerPort } from "./kernel/port";
export { JupyterKernel } from "./kernel/kernel";
export { JupyterServer } from "./kernel/server";
export { fromIOPub } from "./kernel/convert";

// ── config + session ────────────────────────────────────────────────────────
export { isConfigured, loadConfig, type ShimConfig } from "./config";
export { RemoteSession } from "./session";
