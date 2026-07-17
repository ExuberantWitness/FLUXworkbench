// Record multiple studio flows by driving the built Electron app with
// Playwright, screenshotting each step. Frames → (caller) ffmpeg → GIF.
//   node scripts/record-demos.mjs <scene>
// scenes: mission | onboard | devready | pet | scheduler   (pcb has its own script)
import { _electron as electron } from "playwright";
import { mkdirSync } from "node:fs";
import * as path from "node:path";

const scene = process.argv[2] || "mission";
const OUT = `/tmp/demo-${scene}`;
mkdirSync(OUT, { recursive: true });
let n = 0;

const launch = async () => {
  const app = await electron.launch({
    args: ["out/main/index.js", "--disable-gpu", "--no-sandbox"],
    cwd: path.join(process.cwd(), "app"),
    executablePath: path.join(process.cwd(), "node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/electron"),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(6000); // MCP boot
  return { app, page };
};
const shot = async (page, label, hold = 3) => {
  for (let i = 0; i < hold; i++) {
    await page.screenshot({ path: path.join(OUT, `f${String(n++).padStart(3, "0")}.png`), animations: "disabled", timeout: 8000 }).catch(()=>{});
    await page.waitForTimeout(120);
  }
  console.log(`  ${scene} frame ${n}: ${label}`);
};
const clickTab = async (page, re) => {
  const t = page.locator(".center-tab", { hasText: re }).first();
  if (await t.count()) { await t.click(); await page.waitForTimeout(600); }
};

const { app, page } = await launch();
try {
  if (scene === "mission") {
    // Golden path on mock: Assets → 调通 → Start (auto-resolves board+backend)
    await clickTab(page, /Assets|资产/);
    await shot(page, "assets");
    await page.locator('[data-guide="sub-bringup"]').click().catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, "bringup");
    await page.locator('[data-guide="mission-start"]').click();
    await shot(page, "started", 2);
    // watch the phase lights advance
    for (let i = 0; i < 5; i++) { await page.waitForTimeout(900); await shot(page, `phase${i}`, 1); }
    await page.waitForTimeout(1500);
    await shot(page, "result", 4);

  } else if (scene === "onboard") {
    // Real tab → scan (mock devices from boards.json show as present via lsusb)
    await clickTab(page, /Real|真实/);
    await shot(page, "real");
    await page.locator('[data-guide="dev-scan"]').click().catch(() => {});
    await page.waitForTimeout(1200);
    await shot(page, "scanned", 4);
    // if an onboard button appears (a board is present), click it
    const onb = page.locator('[data-guide="dev-onboard"]').first();
    if (await onb.count()) {
      await onb.click();
      await shot(page, "onboarding", 2);
      await page.waitForTimeout(4000);
      await shot(page, "onboarded", 4);
    } else {
      await shot(page, "no-device", 3);
    }

  } else if (scene === "devready") {
    // Assets right panel → click a devready card → detail modal tabs
    await clickTab(page, /Assets|资产/);
    await page.waitForTimeout(600);
    await shot(page, "assets");
    // click the first devready asset card in the right panel
    const card = page.locator(".rp-card").filter({ hasText: /devready|DEVREADY/ }).first();
    if (await card.count()) {
      await card.click();
      await page.waitForTimeout(800);
      await shot(page, "detail", 4);
      // cycle a couple of tabs in the modal
      for (const tabRe of [/引脚|Pins/, /记忆|Memory|Journal/, /\.flux|File/]) {
        const tt = page.locator(".asset-tab", { hasText: tabRe }).first();
        if (await tt.count()) { await tt.click(); await page.waitForTimeout(700); await shot(page, "tab", 3); }
      }
    } else {
      await shot(page, "no-asset", 3);
    }

  } else if (scene === "scheduler") {
    // The kernel scheduler in action: real cross-band traffic on the priority
    // queue, then a hardware alarm preempts every software task below Device(70).
    // Proves the "not another VSCode" claim — VSCode has no such scheduler.
    await page.setViewportSize({ width: 1200, height: 900 }).catch(() => {});
    // Collect the live scheduler.state stream so we can ASSERT preemption really
    // happened (a Device(70) task flying while a band-30 task is frozen queued).
    await page.evaluate(() => {
      window.__sched = [];
      window.flux?.onEvent?.((e) => { if (e.topic === "scheduler.state") window.__sched.push(e.data); });
    });
    // Open the flywheel dashboard modal (900px) — SchedulerViz sits at the top,
    // all five bands visible without scrolling.
    await page.locator(".pet-stats").first().click({ force: true });
    await page.waitForTimeout(900);
    // Tight element crop of the scheduler viz inside the modal.
    const viz = page.locator(".asset-modal [data-viz='scheduler']").first();
    await viz.waitFor({ timeout: 8000 });
    const box = await viz.boundingBox();
    // Pad the crop a little so the border/shadow isn't shaved.
    const clip = box ? { x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 6), width: box.width + 12, height: box.height + 12 } : undefined;
    console.log("  viz box:", JSON.stringify(box));
    const frame = async () => {
      await page.screenshot({ path: path.join(OUT, `f${String(n++).padStart(3, "0")}.png`), clip, animations: "allow", timeout: 8000 }).catch(() => {});
    };
    // A few idle frames so the GIF opens at rest, then fire the demo and sample
    // the arc against a REAL-TIME budget (screenshot latency accumulates, so a
    // fixed frame count would drift past the fast phases). Stop before the long
    // background-drain tail.
    for (let i = 0; i < 3; i++) { await frame(); await page.waitForTimeout(140); }
    // Fire-and-forget: the IPC handler awaits the whole demo (~7.5s of sleeps),
    // so we must NOT return its promise from evaluate or capture would block
    // until the demo already finished. Block-body arrow → resolves immediately.
    await page.evaluate(() => { void window.flux?.schedulerDemo?.(); });
    const start = Date.now();
    while (Date.now() - start < 7200) { await frame(); await page.waitForTimeout(90); }
    console.log(`  scheduler: sampled ${n} frames over the ${((Date.now() - start) / 1000).toFixed(1)}s arc`);
    // Assert the RTOS behaviour actually occurred in the real scheduler.
    const snaps = await page.evaluate(() => window.__sched ?? []);
    const preempted = snaps.some((s) =>
      s.pauseFloor === 70 &&
      (s.inflightCalls ?? []).some((c) => c.prio === 70) &&
      (s.queued ?? []).some((c) => c.prio < 70));
    console.log(`  scheduler: ${snaps.length} live snapshots; preemption observed = ${preempted}`);
    if (!preempted) console.error("  WARN: no snapshot showed Device(70) flying while a lower band was frozen");

  } else if (scene === "pet") {
    // Desk pet lives in the bottom-right dock (.pet-dock); the emoji span opens it.
    await shot(page, "home");
    await page.locator(".pet-dock span").first().click({ force: true });
    await page.waitForTimeout(700);
    await shot(page, "pet-open", 3);
    const inp = page.locator(".pet-window input").first();
    if (await inp.count()) {
      await inp.fill("我有个项目 https://github.com/cfrpg/Vigilator 要做 BSP");
      await shot(page, "pet-typed", 4);
      await page.locator(".pet-window .chat-send").first().click().catch(() => {});
      await page.waitForTimeout(3500);
      await shot(page, "pet-guiding", 5);
    }
  }
  console.log(`DONE ${scene}: ${n} frames`);
} catch (e) {
  console.error(`${scene} ERROR:`, e.message);
  await shot(page, "error", 1);
} finally {
  await app.close();
}
