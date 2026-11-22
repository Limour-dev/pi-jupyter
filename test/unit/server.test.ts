/**
 * Unit tests: contents-path encoding used by the remote auto-save upload
 * (FR-2 / NFR-3). Offline — no Jupyter Server involved.
 */
import { ServerConnection } from "@jupyterlab/services";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeContentsPath, JupyterServer, normalizeContentsDir } from "../../src/kernel/server";

describe("encodeContentsPath", () => {
  it("keeps a plain default file name intact", () => {
    expect(encodeContentsPath("remote-1785163018289-b9ec77ab.ipynb")).toBe(
      "remote-1785163018289-b9ec77ab.ipynb",
    );
  });

  it("preserves hierarchy slashes while encoding per segment", () => {
    expect(encodeContentsPath("notes/sub/pi.ipynb")).toBe("notes/sub/pi.ipynb");
  });

  it("percent-encodes unsafe characters segment by segment", () => {
    expect(encodeContentsPath("a b/c?d.ipynb")).toBe("a%20b/c%3Fd.ipynb");
    expect(encodeContentsPath("100%/done.ipynb")).toBe("100%25/done.ipynb");
  });

  it("percent-encodes non-ASCII and reserved characters per segment", () => {
    expect(encodeContentsPath("笔记/pi.ipynb")).toBe("%E7%AC%94%E8%AE%B0/pi.ipynb");
    expect(encodeContentsPath("a&b/c#d.ipynb")).toBe("a%26b/c%23d.ipynb");
  });
});

describe("normalizeContentsDir", () => {
  it("collapses the root spellings to the empty path", () => {
    expect(normalizeContentsDir(".")).toBe("");
    expect(normalizeContentsDir("")).toBe("");
    expect(normalizeContentsDir("/")).toBe("");
    expect(normalizeContentsDir("./")).toBe("");
  });

  it("strips ./ and trailing slashes but keeps hierarchy", () => {
    expect(normalizeContentsDir("./notes/")).toBe("notes");
    expect(normalizeContentsDir("/notes/sub/")).toBe("notes/sub");
  });
});

vi.mock("@jupyterlab/services", () => ({
  KernelManager: class {},
  ServerConnection: {
    makeSettings: (settings: ServerConnection.ISettings) => settings,
    makeRequest: vi.fn(),
  },
}));

describe("JupyterServer.uploadNotebook", () => {
  const base = "http://jupyter.test/api/contents";
  const makeRequest = vi.mocked(ServerConnection.makeRequest);
  const server = new JupyterServer({
    url: "http://jupyter.test/", token: "test", tlsInsecure: false,
    defaultTimeoutMs: 1000, installTimeoutMs: 1000, workingDir: "/tmp",
    timeoutRestartKernel: false, keepKernels: true, remoteAutoSave: true,
    enableAddDependencies: false, enableSaveNotebook: true,
  });
  const notebook = { cells: [] };
  const requests = () => makeRequest.mock.calls.map(([url, init]) => {
    const type = init.body ? JSON.parse(String(init.body)).type : undefined;
    return [init.method, url, type];
  });

  beforeEach(() => makeRequest.mockReset());

  it("creates missing ancestors before uploading to a nested path", async () => {
    makeRequest
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValue(new Response(null, { status: 201 }));

    await server.uploadNotebook("project notes/results/analysis.ipynb", notebook);
    expect(requests()).toEqual([
      ["GET", `${base}/project%20notes/results?content=0`, undefined],
      ["GET", `${base}/project%20notes?content=0`, undefined],
      ["PUT", `${base}/project%20notes`, "directory"],
      ["PUT", `${base}/project%20notes/results`, "directory"],
      ["PUT", `${base}/project%20notes/results/analysis.ipynb`, "notebook"],
    ]);
  });

  it("skips directory creation when it exists and recreates it if deleted between saves", async () => {
    makeRequest
      .mockResolvedValueOnce(Response.json({ type: "directory" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValue(new Response(null, { status: 201 }));

    await server.uploadNotebook("notes/analysis.ipynb", notebook);
    await server.uploadNotebook("notes/analysis.ipynb", notebook);
    expect(requests()).toEqual([
      ["GET", `${base}/notes?content=0`, undefined],
      ["PUT", `${base}/notes/analysis.ipynb`, "notebook"],
      ["GET", `${base}/notes?content=0`, undefined],
      ["PUT", `${base}/notes`, "directory"],
      ["PUT", `${base}/notes/analysis.ipynb`, "notebook"],
    ]);
  });

  it("does not try to create a directory over an existing file", async () => {
    makeRequest.mockResolvedValueOnce(Response.json({ type: "file" }));
    await expect(server.uploadNotebook("notes/analysis.ipynb", notebook)).rejects.toThrow(/"notes" is not a directory/);
    expect(requests()).toEqual([["GET", `${base}/notes?content=0`, undefined]]);
  });

  it("does not treat a forbidden directory as missing", async () => {
    makeRequest.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(server.uploadNotebook("notes/analysis.ipynb", notebook)).rejects.toThrow(/"notes": HTTP 403/);
    expect(requests()).toEqual([["GET", `${base}/notes?content=0`, undefined]]);
  });
});
