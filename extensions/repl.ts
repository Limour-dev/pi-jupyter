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
 * Kernel selection — which kernel runs the code (python3, ir, …) — is the
 * AGENT's decision:
 *   - The Jupyter Server connection (url/token) is user-configured via env vars.
 *   - The kernels are discovered at runtime with `jupyter_list_kernels` and
 *     picked per call via the `kernel` parameter — NOT configured in advance.
 *   - What each kernel is FOR is remembered across sessions in
 *     ~/.pi-jupyter/purposes.json (`jupyter_set_kernel_purpose`). Only a
 *     newly discovered kernel with no recorded purpose triggers a question to
 *     the user; recorded kernels are shown with their purpose and reused.
 *
 * Notebooks — continuity across conversations (`jupyter_open_notebook`,
 * `jupyter_list_notebooks`):
 *   - A session is bound to a REMOTE contents path (e.g. "notes/pi.ipynb") —
 *     the same path is the /api/sessions bind row and the auto-save target.
 *   - Opening an existing notebook path first looks for a LIVE kernel bound to
 *     it on the server and ATTACHES to it (no new kernel; in-memory variables
 *     survive). Otherwise it starts a new kernel bound to the SAME path and
 *     seeds the document from the file's cells (run them again to rebuild
 *     state); a missing file starts the document empty.
 *   - Known paths are persisted in ~/.pi-jupyter/notebooks.json so a NEW
 *     conversation can list and resume them. When `keepKernels` is on (default),
 *     kernels are NOT killed when the conversation ends — they keep running on
 *     the server so a later conversation or the browser can re-attach. Clean up
 *     with jupyter_shutdown_notebook or /jupyter-reset.
 *
 * Legacy anonymous calls (no `notebook` param) keep one session per kernel,
 * so switching python3 ↔ ir back and forth never loses either kernel's state.

 * Config (env vars):
 *   JUPYTER_REMOTE_URL    e.g. http://192.168.105.1:57002   (user-set)
 *   JUPYTER_REMOTE_TOKEN  e.g. 123456                       (user-set)
 *   JUPYTER_KERNEL_NAME   OPTIONAL fallback default kernel (a kernelspec
 *                         *name*, e.g. "ir" — not the display name "R");
 *                         used only when a tool call omits `kernel`
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
 *   JUPYTER_REMOTE_SAVE_PATH   remote contents path override, e.g.
 *                              "notes/pi.ipynb" (default: <notebookId>.ipynb)
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
  // Two kinds of session coexist:
  //   * Notebook sessions — keyed by their remote contents path. The path is
  //     both the /api/sessions bind row and the auto-save target, so a LATER
  //     conversation (or a browser) can resume exactly that file — attaching to
  //     the still-running kernel when there is one (no restart, variables kept).
  //   * Anonymous sessions — legacy per-kernel sessions for calls that pass no
  //     `notebook` (one per kernelspec name, so python3 ↔ ir switching is safe).
  const sessionsByKernel = new Map<string, Session>();
  const sessionsByPath = new Map<string, Session>();
  const openings = new Map<string, Promise<Session>>();
  /** Per-kernel display counter for the In[n] / Out[n] call rendering. */
  const execCounts = new Map<string, number | null>();
  /** Cached default kernelspec of the server (used when no kernel is passed). */
  let serverDefault: string | null | undefined;

  /**
   * Resolve which kernel a call targets. Explicit `kernel` param wins; else
   * the optional `kernelName` fallback from config/env; else the server's
   * default kernelspec; else "python3" as a last resort.
   */
  async function resolveKernel(requested: string | undefined): Promise<string> {
    const name = requested?.trim();
    if (name) return name;
    if (config.kernelName) return config.kernelName;
    if (serverDefault === undefined) {
      const server = new JupyterServer(config);
      try {
        const specs = await server.listKernelSpecs();
        serverDefault = specs.default || specs.specs[0]?.name || null;
      } catch {
        serverDefault = null;
      } finally {
        try { server.dispose(); } catch { /* ignore */ }
      }
    }
    return serverDefault ?? "python3";
  }

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

  /** Legacy anonymous session per kernel (no `notebook` path given). */
  async function ensureAnonymousSession(
    kernelParam?: string,
    initialDeps: string[] = [],
    cwd?: string,
  ): Promise<Session> {
    const deps = [...new Set(initialDeps.map((p) => p.trim()).filter(Boolean))];
    const kernel = await resolveKernel(kernelParam);
    const existing = sessionsByKernel.get(kernel);
    if (existing) {
      await addDepsAndSync(existing, deps);
      return existing;
    }
    let opening = openings.get(`kernel:${kernel}`);
    if (!opening) {
      opening = (async () => {
        const server = new JupyterServer(config);
        try {
          const sess = new RemoteSession(server, config, {
            kernelName: kernel,
            runtime: "jupyter",
            workingDir: cwd ?? config.workingDir,
            peerLabel: "pi",
            description: `pi remote Jupyter REPL (kernel ${kernel})`,
            dependencies: deps,
          });
          await sess.initialize();
          sessionsByKernel.set(kernel, sess);
          execCounts.set(kernel, 1);
          rememberNotebook(sess, "remote");
          return sess;
        } catch (err) {
          try { server.dispose(); } catch { /* ignore */ }
          throw err;
        }
      })();
      openings.set(`kernel:${kernel}`, opening);
    }
    try {
      const opened = await opening;
      await addDepsAndSync(opened, deps);
      return opened;
    } finally {
      openings.delete(`kernel:${kernel}`);
    }
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
    deps?: string[];
    cwd?: string;
    source?: "remote" | "local";
    localFile?: string;
  }): Promise<{ session: Session; opened: boolean; outcome: ResumeOutcome | undefined }> {
    const path = normalizeContentsPath(opts.path); // "/a.ipynb" and "a.ipynb" are the SAME file
    const existing = sessionsByPath.get(path);
    if (existing) {
      if (opts.deps?.length) await addDepsAndSync(existing, opts.deps);
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
      if (opts.deps?.length) await addDepsAndSync(session, opts.deps);
      rememberNotebook(session, opts.source ?? "remote", opts.localFile);
      return { session, opened: true, outcome: session.resumeOutcome };
    } finally {
      openings.delete(`path:${path}`);
    }
  }

  /**
   * Target session for a tool call: an explicit notebook path wins; otherwise
   * the legacy anonymous per-kernel session.
   */
  async function ensureTarget(opts: {
    kernel?: string;
    notebook?: string;
    deps?: string[];
    cwd?: string;
  }): Promise<Session> {
    const notebook = opts.notebook?.trim();
    if (notebook) {
      const { session } = await ensureNotebookSession({
        path: notebook,
        kernel: opts.kernel,
        deps: opts.deps,
        cwd: opts.cwd,
      });
      return session;
    }
    return ensureAnonymousSession(opts.kernel, opts.deps, opts.cwd);
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
        "  Pass one of these names as `kernel` to jupyter_repl / jupyter_add_dependencies / jupyter_save_notebook.",
        "",
      ];
      for (const s of specs) {
        const marks: string[] = [];
        if (s.name === def) marks.push("server default");
        if (config.kernelName && s.name === config.kernelName) marks.push("config fallback");
        if (sessionsByKernel.has(s.name) || [...sessionsByPath.values()].some((se) => se.kernelName === s.name)) {
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
          session_open: [
            ...sessionsByKernel.keys(),
            ...sessionsByPath.keys(),
          ],
        },
      };
    } finally {
      try { server.dispose(); } catch { /* ignore */ }
    }
  }

  /**
   * Human + structured view of the notebooks the agent can CONTINUE:
   * registry entries (~/.pi-jupyter/notebooks.json) merged with the server's
   * live /api/sessions rows. A live row means "attach — kernel still running,
   * variables preserved"; a registry-only path means "resume from file — a new
   * kernel is started bound to the same path, re-run the cells you need".
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
      "  Pass one of these contents paths as `notebook` to jupyter_repl / jupyter_add_dependencies / jupyter_save_notebook,",
      "  or open one explicitly with jupyter_open_notebook.",
      "",
    ];
    if (merged.size === 0) {
      lines.push("  (none yet — run a jupyter_repl or open a path with jupyter_open_notebook to create one)");
    } else {
      for (const [path, info] of [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const marks: string[] = [];
        if (info.live) marks.push("LIVE kernel — open attaches, variables kept");
        else marks.push("file only — open resumes it with a new kernel (re-run setup cells)");
        if (info.open) marks.push("open in this conversation");
        if (info.source === "local" && info.localFile) marks.push(`imported from ${info.localFile}`);
        const purpose = purposes[info.kernel];
        lines.push(`  - ${path}  (kernel ${info.kernel})${purpose ? `  [purpose: ${purpose}]` : ""}`);
        lines.push(`      ${marks.join(" | ")}${info.updated ? ` | last used ${info.updated.slice(0, 10)}` : ""}`);
      }
    }
    lines.push(
      "",
      "To continue a notebook in a NEW conversation: pick its path and pass it to jupyter_open_notebook",
      "(or jupyter_repl with `notebook`). If a LIVE kernel is bound to it, the tool ATTACHES to that",
      "kernel — nothing restarts and in-memory variables are kept. Otherwise a fresh kernel is started",
      "bound to the same path and the file's cells are loaded: re-run the setup cells to rebuild state.",
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
      "List the notebooks available to CONTINUE on the remote Jupyter Server — every contents path pi has opened (~/.pi-jupyter/notebooks.json) merged with the live /api/sessions rows. Each entry shows its kernel and whether a LIVE kernel is bound to it: pass the path to jupyter_open_notebook (or `notebook` on jupyter_repl) to continue — attaching to the live kernel (variables preserved, no new kernel) or resuming the file with a new kernel bound to the same path.",
    promptSnippet:
      "jupyter_list_notebooks: list notebooks available to continue (live kernels attach with variables intact; files resume with a new kernel).",
    promptGuidelines: [
      "Call this when the user wants to CONTINUE earlier work (or just named a notebook): it shows the paths to pass as `notebook` / `path`.",
      "A path marked LIVE has a kernel still running on the server — opening it ATTACHES (no restart, in-memory variables preserved).",
      "A path marked 'file only' resumes from the saved .ipynb with a NEW kernel bound to that same path — tell the user variables were not preserved, then re-run the setup cells.",
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
      "List the kernels available on the remote Jupyter Server — the python3 / ir / … kernelspecs that can execute code, each annotated with its recorded purpose (persisted across sessions). Only a kernel with no recorded purpose is NEW: ask the user what it is for, record it with jupyter_set_kernel_purpose, then auto-select the right kernel per task. The server address itself is already configured by the user and is never chosen here.",
    promptSnippet:
      "jupyter_list_kernels: list the kernels on the configured Jupyter Server so the agent can pick the right one for the task.",
    promptGuidelines: [
      "A kernel is what executes code (python3, ir, …) — the Jupyter Server url/token is configured by the user and never selected.",
      "Call this BEFORE the first jupyter_repl call. Kernels whose purpose is already recorded (persisted in ~/.pi-jupyter/purposes.json) are shown with it — pick them directly, never re-ask.",
      "Only a kernel marked 'purpose: not recorded' is NEW: ask the user once what it is for, then record it with `jupyter_set_kernel_purpose`. After that every session shows the purpose and you auto-select it.",
      "Pass the chosen name as the `kernel` parameter of jupyter_repl (kernelspec *name*: \"ir\", not \"R\").",
      "Each kernel keeps its own persistent session, so switching kernels is safe and state is preserved per kernel.",
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
      "Record what a kernel (kernelspec name) is for, as the user explained — persisted across sessions in ~/.pi-jupyter/purposes.json, so jupyter_list_kernels shows it later and the agent auto-selects without re-asking. Call this right after the user describes a kernel that jupyter_list_kernels marked as having no recorded purpose. Use kernelspec *names* only (\"ir\", not \"R\").",
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
      "Open an existing notebook and CONTINUE it. `path` is a remote contents path (e.g. \"notes/pi.ipynb\", as listed by jupyter_list_notebooks) or `local_file` is a .ipynb on this machine to import under its file name and then continue. If a LIVE kernel is bound to the path, this ATTACHES to that kernel — no new kernel is started, so in-memory variables from the earlier session survive. Otherwise a NEW kernel is started bound to the SAME path and the file's cells are loaded into the document (re-run the setup cells to rebuild state); a path with no file yet just starts the document empty. The kernel comes from the `kernel` param, else from the notebook file's recorded kernelspec, else the configured fallback.",
    promptSnippet:
      "jupyter_open_notebook: continue an existing notebook — attach to its live kernel (variables kept) or resume its file with a new kernel bound to the same path.",
    promptGuidelines: [
      "In a NEW conversation, when the user wants to continue earlier work, list candidates with jupyter_list_notebooks (or ask which file), then open the chosen path here.",
      "If the result says 'attached', the previous kernel is still running — variables/imports are intact, just keep working.",
      "If it says 'started'/'created', a NEW kernel was started: in-memory variables were NOT preserved. The result lists the file's code cells; re-run the setup cells with jupyter_repl (passing this notebook path) to rebuild state. Re-running a cell whose source exactly matches a loaded cell executes it IN PLACE — the notebook keeps one copy, like JupyterLab.",
      "Then keep passing the same `notebook` path on jupyter_repl / jupyter_add_dependencies / jupyter_save_notebook calls.",
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
          lines.push(`The notebook file existed and its ${cells.length} code cell(s) are loaded into the document.`);
        } else {
          lines.push("No file existed at that path yet — the notebook starts empty and will be auto-saved there.");
        }
        lines.push("To rebuild state, re-run the setup cells below (same source → executed in place, no duplicates).");
      } else {
        lines.push(`Notebook ${openPath} is already open in this conversation (kernel ${session.kernelName}).`);
      }
      lines.push("");
      if (cells.length) {
        lines.push(`Code cells (pass any source to jupyter_repl(notebook="${openPath}", code=<source>) to run):`);
        cells.forEach((c, i) => {
          const one = c.source.replace(/\s+/g, " ").trim().slice(0, 140);
          lines.push(`  [${i}] (exec ${c.executionCount ?? "-"}${c.restored ? ", restored" : ", ran"}) ${one}`);
        });
      } else {
        lines.push("No code cells yet.");
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
        },
      };
    },
  });

  // ── jupyter_shutdown_notebook ─────────────────────────────────────────────

  pi.registerTool<typeof SHUTDOWN_NOTEBOOK_PARAMS, Record<string, unknown>>({
    name: "jupyter_shutdown_notebook",
    label: "Shut Down Notebook Kernel",
    description:
      "Shut down a notebook's kernel: kill the kernel and drop its session row on the server (the .ipynb file stays on the server; it can be resumed later, but with a fresh kernel and no in-memory variables). Use /jupyter-reset to shut down everything.",
    promptSnippet:
      "jupyter_shutdown_notebook: kill one notebook's kernel (file stays, resume restarts a fresh kernel).",
    parameters: SHUTDOWN_NOTEBOOK_PARAMS,
    async execute(_toolCallId, params: ShutdownNotebookParams) {
      const path = normalizeContentsPath(params.path);
      const sess = sessionsByPath.get(path);
      if (!sess) throw new Error(`[pi-jupyter] notebook ${path} is not open in this conversation.`);
      await sess.shutdown();
      sessionsByPath.delete(path);
      execCounts.delete(sess.kernelName);
      return {
        content: [{ type: "text", text: `Kernel serving ${path} shut down (file kept; a future open resumes it with a fresh kernel).` }],
        details: { path, kernel: sess.kernelName },
      };
    },
  });
  // ── jupyter_repl ─────────────────────────────────────────────────────────

  pi.registerTool<typeof JUPYTER_PARAMS, unknown, InCallState>({
    name: "jupyter_repl",
    label: "Jupyter REPL",
    description:
      "Execute code in a persistent REPL on a remote Jupyter Server. Backed by a real Jupyter kernel (e.g. python3, or ir for R). Variables, imports, and state stick around between calls. Pass `notebook` (a contents path from jupyter_list_notebooks) to run in an EXISTING notebook — the call attaches to its live kernel when one is running (variables preserved, no restart) or opens it first (new kernel bound to the same path). The last expression is the result; use print() for intermediate output. Images are returned inline.",
    promptSnippet:
      "jupyter_repl: run code on a remote Jupyter kernel (variables and imports persist; returns stdout + last expression + images). Pass `notebook` to continue an existing notebook.",
    promptGuidelines: [
      "Use `jupyter_repl` for data analysis, plotting, and multi-step workflows. State persists between calls in a real remote Jupyter kernel.",
      "The `kernel` parameter chooses WHICH kernel runs the code. Discover kernels with `jupyter_list_kernels`; if you do not know what each kernel is for, ask the user, then pick the matching one per task automatically.",
      "To CONTINUE an existing notebook (earlier conversation, saved file, or a notebook the user opened in the browser), pass its path as `notebook` (see jupyter_list_notebooks). Keep passing that same path on every call so the work lands in the same file and — when its kernel is still running — on the same kernel.",
      "A `kernel`-only call (no `notebook`) uses that kernel's anonymous session — a DIFFERENT session from any open notebook. After opening a notebook, always pass its `notebook` path.",
      "Variables and imports stick around on each kernel/session. No need to re-import or redefine on every turn unless the user has reset the session.",
      "The last expression is the result; use print() or display() for intermediate output.",
      "Images (matplotlib, PIL) come back inline. The user sees them if their terminal supports graphics.",
      "Pass `dependencies` on the first call to pre-install packages before the kernel starts.",
      "Use `jupyter_add_dependencies` to install packages mid-session without restarting the kernel.",
    ],
    parameters: JUPYTER_PARAMS,

    renderCall(args, theme, _context) {
      const text =
        (_context.lastComponent as InstanceType<typeof Text> | undefined) ?? new Text("", 0, 0);
      const code = (args?.code ?? "").replace(/^\n+/, "");
      const key = args?.kernel?.trim() || config.kernelName || "default";
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
      const sess = await ensureTarget({
        kernel: params.kernel,
        notebook: params.notebook,
        deps: params.dependencies ?? [],
        cwd: ctx.cwd,
      });
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
        },
      };
    },
  });

  // ── jupyter_add_dependencies ─────────────────────────────────────────────

  pi.registerTool<typeof ADD_DEPENDENCIES_PARAMS, { kernel?: string; notebook_id?: string; packages?: string[] }>({
    name: "jupyter_add_dependencies",
    label: "Add Dependencies",
    description:
      "Install packages into a remote kernel's environment without restarting. `notebook` selects an open/existing notebook (contents path, see jupyter_list_notebooks) — its session's kernel gets the packages. `kernel` selects which kernel (kernelspec name, see jupyter_list_kernels) when no `notebook` is given; omit both to target the default kernel. Python kernels use %pip (pip-style specs like 'matplotlib', 'numpy>=2'); R kernels use install.packages (CRAN names like 'ggplot2'). Reports the real error when installation fails.",
    promptSnippet:
      "jupyter_add_dependencies: install packages into the remote kernel session (no restart needed). Pass `notebook` to target an existing notebook's kernel.",
    parameters: ADD_DEPENDENCIES_PARAMS,
    async execute(_toolCallId, params: AddDependenciesParams, signal) {
      if (signal?.aborted) throw new Error("aborted");
      if (!params.packages.length) {
        return { content: [{ type: "text", text: "No packages given." }], details: {} };
      }
      const sess = await ensureTarget({ kernel: params.kernel, notebook: params.notebook });
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
      "Save the session of a kernel or notebook as an .ipynb file (openable in Jupyter / VSCode). `notebook` selects an open/existing notebook (contents path, see jupyter_list_notebooks); `kernel` selects which kernel's anonymous session to save when no `notebook` is given (kernelspec name, see jupyter_list_kernels). Prefer an absolute path or ~/ — relative paths resolve against the current working directory, not the pi process directory.",
    promptSnippet: "jupyter_save_notebook: save the current session as an .ipynb file.",
    parameters: SAVE_NOTEBOOK_PARAMS,
    async execute(_toolCallId, params: SaveNotebookParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("aborted");
      const sess = await ensureTarget({ kernel: params.kernel, notebook: params.notebook });
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
      "Start fresh: shut down ALL kernel sessions (anonymous + every open notebook) on the server. The saved .ipynb files stay; the next open/jupyter_repl call starts new kernels bound to them (clean slate: no prior variables or imports).",
    handler: async (_args, ctx) => {
      const olds = [...sessionsByKernel.values(), ...sessionsByPath.values()];
      sessionsByKernel.clear();
      sessionsByPath.clear();
      openings.clear();
      execCounts.clear();
      await Promise.allSettled(olds.map((s) => s.shutdown()));
      ctx.ui.notify(
        "Kernel sessions closed. Next jupyter_repl/open call starts fresh kernels (notebook files are kept).",
        "info",
      );
    },
  });

  // ── cleanup on shutdown ─────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    const kernelSessions = [...sessionsByKernel.values()];
    const notebookSessions = [...sessionsByPath.values()];
    sessionsByKernel.clear();
    sessionsByPath.clear();
    openings.clear();
    execCounts.clear();
    // Legacy anonymous (per-kernel, no notebook path) sessions are ALWAYS shut
    // down — they have random throwaway contents paths, and keeping one per
    // conversation would pile kernels up on the server between /jupyter-resets.
    await Promise.allSettled(kernelSessions.map((s) => s.shutdown()));
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
