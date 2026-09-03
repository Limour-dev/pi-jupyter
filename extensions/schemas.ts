/**
 * Tool parameter schemas (TypeBox).
 *
 * Extracted from the extension so the wiring in `repl.ts` stays declarative.
 */
import { Type, type Static } from "typebox";

/**
 * Optional `kernel` parameter — kept ONLY on `jupyter_open_notebook`: which
 * kernel runs the code (kernelspec *name* such as "python3" / "ir") is picked
 * when a notebook is opened/created. jupyter_repl and the other session tools
 * no longer take `kernel` — they run on the notebook's session, whose kernel
 * was fixed at open time (live kernel / file's recorded kernelspec / this
 * param / config fallback).
 */
const KERNEL = Type.Optional(
  Type.String({
    description:
      "Kernel to serve this notebook — a kernelspec *name* discovered via jupyter_list_kernels, e.g. \"python3\" or \"ir\". A live kernel bound to the path is always kept; otherwise this overrides the notebook file's recorded kernelspec (a warning is shown when they differ). Omit to use the file's kernelspec, then the config fallback.",
  }),
);

/**
 * Required `notebook` param — the remote contents path of the notebook session
 * to run in. Sessions are per notebook path: every execution/install/save
 * targets a notebook that was opened with `jupyter_open_notebook` (which
 * attaches to its live kernel or resumes the file and re-runs its cells to
 * restore state). There are NO anonymous/kernel-only sessions anymore.
 */
const NOTEBOOK = Type.String({
  description:
    "Remote contents path of the notebook session to run in, e.g. \"notes/pi.ipynb\" " +
      "(open/continue it first with jupyter_open_notebook, then pass the same path here). Required.",
});

export const JUPYTER_PARAMS = Type.Object({
  notebook: NOTEBOOK,
  code: Type.String({
    description:
      "Python source to execute in the notebook's persistent remote kernel. Use print(...) for side effects; the last expression's repr is returned as the result. Re-running code whose source matches an existing cell (loaded from the file or run earlier this session) executes IN PLACE — same cell id, outputs replaced, never a duplicate. Different code appends a new cell.",
  }),
  timeout_secs: Type.Optional(
    Type.Number({
      description: "Max seconds to wait for execution (default 120).",
      default: 120,
    }),
  ),
});

export const ADD_DEPENDENCIES_PARAMS = Type.Object({
  notebook: NOTEBOOK,
  packages: Type.Array(Type.String(), {
    description: "Package specs (e.g. ['matplotlib', 'pandas>=2']).",
  }),
});

export const SAVE_NOTEBOOK_PARAMS = Type.Object({
  notebook: NOTEBOOK,
  path: Type.Optional(
    Type.String({
      description:
        "File path to save to (e.g. './analysis.ipynb'). Prefer an absolute path or ~/; relative paths resolve against the current working directory. If omitted, saves to <notebook-id>.ipynb in the working directory.",
    }),
  ),
});

export const OPEN_NOTEBOOK_PARAMS = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "Remote contents path of the notebook to open/continue on the Jupyter Server, e.g. \"notes/pi.ipynb\" (as shown by jupyter_list_notebooks). One of `path` or `local_file` is required.",
    }),
  ),
  local_file: Type.Optional(
    Type.String({
      description:
        "Local .ipynb file to IMPORT into the server (under its file name at the contents root) and then continue as the remote notebook. One of `path` or `local_file` is required.",
    }),
  ),
  kernel: KERNEL,
});

export const LIST_NOTEBOOKS_PARAMS = Type.Object({});

export const SHUTDOWN_NOTEBOOK_PARAMS = Type.Object({
  path: Type.String({
    description:
      "Remote contents path of the notebook to shut down (kill its kernel and drop the session) — e.g. \"notes/pi.ipynb\".",
  }),
});

export const LIST_KERNELS_PARAMS = Type.Object({});

export const SET_KERNEL_PURPOSE_PARAMS = Type.Object({
  kernel: Type.String({
    description:
      "kernelspec *name* of the kernel, as shown by jupyter_list_kernels (e.g. \"python3\" or \"ir\") — not a display name like \"R\".",
  }),
  purpose: Type.String({
    description:
      "What this kernel is for, as the user explained — e.g. \"data analysis with pandas\" or \"statistics in R\". Persisted across sessions in ~/.pi-jupyter/purposes.json.",
  }),
});

export type JupyterParams = Static<typeof JUPYTER_PARAMS>;
export type AddDependenciesParams = Static<typeof ADD_DEPENDENCIES_PARAMS>;
export type SaveNotebookParams = Static<typeof SAVE_NOTEBOOK_PARAMS>;
export type OpenNotebookParams = Static<typeof OPEN_NOTEBOOK_PARAMS>;
export type ShutdownNotebookParams = Static<typeof SHUTDOWN_NOTEBOOK_PARAMS>;
export type SetKernelPurposeParams = Static<typeof SET_KERNEL_PURPOSE_PARAMS>;
