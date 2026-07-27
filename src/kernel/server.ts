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
import { KernelManager, ServerConnection } from "@jupyterlab/services";
import { createRequire } from "node:module";
import type { ShimConfig } from "../config";
import { JupyterKernel } from "./kernel";
import type { KernelPort, KernelSpecInfo, KernelSpecList, ServerPort } from "./port";

export class JupyterServer implements ServerPort {
  readonly settings: ServerConnection.ISettings;
  private kernels: KernelManager;

  constructor(config: ShimConfig) {
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
  async startKernel(name: string): Promise<KernelPort> {
    const connection = await this.kernels.startNew({ name });
    return new JupyterKernel(connection);
  }

  dispose(): void {
    this.kernels.dispose();
  }
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
