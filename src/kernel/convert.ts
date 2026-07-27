/**
 * KernelMessage → JsOutput conversion.
 *
 * This is the ONE place that touches `@jupyterlab/services` message shapes.
 * Everything downstream sees only domain `JsOutput` structs.
 */
import { KernelMessage } from "@jupyterlab/services";
import { normalizeMimebundle } from "../domain/output";
import type { JsOutput } from "../domain/types";

/**
 * Convert a single iopub message to a JsOutput.
 * Returns `null` for lifecycle / comm / debug messages that carry no
 * renderable output (status, execute_input, comm_*, debug_event).
 */
export function fromIOPub(msg: KernelMessage.IIOPubMessage): JsOutput | null {
  if (KernelMessage.isStreamMsg(msg)) {
    return {
      outputType: "stream",
      name: msg.content.name,
      text: msg.content.text,
    };
  }
  if (KernelMessage.isExecuteResultMsg(msg)) {
    return {
      outputType: "execute_result",
      dataJson: JSON.stringify(normalizeMimebundle(msg.content.data)),
      executionCount: msg.content.execution_count ?? undefined,
    };
  }
  if (KernelMessage.isDisplayDataMsg(msg)) {
    return {
      outputType: "display_data",
      dataJson: JSON.stringify(normalizeMimebundle(msg.content.data)),
    };
  }
  // update_display_data: treat as a fresh display_data (MVP; could merge by
  // display_id later).
  if (KernelMessage.isUpdateDisplayDataMsg(msg)) {
    return {
      outputType: "display_data",
      dataJson: JSON.stringify(normalizeMimebundle(msg.content.data)),
    };
  }
  if (KernelMessage.isErrorMsg(msg)) {
    return {
      outputType: "error",
      ename: msg.content.ename,
      evalue: msg.content.evalue,
      traceback: msg.content.traceback,
    };
  }
  return null;
}
