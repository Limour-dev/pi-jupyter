/**
 * Configuration loading.
 *
 * Priority: environment variables > optional config file > defaults.
 * No server is hard-coded: `JUPYTER_REMOTE_URL` and `JUPYTER_REMOTE_TOKEN`
 * are required (via env or the config file) and we fail fast with a clear
 * message if they are missing.
 *
 *   export JUPYTER_REMOTE_URL=http://192.168.105.1:57002
 *   export JUPYTER_REMOTE_TOKEN=123456
 *
 * Optional config file: ~/.pi-jupyter/config.json
 *   { "url": "...", "token": "...", "kernelName": "python3", ... }
 *
 * Optional extras: JUPYTER_WORKING_DIR (base for relative save paths) and
 * JUPYTER_TIMEOUT_RESTART_KERNEL=1 (auto-restart a kernel still busy after a
 * timeout).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ShimConfig {
  url: string;
  token: string;
  kernelName: string;
  tlsInsecure: boolean;
  defaultTimeoutMs: number;
  installTimeoutMs: number;
  /** Base directory for relative save paths (BUG-3). Defaults to the cwd. */
  workingDir: string;
  /** Restart the kernel when it is still busy after a timeout (BUG-6). */
  timeoutRestartKernel: boolean;
  /** 把内核绑到 /api/sessions 行，使其出现在 Jupyter Running UI。缺省 true。 */
  bindSession?: boolean;
  /** 每次 jupyter_repl 结束后自动把快照落盘到远端。缺省 true（FR-7.1）。 */
  remoteAutoSave: boolean;
  /** 远端 contents 相对 path，覆盖默认的 `${notebookId}.ipynb`（FR-3.4）。 */
  remoteSavePath?: string;
}

export const CONFIG_HINT =
  "[pi-jupyter] Remote Jupyter Server is not configured.\n" +
  "  export JUPYTER_REMOTE_URL=http://host:port      # e.g. http://192.168.105.1:57002\n" +
  "  export JUPYTER_REMOTE_TOKEN=<your-token>\n" +
  'Optional: ~/.pi-jupyter/config.json with {"url","token","kernelName"}.';

/**
 * Load config with env > file > default priority.
 * @param env  Injected for testing (defaults to `process.env`).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ShimConfig {
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(
      readFileSync(join(homedir(), ".pi-jupyter", "config.json"), "utf-8"),
    ) as Record<string, unknown>;
  } catch {
    /* no config file — env vars only */
  }

  const url = env.JUPYTER_REMOTE_URL ?? (file.url as string | undefined);
  const token = env.JUPYTER_REMOTE_TOKEN ?? (file.token as string | undefined);

  if (!url) throw new Error(CONFIG_HINT);
  if (!token) {
    throw new Error(
      "[pi-jupyter] JUPYTER_REMOTE_TOKEN not set. Find it in the remote Jupyter Server logs/config.",
    );
  }

  return {
    url,
    token,
    kernelName:
      env.JUPYTER_KERNEL_NAME ?? (file.kernelName as string | undefined) ?? "python3",
    tlsInsecure:
      env.JUPYTER_REMOTE_TLS_INSECURE === "1" || file.tlsInsecure === true,
    defaultTimeoutMs:
      intEnv(env, "JUPYTER_REMOTE_TIMEOUT_MS") ??
      (file.defaultTimeoutMs as number | undefined) ??
      300_000,
    installTimeoutMs:
      intEnv(env, "JUPYTER_INSTALL_TIMEOUT_MS") ??
      (file.installTimeoutMs as number | undefined) ??
      600_000,
    workingDir:
      env.JUPYTER_WORKING_DIR ?? (file.workingDir as string | undefined) ?? process.cwd(),
    timeoutRestartKernel:
      env.JUPYTER_TIMEOUT_RESTART_KERNEL === "1" || file.timeoutRestartKernel === true,
    bindSession:
      env.JUPYTER_BIND_SESSION === "1" ? true
      : env.JUPYTER_BIND_SESSION === "0" ? false
      : (file.bindSession as boolean | undefined),
    remoteAutoSave:
      env.JUPYTER_REMOTE_AUTOSAVE === "0" ? false
      : env.JUPYTER_REMOTE_AUTOSAVE === "1" ? true
      : (file.remoteAutoSave as boolean | undefined) ?? true,
    remoteSavePath: nonEmpty(
      env.JUPYTER_REMOTE_SAVE_PATH ?? (file.remoteSavePath as string | undefined),
    ),
  };
}

/** True when the minimum required configuration is present. */
export function isConfigured(env: Record<string, string | undefined> = process.env): boolean {
  try {
    loadConfig(env);
    return true;
  } catch {
    return false;
  }
}

function intEnv(env: Record<string, string | undefined>, k: string): number | undefined {
  const v = env[k];
  return v ? Number.parseInt(v, 10) : undefined;
}

/** Trimmed value, or undefined when empty/blank (空串视同未设置). */
function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}
