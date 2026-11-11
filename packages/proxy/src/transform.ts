/**
 * Request transforms for the local proxy (slice 10). Each takes a parsed request body and
 * returns a changed copy plus what it did. They never throw to the caller's request: the server
 * wraps them and sends the original bytes if anything goes wrong.
 *
 * What is touched: tool descriptions (cut), tool results (replaced by a receipt, original archived),
 * cache marks (added only in free slots). What is never touched: user text, assistant text,
 * thinking blocks and their signatures, tool calls and their inputs (so file edits are intact),
 * and the results of edit tools and of failed calls.
 */

// biome-ignore lint/suspicious/noExplicitAny: provider request bodies are open-ended JSON
type Json = any;

export interface ProxyLimits {
  trimDescriptionBytes: number;
  foldResultBytes: number;
  archiveAt: number;
  archiveStep: number;
  keepRecentMessages: number;
  addCacheMarks: boolean;
  foldHistory: boolean;
  trimTools: boolean;
}

/** What the transforms need from the archive. Implemented over a ProjectStore in the server. */
export interface Archiver {
  /** Archive `text` and return a receipt for it, or null if a receipt would not be shorter. */
  receipt(text: string, meta: { tool?: string; command?: string }): { text: string; id: string } | null;
  /** Archive `text` and return its id. */
  archive(text: string): string;
}

export interface Stats {
  trimmedBytes: number;
  folded: number;
  archived: number;
  marksAdded: number;
  /** Full definitions of tools whose description was cut. */
  schemas: Array<{ name: string; definition: Json }>;
}
const fresh = (): Stats => ({ trimmedBytes: 0, folded: 0, archived: 0, marksAdded: 0, schemas: [] });

const EDIT_TOOL =
  /^(edit|write|multiedit|notebookedit|apply_patch|str_replace\w*|create_file|replace\w*|insert\w*)$/i;
const RECEIPT = /\[sieve (s_[a-z2-7]+)\]/;
const ARCHIVED = /^\[sieve archived /;

/** Context window by model name, in tokens. A guess from the name; override with `archive_at`. */
export function contextWindow(model: string | undefined): number {
  const m = (model ?? "").toLowerCase();
  if (/1m|gemini|gpt-4\.1/.test(m)) return 1_000_000;
  if (/claude|sonnet|opus|haiku|fable/.test(m)) return 200_000;
  if (/gpt-5|o3|o4/.test(m)) return 400_000;
  if (/llama|qwen|mistral|deepseek|gemma/.test(m)) return 128_000;
  return 128_000;
}

/** ~3.6 characters per token: cheap, and only used to decide when to archive. */
export const approxTokens = (s: string) => Math.ceil(s.length / 3.6);

// ------------------------------------------------------------------ tool schemas

/** Cut a description at a sentence boundary under `max` bytes, and say where the full text is. */
export function trimDescription(desc: string, max: number, name: string): string {
  if (Buffer.byteLength(desc) <= max) return desc;
  const suffix = ` […] (full text: sieve_schema {"tool":${JSON.stringify(name)}})`;
  const room = Math.max(100, max - Buffer.byteLength(suffix));
  // work in characters, then back off until the bytes fit
  let head = desc.slice(0, room);
  while (Buffer.byteLength(head) > room) head = head.slice(0, -1);
  const sentence = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
    head.lastIndexOf(".\n"),
  );
  if (sentence > room * 0.4) head = head.slice(0, sentence + 1);
  else {
    const word = head.lastIndexOf(" ");
    if (word > room * 0.6) head = head.slice(0, word);
  }
  return head.trimEnd() + suffix;
}

function trimOne(
  tool: Json,
  get: () => string | undefined,
  set: (s: string) => void,
  name: string,
  max: number,
  st: Stats,
) {
  const d = get();
  if (typeof d !== "string" || Buffer.byteLength(d) <= max) return;
  const t = trimDescription(d, max, name);
  if (t === d) return;
  st.schemas.push({ name, definition: structuredClone(tool) });
  st.trimmedBytes += Buffer.byteLength(d) - Buffer.byteLength(t);
  set(t);
}

function trimAnthropicTools(body: Json, max: number, st: Stats) {
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (
      !t ||
      typeof t.name !== "string" ||
      t.type?.startsWith?.("computer") ||
      t.type?.startsWith?.("bash_") ||
      t.type?.startsWith?.("text_editor")
    )
      continue;
    trimOne(
      t,
      () => t.description,
      (s) => (t.description = s),
      t.name,
      max,
      st,
    );
  }
}
function trimOpenAITools(body: Json, max: number, st: Stats) {
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    const f = t?.function;
    if (f && typeof f.name === "string")
      trimOne(
        t,
        () => f.description,
        (s) => (f.description = s),
        f.name,
        max,
        st,
      );
  }
}
function trimGeminiTools(body: Json, max: number, st: Stats) {
  for (const t of Array.isArray(body.tools) ? body.tools : [])
    for (const f of Array.isArray(t?.functionDeclarations) ? t.functionDeclarations : [])
      if (typeof f?.name === "string")
        trimOne(
          f,
          () => f.description,
          (s) => (f.description = s),
          f.name,
          max,
          st,
        );
}

// ------------------------------------------------------------------ tool results

interface Slot {
  /** Index into messages. */
  msg: number;
  get(): string | null;
  set(text: string): void;
  tool: string | undefined;
  command: string | undefined;
}

function anthropicSlots(body: Json): Slot[] {
  const calls = new Map<string, { name: string; input: Json }>();
  const out: Slot[] = [];
  const msgs: Json[] = Array.isArray(body.messages) ? body.messages : [];
  msgs.forEach((m, msg) => {
    if (!Array.isArray(m?.content)) return;
    for (const b of m.content) {
      if (b?.type === "tool_use" && typeof b.id === "string")
        calls.set(b.id, { name: String(b.name), input: b.input });
      if (b?.type !== "tool_result" || b.is_error) continue;
      const call = calls.get(b.tool_use_id);
      const content = b.content;
      let text: string | null = null;
      if (typeof content === "string") text = content;
      else if (
        Array.isArray(content) &&
        content.length &&
        content.every((x: Json) => x?.type === "text" && typeof x.text === "string")
      )
        text = content.map((x: Json) => x.text).join("\n");
      if (text === null) continue; // images and other blocks stay
      out.push({
        msg,
        get: () =>
          typeof b.content === "string" ? b.content : b.content.map((x: Json) => x.text).join("\n"),
        set: (s) => {
          b.content = s;
        },
        tool: call?.name,
        command: typeof call?.input?.command === "string" ? call.input.command : undefined,
      });
    }
  });
  return out;
}

function openaiSlots(body: Json): Slot[] {
  const calls = new Map<string, { name: string; args: Json }>();
  const out: Slot[] = [];
  const msgs: Json[] = Array.isArray(body.messages) ? body.messages : [];
  msgs.forEach((m, msg) => {
    for (const c of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
      let args: Json = {};
      try {
        args = JSON.parse(c?.function?.arguments ?? "{}");
      } catch {}
      if (typeof c?.id === "string") calls.set(c.id, { name: String(c?.function?.name), args });
    }
    if (m?.role !== "tool" || typeof m.content !== "string") return;
    const call = calls.get(m.tool_call_id);
    out.push({
      msg,
      get: () => m.content,
      set: (s) => {
        m.content = s;
      },
      tool: call?.name,
      command: typeof call?.args?.command === "string" ? call.args.command : undefined,
    });
  });
  return out;
}

function eligible(s: Slot): boolean {
  return !(s.tool && EDIT_TOOL.test(s.tool));
}

/** Replace large results with receipts, the first time they are seen. Deterministic, so a replayed history is unchanged. */
function foldResults(slots: Slot[], a: Archiver, minBytes: number, st: Stats) {
  for (const s of slots) {
    const text = s.get();
    if (
      text === null ||
      Buffer.byteLength(text) < minBytes ||
      !eligible(s) ||
      RECEIPT.test(text) ||
      ARCHIVED.test(text)
    )
      continue;
    const r = a.receipt(text, {
      ...(s.tool ? { tool: s.tool } : {}),
      ...(s.command ? { command: s.command } : {}),
    });
    if (!r) continue;
    s.set(r.text);
    st.folded++;
  }
}

/**
 * Past the threshold, archive old results in fixed steps: the oldest `k` results (k a multiple of
 * `step`) are replaced by one-line pointers. Because k only grows as history grows, the request
 * prefix changes once per step rather than on every turn, which keeps provider caches warm.
 */
function archiveOld(
  slots: Slot[],
  total: number,
  window: number,
  lim: ProxyLimits,
  a: Archiver,
  st: Stats,
  forceTokens = 0,
  msgCount = Infinity,
) {
  const target = (lim.archiveAt - 0.1) * window;
  const need = forceTokens > 0 ? forceTokens : total - target;
  if (need <= 0 && forceTokens <= 0) return;
  if (total <= lim.archiveAt * window && forceTokens <= 0) return;
  const cutoff = msgCount - lim.keepRecentMessages;
  const cands = slots.filter(
    (s) => s.msg < cutoff && eligible(s) && !ARCHIVED.test(s.get() ?? "") && (s.get()?.length ?? 0) > 400,
  );
  let saved = 0;
  let k = 0;
  while (k < cands.length && saved < need) {
    const text = cands[k]!.get() ?? "";
    saved += approxTokens(text) - 60;
    k++;
  }
  k = Math.min(cands.length, Math.ceil(k / lim.archiveStep) * lim.archiveStep);
  for (const s of cands.slice(0, k)) {
    const text = s.get() ?? "";
    const id = RECEIPT.exec(text)?.[1] ?? a.archive(text);
    const first = text.replace(/\s+/g, " ").trim().slice(0, 100);
    s.set(
      `[sieve archived an older tool result (${text.length.toLocaleString("en-US")} characters): sieve_get {"id":"${id}"}] ${first}…`,
    );
    st.archived++;
  }
}

// ------------------------------------------------------------------ cache marks (Anthropic)

function countMarks(body: Json): number {
  let n = 0;
  const walk = (x: Json) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      if (x.cache_control) n++;
      for (const k of Object.keys(x)) if (k !== "cache_control") walk(x[k]);
    }
  };
  walk(body.system);
  walk(body.tools);
  walk(body.messages);
  return n;
}

const MAX_MARKS = 4;

/** Add Sieve's marks only in free slots, never touching the client's. Returns how many were added. */
export function addCacheMarks(body: Json): number {
  let free = MAX_MARKS - countMarks(body);
  let added = 0;
  const mark = { type: "ephemeral" };
  // 1. end of the system prompt
  if (free > 0 && body.system) {
    if (typeof body.system === "string" && body.system.length) {
      body.system = [{ type: "text", text: body.system, cache_control: mark }];
      free--;
      added++;
    } else if (
      Array.isArray(body.system) &&
      body.system.length &&
      !body.system.some((b: Json) => b?.cache_control)
    ) {
      const last = body.system[body.system.length - 1];
      if (last && typeof last === "object") {
        last.cache_control = mark;
        free--;
        added++;
      }
    }
  }
  // 2. end of the tool list
  if (
    free > 0 &&
    Array.isArray(body.tools) &&
    body.tools.length &&
    !body.tools.some((t: Json) => t?.cache_control)
  ) {
    const last = body.tools[body.tools.length - 1];
    if (last && typeof last === "object" && !last.type?.startsWith?.("computer")) {
      last.cache_control = mark;
      free--;
      added++;
    }
  }
  // 3. the conversation so far (everything before the newest user turn)
  if (free > 0 && Array.isArray(body.messages) && body.messages.length >= 3) {
    const m = body.messages[body.messages.length - 2];
    if (m && Array.isArray(m.content) && m.content.length) {
      const last = m.content[m.content.length - 1];
      if (
        last &&
        typeof last === "object" &&
        !last.cache_control &&
        last.type !== "thinking" &&
        last.type !== "redacted_thinking"
      ) {
        last.cache_control = mark;
        free--;
        added++;
      }
    } else if (m && typeof m.content === "string" && m.content.length) {
      m.content = [{ type: "text", text: m.content, cache_control: mark }];
      free--;
      added++;
    }
  }
  return added;
}

// ------------------------------------------------------------------ entry points

export interface Transformed {
  body: Json;
  stats: Stats;
}

function history(body: Json, slots: Slot[], lim: ProxyLimits, a: Archiver, st: Stats, force = 0) {
  const window = contextWindow(body.model);
  if (lim.foldHistory) foldResults(slots, a, lim.foldResultBytes, st);
  const total = approxTokens(JSON.stringify(body));
  const n = Array.isArray(body.messages) ? body.messages.length : 0;
  if (lim.foldHistory || force) archiveOld(slots, total, window, lim, a, st, force, n);
}

export function transformAnthropic(
  input: Json,
  lim: ProxyLimits,
  a: Archiver,
  opts: { force?: number } = {},
): Transformed {
  const body = structuredClone(input);
  const st = fresh();
  if (lim.trimTools) trimAnthropicTools(body, lim.trimDescriptionBytes, st);
  history(body, anthropicSlots(body), lim, a, st, opts.force ?? 0);
  if (lim.addCacheMarks) st.marksAdded = addCacheMarks(body);
  return { body, stats: st };
}

export function transformOpenAI(
  input: Json,
  lim: ProxyLimits,
  a: Archiver,
  opts: { force?: number } = {},
): Transformed {
  const body = structuredClone(input);
  const st = fresh();
  if (lim.trimTools) trimOpenAITools(body, lim.trimDescriptionBytes, st);
  history(body, openaiSlots(body), lim, a, st, opts.force ?? 0);
  return { body, stats: st };
}

export function transformGemini(input: Json, lim: ProxyLimits): Transformed {
  const body = structuredClone(input);
  const st = fresh();
  if (lim.trimTools) trimGeminiTools(body, lim.trimDescriptionBytes, st);
  return { body, stats: st };
}

/** Tokens a provider says the request had and its limit, from a "too long" refusal. */
export function parseTooLong(message: string): { actual: number; limit: number } | null {
  if (!/too long|context length|context_length|maximum context|exceed/i.test(message)) return null;
  const nums = [...message.matchAll(/\d[\d,]{3,}/g)]
    .map((m) => Number(m[0].replace(/,/g, "")))
    .filter((x) => x >= 1000);
  if (nums.length < 2) return null;
  const actual = Math.max(nums[0]!, nums[1]!);
  const limit = Math.min(nums[0]!, nums[1]!);
  return actual > limit ? { actual, limit } : null;
}
