// Build service — firmware cross-compile with live bus events.
//
// Extracted from the inline flux:build IPC handler so the HIL runner can call
// it too. Publishes build.progress (state) and, on failure, per-line
// build.diagnostic events (the Problems panel's feed) parsed from GCC/CMake
// output. Toolchain dispatch (hpm | zephyr) lands with phase 6.

import { exec, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import type { Bus } from "./kernel/bus";

export interface BuildOptions {
  toolchain?: "hpm" | "zephyr"; // default hpm — existing callers unaffected
  board?: string;
  pristine?: boolean;
}

export interface BuildResult {
  ok: boolean;
  elf?: string;
  buildDir?: string;
  dts?: string; // zephyr: flattened build/zephyr/zephyr.dts (ingestion input)
  board?: string;
  log?: string;
  error?: string;
}

// "src/main.c:12:5: error: expected ';' before 'return'" / cmake "CMake Error at ..."
const GCC_DIAG = /^(.+?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning):\s*(.*)$/;
const CMAKE_DIAG = /^CMake (Error|Warning)(?: at (.+?):(\d+))?/;

function findElf(buildDir: string): string | undefined {
  const outDir = path.join(buildDir, "output");
  const dirs = [outDir, buildDir];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    const elf = readdirSync(d).find((f) => f.endsWith(".elf"));
    if (elf) return path.join(d, elf);
  }
  return undefined;
}

export function parseDiagnostics(log: string): Array<{
  file: string; line: number; col: number; severity: string; message: string; source: string;
}> {
  const out: Array<{ file: string; line: number; col: number; severity: string; message: string; source: string }> = [];
  for (const raw of log.split("\n")) {
    const line = raw.trimEnd();
    const g = line.match(GCC_DIAG);
    if (g) {
      out.push({
        file: g[1] ?? "", line: Number(g[2] ?? 0), col: Number(g[3] ?? 0),
        severity: (g[4] ?? "error").includes("error") ? "error" : "warning",
        message: g[5] ?? "", source: "gcc",
      });
      continue;
    }
    const c = line.match(CMAKE_DIAG);
    if (c) {
      out.push({
        file: c[2] ?? "", line: Number(c[3] ?? 0), col: 0,
        severity: (c[1] ?? "Error").toLowerCase() === "error" ? "error" : "warning",
        message: line, source: "cmake",
      });
    }
  }
  return out;
}

function repoRoot(): string {
  const fromHere = path.resolve(__dirname, "..", "..", "..");
  return existsSync(path.join(fromHere, "brain")) ? fromHere : process.cwd();
}

/** Zephyr toolchain: west build with gnuarmemb (vendored xpack gcc), streamed progress. */
async function runZephyrBuild(appDir: string, board: string, bus: Bus, pristine: boolean): Promise<BuildResult> {
  const root = repoRoot();
  const zephyrBase = process.env["ZEPHYR_BASE"] ?? path.join(root, "vendor", "zephyrproject", "zephyr");
  const west = process.env["FLUX_WEST"] ?? path.join(root, "brain", ".venv", "bin", "west");
  const buildDir = "/tmp/flux-zbuild-" + Date.now();
  const progress = (phase: string, extra: Record<string, unknown> = {}): void =>
    void bus.publish({
      source: "build-service", kind: "execute", topic: "build.progress",
      data: { phase, sampleDir: appDir, board, ...extra }, trace_id: `zbuild-${Date.now()}`,
    });

  progress("start");
  return new Promise((resolve) => {
    const args = ["build", ...(pristine ? ["-p", "always"] : ["-p", "auto"]), "-b", board, "-d", buildDir, appDir];
    const proc = spawn(west, args, {
      cwd: zephyrBase,
      env: {
        ...process.env,
        ZEPHYR_BASE: zephyrBase,
        ZEPHYR_TOOLCHAIN_VARIANT: "gnuarmemb",
        GNUARMEMB_TOOLCHAIN_PATH: process.env["GNUARMEMB_TOOLCHAIN_PATH"] ?? path.join(root, "vendor", "arm-gcc"),
      },
    });
    let full = "";
    const onChunk = (b: Buffer): void => {
      const text = b.toString();
      full += text;
      // ninja progress markers "[123/456]" — sampled, not every line
      const m = text.match(/\[(\d+)\/(\d+)\]/);
      if (m && Number(m[1]) % 25 === 0) progress("compile", { done: Number(m[1]), total: Number(m[2]) });
    };
    proc.stdout.on("data", onChunk);
    proc.stderr.on("data", onChunk);
    proc.on("exit", (code) => {
      if (code !== 0) {
        for (const d of parseDiagnostics(full)) {
          void bus.publish({
            source: "build-service", kind: "error", topic: "build.diagnostic",
            data: { ...d }, trace_id: `diag-${Date.now()}`,
          });
        }
        progress("done", { ok: false });
        resolve({ ok: false, board, error: full.slice(-2000), log: full.slice(-4000) });
        return;
      }
      progress("done", { ok: true });
      resolve({
        ok: true,
        board,
        elf: path.join(buildDir, "zephyr", "zephyr.elf"),
        dts: path.join(buildDir, "zephyr", "zephyr.dts"),
        buildDir,
        log: full.slice(-500),
      });
    });
  });
}

export async function runBuild(sampleDir: string, bus: Bus, opts: BuildOptions = {}): Promise<BuildResult> {
  if (opts.toolchain === "zephyr") {
    return runZephyrBuild(sampleDir, opts.board ?? "stm32_min_dev@blue", bus, opts.pristine ?? false);
  }
  return runHpmBuild(sampleDir, bus);
}

/** Auto-detect the RISC-V toolchain: env override first, then ~/toolchains/*riscv*. */
function detectRiscvToolchain(): string {
  if (process.env["GNURISCV_TOOLCHAIN_PATH"]) return process.env["GNURISCV_TOOLCHAIN_PATH"];
  const os = require("node:os") as typeof import("node:os");
  const fs = require("node:fs") as typeof import("node:fs");
  const root = `${os.homedir()}/toolchains`;
  try {
    const hit = fs.readdirSync(root).find((d) => /riscv/i.test(d) && fs.existsSync(`${root}/${d}/bin`));
    if (hit) return `${root}/${hit}`;
  } catch { /* no ~/toolchains */ }
  return "/opt/riscv";
}

async function runHpmBuild(sampleDir: string, bus: Bus): Promise<BuildResult> {
  const os = require("node:os") as typeof import("node:os");
  const toolchain = detectRiscvToolchain();
  const sdk = process.env["HPM_SDK_BASE"] ?? `${os.homedir()}/hpm_sdk`;
  const buildDir = "/tmp/flux-build-" + Date.now();
  const progress = (phase: string, extra: Record<string, unknown> = {}): Promise<void> =>
    bus.publish({
      source: "build-service", kind: "execute", topic: "build.progress",
      data: { phase, sampleDir, ...extra }, trace_id: `build-${Date.now()}`,
    });

  await progress("start");
  return new Promise((resolve) => {
    exec(
      `mkdir -p ${buildDir} && cd ${buildDir} && cmake -DBOARD=hpm6e00evk -DHPM_SDK_BASE=${sdk} -DHPM_BUILD_TYPE=flash_xip ${sampleDir} && make -j4`,
      // /usr/bin first: hpm_sdk cmake needs a python3 with pyyaml, and a leaked
      // venv PATH often points at one without it (the pyyaml pitfall).
      { env: { ...process.env, GNURISCV_TOOLCHAIN_PATH: toolchain, HPM_SDK_BASE: sdk, PATH: `${toolchain}/bin:/usr/bin:${process.env.PATH}` } },
      (err, stdout, stderr) => {
        const full = stdout + "\n" + stderr;
        if (err) {
          for (const d of parseDiagnostics(full)) {
            void bus.publish({
              source: "build-service", kind: "error", topic: "build.diagnostic",
              data: { ...d }, trace_id: `diag-${Date.now()}`,
            });
          }
          void progress("done", { ok: false });
          resolve({ ok: false, error: stderr.slice(-2000), log: full.slice(-4000) });
          return;
        }
        void progress("done", { ok: true });
        resolve({ ok: true, elf: findElf(buildDir), buildDir, log: stdout.slice(-500) });
      },
    );
  });
}
