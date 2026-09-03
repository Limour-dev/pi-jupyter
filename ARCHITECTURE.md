# pi-jupyter v2 — Architecture

> A remote Jupyter-backed REPL for pi coding agents. Pure TypeScript,
> no local daemon — code runs on a remote Jupyter Server, reached via
> the official `@jupyterlab/services` client. Which kernel executes the code
> (python3, ir, …) is picked by the agent per call (§ below).

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

## Who decides the kernel?

Two things are easy to conflate, and v2 separates them sharply:

- **The Jupyter Server connection** (url/token) is *user configuration*. It is
  the only thing `src/config.ts` requires (`JUPYTER_REMOTE_URL` /
  `JUPYTER_REMOTE_TOKEN`, env or `~/.pi-jupyter/config.json`).
- **Which kernel executes the code** (python3, ir, …) is an *agent decision*
  per tool call, **not** configuration.

Flow (see `extensions/repl.ts`):

1. `jupyter_list_kernels` connects to the configured server, reads
   `/api/kernelspecs` (`ServerPort.listKernelSpecs`) and shows the agent the
   available kernels — each annotated with its recorded purpose (from
   `~/.pi-jupyter/purposes.json`) plus the server default and any open
   session. Kernels without a recorded purpose are flagged as new.
2. **Only a newly discovered kernel with no recorded purpose** triggers a
   question: the agent asks the user what it is for and stores the answer
   with `jupyter_set_kernel_purpose` → `src/purposes.ts` writes
   `~/.pi-jupyter/purposes.json` (`{ name: purpose }`, atomic replace).
   Already-recorded kernels are shown with their purpose and reused — no
   re-asking, in this session or later ones.
3. The agent passes the matching kernelspec *name* as the `kernel` parameter
   of `jupyter_repl` / `jupyter_add_dependencies` / `jupyter_save_notebook`.

Consequences encoded in the code:

- `ShimConfig.kernelName` is optional and is **only a fallback default** for
  calls that omit `kernel` (default → server default kernelspec → `python3`).
  It never overrides an explicit agent choice.
- Sessions are keyed **per kernel** (`Map<kernelName, Session>` in the
  extension): each kernel runs its own `RemoteSession` (own kernel, own
  notebookId, own auto-save target), so switching python3 ↔ R back and forth
  never loses either kernel's state.
- `RemoteSession` receives the chosen kernel via `CreateSessionOpts.kernelName`
  and exposes it as `Session.kernelName` (surfaced in every tool result's
  `details.kernel`), so the agent can see which kernel actually ran. A
  session constructed with no kernel at all fails fast with a "no kernel
  selected" error before touching the network.
- `jupyter_list_kernels` works with a throwaway `JupyterServer` instance, so
  listing never interferes with live sessions.
- Purpose notes live in a tiny JSON store (`src/purposes.ts`,
  `~/.pi-jupyter/purposes.json`), read by `jupyter_list_kernels` and written
  by `jupyter_set_kernel_purpose`. The store only carries the user's
  EXPLANATION — it never selects a kernel, so the agent's per-call decision
  (step 3) stays the single source of truth.

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
