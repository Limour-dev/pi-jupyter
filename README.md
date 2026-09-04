# pi-jupyter v3

Run code (Python, R, …) on a **remote Jupyter Server** from inside the pi coding agent,
**always inside a notebook**. Pure TypeScript, no local daemon — code runs on a remote
Jupyter Server via `@jupyterlab/services`.

This is a refactor of v2 around **notebook-only sessions**: every execution targets a
notebook contents path opened with `jupyter_open_notebook`; anonymous kernel-only
sessions are gone (`jupyter_repl` requires `notebook` and no longer takes `kernel` or
`dependencies`). See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design rationale.

## Features

- `jupyter_list_notebooks(dir=…)` — FIRST step, **scoped to one remote contents directory**: shows the notebooks that are ACTIVE (open this
  conversation / LIVE kernel on the server) or resumable from a saved file, taking only **direct children of `dir`** — it never recurses into
  subdirectories, so the list stays small as more folders accumulate (pass `"."` for the server root)
- `jupyter_open_notebook` — start an ACTIVE session on a notebook: attaches to its
  still-running kernel when one is bound to the path (no new kernel, variables kept), or
  starts a NEW kernel bound to the same path and **re-runs the file's code cells from
  first to last** so the in-memory state is restored (previously-closed session)
- `jupyter_repl` — execute code in the active notebook session (`notebook` is required and
  the call REUSES that session); variables/imports persist between calls
- `jupyter_add_dependencies` — hot-install packages into a notebook's kernel (`%pip` for
  Python, `install.packages` for R), no restart — **OPT-IN tool** (off by default, see *Tool gates* below)
- `jupyter_list_kernels` — discover the kernels (python3, ir, …) on the server; shows each
  kernel's recorded purpose and flags new ones with none
- `jupyter_set_kernel_purpose` — persist the user's explanation of what a kernel is for
- `jupyter_save_notebook` — export a notebook session as a valid `.ipynb` — **OPT-IN tool**
  (off by default, see *Tool gates* below)
- `jupyter_shutdown_notebook` — kill one notebook's kernel (the .ipynb file stays)
- **Remote auto-save** — after every cell, the notebook snapshot is uploaded to the remote
  server (remote `$HOME` by default), so the *same kernel* can be re-opened in a browser
- **Kernels outlive the conversation** — notebook kernels keep running on the server when
  pi ends, so a later conversation can attach to them again (`JUPYTER_KEEP_KERNELS=0`
  restores kill-on-exit)
- `/jupyter-reset` — shut down ALL open notebook sessions; saved .ipynb files stay and can
  be resumed (clean slate: their cells are re-run on the next open)
- Inline matplotlib/PIL images returned to the model
- Streaming output, execution-timeout interrupt; cleanup is explicit (`/jupyter-reset`,
  `jupyter_shutdown_notebook`)

## Quick start

```bash
pi install git:github.com/Limour-dev/pi-jupyter
```

Then set the environment variables:

```bash
export JUPYTER_REMOTE_URL=http://192.168.105.1:57002
export JUPYTER_REMOTE_TOKEN=123456
```

Optional config file: `~/.pi-jupyter/config.json`
(see [`config.example.json`](./config.example.json)). Env vars win over the file.

### Tool gates (both default OFF)

`jupyter_add_dependencies` and `jupyter_save_notebook` are **not registered by default** —
each is loaded only when its gate is on, in `~/.pi-jupyter/config.json`: `"enableAddDependencies": true`
loads `jupyter_add_dependencies`; `"enableSaveNotebook": true` loads `jupyter_save_notebook`.
Equivalently via env `JUPYTER_ENABLE_ADD_DEPENDENCIES=1` / `JUPYTER_ENABLE_SAVE_NOTEBOOK=1`
(env wins). When a gate is off the tool does not exist for the agent at all: it is never
prompted to install packages or write `.ipynb` files, and the `jupyter_repl` /
`jupyter_list_notebooks` help text stops naming it.

## How an agent should drive it (the notebook flow)

There are **no anonymous kernel sessions**: code always runs on the kernel of a notebook
that was opened by `jupyter_open_notebook`. A NEW agent follows this flow:

1. `jupyter_list_notebooks(dir=…)` — detect whether a session is already active in the current remote folder (`dir` is required; only notebooks sitting directly in it are shown — no recursion).
2. No active session, or switching to another notebook → `jupyter_open_notebook`
   (`path` from the list, or `local_file` to import). If you do not know which kernels
   the server offers, call `jupyter_list_kernels` first.
3. `jupyter_open_notebook` on a notebook whose kernel was **previously closed** starts a
   NEW kernel bound to the same path and **executes its cells from the first to the last**
   automatically — that is what rebuilds the in-memory state.
4. Then run code with `jupyter_repl(notebook=<same path>, code=…)`. When a session is
   already active and you are continuing it, `jupyter_repl` simply REUSES it.

```text
you:   "continue my notes/pi.ipynb"
agent: jupyter_list_notebooks(dir=".")             # 1. is a session active?
       → notes/pi.ipynb   (kernel python3)  [LIVE kernel — open attaches, variables kept]
       → analysis.ipynb   (kernel ir)       [file only — open starts a fresh kernel]
agent: jupyter_open_notebook(path="notes/pi.ipynb")   # 2. continue / switch
       → Attached to the LIVE kernel — variables intact (no re-run)
agent: jupyter_repl(notebook="notes/pi.ipynb", code="...")   # 4. reuse the session
```

### Which kernel runs the code? Decided when the notebook is opened.

The Jupyter Server connection (url/token) is user-configured, but **which kernel** serves
a notebook (python3, ir, …) is decided **when the notebook is opened**, in this order:

1. a LIVE session bound to the path — attaching keeps its running kernel,
2. the `kernel` parameter passed to `jupyter_open_notebook` (kernelspec *name*; it
   overrides the file's recorded kernel — a warning is shown when they differ),
3. the kernelspec recorded in the notebook file (when no explicit `kernel` is given),
4. the optional `JUPYTER_KERNEL_NAME` config fallback,
5. `python3`.

`jupyter_repl`, `jupyter_add_dependencies` and `jupyter_save_notebook` never take a
`kernel` — they act on the notebook session whose kernel was already fixed.

**What each kernel is for** ("python3 → data wrangling", "ir → statistics") is remembered
across sessions in `~/.pi-jupyter/purposes.json` (a tiny JSON map `{ name: purpose }`,
editable by hand too). Only a *newly discovered kernel with no recorded purpose* makes the
agent ask you once; it then saves your answer with `jupyter_set_kernel_purpose`, and every
later `jupyter_list_kernels` shows the purpose.

| Env var | Default | Meaning |
|---------|---------|---------|
| `JUPYTER_REMOTE_URL` | *required* | Server base URL (user-set) |
| `JUPYTER_REMOTE_TOKEN` | *required* | Auth token (user-set) |
| `JUPYTER_KERNEL_NAME` | *none* | Optional fallback default kernel only — used when opening a notebook that records no kernel and gets none explicitly; normally the notebook's kernelspec decides |
| `JUPYTER_REMOTE_TLS_INSECURE` | off | Skip TLS validation (dev only) |
| `JUPYTER_REMOTE_TIMEOUT_MS` | `300000` | Per-cell timeout |
| `JUPYTER_INSTALL_TIMEOUT_MS` | `600000` | Package-install timeout |
| `JUPYTER_WORKING_DIR` | process cwd | Base dir for relative `save_notebook` paths |
| `JUPYTER_TIMEOUT_RESTART_KERNEL` | off | Restart a kernel still busy after a timeout (state lost) |
| `JUPYTER_BIND_SESSION` | on | Bind the kernel to an `/api/sessions` row so it shows in the Jupyter Running UI (`=0` restores bare-kernel behavior) |
| `JUPYTER_KEEP_KERNELS` | on | Notebook kernels keep running on the server when a pi conversation ends, so a later conversation/browser can re-attach to the same notebook (variables kept). `=0` restores kill-on-exit |
| `JUPYTER_REMOTE_AUTOSAVE` | on | Upload the notebook snapshot to the remote server after every cell (`=0` disables) |
| `JUPYTER_REMOTE_SAVE_PATH` | — | Legacy override only for sessions created WITHOUT an explicit path — every session today opens a named notebook, so it is rarely used |
| `JUPYTER_ENABLE_ADD_DEPENDENCIES` | off | Load the `jupyter_add_dependencies` tool (opt-in, see *Tool gates*) |
| `JUPYTER_ENABLE_SAVE_NOTEBOOK` | off | Load the `jupyter_save_notebook` tool (opt-in, see *Tool gates*) |

## Continuity across conversations

A NEW conversation can pick up where an earlier one left off — no re-running everything
from scratch, and when the kernel is still alive, **no new kernel at all**. What pi has
opened is remembered in `~/.pi-jupyter/notebooks.json` (contents path → kernel), and
`jupyter_list_notebooks(dir=…)` merges that registry with the server's live `/api/sessions` rows and shows only notebooks sitting **directly in `dir`** (never recursing into subdirectories).

- **The notebook is a remote contents path** (e.g. `notes/pi.ipynb`): the same path is the
  `/api/sessions` bind row and the auto-save target, so the file you open in JupyterLab,
  the kernel the browser attaches to, and the session pi resumes are one object.
- **Live kernel → attach.** When a kernel is still running bound to that path (left by an
  earlier pi conversation or opened in the browser), `jupyter_open_notebook` re-connects to
  it — in-memory variables/imports are preserved and nothing restarts. This works across
  conversations because notebook kernels are **not killed** when a pi conversation ends
  (`JUPYTER_KEEP_KERNELS=0` restores kill-on-exit).
- **File only (previously-closed session) → resume with replay.** If no kernel is running,
  a NEW kernel is started *bound to the same path* and the file's code cells are executed
  **from first to last automatically**, so the in-memory state is rebuilt before any
  `jupyter_repl` call. Re-running identical source executes IN PLACE (same cell id,
  outputs replaced), so the notebook keeps one copy per logical cell — like JupyterLab.
  The open result lists each cell and any failures.
- **Local file → import.** `jupyter_open_notebook(local_file="./x.ipynb")` uploads the file
  to the server (under its file name) and continues it there (imported cells are re-run
  the same way).
- **Always keep passing the notebook path.** Once a notebook is open, all of
  `jupyter_repl`, `jupyter_add_dependencies` and `jupyter_save_notebook` reuse that session
  by its `notebook` path.

## Remote auto-save

After every `jupyter_repl` cell (success, error, or timeout alike) the session snapshot is
uploaded to the remote Jupyter Server via the Contents API (`PUT /api/contents/<path>`).
The upload is a by-pass: it never blocks or changes the tool result, rapid cells are
coalesced (an older snapshot can never overwrite a newer one), and failures only produce a
warning.

- **Default target = remote `$HOME`.** The file is written to the contents root as the
  notebook's path. In a default `jupyter_server` deployment the contents root *is* the
  remote user's home directory (`root_dir == $HOME`). The local machine's home directory is
  never involved.
- **Open in a browser, reuse the same kernel.** The auto-save path and the `/api/sessions`
  bind row share one name, so opening that `.ipynb` in JupyterLab connects to the *running*
  kernel — variables are shared both ways between the browser and the agent.
- `jupyter_save_notebook` is unchanged: it still writes **locally** and is independent of
  the remote auto-save.

## Multiple kernels (R and others)

The extension is language-aware: a notebook's kernel drives the install command, the
bootstrap code, and the metadata of saved notebooks.

Each `kernel` value must be a kernelspec **name**, not a display name — e.g. `ir`, not
`R`. Run `jupyter_list_kernels` inside pi (or curl the endpoint below) to see what the
server offers:

```bash
curl -s -H "Authorization: token YOUR-TOKEN" \
  http://192.168.105.1:57002/api/kernelspecs \
  | jq '.kernelspecs | to_entries[] | {name: .key, display: .value.spec.display_name, language: .value.spec.language}'
```

Typical first-run flow — only new kernels without a recorded purpose are asked about once;
later sessions reuse the notes:

```text
agent: jupyter_list_notebooks(dir=".")      # none yet — no active session
agent: jupyter_list_kernels
       → python3  (purpose recorded: data wrangling)      # reuse, no question
       → ir      (purpose: not recorded)  ← NEW
agent: "What is the ir kernel for?"
you:   "statistics with R"
agent: jupyter_set_kernel_purpose(kernel="ir", purpose="statistics with R")
agent: jupyter_open_notebook(path="analysis.ipynb", kernel="ir")   # R notebook
       → new ir kernel started (no file yet) — starts empty
agent: jupyter_repl(notebook="analysis.ipynb", code="...")          # run in it
```

You can pin a fallback kernel in `~/.pi-jupyter/config.json` (`"kernelName": "ir"`); it is
used only when opening a notebook that records no kernel and gets none explicitly:

```json
{
  "url": "http://192.168.105.1:57002",
  "token": "your-token-here",
  "kernelName": "ir"   // optional fallback ONLY — the notebook's kernelspec decides first
}
```

Language-specific behavior:

- `jupyter_add_dependencies` maps to `%pip install` for Python kernels and to
  `install.packages(..., repos = "https://cloud.r-project.org")` (CRAN names) for R
  kernels; unsupported languages fail with an explicit error. Failed installs are
  reported, never silently treated as success.
- Saved `.ipynb` files declare the real kernelspec (e.g. `ir` / `r`), so Jupyter and VSCode
  open them with the correct kernel.
- The matplotlib inline bootstrap and the missing-package probe run only on Python kernels.
- Timeouts interrupt the kernel, but SIGINT is best-effort: a kernel that ignores it (e.g.
  R inside a long C loop) stays busy. The next call then fails fast with a clear
  `kernel still busy` error instead of silently queueing; set
  `JUPYTER_TIMEOUT_RESTART_KERNEL=1` (or `"timeoutRestartKernel": true`) to auto-restart
  instead — in-memory state will be lost.

Troubleshooting:

- `kernel "R" not found` — use the spec name (`ir`), not the display name, as the `kernel`
  value of `jupyter_open_notebook`.
- Save paths: relative paths resolve against the pi working directory; prefer absolute
  paths or `~/`, or set `JUPYTER_WORKING_DIR`.

## Development

```bash
npm install --include=dev      # NODE_ENV=production environments need --include=dev
npm run typecheck              # tsc --noEmit
npm test                       # offline unit suite (vitest, no server)
npm run test:integration       # live smoke test (needs JUPYTER_REMOTE_*)
npm run build                  # tsup → dist/
```

## Layout

```
src/domain/      pure core, zero external deps  (types, output, notebook, deps, bootstrap, subject)
src/kernel/      @jupyterlab/services adapters  (port, server, kernel, convert)
src/session.ts   RemoteSession behind KernelPort
src/config.ts    server connection only (url/token); the kernel is fixed when a notebook is opened
src/purposes.ts    persistent per-kernel purpose notes (~/.pi-jupyter/purposes.json)
src/notebooks.ts   known-notebook registry (~/.pi-jupyter/notebooks.json) for cross-conversation resume
extensions/      pi extension (repl, format, schemas)
test/unit/       offline vitest suite (mock IFuture + mock KernelPort)
test/integration live smoke test
```

## Requirements

- Node ≥ 22
- A reachable Jupyter Server (`jupyter_server`) with a token
