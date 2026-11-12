# Builds one fresh task project. Deterministic content; every task has one checkable answer.
import os, sys, json, random
task, d = sys.argv[1], sys.argv[2]
os.makedirs(d, exist_ok=True)
rnd = random.Random(42)
def w(p, s, x=False):
    os.makedirs(os.path.dirname(os.path.join(d, p)) or d, exist_ok=True)
    open(os.path.join(d, p), "w").write(s)
    if x: os.chmod(os.path.join(d, p), 0o755)
if task == "tests":   # ~14 KB of test output, one failure in the middle
    lines = []
    for i in range(320):
        if i == 171: lines.append("FAIL src/auth/token.test.ts > rejects an expired token: expected status 401, received 200")
        else: lines.append(f"PASS src/module{i % 37}/case{i}.test.ts > handles input variant {i} ({rnd.randint(2,90)} ms)")
    w("out.txt", "\n".join(lines) + "\n")
    w("run-tests.sh", "#!/bin/sh\ncat \"$(dirname \"$0\")/out.txt\"\n", True)
elif task == "grep":  # ~16 KB of grep matches, one definition among the uses
    for f in range(12):
        body = [f"import {{ rateLimitWindow }} from '../limits';" ]
        for k in range(7): body.append(f"const v{k} = rateLimitWindow(req{k}, {k * 3}); // rateLimitWindow use {f}-{k}")
        w(f"src/feature{f}/handler.ts", "\n".join(body) + "\n")
    w("src/core/windows.ts", "export function rateLimitWindow(req: Request, ms: number) {\n  return Math.max(ms, 1);\n}\n")
elif task == "log":   # ~20 KB server log, one 500
    lines = []
    for i in range(260):
        if i == 197: lines.append("2026-11-12T10:14:07Z ERROR status=500 path=/api/orders req=req-7f3a91 msg=\"upstream timeout\"")
        else: lines.append(f"2026-11-12T10:{10 + i // 60:02d}:{i % 60:02d}Z INFO status=200 path=/api/items/{i} req=req-{rnd.randrange(16**6):06x} ms={rnd.randint(3,120)}")
    w("server.log", "\n".join(lines) + "\n")
elif task == "json":  # ~18 KB JSON array, one record asked for
    users = [{"id": i, "name": f"user{i}", "email": f"user{i}@example.org", "role": "member"} for i in range(1, 181)]
    users[136]["email"] = "maria.k.137@corp.example.com"
    w("users.json", json.dumps(users, indent=2))
    w("api.sh", "#!/bin/sh\ncat \"$(dirname \"$0\")/users.json\"\n", True)

elif task == "config":  # ~16 KB env dump, one value asked for in plain words
    lines = [f"SERVICE_{i}_TIMEOUT_MS={1000 + i}" for i in range(520)]
    lines.insert(311, "PAYMENTS_SERVICE_PORT=8443")
    w("settings.conf", "\n".join(lines) + "\n")
elif task == "migrate":  # ~22 KB migration log, one failure named by its id
    lines = [f"2026-11-12T09:{i % 60:02d}:00Z migrate: applied 2026{i:04d}_step ok" for i in range(380)]
    lines.insert(290, "2026-11-12T09:41:00Z migrate: 20261112_add_index FAILED: duplicate key value violates unique constraint orders_ref_key")
    w("migrate.log", "\n".join(lines) + "\n")
