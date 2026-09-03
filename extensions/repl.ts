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
 *   - `jupyter_list_notebooks` first: it shows every notebook that is ACTIVE
 *     (open this conversation / LIVE kernel on the server) or resumable from a
 *     saved file (~/.pi-jupyter/notebooks.json merged with /api/sessions).
 *   - No active session yet, or switching to another notebook → CONTINUE one
 *     with `jupyter_open_notebook` (a `path` from jupyter_list_notebooks, or a
 *     `local_file` to import). When the agent does not know which kernels the
 *     server offers, call `jupyter_list_kernels` first. Only then run code with
 *     `jupyter_repl`.
 *   - Opening a notebook whose kernel was previously closed (no live kernel)
 *     starts a NEW kernel bound to the same path and re-runs the file's code
 *     cells FROM FIRST TO LAST, so the in-memory state is rebuilt before any
 *     jupyter_repl call. A LIVE kernel is ATTACHED instead (no new kernel, no
 *     re-run — variables/imports survive). With an active session, each
 *     jupyter_repl(notebook=…) REUSES that session.
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
 * After editing, run `/reload` in pi.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { CONFIG_HINT, isConfigured, loadConfig } from "../src/config";
import type { ResumeOutcome, Session } from "../src/domain/types";
import { JupyterServer } from "../src/kernel/server";
import { loadNotebooks, touchNotebook } from "../src/notebooks";
import { normalizeContentsPath, RemoteSession } from "../src/session";
import { formatResult } from "./format";
import { loadPurposes, savePurposes } from "../src/purposes";
import {
  ADD_DEPENDENCIES_PARAMS,
  JUPYTER_PARAMS,
  LIST_KERNELS_PARAMS,
  LIST_NOTEBOOKS_PARAMS,
  OPEN_NOTEBOOK_PARAMS,
  SAVE_NOTEBOOK_PARAMS,
  SET_KERNEL_PURPOSE_PARAMS,
  SHUTDOWN_NOTEBOOK_PARAMS,
  type AddDependenciesParams,
  type JupyterParams,
  type OpenNotebookParams,
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

// ── extension ───────────────────────────────────────────────────────────────

export default function piJupyterExtension(pi: ExtensionAPI) {
  if (!isConfigured()) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(CONFIG_HINT, "warning");
    });
    // Register every tool even when unconfigured, so the tool list is stable
    // before/after configuration; each stub fails with the same hint (UX-8).
    pi.registerTool({
      name: "jupyter_list_kernels",
      label: "List Kernels",
      description:
        "List the kernels available on the remote Jupyter Server. Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
      promptSnippet:
        "jupyter_list_kernels: not configured (set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN, or ~/.pi-jupyter/config.json).",
      parameters: LIST_KERNELS_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });

    pi.registerTool({
      name: "jupyter_list_notebooks",
      label: "List Notebooks",
      description:
        "List the notebooks available to continue on the remote Jupyter Server. Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
      promptSnippet:
        "jupyter_list_notebooks: not configured (set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN, or ~/.pi-jupyter/config.json).",
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
      promptSnippet:
        "jupyter_open_notebook: not configured (set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN, or ~/.pi-jupyter/config.json).",
      parameters: OPEN_NOTEBOOK_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });

    pi.registerTool({
      name: "jupyter_shutdown_notebook",
      label: "Shut Down Notebook Kernel",
      description:
        "Shut down one notebook's kernel (the .ipynb file stays). Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
      promptSnippet:
        "jupyter_shutdown_notebook: not configured (set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN, or ~/.pi-jupyter/config.json).",
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
      promptSnippet:
        "jupyter_set_kernel_purpose: not configured (set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN, or ~/.pi-jupyter/config.json).",
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
        "jupyter_repl: run code on a remote Jupyter kernel (not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN, or ~/.pi-jupyter/config.json).",
      parameters: JUPYTER_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });
    pi.registerTool({
      name: "jupyter_add_dependencies",
      label: "Add Dependencies",
      description:
        "Install packages into the remote kernel's environment. Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
      promptSnippet:
        "jupyter_add_dependencies: not configured (set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN, or ~/.pi-jupyter/config.json).",
      parameters: ADD_DEPENDENCIES_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });
    pi.registerTool({
      name: "jupyter_save_notebook",
      label: "Save Notebook",
      description:
        "Save the current session as an .ipynb file. Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN (env) or ~/.pi-jupyter/config.json.",
      promptSnippet:
        "jupyter_save_notebook: not configured (set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN, or ~/.pi-jupyter/config.json).",
      parameters: SAVE_NOTEBOOK_PARAMS,
      async execute() {
        throw new Error(CONFIG_HINT);
      },
    });
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
    failed: { index: number; cellId: string; status: string; error: string }[];
  }> {
    const cells = sess.listCells();
    const failed: { index: number; cellId: string; status: string; error: string }[] = [];
    let lastCount: number | null | undefined;
    for (let i = 0; i < cells.length; i++) {
      const res = await sess.runCell(cells[i].source);
      lastCount = res.executionCount ?? lastCount;
      if (res.success) continue;
      const err = res.outputs?.find((o) => o.outputType === "error");
      failed.push({
        index: i,
        cellId: res.cellId,
        status: res.status,
        error: err?.evalue ?? err?.ename ?? res.status,
      });
    }
    if (lastCount != null) execCounts.set(sess.kernelName, lastCount + 1);
    return { replayed: cells.length, failed };
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
        "  Pass one of these names as `kernel` to jupyter_open_notebook — used when the",
        "  notebook has no live kernel and its file records none (e.g. brand-new notebooks).",
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
   * Human + structured view of the notebooks the agent can CONTINUE:
   * registry entries (~/.pi-jupyter/notebooks.json) merged with the server's
   * live /api/sessions rows — this is what a NEW agent consults FIRST to see
   * whether a session is active. A live row means "attach — kernel still
   * running, variables preserved"; a registry-only path means "file only —
   * opening it starts a NEW kernel bound to the same path and re-runs its code
   * cells from first to last, restoring the state".
   */
  async function describeNotebooks(): Promise<{ text: string; details: Record<string, unknown> }> {
    const server = new JupyterServer(config);
    const purposes = loadPurposes();
    let liveRows: Array<{ path: string; kernelName: string }> = [];
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
    // path → { kernel, live, source, localFile, updated, open }
    const merged = new Map<
      string,
      {
        kernel: string;
        live: boolean;
        source: "remote" | "local";
        localFile?: string;
        updated: string;
        open: boolean;
      }
    >();
    for (const live of liveRows) {
      const prior = merged.get(live.path);
      merged.set(live.path, {
        kernel: live.kernelName || prior?.kernel || "?",
        live: true,
        source: prior?.source ?? "remote",
        ...(prior?.localFile ? { localFile: prior.localFile } : {}),
        updated: prior?.updated ?? "",
        open: sessionsByPath.has(live.path),
      });
    }
    for (const [path, rec] of Object.entries(store)) {
      const prior = merged.get(path);
      merged.set(path, {
        kernel: prior?.kernel ?? rec.kernelName,
        live: prior?.live ?? false,
        source: rec.source,
        ...(rec.localFile ? { localFile: rec.localFile } : {}),
        updated: prior?.updated ?? rec.updated,
        open: prior?.open ?? sessionsByPath.has(path),
      });
    }
    // Keep rows open in THIS conversation that somehow are not above.
    for (const path of sessionsByPath.keys()) {
      if (!merged.has(path)) {
        const sess = sessionsByPath.get(path)!;
        merged.set(path, {
          kernel: sess.kernelName,
          live: true,
          source: "remote",
          updated: "",
          open: true,
        });
      }
    }
    const lines: string[] = [
      "Notebooks available to continue on the configured Jupyter Server:",
      "  Continue one with jupyter_open_notebook(path=…): it attaches to a live kernel",
      "  (variables kept) or starts a new one and re-runs the file's cells from first",
      "  to last (state restored). Then keep passing the same path as `notebook` to",
      "  jupyter_repl / jupyter_add_dependencies / jupyter_save_notebook.",
      "",
    ];
    if (merged.size === 0) {
      lines.push("  (none yet — open a path with jupyter_open_notebook to create the first session)");
    } else {
      for (const [path, info] of [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const marks: string[] = [];
        if (info.live) marks.push("LIVE kernel — open attaches, variables kept");
        else marks.push("file only — open starts a fresh kernel and re-runs its cells from first to last (state restored)");
        if (info.open) marks.push("open in this conversation");
        if (info.source === "local" && info.localFile) marks.push(`imported from ${info.localFile}`);
        const purpose = purposes[info.kernel];
        lines.push(`  - ${path}  (kernel ${info.kernel})${purpose ? `  [purpose: ${purpose}]` : ""}`);
        lines.push(`      ${marks.join(" | ")}${info.updated ? ` | last used ${info.updated.slice(0, 10)}` : ""}`);
      }
    }
    lines.push(
      "",
      "Workflow: call this tool FIRST to check the active session(s). If there is no",
      "active session — or you need to switch notebooks — continue a path here with",
      "jupyter_open_notebook (list the kernels first with jupyter_list_kernels when",
      "you do not know them). Opening a previously-closed notebook starts a NEW kernel",
      "bound to it and re-runs its code cells from first to last, so in-memory state",
      "is restored before any jupyter_repl call. With an active session, simply reuse",
      "it via jupyter_repl(notebook=<same path>, code=…).",
    );
    return {
      text: lines.join("\n"),
      details: {
        notebooks: [...merged.entries()].map(([path, info]) => ({ path, ...info })),
        live_paths: liveRows.map((r) => r.path),
      },
    };
  }

  // ── jupyter_list_notebooks ───────────────────────────────────────────────

  pi.registerTool<typeof LIST_NOTEBOOKS_PARAMS, Record<string, unknown>>({
    name: "jupyter_list_notebooks",
    label: "List Notebooks",
    description:
      "List the notebooks available to CONTINUE on the remote Jupyter Server — every contents path pi has opened (~/.pi-jupyter/notebooks.json) merged with the live /api/sessions rows. Call this FIRST to check whether a session is active: each entry shows its kernel and whether a LIVE kernel is bound to it. Continue one with jupyter_open_notebook (it ATTACHES to the live kernel with variables preserved, or starts a fresh kernel that re-runs the file's cells from first to last so state is restored), then run code with jupyter_repl.",
    promptSnippet:
      "jupyter_list_notebooks: FIRST check for an active session — LIVE kernels attach with variables intact; file-only notebooks resume with a new kernel that re-runs their cells.",
    promptGuidelines: [
      "Call this FIRST whenever the user wants to continue earlier work (or just named a notebook) — it shows which sessions are ACTIVE (open in this conversation / LIVE on the server) and which paths can be resumed.",
      "If an active session already exists and you are continuing it, pass its path straight to jupyter_repl — that call REUSES the session. If there is no active session, or you need to switch, continue a path with jupyter_open_notebook first (and jupyter_list_kernels first when you do not know the kernels).",
      "A path marked LIVE has a kernel still running on the server — opening it ATTACHES (no restart, in-memory variables preserved). A 'file only' path starts a NEW kernel bound to that same path and jupyter_open_notebook re-runs its cells from first to last, restoring the state automatically.",
    ],
    parameters: LIST_NOTEBOOKS_PARAMS,
    async execute() {
      const { text, details } = await describeNotebooks();
      return { content: [{ type: "text", text }], details };
    },
  });

  // ── jupyter_list_kernels ──────────────────────────────────────────────────

  pi.registerTool<typeof LIST_KERNELS_PARAMS, Record<string, unknown>>({
    name: "jupyter_list_kernels",
    label: "List Kernels",
    description:
      "List the kernels available on the remote Jupyter Server — the python3 / ir / … kernelspecs that can execute code, each annotated with its recorded purpose (persisted across sessions). Only a kernel with no recorded purpose is NEW: ask the user what it is for, record it with jupyter_set_kernel_purpose, then pick the matching kernel when a notebook must be opened on it. The server address itself is already configured by the user and is never chosen here.",
    promptSnippet:
      "jupyter_list_kernels: list the kernels on the configured Jupyter Server so the agent can pick the right one when opening a notebook.",
    promptGuidelines: [
      "A kernel is what executes code (python3, ir, …) — the Jupyter Server url/token is configured by the user and never selected.",
      "Call this BEFORE jupyter_open_notebook when you do not know which kernels the server offers (the FIRST step of the flow is still jupyter_list_notebooks). Kernels whose purpose is already recorded (persisted in ~/.pi-jupyter/purposes.json) are shown with it — pick them directly, never re-ask.",
      "Only a kernel marked 'purpose: not recorded' is NEW: ask the user once what it is for, then record it with `jupyter_set_kernel_purpose`. After that every session shows the purpose and you pick it automatically.",
      "Pass the chosen name as the `kernel` parameter of jupyter_open_notebook (kernelspec *name*: \"ir\", not \"R\") when the notebook has no live kernel and its file records none. jupyter_repl never takes a `kernel` — the kernel of its notebook session was fixed when the notebook was opened.",
    ],
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
      "Record what a kernel (kernelspec name) is for, as the user explained — persisted across sessions in ~/.pi-jupyter/purposes.json, so jupyter_list_kernels shows it later and the agent picks the matching kernel when opening a notebook, without re-asking. Call this right after the user describes a kernel that jupyter_list_kernels marked as having no recorded purpose. Use kernelspec *names* only (\"ir\", not \"R\").",
    promptSnippet:
      "jupyter_set_kernel_purpose: remember what a kernel is for so future sessions can pick it without re-asking.",
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
      "Start an ACTIVE session on a notebook and CONTINUE it. `path` is a remote contents path (e.g. \"notes/pi.ipynb\", as listed by jupyter_list_notebooks) or `local_file` is a .ipynb on this machine to import under its file name and then continue. If a LIVE kernel is bound to the path, this ATTACHES to that kernel — no new kernel is started, so in-memory variables from the earlier session survive. Otherwise (the previously-closed session) a NEW kernel is started bound to the SAME path and the file's code cells are executed FROM FIRST TO LAST so the state is rebuilt before any jupyter_repl call; a path with no file yet just starts the document empty. The kernel comes from the `kernel` param, else from the notebook file's recorded kernelspec, else the configured fallback.",
    promptSnippet:
      "jupyter_open_notebook: start/continue a notebook session — attach to its live kernel (variables kept), or start a new kernel bound to the same path and re-run its cells from first to last to restore state.",
    promptGuidelines: [
      "This is how a session is STARTED. Flow: jupyter_list_notebooks FIRST to see if a session is already active; when there is none (or you need to switch notebooks), open one here — and call jupyter_list_kernels first if you don't know which kernels the server offers. Only after this returns do you run code with jupyter_repl(notebook=…).",
      "If the result says 'attached', the previous kernel is still running — variables/imports are intact, just keep working.",
      "If it says 'started', the notebook was previously closed: a NEW kernel was started and its code cells were re-run FROM FIRST TO LAST (identical source → executed IN PLACE — same cell id, outputs replaced — so the notebook keeps one copy per logical cell). The result lists each cell's outcome, so state is already rebuilt unless a cell failed — fix any failure and re-run.",
      "Then keep passing the same `notebook` path on jupyter_repl / jupyter_add_dependencies / jupyter_save_notebook calls — they REUSE this session.",
    ],
    parameters: OPEN_NOTEBOOK_PARAMS,
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
      const replay =
        opened && outcome?.mode === "started" && outcome.fileExisted
          ? await replayFromStart(session)
          : undefined;
      const cells = session.listCells();
      const lines: string[] = [];
      const modeText = opened && outcome ? outcome.mode : "open";
      if (modeText === "attached") {
        lines.push(`Attached to the LIVE kernel (${session.kernelName}) serving ${openPath} — variables and imports from the earlier session are intact.`);
        if (cells.length) lines.push(`${cells.length} code cell(s) loaded from the file for reference.`);
        lines.push("Keep working: no setup needs re-running.");
      } else if (modeText === "started") {
        lines.push(`Started a NEW ${session.kernelName} kernel bound to ${openPath} (a fresh kernel — in-memory variables were NOT preserved).`);
        if (outcome?.fileExisted) {
          if (cells.length === 0) {
            lines.push("The file existed but holds no code cells — the document starts clean.");
          } else if (replay) {
            if (replay.failed.length === 0) {
              lines.push(`State restored: re-ran all ${replay.replayed} code cell(s) from first to last — every one succeeded.`);
            } else {
              lines.push(`State restore is PARTIAL: re-ran ${replay.replayed} code cell(s) from first to last; ${replay.failed.length} FAILED (listed at the end, also in details.replay). Fix the failing cells and re-run them.`);
            }
          }
        } else {
          lines.push("No file existed at that path yet — the notebook starts empty and will be auto-saved there.");
        }
      } else {
        lines.push(`Notebook ${openPath} is already open in this conversation (kernel ${session.kernelName}).`);
      }
      lines.push("");
      if (cells.length) {
        lines.push(`Code cells (all executed above unless noted — jupyter_repl(notebook="${openPath}", code=<source>) runs more):`);
        cells.forEach((c, i) => {
          const one = c.source.replace(/\s+/g, " ").trim().slice(0, 140);
          lines.push(`  [${i}] (exec ${c.executionCount ?? "-"}${c.restored ? ", restored" : ", ran"}) ${one}`);
        });
      } else {
        lines.push("No code cells yet.");
      }
      if (replay?.failed.length) {
        lines.push("");
        for (const f of replay.failed) {
          lines.push(`  ! cell [${f.index}] ${f.cellId} — ${f.status}: ${f.error}`);
        }
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
          ...(replay ? { replay: { replayed: replay.replayed, failed: replay.failed } } : {}),
        },
      };
    },
  });

  // ── jupyter_shutdown_notebook ─────────────────────────────────────────────

  pi.registerTool<typeof SHUTDOWN_NOTEBOOK_PARAMS, Record<string, unknown>>({
    name: "jupyter_shutdown_notebook",
    label: "Shut Down Notebook Kernel",
    description:
      "Shut down a notebook's kernel: kill the kernel and drop its session row on the server (the .ipynb file stays on the server; a future jupyter_open_notebook resumes it with a fresh kernel, re-running its cells from first to last). The path may be a notebook open in this conversation OR any LIVE kernel bound to that path on the server (left by an earlier conversation or a browser tab). Use /jupyter-reset to shut down everything.",
    promptSnippet:
      "jupyter_shutdown_notebook: kill one notebook's kernel (open here or live on the server; the file stays, resume restarts a fresh kernel).",
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
        removeSession(local);
        return {
          content: [{ type: "text", text: `Kernel serving ${path} shut down (file kept; a future open resumes it with a fresh kernel).` }],
          details: { path, kernel, target: "this-conversation" },
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
      "Execute code in the ACTIVE notebook session on a remote Jupyter Server. `notebook` is REQUIRED — the remote contents path of the notebook to run in (open/continue it first with jupyter_open_notebook, then keep passing the same path; it REUSES that session). Variables, imports, and state persist across calls in that notebook's kernel. The last expression is the result; use print() for intermediate output. Images are returned inline.",
    promptSnippet:
      "jupyter_repl: run code in an open notebook session (notebook is required — continue it with jupyter_open_notebook first, then reuse it here).",
    promptGuidelines: [
      "Call jupyter_list_notebooks FIRST to see whether a session is already active. If one is active, pass its path here — the session is REUSED. If none is active (or you need to switch notebooks), start one with jupyter_open_notebook first (and jupyter_list_kernels first if you do not know the kernels), then run code here.",
      "State persists between calls in the notebook's remote kernel — no need to re-import or redefine on every turn unless the session was reset. Opening a previously-closed notebook re-runs its cells from first to last (state restored); continue working here afterwards.",
      "There is no `kernel` or `dependencies` parameter: the kernel was fixed when the notebook was opened (live kernel / recorded kernelspec / the `kernel` param of jupyter_open_notebook). Install packages with jupyter_add_dependencies.",
      "The last expression is the result; use print() or display() for intermediate output.",
      "Images (matplotlib, PIL) come back inline. The user sees them if their terminal supports graphics.",
    ],
    parameters: JUPYTER_PARAMS,

    renderCall(args, theme, _context) {
      const text =
        (_context.lastComponent as InstanceType<typeof Text> | undefined) ?? new Text("", 0, 0);
      const code = (args?.code ?? "").replace(/^\n+/, "");
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
      const timeoutSecs = Math.max(1, params.timeout_secs ?? 120);
      const result = await sess.runCell(params.code, {
        timeoutMs: Math.round(timeoutSecs * 1000),
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
      return {
        content,
        details: {
          kernel: sess.kernelName,
          notebook: sess.contentsPath,
          notebook_id: sess.notebookId,
          cell_id: result.cellId,
          execution_id: result.executionId,
          status: result.status,
          execution_count: result.executionCount,
          is_error: isError,
          runtime: await sess.getRuntimeStatus().catch(() => undefined),
          ...(replay ? { replay: { replayed: replay.replayed, failed: replay.failed } } : {}),
        },
      };
    },
  });

  // ── jupyter_add_dependencies ─────────────────────────────────────────────

  pi.registerTool<typeof ADD_DEPENDENCIES_PARAMS, { kernel?: string; notebook_id?: string; packages?: string[] }>({
    name: "jupyter_add_dependencies",
    label: "Add Dependencies",
    description:
      "Install packages into a notebook session's kernel without restarting. `notebook` is REQUIRED — the remote contents path of the notebook whose kernel should get the packages (open/continue it first with jupyter_open_notebook, then pass the same path; an already-open session is reused). Python kernels use %pip (pip-style specs like 'matplotlib', 'numpy>=2'); R kernels use install.packages (CRAN names like 'ggplot2'). Reports the real error when installation fails.",
    promptSnippet:
      "jupyter_add_dependencies: install packages into an open notebook's kernel (no restart needed). `notebook` is required — pass the same path you opened with jupyter_open_notebook.",
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

  // ── jupyter_save_notebook ────────────────────────────────────────────────

  pi.registerTool<typeof SAVE_NOTEBOOK_PARAMS, { kernel?: string; notebook_id: string; path?: string }>({
    name: "jupyter_save_notebook",
    label: "Save Notebook",
    description:
      "Save the session of a notebook as an .ipynb file (openable in Jupyter / VSCode). `notebook` is REQUIRED — the remote contents path of the notebook to export (open/continue it first with jupyter_open_notebook, then pass the same path). Prefer an absolute path or ~/ — relative paths resolve against the current working directory, not the pi process directory.",
    promptSnippet: "jupyter_save_notebook: save the current session as an .ipynb file.",
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
