import { z } from "zod";

/**
 * Input schemas for the MCP tools built so far. Every schema is strict: unknown
 * fields are rejected with an error that names them, because the caller is a model.
 * Descriptions stay under 400 characters (checked in tests).
 */

const lineRange = z.string().regex(/^\d+-\d+$/, "expected a line range like 120-180");

export const RunArgs = z
  .object({
    language: z.string().min(1).describe("shell | powershell | python | js | ts, or any runtime on PATH"),
    code: z.string().min(1),
    file: z.string().optional().describe("Exposed to the script as SIEVE_FILE"),
    intent: z.string().optional().describe("What you are looking for; ranks the lines kept"),
    timeoutMs: z.number().int().min(1).max(600_000).optional(),
    background: z.boolean().optional(),
  })
  .strict();

export const GetArgs = z
  .object({
    id: z.string().regex(/^(s|j)_[a-z2-7]+$/, "expected an id like s_abc123 or j_abc123"),
    lines: lineRange.optional(),
  })
  .strict();

export const ReadArgs = z
  .object({
    path: z.string().min(1),
    intent: z.string().optional().describe("What you are looking for; its lines are shown with the outline"),
    ranges: z.array(lineRange).max(10).optional().describe('Line ranges to return, e.g. ["120-180"]'),
    full: z.boolean().optional().describe("Return the whole file even if it is large or unchanged"),
  })
  .strict();

export const SearchArgs = z
  .object({
    query: z.string().min(1),
    scope: z.enum(["session", "worktree", "project"]).optional(),
    sort: z.enum(["relevance", "timeline"]).optional(),
    cursor: z.string().optional(),
  })
  .strict();

export const IndexArgs = z
  .object({
    path: z.string().optional(),
    content: z.string().optional(),
    title: z.string().optional(),
  })
  .strict()
  .refine((a) => (a.path === undefined) !== (a.content === undefined), {
    message: "give exactly one of path or content",
  });

export const BatchArgs = z
  .object({
    commands: z.array(z.string().min(1)).min(1).max(20).describe("Shell commands, run in order"),
    queries: z.array(z.string().min(1)).min(1).max(10).describe("What you want to know from their output"),
    timeoutMs: z.number().int().min(1).max(600_000).optional().describe("Total time for all commands"),
  })
  .strict();

export const StatsArgs = z.object({}).strict();

export const TOOLS = {
  sieve_run: {
    schema: RunArgs,
    description:
      "Run code (shell, python, js/ts, or any runtime on PATH) and get a short, extracted result plus a receipt. Large output is archived, not lost: expand it with sieve_get. Use this instead of running commands that print a lot. Pass intent to keep the lines you care about.",
  },
  sieve_batch: {
    schema: BatchArgs,
    description:
      "Run several shell commands in order, index all their output, and get back only the parts that answer your queries (top 3 per query, with ids to expand). Use it to gather facts from noisy commands in one call.",
  },
  sieve_get: {
    schema: GetArgs,
    description:
      "Expand an archived item by id (s_…), in full or a line range, exactly as it was. Also returns status and output of a background run (j_…).",
  },
  sieve_read: {
    schema: ReadArgs,
    description:
      "Read a file smartly: an outline plus the lines matching your intent for large files, only the changed hunks if it changed since you read it, or a note if it is unchanged. Use ranges for specific lines and full: true to get the whole file.",
  },
  sieve_search: {
    schema: SearchArgs,
    description:
      "Search everything Sieve archived or indexed (tool output, runs, files read) and the project's symbols. 5 hits per page with source, id and a flag if the file changed since; pass the cursor for more. scope: session, worktree, or project (default). sort: relevance or timeline.",
  },
  sieve_index: {
    schema: IndexArgs,
    description:
      "Index a file or folder (path, respects .gitignore) or raw content so it can be found with sieve_search later.",
  },
  sieve_stats: {
    schema: StatsArgs,
    description: "Tokens archived versus returned for this project, plus hook health per agent.",
  },
} as const;

export type ToolName = keyof typeof TOOLS;
