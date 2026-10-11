/**
 * Unit tests: contents-path encoding used by the remote auto-save upload
 * (FR-2 / NFR-3). Offline — no Jupyter Server involved.
 */
import { describe, expect, it } from "vitest";
import { encodeContentsPath, normalizeContentsDir } from "../../src/kernel/server";

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
