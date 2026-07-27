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
 *   JUPYTER_KERNEL_NAME   default "python3"
 *
 * After editing, run `/reload` in pi.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import path from "node:path";
import { isConfigured, loadConfig } from "../src/config";
import type { Session } from "../src/domain/types";
import { JupyterServer } from "../src/kernel/server";
import { RemoteSession } from "../src/session";
import { formatResult } from "./format";
import {
  ADD_DEPENDENCIES_PARAMS,
  PYTHON_PARAMS,
  SAVE_NOTEBOOK_PARAMS,
  type AddDependenciesParams,
  type PythonParams,
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

const CONFIG_HINT =
  "Remote Jupyter is not configured. Set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN.";

export default function piJupyterExtension(pi: ExtensionAPI) {
  if (!isConfigured()) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(CONFIG_HINT, "warning");
    });
    pi.registerTool({
      name: "python_repl",
      label: "Python REPL",
      description:
        "Execute Python on a remote Jupyter Server. Not configured: set JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN.",
      promptSnippet:
        "python_repl: requires JUPYTER_REMOTE_URL and JUPYTER_REMOTE_TOKEN to be set.",
      parameters: PYTHON_PARAMS,
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

  async function ensureSession(initialDeps: string[] = []): Promise<Session> {
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
        runtime: "python",
        workingDir: process.cwd(),
        peerLabel: "pi",
        description: "pi remote Python REPL",
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

  // ── python_repl ─────────────────────────────────────────────────────────

  pi.registerTool<typeof PYTHON_PARAMS, unknown, InCallState>({
    name: "python_repl",
    label: "Python REPL",
    description:
      "Execute Python in a persistent REPL on a remote Jupyter Server. Backed by a real IPython kernel. Variables, imports, and state stick around between calls. The last expression is the result; use print() or display() for intermediate output. Images (matplotlib, PIL) are returned inline.",
    promptSnippet:
      "python_repl: run Python on a remote Jupyter kernel (variables and imports persist; returns stdout + last expression + images).",
    promptGuidelines: [
      "Use `python_repl` for data analysis, plotting, and multi-step workflows. State persists between calls in a real remote IPython kernel.",
      "Variables and imports stick around. No need to re-import or redefine on every turn unless the user has reset the session.",
      "The last expression is the result; use print() or display() for intermediate output.",
      "Images (matplotlib, PIL) come back inline. The user sees them if their terminal supports graphics.",
      "Pass `dependencies` on the first call to pre-install packages before the kernel starts.",
      "Use `python_add_dependencies` to install packages mid-session without restarting the kernel.",
    ],
    parameters: PYTHON_PARAMS,

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

    async execute(_toolCallId, params: PythonParams, signal, onUpdate) {
      if (signal?.aborted) throw new Error("aborted");
      const sess = await ensureSession(params.dependencies ?? []);
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

  // ── python_add_dependencies ─────────────────────────────────────────────

  pi.registerTool<typeof ADD_DEPENDENCIES_PARAMS, { notebook_id?: string; packages?: string[] }>({
    name: "python_add_dependencies",
    label: "Add Dependencies",
    description:
      "Install packages into the remote kernel's environment without restarting. Accepts pip-style specs like 'matplotlib', 'numpy>=2', 'requests'. Uses %pip so packages land in the kernel's own environment.",
    promptSnippet:
      "python_add_dependencies: install packages into the remote Python session (no restart needed).",
    parameters: ADD_DEPENDENCIES_PARAMS,
    async execute(_toolCallId, params: AddDependenciesParams, signal) {
      if (signal?.aborted) throw new Error("aborted");
      if (!params.packages.length) {
        return { content: [{ type: "text", text: "No packages given." }], details: {} };
      }
      const sess = await ensureSession();
      await addDepsAndSync(sess, params.packages);
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

  // ── python_save_notebook ────────────────────────────────────────────────

  pi.registerTool<typeof SAVE_NOTEBOOK_PARAMS, { notebook_id: string; path?: string }>({
    name: "python_save_notebook",
    label: "Save Notebook",
    description:
      "Save the current session as an .ipynb file (openable in Jupyter / VSCode). If no path is given, saves to <notebook-id>.ipynb in the current directory.",
    promptSnippet: "python_save_notebook: save the current session as an .ipynb file.",
    parameters: SAVE_NOTEBOOK_PARAMS,
    async execute(_toolCallId, params: SaveNotebookParams, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const sess = await ensureSession();
      const savePath = params.path ? resolvePath(params.path) : undefined;
      await sess.saveNotebook(savePath);
      const where = savePath ?? `${sess.notebookId}.ipynb`;
      return {
        content: [{ type: "text", text: `Notebook saved to ${where}` }],
        details: { notebook_id: sess.notebookId, path: savePath },
      };
    },
  });

  // ── /python-reset ───────────────────────────────────────────────────────

  pi.registerCommand("python-reset", {
    description:
      "Start fresh: next python_repl call opens a new remote kernel (clean slate, no prior variables or imports)",
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
        "Python session closed. Next python_repl call will start a fresh remote kernel.",
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
