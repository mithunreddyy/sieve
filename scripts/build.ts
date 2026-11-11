/**
 * Build both binaries into dist/: `sieve` (bun build --compile) and `sieve-hook` (Go).
 *   bun run build                 host platform
 *   bun run build --all           every release target
 *   bun run build --all --targets darwin-arm64,darwin-x64   only these release targets
 */

import { mkdirSync, statSync } from "node:fs";
import { $ } from "bun";

const TARGETS = [
  { bun: "bun-darwin-arm64", goos: "darwin", goarch: "arm64", suffix: "darwin-arm64" },
  { bun: "bun-darwin-x64", goos: "darwin", goarch: "amd64", suffix: "darwin-x64" },
  { bun: "bun-linux-x64", goos: "linux", goarch: "amd64", suffix: "linux-x64" },
  { bun: "bun-linux-arm64", goos: "linux", goarch: "arm64", suffix: "linux-arm64" },
  { bun: "bun-windows-x64", goos: "windows", goarch: "amd64", suffix: "windows-x64" },
];
const SHIM_LIMIT = 3 * 1024 * 1024;

mkdirSync("dist", { recursive: true });
const all = process.argv.includes("--all");

async function shim(out: string, goos?: string, goarch?: string) {
  const env = { ...process.env, CGO_ENABLED: "0", ...(goos ? { GOOS: goos, GOARCH: goarch } : {}) };
  await $`go build -trimpath -ldflags=${"-s -w"} -o ${`../${out}`} .`.cwd("shim").env(env);
  const size = statSync(out).size;
  if (size > SHIM_LIMIT) throw new Error(`${out} is ${size} bytes, over the 3 MB budget`);
  console.log(`built ${out} (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

/** The Linux Landlock/seccomp helper (opt-in, never run on Linux): cross-compiled for Linux targets only. */
async function linuxHelper(out: string, goarch: string) {
  const env = { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: goarch };
  await $`go build -trimpath -ldflags=${"-s -w"} -o ${`../../${out}`} .`
    .cwd("helpers/linux-sandbox")
    .env(env);
  console.log(`built ${out} (${(statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
}

async function sieve(out: string, target?: string) {
  const targetArg = target ? [`--target=${target}`] : [];
  // The outline worker is a second entrypoint so it is embedded in the binary.
  await $`bun build packages/cli/src/main.ts packages/core/src/outline/worker.ts --compile --minify ${targetArg} --outfile ${out}`.quiet();
  console.log(`built ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
}

const ti = process.argv.indexOf("--targets");
const only = ti > 0 ? (process.argv[ti + 1] ?? "").split(",").filter(Boolean) : null;
if (only) {
  const unknown = only.filter((s) => !TARGETS.some((t) => t.suffix === s));
  if (unknown.length)
    throw new Error(`unknown target(s): ${unknown.join(", ")}; known: ${TARGETS.map((t) => t.suffix)}`);
}

if (all) {
  for (const t of TARGETS) {
    if (only && !only.includes(t.suffix)) continue;
    const ext = t.goos === "windows" ? ".exe" : "";
    await sieve(`dist/${t.suffix}/sieve${ext}`, t.bun);
    await shim(`dist/${t.suffix}/sieve-hook${ext}`, t.goos, t.goarch);
    if (t.goos === "linux") await linuxHelper(`dist/${t.suffix}/sieve-sandbox-linux`, t.goarch as string);
  }
} else {
  await sieve("dist/sieve");
  await shim("dist/sieve-hook");
}
