import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeHits, EnvValues, entropy, mask, maskSecrets, readEnvValues } from "../src/index.ts";

// Built from pieces so this file holds no contiguous secret-shaped string.
const gh = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const slack = `xoxb-${"1234567890-".repeat(2)}abcdefghij`;
const stripe = `${"sk"}_live_${"Ab12Cd34Ef56Gh78"}`;
const anthropic = `sk-ant-${"api03-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm"}`;
const openai = `sk-${"proj-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8Vc"}`;
const google = `AIza${"SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"}`;
const jwt = `eyJ${"hbGciOiJIUzI1NiJ9"}.eyJ${"zdWIiOiIxMjM0NTY3ODkwIn0"}.${"dBjftJeZ4CVPmB92K27uhbUJU1p1r"}`;
const pem = `-----BEGIN ${"RSA"} PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234abcd5678efgh\nZZZZyyyyxxxxwwwwvvvvuuuu0000\n-----END ${"RSA"} PRIVATE KEY-----`;

describe("known formats", () => {
  test.each([
    ["aws_key", "key AKIAIOSFODNN7EXAMPLE used"],
    ["github_token", `token ${gh} end`],
    ["slack_token", `slack ${slack} end`],
    ["stripe_key", `stripe ${stripe} end`],
    ["anthropic_key", `k ${anthropic} end`],
    ["openai_key", `k ${openai} end`],
    ["google_api_key", `k ${google} end`],
    ["jwt", `auth ${jwt} end`],
    ["private_key", `a\n${pem}\nb`],
  ])("%s", (kind, text) => {
    const r = maskSecrets(text);
    expect(r.hits).toEqual([{ kind, count: 1 }]);
    expect(r.text).toContain(`<secret:${kind}#1>`);
    expect(r.text).not.toMatch(/AKIAIOSFODNN|ghp_|xoxb-|_live_|sk-ant-|AIzaSy|eyJ|MIIEow/);
  });
  test("the text around a secret is untouched; a private key without its end marker is still masked", () => {
    expect(mask(`before ${gh} after`)).toBe("before <secret:github_token#1> after");
    const open = mask(
      `-----BEGIN ${"EC"} PRIVATE KEY-----\nMHcCAQEEIA1234567890abcdef\nQWERTYuiop1234567890zxcv\n`,
    );
    expect(open).toBe("<secret:private_key#1>");
  });
  test("numbering: distinct secrets of a kind count up in order; a repeat keeps its number", () => {
    const a = `AKIA${"IOSFODNN7EXAMPLE"}`;
    const b = `AKIA${"ZZZZZZZZZZZZZZZZ"}`;
    expect(mask(`${a} ${b} ${a}`)).toBe("<secret:aws_key#1> <secret:aws_key#2> <secret:aws_key#1>");
  });
});

describe("context", () => {
  test("values assigned to secret-looking names, in several syntaxes", () => {
    expect(mask("API_KEY=9f8e7d6c5b4a3210")).toBe("API_KEY=<secret:secret_value#1>");
    expect(mask('{"client_secret": "Zq8Rt2Vb7Nm4Kx1Pw"}')).toBe(
      '{"client_secret": "<secret:secret_value#1>"}',
    );
    expect(mask("password: hunter2hunter2")).toBe("password: <secret:secret_value#1>");
    expect(mask("export GITHUB_TOKEN='abc123def456ghi789'")).toBe(
      "export GITHUB_TOKEN='<secret:secret_value#1>'",
    );
  });
  test("URL passwords, bearer tokens, auth headers, AWS secrets", () => {
    expect(mask("postgres://app:s3cr3tPass99@db.internal:5432/app")).toBe(
      "postgres://app:<secret:url_password#1>@db.internal:5432/app",
    );
    expect(mask("curl -H 'Authorization: Bearer abcdefghij1234567890XYZ' x")).toContain(
      "Bearer <secret:bearer_token#1>",
    );
    expect(mask("Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==")).toBe(
      "Authorization: Basic <secret:auth_header#1>",
    );
    const aws = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(mask(`aws_secret_access_key = ${aws}`)).toBe("aws_secret_access_key = <secret:aws_secret#1>");
  });
  test("references and placeholders are left alone", () => {
    for (const ok of [
      "token = process.env.GITHUB_TOKEN",
      "const apiKey = getKey(config)",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell/template syntax under test
      "password: ${DB_PASSWORD}",
      "API_KEY=<your-key-here>",
      "secret: required",
      "tokenizer = o200k_base",
      "maxTokens: 4096",
      "const secret = 'private-token';",
      "token: string",
      "api_key=$OPENAI_API_KEY",
      "SECRET_FILE=/run/secrets/db",
    ])
      expect(mask(ok)).toBe(ok);
  });
});

describe("high-entropy tokens on their own", () => {
  test("a long random token is masked; hashes, uuids, integrity strings, sequences and identifiers are not", () => {
    const rand = "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8Vc7Xz6Qw5Er4";
    expect(mask(`session ${rand} done`)).toBe("session <secret:high_entropy#1> done");
    for (const ok of [
      "commit 3f786850e387550fdab836ed7e6dc881de23001b",
      "id 123e4567-e89b-12d3-a456-426614174000",
      '"integrity": "sha512-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8Vc7Xz6Qw5Er4Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4Oo5Pp=="',
      'const abc = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";',
      "const someVeryLongCamelCaseIdentifierNameThatKeepsGoingOnAndOn = 1;",
    ])
      expect(mask(ok)).toBe(ok);
  });
  test("entropy is Shannon bits per character", () => {
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("abcd")).toBe(2);
  });
});

describe("properties", () => {
  const sample = `x ${gh} y AKIAIOSFODNN7EXAMPLE z API_KEY=9f8e7d6c5b4a3210\n${pem}`;
  test("idempotent and deterministic", () => {
    const once = mask(sample);
    expect(mask(once)).toBe(once);
    expect(mask(sample)).toBe(once);
  });
  test("plain text is returned as the same string, with no hits", () => {
    const t = "PASS src/a.test.ts (12 ms)\n".repeat(500);
    const r = maskSecrets(t);
    expect(r.text).toBe(t);
    expect(r.hits).toEqual([]);
  });
  test("describeHits", () => {
    expect(describeHits(maskSecrets(sample).hits)).toBe(
      "4 secrets masked (github_token ×1, aws_key ×1, secret_value ×1, private_key ×1)",
    );
    expect(describeHits([])).toBe("");
  });
});

describe(".env values", () => {
  test("values from .env files are masked wherever they appear; examples and short values are not read", () => {
    const d = mkdtempSync(join(tmpdir(), "sieve-env-"));
    writeFileSync(
      join(d, ".env"),
      'DATABASE_NAME=main\nSTRIPE_WEBHOOK=whsec_Zx9Qw8Er7Ty6Ui5\nexport SMTP_USER="mailer-robot-77"\nPORT=3000\n# C=1\n',
    );
    writeFileSync(join(d, ".env.example"), "STRIPE_WEBHOOK=whsec_example_value_here\n");
    expect(readEnvValues(d).sort()).toEqual(["mailer-robot-77", "whsec_Zx9Qw8Er7Ty6Ui5"]);
    const env = new EnvValues();
    const out = maskSecrets("hook whsec_Zx9Qw8Er7Ty6Ui5 and user mailer-robot-77 on port 3000", {
      values: env.get(d),
    });
    expect(out.text).toBe("hook <secret:env_value#1> and user <secret:env_value#2> on port 3000");
    writeFileSync(join(d, ".env"), "NEW_ONE=brand-new-secret-9\n");
    expect(env.get(d, Date.now() + 5000)).toEqual(["brand-new-secret-9"]);
  });
});

describe("false positives on real content", () => {
  test("none of the captured fixtures changes", () => {
    const root = join(import.meta.dir, "../fixtures");
    let n = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".txt")) {
          const t = readFileSync(p, "utf8");
          expect({ file: p.slice(root.length), hits: maskSecrets(t).hits }).toEqual({
            file: p.slice(root.length),
            hits: [],
          });
          n++;
        }
      }
    };
    walk(root);
    expect(n).toBeGreaterThan(30);
  });
  test("a lockfile with integrity hashes is unchanged", () => {
    const lock = readFileSync(join(import.meta.dir, "../../../bun.lock"), "utf8");
    expect(maskSecrets(lock).hits).toEqual([]);
  });
});

describe("command-line flags", () => {
  test("curl -u, --password and --token values are masked; uid:gid and short values are not", () => {
    expect(mask("curl -u admin:s3cr3tPass99 https://x.example.com")).toBe(
      "curl -u admin:<secret:cli_password#1> https://x.example.com",
    );
    expect(mask("curl --user=admin:s3cr3tPass99 https://x")).toBe(
      "curl --user=admin:<secret:cli_password#1> https://x",
    );
    expect(mask("tool --password hunter2hunter2 --verbose")).toBe(
      "tool --password <secret:cli_secret#1> --verbose",
    );
    expect(mask("gh --token=abc123def456ghi run")).toBe("gh --token=<secret:cli_secret#1> run");
    for (const ok of [
      "docker run -u 1000:1000 img",
      "sort -u file.txt",
      "tool --password-file /run/secrets/p",
      "x --token abc",
      "cmd --token --other",
    ])
      expect(mask(ok)).toBe(ok);
  });
});
