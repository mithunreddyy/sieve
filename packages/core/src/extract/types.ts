export interface ExtractInput {
  /** ANSI-stripped, progress redraws collapsed. */
  text: string;
  /** Shell command, if known. */
  command?: string;
  /** Agent or MCP tool name. */
  toolName?: string;
  /** Search pattern for grep-like tools (Claude Code's Grep `pattern`). */
  pattern?: string;
  isError: boolean;
  intent?: string;
  /** Soft cap in bytes for the body. Failures may exceed it (they are never cut). */
  budget: number;
}

export interface Extraction {
  /** Extractor id, shown in the receipt. */
  extractor: string;
  /** What the agent sees. */
  body: string;
  /** What was dropped, e.g. ["412 passing tests", "38 library frames"]. Empty means nothing. */
  dropped: string[];
  /** True when failures or errors were kept whole. */
  keptVerbatim: boolean;
}

export interface Extractor {
  id: string;
  /** Cheap and deterministic. 0 = not mine, 1..100 = confidence. Highest wins; ties go to registry order. */
  detect(input: ExtractInput): number;
  /** Pure: same input, same bytes. Returns null when the text does not parse after all. */
  extract(input: ExtractInput): Extraction | null;
  /**
   * Stable identifiers of the failures in this output (failing test names, diagnostic
   * locations), used to compare a rerun with the previous run. Optional.
   */
  keys?(input: ExtractInput): string[];
}
