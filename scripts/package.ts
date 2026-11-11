/**
 * Package release binaries from dist/<target>/ (made by `bun run build --all`) into dist/release/:
 *   sieve-<version>-<target>.tar.gz (.zip on Windows)  sieve, sieve-hook (+ Linux helper), LICENSE, README
 *   sieve-<target>[.exe]                                the bare binary, for `sieve upgrade --from <url>`
 *   SHA256SUMS                                          `shasum -a 256 -c` format, every file above
 *
 *   bun scripts/package.ts [--tag v0.1.0]
 *
 * With --tag, the tag must equal the version compiled into the binary (protocol/src/version.ts) and
 * the CLI package version, so a release can never ship a binary that reports another version.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { SIEVE_VERSION } from "../packages/protocol/src/version.ts";

// Windows is built by `bun run build --all` but not released: its daemon transport is not built.
const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

const cliVersion = JSON.parse(readFileSync("packages/cli/package.json", "utf8")).version as string;
if (cliVersion !== SIEVE_VERSION)
  throw new Error(`packages/cli/package.json says ${cliVersion}, the binary says ${SIEVE_VERSION}`);
// /sieve:install downloads the release named by the plugin's version, so they must match.
const pluginVersion = JSON.parse(readFileSync("plugins/sieve/.claude-plugin/plugin.json", "utf8")).version;
if (pluginVersion !== SIEVE_VERSION)
  throw new Error(
    `plugins/sieve/.claude-plugin/plugin.json says ${pluginVersion}, the binary says ${SIEVE_VERSION}`,
  );
const ti = process.argv.indexOf("--tag");
const tag = ti > 0 ? process.argv[ti + 1] : undefined;
if (tag !== undefined && tag !== `v${SIEVE_VERSION}`)
  throw new Error(`tag ${tag} does not match the version in the binary (v${SIEVE_VERSION})`);

const out = "dist/release";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const made: string[] = [];
for (const t of TARGETS) {
  const src = join("dist", t);
  if (!existsSync(src)) {
    console.log(`skip ${t}: no ${src}/`);
    continue;
  }
  const win = t.startsWith("windows");
  const ext = win ? ".exe" : "";
  for (const need of [`sieve${ext}`, `sieve-hook${ext}`])
    if (!existsSync(join(src, need))) throw new Error(`${src}/${need} is missing`);

  const name = `sieve-${SIEVE_VERSION}-${t}`;
  const stage = join(out, "stage", name);
  mkdirSync(stage, { recursive: true });
  for (const f of readdirSync(src)) copyFileSync(join(src, f), join(stage, f));
  copyFileSync("LICENSE", join(stage, "LICENSE"));
  copyFileSync("README.md", join(stage, "README.md"));

  const archive = win ? `${name}.zip` : `${name}.tar.gz`;
  // cwd is dist/release/stage, so ../ is dist/release/
  if (win) await $`zip -qr ${`../${archive}`} ${name}`.cwd(join(out, "stage"));
  else await $`tar -czf ${`../${archive}`} ${name}`.cwd(join(out, "stage"));
  made.push(archive);

  const bare = `sieve-${t}${ext}`;
  copyFileSync(join(src, `sieve${ext}`), join(out, bare));
  made.push(bare);
}
rmSync(join(out, "stage"), { recursive: true, force: true });
if (!made.length) throw new Error("nothing to package: run `bun run build --all` first");

const sums = made
  .sort()
  .map(
    (f) =>
      `${createHash("sha256")
        .update(readFileSync(join(out, f)))
        .digest("hex")}  ${f}`,
  )
  .join("\n");
writeFileSync(join(out, "SHA256SUMS"), `${sums}\n`);
console.log(`${out}/: ${made.length} files + SHA256SUMS (v${SIEVE_VERSION})`);
