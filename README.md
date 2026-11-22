# pi-jupyter v3

Run Python, R, or another installed kernel on a remote Jupyter Server from pi. Each execution targets a notebook contents path (for example, `notes/pi.ipynb`). The path identifies both the session to reuse and the file to save. There is no local daemon. See [architecture](./ARCHITECTURE.md) for the design.

## Setup

Requires Node ≥ 22 and a reachable Jupyter Server with token authentication.

```bash
pi install git:github.com/Limour-dev/pi-jupyter
export JUPYTER_REMOTE_URL=http://host:8888
export JUPYTER_REMOTE_TOKEN=your-token-here
```

Alternatively, copy [config.example.json](./config.example.json) to `~/.pi-jupyter/config.json` and replace the connection settings:

```json
{
  "url": "http://host:8888",
  "token": "your-token-here"
}
```

The file is optional. An unreadable file or invalid JSON stops the extension rather than silently using defaults. Reload pi after changing configuration.

## Notebook workflow

The following example finds a notebook, inspects it without starting a kernel, then continues work in it:

```text
jupyter_list_notebooks(dir="notes")                       → notes/pi.ipynb
jupyter_read_cells(path="notes/pi.ipynb", query="import") → saved sources and cell IDs
jupyter_outputs(path="notes/pi.ipynb")                    → saved outputs
jupyter_repl(notebook="notes/pi.ipynb", code="x = 42")     → sets x in the kernel only
jupyter_repl(notebook="notes/pi.ipynb", code="x + 1", persist=true) → records the result
```

- **Inspect:** If the path is known, skip the listing. By default, only direct children of `dir` appear; use `recursive=true` to include subdirectories and `query` to filter paths.
- **Execute:** `jupyter_repl` reuses or opens the path. An attachable live kernel keeps its variables. Otherwise, a fresh kernel normally replays the file's code cells in order. Only a confirmed 404 starts an empty document. Use `jupyter_open_notebook` to request a kernel, import a `local_file`, or open with `replay="skip"`: skip still establishes an executable session but does not run the file cells. Concurrent opens share the first request's replay policy. Do not shut down and reopen to refresh a notebook.
- **Record or edit:** Code alone is scratch. A `cell_id` run records in place by default, using the cell's current source unless `code` is supplied. Explicit `persist` overrides either default. Use `jupyter_edit_cell` to insert, replace, move or delete cells; replacing clears stale outputs. Pass `run: true` with `insert` or `replace` to execute that cell immediately and record its outputs in place. Omit it or pass `false` to edit only. Don't edit the active `.ipynb` with another script.

Recorded runs schedule a background upload; scratch runs do not. Edits report the session change separately from the remote save. A timeout means the upload was not confirmed, not that the edit was rolled back. `jupyter_save_notebook` can export the current session document to a **local** file even if the remote copy is behind. Long REPL output is capped to the first 50 and last 100 lines; `details.output_truncated.log_path` points to the omitted text.

## Kernels and lifecycle

`jupyter_list_kernels` shows kernelspec names (e.g. `ir`, not the display name `R`). `jupyter_set_kernel_purpose` stores purpose notes in `~/.pi-jupyter/purposes.json`; notes do not select kernels. `jupyter_add_dependencies`, when enabled, uses `%pip` for Python and CRAN for R. A timeout interrupts execution; if the kernel remains busy, the next run fails unless restart-on-timeout is enabled.

Named kernels normally outlive the pi conversation. A browser or a later conversation can attach at the same path. `jupyter_shutdown_notebook` stops one kernel; `/jupyter-reset` stops this conversation's open kernels. Shutdown and detach attempt a final snapshot if the document changed. Stopping a kernel discards its in-memory variables, not the saved notebook.

## Configuration

| JSON key | Environment variable | Default / meaning |
|---|---|---|
| `url`, `token` | `JUPYTER_REMOTE_URL`, `JUPYTER_REMOTE_TOKEN` | Required connection settings |
| `kernelName` | `JUPYTER_KERNEL_NAME` | Optional fallback for a new kernel |
| `tlsInsecure` | `JUPYTER_REMOTE_TLS_INSECURE` | Off; skip TLS verification for development |
| `defaultTimeoutMs` | `JUPYTER_REMOTE_TIMEOUT_MS` | `300000` ms per cell; `timeout_secs` overrides for one REPL run |
| `installTimeoutMs` | `JUPYTER_INSTALL_TIMEOUT_MS` | `600000` ms per install |
| `workingDir` | `JUPYTER_WORKING_DIR` | Process cwd when no working directory is supplied |
| `timeoutRestartKernel` | `JUPYTER_TIMEOUT_RESTART_KERNEL` | Off; restart a still-busy kernel after a timeout (loses state) |
| `bindSession` | `JUPYTER_BIND_SESSION` | On; bind to a server session visible in the Running UI |
| `keepKernels` | `JUPYTER_KEEP_KERNELS` | On; detach rather than kill on conversation end |
| `remoteAutoSave` | `JUPYTER_REMOTE_AUTOSAVE` | On; upload recorded cells and document edits |
| `remoteSavePath` | `JUPYTER_REMOTE_SAVE_PATH` | Legacy override for library sessions without an explicit path |
| `enableAddDependencies` | `JUPYTER_ENABLE_ADD_DEPENDENCIES` | Off; opt in to installing packages |
| `enableSaveNotebook` | `JUPYTER_ENABLE_SAVE_NOTEBOOK` | On; allow local notebook export |

## Development

```bash
npm install --include=dev
npm test                  # offline unit tests
npm run typecheck
npm run build             # library bundles and declarations in dist/
npm run test:integration  # live smoke test; requires a configured server
```
