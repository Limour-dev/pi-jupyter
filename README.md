# pi-jupyter v2

Run code (Python, R, …) on a **remote Jupyter Server** from inside the pi coding agent.
Pure TypeScript, no local daemon — code runs on a remote Jupyter Server via `@jupyterlab/services`.

This is a ground-up refactor of v1 around a hexagonal (ports & adapters)
architecture. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design
rationale and the lessons carried over from v1.

## Features

- `jupyter_repl` — persistent remote Jupyter kernel; state survives between calls
- `jupyter_list_kernels` — discover the kernels (python3, ir, …) on the server; shows each kernel's recorded purpose and flags new ones with none
- `jupyter_add_dependencies` — hot-install packages into a running kernel (`%pip` for Python, `install.packages` for R), no restart
- `jupyter_set_kernel_purpose` — persist the user's explanation of what a kernel is for (across sessions)
- `jupyter_save_notebook` — export a session as a valid `.ipynb`
- **Remote auto-save** — after every cell, the notebook snapshot is uploaded to the remote server (remote `$HOME` by default), so the *same kernel* can be re-opened in a browser
- `/jupyter-reset` — drop all kernels and start clean
- Inline matplotlib/PIL images returned to the model
- Streaming output, execution-timeout interrupt, no orphan kernels on exit

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

### Which kernel runs the code? The agent decides.

The Jupyter Server connection (url/token) is user-configured, but **which
kernel** executes your code (python3, ir, …) is **not configured** anywhere.
The agent discovers the kernels itself with `jupyter_list_kernels`, picks the
matching one per task and passes it as the `kernel` parameter of
`jupyter_repl` / `jupyter_add_dependencies` / `jupyter_save_notebook`. Each
kernel keeps its own persistent session, so switching python3 ↔ R never
loses state.

**What each kernel is for** ("python3 → data wrangling", "ir → statistics") is
remembered across sessions in `~/.pi-jupyter/purposes.json` (a tiny JSON map
`{ name: purpose }`, editable by hand too). Only a *newly discovered kernel
with no recorded purpose* makes the agent ask you once; it then saves your
answer with `jupyter_set_kernel_purpose`, and every later session shows the
purpose and auto-selects without re-asking.

| Env var | Default | Meaning |
|---------|---------|---------|
| `JUPYTER_REMOTE_URL` | *required* | Server base URL (user-set) |
| `JUPYTER_REMOTE_TOKEN` | *required* | Auth token (user-set) |
| `JUPYTER_KERNEL_NAME` | *none* | Optional fallback default kernel only — used when a tool call omits `kernel`; normally the agent picks per call |
| `JUPYTER_REMOTE_TLS_INSECURE` | off | Skip TLS validation (dev only) |
| `JUPYTER_REMOTE_TIMEOUT_MS` | `300000` | Per-cell timeout |
| `JUPYTER_INSTALL_TIMEOUT_MS` | `600000` | Package-install timeout |
| `JUPYTER_WORKING_DIR` | process cwd | Base dir for relative `save_notebook` paths |
| `JUPYTER_TIMEOUT_RESTART_KERNEL` | off | Restart a kernel still busy after a timeout (state lost) |
| `JUPYTER_BIND_SESSION` | on | Bind the kernel to an `/api/sessions` row so it shows in the Jupyter Running UI (`=0` restores bare-kernel behavior) |
| `JUPYTER_REMOTE_AUTOSAVE` | on | Upload the notebook snapshot to the remote server after every cell (`=0` disables) |
| `JUPYTER_REMOTE_SAVE_PATH` | `<notebookId>.ipynb` | Remote contents path for the auto-save, e.g. `notes/pi.ipynb` |
## Remote auto-save

After every `jupyter_repl` cell (success, error, or timeout alike) the session
snapshot is uploaded to the remote Jupyter Server via the Contents API
(`PUT /api/contents/<path>`). The upload is a by-pass: it never blocks or
changes the tool result, rapid cells are coalesced (an older snapshot can
never overwrite a newer one), and failures only produce a warning.

- **Default target = remote `$HOME`.** The file is written to the contents
  root as `<notebookId>.ipynb`. In a default `jupyter_server` deployment the
  contents root *is* the remote user's home directory (`root_dir == $HOME`).
  If your server set a custom `root_dir`, use `JUPYTER_REMOTE_SAVE_PATH`.
  The local machine's home directory is never involved.
- **Open in a browser, reuse the same kernel.** The auto-save path and the
  `/api/sessions` bind row share one name, so opening that `.ipynb` in
  JupyterLab connects to the *running* kernel — variables are shared both
  ways between the browser and the agent.
- **`JUPYTER_REMOTE_SAVE_PATH`** overrides the path (sub-directories are
  created automatically; `..` segments are rejected). A fixed name gives a
  live single-file mirror — intended for single-instance use only.
- `jupyter_save_notebook` is unchanged: it still writes **locally** and is
  independent of the remote auto-save.

## Multiple kernels (R and others)

The extension is language-aware: the chosen kernel's kernelspec drives the
install command, the bootstrap code, and the metadata of saved notebooks.

Each `kernel` value must be a kernelspec **name**, not a display name — e.g.
`ir`, not `R`. Run `jupyter_list_kernels` inside pi (or curl the endpoint
below) to see what the server offers:

```bash
curl -s -H "Authorization: token YOUR-TOKEN" \
  http://192.168.105.1:57002/api/kernelspecs \
  | jq '.kernelspecs | to_entries[] | {name: .key, display: .value.spec.display_name, language: .value.spec.language}'
```

If the chosen `kernel` matches no spec, initialization fails with the full
list of available kernels grouped by language.

Typical first-run flow — only the new kernels without a recorded purpose are
asked about once; later sessions reuse the notes:

```text
agent: jupyter_list_kernels
       → python3  (purpose recorded: data wrangling)      # reuse, no question
       → ir      (purpose: not recorded)  ← NEW
agent: "What is the ir kernel for?"
you:   "statistics with R"
agent: jupyter_set_kernel_purpose(kernel="ir", purpose="statistics with R")
agent: jupyter_repl(kernel="ir", code="...")           # per-task choice
```

R example — tell the agent the R kernel exists (`kernel: "ir"`), or
optionally pin it as the fallback default in `~/.pi-jupyter/config.json`
(`"kernelName": "ir"`); the agent still overrides per call:

```json
{
  "url": "http://192.168.105.1:57002",
  "token": "your-token-here",
  "kernelName": "ir"   // optional fallback ONLY — the agent picks per call
}
```

Language-specific behavior:

- `jupyter_add_dependencies` maps to `%pip install` for Python kernels and to
  `install.packages(..., repos = "https://cloud.r-project.org")` (CRAN names)
  for R kernels; unsupported languages fail with an explicit error. Failed
  installs are reported, never silently treated as success.
- Saved `.ipynb` files declare the real kernelspec (e.g. `ir` / `r`), so
  Jupyter and VSCode open them with the correct kernel.
- The matplotlib inline bootstrap and the missing-package probe run only on
  Python kernels.
- Timeouts interrupt the kernel, but SIGINT is best-effort: a kernel that
  ignores it (e.g. R inside a long C loop) stays busy. The next call then
  fails fast with a clear `kernel still busy` error instead of silently
  queueing; set `JUPYTER_TIMEOUT_RESTART_KERNEL=1` (or `"timeoutRestartKernel":
  true`) to auto-restart instead — in-memory state will be lost.

Troubleshooting:

- `kernel "R" not found` — use the spec name (`ir`), not the display name, as the `kernel` value.
- Save paths: relative paths resolve against the pi working directory; prefer
  absolute paths or `~/`, or set `JUPYTER_WORKING_DIR`.

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
src/config.ts    server connection only (url/token); the kernel is agent-decided per call
src/purposes.ts   persistent per-kernel purpose notes (~/.pi-jupyter/purposes.json)
extensions/      pi extension (repl, format, schemas)
test/unit/       offline vitest suite (mock IFuture + mock KernelPort)
test/integration live smoke test
```

## Requirements

- Node ≥ 22
- A reachable Jupyter Server (`jupyter_server`) with a token
