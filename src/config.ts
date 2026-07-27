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
 * Optional config file: ~/.jupyter-remote-shim/config.json
 *   { "url": "...", "token": "...", "kernelName": "python3", ... }
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
}

const CONFIG_HINT =
  "[pi-jupyter] Remote Jupyter Server is not configured.\n" +
  "  export JUPYTER_REMOTE_URL=http://host:port      # e.g. http://192.168.105.1:57002\n" +
  "  export JUPYTER_REMOTE_TOKEN=<your-token>\n" +
  'Optional: ~/.jupyter-remote-shim/config.json with {"url","token","kernelName"}.';

/**
 * Load config with env > file > default priority.
 * @param env  Injected for testing (defaults to `process.env`).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ShimConfig {
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(
      readFileSync(join(homedir(), ".jupyter-remote-shim", "config.json"), "utf-8"),
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
