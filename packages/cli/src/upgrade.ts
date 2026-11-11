import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { flag } from "./args.ts";
import { currentBinary } from "./service.ts";

/**
 * `sieve upgrade --from <file|https-url> --sha256 <hex>` (slice 11).
 *
 * Replaces this binary with a verified one. It never looks for updates by itself and contacts
 * nothing unless you give it an https URL; a URL must come with the checksum you expect, because
 * a download is only as trustworthy as that number. The new binary has to run and report a
 * version before it replaces anything, the old one is kept as `<name>.prev`, and the swap is a
 * rename, so a failure leaves the old binary in place.
 */

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * The expected checksum from a `--sha256-file`: either a bare hash, or a `SHA256SUMS` file
 * (`<hex>  <name>` per line, as `shasum -a 256` writes it), in which case the line naming the file
 * being installed is used. With several lines and no match it refuses rather than guess.
 */
export function checksumFor(text: string, from: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const name = from.split(/[/\\]/).pop() ?? from;
  for (const l of lines) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(l);
    if (m && m[2]!.split(/[/\\]/).pop() === name) return m[1]!;
  }
  if (lines.length === 1) return lines[0]!.split(/\s+/)[0]!;
  throw new Error(`the checksum file has no line for ${name}`);
}

export interface UpgradeResult {
  target: string;
  previous: string;
  version: string;
  sha256: string;
}

export async function replaceBinary(opts: {
  from: string;
  expectSha256?: string;
  target: string;
  fetchImpl?: typeof fetch;
}): Promise<UpgradeResult> {
  const { from, target } = opts;
  let bytes: Buffer;
  if (/^https:\/\//i.test(from)) {
    if (!opts.expectSha256)
      throw new Error("a download needs --sha256 <hex>: the checksum you expect, from a source you trust");
    const res = await (opts.fetchImpl ?? fetch)(from, { redirect: "follow" });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } else if (/^[a-z]+:\/\//i.test(from)) {
    throw new Error("only https:// URLs and local files are accepted");
  } else {
    if (!existsSync(from)) throw new Error(`no such file: ${from}`);
    bytes = readFileSync(from);
  }
  const got = sha256(bytes);
  if (opts.expectSha256 && got !== opts.expectSha256.toLowerCase())
    throw new Error(
      `checksum mismatch: expected ${opts.expectSha256.toLowerCase()}, the file is ${got}. Nothing was changed.`,
    );
  if (!existsSync(target)) throw new Error(`target ${target} does not exist`);

  // Stage next to the target (same filesystem, so the final rename is atomic), and prove it runs.
  const stage = join(dirname(target), `.sieve-upgrade-${process.pid}`);
  writeFileSync(stage, bytes, { mode: 0o755 });
  chmodSync(stage, 0o755);
  try {
    const probe = spawnSync(stage, ["version"], { encoding: "utf8", timeout: 15_000 });
    const version = /\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/.exec(probe.stdout ?? "")?.[1];
    if (probe.status !== 0 || !version)
      throw new Error(
        `the new binary did not run and report a version (exit ${probe.status}). Nothing was changed.`,
      );
    const previous = `${target}.prev`;
    copyFileSync(target, previous);
    renameSync(stage, target);
    return { target, previous, version, sha256: got };
  } finally {
    if (existsSync(stage)) rmSync(stage, { force: true });
  }
}

export async function upgradeCommand(args: string[]): Promise<number> {
  const from = flag(args, "--from");
  const sha = flag(args, "--sha256") || undefined;
  const shaFile = flag(args, "--sha256-file");
  const target = flag(args, "--target") || currentBinary();
  if (!from) {
    console.error(
      "usage: sieve upgrade --from <file|https-url> [--sha256 <hex> | --sha256-file <file>] [--target <path>]",
    );
    return 2;
  }
  if (!target) {
    console.error("This is running from source; pass --target <path of the installed sieve binary>.");
    return 1;
  }
  try {
    const expect = sha ?? (shaFile ? checksumFor(readFileSync(shaFile, "utf8"), from) : undefined);
    const r = await replaceBinary({ from, expectSha256: expect, target });
    console.log(
      `Upgraded ${r.target} to ${r.version} (sha256 ${r.sha256.slice(0, 16)}…). The old one is kept as ${r.previous}.`,
    );
    // The running daemon finishes what it is doing and exits; the next hook or tool call starts the new build.
    const stop = spawnSync(r.target, ["daemon", "stop"], { encoding: "utf8", timeout: 30_000 });
    console.log(
      stop.status === 0
        ? "The daemon was asked to stop; the next hook starts the new version."
        : "No running daemon to restart.",
    );
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
