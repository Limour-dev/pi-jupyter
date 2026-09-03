/**
 * Tool parameter schemas (TypeBox).
 *
 * Extracted from the extension so the wiring in `repl.ts` stays declarative.
 */
import { Type, type Static } from "typebox";

/**
 * Shared optional `kernel` parameter — the agent's per-call choice of which
 * kernel executes the code (kernelspec *name* such as "python3" / "ir").
 * The server itself (url/token) is user-configured and never appears here.
 */
const KERNEL = Type.Optional(
  Type.String({
    description:
      "Kernel to run on — a kernelspec *name* discovered via jupyter_list_kernels, e.g. \"python3\" or \"ir\". " +
        "The agent decides: first ask the user what each kernel is for, then pick the matching one per task. " +
        "Omit to use the default kernel.",
  }),
);

export const JUPYTER_PARAMS = Type.Object({
  kernel: KERNEL,
  code: Type.String({
    description:
      "Python source to execute in the persistent remote notebook session. Use print(...) for side effects; the last expression's repr is returned as the result.",
  }),
  dependencies: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Packages to add before executing this code. On the first call they are recorded before the kernel starts; on later calls they are hot-installed into the kernel (pip-style specs for Python, CRAN names for R).",
    }),
  ),
  timeout_secs: Type.Optional(
    Type.Number({
      description: "Max seconds to wait for execution (default 120).",
      default: 120,
    }),
  ),
});

export const ADD_DEPENDENCIES_PARAMS = Type.Object({
  kernel: KERNEL,
  packages: Type.Array(Type.String(), {
    description: "Package specs (e.g. ['matplotlib', 'pandas>=2']).",
  }),
});

export const SAVE_NOTEBOOK_PARAMS = Type.Object({
  kernel: KERNEL,
  path: Type.Optional(
    Type.String({
      description:
        "File path to save to (e.g. './analysis.ipynb'). Prefer an absolute path or ~/; relative paths resolve against the current working directory. If omitted, saves to <notebook-id>.ipynb in the working directory.",
    }),
  ),
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
export type SetKernelPurposeParams = Static<typeof SET_KERNEL_PURPOSE_PARAMS>;
