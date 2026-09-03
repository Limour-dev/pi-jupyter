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
 *
 * Kernel selection — which kernel runs the code (python3, ir, …) — is the
 * AGENT's decision:
 *   - The Jupyter Server connection (url/token) is user-configured via env vars.
 *   - The kernels are discovered at runtime with `jupyter_list_kernels` and
 *     picked per call via the `kernel` parameter — NOT configured in advance.
 *   - What each kernel is FOR is remembered across sessions in
 *     ~/.pi-jupyter/purposes.json (`jupyter_set_kernel_purpose`). Only a
 *     newly discovered kernel with no recorded purpose triggers a question to
 *     the user; recorded kernels are shown with their purpose and reused.
 *   - Each kernel gets its own persistent session, so switching between
 *     kernels never loses another kernel's state.
 *
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
import { homedir } from "node:os";
import path from "node:path";
import { CONFIG_HINT, isConfigured, loadConfig } from "../src/config";
import type { Session } from "../src/domain/types";
import { JupyterServer } from "../src/kernel/server";
import { RemoteSession } from "../src/session";
import { formatResult } from "./format";
import { loadPurposes, savePurposes } from "../src/purposes";
import {
  ADD_DEPENDENCIES_PARAMS,
  JUPYTER_PARAMS,
  LIST_KERNELS_PARAMS,
  SAVE_NOTEBOOK_PARAMS,
  SET_KERNEL_PURPOSE_PARAMS,
  type AddDependenciesParams,
  type JupyterParams,
  type SaveNotebookParams,
  type SetKernelPurposeParams,
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
  return path.isAbsolute(expanded) ? expanded : path.resolve(workingDir, expanded);
}

function expandHome(userPath: string): string {
  if (userPath === "~") return homedir();
  if (userPath.startsWith("~/") || userPath.startsWith("~\\")) {
    return path.join(homedir(), userPath.slice(2));
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

  // ── session lifecycle (per kernel, lazy, concurrent-safe) ─────────────────
  // One persistent session per kernel (a kernelspec name such as "python3" /
  // "ir"), so the agent can switch python3 ↔ ir freely without losing either
  // kernel's state.
  const sessions = new Map<string, Session>();
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

  async function ensureSession(
    kernelParam?: string,
    initialDeps: string[] = [],
    cwd?: string,
  ): Promise<Session> {
    const deps = [...new Set(initialDeps.map((p) => p.trim()).filter(Boolean))];
    const kernel = await resolveKernel(kernelParam);
    const existing = sessions.get(kernel);
    if (existing) {
      await addDepsAndSync(existing, deps);
      return existing;
    }
    let opening = openings.get(kernel);
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
          sessions.set(kernel, sess);
          execCounts.set(kernel, 1);
          return sess;
        } catch (err) {
          try { server.dispose(); } catch { /* ignore */ }
          throw err;
        }
      })();
      openings.set(kernel, opening);
    }
    try {
      const opened = await opening;
      await addDepsAndSync(opened, deps);
      return opened;
    } finally {
      openings.delete(kernel);
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
        "  Pass one of these names as `kernel` to jupyter_repl / jupyter_add_dependencies / jupyter_save_notebook.",
        "",
      ];
      for (const s of specs) {
        const marks: string[] = [];
        if (s.name === def) marks.push("server default");
        if (config.kernelName && s.name === config.kernelName) marks.push("config fallback");
        if (sessions.has(s.name)) marks.push("session open (state persists)");
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
          session_open: [...sessions.keys()],
        },
      };
    } finally {
      try { server.dispose(); } catch { /* ignore */ }
    }
  }

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

  // ── jupyter_repl ─────────────────────────────────────────────────────────

  pi.registerTool<typeof JUPYTER_PARAMS, unknown, InCallState>({
    name: "jupyter_repl",
    label: "Jupyter REPL",
    description:
      "Execute code in a persistent REPL on a remote Jupyter Server. Backed by a real Jupyter kernel (e.g. python3, or ir for R). Variables, imports, and state stick around between calls on the same kernel. The last expression is the result; use print() for intermediate output. Images are returned inline.",
    promptSnippet:
      "jupyter_repl: run code on a remote Jupyter kernel (variables and imports persist; returns stdout + last expression + images).",
    promptGuidelines: [
      "Use `jupyter_repl` for data analysis, plotting, and multi-step workflows. State persists between calls in a real remote Jupyter kernel.",
      "The `kernel` parameter chooses WHICH kernel runs the code. Discover kernels with `jupyter_list_kernels`; if you do not know what each kernel is for, ask the user, then pick the matching one per task automatically.",
      "Variables and imports stick around on each kernel. No need to re-import or redefine on every turn unless the user has reset the session.",
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
      const sess = await ensureSession(params.kernel, params.dependencies ?? [], ctx.cwd);
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
      "Install packages into a remote kernel's environment without restarting. `kernel` selects which kernel (kernelspec name, see jupyter_list_kernels); omit to target the default kernel. Python kernels use %pip (pip-style specs like 'matplotlib', 'numpy>=2'); R kernels use install.packages (CRAN names like 'ggplot2'). Reports the real error when installation fails.",
    promptSnippet:
      "jupyter_add_dependencies: install packages into the remote kernel session (no restart needed).",
    parameters: ADD_DEPENDENCIES_PARAMS,
    async execute(_toolCallId, params: AddDependenciesParams, signal) {
      if (signal?.aborted) throw new Error("aborted");
      if (!params.packages.length) {
        return { content: [{ type: "text", text: "No packages given." }], details: {} };
      }
      const sess = await ensureSession(params.kernel);
      try {
        await addDepsAndSync(sess, params.packages);
      } catch (err) {
        // Surface the REAL failure (wrong language, network, CRAN error, …)
        // instead of pretending the install succeeded (BUG-1).
        return {
          content: [
            {
              type: "text",
              text: `Failed to install into ${sess.notebookId} (kernel ${sess.kernelName}): ${(err as Error).message}`,
            },
          ],
          details: { kernel: sess.kernelName, notebook_id: sess.notebookId, packages: params.packages },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Installed into ${sess.notebookId} (kernel ${sess.kernelName}): ${params.packages.join(", ")}`,
          },
        ],
        details: { kernel: sess.kernelName, notebook_id: sess.notebookId, packages: params.packages },
      };
    },
  });

  // ── jupyter_save_notebook ────────────────────────────────────────────────

  pi.registerTool<typeof SAVE_NOTEBOOK_PARAMS, { kernel?: string; notebook_id: string; path?: string }>({
    name: "jupyter_save_notebook",
    label: "Save Notebook",
    description:
      "Save the session of a kernel as an .ipynb file (openable in Jupyter / VSCode). `kernel` selects which kernel's session to save (kernelspec name, see jupyter_list_kernels); omit to save the default kernel's session. Prefer an absolute path or ~/ — relative paths resolve against the current working directory, not the pi process directory.",
    promptSnippet: "jupyter_save_notebook: save the current session as an .ipynb file.",
    parameters: SAVE_NOTEBOOK_PARAMS,
    async execute(_toolCallId, params: SaveNotebookParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("aborted");
      const sess = await ensureSession(params.kernel);
      // Resolve relative paths against the pi working directory (ctx.cwd), NOT
      // the pi *process* cwd — under npx those are different places (BUG-3).
      const base = ctx?.cwd ?? process.cwd();
      const savePath = params.path
        ? resolvePath(params.path, base)
        : path.resolve(base, `${sess.notebookId}.ipynb`);
      const where = await sess.saveNotebook(savePath);
      return {
        content: [{ type: "text", text: `Notebook (kernel ${sess.kernelName}) saved to ${where}` }],
        details: { kernel: sess.kernelName, notebook_id: sess.notebookId, path: where },
      };
    },
  });

  // ── /jupyter-reset ───────────────────────────────────────────────────────

  pi.registerCommand("jupyter-reset", {
    description:
      "Start fresh: close ALL kernel sessions — the next jupyter_repl call opens new remote kernels (clean slate, no prior variables or imports)",
    handler: async (_args, ctx) => {
      const olds = [...sessions.values()];
      sessions.clear();
      openings.clear();
      execCounts.clear();
      await Promise.allSettled(olds.map((s) => s.shutdown()));
      ctx.ui.notify(
        "Kernel sessions closed. Next jupyter_repl call will start fresh kernels.",
        "info",
      );
    },
  });

  // ── cleanup on shutdown ─────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    const olds = [...sessions.values()];
    sessions.clear();
    openings.clear();
    execCounts.clear();
    for (const s of olds) {
      try {
        await s.shutdown();
      } catch {
        /* ignore */
      }
    }
  });
}
