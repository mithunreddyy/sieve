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
    archive: z
      .object({
        /**
         * Remove archived items not read (or seen again) for this many days. 0, the default, keeps
         * everything until you run `sieve purge`. When on, an id in an old receipt that was removed
         * says so (a tombstone), instead of failing as unknown. Runs for projects the daemon has open.
         */
        retention_days: z.number().int().min(0).max(36_500).default(0),
      })
      .strict()
      .default({ retention_days: 0 }),
    fetch: z
      .object({
        /**
         * Let `sieve_index` fetch a web page (https only; every address checked as public, redirects
         * re-checked; text only). Off by default: with it off, Sieve makes no network call of its own.
         */
        enabled: z.boolean().default(false),
        /** Only these hosts (exact, or `*.example.com`). Empty: any public host. */
        allow_hosts: z.array(z.string().min(1)).default([]),
        /** Keep at most this much of a page. */
        max_kb: z.number().int().min(16).max(16_384).default(2048),
        timeout_ms: z.number().int().min(1000).max(60_000).default(15_000),
      })
      .strict()
      .default({ enabled: false, allow_hosts: [], max_kb: 2048, timeout_ms: 15_000 }),
    watch: z
      .object({ enabled: z.boolean().default(true), max_files: z.number().int().min(0).default(50_000) })
      .strict()
      .default({ enabled: true, max_files: 50_000 }),
    reruns: z
      .object({ diff: z.boolean().default(true) })
      .strict()
      .default({ diff: true }),
    guard: z
      .object({
        /** Check every tool call against the rules in ~/.sieve/guard.toml and the preset. Off = no checks at all. */
        enabled: z.boolean().default(true),
      })
      .strict()
      .default({ enabled: true }),
    sandbox: z
      .object({
        /** auto: isolate when the OS can, and say so when it cannot. off: never. require: refuse to run unisolated. */
        mode: z.enum(["auto", "off", "require"]).default("auto"),
      })
      .strict()
      .default({ mode: "auto" }),
    memory: z
      .object({
        /** Long-term facts: the two tools, and the blocks shown at the start and after compaction. */
        enabled: z.boolean().default(true),
        /** Record commits, pull requests and decisions as observed facts (rules only, no model). */
        capture: z.boolean().default(true),
        /**
         * Optional: have a model suggest up to 5 short facts after a turn. Off by default. "command" runs a
         * program you name (stdin: JSON, stdout: JSON; wrap any local model or your own key in it);
         * "ollama" talks to a model server on this machine. Nothing is sent anywhere else.
         */
        extraction: z
          .object({
            provider: z.enum(["off", "command", "ollama"]).default("off"),
            command: z.array(z.string().min(1)).max(16).default([]),
            model: z.string().default("llama3.1"),
            url: z.string().url().default("http://127.0.0.1:11434"),
            timeout_ms: z.number().int().min(1000).max(120_000).default(30_000),
          })
          .strict()
          .default({
            provider: "off",
            command: [],
            model: "llama3.1",
            url: "http://127.0.0.1:11434",
            timeout_ms: 30_000,
          }),
      })
      .strict()
      .default({
        enabled: true,
        capture: true,
        extraction: {
          provider: "off",
          command: [],
          model: "llama3.1",
          url: "http://127.0.0.1:11434",
          timeout_ms: 30_000,
        },
      }),
    search: z
      .object({
        /** Reorder full-text candidates by closeness to the whole query. "hash" is built in; "command" runs a program you name. */
        rerank: z.enum(["off", "hash", "command"]).default("off"),
        command: z.array(z.string().min(1)).max(16).default([]),
      })
      .strict()
      .default({ rerank: "off", command: [] }),
    notify: z
      .object({
        /** Every few minutes the daemon checks that installed agents still point at Sieve, and sends an OS notification if one does not. */
        enabled: z.boolean().default(false),
      })
      .strict()
      .default({ enabled: false }),
    steering: z
      .object({
        /** Decline a read-only command once when it printed a lot last time, pointing at sieve_run. */
        enabled: z.boolean().default(true),
      })
      .strict()
      .default({ enabled: true }),
    canary: z
      .object({
        /** Fraction (0..1) of shortened outputs flagged for audit against the original. Off by default. */
        sample: z.number().min(0).max(1).default(0),
      })
      .strict()
      .default({ sample: 0 }),
    prices: z
      .object({
        /** Dollars per million input tokens used for the dashboard's estimate. A list price you set, not a measurement. */
        input_per_mtok: z.number().min(0).default(3),
      })
      .strict()
      .default({ input_per_mtok: 3 }),
    proxy: z
      .object({
        port: z.number().int().min(1).max(65535).default(8787),
        /** Address to listen on. Loopback unless you are self-hosting for a team (then put TLS and authentication in front). */
        host: z.string().min(1).default("127.0.0.1"),
        /** Where each provider's requests go. Your key is sent there by your client, not stored. */
        anthropic_upstream: z.string().url().default("https://api.anthropic.com"),
        openai_upstream: z.string().url().default("https://api.openai.com"),
        gemini_upstream: z.string().url().default("https://generativelanguage.googleapis.com"),
        /** Tool descriptions longer than this many bytes are cut at a sentence boundary. */
        trim_description_bytes: z.number().int().min(200).default(1500),
        /** A tool result over this many bytes is replaced by a receipt on first sight. */
        fold_result_bytes: z.number().int().min(1024).default(8192),
        /** Archive old tool results once history passes this fraction of the model's context window. */
        archive_at: z.number().min(0.2).max(0.95).default(0.6),
        /** Old results are archived this many at a time, so the request prefix changes rarely and caches hold. */
        archive_step: z.number().int().min(1).default(8),
        /** The newest messages are never archived. */
        keep_recent_messages: z.number().int().min(2).default(8),
        add_cache_marks: z.boolean().default(true),
        fold_history: z.boolean().default(true),
        trim_tools: z.boolean().default(true),
        /** Dollars per million tokens for the budget and dashboard estimates: list prices you set. */
        input_per_mtok: z.number().min(0).default(3),
        output_per_mtok: z.number().min(0).default(15),
        /** 0 = no cap. */
        session_tokens: z.number().int().min(0).default(0),
        day_tokens: z.number().int().min(0).default(0),
        session_dollars: z.number().min(0).default(0),
        day_dollars: z.number().min(0).default(0),
        /** Refuse requests once a cap is reached. Off: only warn. */
        hard_stop: z.boolean().default(false),
      })
      .strict()
      .default({
        port: 8787,
        host: "127.0.0.1",
        anthropic_upstream: "https://api.anthropic.com",
        openai_upstream: "https://api.openai.com",
        gemini_upstream: "https://generativelanguage.googleapis.com",
        trim_description_bytes: 1500,
        fold_result_bytes: 8192,
        archive_at: 0.6,
        archive_step: 8,
        keep_recent_messages: 8,
        add_cache_marks: true,
        fold_history: true,
        trim_tools: true,
        input_per_mtok: 3,
        output_per_mtok: 15,
        session_tokens: 0,
        day_tokens: 0,
        session_dollars: 0,
        day_dollars: 0,
        hard_stop: false,
      }),
    skills: z
      .object({
        /** Offer enabled skills: one line each at the start, and load the one a prompt asks for or matches. */
        enabled: z.boolean().default(true),
      })
      .strict()
      .default({ enabled: true }),
    session: z
      .object({
        /** Deliver the state block after compaction (it is always logged and built). */
        state_block: z.boolean().default(true),
        /** Add up to 3 pointers to earlier output that matches a prompt's file names, symbols or errors. */
        recall: z.boolean().default(true),
      })
      .strict()
      .default({ state_block: true, recall: true }),
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
  if (env.SIEVE_GUARD !== undefined) c.guard.enabled = env.SIEVE_GUARD !== "0";
  if (env.SIEVE_SANDBOX !== undefined)
    c.sandbox.mode = z.enum(["auto", "off", "require"]).parse(env.SIEVE_SANDBOX);
  if (env.SIEVE_STATE_BLOCK !== undefined) c.session.state_block = env.SIEVE_STATE_BLOCK !== "0";
  if (env.SIEVE_RECALL !== undefined) c.session.recall = env.SIEVE_RECALL !== "0";
  if (env.SIEVE_PROXY_HOST !== undefined) c.proxy.host = env.SIEVE_PROXY_HOST;
  if (env.SIEVE_STEERING !== undefined) c.steering.enabled = env.SIEVE_STEERING !== "0";
  if (env.SIEVE_SKILLS !== undefined) c.skills.enabled = env.SIEVE_SKILLS !== "0";
  if (env.SIEVE_MEMORY !== undefined) c.memory.enabled = env.SIEVE_MEMORY !== "0";
  return c;
}
