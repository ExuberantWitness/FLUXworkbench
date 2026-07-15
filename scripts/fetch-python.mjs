#!/usr/bin/env node
// Fetch a relocatable CPython (astral-sh/python-build-standalone) for the
// CURRENT platform, bake brain/requirements.txt into it, stage under
// dist-python/python — electron-builder ships it as resources/python.
// One-click principle: users never install Python themselves.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const TRIPLES = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};
const key = `${process.platform}-${process.arch}`;
const triple = TRIPLES[key];
if (!triple) { console.error(`unsupported platform: ${key}`); process.exit(1); }

const sh = (cmd) => execSync(cmd, { stdio: "inherit", shell: true });
const out = (cmd) => execSync(cmd, { shell: true, maxBuffer: 64 * 1024 * 1024 }).toString();

if (existsSync("dist-python/python")) {
  console.log("dist-python/python already staged — skip (rm -rf dist-python to refetch)");
} else {
  // resolve latest release asset via GitHub API (curl honors proxy env)
  const rel = JSON.parse(out(`curl -sL https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest`));
  const asset = (rel.assets ?? []).find((a) =>
    a.name.includes("cpython-3.12.") && a.name.includes(triple) && a.name.endsWith("install_only_stripped.tar.gz"))
    ?? (rel.assets ?? []).find((a) =>
    a.name.includes("cpython-3.12.") && a.name.includes(triple) && a.name.endsWith("install_only.tar.gz"));
  if (!asset) { console.error(`no cpython 3.12 asset for ${triple} in ${rel.tag_name}`); process.exit(1); }
  console.log(`fetching ${asset.name} (${(asset.size / 1e6).toFixed(0)} MB)…`);
  mkdirSync("dist-python", { recursive: true });
  sh(`curl -L -o dist-python/py.tar.gz "${asset.browser_download_url}"`);
  sh(`tar xzf dist-python/py.tar.gz -C dist-python`); // extracts python/
  rmSync("dist-python/py.tar.gz");
}

const py = process.platform === "win32" ? "dist-python\\python\\python.exe" : "dist-python/python/bin/python3";
console.log("baking brain deps into embedded python…");
sh(`"${py}" -m pip install --no-warn-script-location -r brain/requirements.txt`);
sh(`"${py}" -c "import httpx, sys; print('embedded python OK', sys.version)"`);
