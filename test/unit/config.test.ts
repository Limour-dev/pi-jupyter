/**
 * Unit tests: config loading (priority + fail-fast).
 * Env vars are injected so no real environment is touched.
 */
import { describe, expect, it } from "vitest";
import { isConfigured, loadConfig } from "../../src/config";

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
    expect(cfg.kernelName).toBe("python3");
    expect(cfg.tlsInsecure).toBe(false);
    expect(cfg.defaultTimeoutMs).toBe(300_000);
    expect(cfg.installTimeoutMs).toBe(600_000);
  });

  it("honors env overrides for optional fields", () => {
    const cfg = loadConfig({
      ...BASE,
      JUPYTER_KERNEL_NAME: "python3.12",
      JUPYTER_REMOTE_TLS_INSECURE: "1",
      JUPYTER_REMOTE_TIMEOUT_MS: "5000",
      JUPYTER_INSTALL_TIMEOUT_MS: "9000",
    });
    expect(cfg.kernelName).toBe("python3.12");
    expect(cfg.tlsInsecure).toBe(true);
    expect(cfg.defaultTimeoutMs).toBe(5000);
    expect(cfg.installTimeoutMs).toBe(9000);
  });

  it("throws a helpful error when url is missing", () => {
    expect(() => loadConfig({ JUPYTER_REMOTE_TOKEN: "tok" })).toThrow(/not configured/);
  });

  it("throws when token is missing", () => {
    expect(() => loadConfig({ JUPYTER_REMOTE_URL: "http://x" })).toThrow(/TOKEN not set/);
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
