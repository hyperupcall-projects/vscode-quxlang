#!/usr/bin/env node
/**
 * Package Unofficial Quxlang and publish it to the Visual Studio Marketplace
 * and/or the Open VSX Registry.
 *
 *   VSCE_PAT=... OVSX_PAT=... node scripts/publish.mjs
 *   node scripts/publish.mjs --marketplace
 *   node scripts/publish.mjs --ovsx
 *   node scripts/publish.mjs --package-only
 *
 * Tokens:
 *   VSCE_PAT  Azure DevOps PAT (Marketplace: Acquire + Publish)
 *   OVSX_PAT  https://open-vsx.org user token
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const pkg = createRequire(import.meta.url)(join(root, "package.json"));
const vsixName = `${pkg.name}-${pkg.version}.vsix`;
const args = new Set(process.argv.slice(2));
const wantMarketplace = args.has("--marketplace") || args.has("--all") || args.size === 0;
const wantOvsx = args.has("--ovsx") || args.has("--all") || args.size === 0;
const packageOnly = args.has("--package-only");

function run(command, commandArgs, extraEnv = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function npx(bin) {
  try {
    return createRequire(import.meta.url).resolve(`${bin}/package.json`);
  } catch {
    return null;
  }
}

const vsce = join(root, "node_modules", ".bin", "vsce");
const ovsx = join(root, "node_modules", ".bin", "ovsx");
if (!existsSync(vsce) || !existsSync(ovsx)) {
  console.error("Run `npm install` in vscode-quxlang before publishing.");
  process.exit(1);
}

console.log(`Testing ${pkg.displayName} ${pkg.version}...`);
run(process.execPath, [join(root, "scripts", "test-highlighting.mjs")]);

console.log(`Packaging ${vsixName}...`);
run(vsce, ["package", "--no-dependencies", "--allow-missing-repository"]);

const vsix = join(root, vsixName);
if (!existsSync(vsix)) {
  const found = readdirSync(root).filter((name) => name.endsWith(".vsix"));
  console.error(`Expected ${vsixName}, found: ${found.join(", ") || "(none)"}`);
  process.exit(1);
}

if (packageOnly) {
  console.log(`Wrote ${vsix}`);
  process.exit(0);
}

if (wantMarketplace) {
  if (!process.env.VSCE_PAT) {
    console.error("VSCE_PAT is not set; skip `node scripts/publish.mjs --marketplace`.");
    process.exit(1);
  }
  console.log("Publishing to the Visual Studio Marketplace...");
  run(vsce, ["publish", "--no-dependencies", "--allow-missing-repository", "--pat", process.env.VSCE_PAT]);
}

if (wantOvsx) {
  if (!process.env.OVSX_PAT) {
    console.error("OVSX_PAT is not set; skip `node scripts/publish.mjs --ovsx`.");
    process.exit(1);
  }
  console.log("Publishing to the Open VSX Registry...");
  run(ovsx, ["publish", "--packagePath", vsix, "--pat", process.env.OVSX_PAT]);
}

console.log("Done.");
