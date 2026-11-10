/**
 * Five replay tasks for slice 1. Each has a tool output the agent would receive and the
 * facts the agent needs from it to finish the task. The outputs are SYNTHETIC (generated
 * here, shaped like real tool output); slice 2 replaces them with captured real output.
 * A task "keeps its facts" only if every needle is visible in what the agent sees.
 */
export interface ReplayTask {
  id: string;
  title: string;
  tool: string;
  command: string;
  /** What the agent said it was looking for (Claude Code's Bash `description`). */
  intent: string;
  output: string;
  needles: string[];
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export function replayTasks(): ReplayTask[] {
  const failing = range(420).map((i) =>
    i === 233
      ? [
          " FAIL  src/billing/invoice.test.ts > totals > applies the discount once",
          "AssertionError: expected 90 to be 81",
          " ❯ src/billing/invoice.test.ts:48:22",
          "     46|     const inv = makeInvoice({ subtotal: 100, discount: 0.1 });",
          "     47|     applyDiscount(inv);",
          "     48|     expect(inv.total).toBe(81);",
        ].join("\n")
      : ` ✓ src/module${i}/feature.test.ts (${(i % 9) + 2} tests) ${(i % 50) + 4}ms`,
  );
  failing.push(
    "",
    " Test Files  1 failed | 419 passed (420)",
    "      Tests  1 failed | 2311 passed (2312)",
    "   Duration  14.21s",
  );

  const tsc = range(160).map(
    (i) =>
      `src/generated/api${i}.ts(${i + 3},5): warning TS6133: 'unused${i}' is declared but its value is never read.`,
  );
  tsc.splice(
    90,
    0,
    "src/server/routes.ts(212,17): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
  );
  tsc.push("", "Found 1 error and 160 warnings in 161 files.");

  const logs = range(9000).map((i) => {
    const t = `2026-11-10T09:${String(Math.floor(i / 150) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
    if (i === 7412)
      return `${t} ERROR payments.worker panic: nil pointer dereference in settleBatch (batch=88213)`;
    return `${t} INFO  http GET /api/items/${i % 300} 200 ${(i % 40) + 3}ms`;
  });

  const grep = range(700).map(
    (i) =>
      `src/${["ui", "core", "api", "jobs"][i % 4]}/file${i}.ts:${(i % 200) + 1}:  const client = createLegacyClient(config${i % 7});`,
  );
  grep.splice(
    500,
    0,
    "src/core/bootstrap.ts:12:export function createLegacyClient(config: LegacyConfig): Client {",
  );

  const page = range(400).map((i) =>
    i === 333
      ? "Rate limits: the v3 API allows 900 requests per 15 minutes per token; exceeding it returns HTTP 429 with a Retry-After header."
      : `Section ${i}. This paragraph describes general usage of the platform, onboarding steps, and links to other guides (${i}).`,
  );

  return [
    {
      id: "fix-failing-test",
      title: "Fix a failing test",
      tool: "Bash",
      command: "npx vitest run",
      intent: "Run the tests and find the failure",
      output: failing.join("\n"),
      needles: ["expected 90 to be 81", "invoice.test.ts:48"],
    },
    {
      id: "debug-build",
      title: "Debug a build",
      tool: "Bash",
      command: "npx tsc --noEmit",
      intent: "Type-check and find the error",
      output: tsc.join("\n"),
      needles: ["routes.ts(212,17): error TS2345"],
    },
    {
      id: "analyse-logs",
      title: "Analyse logs",
      tool: "Bash",
      command: "kubectl logs deploy/api --since=1h",
      intent: "Find the panic in the payments worker",
      output: logs.join("\n"),
      needles: ["panic: nil pointer dereference in settleBatch"],
    },
    {
      id: "refactor-across-files",
      title: "Refactor across files",
      tool: "Bash",
      command: "rg -n createLegacyClient src",
      intent: "Find where createLegacyClient is defined and used",
      output: grep.join("\n"),
      needles: ["bootstrap.ts:12:export function createLegacyClient"],
    },
    {
      id: "research-web",
      title: "Research with a web page",
      tool: "WebFetch",
      command: "https://example.com/docs/api",
      intent: "What are the API rate limits",
      output: page.join("\n"),
      needles: ["900 requests per 15 minutes"],
    },
  ];
}
