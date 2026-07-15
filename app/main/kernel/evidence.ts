// Evidence bundles (P3) — unfakeable demos, hash-chained.
//
// After every HIL run the kernel packs plan + report + the run's recorded
// bus events + source-asset fingerprints + the LLM usage window into one
// JSON file under FLUX_HOME/evidence/, appends its sha256 to a hash chain,
// and commits an evidence-bundle asset. Tech DD = "pick any run, replay it."

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import * as path from "node:path";
import type { MCPOrchestrator } from "../mcp_orchestrator";
import type { Bus } from "./bus";
import type { HilReport, HilTestPlan } from "./hil_types";
import { fluxHome, type EventRecorder } from "./recorder";
import { mcpText } from "./golden_path";

function evidenceDir(): string {
  const dir = path.join(fluxHome(), "evidence");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function lastChainHash(dir: string): string {
  try {
    const lines = readFileSync(path.join(dir, "CHAIN"), "utf8").trim().split("\n");
    return lines[lines.length - 1]?.split(" ")[0] ?? "genesis";
  } catch { return "genesis"; }
}

export async function writeEvidenceBundle(
  recorder: EventRecorder, mcp: MCPOrchestrator, bus: Bus,
  plan: HilTestPlan, report: HilReport, startedTs: number,
): Promise<string | null> {
  try {
    const dir = evidenceDir();

    // Run-scoped events: HIL steps carry trace `${runId}-${stepId}`; the window
    // catches sim.state/openocd traffic published with unrelated trace ids.
    const byTrace = recorder.queryEvents({ traceIdPrefix: report.runId });
    const windowTopics = new Set(["hil.plan", "hil.step", "hil.report", "openocd.event", "sim.state", "cmd.chat"]);
    const byWindow = recorder.queryEvents({ sinceTs: startedTs })
      .filter((e) => windowTopics.has(e.topic));
    const seen = new Set<string>();
    const events = [...byTrace, ...byWindow].filter((e) => {
      const k = `${e.ts}|${e.topic}|${e.trace_id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => a.ts - b.ts);

    // Source-asset fingerprints: the plan's authority trail.
    const sourceAssets: Array<{ asset_id: string; sha256: string }> = [];
    for (const id of plan.source_assets ?? []) {
      try {
        const raw = mcpText(await mcp.callTool("query_asset", { asset_id: id }, 10));
        sourceAssets.push({ asset_id: id, sha256: createHash("sha256").update(raw).digest("hex") });
      } catch { sourceAssets.push({ asset_id: id, sha256: "unavailable" }); }
    }

    let usage: unknown = {};
    try {
      usage = JSON.parse(mcpText(await mcp.callTool("usage_stats", { since_ts: startedTs / 1000 }, 10)));
    } catch { /* metering unavailable */ }

    const bundle: Record<string, unknown> = {
      schema: "flux.evidence/v1",
      runId: report.runId,
      createdAt: Date.now(),
      plan, report, events,
      source_assets: sourceAssets,
      usage,
      prev_hash: lastChainHash(dir),
    };
    const contentHash = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
    bundle["content_hash"] = contentHash;

    const file = path.join(dir, `${report.runId}.json`);
    writeFileSync(file, JSON.stringify(bundle, null, 1));
    appendFileSync(path.join(dir, "CHAIN"), `${contentHash} ${report.runId} ${new Date().toISOString()}\n`);

    await mcp.callTool("commit_asset", {
      asset_id: `evidence-${report.runId}`,
      type: "evidence-bundle",
      source: { kind: "hil-run", runId: report.runId },
      components: [report.board, report.planName],
      characterization: {
        runId: report.runId, verdict: report.summary.verdict,
        content_hash: contentHash, events: events.length, file,
      },
    }, 10);
    await bus.publish({
      source: "evidence", kind: "execute", topic: "asset.committed",
      data: { asset_id: `evidence-${report.runId}`, type: "evidence-bundle" },
      trace_id: report.runId,
    });
    return contentHash;
  } catch (e) {
    console.warn("[evidence]", (e as Error).message);
    return null;
  }
}

export function listEvidence(): Array<{ runId: string; verdict: string; createdAt: number; content_hash: string }> {
  const dir = path.join(fluxHome(), "evidence");
  if (!existsSync(dir)) return [];
  const out: Array<{ runId: string; verdict: string; createdAt: number; content_hash: string }> = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const b = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as {
        runId?: string; createdAt?: number; content_hash?: string;
        report?: { summary?: { verdict?: string } };
      };
      out.push({
        runId: b.runId ?? f.replace(/\.json$/, ""),
        verdict: b.report?.summary?.verdict ?? "?",
        createdAt: b.createdAt ?? 0,
        content_hash: b.content_hash ?? "",
      });
    } catch { /* corrupt bundle — skip */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function getEvidence(runId: string): unknown | null {
  const file = path.join(fluxHome(), "evidence", `${path.basename(runId)}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
