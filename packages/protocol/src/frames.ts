import { z } from "zod";

export const RequestFrame = z.object({
  v: z.number().int(),
  id: z.string().optional(),
  type: z.enum(["hook", "tool", "status", "ping", "shutdown"]),
  client: z.string().optional(),
  budgetMs: z.number().positive().optional(),
  agent: z.string().optional(),
  event: z.string().optional(),
  input: z.unknown().optional(),
  tool: z.string().optional(),
  args: z.unknown().optional(),
  cwd: z.string().optional(),
});
export type RequestFrame = z.infer<typeof RequestFrame>;

export type ErrorCode = "version_mismatch" | "bad_request" | "unknown_tool" | "invalid_args" | "internal";

export interface HookResult {
  /** Text the shim prints to stdout. Empty means pass-through. */
  stdout: string;
  exitCode: number;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

export type ReplyFrame =
  | { v: number; id?: string; ok: true; daemon: string; result: unknown }
  | { v: number; id?: string; ok: false; daemon: string; error: { code: ErrorCode; message: string } };
