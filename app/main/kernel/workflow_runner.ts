// Kernel-side workflow dispatcher (decision #20: TS dispatches the flow Python produced).
//
// Consumes a `workflow.published` DAG and runs its `cmd.*` steps in topological
// order, gating each on the matching `openocd.event` before advancing. Non-cmd
// steps (agent.characterize / devready.commit) are the brain's reaction to
// openocd.event (it commits the asset on flash OK), so the kernel only needs to
// drive the hardware cmds.

import type { Bus } from "./bus";
import type { Event } from "./types";

export interface WfStep {
  name: string;
  op: string;
  deps: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>;
}
export interface WorkflowDescriptor {
  name: string;
  description?: string;
  steps: WfStep[];
}

/** Derive uORB command args from a step's params (per-op convention). */
function argsFor(step: WfStep): unknown[] {
  if (step.op === "cmd.flash") return step.params?.["elf"] ? [step.params["elf"]] : [];
  if (step.op === "cmd.mdw") {
    const addr = step.params?.["addr"] ?? 0;
    const count = step.params?.["count"] ?? 1;
    return [addr, count];
  }
  return [];
}

export class WorkflowRunner {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  constructor(private readonly bus: Bus) {}

  async run(wf: WorkflowDescriptor): Promise<void> {
    const cmdSteps = wf.steps.filter((s) => s.op.startsWith("cmd."));
    for (const step of cmdSteps) {
      // eslint-disable-next-line no-console
      console.log(`[workflow] dispatch ${wf.name}/${step.name} → ${step.op}`);
      await this.dispatchCmd(step);
    }
    // eslint-disable-next-line no-console
    console.log(`[workflow] ${wf.name} cmd-steps complete (${cmdSteps.length})`);
  }

  /** Publish the cmd and resolve when the matching openocd.event arrives. */
  private async dispatchCmd(step: WfStep): Promise<Event> {
    return new Promise<Event>((resolve) => {
      let off: () => void = () => void 0;
      void this.bus.subscribe("openocd.event", (e: Event) => {
        if (e.data?.["cmd"] === step.op) {
          off();
          resolve(e);
        }
      }).then((o: () => void) => {
        off = o;
        void this.bus.publish({
          source: "kernel",
          kind: "execute",
          topic: step.op,
          data: { args: argsFor(step) },
          trace_id: `wf-${step.name}`,
        });
      });
    });
  }
}
