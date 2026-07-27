/**
 * Tool parameter schemas (TypeBox).
 *
 * Extracted from the extension so the wiring in `repl.ts` stays declarative.
 */
import { Type, type Static } from "typebox";

export const JUPYTER_PARAMS = Type.Object({
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
  packages: Type.Array(Type.String(), {
    description: "Package specs (e.g. ['matplotlib', 'pandas>=2']).",
  }),
});

export const SAVE_NOTEBOOK_PARAMS = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        "File path to save to (e.g. './analysis.ipynb'). Prefer an absolute path or ~/; relative paths resolve against the current working directory. If omitted, saves to <notebook-id>.ipynb in the working directory.",
    }),
  ),
});

export type JupyterParams = Static<typeof JUPYTER_PARAMS>;
export type AddDependenciesParams = Static<typeof ADD_DEPENDENCIES_PARAMS>;
export type SaveNotebookParams = Static<typeof SAVE_NOTEBOOK_PARAMS>;
