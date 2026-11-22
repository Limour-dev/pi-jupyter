import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register from "../../extensions/repl";
import type { ExecuteOptions, ExecuteOutcome } from "../../src/kernel/port";
import { loadNotebooks } from "../../src/notebooks";

// Exercise the registered tools and the real RemoteSession. Only the host,
// registry, and remote ports are replaced; no network or home-directory writes.
vi.mock("@earendil-works/pi-coding-agent", () => ({ highlightCode: vi.fn() }));
vi.mock("@earendil-works/pi-tui", () => ({ Text: class {} }));
vi.mock("../../src/notebooks", () => ({ loadNotebooks: vi.fn(() => ({})), touchNotebook: vi.fn() }));
vi.mock("../../src/kernel/server", () => ({ JupyterServer: class { constructor() { return server; } } }));

const model = { metadata: { kernelspec: { name: "ir", language: "r" } }, cells:
  ["first", "second"].map(id => ({ id, cell_type: "code", source: "same()", outputs: [] })) };
const execute = vi.fn(async (_source: string, _opts: ExecuteOptions): Promise<ExecuteOutcome> => ({ status: "ok", outputs: [], executionCount: 1 }));
const server = {
  ping: vi.fn(), readNotebook: vi.fn(async () => model), findLiveSession: vi.fn(async () => null),
  listKernelSpecs: vi.fn(async () => ({ specs: [{ name: "ir", language: "r" }] })),
  listDirectory: vi.fn(), listSessions: vi.fn(async () => []),
  startKernel: vi.fn(async () => ({ status: "idle", waitConnected: vi.fn(), execute })), dispose: vi.fn(),
};

function tools() {
  const registered = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const host: Pick<ExtensionAPI, "registerCommand" | "on" | "registerTool"> = {
    registerCommand: vi.fn(), on: vi.fn(), registerTool(tool) { registered.set(tool.name, tool); },
  };
  register(host as ExtensionAPI);
  return (name: string, params: Record<string, unknown>) => registered.get(`jupyter_${name}`)!.execute(
    "test", params, undefined, undefined, { cwd: "/tmp" },
  );
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HOME", `/tmp/pi-jupyter-repl-test-${process.pid}`);
  vi.stubEnv("JUPYTER_REMOTE_URL", "http://test");
  vi.stubEnv("JUPYTER_REMOTE_TOKEN", "test");
  vi.stubEnv("JUPYTER_REMOTE_AUTOSAVE", "0");
  vi.stubEnv("JUPYTER_REMOTE_TIMEOUT_MS", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("jupyter_list_notebooks", () => {
  it("silently omits stale registry entries from text and details", async () => {
    vi.mocked(loadNotebooks).mockReturnValueOnce({
      "notes/deleted.ipynb": { kernelName: "python3", updated: "2026-01-01", source: "remote" },
    });
    server.listDirectory.mockResolvedValueOnce({
      exists: true,
      entries: [{ path: "notes/current.ipynb", name: "current.ipynb", type: "notebook" }],
    });

    const { content, details } = await tools()("list_notebooks", { dir: "notes" });

    expect(content[0].text).toContain("notes/current.ipynb");
    expect(content[0].text).not.toMatch(/stale registry|notes\/deleted\.ipynb/);
    expect(details.notebooks.map((row: { path: string }) => row.path)).toEqual(["notes/current.ipynb"]);
    expect(details).not.toHaveProperty("stale");
  });
});

describe("notebook tool initialization", () => {
  const path = "demo.ipynb";
  it("shares ongoing replay, targets duplicate sources by id and executes user code last", async () => {
    const call = tools();
    const entered = latch(), resume = latch();
    execute.mockImplementationOnce(async () => {
      entered.release(); await resume.promise;
      return { status: "ok", outputs: [], executionCount: 8 };
    });
    const opening = call("open_notebook", { path });
    await entered.promise;
    const conflicting = call("open_notebook", { path: `/${path}`, replay: "skip" });
    const run = call("repl", { notebook: path, code: "user()" });
    resume.release();
    const [opened, joined] = await Promise.all([opening, conflicting, run]);
    expect(server.startKernel).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.map(([source]) => source)).toEqual(["same()", "same()", "user()"]);
    expect(opened.details.cells.map((c: any) => [c.cellId, c.executionCount])).toEqual([["first", 8], ["second", 1]]);
    expect(joined.details.replay_mode).toBe("auto");
    expect(joined.content[0].text).toContain('first request selected replay="auto"');
  });

  it("does not claim a remote save when an edit is session-only", async () => {
    const call = tools();
    const edit = await call("edit_cell", { notebook: path, action: "insert", source: "new()" });
    expect(edit.details.remote_save.status).toBe("disabled");
    expect(edit.content[0].text).toMatch(/session document updated.*auto-save is disabled/i);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["insert", "replace"])("runs the exact cell after %s, even with duplicate sources", async (action) => {
    const call = tools();
    execute.mockResolvedValueOnce({ status: "ok", outputs: [{ outputType: "stream", name: "stdout", text: "answer" }], executionCount: 7 });
    const { details, content } = await call("edit_cell", {
      notebook: path, action, source: "same()", run: true, ...(action === "replace" ? { cell_id: "second" } : { position: 1 }),
    });
    expect(execute.mock.calls.map(([source]) => source)).toEqual(["same()"]);
    expect(details.cells).toHaveLength(action === "replace" ? 2 : 3);
    expect(details.cells[0].executionCount).toBeUndefined();
    expect(details.cells[1]).toMatchObject({ cellId: details.cell_id, executionCount: 7 });
    expect(details).toMatchObject({ index: 1, status: "done", execution_count: 7, is_error: false });
    expect(content[1].text).toContain("answer");
  });

  it.each(["delete", "move"])("rejects run=true before applying %s", async (action) => {
    const call = tools();
    await expect(call("edit_cell", { notebook: path, action, cell_id: "first", position: 1, run: true })).rejects.toThrow(/`run`/);
    const { details } = await call("open_notebook", { path });
    expect(details.cells.map((c: any) => c.cellId)).toEqual(["first", "second"]);
    expect(execute).not.toHaveBeenCalled();
  });
  it("honors skip when it arrives first; a concurrent auto open does not replay", async () => {
    const call = tools();
    const [first, second] = await Promise.all([
      call("open_notebook", { path, replay: "skip" }), call("open_notebook", { path }),
    ]);
    expect(first.details.replay_mode).toBe("skip");
    expect(second.details.replay_mode).toBe("skip");
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows retry after a failed shared open", async () => {
    const call = tools();
    server.readNotebook.mockRejectedValueOnce(new Error("read failed"));
    const failures = await Promise.allSettled([call("open_notebook", { path }), call("repl", { notebook: path, code: "probe" })]);
    expect(failures.map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect(server.startKernel).not.toHaveBeenCalled();
    await call("open_notebook", { path, replay: "skip" });
    expect(server.startKernel).toHaveBeenCalledTimes(1);
  });

  it.each([[undefined, 300_000], ["7890", 7890]] as const)("uses the configured timeout (%s) unless the call overrides it", async (configured, expected) => {
    vi.stubEnv("JUPYTER_REMOTE_TIMEOUT_MS", configured);
    const call = tools();
    await call("open_notebook", { path, replay: "skip" });
    await call("repl", { notebook: path, code: "probe" });
    await call("repl", { notebook: path, cell_id: "first", timeout_secs: 2 });
    expect(execute.mock.calls.map(([, opts]) => opts.timeoutMs)).toEqual([expected, 2000]);
    const { details } = await call("open_notebook", { path });
    expect(details.cells.map((c: any) => c.executionCount)).toEqual([1, undefined]);
  });
});
