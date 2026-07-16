// Golden path — the ONE flow the studio leads with (P1.2):
//   plug in → identify → ingest → plan → verify → commit.
//
// v1 chains only already-proven links: query_regmap / ingest_svd →
// gen_test_plan → HilRunner → asset write-back. Each step is a Mission
// milestone; failures drop into Sentinel triage and the mission records
// an honest verdict. v2 slot (codegen + build) is the `plan`→`verify` seam.

import { readFileSync } from "node:fs";
import type { MCPOrchestrator } from "../mcp_orchestrator";
import type { Bus } from "./bus";
import type { HilRunner } from "./hil_runner";
import { validatePlan, type HilReport, type HilTestPlan } from "./hil_types";
import type { MissionEngine, MissionRecord } from "./mission";

/** Unwrap MCP result → content[0].text (every tool returns this shape). */
export function mcpText(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
}

/** Flywheel write-back shared by flux:hilRun and the golden path: the HIL
 * report itself becomes a devready asset (background band). */
export async function commitHilReport(mcp: MCPOrchestrator, bus: Bus, report: HilReport): Promise<void> {
  try {
    await mcp.callTool("commit_asset", {
      asset_id: `hilreport-${report.runId}`,
      type: "hil-report",
      source: { kind: "hil-run", board: report.board, mode: report.mode },
      components: [report.board, report.planName],
      characterization: { summary: report.summary, goal: report.goal, steps: report.steps },
    }, 10);
    await bus.publish({
      source: "hil-runner", kind: "execute", topic: "asset.committed",
      data: { asset_id: `hilreport-${report.runId}`, type: "hil-report" },
      trace_id: report.runId,
    });
  } catch (e) {
    console.warn("[hil] report asset commit failed:", (e as Error).message);
  }
}

export interface GoldenPathOpts {
  chip?: string;
  board?: string;
  backend?: "mock" | "real" | "sim";
  svdPath?: string;
  pinmuxPath?: string; // boards without an SVD ingest their pinmux.c instead
}

export interface GoldenPathResult {
  missionId: string;
  record?: MissionRecord;
  report?: HilReport;
  planGenerated?: boolean;
  error?: string;
}

export class GoldenPath {
  constructor(
    private bus: Bus,
    private mcp: MCPOrchestrator,
    private hil: HilRunner,
    private missions: MissionEngine,
    private templatePlanPath: string,
    private triage: (log: string, source: string, ctx: Record<string, unknown>) => Promise<unknown>,
    private onVerified?: (plan: HilTestPlan, report: HilReport, startedTs: number) => Promise<void>,
  ) {}

  // Re-entrancy guard only: a mission with the SAME key already IN-FLIGHT is
  // ignored (blocks a truly concurrent double-fire). NOT a time cooldown —
  // sequential re-runs are allowed the moment the previous one completes, and
  // durable assets (devready-/pinmap-/experience-<board>) carry stable ids so
  // re-running overwrites rather than duplicates. The held-Enter storm is
  // stopped at the source in MissionPanel (auto-repeat suppression).
  private inflightKeys = new Set<string>();

  async run(goal: string, opts: GoldenPathOpts = {}): Promise<GoldenPathResult> {
    const chip = opts.chip ?? "STM32F103xx";
    const board = opts.board ?? "stm32f103-bluepill";
    const backend = opts.backend ?? "mock";
    const key = `${goal}|${board}|${backend}`;
    if (this.inflightKeys.has(key)) {
      return { missionId: "", error: "a mission with the same target is already running" };
    }
    this.inflightKeys.add(key);
    const missionId = this.missions.start(goal, chip);

    try {
      // ── identify: does the asset store already know this device? ──
      this.missions.milestone(missionId, "identify", "start");
      let known = false;
      try {
        const probe = JSON.parse(mcpText(await this.mcp.callTool("query_regmap", { query: chip }, 30)));
        known = !probe["error"];
      } catch { /* store empty or unreachable — treat as unknown */ }
      this.missions.milestone(missionId, "identify", "done",
        known ? "register-map asset found" : "device unknown to asset store");

      // ── ingest: ONE mutually-exclusive chain. SVD wins (full register map);
      // pinmux is the fallback for boards without an SVD (HPMicro); the bare
      // else only fires when there was truly nothing to ingest. Two separate
      // ifs here once double-fired ("no pinmux_path" / spurious ingest-fail
      // after a successful SVD ingest on a fresh store).
      let characterizedOnly = false; // pinmap ingested, no register-map for HIL
      if (opts.svdPath) {
        this.missions.milestone(missionId, "ingest", "start");
        const summary = JSON.parse(mcpText(
          await this.mcp.callTool("ingest_svd", { svd_path: opts.svdPath, chip }, 30)));
        await this.bus.publish({
          source: "golden-path", kind: "execute", topic: "asset.committed",
          data: { asset_id: summary["asset_id"] ?? "", type: "register-map" },
          trace_id: missionId,
        });
        this.missions.milestone(missionId, "ingest", "done", String(summary["asset_id"] ?? ""));
      } else if (opts.pinmuxPath || (opts.board && !known)) {
        this.missions.milestone(missionId, "ingest", "start");
        const args: Record<string, unknown> = { board: opts.board ?? chip };
        if (opts.pinmuxPath) args["pinmux_path"] = opts.pinmuxPath;
        const summary = JSON.parse(mcpText(await this.mcp.callTool("ingest_pinmux", args, 30)));
        if (summary["error"]) {
          this.missions.milestone(missionId, "ingest", "fail", String(summary["error"]).slice(0, 100));
        } else {
          characterizedOnly = true;
          await this.bus.publish({
            source: "golden-path", kind: "execute", topic: "asset.committed",
            data: { asset_id: summary["asset_id"] ?? "", type: "characterization" },
            trace_id: missionId,
          });
          this.missions.milestone(missionId, "ingest", "done",
            `${summary["asset_id"]} · ${summary["pin_count"]} pins`);
        }
      } else {
        this.missions.milestone(missionId, "ingest", known ? "done" : "fail",
          known ? "skipped — asset present" : "no SVD/pinmux and device unknown");
      }

      // ── characterization-only DevReady: a board with just a pin-map (no
      // register map / SVD) and no real probe can't run firmware-level HIL.
      // The DevReady deliverable IS the characterized asset — mark PASS and
      // stop, instead of failing on a mock that can't simulate this chip.
      //
      // The mock backend ONLY simulates STM32F103 (spike/mock-scenarios). So on
      // mock/sim, firmware HIL is meaningful ONLY for that demo board; every
      // other board (H743, HPM, …) would read zeros and fail every assertion.
      // For those, characterization (register map / pin map ingested) = DevReady.
      const mockDemoBoard = /stm32f103/i.test(chip) || board === "stm32f103-bluepill";
      if (backend !== "real" && (characterizedOnly || !mockDemoBoard)) {
        this.missions.milestone(missionId, "plan", "done",
          mockDemoBoard ? "skipped — characterization asset" : "skipped — mock only simulates STM32F103");
        this.missions.milestone(missionId, "verify", "done", "characterized ✓ (connect a real board to run firmware HIL)");
        this.missions.milestone(missionId, "commit", "start");
        const rec = this.missions.finish(missionId, "PASS");
        if (rec) await this.commitMissionAsset(rec, true);
        await this.refreshDevready(opts.board, missionId);
        this.missions.milestone(missionId, "commit", "done");
        const out: GoldenPathResult = { missionId, planGenerated: true };
        if (rec) out.record = rec;
        return out;
      }

      // ── real board: verify by reading the LIVE silicon (IDCODE + factory
      // UID) over the debug link, not a firmware HIL. Characterization needs
      // proof the chip is present & matches the profile — not proof that some
      // firmware runs. Uses chip_bind's direct-openocd path, so it works
      // regardless of whether the bus OpenOcdAgent was pre-connected. The AI
      // picked `real` because a board is plugged in; this is what that means.
      if (backend === "real") {
        this.missions.milestone(missionId, "plan", "done", "live chip verification (no firmware needed)");
        this.missions.milestone(missionId, "verify", "start", "reading IDCODE + UID over the debug link…");
        let ok = false; let vdetail = "";
        try {
          const v = JSON.parse(mcpText(await this.mcp.callTool("verify_chip", { board }, 70)));
          ok = !!v["ok"];
          vdetail = ok
            ? `IDCODE ${v["idcode"]} · dev ${v["device_id"]} · UID ${String(v["uid"]).slice(0, 12)}`
            : String(v["error"] ?? v["note"] ?? "no response");
        } catch (e) { vdetail = (e as Error).message.slice(0, 100); }
        this.missions.milestone(missionId, "verify", ok ? "done" : "fail", vdetail);
        if (!ok) void this.triage(`Real-board verify FAILED on ${board}: ${vdetail}`, "hil", { board, missionId });
        this.missions.milestone(missionId, "commit", "start");
        const rec = this.missions.finish(missionId, ok ? "PASS" : "FAIL");
        if (rec) await this.commitMissionAsset(rec, true);
        await this.refreshDevready(opts.board, missionId);
        this.missions.milestone(missionId, "commit", "done");
        if (ok) await this.bindChip(opts.board, backend, missionId); // 6th phase: stamp Flash
        const out: GoldenPathResult = { missionId, planGenerated: true };
        if (rec) out.record = rec;
        return out;
      }

      // ── plan: asset-driven test plan, deterministic template as fallback ──
      this.missions.milestone(missionId, "plan", "start");
      let plan: HilTestPlan;
      let planGenerated = true;
      try {
        plan = JSON.parse(mcpText(
          await this.mcp.callTool("gen_test_plan", { goal, chip, board, backend }, 30))) as HilTestPlan;
        const errs = validatePlan(plan);
        if (errs.length) throw new Error(`generated plan invalid: ${errs.join("; ")}`);
      } catch (e) {
        plan = JSON.parse(readFileSync(this.templatePlanPath, "utf8")) as HilTestPlan;
        planGenerated = false;
        this.missions.milestone(missionId, "plan", "done",
          `template fallback (${(e as Error).message.slice(0, 120)})`);
      }
      if (planGenerated) {
        this.missions.milestone(missionId, "plan", "done",
          `${plan.steps.length} steps from assets [${(plan.source_assets ?? []).join(", ")}]`);
      }

      // ── verify: run on mock|real|sim, triage on FAIL ──
      this.missions.milestone(missionId, "verify", "start",
        `flashing + ${plan.steps.length} checks on ${backend}…`);
      const verifyT0 = Date.now();
      const report = await this.hil.run(plan);
      const ok = report.summary.verdict === "PASS";
      this.missions.milestone(missionId, "verify", ok ? "done" : "fail",
        `${report.summary.passed}/${report.summary.total} steps`);
      if (!ok) {
        const failures = report.steps
          .filter((s) => s.status !== "pass" && s.status !== "skipped")
          .map((s) => `step ${s.id} (${s.type}) ${s.status}: ${JSON.stringify(s.assertion ?? s.detail)}`)
          .join("\n");
        void this.triage(
          `Golden path ${missionId} FAILED on ${board} (${backend}) — goal: ${goal}\n${failures}`,
          "hil", { board, plan: plan.name, missionId });
      }

      // ── commit: report asset + evidence bundle + mission asset ──
      this.missions.milestone(missionId, "commit", "start");
      await commitHilReport(this.mcp, this.bus, report);
      if (this.onVerified) void this.onVerified(plan, report, verifyT0);
      const record = this.missions.finish(missionId, ok ? "PASS" : "FAIL");
      if (record) await this.commitMissionAsset(record, planGenerated);
      await this.refreshDevready(opts.board, missionId);
      this.missions.milestone(missionId, "commit", "done");
      // ── bind (6th phase): stamp the DevReady record into the real chip's
      // Flash + read back. Only for a real probe — mock/sim have no silicon. ──
      await this.bindChip(opts.board, backend, missionId);
      const result: GoldenPathResult = { missionId, report, planGenerated };
      if (record) result.record = record;
      return result;
    } catch (e) {
      const record = this.missions.finish(missionId, "ERROR", (e as Error).message);
      if (record) await this.commitMissionAsset(record, false).catch(() => void 0);
      return { missionId, error: (e as Error).message };
    } finally {
      this.inflightKeys.delete(key);
    }
  }

  /** 6th phase: bind asset↔silicon by writing the DevReady record into the
   * real chip's Flash. Real probe only; best-effort (needs openocd + authorized
   * probe) — a bind failure never fails the mission. */
  private async bindChip(board: string | undefined, backend: string, missionId: string): Promise<void> {
    if (!board || backend !== "real") return;
    this.missions.milestone(missionId, "bind", "start");
    try {
      const out = JSON.parse(mcpText(await this.mcp.callTool("bind_chip", { board }, 70)));
      if (out.verified) {
        this.missions.milestone(missionId, "bind", "done", `UID ${String(out.uid).slice(0, 12)} @ ${out.slot}`);
        await this.bus.publish({
          source: "golden-path", kind: "execute", topic: "asset.committed",
          data: { asset_id: `devready-${board}`, type: "devready" }, trace_id: missionId,
        });
      } else {
        this.missions.milestone(missionId, "bind", "fail", String(out.error ?? "readback mismatch").slice(0, 100));
      }
    } catch (e) {
      this.missions.milestone(missionId, "bind", "fail", (e as Error).message.slice(0, 100));
    }
  }

  /** Living DevReady: every bring-up refreshes the board's BODY/MIND/JOURNAL
   * asset so its journal, memory and links stay current (FLUXmeme lifecycle:
   * the asset grows with use). Best-effort — never blocks the mission. */
  private async refreshDevready(board: string | undefined, missionId: string): Promise<void> {
    if (!board) return;
    try {
      const out = JSON.parse(mcpText(await this.mcp.callTool("compose_devready", { board }, 10)));
      if (out["asset_id"]) {
        await this.bus.publish({
          source: "golden-path", kind: "execute", topic: "asset.committed",
          data: { asset_id: out["asset_id"], type: "devready" },
          trace_id: missionId,
        });
      }
    } catch (e) {
      console.warn("[devready] refresh failed:", (e as Error).message);
    }
  }

  /** The dashboard curve reads mission assets — commit metrics + token cost. */
  private async commitMissionAsset(record: MissionRecord, planGenerated: boolean): Promise<void> {
    let usage: Record<string, unknown> = {};
    try {
      usage = JSON.parse(mcpText(await this.mcp.callTool("usage_stats",
        { since_ts: record.startedAt / 1000 }, 10)));
    } catch { /* metering unavailable — commit without cost */ }
    try {
      await this.mcp.callTool("commit_asset", {
        asset_id: record.missionId,
        type: "mission",
        source: { kind: "golden-path", device_family: record.deviceFamily },
        components: [record.deviceFamily],
        characterization: {
          goal: record.goal, verdict: record.verdict,
          time_to_devready_ms: record.timeToDevreadyMs,
          asset_hits: record.assetHits, tool_calls: record.toolCalls,
          plan_generated: planGenerated, milestones: record.milestones,
          usage,
        },
      }, 10);
      await this.bus.publish({
        source: "golden-path", kind: "execute", topic: "asset.committed",
        data: { asset_id: record.missionId, type: "mission" },
        trace_id: record.missionId,
      });
    } catch (e) {
      console.warn("[mission] asset commit failed:", (e as Error).message);
    }
  }
}
