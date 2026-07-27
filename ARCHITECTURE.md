# pi-jupyter v2 — Architecture

> A remote Jupyter-backed REPL for pi coding agents. Pure TypeScript,
> no local backend — the remote Jupyter Server **is** the backend, reached via
> the official `@jupyterlab/services` client.

## Design philosophy

v1 worked end-to-end but, per the conformance analysis, had three weaknesses:

1. **Untestable core.** `executeCell()` took a raw `Kernel.IKernelConnection`,
   so the dual-channel protocol and the whole session could only be exercised
   against a live server. There were **zero offline unit tests**.
2. **A 477-line extension file** mixing tool schemas, output formatting, and
   lifecycle wiring.
3. **No build pipeline** and no explicit record of why we diverged from the
   v3.0 "shim" design.

v2 keeps v1's validated engineering decisions and fixes the structure around
one idea: **hexagonal architecture (ports & adapters)**.

## The three layers

```
┌───────────────────────────────────────────────────────────────────────┐
│  extensions/            pi presentation (thin wiring)                 │
│    repl.ts                register tools/command, session lifecycle   │
│    format.ts              CellResult → pi message content             │
│    schemas.ts             TypeBox parameter schemas                   │
└───────────────┬───────────────────────────────────────────────────────┘
                │ depends on  Session  (interface)
┌───────────────▼───────────────────────────────────────────────────────┐
│  src/session.ts + src/config.ts        application                    │
│    RemoteSession implements Session behind a KernelPort               │
└───────────────┬───────────────────────────────────────────────────────┘
                │ depends on  KernelPort / ServerPort  (interfaces)
┌───────────────▼───────────────────────────────────────────────────────┐
│  src/kernel/            adapters (ALL @jupyterlab/services lives here)│
│    port.ts                KernelPort / ServerPort — the seam          │
│    server.ts              ServerConnection + KernelManager            │
│    kernel.ts              dual-channel executor (IFuture)             │
│    convert.ts             KernelMessage → JsOutput                    │
└───────────────┬───────────────────────────────────────────────────────┘
                │ uses
┌───────────────▼───────────────────────────────────────────────────────┐
│  src/domain/            pure core (ZERO external dependencies)        │
│    types.ts  output.ts  notebook.ts  deps.ts  bootstrap.ts  subject.ts│
└───────────────────────────────────────────────────────────────────────┘
```

**Dependency rule:** arrows point inward only. `domain/` imports nothing
external; `kernel/` is the only layer that imports `@jupyterlab/services`;
`session.ts` imports `domain/` + the `KernelPort` *interface* but never the
adapter; `extensions/` imports the `Session` *interface*.

### Why the seam matters

`KernelPort` / `ServerPort` (`src/kernel/port.ts`) are the inversion point.
Because `RemoteSession` depends on the interface, the entire session
lifecycle is testable with a 20-line mock — see
`test/unit/session.test.ts`. And because `JupyterKernel.execute()` is the
single owner of the `IFuture` protocol, every output-normalization branch is
covered offline with a mock future — see `test/unit/kernel.test.ts`. Both
were impossible in v1.

## Decisions carried over from v1 (and why)

- **Self-contained extension, not the v3.0 shim.** The v3.0 design proposed
  replacing `@runtimed/node` to reuse `@nteract/pi`'s 1300-line renderer.
  v1 chose to write the renderer (~300 lines) instead. We keep that choice:
  it removes the `@runtimed/node` native-binding install risk (v3.0's own
  risk R6), needs no `NTERACT_RUNTIMED_NODE_PATH`, and is independently
  debuggable. The cost is ~300 lines of renderer we own outright.
- **`@jupyterlab/services` dual-channel execution.** iopub carries the output
  stream; the shell `execute_reply` carries the *authoritative*
  `execution_count` and terminal status; `future.done` resolves once both
  arrive. This is the correct protocol and we did not change it.
- **Tables degrade to text.** Remote Jupyter never emits nteract's proprietary
  table MIME types, so we get text fallback for free — no DataTable port.

## Lessons encoded in the code

Each is a comment at the relevant site, all verified against a live server:

| Lesson | Where |
|--------|-------|
| Set **only** `token` on `makeSettings` — a duplicate `Authorization` header triggers `'_xsrf' argument missing` | `kernel/server.ts` |
| Normalize raw mimebundles to `{ type, value }`; denormalize on `.ipynb` export | `domain/output.ts`, `domain/notebook.ts` |
| lumino v2 `signal.connect()` returns `void` — keep the handler ref and `disconnect(handler)` | `kernel/kernel.ts` `waitConnected` |
| Use `TimeoutError` (a real class), not `err.message === "timeout"` string matching | `domain/types.ts`, `kernel/kernel.ts`, `session.ts` |
| `execute_result` must carry `execution_count` in nbformat | `domain/notebook.ts` |

## Testing strategy

| Layer | Tool | Needs a server? |
|-------|------|:---:|
| `test/unit/` | vitest, mock `IFuture` + mock `KernelPort` | **No** |
| `test/integration/smoke.test.ts` | tsx, real server | Yes |

`npm test` runs the offline suite; `npm run test:integration` runs the live
one. v1 had only the live smoke test — the offline suite is new.

## Build

`npm run build` (tsup) emits `dist/index.{js,cjs,d.ts}` from `src/index.ts`
for consumers who want the library API. The pi extension itself is loaded
from `.ts` source via `package.json` → `pi.extensions`.
