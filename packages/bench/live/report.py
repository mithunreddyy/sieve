#!/usr/bin/env python3 -I
"""Paired report. Primary metrics (fixed before any run): cost, final-turn context. Secondary: turns, correctness.
  report.py RESULTS.jsonl [--sieve OTHER.jsonl]   (--sieve: take the Sieve arm from another file, e.g. after tuning)"""
import json, sys, statistics, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
if "--sieve" in sys.argv:
    other = [json.loads(l) for l in open(sys.argv[sys.argv.index("--sieve") + 1])]
    rows = [r for r in rows if r["arm"] != "sieve"] + [r for r in other if r["arm"] == "sieve"]
errors = [r for r in rows if "error" in r]
rows = [r for r in rows if "error" not in r]
by = collections.defaultdict(lambda: collections.defaultdict(list))
for r in rows: by[r["task"]][r["arm"]].append(r)
mean = lambda xs: statistics.mean(xs) if xs else float("nan")
print(f"| task | n | cost base | cost Sieve | Δ cost | final ctx base | final ctx Sieve | Δ ctx | turns b/s | correct b/s |")
print("|---|---:|---:|---:|---:|---:|---:|---:|---|---|")
tot = collections.Counter()
for t, arms in sorted(by.items()):
    b, s = arms.get("baseline", []), arms.get("sieve", [])
    if not b or not s: continue
    cb, cs = mean([r["cost"] for r in b]), mean([r["cost"] for r in s])
    xb, xs = mean([r["final_ctx"] for r in b]), mean([r["final_ctx"] for r in s])
    tb, ts = mean([r["turns"] for r in b]), mean([r["turns"] for r in s])
    ob, os_ = sum(r["success"] for r in b), sum(r["success"] for r in s)
    tot["cb"] += cb; tot["cs"] += cs; tot["xb"] += xb; tot["xs"] += xs; tot["ob"] += ob; tot["os"] += os_; tot["nb"] += len(b); tot["ns"] += len(s)
    print(f"| {t} | {len(b)}/{len(s)} | ${cb:.4f} | ${cs:.4f} | {(cs / cb - 1) * 100:+.0f}% | {xb:,.0f} | {xs:,.0f} | {(xs / xb - 1) * 100:+.0f}% | {tb:.1f}/{ts:.1f} | {ob}/{len(b)} · {os_}/{len(s)} |")
if tot["cb"]:
    print(f"\n**All tasks (mean per task, summed):** cost {(tot['cs'] / tot['cb'] - 1) * 100:+.0f}%, final-turn context {(tot['xs'] / tot['xb'] - 1) * 100:+.0f}%, correct {tot['ob']}/{tot['nb']} without Sieve, {tot['os']}/{tot['ns']} with.")
if errors: print(f"\n{len(errors)} run(s) errored: " + ", ".join(e["id"] for e in errors))
# Why the Sieve arm took more turns: its tool sequences against the baseline's.
print("\nTool sequences (most common per task and arm):")
for t, arms in sorted(by.items()):
    for arm in ("baseline", "sieve"):
        c = collections.Counter(" → ".join(x.split(":")[0] for x in r["tools"]) for r in arms.get(arm, []))
        print(f"  {t:<10} {arm:<9} " + "; ".join(f"{k} ×{v}" for k, v in c.most_common(3)))
