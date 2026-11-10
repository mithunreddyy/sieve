"""Hand-written fixtures for tools not installed on the capture machine.

They follow each tool's documented output format, but they are not captured output.
handwritten.tsv labels them so tests and reports never pass them off as real.
Regenerate with: python3 -I handwritten.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
rows = []

def save(ext, name, cmd, text):
    os.makedirs(os.path.join(HERE, ext), exist_ok=True)
    with open(os.path.join(HERE, ext, name + ".txt"), "w") as f:
        f.write(text)
    rows.append(f"{ext}/{name}.txt\t{cmd}\thand-written\tformat of the tool's documented output")

# cargo test
lines = ["   Compiling shop v0.1.0 (/work/shop)",
         "    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.92s",
         "     Running unittests src/lib.rs (target/debug/deps/shop-1a2b3c4d5e6f7a8b)", "",
         "running 62 tests"]
for i in range(61):
    lines.append(f"test tests::doubles_{i} ... ok")
    if i == 30:
        lines.append("test tests::discount_applied_once ... FAILED")
lines += ["", "failures:", "", "---- tests::discount_applied_once stdout ----", "",
          "thread 'tests::discount_applied_once' panicked at src/lib.rs:20:9:",
          "assertion `left == right` failed", "  left: 81.0", " right: 90.0",
          "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace", "", "",
          "failures:", "    tests::discount_applied_once", "",
          "test result: FAILED. 61 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s", "",
          "error: test failed, to rerun pass `--lib`"]
save("cargo-test", "one-failure", "cargo test", "\n".join(lines) + "\n")

# cargo build: one error, many repeated warnings
lines = [f"   Compiling {d} v1.0.{i}" for i, d in enumerate(["libc", "serde", "serde_json", "itoa", "ryu", "memchr", "proc-macro2", "quote", "syn", "tokio"])]
lines.append("   Compiling shop v0.1.0 (/work/shop)")
for i in range(1, 21):
    lines += [f"warning: unused variable: `scratch`", f"  --> src/handler{i}.rs:5:9", "   |",
              "5  |     let scratch = String::new();", "   |         ^^^^^^^ help: if this is intentional, prefix it with an underscore: `_scratch`",
              "   |"]
    if i == 1:
        lines.append("   = note: `#[warn(unused_variables)]` on by default")
    lines.append("")
lines += ["error[E0308]: mismatched types", "  --> src/routes.rs:12:22", "   |",
          "12 |     let limit: u32 = q.get(\"limit\");", "   |                ---   ^^^^^^^^^^^^^^ expected `u32`, found `Option<&String>`",
          "   |                |", "   |                expected due to this", "   |",
          "   = note: expected type `u32`", "              found enum `Option<&String>`", "",
          "For more information about this error, try `rustc --explain E0308`.",
          "warning: `shop` (lib) generated 20 warnings",
          "error: could not compile `shop` (lib) due to 1 previous error; 20 warnings emitted"]
save("rustc", "cargo-build", "cargo build", "\n".join(lines) + "\n")

# rspec
dots = "." * 70 + "F" + "." * 49
lines = ["", "Randomized with seed 41817", dots, "", "Failures:", "",
         "  1) Cart#total applies the discount once",
         "     Failure/Error: expect(cart.total(0.1)).to eq(90)", "",
         "       expected: 90", "            got: 81.0", "", "       (compared using ==)",
         "     # ./spec/cart_spec.rb:12:in `block (3 levels) in <top (required)>'",
         "     # /usr/local/bundle/gems/rspec-core-3.13.2/lib/rspec/core/example.rb:263:in `instance_exec'",
         "     # /usr/local/bundle/gems/rspec-core-3.13.2/lib/rspec/core/example.rb:263:in `block in run'",
         "     # /usr/local/bundle/gems/rspec-core-3.13.2/lib/rspec/core/hooks.rb:486:in `block in run'", "",
         "Finished in 0.0421 seconds (files took 0.21 seconds to load)", "120 examples, 1 failure", "",
         "Failed examples:", "", "rspec ./spec/cart_spec.rb:11 # Cart#total applies the discount once", "",
         "Randomized with seed 41817", ""]
save("rspec", "one-failure", "bundle exec rspec", "\n".join(lines))

# playwright, list reporter
lines = ["", "Running 48 tests using 4 workers", ""]
n = 0
for spec in ["home", "search", "cart", "account", "checkout", "orders"]:
    for t in range(8):
        n += 1
        if spec == "checkout" and t == 2:
            lines.append(f"  ✘  {n} [chromium] › tests/checkout.spec.ts:10:5 › checkout › pays with saved card (5.1s)")
        else:
            lines.append(f"  ✓  {n} [chromium] › tests/{spec}.spec.ts:{3 + t * 6}:5 › {spec} › case {t} ({300 + t * 37}ms)")
lines += ["", "", "  1) [chromium] › tests/checkout.spec.ts:10:5 › checkout › pays with saved card ─────────────────", "",
          "    Error: Timed out 5000ms waiting for expect(locator).toBeVisible()", "",
          "    Locator: getByRole('button', { name: 'Pay' })", "    Expected: visible",
          "    Received: <element(s) not found>", "    Call log:",
          "      - Expect \"toBeVisible\" with timeout 5000ms", "      - waiting for getByRole('button', { name: 'Pay' })", "",
          "       9 | test('pays with saved card', async ({ page }) => {", "      10 |   await page.goto('/checkout');",
          "    > 11 |   await expect(page.getByRole('button', { name: 'Pay' })).toBeVisible();",
          "         |                                                           ^", "      12 | });", "",
          "        at /work/tests/checkout.spec.ts:11:59", "", "",
          "  1 failed", "    [chromium] › tests/checkout.spec.ts:10:5 › checkout › pays with saved card",
          "  47 passed (12.3s)", ""]
save("playwright", "one-failure", "npx playwright test", "\n".join(lines))

with open(os.path.join(HERE, "handwritten.tsv"), "w") as f:
    f.write("\n".join(rows) + "\n")
print("\n".join(rows))
