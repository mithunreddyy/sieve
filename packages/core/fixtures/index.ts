import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fixture manifest and the facts each output must keep. Shared by the extractor tests and
 * the replay benchmark so both measure the same thing.
 */
export interface Fixture {
  file: string;
  command: string;
  source: "captured" | "hand-written";
  tool: string;
}

export function loadFixtures(): Fixture[] {
  return ["captured.tsv", "handwritten.tsv"].flatMap((m) =>
    readFileSync(join(import.meta.dir, m), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [file, command, source, tool] = l.split("\t");
        return { file: file!, command: command!, source: source as Fixture["source"], tool: tool! };
      }),
  );
}

export const readFixture = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/** Fixtures whose extractor is not simply their directory name. */
export const EXPECTED: Record<string, string> = {
  "git/diff-range.txt": "git-diff",
  "git/log.txt": "git-log",
  "git/log-stat.txt": "git-log",
  "git/status-many.txt": "git-status",
};

/** Facts that only exist in the extracted form (e.g. locations rewritten as file:line:col). */
export const OUTPUT_HAS: Record<string, string[]> = {
  "eslint/stylish-repeated.txt": ["/work/js/lint/page20.js:4:42", "/work/js/lint/page9.js:1:10"],
  "biome/lint-repeated.txt": ["page20.js:3:9"],
};

/** Outputs with nothing worth folding: the extractor declines and the fallback decides. */
export const NOTHING_TO_FOLD = new Set(["pkg/npm-install-deprecated.txt"]);

/** Facts an agent needs from each output. Each must be in the original and survive extraction. */
export const NEEDLES: Record<string, string[]> = {
  "vitest/default-two-failures.txt": ["AssertionError: expected 81 to be 90", "vt/checkout.test.js:5:60", "ZodError", "parseItem src/cart.js:3:46", "Tests  2 failed | 160 passed (162)"],
  "vitest/verbose-two-failures.txt": ["AssertionError: expected 81 to be 90", "vt/checkout.test.js:8:21", "Expected number, received string"],
  "jest/default-two-failures.txt": ["Expected: 90", "Received: 81", "checkout.test.js:4:50", "SyntaxError: Expected property name", "cart.js:5:38", "Tests:       2 failed, 120 passed, 122 total"],
  "jest/verbose-two-failures.txt": ["Expected: 90", "SyntaxError: Expected property name", "Tests:       2 failed, 120 passed, 122 total"],
  "bun-test/one-failure.txt": ["(fail) rounds the total", '"total": 80.99', "broken.test.ts:3:38", " 90 pass"],
  "pytest/default-two-failures.txt": ["AssertionError: assert 81.0 == 90", "tests/test_checkout.py:4: AssertionError", "app/pricing.py:8: in load_config", "JSONDecodeError: Expecting property name", "2 failed, 160 passed"],
  "pytest/verbose-two-failures.txt": ["AssertionError: assert 81.0 == 90", "JSONDecodeError: Expecting property name", "FAILED tests/test_checkout.py::test_discount_applied_once"],
  "junit/pytest-two-failures.txt": ["test_discount_applied_once", "AssertionError: assert 81.0 == 90", "JSONDecodeError"],
  "go-test/verbose-one-failure.txt": ["--- FAIL: TestDiscountAppliedOnce", "Total() = 81, want 90", "FAIL\texample.com/shop"],
  "go-test/panic.txt": ['panic: strconv.Atoi: parsing "2x": invalid syntax', "/work/go/cart.go:16", "/work/go/panic_test.go:6", "Total() = 81, want 90"],
  "cargo-test/one-failure.txt": ["assertion `left == right` failed", "  left: 81.0", "test result: FAILED. 61 passed; 1 failed"],
  "rspec/one-failure.txt": ["expected: 90", "got: 81.0", "./spec/cart_spec.rb:12", "120 examples, 1 failure"],
  "playwright/one-failure.txt": ["Timed out 5000ms", "checkout.spec.ts:11:59", "47 passed (12.3s)"],
  "tsc/many-duplicates.txt": ["routes.ts(3,17): error TS2345", "handler25.ts(3,9)", "handler9.ts(3,9)", "Type 'undefined' is not assignable to type 'number'."],
  "eslint/stylish-repeated.txt": ["'undefinedThing' is not defined", "/work/js/lint/page20.js", "✖ 60 problems (60 errors, 0 warnings)"],
  "biome/lint-repeated.txt": ["lint/correctness/noUnusedImports", "page1.js:1:8"],
  "mypy/many-duplicates.txt": ["app/svc9.py:8", "app/svc15.py:4", "[union-attr]"],
  "ruff/many-duplicates.txt": ["F401", "app/legacy15.py", "Found 105 errors."],
  "rustc/cargo-build.txt": ["error[E0308]: mismatched types", "src/routes.rs:12:22", "src/handler20.rs:5:9", "could not compile `shop`"],
  "clang/repeated.txt": ["missing_fn12", "mod9.c:5:9", "./util.h:1:32"],
  "pkg/pip-install.txt": ["Successfully installed"],
  "pkg/npm-install-deprecated.txt": ["request@2.88.2: request has been deprecated"],
  "pkg/pnpm-add.txt": ["+ express 4.22.3", "+ webpack 5.112.2"],
  "git/log.txt": ["Sindre Sorhus"],
  "git/status-many.txt": ["scratch-25.tmp", "lib/ipc/", "readme.md"],
  "json/npm-view.txt": ['"name": "zod"'],
};

