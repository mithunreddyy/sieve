import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveKey,
  exportSession,
  GlobalStore,
  importSession,
  isSealed,
  newSalt,
  normaliseRemote,
  ProjectStore,
  packBundle,
  remoteOf,
  SyncFolder,
  seal,
  unpackBundle,
  unseal,
} from "../src/index.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(`/tmp/${p}`);
  cleanup.push(d);
  return d;
};

describe("sealing", () => {
  const salt = newSalt();
  test("round trip; the file is not the plaintext; a wrong key or one flipped bit is refused", () => {
    const key = deriveKey("correct horse battery", salt);
    const sealed = seal(Buffer.from("hello secret world"), key);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed.includes(Buffer.from("secret"))).toBe(false);
    expect(unseal(sealed, key).toString()).toBe("hello secret world");
    expect(() => unseal(sealed, deriveKey("another passphrase", salt))).toThrow(
      "wrong passphrase or damaged file",
    );
    const bad = Buffer.from(sealed);
    bad[bad.length - 1]! ^= 1;
    expect(() => unseal(bad, key)).toThrow("wrong passphrase or damaged file");
    expect(() => unseal(Buffer.from("plain text, not sealed"), key)).toThrow("not a Sieve encrypted file");
  });

  test("every file gets its own nonce, and short passphrases are refused", () => {
    const key = deriveKey("correct horse battery", salt);
    expect(seal(Buffer.from("x"), key).equals(seal(Buffer.from("x"), key))).toBe(false);
    expect(() => deriveKey("short", salt)).toThrow("at least 8 characters");
  });
});

describe("git remotes", () => {
  test("every common spelling of one repository gives one name", () => {
    for (const u of [
      "git@github.com:Acme/widgets.git",
      "https://github.com/acme/widgets.git",
      "https://user:tok@github.com/acme/widgets",
      "ssh://git@github.com:22/acme/widgets.git",
      "git://github.com/acme/widgets/",
    ])
      expect([u, normaliseRemote(u)?.toLowerCase()]).toEqual([u, "github.com/acme/widgets"]);
    expect(normaliseRemote("not a url")).toBeNull();
  });

  test("read from .git/config without running git", () => {
    const d = tmp("sv-rem-");
    mkdirSync(join(d, ".git"));
    writeFileSync(
      join(d, ".git", "config"),
      '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
    );
    expect(remoteOf(d)).toBe("github.com/acme/widgets");
    expect(remoteOf(tmp("sv-rem-"))).toBeNull();
  });
});

function projectWith(root: string, home: string) {
  process.env.SIEVE_HOME = home;
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(
    join(root, ".git", "config"),
    '[remote "origin"]\n\turl = https://github.com/acme/widgets.git\n',
  );
  const ref = { key: `k${root.length}${home.length}`, root, name: "widgets", worktree: root };
  const gs = new GlobalStore();
  gs.touchProject(ref);
  const store = new ProjectStore(ref);
  return { ref, gs, store };
}

describe("a session moving between machines", () => {
  function recorded(store: ProjectStore, ref: { worktree: string }) {
    store.touchSession("sess-1", "claude-code", ref.worktree, 1000);
    const big = store.put("detail line\n".repeat(200), {
      sessionId: "sess-1",
      worktree: ref.worktree,
      sourceKind: "tool",
      source: "Bash: bun test",
      at: 1100,
    });
    store.log.append("sess-1", {
      kind: "prompt",
      context: "main",
      worktree: ref.worktree,
      summary: "fix the limiter",
      key: "request",
      at: 1200,
      detailId: big.id,
    });
    store.log.append("sess-1", {
      kind: "command",
      context: "main",
      worktree: ref.worktree,
      summary: "bun test failed",
      at: 1300,
    });
    store.log.decide(ref.worktree, {
      topic: "storage",
      label: "storage",
      text: "Redis",
      sessionId: "sess-1",
      seq: 2,
      at: 1400,
    });
    store.db.run("UPDATE sessions SET ended_at = 2000 WHERE id = 'sess-1'");
    return big.id;
  }

  test("export then import elsewhere keeps the log, the archived output and the decision", () => {
    const a = projectWith(tmp("sv-a-"), tmp("sv-ha-"));
    const id = recorded(a.store, a.ref);
    const { bundle } = exportSession(a.store, "sess-1", { remote: "github.com/acme/widgets", now: 5 });
    expect(bundle.archive.map((x) => x.id)).toEqual([id]);
    const file = packBundle(bundle);

    const b = projectWith(tmp("sv-b-"), tmp("sv-hb-"));
    const r = importSession(b.store, b.ref.worktree, unpackBundle(file));
    expect(r).toEqual({ sessionId: "sess-1", rows: 2, items: 1, newItems: 1 });
    const rows = b.store.db
      .query("SELECT summary, worktree, detail_archive_id AS d FROM session_log ORDER BY seq")
      .all() as Array<{ summary: string; worktree: string; d: string | null }>;
    expect(rows.map((x) => x.summary)).toEqual(["fix the limiter", "bun test failed"]);
    expect(rows.every((x) => x.worktree === b.ref.worktree)).toBe(true); // rewritten to this checkout
    expect(rows[0]!.d).toBe(id);
    expect(b.store.get(id)?.text).toBe("detail line\n".repeat(200));
    expect(b.store.log.decisions(b.ref.worktree).map((d) => d.text)).toEqual(["Redis"]);
    a.store.db.close();
    b.store.db.close();
    a.gs.close();
    b.gs.close();
  });

  test("importing the same session twice is refused unless given another id", () => {
    const a = projectWith(tmp("sv-a-"), tmp("sv-ha-"));
    recorded(a.store, a.ref);
    const bundle = unpackBundle(packBundle(exportSession(a.store, "sess-1").bundle));
    expect(() => importSession(a.store, a.ref.worktree, bundle)).toThrow("already exists");
    expect(importSession(a.store, a.ref.worktree, bundle, { as: "sess-1-copy" }).sessionId).toBe(
      "sess-1-copy",
    );
    a.store.db.close();
    a.gs.close();
  });

  test("a bundle of the wrong shape, or with an unknown field, is rejected before anything is written", () => {
    const a = projectWith(tmp("sv-a-"), tmp("sv-ha-"));
    recorded(a.store, a.ref);
    const good = JSON.parse(JSON.stringify(exportSession(a.store, "sess-1").bundle)) as Record<
      string,
      unknown
    >;
    const b = projectWith(tmp("sv-b-"), tmp("sv-hb-"));
    expect(() => importSession(b.store, b.ref.worktree, { ...good, evil: 1 })).toThrow();
    expect(() => importSession(b.store, b.ref.worktree, { ...good, format: "other" })).toThrow();
    expect(() =>
      importSession(b.store, b.ref.worktree, { ...good, log: [{ seq: 1, kind: "drop table" }] }),
    ).toThrow();
    expect(b.store.db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    a.store.db.close();
    b.store.db.close();
    a.gs.close();
    b.gs.close();
  });

  test("a bundle holds no raw secrets: what was masked before storage stays masked", () => {
    const a = projectWith(tmp("sv-a-"), tmp("sv-ha-"));
    a.store.touchSession("s2", "claude-code", a.ref.worktree, 1);
    const secret = `${"sk"}_live_${"Ab12Cd34Ef56Gh78"}`;
    a.store.put(`token ${secret} in output\n`.repeat(30), {
      sessionId: "s2",
      worktree: a.ref.worktree,
      sourceKind: "tool",
      source: "Bash",
      at: 2,
    });
    const json = JSON.stringify(exportSession(a.store, "s2").bundle);
    const items = (JSON.parse(json) as { archive: { gz: string }[] }).archive;
    const text = items
      .map((i) => require("node:zlib").gunzipSync(Buffer.from(i.gz, "base64")).toString())
      .join("");
    expect(text).not.toContain(secret);
    expect(text).toContain("<secret:");
    a.store.db.close();
    a.gs.close();
  });
});

describe("encrypted sync between two machines", () => {
  const PASS = "a long enough passphrase";

  test("facts and finished sessions flow both ways; the folder holds only ciphertext", () => {
    const folder = tmp("sv-sync-");
    // machine A
    const a = projectWith(tmp("sv-a-"), tmp("sv-ha-"));
    const homeA = process.env.SIEVE_HOME as string;
    a.gs.memory.remember(
      { subject: "api", predicate: "database", object: "postgres", scope: "repo", writer: "user", at: 100 },
      { key: a.ref.key, root: a.ref.root, worktree: a.ref.worktree },
    );
    a.gs.memory.remember(
      {
        subject: "me",
        predicate: "prefers",
        object: "short answers",
        scope: "everywhere",
        writer: "user",
        at: 101,
      },
      { key: a.ref.key, root: a.ref.root, worktree: a.ref.worktree },
    );
    a.gs.memory.remember(
      { subject: "api", predicate: "note", object: "local only", scope: "worktree", writer: "user", at: 102 },
      { key: a.ref.key, root: a.ref.root, worktree: a.ref.worktree },
    );
    a.store.touchSession("sa", "claude-code", a.ref.worktree, 10);
    a.store.log.append("sa", {
      kind: "prompt",
      context: "main",
      worktree: a.ref.worktree,
      summary: "do the thing",
      key: "request",
      at: 11,
    });
    a.store.db.run("UPDATE sessions SET ended_at = 20 WHERE id = 'sa'");
    a.store.db.close();
    const sa = SyncFolder.open(folder, PASS, "aaaa", true);
    const pushed = sa.push(a.gs, 1_000_000);
    expect(pushed).toMatchObject({ pushedFacts: 2, skippedFacts: 1, pushedSessions: 1 });
    a.gs.close();

    // the synced folder has no readable content
    const dump = readdirSync(join(folder, "sieve-sync"))
      .map((f) => readFileSync(join(folder, "sieve-sync", f)).toString("latin1"))
      .join("");
    for (const word of ["postgres", "short answers", "do the thing", "widgets"])
      expect(dump).not.toContain(word);

    // machine B: a different checkout path, the same git remote
    const b = projectWith(tmp("sv-b-"), tmp("sv-hb-"));
    const sb = SyncFolder.open(folder, PASS, "bbbb");
    const pulled = sb.pull(b.gs, 1_000_001);
    expect(pulled).toMatchObject({ pulledFacts: 2, pulledSessions: 1, unreadable: [] });
    const where = { key: b.ref.key, root: b.ref.root, worktree: b.ref.worktree };
    expect(
      b.gs.memory
        .active(where)
        .map((f) => `${f.subject} ${f.predicate} ${f.object} [${f.scope}] ${f.writer}`)
        .sort(),
    ).toEqual([
      "api database postgres [repo] sync".replace("database", "database"),
      "me prefers short answers [everywhere] sync",
    ]);
    const s = new ProjectStore(b.ref);
    expect(
      (s.db.query("SELECT summary FROM session_log WHERE session_id = 'sa'").get() as { summary: string })
        .summary,
    ).toBe("do the thing");
    s.db.close();

    // pulling again changes nothing
    expect(sb.pull(b.gs, 1_000_002)).toMatchObject({ pulledFacts: 0, pulledSessions: 0, closedFacts: 0 });

    // B retracts the fact; after B pushes and A pulls, A's copy is closed too
    const f = b.gs.memory.active(where).find((x) => x.predicate === "database")!;
    b.gs.memory.retractId(f.id, 500);
    sb.push(b.gs, 1_000_003);
    b.gs.close();
    process.env.SIEVE_HOME = homeA;
    const a2 = new GlobalStore();
    const back = SyncFolder.open(folder, PASS, "aaaa").pull(a2, 1_000_004);
    expect(back.closedFacts).toBe(1);
    const whereA = { key: a.ref.key, root: a.ref.root, worktree: a.ref.worktree };
    expect(a2.memory.active(whereA).map((x) => x.predicate)).not.toContain("database");
    a2.close();
  });

  test("a wrong passphrase is caught at the door, and a damaged file is reported, not trusted", () => {
    const folder = tmp("sv-sync-");
    SyncFolder.open(folder, PASS, "aaaa", true);
    expect(() => SyncFolder.open(folder, "not the right one!", "bbbb")).toThrow(
      "wrong passphrase for this sync folder",
    );
    expect(() => SyncFolder.open(tmp("sv-sync-"), PASS, "bbbb")).toThrow("not a Sieve sync folder yet");
    const h = projectWith(tmp("sv-a-"), tmp("sv-ha-"));
    const s = SyncFolder.open(folder, PASS, "aaaa");
    s.push(h.gs, 1);
    const f = join(folder, "sieve-sync", "memory-aaaa.sieve");
    const bytes = readFileSync(f);
    bytes[bytes.length - 3]! ^= 0xff;
    writeFileSync(f, bytes);
    const rep = SyncFolder.open(folder, PASS, "bbbb").pull(h.gs, 2);
    expect(rep.unreadable[0]).toContain("wrong passphrase or damaged file");
    expect(rep.pulledFacts).toBe(0);
    h.store.db.close();
    h.gs.close();
  });

  test("a repo that is not cloned on this machine is skipped with a note, not guessed", () => {
    const folder = tmp("sv-sync-");
    const a = projectWith(tmp("sv-a-"), tmp("sv-ha-"));
    a.gs.memory.remember(
      { subject: "api", predicate: "database", object: "postgres", scope: "repo", writer: "user", at: 1 },
      { key: a.ref.key, root: a.ref.root, worktree: a.ref.worktree },
    );
    SyncFolder.open(folder, PASS, "aaaa", true).push(a.gs, 1);
    a.store.db.close();
    a.gs.close();
    process.env.SIEVE_HOME = tmp("sv-hc-");
    const c = new GlobalStore(); // knows no projects
    const rep = SyncFolder.open(folder, PASS, "cccc").pull(c, 2);
    expect(rep.pulledFacts).toBe(0);
    expect(rep.notes.join(" ")).toContain("not cloned on this machine");
    c.close();
  });
});
