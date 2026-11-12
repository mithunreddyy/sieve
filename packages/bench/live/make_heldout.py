# Held-out tasks: written before any tuning, run once at the end. Multi-step, one checkable answer each.
import os, sys, json, random
task, d = sys.argv[1], sys.argv[2]
os.makedirs(d, exist_ok=True)
rnd = random.Random(7)
def w(p, s, x=False):
    full = os.path.join(d, p); os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full, "w").write(s)
    if x: os.chmod(full, 0o755)
if task == "build":
    warn = [f"src/mod{i % 23}/unit{i}.c:{10 + i % 90}:5: warning: unused variable 'tmp{i}' [-Wunused-variable]" for i in range(260)]
    warn.insert(201, "src/net/client.c:214:12: error: use of undeclared identifier 'retryBudget'")
    w("build.log", "\n".join(warn) + "\n1 error generated.\n")
    w("build.sh", "#!/bin/sh\ncat \"$(dirname \"$0\")/build.log\"\nexit 1\n", True)
    src = [f"/* line {i} */ int pad{i} = {i};" for i in range(1, 300)]
    src[213] = "  total += retryBudget * backoff_ms;"
    w("src/net/client.c", "\n".join(src) + "\n")
elif task == "correlate":
    api = [f"10:{i // 60:02d}:{i % 60:02d} api status=200 req=r{rnd.randrange(10**8):08d} path=/v1/items/{i}" for i in range(230)]
    api.insert(150, "10:02:30 api status=502 req=r40417733 path=/v1/checkout")
    w("api.log", "\n".join(api) + "\n")
    wk = [f"10:{i // 60:02d}:{i % 60:02d} worker job=job-{1000 + i} handled req=r{rnd.randrange(10**8):08d} ok" for i in range(230)]
    wk.insert(97, "10:02:31 worker job=job-5521 handled req=r40417733 timeout upstream")
    w("worker.log", "\n".join(wk) + "\n")
elif task == "fixrerun":
    w("src/calc.ts", "// pricing\nexport const DISCOUNT = 0; // percent\nexport const price = (p: number) => p * (100 - DISCOUNT) / 100;\n")
    w("test.sh", """#!/bin/sh
cd "$(dirname "$0")"
d=$(sed -n 's/^export const DISCOUNT = \\([0-9]*\\);.*/\\1/p' src/calc.ts)
i=0; pass=0
while [ $i -lt 300 ]; do
  if [ $i -eq 157 ] && [ "$d" != "10" ]; then echo "FAIL src/calc.test.ts > applies the 10 percent discount: expected 90, got $((100 - d))"; else echo "PASS src/case$i.test.ts > scenario $i holds"; pass=$((pass+1)); fi
  i=$((i+1))
done
echo "$pass passed, $((300 - pass)) failed"
""", True)
elif task == "deps":
    lic = ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC"]
    pk = [{"name": f"pkg-{i:03d}", "version": f"{rnd.randint(0,4)}.{rnd.randint(0,20)}.{rnd.randint(0,9)}", "license": rnd.choice(lic)} for i in range(160)]
    pk[118] = {"name": "ledger-math", "version": "5.2.0", "license": "GPL-3.0"}
    w("deps.json", json.dumps(pk, indent=2))
    for i in range(30):
        w(f"src/area{i}/index.ts", f"import {{ a }} from 'pkg-{i * 5:03d}';\nimport {{ b }} from 'pkg-{i * 5 + 1:03d}';\nexport const v{i} = a + b;\n")
    w("src/billing/invoice.ts", "import { round } from 'ledger-math';\nexport const total = (x: number) => round(x);\n")
