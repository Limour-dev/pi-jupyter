/**
 * Unit tests: config loading (priority + fail-fast).
 * Env vars are injected so no real environment is touched.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isConfigured, loadConfig, loadToolGates } from "../../src/config";

// Keep these tests hermetic: point HOME at an empty directory so the real
// ~/.pi-jupyter/config.json (if any) cannot leak into loadConfig().
beforeAll(() => {
  process.env.HOME = `/tmp/pi-jupyter-test-home-${process.pid}`;
});
afterEach(() => {
  delete process.env.JUPYTER_REMOTE_URL;
  delete process.env.JUPYTER_REMOTE_TOKEN;
  delete process.env.JUPYTER_REMOTE_AUTOSAVE;
  delete process.env.JUPYTER_REMOTE_SAVE_PATH;
  delete process.env.JUPYTER_ENABLE_ADD_DEPENDENCIES;
  delete process.env.JUPYTER_ENABLE_SAVE_NOTEBOOK;
});

const BASE = {
  JUPYTER_REMOTE_URL: "http://example:8888",
  JUPYTER_REMOTE_TOKEN: "tok",
};

describe("loadConfig", () => {
  it("reads url + token from env", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.url).toBe("http://example:8888");
    expect(cfg.token).toBe("tok");
  });

  it("applies defaults for optional fields", () => {
    const cfg = loadConfig(BASE);
    // The kernel is agent-decided, NOT configured: no default.
    expect(cfg.kernelName).toBeUndefined();
    expect(cfg.tlsInsecure).toBe(false);
    expect(cfg.defaultTimeoutMs).toBe(300_000);
    expect(cfg.installTimeoutMs).toBe(600_000);
    expect(cfg.timeoutRestartKernel).toBe(false);
    expect(typeof cfg.workingDir).toBe("string");
  });

  it("honors env overrides for optional fields", () => {
    const cfg = loadConfig({
      ...BASE,
      JUPYTER_KERNEL_NAME: "python3.12",
      JUPYTER_REMOTE_TLS_INSECURE: "1",
      JUPYTER_REMOTE_TIMEOUT_MS: "5000",
      JUPYTER_INSTALL_TIMEOUT_MS: "9000",
      JUPYTER_WORKING_DIR: "/tmp/pj",
      JUPYTER_TIMEOUT_RESTART_KERNEL: "1",
    });
    expect(cfg.kernelName).toBe("python3.12");
    expect(cfg.tlsInsecure).toBe(true);
    expect(cfg.defaultTimeoutMs).toBe(5000);
    expect(cfg.installTimeoutMs).toBe(9000);
    expect(cfg.workingDir).toBe("/tmp/pj");
    expect(cfg.timeoutRestartKernel).toBe(true);
  });

  it("throws a helpful error when url is missing", () => {
    expect(() => loadConfig({ JUPYTER_REMOTE_TOKEN: "tok" })).toThrow(/not configured/);
  });

  it("throws when token is missing", () => {
    expect(() => loadConfig({ JUPYTER_REMOTE_URL: "http://x" })).toThrow(/TOKEN not set/);
  });

  it("remote auto-save defaults on; env 0/1 toggles it (FR-7.1)", () => {
    expect(loadConfig(BASE).remoteAutoSave).toBe(true);
    expect(loadConfig({ ...BASE, JUPYTER_REMOTE_AUTOSAVE: "0" }).remoteAutoSave).toBe(false);
    expect(loadConfig({ ...BASE, JUPYTER_REMOTE_AUTOSAVE: "1" }).remoteAutoSave).toBe(true);
  });

  it("remoteSavePath: unset by default, env wins, blank means unset (FR-7.2)", () => {
    expect(loadConfig(BASE).remoteSavePath).toBeUndefined();
    expect(loadConfig({ ...BASE, JUPYTER_REMOTE_SAVE_PATH: "notes/pi.ipynb" }).remoteSavePath).toBe(
      "notes/pi.ipynb",
    );
    expect(loadConfig({ ...BASE, JUPYTER_REMOTE_SAVE_PATH: "  " }).remoteSavePath).toBeUndefined();
  });
});

describe("isConfigured", () => {
  it("true when url + token present", () => {
    expect(isConfigured(BASE)).toBe(true);
  });
  it("false when either is missing", () => {
    expect(isConfigured({})).toBe(false);
    expect(isConfigured({ JUPYTER_REMOTE_URL: "http://x" })).toBe(false);
  });
});

describe("keepKernels (notebook continuity policy)", () => {
  it("defaults to true", () => {
    expect(loadConfig(BASE).keepKernels).toBe(true);
  });
  it("JUPYTER_KEEP_KERNELS=0 disables (legacy kill-on-exit)", () => {
    expect(loadConfig({ ...BASE, JUPYTER_KEEP_KERNELS: "0" }).keepKernels).toBe(false);
  });
  it("JUPYTER_KEEP_KERNELS=1 enables", () => {
    expect(loadConfig({ ...BASE, JUPYTER_KEEP_KERNELS: "1" }).keepKernels).toBe(true);
  });
});

describe("tool gates (enableAddDependencies / enableSaveNotebook)", () => {
  it("default to false — the tools are not loaded", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.enableAddDependencies).toBe(false);
    expect(cfg.enableSaveNotebook).toBe(false);
    expect(loadToolGates(BASE)).toEqual({
      enableAddDependencies: false,
      enableSaveNotebook: false,
    });
  });

  it("each gate toggles independently via env 1/0", () => {
    expect(loadConfig({ ...BASE, JUPYTER_ENABLE_ADD_DEPENDENCIES: "1" }).enableAddDependencies).toBe(true);
    expect(loadConfig({ ...BASE, JUPYTER_ENABLE_ADD_DEPENDENCIES: "1" }).enableSaveNotebook).toBe(false);
    expect(loadConfig({ ...BASE, JUPYTER_ENABLE_SAVE_NOTEBOOK: "1" }).enableSaveNotebook).toBe(true);
    expect(loadConfig({ ...BASE, JUPYTER_ENABLE_ADD_DEPENDENCIES: "1", JUPYTER_ENABLE_SAVE_NOTEBOOK: "1" }).enableSaveNotebook).toBe(true);
    expect(loadConfig({ ...BASE, JUPYTER_ENABLE_SAVE_NOTEBOOK: "0" }).enableSaveNotebook).toBe(false);
  });

  it("config.json enables the tools (no env override)", () => {
    const cfgDir = join(homedir(), ".pi-jupyter");
    const cfgPath = join(cfgDir, "config.json");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({ url: "http://example:8888", token: "tok", enableAddDependencies: true, enableSaveNotebook: true }),
    );
    try {
      expect(loadConfig().enableAddDependencies).toBe(true);
      expect(loadConfig().enableSaveNotebook).toBe(true);
    } finally {
      rmSync(cfgPath);
    }
  });

  it("env wins over config.json", () => {
    const cfgDir = join(homedir(), ".pi-jupyter");
    const cfgPath = join(cfgDir, "config.json");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({ enableSaveNotebook: true }),
    );
    try {
      expect(loadConfig({ JUPYTER_REMOTE_URL: "http://example:8888", JUPYTER_REMOTE_TOKEN: "tok", JUPYTER_ENABLE_SAVE_NOTEBOOK: "0" }).enableSaveNotebook).toBe(false);
    } finally {
      rmSync(cfgPath);
    }
  });

  it("loadToolGates needs no url/token (stable tool list unconfigured)", () => {
    expect(loadToolGates({})).toEqual({ enableAddDependencies: false, enableSaveNotebook: false });
    expect(loadToolGates({ JUPYTER_ENABLE_ADD_DEPENDENCIES: "1" })).toEqual({
      enableAddDependencies: true,
      enableSaveNotebook: false,
    });
  });
});
