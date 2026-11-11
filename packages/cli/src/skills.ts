import { join } from "node:path";
import { paths, Skills } from "@sieve/core";

/** `sieve skills add | list | enable | disable | remove | verify | match` (slice 8). */

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined || v.startsWith("--") ? 1 : 2);
  return v === undefined || v.startsWith("--") ? "" : v;
};

export const skillsFor = () => new Skills(join(paths.home(), "skills"));

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

export function skillsCommand(args: string[]): number {
  const sub = args.shift();
  const sk = skillsFor();
  try {
    switch (sub) {
      case "add": {
        const name = flag(args, "--name");
        const path = flag(args, "--path");
        const ref = flag(args, "--ref");
        const src = args[0];
        if (!src) {
          console.error(
            "usage: sieve skills add <git-url|folder> [--path sub/dir] [--ref branch|tag|sha] [--name n]",
          );
          return 2;
        }
        const { skill, replaced } = sk.add(src, { name, path, ref });
        console.log(`${replaced ? "Replaced" : "Added"} ${skill.name} (disabled): ${skill.description}`);
        console.log(
          `  from ${skill.source}${skill.commit ? ` @ ${skill.commit.slice(0, 12)}` : " (no commit: a plain folder)"}`,
        );
        console.log(`  ${skill.files} file(s), ${kb(skill.bytes)}, checksum ${skill.checksum.slice(0, 16)}`);
        console.log(
          "  Sieve never runs anything in a skill: only its SKILL.md text is shown to the model, once enabled.",
        );
        console.log(`  Read it, then: sieve skills enable ${skill.name}`);
        return 0;
      }
      case "list": {
        const all = sk.list();
        if (!all.length) {
          console.log("No skills. Add one with: sieve skills add <git-url|folder>");
          return 0;
        }
        for (const s of all) {
          const v = sk.verify(s.name);
          console.log(
            `${s.enabled ? "on " : "off"} ${s.name}  ${s.description.slice(0, 90)}${v.ok ? "" : `\n    ! ${v.reason}`}`,
          );
          console.log(
            `      ${s.source}${s.commit ? ` @ ${s.commit.slice(0, 7)}` : ""} · ${s.checksum.slice(0, 8)}`,
          );
        }
        const cost = sk.listCost();
        console.log(
          `\nThe list the model sees at the start costs about ${cost} token(s) (${sk.enabled().length} enabled). A loaded skill adds its text, at most about 4000 tokens, once per turn it applies.`,
        );
        return 0;
      }
      case "enable":
      case "disable": {
        const name = args[0];
        if (!name) {
          console.error(`usage: sieve skills ${sub} <name>`);
          return 2;
        }
        const s = sk.setEnabled(name, sub === "enable");
        console.log(`${s.name}: ${s.enabled ? "enabled" : "disabled"}`);
        return 0;
      }
      case "remove": {
        const name = args[0];
        if (!name) {
          console.error("usage: sieve skills remove <name>");
          return 2;
        }
        console.log(sk.remove(name) ? `Removed ${name}.` : `No skill named ${name}.`);
        return sk.get(name) ? 1 : 0;
      }
      case "verify": {
        const names = args[0] ? [args[0]] : sk.list().map((s) => s.name);
        let bad = 0;
        for (const n of names) {
          const v = sk.verify(n);
          console.log(v.ok ? `${n}: ok` : `${n}: ${v.reason}`);
          if (!v.ok) bad++;
        }
        return bad ? 1 : 0;
      }
      case "match": {
        const prompt = args.join(" ");
        if (!prompt) {
          console.error('usage: sieve skills match "<prompt>"   what would load for this prompt, and why');
          return 2;
        }
        const m = sk.match(prompt);
        if (!m) console.log("No skill would load.");
        else
          console.log(
            m.how === "requested"
              ? `${m.skill.name} would load: you asked for it by name.`
              : `${m.skill.name} would load: it matches (${m.words.join(", ")}; score ${m.score.toFixed(2)}).`,
          );
        return 0;
      }
      default:
        console.error(
          'usage: sieve skills add <git-url|folder> | list | enable <name> | disable <name> | remove <name> | verify [name] | match "<prompt>"',
        );
        return sub ? 2 : 0;
    }
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
