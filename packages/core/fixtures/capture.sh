#!/usr/bin/env bash
# Regenerate the captured fixtures: build small projects, run the real tools, save their
# output. Usage: capture.sh <work-dir>   (writes into the directory holding this script)
# Paths are rewritten to /work and $HOME to /home/user so fixtures carry nothing machine-specific.
set -u
WORK=$(cd "${1:?work dir}" && pwd -P)
OUT=$(cd "$(dirname "$0")" && pwd -P)
MANIFEST="$OUT/captured.tsv"
: > "$MANIFEST"
mkdir -p "$WORK"

save() { # save <extractor> <name> <command shown> <tool+version>  (stdin: output)
  mkdir -p "$OUT/$1"
  sed -E -e "s#$WORK#/work#g" -e "s#/private/work#/work#g" -e "s#$HOME#/home/user#g" -e "s#$(whoami)#user#g" \
    -e "s#(/private)?/tmp/claude-[0-9]+/[^ ]*/cap#/work#g" -e "s#hostname=\"[^\"]*\"#hostname=\"host\"#g" \
    -e "s#$(hostname -s)#host#g" > "$OUT/$1/$2.txt"
  printf '%s\t%s\t%s\t%s\n' "$1/$2.txt" "$3" "captured" "$4" >> "$MANIFEST"
  echo "  $1/$2.txt ($(wc -l < "$OUT/$1/$2.txt") lines)"
}

# ---------- JavaScript: vitest, jest, bun test, tsc, eslint, biome ----------
JS=$WORK/js; mkdir -p "$JS/src" "$JS/vt" "$JS/jt" "$JS/bt" "$JS/ts" "$JS/lint"; cd "$JS"
[ -f package.json ] || echo '{ "name": "capjs", "private": true, "type": "module" }' > package.json
[ -d node_modules/vitest ] || bun add -d vitest@3 jest@30 eslint@9 @eslint/js@9 typescript@5.9 zod@3 @biomejs/biome@2 >/dev/null 2>&1
cat > src/cart.js <<'EOF'
import { z } from "zod";
const Item = z.object({ sku: z.string(), qty: z.number().int().positive(), price: z.number() });
export function parseItem(raw) { return Item.parse(raw); }
export function total(items, discount = 0) {
  const sum = items.reduce((s, i) => s + i.qty * i.price, 0);
  return Math.round(sum * (1 - discount) * (1 - discount) * 100) / 100;
}
EOF
for i in $(seq 1 40); do cat > vt/feature$i.test.js <<EOF
import { describe, expect, test } from "vitest";
import { total } from "../src/cart.js";
describe("feature $i", () => {
  test.each([[1, 2], [2, 4], [3, 6]])("doubles %i", (a, b) => expect(a * 2).toBe(b));
  test("sums", () => expect(total([{ sku: "a", qty: 2, price: 5 }])).toBe(10));
});
EOF
done
cat > vt/checkout.test.js <<'EOF'
import { describe, expect, test } from "vitest";
import { parseItem, total } from "../src/cart.js";
describe("checkout", () => {
  test("applies the discount once", () => {
    expect(total([{ sku: "a", qty: 1, price: 100 }], 0.1)).toBe(90);
  });
  test("parses a valid line item", () => {
    expect(parseItem({ sku: "b", qty: "2", price: 3 }).qty).toBe(2);
  });
});
EOF
V=$(npx vitest --version | head -1)
npx vitest run vt 2>&1 | save vitest default-two-failures "npx vitest run" "vitest $V"
npx vitest run vt --reporter=verbose 2>&1 | save vitest verbose-two-failures "npx vitest run --reporter=verbose" "vitest $V"
mv vt/checkout.test.js vt/checkout.test.js.off
npx vitest run vt 2>&1 | save vitest all-pass "npx vitest run" "vitest $V"
mv vt/checkout.test.js.off vt/checkout.test.js

# jest (CommonJS project of its own)
echo '{ "type": "commonjs" }' > jt/package.json
cat > jt/cart.js <<'EOF'
function total(items, discount = 0) {
  const sum = items.reduce((s, i) => s + i.qty * i.price, 0);
  return Math.round(sum * (1 - discount) * (1 - discount) * 100) / 100;
}
function parseQty(raw) { return JSON.parse(raw).qty; }
module.exports = { total, parseQty };
EOF
for i in $(seq 1 30); do cat > jt/module$i.test.js <<EOF
const { total } = require("./cart");
describe("module $i", () => {
  test.each([[1, 2], [2, 4], [3, 6]])("doubles %i", (a, b) => expect(a * 2).toBe(b));
  test("sums", () => expect(total([{ qty: 2, price: 5 }])).toBe(10));
});
EOF
done
cat > jt/checkout.test.js <<'EOF'
const { total, parseQty } = require("./cart");
describe("checkout", () => {
  test("applies the discount once", () => {
    expect(total([{ qty: 1, price: 100 }], 0.1)).toBe(90);
  });
  test("reads the quantity", () => {
    expect(parseQty("{qty: 2}")).toBe(2);
  });
});
EOF
J=$(npx jest --version)
(cd jt && npx jest --ci --rootDir . 2>&1) | save jest default-two-failures "npx jest" "jest $J"
(cd jt && npx jest --ci --verbose --rootDir . 2>&1) | save jest verbose-two-failures "npx jest --verbose" "jest $J"

# bun test
for i in $(seq 1 30); do cat > bt/unit$i.test.ts <<EOF
import { describe, expect, test } from "bun:test";
describe("unit $i", () => {
  for (const n of [1, 2, 3]) test(\`doubles \${n}\`, () => expect(n * 2).toBe(n + n));
});
EOF
done
cat > bt/broken.test.ts <<'EOF'
import { expect, test } from "bun:test";
test("rounds the total", () => {
  expect({ total: 80.99, items: 3 }).toEqual({ total: 81, items: 3 });
});
EOF
(cd bt && bun test 2>&1) | save bun-test one-failure "bun test" "bun $(bun --version)"

# tsc
cat > ts/tsconfig.json <<'EOF'
{ "compilerOptions": { "strict": true, "noEmit": true, "target": "es2022", "module": "esnext", "moduleResolution": "bundler" }, "include": ["*.ts"] }
EOF
for i in $(seq 1 25); do cat > ts/handler$i.ts <<EOF
interface Req { query: Record<string, string | undefined> }
export function handler$i(req: Req): number {
  const limit: number = req.query.limit;
  return limit * $i;
}
EOF
done
cat > ts/routes.ts <<'EOF'
function lookup(id: string) { return id.length; }
export function route(params: { id?: string }) {
  return lookup(params.id);
}
EOF
(cd ts && npx tsc -p . 2>&1) | save tsc many-duplicates "npx tsc --noEmit" "tsc $(npx tsc --version)"

# eslint
cat > lint/eslint.config.js <<'EOF'
import js from "@eslint/js";
export default [js.configs.recommended, { languageOptions: { globals: { console: "readonly" } } }];
EOF
for i in $(seq 1 20); do cat > lint/page$i.js <<EOF
import { helper } from "./util.js";
export function render$i(props) {
  const unused = props.title;
  if (props.count == null) { console.log(undefinedThing); }
  return props.count;
}
EOF
done
(cd lint && npx eslint . 2>&1) | save eslint stylish-repeated "npx eslint ." "eslint $(npx eslint --version)"
[ -x node_modules/.bin/biome ] || bun add -d @biomejs/biome@2 >/dev/null 2>&1
# Never `npx <name>` here: an unresolved name makes npx download whatever package has that name.
(cd lint && ../node_modules/.bin/biome lint --max-diagnostics=200 . 2>&1) | save biome lint-repeated "npx biome lint ." "$(node_modules/.bin/biome --version)"

# ---------- Python: pytest, junit xml, mypy, ruff, pip ----------
PY=$WORK/py; mkdir -p "$PY/tests" "$PY/app"; cd "$PY"
cat > app/__init__.py <<'EOF'
EOF
cat > app/pricing.py <<'EOF'
import json

def total(items, discount=0.0):
    s = sum(i["qty"] * i["price"] for i in items)
    return round(s * (1 - discount) * (1 - discount), 2)

def load_config(text):
    return json.loads(text)["discount"]
EOF
for i in $(seq 1 40); do cat > tests/test_feature$i.py <<EOF
import pytest
from app.pricing import total

@pytest.mark.parametrize("a,b", [(1, 2), (2, 4), (3, 6)])
def test_doubles(a, b):
    assert a * 2 == b

def test_sum():
    assert total([{"qty": 2, "price": 5}]) == 10
EOF
done
cat > tests/test_checkout.py <<'EOF'
from app.pricing import total, load_config

def test_discount_applied_once():
    assert total([{"qty": 1, "price": 100}], 0.1) == 90

def test_reads_discount_from_config():
    assert load_config("{discount: 0.1}") == 0.1
EOF
P=$(python3 -m pytest --version 2>&1)
python3 -m pytest -p no:cacheprovider 2>&1 | save pytest default-two-failures "pytest" "$P"
python3 -m pytest -p no:cacheprovider -v 2>&1 | save pytest verbose-two-failures "pytest -v" "$P"
python3 -m pytest -p no:cacheprovider -q --junitxml="$WORK/junit.xml" >/dev/null 2>&1; save junit pytest-two-failures "cat junit.xml" "$P --junitxml" < "$WORK/junit.xml"
for i in $(seq 1 15); do cat > app/svc$i.py <<EOF
from typing import Optional

def get_limit$i(q: dict[str, str]) -> int:
    limit: int = q.get("limit")
    return limit * $i

def name$i(x: Optional[str]) -> str:
    return x.upper()
EOF
done
python3 -m mypy --strict app 2>&1 | save mypy many-duplicates "mypy --strict app" "$(python3 -m mypy --version)"
for i in $(seq 1 15); do cat > app/legacy$i.py <<EOF
import os, sys
from typing import *
def f$i(x):
    l = [1,2,3]
    if x == None: return l
    except_value = eval("x")
    return except_value
EOF
done
ruff check --no-cache app 2>&1 | save ruff many-duplicates "ruff check app" "$(ruff --version)"
rm -rf "$WORK/pydeps"
pip3 install --no-cache-dir --target "$WORK/pydeps" requests rich 2>&1 | save pkg pip-install "pip install requests rich" "$(pip3 --version | cut -d' ' -f1-2)"

# ---------- npm / pnpm ----------
NP=$WORK/npm; rm -rf "$NP"; mkdir -p "$NP"; cd "$NP"; echo '{"name":"capnpm","version":"1.0.0"}' > package.json
npm install --no-audit --no-fund request@2.88.2 node-sass-middleware@1.0.1 2>&1 | save pkg npm-install-deprecated "npm install request node-sass-middleware" "npm $(npm --version)"
PN=$WORK/pnpm; rm -rf "$PN"; mkdir -p "$PN"; cd "$PN"; echo '{"name":"cappnpm","version":"1.0.0"}' > package.json
pnpm add express@4 webpack@5 2>&1 | save pkg pnpm-add "pnpm add express webpack" "pnpm $(pnpm --version)"
NL=$WORK/npmlog; rm -rf "$NL"; mkdir -p "$NL"; cd "$NL"; echo '{"name":"caplog","version":"1.0.0"}' > package.json
npm install --no-audit --no-fund --loglevel silly express@4 2>&1 | save logs npm-silly "npm install --loglevel silly express" "npm $(npm --version)"

# ---------- Go ----------
GO=$WORK/go; mkdir -p "$GO"; cd "$GO"
[ -f go.mod ] || go mod init example.com/shop >/dev/null 2>&1
cat > cart.go <<'EOF'
package shop

import "strconv"

func Total(prices []float64, discount float64) float64 {
	s := 0.0
	for _, p := range prices {
		s += p
	}
	return s * (1 - discount) * (1 - discount)
}

func ParseQty(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		panic(err)
	}
	return n
}
EOF
cat > cart_test.go <<'EOF'
package shop

import (
	"fmt"
	"testing"
)

func TestDoubles(t *testing.T) {
	for i := 0; i < 60; i++ {
		t.Run(fmt.Sprintf("case_%d", i), func(t *testing.T) {
			if i*2 != i+i {
				t.Fatal("math broke")
			}
		})
	}
}

func TestDiscountAppliedOnce(t *testing.T) {
	if got := Total([]float64{100}, 0.1); got != 90 {
		t.Errorf("Total() = %v, want 90", got)
	}
}
EOF
go test -v ./... 2>&1 | save go-test verbose-one-failure "go test -v ./..." "$(go version)"
go test ./... 2>&1 | save go-test default-one-failure "go test ./..." "$(go version)"
cat > panic_test.go <<'EOF'
package shop

import "testing"

func TestParseQty(t *testing.T) {
	if ParseQty("2x") != 2 {
		t.Fail()
	}
}
EOF
go test ./... 2>&1 | save go-test panic "go test ./..." "$(go version)"
rm panic_test.go

# ---------- C (clang) ----------
C=$WORK/c; mkdir -p "$C"; cd "$C"
cat > util.h <<'EOF'
static int helper(int x) { int unused_local = 3; return x; }
EOF
for i in $(seq 1 12); do cat > mod$i.c <<EOF
#include "util.h"
int calc$i(int a) {
  int b;
  unsigned u = 1;
  if (a < u) return b;
  return helper(a) + missing_fn$i(a);
}
EOF
done
clang -Wall -Wextra -c mod*.c 2>&1 | save clang repeated "clang -Wall -Wextra -c mod*.c" "$(clang --version | head -1)"

# ---------- git ----------
G=$WORK/execa
[ -d "$G" ] || git clone -q --depth 200 https://github.com/sindresorhus/execa "$G"
cd "$G"; git checkout -q . ; git clean -qfd
git log -n 120 2>&1 | save git log "git log -n 120" "$(git --version)"
git log --stat -n 40 2>&1 | save git log-stat "git log --stat -n 40" "$(git --version)"
git diff HEAD~25 HEAD 2>&1 | save git diff-range "git diff HEAD~25 HEAD" "$(git --version)"
for f in $(git ls-files 'lib/**/*.js' | head -30); do echo "// touched" >> "$f"; done
for i in $(seq 1 25); do echo x > "scratch-$i.tmp"; done
git rm -q --cached readme.md
git status 2>&1 | save git status-many "git status" "$(git --version)"
git checkout -q .; git reset -q; git clean -qfd

# ---------- search ----------
rg -n "subprocess" "$G" 2>&1 | head -800 | save search rg-many "rg -n subprocess" "$(rg --version | head -1)"
grep -rn "stdout" "$G/lib" 2>&1 | head -800 | save search grep-many "grep -rn stdout lib" "grep (bsd)"

# ---------- JSON / HTML ----------
npm view zod@3.23.8 --json 2>/dev/null | save json npm-view "npm view zod@3.23.8 --json" "npm $(npm --version)"
curl -fsSL "https://api.github.com/repos/sindresorhus/execa/issues?per_page=30&state=closed" 2>&1 | save json github-issues "curl api.github.com/repos/sindresorhus/execa/issues" "GitHub REST API"
curl -fsSL "https://nodejs.org/api/path.html" 2>&1 | save html node-path-docs "curl https://nodejs.org/api/path.html" "nodejs.org (MIT)"
echo "done: $(wc -l < "$MANIFEST") fixtures"
