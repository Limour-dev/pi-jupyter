/**
 * pi-jupyter extension — thin wiring over the domain + kernel layers.
 *
 * Architecture (see ARCHITECTURE.md):
 *
 *   extensions/schemas.ts   tool parameter schemas
 *   extensions/format.ts    CellResult → pi message content
 *   extensions/repl.ts      THIS FILE: register tools/commands, manage session lifecycle
 *   src/session.ts          RemoteSession (behind KernelPort)
 *   src/kernel/             @jupyterlab/services adapters
 *   src/domain/             pure logic
 * Notebook-first execution — how a NEW agent session should drive this
 * extension:
 *
 *   STAY IN ONE NOTEBOOK — drive it like a human at a REPL. Pick one notebook,
 *   open it ONCE, then keep calling `jupyter_repl(notebook=<same path>, …)` for
 *   every step; the kernel's variables/imports persist across those calls.
 *   Do NOT loop open → run → shutdown → open, and do NOT open a second path
 *   (or a fresh notebook) to "see" what a run produced: a closed kernel loses
 *   all live state and re-opening only replays the file. A SCRATCH run
 *   (persist=false, the default) is intentionally absent from the .ipynb, so
 *   the way to KEEP a cell is `persist=true` — not a restart. Likewise never
 *   write throwaway `.py`/`.R` (or other) source files and convert/import them
 *   as `.ipynb` just to execute; put the code straight into `jupyter_repl` on
 *   the notebook you already have open (or `jupyter_open_notebook` a real
 *   notebook first). Use `jupyter_outputs(path)` to re-read saved outputs.
 *
 *   - `jupyter_list_notebooks(dir=…)` first: it shows the notebooks that EXIST
 *     on the server in ONE remote contents directory (required `dir`; read from
 *     the contents API, so files pi never opened are visible) merged with LIVE
 *     /api/sessions rows and the ~/.pi-jupyter/notebooks.json registry — a
 *     registry entry whose file is gone is dropped as stale. Only direct
 *     children are listed unless `recursive=true` (add `query` to search by
 *     path). Pass "." for the server root.
 *   - No active session yet, or switching to another notebook → CONTINUE one
 *     with `jupyter_open_notebook` (a `path` from jupyter_list_notebooks, or a
 *     `local_file` to import). When the agent does not know which kernels the
 *     server offers, call `jupyter_list_kernels` first. Only then run code with
 *     `jupyter_repl`.
 *   - Restructure an open notebook's cells with `jupyter_edit_cell`
 *     (delete/replace/move/insert) — do NOT edit the `.ipynb` from an external
 *     script; pass `replay=skip` to `jupyter_open_notebook` to load a file without
 *     re-running it (issues 1-2 / 1-3).
 *   - Opening a notebook whose kernel was previously closed (no live kernel)
 *     starts a NEW kernel bound to the same path and re-runs the file's code
 *     cells FROM FIRST TO LAST, so the in-memory state is rebuilt before any
 *     jupyter_repl call. A LIVE kernel is ATTACHED instead (no new kernel, no
 *     re-run — variables/imports survive). With an active session, each
 *     jupyter_repl(notebook=…) REUSES that session. Runs are SCRATCH by
 *     default (`persist=false`): the output is returned but the document is not
 *     modified. Pass `persist=true` to record a cell; use jupyter_outputs(path)
 *     to read outputs already saved in a file.
 *   - There are NO anonymous per-kernel sessions anymore: jupyter_repl /
 *     jupyter_add_dependencies / jupyter_save_notebook all require a
 *     `notebook` path. Which kernel serves a notebook is fixed when it is
 *     opened — the live kernel, else the file's recorded kernelspec, else the
 *     agent's `kernel` param on jupyter_open_notebook, else the config
 *     fallback. The kernel is never chosen on a jupyter_repl call.
 *   - What each kernel is FOR is remembered across sessions in
 *     ~/.pi-jupyter/purposes.json (`jupyter_set_kernel_purpose`). Only a
 *     newly discovered kernel with no recorded purpose triggers a question to
 *     the user; recorded kernels are shown with their purpose and reused.

 * Config (env vars):
 *   JUPYTER_REMOTE_URL    e.g. http://192.168.105.1:57002   (user-set)
 *   JUPYTER_REMOTE_TOKEN  e.g. 123456                       (user-set)
 *   JUPYTER_KERNEL_NAME   OPTIONAL fallback default kernel (a kernelspec
 *                         *name*, e.g. "ir" — not the display name "R");
 *                         used only when a notebook records no kernel and
 *                         jupyter_open_notebook gets none either
 *   JUPYTER_WORKING_DIR   base dir for relative save_notebook paths
 *   JUPYTER_TIMEOUT_RESTART_KERNEL=1  auto-restart a kernel still busy after
 *                                     a timeout (state lost)
 *   JUPYTER_BIND_SESSION=0  disable binding the kernel to an /api/sessions
 *                           row (default on: kernel shows in Running UI)
 *   JUPYTER_KEEP_KERNELS=0  shut kernels down when the conversation/process
 *                           ends (legacy). Default on: kernels stay running on
 *                           the server so a new conversation can re-attach to
 *                           the same notebook path and keep its variables
 *   JUPYTER_REMOTE_AUTOSAVE=0  disable the automatic snapshot upload to the
 *                              remote server after each cell (default on;
 *                              the file lands in the remote $HOME so the same
 *                              kernel can be re-opened in a browser)
 *   JUPYTER_REMOTE_SAVE_PATH   legacy override only for sessions created
 *                              WITHOUT an explicit path (every session today
 *                              opens a named notebook, so it is rarely used)
 *   JUPYTER_ENABLE_ADD_DEPENDENCIES=1  load the jupyter_add_dependencies tool
 *                              (or config.json "enableAddDependencies": true).
 *                              OPT-IN, default OFF.
 *   JUPYTER_ENABLE_SAVE_NOTEBOOK=0     hide the jupyter_save_notebook tool
 *                              (or config.json "enableSaveNotebook": false).
 *                              Default ON (issue 1-5). When a gate is off the
 *                              tool is not registered at all.
 * After editing, run `/reload` in pi.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { CONFIG_HINT, isConfigured, loadConfig, loadToolGates } from "../src/config";
import type { CellResult, ContentsEntry, ResumeOutcome, Session } from "../src/domain/types";
import { mergeNotebookRows } from "../src/domain/listing";
import { parseNotebook } from "../src/domain/notebook";
import { JupyterServer } from "../src/kernel/server";
import { loadNotebooks, touchNotebook } from "../src/notebooks";
import { normalizeContentsPath, RemoteSession } from "../src/session";
import { capOutputContent, formatResult, stripAnsi } from "./format";
import { loadPurposes, savePurposes } from "../src/purposes";
import {
  ADD_DEPENDENCIES_PARAMS,
  EDIT_CELL_PARAMS,
  JUPYTER_PARAMS,
  LIST_KERNELS_PARAMS,
  LIST_NOTEBOOKS_PARAMS,
  OPEN_NOTEBOOK_PARAMS,
  OUTPUTS_PARAMS,
  SAVE_NOTEBOOK_PARAMS,
  SET_KERNEL_PURPOSE_PARAMS,
  SHUTDOWN_NOTEBOOK_PARAMS,
  type AddDependenciesParams,
  type EditCellParams,
  type JupyterParams,
  type ListNotebooksParams,
  type OpenNotebookParams,
  type OutputsParams,
  type SaveNotebookParams,
  type SetKernelPurposeParams,
  type ShutdownNotebookParams,
} from "./schemas";

// ── spinner ─────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

type InCallState = {
  spinner?: { frame: number; timer: ReturnType<typeof setInterval> };
};

// ── path helpers ────────────────────────────────────────────────────────────

function resolvePath(userPath: string, workingDir = process.cwd()): string {
  const expanded = expandHome(userPath);
  return isAbsolute(expanded) ? expanded : join(workingDir, expanded);
}

function expandHome(userPath: string): string {
  if (userPath === "~") return homedir();
  if (userPath.startsWith("~/") || userPath.startsWith("~\\")) {
    return join(homedir(), userPath.slice(2));
  }
  return userPath;
}

/** First non-empty line of a cell's source, trimmed — context for a failure. */
function sourcePreview(source: string, max = 120): string {
  const line = source.split("\n").find((l) => l.trim()) ?? source;
  const text = line.trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Concatenated textual view of a cell's outputs (streams + error traceback +
 * `text/plain`), ANSI-stripped. Images are left out on purpose — the replay
 * summary is text; inline images come from `jupyter_repl` / `jupyter_outputs`.
 */
function outputText(result: CellResult): string {
  const chunks: string[] = [];
  for (const output of result.outputs ?? []) {
    if (output.outputType === "stream" && output.text) {
      chunks.push(output.name === "stderr" ? `[stderr] ${output.text}` : output.text);
    } else if (output.outputType === "error") {
      const traceback = Array.isArray(output.traceback) ? output.traceback.join("\n") : "";
      chunks.push(traceback || `${output.ename ?? "Error"}: ${output.evalue ?? ""}`);
    } else if (output.dataJson) {
      try {
        const data = JSON.parse(output.dataJson) as Record<string, { value?: unknown }>;
        const text = data["text/plain"]?.value;
        if (typeof text === "string" && text.trim() && !/^<Figure[^>]*>/.test(text.trim())) {
          chunks.push(text);
        }
      } catch {
        /* a malformed bundle is not worth failing a replay over */
      }
    }
  }
  return stripAnsi(chunks.join(""));
}

/** Last few lines of a text block (prefixed when lines were dropped), for a compact summary. */
function outputTail(text: string, maxLines = 20, maxChars = 2500): string {
  const trimmed = text.replace(/\n+$/, "");
  if (!trimmed) return "";
  const lines = trimmed.split("\n");
  const kept = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  let out = kept.join("\n");
  if (lines.length > maxLines) out = `…(${lines.length - maxLines} earlier line(s) omitted)\n${out}`;
  if (out.length > maxChars) out = `…${out.slice(-maxChars)}`;
  return out;
}

/** One cell's replay outcome (see `replayFromStart`). */
type ReplayCellReport = {
  index: number;
  cellId: string;
  status: string;
  success: boolean;
  /** First line of the cell's source, for context. */
  source: string;
  /** Tail of the cell's textual output ("" when it produced none). */
  output: string;
  /** Failed cells only: the error message. */
  error?: string;
  /** Failed cells only: index of the first failure in the same contiguous run. */
  upstream?: number;
  /**
   * Failed cells only: the FILE already recorded this cell as an error before
   * the replay, so the failure is the notebook's pre-existing debt rather than
   * something this open produced (issue 1-3).
   */
  preExisting?: boolean;
};


// ── extension ───────────────────────────────────────────────────────────────

export default function piJupyterExtension(pi: ExtensionAPI) {
  if (!isConfigured()) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(CONFIG_HINT, "warning");
    });
    // Register every tool even when unconfigured, so the tool list is stable
    // before/after configuration; each stub fails with the same hint (UX-8).
    // Gated tools: jupyter_add_dependencies is OPT-IN (default OFF),
    // jupyter_save_notebook defaults ON (issue 1-5) — a disabled gate means the
    // tool is not registered here either.
    const gates = loadToolGates();
    pi.registerTool({
      name: "jupyter_list_kernels",
      label: "List Kernels",
      description:
        "List the kernels available on the remote Jupyter Server. Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
      parameters: LIST_KERNELS_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });

    pi.registerTool({
      name: "jupyter_list_notebooks",
      label: "List Notebooks",
      description:
        'List the notebooks in ONE remote contents directory (`dir`, required — direct children only, never recursing into subdirectories; pass "." for the server root) available to continue on the remote Jupyter Server. Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.',
      parameters: LIST_NOTEBOOKS_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });

    pi.registerTool({
      name: "jupyter_open_notebook",
      label: "Open / Continue Notebook",
      description:
        "Continue an existing notebook (attach to its live kernel or resume its file). Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
      parameters: OPEN_NOTEBOOK_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });

    pi.registerTool({
      name: "jupyter_outputs",
      label: "Show Saved Notebook Outputs",
      description:
        "Read the outputs a notebook FILE already records (read-only). Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
      parameters: OUTPUTS_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });
    pi.registerTool({
      name: "jupyter_edit_cell",
      label: "Edit Notebook Cell",
      description:
        "Edit an open notebook's cells (delete/replace/move/insert). Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
      parameters: EDIT_CELL_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });

    pi.registerTool({
      name: "jupyter_shutdown_notebook",
      label: "Shut Down Notebook Kernel",
      description:
        "Shut down one notebook's kernel (the .ipynb file stays). Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
      parameters: SHUTDOWN_NOTEBOOK_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });
    pi.registerTool({
      name: "jupyter_set_kernel_purpose",
      label: "Record Kernel Purpose",
      description:
        "Record what a kernel (kernelspec name) is for, as explained by the user — persisted across sessions. Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
      parameters: SET_KERNEL_PURPOSE_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });

    pi.registerTool({
      name: "jupyter_repl",
      label: "Jupyter REPL",
      description:
        "Execute code in a persistent REPL on a remote Jupyter Server. Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
      promptSnippet:
        "jupyter_repl: run code on a remote Jupyter notebook kernel (not configured: set JUPYTER_REMOTE_URL / JUPYTER_REMOTE_TOKEN).",
      parameters: JUPYTER_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });
    if (gates.enableAddDependencies) {
      pi.registerTool({
        name: "jupyter_add_dependencies",
        label: "Add Dependencies",
        description:
          "Install packages into the remote kernel's environment. Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
        parameters: ADD_DEPENDENCIES_PARAMS,
        async execute() {
          throw new Error(CONFIG_HINT);
        },
      });
    }
    if (gates.enableSaveNotebook) {
      pi.registerTool({
        name: "jupyter_save_notebook",
        label: "Save Notebook",
        description:
          "Save the current session as an .ipynb file. Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
        parameters: SAVE_NOTEBOOK_PARAMS,
        async execute() {
          throw new Error(CONFIG_HINT);
        },
      });
    }
    return;
  }

  const config = loadConfig();

  // ── session lifecycle (lazy, concurrent-safe) ─────────────────────────────
  // v3: notebook-only sessions. EVERY session is keyed by its remote contents
  // path — the same string is the /api/sessions bind row and the auto-save
  // target — so a LATER conversation (or a browser) can resume exactly that
  // file: attaching to the still-running kernel when there is one (no restart,
  // variables kept), else starting a fresh kernel bound to the same path and
  // re-running its cells first → last to restore state. Anonymous per-kernel
  // sessions are gone: jupyter_repl / jupyter_add_dependencies /
  // jupyter_save_notebook all require `notebook`, so no code ever runs on a
  // kernel that is not bound to a notebook path.
  const sessionsByPath = new Map<string, Session>();
  const openings = new Map<string, Promise<Session>>();
  /** Per-kernel display counter for the In[n] / Out[n] call rendering. */
  const execCounts = new Map<string, number | null>();

  async function addDepsAndSync(sess: Session, packages: string[]): Promise<void> {
    const unique = [...new Set(packages.map((p) => p.trim()).filter(Boolean))];
    if (!unique.length) return;
    await sess.addDependencies(unique);
    // syncEnvironment installs only the not-yet-committed packages, commits
    // just the ones that installed to the persistent desired set, and throws
    // if any requested package failed (keeping partial successes). A failed
    // name therefore never persists to poison a later call — that throw is
    // surfaced verbatim by the jupyter_add_dependencies tool (issue "poisoned
    // deps set").
    await sess.syncEnvironment();
  }

  /** Record the session's path in ~/.pi-jupyter/notebooks.json (best-effort). */
  function rememberNotebook(sess: Session, source: "remote" | "local", localFile?: string): void {
    try {
      touchNotebook(sess.contentsPath, {
        kernelName: sess.kernelName || "python3",
        source,
        ...(localFile ? { localFile } : {}),
      });
    } catch {
      /* a registry write must never break a run */
    }
  }

  /**
   * Re-run every code cell of an open notebook document, IN ORDER (first →
   * last), to rebuild the kernel's in-memory state after a fresh start (the
   * "previously closed session" case — new kernel bound to the file).
   * runCell matches same-source cells IN PLACE, so each cell keeps its id and
   * document position — nothing is duplicated. A failing cell does not stop the
   * replay: the rest still run, and the caller sees exactly which cells failed.
   */
  async function replayFromStart(sess: Session): Promise<{
    replayed: number;
    failed: ReplayCellReport[];
    cells: ReplayCellReport[];
  }> {
    const cells = sess.listCells();
    const reports: ReplayCellReport[] = [];
    let lastCount: number | null | undefined;
    // Index of the FIRST failure in the current contiguous failing run. A cell
    // that fails right after another failure is reported as a downstream
    // cascade of it (the "one missing preamble → seven errors" case) instead of
    // an independent bug; a successful cell ends the run, so a later failure
    // stands on its own.
    let runRoot: number | null = null;
    for (let i = 0; i < cells.length; i++) {
      const res = await sess.runCell(cells[i].source);
      lastCount = res.executionCount ?? lastCount;
      const err = res.outputs?.find((o) => o.outputType === "error");
      const report: ReplayCellReport = {
        index: i,
        cellId: res.cellId,
        status: res.status,
        success: res.success,
        source: sourcePreview(cells[i].source),
        output: outputTail(outputText(res)),
        ...(res.success
          ? {}
          : {
              error: err?.evalue ?? err?.ename ?? res.status,
              // A cell the FILE already recorded as an error is old debt, not a
              // regression this replay introduced (issue 1-3).
              ...(cells[i].fileError ? { preExisting: true } : {}),
            }),
      };
      if (res.success) {
        runRoot = null;
      } else if (runRoot !== null) {
        report.upstream = runRoot;
      } else {
        runRoot = i;
      }
      reports.push(report);
    }
    if (lastCount != null) execCounts.set(sess.kernelName, lastCount + 1);
    return { replayed: cells.length, failed: reports.filter((r) => !r.success), cells: reports };
  }

  /** Kernel currently serving an OPEN notebook path (drives the In[n] counter). */
  function kernelForNotebook(notebook: string | undefined): string | undefined {
    if (!notebook?.trim()) return undefined;
    let path: string;
    try {
      path = normalizeContentsPath(notebook);
    } catch {
      return undefined;
    }
    return sessionsByPath.get(path)?.kernelName;
  }

  /**
   * Resolve the session for a notebook contents path, OPENING it when needed:
   *
   *   - already open this conversation → reuse;
   *   - else create a RemoteSession bound to the path and `resume()` it —
   *     attaching to a LIVE kernel when one is running there, otherwise
   *     starting a new kernel bound to the SAME path (seeded from the file).
   *
   * Returns `{ session, opened, outcome }`: `outcome` carries the resume
   * details (mode attached/started, prior code cells) only on the first open.
   */
  async function ensureNotebookSession(opts: {
    path: string;
    kernel?: string;
    cwd?: string;
    source?: "remote" | "local";
    localFile?: string;
  }): Promise<{ session: Session; opened: boolean; outcome: ResumeOutcome | undefined }> {
    const path = normalizeContentsPath(opts.path); // "/a.ipynb" and "a.ipynb" are the SAME file
    const existing = sessionsByPath.get(path);
    if (existing) {
      return { session: existing, opened: false, outcome: undefined };
    }
    let opening = openings.get(`path:${path}`);
    if (!opening) {
      opening = (async () => {
        const server = new JupyterServer(config);
        try {
          const sess = new RemoteSession(server, config, {
            // Pass the agent's explicit kernel ONLY — resume() derives the rest
            // from the live session or the file's recorded kernelspec.
            kernelName: opts.kernel?.trim() || undefined,
            contentsPath: path,
            runtime: "jupyter",
            workingDir: opts.cwd ?? config.workingDir,
            peerLabel: "pi",
            description: `pi remote Jupyter notebook ${path}`,
          });
          await sess.resume(path);
          sessionsByPath.set(path, sess);
          execCounts.set(sess.kernelName, execCounts.get(sess.kernelName) ?? null);
          return sess;
        } catch (err) {
          try { server.dispose(); } catch { /* ignore */ }
          throw err;
        }
      })();
      openings.set(`path:${path}`, opening);
    }
    try {
      const session = await opening;
      rememberNotebook(session, opts.source ?? "remote", opts.localFile);
      return { session, opened: true, outcome: session.resumeOutcome };
    } finally {
      openings.delete(`path:${path}`);
    }
  }

  /** Human + structured description of the kernels the agent can pick. */
  async function describeKernels(): Promise<{ text: string; details: Record<string, unknown> }> {
    const server = new JupyterServer(config);
    try {
      const { default: def, specs } = await server.listKernelSpecs();
      // Merge the persisted purpose notes (~/.pi-jupyter/purposes.json).
      const purposes = loadPurposes();
      const noPurpose: string[] = [];
      const lines: string[] = [
        "Available kernels on the configured Jupyter Server:",
        "  Pass one of these names as `kernel` to jupyter_open_notebook when the notebook has no live kernel and its file records none.",
        "",
      ];
      for (const s of specs) {
        const marks: string[] = [];
        if (s.name === def) marks.push("server default");
        if (config.kernelName && s.name === config.kernelName) marks.push("config fallback");
        if ([...sessionsByPath.values()].some((se) => se.kernelName === s.name)) {
          marks.push("session open (state persists)");
        }
        const purpose = purposes[s.name];
        const note = purpose
          ? `  purpose: ${purpose} (recorded)`
          : "  purpose: not recorded — ask the user, then record it with jupyter_set_kernel_purpose";
        if (!purpose) noPurpose.push(s.name);
        lines.push(
          `  - ${s.name}  (${s.displayName}, ${s.language})${marks.length ? `  [${marks.join(", ")}]` : ""}`,
        );
        lines.push(note);
      }
      lines.push(
        "",
        "Use the kernel whose recorded purpose matches the task. Only a kernel marked",
        "'purpose: not recorded' is NEW — ask the user what it is for, then record it",
        "with `jupyter_set_kernel_purpose` so every future session remembers. Names are",
        "kernelspec *names*, not display names (\"ir\", not \"R\").",
      );
      return {
        text: lines.join("\n"),
        details: {
          default_kernel: def || "",
          kernels: specs.map((s) => s.name),
          purposes,
          kernels_without_purpose: noPurpose,
          open_notebooks: [...sessionsByPath.keys()],
        },
      };
    } finally {
      try { server.dispose(); } catch { /* ignore */ }
    }
  }

  /**
   * Human + structured view of the notebooks the agent can CONTINUE in one
   * remote contents directory. The SERVER's contents listing (what actually
   * exists) is merged with live /api/sessions rows and pi's opened-notebooks
   * registry; a registry entry with no file and no kernel is a ghost and is
   * dropped (see domain/listing.ts). `recursive`/`query` let the agent search a
   * tree in one call instead of paging folder by folder.
   */
  async function describeNotebooks(
    dir: string,
    opts: { recursive?: boolean; query?: string } = {},
  ): Promise<{ text: string; details: Record<string, unknown> }> {
    const recursive = opts.recursive ?? false;
    const query = opts.query?.trim() || undefined;
    const server = new JupyterServer(config);
    const purposes = loadPurposes();
    let serverNotebooks: ContentsEntry[] = [];
    let serverListed = false;
    let listError: string | undefined;
    let liveRows: Array<{ path: string; kernelName: string }> = [];
    try {
      const listing = await server.listDirectory(dir, { recursive });
      serverNotebooks = listing.entries.filter((e) => e.type === "notebook");
      serverListed = listing.exists;
    } catch (err) {
      listError = (err as Error).message;
    }
    try {
      liveRows = (await server.listSessions())
        .filter((s) => s.type === "notebook" || s.path.endsWith(".ipynb"))
        .map((s) => ({ path: s.path, kernelName: s.kernelName }));
    } catch {
      liveRows = [];
    } finally {
      try { server.dispose(); } catch { /* ignore */ }
    }
    const store = loadNotebooks();
    const { rows, stale } = mergeNotebookRows({
      dir,
      recursive,
      ...(query ? { query } : {}),
      serverNotebooks,
      serverListed,
      liveSessions: liveRows,
      registry: store,
      openPaths: [...sessionsByPath.keys()],
    });
    const liveShown = liveRows.filter((r) => rows.some((row) => row.path === r.path));
    const scopeText = recursive
      ? `"${dir}" and its subdirectories`
      : `"${dir}" (direct children only)`;
    const extraTools =
      `jupyter_repl / jupyter_edit_cell${config.enableAddDependencies ? " / jupyter_add_dependencies" : ""}${config.enableSaveNotebook ? " / jupyter_save_notebook" : ""}`;
    const lines: string[] = [
      `Notebooks on the configured Jupyter Server in ${scopeText}${query ? ` matching "${query}"` : ""}:`,
      `  Read from the server's contents API (so files pi never opened are visible) and merged with live /api/sessions rows. Continue one with jupyter_open_notebook(path=…); then keep passing the same path as \`notebook\` to ${extraTools}.`,
      "",
    ];
    if (listError) {
      lines.push(
        `  ! could not read the server's contents listing (${listError}) — showing pi's registry only, existence NOT verified.`,
      );
    } else if (!serverListed) {
      lines.push(
        `  ! the directory "${dir}" does not exist on the server — showing pi's registry only, existence NOT verified.`,
      );
    }
    if (rows.length === 0) {
      if (query) {
        lines.push(`  (nothing in ${scopeText} matches "${query}" — drop or widen \`query\`)`);
      } else if (!recursive && (listError === undefined && serverListed)) {
        lines.push(
          `  (no notebook sits directly in "${dir}" — set recursive=true to also search subdirectories${dir === "." ? "" : ', or pass dir="."'})`,
        );
      } else {
        lines.push(
          `  (none — open a notebook with jupyter_open_notebook, or widen the scope${dir === "." ? "" : ' (dir=".")'})`,
        );
      }
    } else {
      for (const info of rows) {
        const marks: string[] = [];
        if (info.live) marks.push("LIVE — open attaches, variables kept");
        else marks.push("file only — open starts a fresh kernel that re-runs its cells (state restored)");
        if (info.open) marks.push("open in this conversation");
        if (info.source === "local" && info.localFile) marks.push(`imported from ${info.localFile}`);
        const purpose = purposes[info.kernel];
        lines.push(`  - ${info.path}  (kernel ${info.kernel})${purpose ? `  [purpose: ${purpose}]` : ""}`);
        lines.push(
          `      ${marks.join(" | ")}${info.updated ? ` | last used ${info.updated.slice(0, 10)}` : ""}`,
        );
      }
    }
    if (stale.length) {
      lines.push("");
      lines.push(
        `  (${stale.length} stale registry entr${stale.length === 1 ? "y" : "ies"} hidden — no such file on the server: ${stale.join(", ")})`,
      );
    }
    return {
      text: lines.join("\n"),
      details: {
        dir,
        recursive,
        ...(query ? { query } : {}),
        server_listed: serverListed,
        notebooks: rows,
        stale,
        live_paths: liveShown.map((r) => r.path),
      },
    };
  }

  // ── jupyter_list_notebooks ───────────────────────────────────────────────

  pi.registerTool<typeof LIST_NOTEBOOKS_PARAMS, Record<string, unknown>>({
    name: "jupyter_list_notebooks",
    label: "List Notebooks",
    description:
      'List the notebooks that exist on the remote Jupyter Server in the given remote contents `dir` (required; pass "." for the server root). The listing comes from the server\'s contents API — so notebooks pi has never opened are included — merged with live kernels and pi\'s registry; stale registry entries whose file is gone are dropped. By default only direct children of `dir` are shown; set recursive=true (optionally with query="…") to search subdirectories in one call. Each row says whether it has a LIVE kernel (jupyter_open_notebook attaches, variables kept) or is file-only (it starts a fresh kernel that re-runs the cells to restore state).',
    parameters: LIST_NOTEBOOKS_PARAMS,
    async execute(_toolCallId, params: ListNotebooksParams) {
      const dir = params.dir.trim();
      if (!dir) {
        throw new Error('[pi-jupyter] jupyter_list_notebooks needs a non-empty `dir` — a remote contents directory (e.g. "notes"); pass "." for the server root.');
      }
      const { text, details } = await describeNotebooks(dir, {
        recursive: params.recursive,
        query: params.query,
      });
      return { content: [{ type: "text", text }], details };
    },
  });

  // ── jupyter_list_kernels ──────────────────────────────────────────────────

  pi.registerTool<typeof LIST_KERNELS_PARAMS, Record<string, unknown>>({
    name: "jupyter_list_kernels",
    label: "List Kernels",
    description:
      "List the kernels available on the remote Jupyter Server (python3, ir, …) with each one's recorded purpose; kernels without one are flagged as new.",
    parameters: LIST_KERNELS_PARAMS,
    async execute() {
      const { text, details } = await describeKernels();
      return { content: [{ type: "text", text }], details };
    },
  });

  // ── jupyter_set_kernel_purpose ────────────────────────────────────────────

  pi.registerTool<typeof SET_KERNEL_PURPOSE_PARAMS, { kernel?: string; purpose?: string }>({
    name: "jupyter_set_kernel_purpose",
    label: "Record Kernel Purpose",
    description:
      "Record what a kernel (kernelspec *name*) is for, as the user explained — persisted across sessions so later jupyter_list_kernels output shows the purpose and the matching kernel can be picked without re-asking.",
    parameters: SET_KERNEL_PURPOSE_PARAMS,
    async execute(_toolCallId, params: SetKernelPurposeParams) {
      const kernel = params.kernel.trim();
      const purpose = params.purpose.trim();
      const purposes = loadPurposes();
      const overwrote = purposes[kernel] !== undefined;
      purposes[kernel] = purpose;
      savePurposes(purposes);
      return {
        content: [
          {
            type: "text",
            text: `Recorded purpose for kernel "${kernel}": ${purpose}${overwrote ? " (overwrote a previous note)" : ""}`,
          },
        ],
        details: { kernel, purpose, overwrote },
      };
    },
  });

  // ── jupyter_open_notebook ─────────────────────────────────────────────────

  pi.registerTool<typeof OPEN_NOTEBOOK_PARAMS, Record<string, unknown>>({
    name: "jupyter_open_notebook",
    label: "Open / Continue Notebook",
    description:
      "Open/continue a notebook session on the remote Jupyter Server. A LIVE kernel bound to the path is ATTACHED (no new kernel — variables kept); otherwise a NEW kernel is started on the same path and the file's code cells are re-run from first to last, restoring the state (a path with no file starts empty); pass replay=skip to only LOAD the document and execute nothing. Give `path` (a remote contents path, as listed by jupyter_list_notebooks) or `local_file` (import a local .ipynb). Pass `kernel` (a kernelspec name) when there is no live kernel and the file records none — otherwise the file's kernelspec, then the config fallback, apply. Open a notebook ONCE and stay in it: calling this again for a path already open in this conversation is a no-op. Never shut a notebook down just to re-open it or to make it 'pick up' your runs — a shutdown + open discards the live kernel state, and a scratch run is recorded only with jupyter_repl(persist=true).",
    parameters: OPEN_NOTEBOOK_PARAMS,
    promptGuidelines: [
      "Open a given notebook at most ONCE per conversation, then drive it entirely with jupyter_repl(notebook=<same path>, …). Do NOT shut a notebook down and re-open it to \"refresh\" it, to get a clean state, or to see your runs — a shutdown + open discards the live kernel state; pass persist=true to jupyter_repl to record a cell.",
      "Do NOT run code by writing a scratch .py/.R (or other) source file and converting/importing it as .ipynb, and do NOT create a new notebook per experiment. Check what exists with jupyter_list_notebooks, pick the one notebook that fits the task, and stay in it for the whole task.",
      'Pass replay="skip" to jupyter_open_notebook when you only need to READ the current file (cell list and saved outputs): it loads the document and executes nothing, so a heavy notebook is not re-run just to be inspected. A skipped replay leaves the new kernel with no state — rebuild only what you need with jupyter_repl(notebook=…, persist=true).',
    ],
    async execute(_toolCallId, params: OpenNotebookParams, _signal, _onUpdate, ctx) {
      const localRaw = params.local_file?.trim();
      const remoteRaw = params.path?.trim();
      if (!localRaw && !remoteRaw) {
        throw new Error("[pi-jupyter] jupyter_open_notebook needs a `path` (remote contents path) or a `local_file` (.ipynb to import).");
      }
      if (localRaw && remoteRaw) {
        throw new Error("[pi-jupyter] pass either `path` or `local_file`, not both.");
      }
      let openPath = remoteRaw;
      let source: "remote" | "local" = "remote";
      let localFile: string | undefined;
      const base = ctx?.cwd ?? process.cwd();
      if (localRaw) {
        localFile = resolvePath(localRaw, base);
        let model: Record<string, unknown>;
        try {
          model = JSON.parse(readFileSync(localFile, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          throw new Error(`[pi-jupyter] could not read local notebook ${localFile}: ${(err as Error).message}`);
        }
        if (!Array.isArray((model as { cells?: unknown }).cells)) {
          throw new Error(`[pi-jupyter] ${localFile} is not an .ipynb notebook (no cells array).`);
        }
        openPath = basename(localFile);
        source = "local";
        const probe = new JupyterServer(config);
        try {
          const live = await probe.findLiveSession(openPath);
          if (live) {
            throw new Error(
              `[pi-jupyter] a LIVE kernel is already bound to ${openPath} on the server. Importing ${localFile} over it would attach to a different notebook — open the live path directly, or shut it down first (jupyter_shutdown_notebook).`,
            );
          }
          await probe.uploadNotebook(openPath, model); // import: remote copy == the local file
        } finally {
          try { probe.dispose(); } catch { /* ignore */ }
        }
      }
      if (!openPath) throw new Error("[pi-jupyter] empty notebook path.");
      const { session, opened, outcome } = await ensureNotebookSession({
        path: openPath,
        kernel: params.kernel,
        cwd: base,
        source,
        localFile,
      });
      // A "started" open means the notebook's previous session was closed and a
      // NEW kernel was just bound to its file — replay the file's code cells
      // FROM FIRST TO LAST so the in-memory state is rebuilt here, before any
      // jupyter_repl call. An attach (live kernel) already has its state.
      // issue 1-3: replay="skip" loads the document only — the agent can inspect
      // a heavy notebook without paying for a full re-run.
      const replayMode = params.replay ?? "auto";
      const wouldReplay = opened && outcome?.mode === "started" && outcome.fileExisted;
      const replay =
        wouldReplay && replayMode !== "skip" ? await replayFromStart(session) : undefined;
      const cells = session.listCells();
      const lines: string[] = [];
      const modeText = opened && outcome ? outcome.mode : "open";
      if (modeText === "attached") {
        lines.push(`Attached to the LIVE kernel (${session.kernelName}) serving ${openPath} — variables and imports from the earlier session are intact.`);
        if (cells.length) lines.push(`${cells.length} code cell(s) loaded from the file for reference.`);
        lines.push("Keep working: no setup needs re-running.");
      } else if (modeText === "started") {
        lines.push(`Started a NEW ${session.kernelName} kernel bound to ${openPath} (a fresh kernel — in-memory variables were NOT preserved). Stay in this notebook: keep calling jupyter_repl(notebook="${openPath}", …); pass persist=true to record a cell (a scratch run is intentionally not saved). Do not shut it down and re-open to "see" a run.`);
        if (outcome?.fileExisted) {
          if (cells.length === 0) {
            lines.push("The file existed but holds no code cells — the document starts clean.");
          } else if (replayMode === "skip") {
            lines.push(
              `Replay SKIPPED (replay="skip"): the ${cells.length} file cell(s) were LOADED but NOT executed. The new kernel has NO in-memory state — re-run the cells you need with jupyter_repl(notebook="${openPath}", persist=true) before relying on their variables, and read the saved outputs with jupyter_outputs("${openPath}").`,
            );
          } else if (replay) {
            if (replay.failed.length === 0) {
              lines.push(`State restored: re-ran all ${replay.replayed} code cell(s) from first to last — every one succeeded.`);
            } else {
              const roots = replay.failed.filter((f) => f.upstream === undefined).length;
              const oldDebt = replay.failed.filter((f) => f.preExisting).length;
              lines.push(
                `State restore is PARTIAL: re-ran ${replay.replayed} code cell(s) from first to last; ${replay.failed.length} failed${roots < replay.failed.length ? ` (${roots} root cause(s), the rest downstream cascades)` : ""}.` +
                  (oldDebt
                    ? ` ${oldDebt} of them were ALREADY recorded as errors in the file — old debt, listed separately below, not caused by this open.`
                    : "") +
                  " The root causes and the cascades are listed at the end and in details.replay.",
              );
            }
          }
        } else {
          lines.push("No file existed at that path yet — the notebook starts empty and will be auto-saved there.");
        }
      } else {
        lines.push(`Notebook ${openPath} is already open in this conversation (kernel ${session.kernelName}). Keep working in it with jupyter_repl(notebook="${openPath}", …) — do NOT shut it down and re-open to refresh it.`);
      }
      lines.push("");
      if (cells.length) {
        const cellsNote =
          replayMode === "skip" && wouldReplay
            ? "loaded from the file, NOT executed because replay=skip"
            : "all executed above unless noted";
        lines.push(
          `Code cells (${cellsNote} — jupyter_repl(notebook="${openPath}", code=<source>) runs more):`,
        );
        cells.forEach((c, i) => {
          const one = c.source.replace(/\s+/g, " ").trim().slice(0, 140);
          lines.push(`  [${i}] (exec ${c.executionCount ?? "-"}${c.restored ? ", restored" : ", ran"}) ${one}`);
        });
      } else {
        lines.push("No code cells yet.");
      }
      if (replay) {
        const withOutput = replay.cells.filter((c) => c.output);
        if (withOutput.length) {
          lines.push("");
          lines.push(
            "Replayed outputs (tail of each cell's stdout/text — the file has the rest):",
          );
          for (const c of withOutput) {
            lines.push(`  [${c.index}] (${c.status})`);
            for (const l of c.output.split("\n")) lines.push(`      ${l}`);
          }
        }
      }
      const roots = replay?.failed.filter((f) => f.upstream === undefined) ?? [];
      const cascades = replay?.failed.filter((f) => f.upstream !== undefined) ?? [];
      // Split root causes into the FILE's pre-existing errors and failures this
      // replay produced, so a historical broken cell is not mistaken for a
      // problem the agent must fix now (issue 1-3).
      const oldDebt = roots.filter((f) => f.preExisting);
      const newRoots = roots.filter((f) => !f.preExisting);
      if (oldDebt.length) {
        lines.push("");
        lines.push(
          `Pre-existing failures (${oldDebt.length}) — the FILE already recorded these cells as errors before this open; they are the notebook's old debt, not something the replay caused:`,
        );
        for (const f of oldDebt) {
          lines.push(`  · [${f.index}] ${f.cellId} — ${f.status}: ${f.error}`);
        }
        lines.push(
          '  Fix or delete them with jupyter_edit_cell, then re-run their replacements with jupyter_repl(notebook=…, cell_id=…, persist=true); do NOT shut down and re-open to "refresh".',
        );
      }
      if (newRoots.length) {
        lines.push("");
        lines.push(
          `New failures (${newRoots.length} root cause${newRoots.length === 1 ? "" : "s"} from this replay):`,
        );
        for (const f of newRoots) {
          lines.push(`  ! [${f.index}] ${f.cellId} — ${f.status}: ${f.error}`);
          if (f.source) lines.push(`      > ${f.source}`);
          if (f.output) for (const l of f.output.split("\n")) lines.push(`      ${l}`);
        }
      }
      if (cascades.length) {
        lines.push(
          `  ~ ${cascades.length} more cell(s) failed immediately after a failure and are reported as DOWNSTREAM CASCADES of their run's first failure (` +
            cascades.map((f) => `[${f.index}]←[${f.upstream}]`).join(", ") +
            ") — fix the root cell(s) with jupyter_edit_cell, then re-run them with jupyter_repl(notebook=…, cell_id=…, persist=true); do NOT shut down and re-open.",
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          path: openPath,
          kernel: session.kernelName,
          notebook_id: session.notebookId,
          mode: modeText,
          cell_count: cells.length,
          cells,
          ...(replay ? { replay: { replayed: replay.replayed, failed: replay.failed, cells: replay.cells } } : {}),
        },
      };
    },
  });

  // ── jupyter_outputs ───────────────────────────────────────────────────────

  pi.registerTool<typeof OUTPUTS_PARAMS, Record<string, unknown>>({
    name: "jupyter_outputs",
    label: "Show Saved Notebook Outputs",
    description:
      "Read the outputs a notebook FILE already records — READ-ONLY: no kernel is started and no code runs. Use it when a replay/open summary is not enough (e.g. to re-read a table or a p-value already in the file), instead of parsing the .ipynb by hand. Optional `cell_id` narrows to one code cell; images are returned inline.",
    parameters: OUTPUTS_PARAMS,
    async execute(_toolCallId, params: OutputsParams) {
      const path = normalizeContentsPath(params.path);
      const server = new JupyterServer(config);
      let model: Record<string, unknown> | null;
      try {
        model = await server.readNotebook(path);
      } catch (err) {
        throw new Error(`[pi-jupyter] could not read ${path}: ${(err as Error).message}`);
      } finally {
        try { server.dispose(); } catch { /* ignore */ }
      }
      if (!model) {
        throw new Error(
          `[pi-jupyter] no notebook file at "${path}" (or it is not an nbformat notebook).`,
        );
      }
      const parsed = parseNotebook(model);
      const codeCells = parsed.slots.filter(
        (s): s is Extract<(typeof parsed.slots)[number], { kind: "code" }> => s.kind === "code",
      );
      const wanted = params.cell_id?.trim();
      const selected = wanted ? codeCells.filter((c) => c.cellId === wanted) : codeCells;
      if (wanted && selected.length === 0) {
        throw new Error(`[pi-jupyter] ${path} has no code cell with id "${wanted}".`);
      }
      const content: ReturnType<typeof formatResult>["content"] = [];
      const summaries: Array<Record<string, unknown>> = [];
      selected.forEach((cell, index) => {
        const { content: cellContent, isError } = formatResult(cell.result);
        const header =
          `[${index}] ${cell.cellId} (exec ${cell.result.executionCount ?? "-"})${isError ? " — ERROR" : ""}: ` +
          sourcePreview(cell.source);
        const [first, ...rest] = cellContent;
        if (first && first.type === "text") {
          // formatResult prefixes its own "cell <id> [n] status" header — drop it,
          // we just rendered a richer one.
          const body = first.text.replace(/^cell \S+ \[[^\]]*\] \S*\n?/, "");
          content.push({ type: "text", text: body ? `${header}\n${body}` : header });
          content.push(...rest);
        } else {
          content.push({ type: "text", text: header });
          content.push(...cellContent);
        }
        summaries.push({
          index,
          cell_id: cell.cellId,
          execution_count: cell.result.executionCount ?? null,
          is_error: isError,
          source: sourcePreview(cell.source, 200),
          output: outputTail(outputText(cell.result), 50, 4000),
        });
      });
      if (content.length === 0) {
        content.push({
          type: "text",
          text: `Notebook ${path} has no code cells${wanted ? ` matching id "${wanted}"` : ""}.`,
        });
      }
      return {
        content,
        details: { path, cell_count: codeCells.length, shown: selected.length, cells: summaries },
      };
    },
  });

  // ── jupyter_shutdown_notebook ─────────────────────────────────────────────

  pi.registerTool<typeof SHUTDOWN_NOTEBOOK_PARAMS, Record<string, unknown>>({
    name: "jupyter_shutdown_notebook",
    label: "Shut Down Notebook Kernel",
    description:
      "Shut down one notebook's kernel on the server — its .ipynb file stays, and a later jupyter_open_notebook resumes it with a fresh kernel. `path` may be a notebook open in this conversation or any LIVE kernel bound to that path on the server (left by an earlier conversation or a browser tab). Use /jupyter-reset to shut down everything. This is NOT a way to refresh a notebook or to make your runs appear: it destroys the live kernel's variables/imports. Keep the notebook open for the whole task and record cells with jupyter_repl(persist=true); shut down only when you are really done with it.",
    parameters: SHUTDOWN_NOTEBOOK_PARAMS,
    async execute(_toolCallId, params: ShutdownNotebookParams) {
      const path = normalizeContentsPath(params.path);
      // Drop the session from the open map once its kernel is gone, so cleanup
      // never runs twice.
      const removeSession = (sess: Session) => {
        for (const [p, s] of sessionsByPath) if (s === sess) sessionsByPath.delete(p);
        execCounts.delete(sess.kernelName);
      };
      // (1) Open in THIS conversation — a notebook session at the path.
      const local = sessionsByPath.get(path);
      if (local) {
        const kernel = local.kernelName;
        await local.shutdown();
        const status = await local.getRuntimeStatus().catch(() => undefined);
        removeSession(local);
        // issue 1-6: say plainly whether THIS shutdown wrote a snapshot back, so
        // the agent can tell "the remote file is current" from "nothing was
        // recorded / auto-save is off".
        const last = status?.lastAutoSave;
        const snapshot = last
          ? last.ok
            ? `Final snapshot written to the remote ${last.path} at ${last.at}.`
            : `Final snapshot upload FAILED (${last.error ?? "unknown error"}) — the remote file may be behind.`
          : "No snapshot was written (nothing was recorded or edited this session, or remote auto-save is off).";
        return {
          content: [
            {
              type: "text",
              text: `Kernel serving ${path} shut down (file kept; a future open resumes it with a fresh kernel). ${snapshot}`,
            },
          ],
          details: { path, kernel, target: "this-conversation", lastAutoSave: last ?? null },
        };
      }
      // (2) A LIVE kernel bound to `path` that this conversation never opened
      // — left by an earlier conversation (detach) or a browser tab. Kill it server-side.
      const probe = new JupyterServer(config);
      try {
        const live = await probe.findLiveSession(path);
        if (!live) {
          throw new Error(
            `[pi-jupyter] no kernel is currently running for ${path} — nothing to shut down. ` +
              "The file (if any) is kept; jupyter_open_notebook can resume it later with a fresh kernel.",
          );
        }
        await probe.shutdownSession(live);
        return {
          content: [{ type: "text", text: `Kernel serving ${path} shut down on the server (file kept; a future open resumes it with a fresh kernel).` }],
          details: { path, kernel: live.kernelName, target: "server" },
        };
      } finally {
        try { probe.dispose(); } catch { /* ignore */ }
      }
    },
  });
  // ── jupyter_repl ─────────────────────────────────────────────────────────

  pi.registerTool<typeof JUPYTER_PARAMS, unknown, InCallState>({
    name: "jupyter_repl",
    label: "Jupyter REPL",
    description:
      "Execute code in a notebook's persistent kernel on the remote Jupyter Server. `notebook` (required) is the remote contents path of the notebook to run in — pass the path you opened with jupyter_open_notebook to REUSE that session (a not-yet-open notebook is opened the same way first). Variables/imports persist across calls in that notebook's kernel. SCRATCH by default (`persist=false`): the code runs on the kernel and its output is returned, but the notebook document is NOT changed — exploratory/probe code never pollutes the saved .ipynb. Pass `persist=true` for real work that should be kept (an existing same-source cell is re-run in place, otherwise a new cell is appended, and the remote auto-save picks it up). Pass `cell_id` (instead of `code`) to RE-RUN an existing cell from its CURRENT source — the way to refill a cell's outputs after jupyter_edit_cell changed it, with no need to retype the code; a `cell_id` run records in place by default. The last expression is the result; use print()/display() for intermediate output; images are returned inline. Stay in the SAME notebook for the whole task: pass the same `notebook` path again and again — do NOT shut it down and re-open it to refresh it, and do NOT route code through a scratch .py/.R file; `persist=true` is how a run becomes part of the .ipynb. Use jupyter_edit_cell to restructure the document itself (delete/replace/move/insert a cell); never edit the .ipynb through an external script. Output is capped to the FIRST 50 + LAST 100 lines; when a run prints more, the omitted middle lines are written to a /tmp/pi-jupyter/*.log file whose path is returned (details.output_truncated.log_path) so you can read them on demand instead of flooding the context.",
    promptSnippet:
      "jupyter_repl: run code on a remote Jupyter notebook kernel — pass the notebook path opened with jupyter_open_notebook.",
    promptGuidelines: [
      "Begin Jupyter work with jupyter_list_notebooks(dir=…) to see which sessions are active in the current remote contents folder (open here / LIVE on the server) — scope the listing to one directory (direct children only, no recursion); with none active — or to switch — continue a notebook with jupyter_open_notebook first (call jupyter_list_kernels first when you do not know the kernels), then run code with jupyter_repl.",
      `Pass the same \`notebook\` path to jupyter_repl${config.enableAddDependencies ? " / jupyter_add_dependencies" : ""}${config.enableSaveNotebook ? " / jupyter_save_notebook" : ""} to REUSE the session. Opening a previously-closed notebook starts a new kernel bound to its file and re-runs the code cells from first to last (state restored); opening a LIVE one attaches with variables kept.`,
      `jupyter_repl has no \`kernel\` or \`dependencies\` parameter — the kernel was fixed when the notebook was opened (live kernel / recorded kernelspec / the \`kernel\` param of jupyter_open_notebook / config fallback).${config.enableAddDependencies ? " Install packages with jupyter_add_dependencies." : ""}`,
      "The last expression is the result; use print()/display() for intermediate output. Images (matplotlib, PIL) come back inline.",
      "jupyter_repl takes `code` (new code) or `cell_id` (re-run an existing cell from its current, possibly just-edited source) — at least one is required. A `cell_id` run targets that document cell and records in place by default (persist=false opts out to a scratch probe); `code` together with `cell_id` executes the new code into that cell.",
      "jupyter_repl is SCRATCH by default (persist=false): the run's output comes back but it is not written to the notebook. Use it freely for probes/experiments. Pass persist=true only for real work you want recorded; use jupyter_outputs(path) to re-read outputs already saved in a .ipynb without running anything.",
      "Drive ONE notebook like a REPL for the whole task: pass the same `notebook` path to every call. Do NOT loop jupyter_shutdown_notebook → jupyter_open_notebook to refresh state, and do NOT open a second/new notebook just to see whether a run was recorded — a shutdown wipes the live kernel's variables, while persist=true is what puts a run into the file.",
      "Never execute by writing a throwaway .py/.R/.jl (or other) source file and converting or importing it as .ipynb, and never fall back to a plain file/shell script to avoid the notebook. Put the code directly into jupyter_repl against the notebook path from jupyter_open_notebook; use jupyter_list_notebooks first if you have not picked that notebook yet.",
      'To CHANGE an existing cell, do not just re-run the new code (that appends a duplicate): replace it with jupyter_edit_cell(action="replace", cell_id=…, source=…) and then re-run THAT cell with jupyter_repl(notebook=…, cell_id=…, persist=true) — it uses the edited source, so the code need not be retyped. Delete probe/error cells with jupyter_edit_cell(action="delete", cell_id=…). Never edit the .ipynb through an external script.',
    ],
    parameters: JUPYTER_PARAMS,

    renderCall(args, theme, _context) {
      const text =
        (_context.lastComponent as InstanceType<typeof Text> | undefined) ?? new Text("", 0, 0);
      const cellId = (args?.cell_id ?? "").trim();
      const code =
        (args?.code ?? "").replace(/^\n+/, "") ||
        (cellId ? `# re-run cell ${cellId}` : "");
      const key = kernelForNotebook(args?.notebook) || config.kernelName || "default";
      const count = execCounts.get(key) ?? null;
      const prompt = count != null ? `In [${count}]:` : "In [*]:";
      const promptStr = theme.fg("accent", theme.bold(prompt));

      const state = _context.state as InCallState;
      const waitingForFirstToken =
        !code && !_context.executionStarted && !_context.argsComplete && !_context.isError;
      if (waitingForFirstToken) {
        if (!state.spinner) {
          const timer = setInterval(() => {
            const s = state.spinner;
            if (!s) return;
            s.frame = (s.frame + 1) % SPINNER_FRAMES.length;
            _context.invalidate();
          }, SPINNER_INTERVAL_MS);
          timer.unref?.();
          state.spinner = { frame: 0, timer };
        }
        const frame = SPINNER_FRAMES[state.spinner.frame];
        text.setText(`${promptStr} ${theme.fg("muted", frame)}`);
        return text;
      }

      if (state.spinner) {
        clearInterval(state.spinner.timer);
        state.spinner = undefined;
      }

      const lines = highlightCode(code, "python");
      const pad = " ".repeat(prompt.length + 1);
      const formatted = lines
        .map((l, i) => (i === 0 ? `${promptStr} ${l}` : `${pad}${l}`))
        .join("\n");
      text.setText(formatted);
      return text;
    },

    renderResult(result, _options, theme, _context) {
      const details = (result as any).details ?? {};
      const count = details.execution_count;
      const isErr = details.is_error;
      const key = details.kernel || config.kernelName || "default";

      if (count != null) execCounts.set(key, count + 1);

      const textContent = (result.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      // Strip the "cell <id> [n] status" header we put in the text content.
      const body = textContent.replace(/^cell \S* \[[^\]]*\] \S*\n?/, "").trim();

      const text =
        (_context.lastComponent instanceof Text ? _context.lastComponent : undefined) ??
        new Text("", 0, 0);
      if (!body) {
        const icon = isErr ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
        text.setText(icon);
      } else if (isErr) {
        text.setText(theme.fg("error", body));
      } else {
        const prompt = count != null ? `Out[${count}]:` : "Out:";
        const promptStr = theme.fg("muted", prompt);
        const pad = " ".repeat(prompt.length + 1);
        const bodyLines = body.split("\n");
        const formatted = bodyLines
          .map((l: string, i: number) => (i === 0 ? `${promptStr} ${l}` : `${pad}${l}`))
          .join("\n");
        text.setText(formatted);
      }
      return text;
    },

    async execute(_toolCallId, params: JupyterParams, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("aborted");
      const notebookRaw = params.notebook?.trim();
      if (!notebookRaw) {
        throw new Error(
          "[pi-jupyter] jupyter_repl requires a `notebook` path — start/continue a session" +
            " with jupyter_open_notebook first, then pass the same path here.",
        );
      }
      // `code` or `cell_id` — at least one. With `cell_id` alone the source
      // comes from the live document below, so an edited cell re-runs as-is.
      if (params.code === undefined && !params.cell_id?.trim()) {
        throw new Error(
          "[pi-jupyter] jupyter_repl needs `code` to run, or `cell_id` to re-run an" +
            " existing cell (its current source is used, so a just-edited cell needs no retyping).",
        );
      }
      const { session: sess, opened, outcome } = await ensureNotebookSession({
        path: notebookRaw,
        cwd: ctx.cwd,
      });
      // Opening a previously-closed notebook (a fresh kernel bound to its file)
      // replays the file's cells FIRST → LAST so the in-memory state is rebuilt
      // here too — exactly what jupyter_open_notebook does. An attach (live
      // kernel) or an already-open session keeps its state as-is.
      const replay =
        opened && outcome?.mode === "started" && outcome.fileExisted && sess.listCells().length > 0
          ? await replayFromStart(sess)
          : undefined;
      // Side-channel for the remote auto-save (FR-6.2): failures are notified
      // to the user but never touch this tool's result (by-pass, FR-6.1).
      sess.onAutoSave = (e) => {
        if (!e.ok) {
          ctx.ui?.notify(`[pi-jupyter] remote auto-save failed (${e.path}): ${e.error}`, "warning");
        }
      };
      // Resolve what to run. With `cell_id` and no `code`, take the source from
      // the live document so an edited cell (jupyter_edit_cell replace) is
      // re-executed exactly as it now stands — no need to retype the code. A
      // `cell_id` run targets a real document cell, so recording in place is the
      // default; persist=false still opts out to a scratch probe.
      const cellIdRaw = params.cell_id?.trim();
      let code = params.code;
      if (code === undefined) {
        const target = sess.listCells().find((c) => c.cellId === cellIdRaw);
        if (!target) {
          throw new Error(
            `[pi-jupyter] no code cell with id "${cellIdRaw}" — list the cell ids with` +
              " jupyter_open_notebook (details.cells) or jupyter_outputs(path).",
          );
        }
        code = target.source;
      }
      const persist = params.persist ?? Boolean(cellIdRaw);
      const timeoutSecs = Math.max(1, params.timeout_secs ?? 120);
      const result = await sess.runCell(code, {
        timeoutMs: Math.round(timeoutSecs * 1000),
        // Scratch by default: the agent must opt in with persist=true to write
        // the run into the notebook document (append or in-place re-run).
        persist,
        cellId: cellIdRaw,
        afterCellId: params.after_cell_id,
        onUpdate: (progress) => {
          const { content, isError } = formatResult(progress);
          onUpdate?.({
            content,
            details: {
              kernel: sess.kernelName,
              notebook_id: sess.notebookId,
              cell_id: progress.cellId,
              execution_id: progress.executionId,
              status: progress.status,
              execution_count: progress.executionCount,
              is_error: isError,
              streaming: true,
            },
          });
        },
      });
      const { content, isError } = formatResult(result);
      // Keep the transcript bounded: only the FIRST 50 and the LAST 100 lines
      // of a cell's output reach the model. The middle is moved to a /tmp log
      // file the agent can read on demand, so one huge print() cannot flood the
      // context window. Both ends are kept because a run usually announces what
      // it is doing first and states its result last.
      const capped = capOutputContent(content);
      return {
        content: capped.content,
        details: {
          kernel: sess.kernelName,
          notebook: sess.contentsPath,
          notebook_id: sess.notebookId,
          cell_id: result.cellId,
          execution_id: result.executionId,
          status: result.status,
          execution_count: result.executionCount,
          is_error: isError,
          persist,
          ...(capped.dropped
            ? {
                output_truncated: {
                  dropped_lines: capped.dropped,
                  log_path: capped.logPaths[0] ?? null,
                },
              }
            : {}),
          runtime: await sess.getRuntimeStatus().catch(() => undefined),
          ...(replay ? { replay: { replayed: replay.replayed, failed: replay.failed, cells: replay.cells } } : {}),
        },
      };
    },
  });

  // ── jupyter_edit_cell ─────────────────────────────────────────────────────

  pi.registerTool<typeof EDIT_CELL_PARAMS, Record<string, unknown>>({
    name: "jupyter_edit_cell",
    label: "Edit Notebook Cell",
    description:
      "Edit an OPEN notebook's document in place: delete, replace, move or insert a code cell. This is the in-plugin write path for restructuring a notebook — deleting probe/error cells, replacing a cell with a self-contained version, reordering cells, inserting a promoted scratch cell — so the .ipynb itself is edited from inside the session. Cell ids come from jupyter_open_notebook (details.cells) or jupyter_outputs(path). Replacing a cell CLEARS its old outputs; re-run it with jupyter_repl(notebook=…, cell_id=…) to fill them again (the cell is matched by id, using its edited source). Every edit is written to the remote .ipynb (unless remote auto-save is off).",
    parameters: EDIT_CELL_PARAMS,
    promptGuidelines: [
      "Restructure an open notebook with jupyter_edit_cell — delete probe/error cells, replace a cell's source, move cells into order, insert a cell. Do NOT write an external .py script or JSON patch to modify the .ipynb: the live document is the source of truth, and an outside write can be overwritten by the session's auto-save.",
      'After jupyter_edit_cell(action="replace", …) the cell has NO outputs; re-run it with jupyter_repl(notebook=…, cell_id=…) to execute its edited source and record the result in place (persist then defaults to true, so no code needs retyping). To promote a scratch run, re-run it with persist=true plus after_cell_id.',
    ],
    async execute(_toolCallId, params: EditCellParams) {
      const { session: sess } = await ensureNotebookSession({ path: params.notebook });
      const outcome = await sess.editCell({
        action: params.action,
        cellId: params.cell_id,
        source: params.source,
        position: params.position,
        afterCellId: params.after_cell_id,
      });
      const verb =
        outcome.action === "delete"
          ? "Deleted"
          : outcome.action === "replace"
            ? "Replaced"
            : outcome.action === "move"
              ? "Moved"
              : "Inserted";
      const cellList = outcome.cells.length
        ? outcome.cells
            .map(
              (c, i) =>
                `  [${i}] ${c.cellId} (exec ${c.executionCount ?? "-"}${c.restored ? ", restored" : ", ran"}) ${sourcePreview(c.source, 100)}`,
            )
            .join("\n")
        : "  (no code cells)";
      const positionNote = outcome.index !== undefined ? ` — now index ${outcome.index}` : "";
      return {
        content: [
          {
            type: "text",
            text:
              `${verb} cell${outcome.cellId ? ` ${outcome.cellId}` : ""} in ${sess.contentsPath}${positionNote};` +
              ` the document was written to the remote .ipynb.\nCode cells now:\n${cellList}`,
          },
        ],
        details: {
          kernel: sess.kernelName,
          notebook: sess.contentsPath,
          notebook_id: sess.notebookId,
          action: outcome.action,
          cell_id: outcome.cellId ?? null,
          index: outcome.index ?? null,
          cells: outcome.cells,
          runtime: await sess.getRuntimeStatus().catch(() => undefined),
        },
      };
    },
  });

  // ── jupyter_add_dependencies ─────────────────────────────────────────────

  if (config.enableAddDependencies) {
    pi.registerTool<typeof ADD_DEPENDENCIES_PARAMS, { kernel?: string; notebook_id?: string; packages?: string[] }>({
      name: "jupyter_add_dependencies",
      label: "Add Dependencies",
      description:
        "Install packages into a notebook's kernel WITHOUT restarting. Python kernels use %pip (specs like 'matplotlib', 'numpy>=2'); R kernels use CRAN install.packages (e.g. 'ggplot2'); other languages fail explicitly. Real install errors are reported, never masked.",
      parameters: ADD_DEPENDENCIES_PARAMS,
      async execute(_toolCallId, params: AddDependenciesParams, signal) {
        if (signal?.aborted) throw new Error("aborted");
        if (!params.packages.length) {
          return { content: [{ type: "text", text: "No packages given." }], details: {} };
        }
        const { session: sess } = await ensureNotebookSession({ path: params.notebook });
        try {
          await addDepsAndSync(sess, params.packages);
        } catch (err) {
          // Surface the REAL failure (wrong language, network, CRAN error, …)
          // instead of pretending the install succeeded (BUG-1).
          return {
            content: [
              {
                type: "text",
                text: `Failed to install into ${sess.contentsPath} (kernel ${sess.kernelName}): ${(err as Error).message}`,
              },
            ],
            details: { kernel: sess.kernelName, notebook: sess.contentsPath, notebook_id: sess.notebookId, packages: params.packages },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Installed into ${sess.contentsPath} (kernel ${sess.kernelName}): ${params.packages.join(", ")}`,
            },
          ],
          details: { kernel: sess.kernelName, notebook: sess.contentsPath, notebook_id: sess.notebookId, packages: params.packages },
        };
      },
    });
  }

  // ── jupyter_save_notebook ────────────────────────────────────────────────

  if (config.enableSaveNotebook) {
    pi.registerTool<typeof SAVE_NOTEBOOK_PARAMS, { kernel?: string; notebook_id: string; path?: string }>({
      name: "jupyter_save_notebook",
      label: "Save Notebook",
      description:
        "Save a notebook session as a local .ipynb file (openable in Jupyter / VSCode). `path` defaults to <notebook-id>.ipynb in the working directory; relative paths resolve against the working directory, so prefer absolute paths or ~/.",
      parameters: SAVE_NOTEBOOK_PARAMS,
      async execute(_toolCallId, params: SaveNotebookParams, signal, _onUpdate, ctx) {
        if (signal?.aborted) throw new Error("aborted");
        const { session: sess } = await ensureNotebookSession({ path: params.notebook });
        // Resolve relative paths against the pi working directory (ctx.cwd), NOT
        // the pi *process* cwd — under npx those are different places (BUG-3).
        const base = ctx?.cwd ?? process.cwd();
        const savePath = params.path
          ? resolvePath(params.path, base)
          : join(base, `${sess.notebookId}.ipynb`);
        const where = await sess.saveNotebook(savePath);
        return {
          content: [{ type: "text", text: `Notebook (kernel ${sess.kernelName}) saved to ${where}` }],
          details: { kernel: sess.kernelName, notebook: sess.contentsPath, notebook_id: sess.notebookId, path: where },
        };
      },
    });
  }

  // ── /jupyter-reset ───────────────────────────────────────────────────────

  pi.registerCommand("jupyter-reset", {
    description:
      "Start fresh: shut down ALL open notebook sessions on the server. The saved .ipynb files stay; the next jupyter_open_notebook call starts new kernels bound to them and re-runs their cells (clean slate: no prior variables or imports).",
    handler: async (_args, ctx) => {
      const olds = [...sessionsByPath.values()];
      sessionsByPath.clear();
      openings.clear();
      execCounts.clear();
      await Promise.allSettled(olds.map((s) => s.shutdown()));
      ctx.ui.notify(
        "All notebook sessions closed. Next jupyter_open_notebook starts fresh kernels bound to the saved files (their cells are re-run first → last).",
        "info",
      );
    },
  });

  // ── cleanup on shutdown ─────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    const notebookSessions = [...sessionsByPath.values()];
    sessionsByPath.clear();
    openings.clear();
    execCounts.clear();
    if (config.keepKernels) {
      // Continuity mode (default): for NAMED notebook sessions, DETACH — flush
      // the snapshot and drop this client's connections, but LEAVE the kernels
      // running on the server so a new conversation (or the browser) can
      // re-attach to the same contents paths and keep their in-memory
      // variables. Explicit cleanup: jupyter_shutdown_notebook or /jupyter-reset.
      await Promise.allSettled(notebookSessions.map((s) => s.detach()));
    } else {
      // Legacy mode (JUPYTER_KEEP_KERNELS=0): kill named notebooks too.
      await Promise.allSettled(notebookSessions.map((s) => s.shutdown()));
    }
  });
}
