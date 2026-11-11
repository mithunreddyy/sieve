// Fails unless the sandbox backend named in argv[2] (seatbelt | bwrap) is the one in use.
// CI uses it so the sandbox tests cannot "pass" by skipping on a runner without a backend.
import { detect } from "../packages/sandbox/src/index.ts";

const want = process.argv[2];
const got = detect();
console.log(JSON.stringify(got));
if (got.kind !== want) {
  console.error(`expected the ${want} backend, found ${got.kind}: ${got.detail}`);
  process.exit(1);
}
