import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { sieveHome } from "./paths.ts";

/**
 * ~/.sieve/config.toml. Every key is optional; unknown keys are an error (a typo should not
 * silently do nothing). Environment variables override the file.
 */
export const Config = z
  .object({
    daemon: z
      .object({ idle_minutes: z.number().min(0).default(30) })
      .strict()
      .default({ idle_minutes: 30 }),
    reads: z
      .object({
        /** Decline a full read once when Sieve has something shorter (outline, "unchanged", changed hunks). */
        smart: z.boolean().default(true),
        /** Files above this size get an outline instead of a full read on first sight. */
        outline_above_kb: z.number().min(1).default(16),
      })
      .strict()
      .default({ smart: true, outline_above_kb: 16 }),
    watch: z
      .object({ enabled: z.boolean().default(true), max_files: z.number().int().min(0).default(50_000) })
      .strict()
      .default({ enabled: true, max_files: 50_000 }),
    reruns: z
      .object({ diff: z.boolean().default(true) })
      .strict()
      .default({ diff: true }),
  })
  .strict();
export type Config = z.infer<typeof Config>;

export function loadConfig(file = join(sieveHome(), "config.toml")): Config {
  const raw = existsSync(file) ? parse(readFileSync(file, "utf8")) : {};
  const c = Config.parse(raw);
  const env = process.env;
  if (env.SIEVE_IDLE_MINUTES !== undefined) c.daemon.idle_minutes = Number(env.SIEVE_IDLE_MINUTES);
  if (env.SIEVE_SMART_READS !== undefined) c.reads.smart = env.SIEVE_SMART_READS !== "0";
  if (env.SIEVE_WATCH !== undefined) c.watch.enabled = env.SIEVE_WATCH !== "0";
  if (env.SIEVE_RERUN_DIFF !== undefined) c.reruns.diff = env.SIEVE_RERUN_DIFF !== "0";
  return c;
}
