import type { ExtractInput, Extraction, Extractor } from "./types.ts";
import {
  cmdMatches,
  collapseLibraryFrames,
  compact,
  foldLines,
  LIB_PATH,
  lines,
  plural,
  share,
  squeezeBlank,
} from "./util.ts";

/**
 * Test runners. Rule for all of them: counts stay, every failure stays verbatim (message,
 * assertion diff, project frames); passing tests collapse into counted lines and runs of
 * library frames collapse into one line.
 */

function finish(id: string, out: string[], dropped: Array<string | false>, failures: boolean): Extraction {
  return {
    extractor: id,
    body: squeezeBlank(out).join("\n"),
    dropped: compact(dropped),
    keptVerbatim: failures,
  };
}

// ---------------------------------------------------------------- vitest
export const vitest: Extractor = {
  id: "vitest",
  detect: ({ command, text }) =>
    cmdMatches(command, /\bvitest\b/)
      ? 95
      : /^\s+Test Files\s+.*\(\d+\)$/m.test(text) && /^\s+Tests\s+/m.test(text)
        ? 85
        : 0,
  extract({ text }) {
    let ls = lines(text);
    const passFile = /^\s*✓\s.*\(\d+ tests?\)/;
    const isPass = (l: string) => /^\s*✓\s/.test(l);
    const files = ls.filter((l) => passFile.test(l)).length;
    const f = foldLines(ls, isPass, (n) =>
      files === n ? ` ✓ ${plural(n, "passing test file")}` : ` ✓ ${plural(n, "passing test")}`,
    );
    ls = f.out;
    const skipped = foldLines(
      ls,
      (l) => /^\s*↓\s/.test(l),
      (n) => ` ↓ ${plural(n, "skipped test")}`,
    );
    const fr = collapseLibraryFrames(skipped.out);
    const failed = ls.some((l) => /^\s*FAIL\s/.test(l) || /^\s*×\s/.test(l));
    return finish(
      "vitest",
      fr.out,
      [
        f.n > 0 && (files === f.n ? plural(f.n, "passing test file") : plural(f.n, "passing test")),
        skipped.n > 0 && plural(skipped.n, "skipped test"),
        fr.frames > 0 && plural(fr.frames, "library frame"),
      ],
      failed,
    );
  },
};

// ---------------------------------------------------------------- jest
export const jest: Extractor = {
  id: "jest",
  detect: ({ command, text }) =>
    cmdMatches(command, /\bjest\b/)
      ? 95
      : /^Test Suites: .*\d+ total$/m.test(text) && /^Tests: /m.test(text)
        ? 85
        : 0,
  extract({ text }) {
    const ls = lines(text);
    const out: string[] = [];
    let passSuites = 0;
    let passTests = 0;
    let summaryLines = 0;
    let sawFailure = false;
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i]!;
      if (/^PASS\s/.test(l)) {
        passSuites++;
        // Verbose mode lists the suite's tests indented under it; they all passed.
        while (i + 1 < ls.length && /^\s+\S/.test(ls[i + 1]!)) {
          i++;
          if (/✓/.test(ls[i]!)) passTests++;
        }
        continue;
      }
      if (/^\s+●\s/.test(l)) sawFailure = true;
      if (sawFailure && /^Summary of all failing tests$/.test(l)) {
        // Jest repeats every failure here; they are already shown above.
        while (i + 1 < ls.length && !/^Test Suites:/.test(ls[i + 1]!)) {
          i++;
          summaryLines++;
        }
        continue;
      }
      if (/^\s+✓\s/.test(l)) {
        passTests++;
        continue;
      }
      out.push(l);
    }
    if (passSuites)
      out.unshift(
        `PASS ${plural(passSuites, "suite")}${passTests ? ` (${plural(passTests, "passing test")} listed)` : ""}`,
      );
    const fr = collapseLibraryFrames(out);
    return finish(
      "jest",
      fr.out,
      [
        passSuites > 0 && plural(passSuites, "passing suite"),
        passTests > 0 && plural(passTests, "passing test line"),
        summaryLines > 0 && `the repeated failure summary (${plural(summaryLines, "line")})`,
        fr.frames > 0 && plural(fr.frames, "library frame"),
      ],
      sawFailure,
    );
  },
};

// ---------------------------------------------------------------- bun test
export const bunTest: Extractor = {
  id: "bun-test",
  detect: ({ command, text }) =>
    cmdMatches(command, /\bbun\s+test\b/)
      ? 95
      : /^Ran \d+ tests? across \d+ files?\./m.test(text) && /^\s*\d+ pass$/m.test(text)
        ? 85
        : 0,
  extract({ text }) {
    let ls = lines(text);
    const p = foldLines(
      ls,
      (l) => /^\(pass\) /.test(l),
      (n) => `(pass) ${plural(n, "passing test")}`,
    );
    const s = foldLines(
      p.out,
      (l) => /^\((skip|todo)\) /.test(l),
      (n) => `(skip) ${plural(n, "skipped test")}`,
    );
    ls = s.out;
    // A file header whose tests all passed is now followed by nothing of its own.
    const header = /^\S.*\.(test|spec|_test|_spec)\.[cm]?[jt]sx?:$/;
    const kept = ls.filter(
      (l, i) =>
        !(
          header.test(l) &&
          (i + 1 >= ls.length ||
            header.test(ls[i + 1]!) ||
            !ls[i + 1]!.trim() ||
            /^\((pass|skip)\) \d/.test(ls[i + 1]!))
        ),
    );
    const fr = collapseLibraryFrames(kept);
    return finish(
      "bun-test",
      fr.out,
      [
        p.n > 0 && plural(p.n, "passing test"),
        s.n > 0 && plural(s.n, "skipped test"),
        ls.length - kept.length > 0 && plural(ls.length - kept.length, "file header"),
        fr.frames > 0 && plural(fr.frames, "library frame"),
      ],
      /^\(fail\) /m.test(text),
    );
  },
};

// ---------------------------------------------------------------- pytest
const PY_LIB_LOC = (l: string) => /^\S+:\d+: /.test(l) && LIB_PATH.test(l.split(":")[0]!);
export const pytest: Extractor = {
  id: "pytest",
  detect: ({ command, text }) =>
    cmdMatches(command, /\b(py\.?test|python3? -m pytest)\b/)
      ? 95
      : /^=+ test session starts =+$/m.test(text)
        ? 90
        : 0,
  extract({ text }) {
    const ls = lines(text);
    const progress = /^(\S+\.py) ([.sxX]+)\s+\[\s*\d+%\]$/;
    const verbosePass = /^\S+::.* (PASSED|SKIPPED|XFAIL|XPASS)\s+\[\s*\d+%\]$/;
    let dots = 0;
    let progressLines = 0;
    let verbose = 0;
    let libLines = 0;
    let frames = 0;
    const out: string[] = [];
    let inFailures = false;
    let segment: string[] = [];
    const flushSegment = () => {
      if (!segment.length) return;
      const last = [...segment].reverse().find((l) => l.trim());
      if (last && PY_LIB_LOC(last)) {
        // A traceback entry inside a library: keep its location and the E lines, drop the source listing.
        const keep = segment.filter((l) => /^E\s/.test(l) || /^>\s/.test(l) || l === last);
        libLines += segment.filter((l) => l.trim()).length - keep.length;
        out.push(`    … library source omitted (${last.split(":").slice(0, 2).join(":")})`, ...keep);
      } else {
        // Pairs of "lib/…:N: in fn" + code line are library frames.
        const merged: string[] = [];
        for (let i = 0; i < segment.length; i++) {
          const l = segment[i]!;
          if (PY_LIB_LOC(l) && / in \S+$/.test(l)) {
            let j = i;
            let run = 0;
            while (j < segment.length && PY_LIB_LOC(segment[j]!) && / in \S+$/.test(segment[j]!)) {
              j++;
              while (j < segment.length && /^\s{4}\S/.test(segment[j]!)) j++;
              run++;
            }
            if (run >= 2) {
              merged.push(`… ${plural(run, "library frame")}`);
              frames += run;
              i = j - 1;
              continue;
            }
          }
          merged.push(l);
        }
        out.push(...merged);
      }
      segment = [];
    };
    for (const l of ls) {
      if (/^=+ (FAILURES|ERRORS) =+$/.test(l)) {
        inFailures = true;
        out.push(l);
        continue;
      }
      if (inFailures) {
        if (/^=+ .* =+$/.test(l) || /^_{3,} .* _{3,}$/.test(l) || /^(_ ){5,}_?\s*$/.test(l)) {
          flushSegment();
          if (/^=+ .* =+$/.test(l) && !/^=+ (FAILURES|ERRORS) =+$/.test(l)) inFailures = false;
          out.push(l);
          continue;
        }
        segment.push(l);
        continue;
      }
      const m = progress.exec(l);
      if (m) {
        dots += m[2]!.length;
        progressLines++;
        continue;
      }
      if (verbosePass.test(l)) {
        verbose++;
        continue;
      }
      out.push(l);
    }
    flushSegment();
    if (progressLines) {
      const at = out.findIndex((l) => /^collected \d+ items?/.test(l));
      out.splice(
        at === -1 ? 0 : at + 1,
        0,
        "",
        `${plural(dots, "test")} passed or skipped in ${plural(progressLines, "file")} (progress lines without F/E)`,
      );
    }
    if (verbose) {
      const at = out.findIndex((l) => /^collected \d+ items?/.test(l));
      out.splice(at === -1 ? 0 : at + 1, 0, "", `${plural(verbose, "test")} PASSED/SKIPPED (lines omitted)`);
    }
    return finish(
      "pytest",
      out,
      [
        progressLines > 0 && plural(progressLines, "all-passing progress line"),
        verbose > 0 && plural(verbose, "passing test line"),
        libLines > 0 && `${plural(libLines, "line")} of library source`,
        frames > 0 && plural(frames, "library frame"),
      ],
      /^(FAILED|ERROR) /m.test(text) || /^=+ (FAILURES|ERRORS) =+$/m.test(text),
    );
  },
};

// ---------------------------------------------------------------- go test
export const goTest: Extractor = {
  id: "go-test",
  detect: ({ command, text }) =>
    cmdMatches(command, /\bgo\s+test\b/)
      ? 95
      : share(lines(text), /^(=== (RUN|PAUSE|CONT)|\s*--- (PASS|FAIL|SKIP):|ok\s+\S+\s|FAIL\s+\S+\s)/) >
            0.3 ||
          (/^--- FAIL: \S+ \([\d.]+s\)$/m.test(text) && /^(FAIL|ok)\s+\S+\s+[\d.]+s$/m.test(text))
        ? 85
        : 0,
  extract({ text }) {
    let ls = lines(text);
    const run = foldLines(
      ls,
      (l) => /^=== (RUN|PAUSE|CONT|NAME)\s/.test(l),
      (n) => `=== ${plural(n, "RUN/PAUSE/CONT line")} omitted`,
    );
    const pass = foldLines(
      run.out,
      (l) => /^\s*--- (PASS|SKIP): /.test(l),
      (n) => `--- ${plural(n, "passing or skipped test")}`,
    );
    const ok = foldLines(
      pass.out,
      (l) => /^(ok|\?)\s+\S+/.test(l),
      (n) => `ok ${plural(n, "package")} passed or had no tests`,
    );
    ls = ok.out.filter((l) => l !== "PASS");
    const fr = collapseLibraryFrames(ls);
    return finish(
      "go-test",
      fr.out,
      [
        run.n > 0 && plural(run.n, "RUN line"),
        pass.n > 0 && plural(pass.n, "passing test"),
        ok.n > 0 && plural(ok.n, "passing package"),
        fr.frames > 0 && plural(fr.frames, "runtime frame"),
      ],
      /^\s*--- FAIL|^FAIL\b|^panic:/m.test(text),
    );
  },
};

// ---------------------------------------------------------------- cargo test
export const cargoTest: Extractor = {
  id: "cargo-test",
  detect: ({ command, text }) =>
    cmdMatches(command, /\bcargo\s+(test|nextest)\b/)
      ? 95
      : /^test result: (ok|FAILED)\./m.test(text)
        ? 90
        : 0,
  extract({ text }) {
    const ok = foldLines(
      lines(text),
      (l) => /^test .+ \.\.\. ok$/.test(l),
      (n) => `test … ${plural(n, "passing test")}`,
    );
    const ign = foldLines(
      ok.out,
      (l) => /^test .+ \.\.\. ignored/.test(l),
      (n) => `test … ${plural(n, "ignored test")}`,
    );
    const comp = foldLines(
      ign.out,
      (l) => /^\s+(Compiling|Downloaded|Downloading|Fresh|Checking) /.test(l),
      (n) => `   ${plural(n, "crate")} compiled`,
    );
    const fr = collapseLibraryFrames(comp.out);
    return finish(
      "cargo-test",
      fr.out,
      [
        ok.n > 0 && plural(ok.n, "passing test"),
        ign.n > 0 && plural(ign.n, "ignored test"),
        comp.n > 0 && plural(comp.n, "Compiling line"),
        fr.frames > 0 && plural(fr.frames, "library frame"),
      ],
      /\.\.\. FAILED$/m.test(text),
    );
  },
};

// ---------------------------------------------------------------- rspec
export const rspec: Extractor = {
  id: "rspec",
  detect: ({ command, text }) =>
    cmdMatches(command, /\brspec\b/) ? 95 : /^\d+ examples?, \d+ failures?/m.test(text) ? 90 : 0,
  extract({ text }) {
    let progress = 0;
    const out = lines(text).map((l) => {
      if (/^[.F*E]{20,}$/.test(l)) {
        progress += l.length;
        const f = (l.match(/[FE]/g) ?? []).length;
        return `(progress: ${plural(l.length, "example")}, ${f} failed or errored)`;
      }
      return l;
    });
    const fr = collapseLibraryFrames(out);
    return finish(
      "rspec",
      fr.out,
      [
        progress > 0 && `${plural(progress, "progress character")}`,
        fr.frames > 0 && plural(fr.frames, "gem frame"),
      ],
      /^\s+\d+\) /m.test(text),
    );
  },
};

// ---------------------------------------------------------------- playwright
export const playwright: Extractor = {
  id: "playwright",
  detect: ({ command, text }) =>
    cmdMatches(command, /\bplaywright\s+test\b/)
      ? 95
      : /^Running \d+ tests? using \d+ workers?/m.test(text)
        ? 85
        : 0,
  extract({ text }) {
    const p = foldLines(
      lines(text),
      (l) => /^\s+✓\s+\d+\s/.test(l),
      (n) => `  ✓ ${plural(n, "passing test")}`,
    );
    const s = foldLines(
      p.out,
      (l) => /^\s+-\s+\d+\s/.test(l),
      (n) => `  - ${plural(n, "skipped test")}`,
    );
    const fr = collapseLibraryFrames(s.out);
    return finish(
      "playwright",
      fr.out,
      [
        p.n > 0 && plural(p.n, "passing test"),
        s.n > 0 && plural(s.n, "skipped test"),
        fr.frames > 0 && plural(fr.frames, "library frame"),
      ],
      /^\s+✘\s/m.test(text),
    );
  },
};

// ---------------------------------------------------------------- JUnit XML
const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const attrs = (s: string) =>
  Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1]!, decode(m[2]!)]));

export const junit: Extractor = {
  id: "junit",
  detect: ({ text }) => (/^\s*(<\?xml[^>]*>\s*)?<testsuites?\b/.test(text.slice(0, 500)) ? 95 : 0),
  extract({ text }) {
    const out: string[] = [];
    for (const s of text.matchAll(/<testsuite\b([^>]*)>/g)) {
      const a = attrs(s[1]!);
      out.push(
        `suite ${a.name ?? "?"}: ${a.tests ?? "?"} tests, ${a.failures ?? 0} failures, ${a.errors ?? 0} errors, ${a.skipped ?? 0} skipped${a.time ? `, ${a.time}s` : ""}`,
      );
    }
    let passed = 0;
    let skipped = 0;
    let failed = 0;
    for (const m of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const a = attrs(m[1]!);
      const inner = m[2] ?? "";
      const bad = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(inner);
      if (!bad) {
        if (/<skipped\b/.test(inner)) skipped++;
        else passed++;
        continue;
      }
      failed++;
      const fa = attrs(bad[2]!);
      out.push(
        "",
        `${bad[1]!.toUpperCase()} ${a.classname ? `${a.classname}::` : ""}${a.name ?? "?"}${a.file ? ` (${a.file})` : ""}`,
      );
      if (fa.message) out.push(`  message: ${fa.message}`);
      if (fa.type) out.push(`  type: ${fa.type}`);
      if (bad[3]?.trim())
        out.push(
          ...decode(bad[3])
            .replace(/^<!\[CDATA\[|\]\]>$/g, "")
            .split("\n")
            .map((l) => `  ${l}`),
        );
      const so = /<system-(out|err)>([\s\S]*?)<\/system-\1>/.exec(inner);
      if (so?.[2]?.trim())
        out.push(
          `  system-${so[1]}:`,
          ...decode(so[2])
            .trim()
            .split("\n")
            .slice(0, 40)
            .map((l) => `    ${l}`),
        );
    }
    if (!out.length) return null;
    return finish(
      "junit",
      out,
      [
        passed > 0 && plural(passed, "passing testcase"),
        skipped > 0 && plural(skipped, "skipped testcase"),
        "XML markup",
      ],
      failed > 0,
    );
  },
};

export const TEST_EXTRACTORS: Extractor[] = [
  vitest,
  jest,
  bunTest,
  pytest,
  goTest,
  cargoTest,
  rspec,
  playwright,
  junit,
];
export type { ExtractInput };
