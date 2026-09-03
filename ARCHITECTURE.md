# pi-jupyter v3 — Architecture

> A remote Jupyter-backed REPL for pi coding agents. Pure TypeScript,
> no local daemon — code runs on a remote Jupyter Server, reached via
> the official `@jupyterlab/services` client. Every execution happens in a
> **notebook session** bound to a remote contents path; anonymous
> kernel-only sessions are gone. Which kernel executes the code
> (python3, ir, …) is decided **when the notebook is opened** (§ below).

## Design philosophy

v2 worked end-to-end but, per the v3 requirements, had a structural smell:
**two kinds of sessions** coexisted — notebook sessions (keyed by a contents
path) and *anonymous per-kernel sessions* (keyed by kernelspec name) that any
tool could create by omitting `notebook`. The anonymous path duplicated the
lifecycle (own kernel, own auto-save target, extra cleanup on shutdown) and let
an agent run code without ever choosing a notebook, which made continuity and
state recovery depend on the agent remembering to pass `notebook`.

v3 collapses the model to **one kind of session**:

- `jupyter_repl` requires a `notebook` path and no longer takes `kernel` or
  `dependencies` (use `jupyter_open_notebook` to pick the kernel, and
  `jupyter_add_dependencies` to install packages).
- `jupyter_add_dependencies` and `jupyter_save_notebook` also require a
  `notebook` path.
- Opening a notebook whose kernel was **previously closed** starts a NEW kernel
  bound to the same path and **re-runs the file's code cells from first to
  last**, so in-memory state is rebuilt automatically.
- The agent flow is fixed and self-checkable: `jupyter_list_notebooks` (is a
  session active?) → `jupyter_open_notebook` (+ `jupyter_list_kernels` when the
  kernels are unknown) → `jupyter_repl`.

v2's engineering decisions are carried over unchanged (hexagonal layout, the
dual-channel execution protocol, the two JSON stores, the offline test suite).

## The three layers

```
┌───────────────────────────────────────────────────────────────────────┐
│  extensions/            pi presentation (thin wiring)                 │
│    repl.ts                register tools/command, session lifecycle   │
│    format.ts              CellResult → pi message content             │
│    schemas.ts             TypeBox parameter schemas                   │
└───────────────┬───────────────────────────────────────────────────────┘
                │ wires  RemoteSession + JupyterServer  (composition root)
┌───────────────▼───────────────────────────────────────────────────────┐
│  src/session.ts + src/config.ts + src/purposes.ts  application        │
│    RemoteSession implements Session behind a KernelPort               │
└───────────────┬───────────────────────────────────────────────────────┘
                │ depends on  KernelPort / ServerPort  (interfaces)
┌───────────────▼───────────────────────────────────────────────────────┐
│  src/kernel/            adapters (ALL @jupyterlab/services lives here)│
│    port.ts                KernelPort / ServerPort — the seam          │
│    server.ts         ServerConnection + KernelManager + SessionManager│
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
adapter; `extensions/` is the composition root — it depends on the `Session`
interface but wires the concrete `RemoteSession` and `JupyterServer`. Two tiny
JSON stores sit at application level next to `session.ts`: `src/purposes.ts`
(what each kernel is FOR) and `src/notebooks.ts` (which notebook contents paths
pi has opened) — both are written by tools and read by the list tools; neither
ever selects a session.

### Why the seam matters

`KernelPort` / `ServerPort` (`src/kernel/port.ts`) are the inversion point.
Because `RemoteSession` depends on the interface, the entire session lifecycle
is testable with a mock port — see `test/unit/session.test.ts`. And because
`JupyterKernel.execute()` is the single owner of the `IFuture` protocol, every
output-normalization branch is covered offline with a mock future — see
`test/unit/kernel.test.ts`.

## Who decides the kernel?

Two things are easy to conflate, and v3 separates them sharply:

- **The Jupyter Server connection** (url/token) is *user configuration*. It is
  the only thing `src/config.ts` requires (`JUPYTER_REMOTE_URL` /
  `JUPYTER_REMOTE_TOKEN`, env or `~/.pi-jupyter/config.json`).
- **Which kernel executes the code** (python3, ir, …) is fixed **when a
  notebook is opened** — it is *not* a per-call parameter anymore. Order:
  1. a **live session** bound to the path reuses its running kernel (attach);
  2. else the `kernel` parameter of `jupyter_open_notebook` (the agent's choice,
     overriding a recorded kernelspec — a warning is shown when they differ);
  3. else the kernelspec **recorded in the notebook file**;
  4. else the optional `config.kernelName` fallback;
  5. else `"python3"`.

`jupyter_repl`, `jupyter_add_dependencies` and `jupyter_save_notebook` run on
the *notebook's* session and never take a `kernel`.

Flow (see `extensions/repl.ts`):

1. `jupyter_list_kernels` connects to the configured server, reads
   `/api/kernelspecs` (`ServerPort.listKernelSpecs`) and shows the agent the
   available kernels — each annotated with its recorded purpose (from
   `~/.pi-jupyter/purposes.json`) plus the server default and any open
   notebook session bound to it. Kernels without a recorded purpose are flagged
   as new.
2. **Only a newly discovered kernel with no recorded purpose** triggers a
   question: the agent asks the user what it is for and stores the answer
   with `jupyter_set_kernel_purpose` → `src/purposes.ts` writes
   `~/.pi-jupyter/purposes.json` (`{ name: purpose }`, atomic replace).
   Already-recorded kernels are shown with their purpose and reused — no
   re-asking, in this session or later ones.
3. When a notebook must be opened that has no live kernel and no recorded
   kernelspec, the agent passes the matching kernelspec *name* as the `kernel`
   parameter of `jupyter_open_notebook`.

Consequences encoded in the code:

- `ShimConfig.kernelName` is optional and is **only a fallback default** for
  opens that pass no `kernel` and whose file records none. It never overrides
  an explicit agent choice or a file's kernelspec.
- Every session is keyed by its **remote contents path**
  (`Map<path, Session>`); the path, not the kernel, is a session's identity.
- `RemoteSession` receives the chosen kernel via `CreateSessionOpts.kernelName`
  and exposes it as `Session.kernelName` (surfaced in every tool result's
  `details.kernel`), so the agent can see which kernel actually ran.
- `jupyter_list_kernels` works with a throwaway `JupyterServer` instance, so
  listing never interferes with live sessions.
- Purpose notes live in a tiny JSON store (`src/purposes.ts`,
  `~/.pi-jupyter/purposes.json`), read by `jupyter_list_kernels` and written by
  `jupyter_set_kernel_purpose`. The store only carries the user's EXPLANATION —
  it never selects a kernel.

## Sessions, notebooks, and the agent flow

A pi conversation's state lives in the pi process and dies with it; the only
things that survive are (a) the notebook FILES on the server and (b) kernels
that keep running on the server. v3 makes both first-class so a NEW
conversation can continue earlier work — and, when the kernel is still alive,
**without starting or restarting a kernel at all**.

### The notebook path is the session's identity

A session is bound to a **remote contents path** (e.g. `notes/pi.ipynb`) — the
same string is the `/api/sessions` bind row, the auto-save target, and the file
the user opens in JupyterLab. `RemoteSession` adopts a path via
`resume(contentsPath)`:

1. **Live session → ATTACH.** `ServerPort.findLiveSession(path)` scans
   `GET /api/sessions`; when a row is bound to the path, `connectToSession()`
   adds a *new client* to the RUNNING kernel (`SessionManager.connectTo`).
   No kernel is started — in-memory variables from the earlier session or the
   browser survive. Attach failures (stale row, dead kernel) fall back to (2)
   with a warning instead of erroring out.
2. **File present, no live kernel → RESUME + REPLAY.** The `.ipynb` is read
   (`ServerPort.readNotebook`, contents GET) and parsed into a **document of
   slots** (`domain/notebook.ts` `parseNotebook`): code cells become
   `{kind:"code", record, restored:true, raw}` slots, every non-code cell
   (markdown/raw) is preserved VERBATIM as `{kind:"other", raw}`. A NEW kernel
   is then started **bound to the same path** (`sessionPath: path`), and — this
   is v3 — the document's code cells are executed **from the first to the
   last** (`replayFromStart` in `extensions/repl.ts`) so the in-memory state is
   rebuilt. The kernel serving a resumed notebook comes from the file's
   recorded kernelspec → the agent's `kernel` opt → `config.kernelName` →
   `python3`.
3. **No file → CREATE.** Same as (2) with an empty document (nothing to
   replay); the first auto-save materializes the file at the path.

Because the replay happens inside `jupyter_open_notebook`, a session opened
from a previously-closed notebook always returns with its state restored and a
per-cell report of any failures. `jupyter_repl` that finds the notebook not yet
open does the same replay before running the requested code — the invariant is
"a fresh kernel bound to a file has its cells re-run", no matter which tool
triggered the open. An *attach* never re-runs anything.

`Session.contentsPath` and `Session.listCells()` (restored + run cells, in
document order) let the tool layer tell the agent exactly what is there.

### The agent flow (encoded in the tool prompts)

1. `jupyter_list_notebooks` — detect whether a session is active (open this
   conversation / LIVE kernel on the server) and what else is resumable.
2. No active session, or switching to another notebook → `jupyter_open_notebook`
   (`path`, or `local_file` to import). `jupyter_list_kernels` first when the
   kernels are unknown.
3. If the open result says `started`, the previously-closed session was replayed
   from first to last (state restored, failures listed).
4. Continuing an active session → `jupyter_repl(notebook=<same path>, code=…)`
   reuses the session.

### Re-running identical code happens IN PLACE

`runCell` re-executes IN PLACE whenever the document already holds a code cell
whose source equals the executed code — a restored file cell AND a cell run
earlier in this session alike. The execution lands back in THAT slot (same cell
id, outputs replaced; a restored slot drops its verbatim `raw` so the fresh
result serializes), and the match repeats on every identical re-run: re-running
the same code never duplicates the cell, so the notebook keeps one copy per
logical cell, like JupyterLab. Only code that matches no existing cell appends a
new code slot. Replaying a file with a fresh kernel therefore does not
duplicate the document — each logical cell executes once in place.

### Kernel lifecycle: keep-alive for notebooks (default)

Continuation is only possible if the kernel survives the conversation, so the
`session_shutdown` cleanup **detaches** instead of shutting down:
`RemoteSession.detach()` flushes the final snapshot and disposes this client's
connections but leaves the server-side kernel/session row running.

- **All sessions are notebook sessions** (opened via `jupyter_open_notebook`),
  and are detached by default (`config.keepKernels`, env `JUPYTER_KEEP_KERNELS=0`
  restores kill-on-exit). The kernel keeps running until
  `jupyter_shutdown_notebook`, `/jupyter-reset`, a server-side restart, or the
  server stops — exactly the JupyterLab mental model, so the browser and a
  later pi conversation attach to the SAME kernel.
- There is **no anonymous-per-kernel cleanup branch anymore** — nothing creates
  such sessions, so nothing leaks random kernels on the server between
  `/jupyter-reset` runs.

### Discovery: the notebooks registry

`src/notebooks.ts` keeps `~/.pi-jupyter/notebooks.json` (contents path →
`{kernelName, updated, source, localFile?}`), written whenever a session opens
(atomic tmp+rename, like `purposes.json`). `jupyter_list_notebooks` merges it
with the server's LIVE `/api/sessions` rows (`ServerPort.listSessions`) and
annotates every candidate: **LIVE kernel → attach, variables kept** vs
**file only → open starts a new kernel and re-runs its cells (state restored)**.
A brand-new conversation — empty session map, no in-memory state — therefore
still knows what it can continue. `jupyter_open_notebook` accepts a remote path
or a local `.ipynb` (imported under its file name via the contents PUT) and
returns the mode + the loaded code cells. `jupyter_repl`,
`jupyter_add_dependencies` and `jupyter_save_notebook` all take the same
`notebook` path (required).

## Decisions carried over from v1/v2 (and why)

- **Self-contained extension, not the v3.0 shim.** The v3.0 design proposed
  replacing `@runtimed/node` to reuse `@nteract/pi`'s 1300-line renderer.
  v1 chose to write the renderer (~300 lines) instead. We keep that choice:
  it removes the `@runtimed/node` native-binding install risk, needs no
  `NTERACT_RUNTIMED_NODE_PATH`, and is independently debuggable. The cost is
  ~300 lines of renderer we own outright.
- **`@jupyterlab/services` dual-channel execution.** iopub carries the output
  stream; the shell `execute_reply` carries the *authoritative*
  `execution_count` and terminal status; `future.done` resolves once both
  arrive. This is the correct protocol and we did not change it.
- **Tables degrade to text.** Remote Jupyter never emits nteract's proprietary
  table MIME types, so we get text fallback for free — no DataTable port.
- **Kernels outlive the client.** v1's "no orphan kernels on exit" existed
  because nothing could re-attach a kernel. Since v2.6 kernels are the
  server-side continuation point (`ServerPort.findLiveSession` /
  `connectToSession`), so "leaving a kernel running" stops being a leak and
  becomes the resume path — with explicit cleanup (`/jupyter-reset`,
  `jupyter_shutdown_notebook`) and an opt-out (`JUPYTER_KEEP_KERNELS=0`).
- **nbformat is parsed as well as written.** Serializing was one-way in v1.
  Resuming a file requires the inverse — `domain/notebook.ts` now owns both
  directions (cells → nbformat, nbformat → slots → cells) and the round-trip
  is unit-tested, so adopted notebooks never lose markdown/raw cells.

## v3 deltas vs v2 (the notebook-only model)

| Aspect | v2 | v3 |
|--------|----|----|
| `jupyter_repl` params | `notebook?` + `kernel?` + `dependencies?` | `notebook` **required**; no `kernel`, no `dependencies` |
| `jupyter_add_dependencies` / `jupyter_save_notebook` | `notebook?` + `kernel?` | `notebook` **required**; no `kernel` |
| Session kinds | notebook + anonymous-per-kernel | notebook only |
| Kernel selection | agent's `kernel` param on every code call | fixed at open time (file kernelspec → `kernel` opt on open → config fallback → python3) |
| Open of a closed notebook | loads cells; agent re-runs setup cells | starts a new kernel and **re-runs all cells first → last** (state restored) |
| Cleanup on conversation end | shutdown anon kernels + detach named | detach every notebook session (keep-kernels default) |
| Dependency install | in `jupyter_repl` or `jupyter_add_dependencies` | `jupyter_add_dependencies(notebook=…)` only |

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
| `test/unit/` | vitest, mock `IFuture` + mock `KernelPort`/`ServerPort` (incl. notebook parsing, resume attach/start, registry) | **No** |
| `test/integration/smoke.test.ts` | node --import tsx, real server | Yes |

`npm test` runs the offline suite; `npm run test:integration` runs the live
one. The v3 session-policy (notebook required, replay-on-start, per-path
keying) is enforced at the `extensions/repl.ts` tool layer; `RemoteSession`
itself keeps a single, notebook-agnostic implementation that the offline suite
covers end-to-end.

## Build

`npm run build` (tsup) emits ESM/CJS bundles and type declarations from `src/index.ts`
for consumers who want the library API. The pi extension itself is loaded
from `.ts` source via `package.json` → `pi.extensions`.
