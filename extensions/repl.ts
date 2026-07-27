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
 * Config (env vars):
 *   JUPYTER_REMOTE_URL    e.g. http://192.168.105.1:57002
 *   JUPYTER_REMOTE_TOKEN  e.g. 123456
 *   JUPYTER_KERNEL_NAME   default "python3" (must be a kernelspec *name*,
 *                         e.g. "ir" for R — not the display name "R")
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
import {
  ADD_DEPENDENCIES_PARAMS,
  JUPYTER_PARAMS,
  SAVE_NOTEBOOK_PARAMS,
  type AddDependenciesParams,
  type JupyterParams,
  type SaveNotebookParams,
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

  // ── session lifecycle (lazy, concurrent-safe) ───────────────────────────

  let session: Session | null = null;
  let opening: Promise<Session> | null = null;
  let nextExecCount: number | null = 1;

  async function addDepsAndSync(sess: Session, packages: string[]): Promise<void> {
    const unique = [...new Set(packages.map((p) => p.trim()).filter(Boolean))];
    if (!unique.length) return;
    await sess.addDependencies(unique);
    await sess.syncEnvironment();
  }

  async function ensureSession(initialDeps: string[] = [], cwd?: string): Promise<Session> {
    const deps = [...new Set(initialDeps.map((p) => p.trim()).filter(Boolean))];
    if (session) {
      await addDepsAndSync(session, deps);
      return session;
    }
    if (opening) {
      const opened = await opening;
      await addDepsAndSync(opened, deps);
      return opened;
    }
    opening = (async () => {
      const config = loadConfig();
      const server = new JupyterServer(config);
      const sess = new RemoteSession(server, config, {
        runtime: "jupyter",
        workingDir: cwd ?? config.workingDir,
        peerLabel: "pi",
        description: "pi remote Jupyter REPL",
        dependencies: deps,
      });
      await sess.initialize();
      session = sess;
      return sess;
    })();
    try {
      return await opening;
    } finally {
      opening = null;
    }
  }

  // ── jupyter_repl ─────────────────────────────────────────────────────────

  pi.registerTool<typeof JUPYTER_PARAMS, unknown, InCallState>({
    name: "jupyter_repl",
    label: "Jupyter REPL",
    description:
      "Execute code in a persistent REPL on a remote Jupyter Server. Backed by a real Jupyter kernel (e.g. python3, or ir for R). Variables, imports, and state stick around between calls. The last expression is the result; use print() for intermediate output. Images are returned inline.",
    promptSnippet:
      "jupyter_repl: run code on a remote Jupyter kernel (variables and imports persist; returns stdout + last expression + images).",
    promptGuidelines: [
      "Use `jupyter_repl` for data analysis, plotting, and multi-step workflows. State persists between calls in a real remote Jupyter kernel.",
      "Variables and imports stick around. No need to re-import or redefine on every turn unless the user has reset the session.",
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
      const count = nextExecCount;
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

      if (count != null) nextExecCount = count + 1;

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
      const sess = await ensureSession(params.dependencies ?? [], ctx.cwd);
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

  pi.registerTool<typeof ADD_DEPENDENCIES_PARAMS, { notebook_id?: string; packages?: string[] }>({
    name: "jupyter_add_dependencies",
    label: "Add Dependencies",
    description:
      "Install packages into the remote kernel's environment without restarting. Python kernels use %pip (pip-style specs like 'matplotlib', 'numpy>=2'); R kernels use install.packages (CRAN names like 'ggplot2'). Reports the real error when installation fails.",
    promptSnippet:
      "jupyter_add_dependencies: install packages into the remote kernel session (no restart needed).",
    parameters: ADD_DEPENDENCIES_PARAMS,
    async execute(_toolCallId, params: AddDependenciesParams, signal) {
      if (signal?.aborted) throw new Error("aborted");
      if (!params.packages.length) {
        return { content: [{ type: "text", text: "No packages given." }], details: {} };
      }
      const sess = await ensureSession();
      try {
        await addDepsAndSync(sess, params.packages);
      } catch (err) {
        // Surface the REAL failure (wrong language, network, CRAN error, …)
        // instead of pretending the install succeeded (BUG-1).
        return {
          content: [
            {
              type: "text",
              text: `Failed to install into ${sess.notebookId}: ${(err as Error).message}`,
            },
          ],
          details: { notebook_id: sess.notebookId, packages: params.packages },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Installed into ${sess.notebookId}: ${params.packages.join(", ")}`,
          },
        ],
        details: { notebook_id: sess.notebookId, packages: params.packages },
      };
    },
  });

  // ── jupyter_save_notebook ────────────────────────────────────────────────

  pi.registerTool<typeof SAVE_NOTEBOOK_PARAMS, { notebook_id: string; path?: string }>({
    name: "jupyter_save_notebook",
    label: "Save Notebook",
    description:
      "Save the current session as an .ipynb file (openable in Jupyter / VSCode). Prefer an absolute path or ~/ — relative paths resolve against the current working directory, not the pi process directory.",
    promptSnippet: "jupyter_save_notebook: save the current session as an .ipynb file.",
    parameters: SAVE_NOTEBOOK_PARAMS,
    async execute(_toolCallId, params: SaveNotebookParams, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("aborted");
      const sess = await ensureSession();
      // Resolve relative paths against the pi working directory (ctx.cwd), NOT
      // the pi *process* cwd — under npx those are different places (BUG-3).
      const base = ctx?.cwd ?? process.cwd();
      const savePath = params.path
        ? resolvePath(params.path, base)
        : path.resolve(base, `${sess.notebookId}.ipynb`);
      const where = await sess.saveNotebook(savePath);
      return {
        content: [{ type: "text", text: `Notebook saved to ${where}` }],
        details: { notebook_id: sess.notebookId, path: where },
      };
    },
  });

  // ── /jupyter-reset ───────────────────────────────────────────────────────

  pi.registerCommand("jupyter-reset", {
    description:
      "Start fresh: next jupyter_repl call opens a new remote kernel (clean slate, no prior variables or imports)",
    handler: async (_args, ctx) => {
      const old = session;
      session = null;
      nextExecCount = 1;
      if (old) {
        try {
          await old.shutdown();
        } catch {
          /* ignore */
        }
      }
      ctx.ui.notify(
        "Kernel session closed. Next jupyter_repl call will start a fresh remote kernel.",
        "info",
      );
    },
  });

  // ── cleanup on shutdown ─────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    if (session) {
      try {
        await session.shutdown();
      } catch {
        /* ignore */
      }
      session = null;
    }
  });
}
