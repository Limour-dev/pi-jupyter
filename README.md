# pi-jupyter v2

Run Python on a **remote Jupyter Server** from inside the pi coding agent.
Pure TypeScript, no local backend — the remote server *is* the backend.

This is a ground-up refactor of v1 around a hexagonal (ports & adapters)
architecture. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design
rationale and the lessons carried over from v1.

## Features

- `python_repl` — persistent remote IPython kernel; state survives between calls
- `python_add_dependencies` — hot-install packages via `%pip` (no restart)
- `python_save_notebook` — export the session as a valid `.ipynb`
- `/python-reset` — drop the kernel and start clean
- Inline matplotlib/PIL images returned to the model
- Streaming output, execution-timeout interrupt, no orphan kernels on exit

## Quick start

```bash
export JUPYTER_REMOTE_URL=http://192.168.105.1:57002
export JUPYTER_REMOTE_TOKEN=123456
```

Then install the extension into pi (or run `/reload` during development).
Optional config file: `~/.jupyter-remote-shim/config.json`
(see [`config.example.json`](./config.example.json)). Env vars win over the file.

| Env var | Default | Meaning |
|---------|---------|---------|
| `JUPYTER_REMOTE_URL` | *required* | Server base URL |
| `JUPYTER_REMOTE_TOKEN` | *required* | Auth token |
| `JUPYTER_KERNEL_NAME` | `python3` | Kernel spec name |
| `JUPYTER_REMOTE_TLS_INSECURE` | off | Skip TLS validation (dev only) |
| `JUPYTER_REMOTE_TIMEOUT_MS` | `300000` | Per-cell timeout |
| `JUPYTER_INSTALL_TIMEOUT_MS` | `600000` | `%pip` install timeout |

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
src/config.ts    env > file > default
extensions/      pi extension (repl, format, schemas)
test/unit/       offline vitest suite (mock IFuture + mock KernelPort)
test/integration live smoke test
```

## Requirements

- Node ≥ 22
- A reachable Jupyter Server (`jupyter_server`) with a token
