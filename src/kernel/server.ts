/**
 * JupyterServer — ServerConnection + KernelManager, implementing ServerPort.
 *
 * This is the literal "reuse JupyterLab's REST API" landing point (C2): the
 * official JupyterLab TypeScript client talks to the remote Jupyter Server's
 * standard REST + WebSocket API.  No custom backend.
 *
 * Auth note (verified against a live server): we set ONLY `token` on
 * makeSettings.  The library appends `Authorization: token <TOKEN>` itself.
 * Passing `init: { headers: { Authorization } }` as well DUPLICATES the header
 * ("token X, token X"), which the server fails to parse — it then falls back
 * to XSRF checking and rejects POST with "'_xsrf' argument missing".  So we
 * never set init.headers for auth here.
 */
import { KernelManager, ServerConnection, SessionManager } from "@jupyterlab/services";
import { createRequire } from "node:module";
import type { ShimConfig } from "../config";
import { JupyterKernel } from "./kernel";
import type {
  KernelPort,
  KernelSpecInfo,
  KernelSpecList,
  ServerPort,
  StartKernelOpts,
} from "./port";

export class JupyterServer implements ServerPort {
  readonly settings: ServerConnection.ISettings;
  private kernels: KernelManager;
  private sessions?: SessionManager; // 懒加载，仅 bind 模式用到
  /** Parent directories already created on the server (avoids a PUT per cell). */
  private ensuredDirs = new Set<string>();

  constructor(private config: ShimConfig) {
    const baseUrl = config.url.replace(/\/?$/, "/");
    const wsUrl = baseUrl.replace(/^http/, "ws");

    this.settings = ServerConnection.makeSettings({
      baseUrl,
      wsUrl,
      token: config.token,
      // Append ?token= to the WebSocket URL (Node proxies may ignore
      // handshake headers).  REST still authenticates via Authorization.
      appendToken: true,
      ...(config.tlsInsecure ? { fetch: insecureFetch } : {}),
    });

    this.kernels = new KernelManager({ serverSettings: this.settings });
  }

  async ping(): Promise<void> {
    const res = await ServerConnection.makeRequest(
      `${this.settings.baseUrl}api`,
      { method: "GET" },
      this.settings,
    );
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `[pi-jupyter] bad token (HTTP ${res.status}). Check JUPYTER_REMOTE_TOKEN.`,
      );
    }
    if (!res.ok) {
      throw new Error(
        `[pi-jupyter] Jupyter server unreachable or error: ${res.status} ${res.statusText}`,
      );
    }
  }

  async listKernelSpecs(): Promise<KernelSpecList> {
    const res = await ServerConnection.makeRequest(
      `${this.settings.baseUrl}api/kernelspecs`,
      { method: "GET" },
      this.settings,
    );
    if (!res.ok) {
      throw new Error(
        `[pi-jupyter] could not list kernelspecs: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as {
      default?: string;
      kernelspecs?: Record<
        string,
        { name?: string; spec?: { display_name?: string; language?: string } } | undefined
      >;
    };
    const specs: KernelSpecInfo[] = Object.entries(body.kernelspecs ?? {}).map(
      ([name, ks]) => ({
        name: ks?.name ?? name,
        displayName: ks?.spec?.display_name ?? name,
        language: (ks?.spec?.language ?? "unknown").toLowerCase(),
      }),
    );
    return { default: body.default ?? "", specs };
  }
  async startKernel(name: string, opts?: StartKernelOpts): Promise<KernelPort> {
    const bind = this.config.bindSession ?? true;
    if (bind && opts?.sessionPath) {
      // 懒建 SessionManager（构造时会自带/复用 KernelManager，仅 serverSettings 即可）。
      const mgr = (this.sessions ??= new SessionManager({
        serverSettings: this.settings,
        kernelManager: this.kernels,
      }));
      const session = await mgr.startNew({
        path: opts.sessionPath,
        name: opts.sessionName ?? opts.sessionPath,
        type: "notebook",
        kernel: { name },
      });
      const k = session.kernel;
      if (!k) throw new Error("[pi-jupyter] session started without a kernel connection");
      return new JupyterKernel(k, session);
    }
    const connection = await this.kernels.startNew({ name });
    return new JupyterKernel(connection);
  }

  /**
   * Write an nbformat model to the remote Contents API (FR-2):
   * `PUT /api/contents/<path>` is create-or-update (201 new / 200 existing).
   * Some jupyter_server deployments do NOT create missing parent directories
   * on save (they fail with HTTP 500), so `ensureParentDirs` creates them
   * first when the path contains sub-directories (R3.4).
   * Reuses the SAME `ServerConnection.ISettings` (hence the same token/auth
   * path) as `ping()` / `listKernelSpecs()` — we never set our own
   * Authorization header (that would trigger the `_xsrf` failure, see the
   * file header). Throws on a non-ok response; callers by-pass it.
   */
  async uploadNotebook(contentsPath: string, model: Record<string, unknown>): Promise<void> {
    await this.ensureParentDirs(contentsPath);
    const url = `${this.settings.baseUrl}api/contents/${encodeContentsPath(contentsPath)}`;
    const res = await ServerConnection.makeRequest(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "notebook", format: "json", content: model }),
      },
      this.settings,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `[pi-jupyter] remote save failed: HTTP ${res.status} ${res.statusText} ${detail}`.trim(),
      );
    }
  }

  /**
   * Create the parent directory of `contentsPath` on the server when needed.
   * `PUT` with `{type:"directory"}` is idempotent (the server no-ops on an
   * existing dir and `os.makedirs` is recursive), and successful parents are
   * cached so steady-state cells cost zero extra requests.
   */
  private async ensureParentDirs(contentsPath: string): Promise<void> {
    const idx = contentsPath.lastIndexOf("/");
    if (idx <= 0) return; // file sits at the contents root
    const parent = contentsPath.slice(0, idx);
    if (this.ensuredDirs.has(parent)) return;
    const url = `${this.settings.baseUrl}api/contents/${encodeContentsPath(parent)}`;
    const res = await ServerConnection.makeRequest(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "directory", format: "json", content: {} }),
      },
      this.settings,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `[pi-jupyter] could not create remote directory "${parent}": ` +
          `HTTP ${res.status} ${res.statusText} ${detail}`.trim(),
      );
    }
    this.ensuredDirs.add(parent);
  }

  dispose(): void {
    try { this.sessions?.dispose(); } catch { /* ignore */ }
    this.kernels.dispose();
  }
}

/**
 * Percent-encode a Jupyter contents path segment-by-segment, preserving the
 * hierarchy slashes (FR-2 / NFR-3). The default file name has no slash, but
 * `remoteSavePath` may contain sub-directories.
 */
export function encodeContentsPath(contentsPath: string): string {
  return contentsPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Dev-only fetch that skips TLS certificate validation (self-signed certs).
 * Uses an undici Agent dispatcher when available; otherwise falls back to the
 * process-wide NODE_TLS_REJECT_UNAUTHORIZED switch.  Never used unless
 * `tlsInsecure` is set.
 */
function insecureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    const req = createRequire(import.meta.url);
    const undici = req("undici") as typeof import("undici");
    const agent = new undici.Agent({ connect: { rejectUnauthorized: false } });
    return fetch(input as RequestInfo, {
      ...init,
      // @ts-expect-error undici dispatcher passthrough (not in lib.dom types)
      dispatcher: agent,
    });
  } catch {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    return fetch(input as RequestInfo, init);
  }
}
