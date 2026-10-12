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
  code: Type.Optional(
    Type.String({
      description:
        "Code to execute in the notebook's persistent kernel. Use print()/display() for side effects; the last expression's repr is the result. Omit it (and pass `cell_id`) to re-run an existing cell from its current source. SCRATCH by default: the output comes back but the document is untouched unless `persist=true`, in which case re-running an existing same-source cell updates it in place (same cell id, no duplicate) and new code appends a cell.",
    }),
  ),
  cell_id: Type.Optional(
    Type.String({
      description:
        'Re-run the EXISTING code cell with this id (from jupyter_open_notebook details.cells, jupyter_outputs, or a jupyter_edit_cell result) using its CURRENT source — pass `cell_id` instead of `code` after jupyter_edit_cell(action="replace") to fill the cell\'s outputs again without retyping the source. A `cell_id` run records in place by default (persist defaults to true); pass persist=false for a scratch probe. When both are given, `code` is executed into that cell. Unknown ids are rejected before anything runs.',
    }),
  ),
  timeout_secs: Type.Optional(
    Type.Number({
      description: "Max seconds to wait for execution (default 120).",
      default: 120,
    }),
  ),
  persist: Type.Optional(
    Type.Boolean({
      description:
        "Record this run in the notebook document? Default false = SCRATCH: the code runs on the kernel and its output is returned, but it is NOT added as a cell and does NOT modify an existing matching cell, so exploratory/probe code never pollutes the saved .ipynb. Pass true when the run is real work worth keeping: an existing same-source cell then re-runs in place, or a new cell is appended, and the remote auto-save picks it up. This is the ONLY way to make a run appear in the .ipynb — never shut the notebook down and re-open it to try to see a run.",
      default: false,
    }),
  ),
  after_cell_id: Type.Optional(
    Type.String({
      description:
        "Record this run directly AFTER the code cell with this id instead of at the end of the document. Only meaningful with persist=true and when the code matches no existing cell (an in-place re-run keeps its own position). Unknown ids are rejected before anything runs. Use it to place a promoted scratch/probe cell where it belongs (issue 1-4).",
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
  replay: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("skip")], {
      description:
        'Whether to re-run the file\'s code cells when a fresh kernel is started: "auto" (default) replays them from first to last to rebuild the in-memory state; "skip" only LOADS the document (cell list + saved outputs) and executes nothing — use it when you just need to read the current file without paying for a full replay. A skipped replay leaves the new kernel with NO state, so later cells that depend on earlier ones must be re-run with jupyter_repl(notebook=…, persist=true). Only a "started" open (no live kernel) replays at all; an attach never replays.',
      default: "auto",
    }),
  ),
});

/**
 * Structural edits of an OPEN notebook's cells (issue 1-2): delete / replace /
 * move / insert one code cell. This is what makes the `.ipynb` itself editable
 * from inside the session, so the agent never has to touch the file from the
 * outside (the workaround whose in-flight snapshot could be rolled back).
 */
export const EDIT_CELL_PARAMS = Type.Object({
  notebook: NOTEBOOK,
  action: Type.Union(
    [Type.Literal("delete"), Type.Literal("replace"), Type.Literal("move"), Type.Literal("insert")],
    {
      description:
        'Edit to apply: "delete" removes a cell; "replace" swaps an existing cell\'s source (its stale outputs are cleared — re-run it with jupyter_repl(persist=true) to fill them again); "move" reorders a cell to `position`; "insert" adds a NEW un-executed cell.',
    },
  ),
  cell_id: Type.Optional(
    Type.String({
      description:
        'Target cell id (from jupyter_open_notebook details.cells or jupyter_outputs). Required for delete/replace/move; omit it for insert (or pass after_cell_id to anchor the new cell).',
    }),
  ),
  source: Type.Optional(
    Type.String({
      description: 'New cell source — required for "replace" and "insert".',
    }),
  ),
  position: Type.Optional(
    Type.Number({
      description:
        '0-based index among CODE cells: the destination for "move", or the insertion point for "insert" (ignored when after_cell_id is given). Omit to append.',
    }),
  ),
  after_cell_id: Type.Optional(
    Type.String({
      description: 'For "insert": place the new cell directly after this cell id (wins over `position`).',
    }),
  ),
});

export const LIST_NOTEBOOKS_PARAMS = Type.Object({
  /**
   * REQUIRED remote contents directory the listing is scoped to — the same
   * "/"-separated coordinate space the listed paths live in (e.g. "notes").
   * The listing is built from the SERVER's contents API (the files that really
   * exist), merged with live /api/sessions rows and pi's opened-notebooks
   * registry; by default only notebooks sitting DIRECTLY in `dir` are shown.
   * Pass "." for the server root.
   */
  dir: Type.String({
    minLength: 1,
    description:
      'Remote contents directory the listing is scoped to (required) — the same "/"-separated coordinate space the listed paths use, e.g. "notes". The listing is read from the server\'s contents API (so notebooks pi never opened are visible) and merged with live kernels and pi\'s registry; stale registry entries whose file no longer exists are dropped. By default only notebooks DIRECTLY in this directory are shown (no recursion — set recursive=true to include subdirectories). Pass "." for the server root.',
  }),
  recursive: Type.Optional(
    Type.Boolean({
      description:
        "Include notebooks in every subdirectory of `dir`, not just its direct children. Default false (one level only) — turn it on when you are searching for a notebook instead of paging through folders one at a time.",
      default: false,
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Case-insensitive substring filter on the full contents path (e.g. \"imh\" shows every path containing imh). Combine with recursive=true to search a whole tree in one call.",
    }),
  ),
});

/**
 * Read-only outputs tool: show the outputs a notebook FILE already records,
 * WITHOUT touching a kernel or replaying anything. This is the escape hatch
 * when an open/replay summary is not enough — it renders the `.ipynb`'s stored
 * outputs (text + inline images) so the agent never has to parse the JSON by
 * hand.
 */
export const OUTPUTS_PARAMS = Type.Object({
  path: Type.String({
    description:
      'Remote contents path of the notebook whose SAVED outputs to show, e.g. "notes/pi.ipynb". Read-only: no kernel is started and nothing is executed.',
  }),
  cell_id: Type.Optional(
    Type.String({
      description:
        "Only show the code cell with this id (as reported by jupyter_open_notebook / jupyter_repl). Omit to show every code cell.",
    }),
  ),
});

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
export type ListNotebooksParams = Static<typeof LIST_NOTEBOOKS_PARAMS>;
export type OpenNotebookParams = Static<typeof OPEN_NOTEBOOK_PARAMS>;
export type OutputsParams = Static<typeof OUTPUTS_PARAMS>;
export type ShutdownNotebookParams = Static<typeof SHUTDOWN_NOTEBOOK_PARAMS>;
export type SetKernelPurposeParams = Static<typeof SET_KERNEL_PURPOSE_PARAMS>;
export type EditCellParams = Static<typeof EDIT_CELL_PARAMS>;
