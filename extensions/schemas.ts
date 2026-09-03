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
      'Kernelspec *name* (e.g. "python3" or "ir", from jupyter_list_kernels) to serve this notebook when no live kernel is bound to it. Overrides the notebook file\'s recorded kernelspec (a warning is shown when they differ); omit for the file\'s kernelspec, then the config fallback.',
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
    'Remote contents path of the notebook session to run in, e.g. "notes/pi.ipynb" (as opened via jupyter_open_notebook). Required.',
});

export const JUPYTER_PARAMS = Type.Object({
  notebook: NOTEBOOK,
  code: Type.String({
    description:
      "Code to execute in the notebook's persistent kernel. Use print()/display() for side effects; the last expression's repr is the result. Re-running the same source as an existing cell executes it in place (same cell id, no duplicate); new code appends a cell.",
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
    description: "Package specs to install (e.g. ['matplotlib', 'pandas>=2']).",
  }),
});

export const SAVE_NOTEBOOK_PARAMS = Type.Object({
  notebook: NOTEBOOK,
  path: Type.Optional(
    Type.String({
      description:
        "Local path to save the .ipynb to (default: <notebook-id>.ipynb in the working directory). Prefer an absolute path or ~/ — relative paths resolve against the working directory.",
    }),
  ),
});

export const OPEN_NOTEBOOK_PARAMS = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        'Remote contents path of the notebook to open/continue, e.g. "notes/pi.ipynb" (as listed by jupyter_list_notebooks). Required unless `local_file` is given.',
    }),
  ),
  local_file: Type.Optional(
    Type.String({
      description:
        "Local .ipynb file to import — uploaded to the server under its file name and continued there. Required unless `path` is given.",
    }),
  ),
  kernel: KERNEL,
});

export const LIST_NOTEBOOKS_PARAMS = Type.Object({});

export const SHUTDOWN_NOTEBOOK_PARAMS = Type.Object({
  path: Type.String({
    description:
      'Remote contents path of the notebook to shut down (kill its kernel and drop the session) — e.g. "notes/pi.ipynb".',
  }),
});

export const LIST_KERNELS_PARAMS = Type.Object({});

export const SET_KERNEL_PURPOSE_PARAMS = Type.Object({
  kernel: Type.String({
    description:
      'kernelspec *name* of the kernel, as shown by jupyter_list_kernels (e.g. "python3" or "ir") — not a display name like "R".',
  }),
  purpose: Type.String({
    description:
      'What this kernel is for, as the user explained (e.g. "data analysis with pandas") — persisted in ~/.pi-jupyter/purposes.json.',
  }),
});

export type JupyterParams = Static<typeof JUPYTER_PARAMS>;
export type AddDependenciesParams = Static<typeof ADD_DEPENDENCIES_PARAMS>;
export type SaveNotebookParams = Static<typeof SAVE_NOTEBOOK_PARAMS>;
export type OpenNotebookParams = Static<typeof OPEN_NOTEBOOK_PARAMS>;
export type ShutdownNotebookParams = Static<typeof SHUTDOWN_NOTEBOOK_PARAMS>;
export type SetKernelPurposeParams = Static<typeof SET_KERNEL_PURPOSE_PARAMS>;
