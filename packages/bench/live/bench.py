#!/usr/bin/env python3 -I
"""Paired live benchmark: the same tasks with and without Sieve, in a neutral Claude Code environment
(the user's other plugins disabled for these runs only). Records, per run: cost, the final turn's
context size, turns, correctness, and the tool-call sequence.

  bench.py --set dev|heldout --arms baseline,sieve --reps 5 --model haiku --parallel 4 --out FILE
"""
import argparse, json, os, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

S = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(S, "..", "..", ".."))  # the repository root (this file is packages/bench/live/bench.py)
SETS = {"dev": ("make.py", "tasks.json"), "heldout": ("make_heldout.py", "tasks_heldout.json")}

ap = argparse.ArgumentParser()
ap.add_argument("--set", default="dev")
ap.add_argument("--arms", default="baseline,sieve")
ap.add_argument("--reps", type=int, default=5)
ap.add_argument("--model", default="haiku")
ap.add_argument("--parallel", type=int, default=4)
ap.add_argument("--tasks", default="")
ap.add_argument("--out", required=True)
a = ap.parse_args()

maker, tasks_file = SETS[a.set]
tasks = json.load(open(os.path.join(S, tasks_file)))
if a.tasks: tasks = {k: v for k, v in tasks.items() if k in a.tasks.split(",")}

# Neutral environment: every plugin the user has enabled is turned off for these runs only.
user = json.load(open(os.path.expanduser("~/.claude/settings.json")))
os.makedirs("/tmp/svb", exist_ok=True)
neutral = "/tmp/svb/neutral.json"  # written fresh each run from your own settings
json.dump({"enabledPlugins": {k: False for k, v in (user.get("enabledPlugins") or {}).items() if v}}, open(neutral, "w"))

def one(job):
    task, arm, rep = job
    rid = f"{a.set}-{task}-{arm}-{rep}"
    base = f"/tmp/svb/{rid}"
    proj, home = f"{base}/p", f"{base}/h"
    shutil.rmtree(base, ignore_errors=True); os.makedirs(home)
    subprocess.run([sys.executable, os.path.join(S, maker), task, proj], check=True)
    subprocess.run(["git", "init", "-q", proj], check=True)  # same for every arm
    env = dict(os.environ, SIEVE_HOME=home)
    cmd = ["claude", "-p", tasks[task]["prompt"], "--model", a.model, "--strict-mcp-config", "--settings", neutral,
           "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--max-budget-usd", "0.5"]
    tools = "Bash,Read,Grep,Glob,Edit"
    if arm == "sieve":
        mcp = f"{base}/mcp.json"
        json.dump({"mcpServers": {"sieve": {"type": "stdio", "command": f"{REPO}/dist/sieve", "args": ["mcp"],
                   "env": {"SIEVE_HOME": home, "SIEVE_BIN": f"{REPO}/dist/sieve"}}}}, open(mcp, "w"))
        cmd += ["--mcp-config", mcp]
        tools += ",mcp__sieve__sieve_get,mcp__sieve__sieve_search"
        env.update(SIEVE_BIN=f"{REPO}/dist/sieve", SIEVE_HOOK_TIMEOUT_MS="3000")
    else:
        env.update(SIEVE_BIN="/nonexistent")
    cmd += ["--allowedTools", tools]
    p = subprocess.run(cmd, cwd=proj, env=env, capture_output=True, text=True, timeout=600)
    if arm == "sieve":
        subprocess.run([f"{REPO}/dist/sieve", "daemon", "stop"], env=env, capture_output=True)
    seq, last_ctx, result = [], 0, None
    for line in p.stdout.splitlines():
        try: e = json.loads(line)
        except Exception: continue
        m = e.get("message") or {}
        if e.get("type") == "assistant":
            u = m.get("usage") or {}
            last_ctx = u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            for x in m.get("content") or []:
                if x.get("type") == "tool_use":
                    inp = x.get("input") or {}
                    seq.append(f"{x['name']}:{(inp.get('command') or inp.get('file_path') or inp.get('pattern') or inp.get('id') or inp.get('query') or '')}"[:90])
        if e.get("type") == "result": result = e
    if not result:
        return {"id": rid, "task": task, "arm": arm, "rep": rep, "error": (p.stderr or p.stdout)[-300:]}
    u = result.get("usage", {}); res = result.get("result") or ""
    return {"id": rid, "set": a.set, "task": task, "arm": arm, "rep": rep, "model": a.model,
            "success": all(c in res for c in tasks[task]["check"]), "cost": result.get("total_cost_usd"),
            "turns": result.get("num_turns"), "final_ctx": last_ctx,
            "uncached": u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0),
            "cache_read": u.get("cache_read_input_tokens", 0), "output": u.get("output_tokens", 0),
            "tools": seq, "answer": res[:200]}

jobs = [(t, arm, r) for r in range(a.reps) for t in tasks for arm in a.arms.split(",")]
with open(a.out, "w") as f, ThreadPoolExecutor(a.parallel) as ex:
    for row in ex.map(one, jobs):
        f.write(json.dumps(row) + "\n"); f.flush()
        print(row["id"], "ok" if row.get("success") else ("ERROR" if "error" in row else "WRONG"), file=sys.stderr)
print("ALL-DONE", file=sys.stderr)
