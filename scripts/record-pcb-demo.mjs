// Record the PCB→BSP flow by driving the real Electron app with Playwright,
// screenshotting each step. Frames → ffmpeg → GIF (done by the caller).
//   node scripts/record-pcb-demo.mjs
import { _electron as electron } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const OUT = "/tmp/pcb-frames";
mkdirSync(OUT, { recursive: true });
let n = 0;
const shot = async (page, label, hold = 1) => {
  // hold = how many duplicate frames (slows that beat down in the GIF)
  for (let i = 0; i < hold; i++) {
    await page.screenshot({ path: path.join(OUT, `f${String(n++).padStart(3, "0")}_${label}.png`) });
    if (hold > 1) await page.waitForTimeout(150);
  }
  console.log(`  frame ${n}: ${label}`);
};

const app = await electron.launch({
  args: ["out/main/index.js", "--disable-gpu", "--no-sandbox"],
  cwd: path.join(process.cwd(), "app"),
  executablePath: path.join(process.cwd(), "node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/electron"),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
});
const page = await app.firstWindow();
await page.waitForLoadState("domcontentloaded");
await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
console.log("app up, waiting for kernel boot…");
await page.waitForTimeout(6000); // MCP servers boot

try {
  // 1. land on Assets → PCB Import sub-tab
  await shot(page, "01-boot", 3);
  // click the 资产/Assets center tab (default is assets, but be explicit)
  const assetsTab = page.locator('.center-tab', { hasText: /Assets|资产/ }).first();
  if (await assetsTab.count()) { await assetsTab.click(); await page.waitForTimeout(600); }
  // PCB Import sub-tab (data-guide="sub-pcb")
  const pcbSub = page.locator('[data-guide="sub-pcb"]');
  await pcbSub.click();
  await page.waitForTimeout(700);
  await shot(page, "02-pcb-tab", 3);

  // 2. type the GitHub URL
  const input = page.locator('[data-guide="pcb-input"]');
  await input.click();
  await input.fill("https://github.com/cfrpg/Vigilator");
  await shot(page, "03-url", 4);

  // 3. click Extract BSP (repo is pre-cloned to ~/.flux/projects/Vigilator)
  await page.locator('[data-guide="pcb-ingest"]').click();
  await shot(page, "04-extracting", 2);

  // 4. wait for the result card + wiring graph to render
  await page.locator("svg", { has: page.locator("text=/MLX90640|STM32/") }).first()
    .waitFor({ timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await shot(page, "05-result", 4);

  // 5. hover/click a device in the graph to show connection tracing
  const dev = page.locator("svg text", { hasText: "MLX90640" }).first();
  if (await dev.count()) {
    await dev.click().catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, "06-trace-mlx", 5);
  }
  // scroll to the detail table
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(600);
  await shot(page, "07-table", 4);

  console.log(`\nDONE — ${n} frames in ${OUT}`);
} catch (e) {
  console.error("FLOW ERROR:", e.message);
  await shot(page, "99-error", 1);
} finally {
  await app.close();
}
