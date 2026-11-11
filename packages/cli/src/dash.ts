import { DaemonClient } from "@sieve/daemon";
import { collect, renderFrame, serveDashboard } from "@sieve/dashboard";
import type { StatusReport } from "@sieve/protocol";

/** `sieve dash` (local web page) and `sieve tui` (terminal view), slice 9. */

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined || v.startsWith("--") ? 1 : 2);
  return v === undefined || v.startsWith("--") ? "" : v;
};
const has = (args: string[], name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};

export async function dashCommand(args: string[]): Promise<number> {
  const port = Number(flag(args, "--port") ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("usage: sieve dash [--port N]");
    return 2;
  }
  const d = serveDashboard({ port });
  console.log(`Sieve dashboard (this machine only): ${d.url}`);
  console.log("Open that address in a browser. The token in it is new every time. Ctrl-C stops it.");
  return new Promise<number>(() => {});
}

/** Whether the daemon is up, and a one-line summary, without starting it. */
async function daemonLine(): Promise<{ up: boolean; line?: string }> {
  const c = await DaemonClient.connect({ autostart: false });
  if (!c) return { up: false };
  try {
    const r = await c.request({ type: "status" });
    if (!r.ok) return { up: true };
    const s = r.result as StatusReport;
    return {
      up: true,
      line: `v${s.daemon.version} · ${Math.round(s.daemon.rssBytes / 1048576)} MB · queue ${s.queue.hook}/${s.queue.tool}/${s.queue.background}`,
    };
  } finally {
    c.close();
  }
}

export async function tuiCommand(args: string[]): Promise<number> {
  const once = has(args, "--once");
  const frame = async () =>
    renderFrame(collect({ limit: 20 }), {
      width: process.stdout.columns ?? 100,
      color: !!process.stdout.isTTY && !process.env.NO_COLOR,
      daemon: await daemonLine(),
    });
  if (once || !process.stdout.isTTY) {
    console.log(await frame());
    return 0;
  }
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  let stop = false;
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (b) => {
    if (b.toString() === "q" || b[0] === 3) stop = true;
  });
  try {
    while (!stop) {
      process.stdout.write(`\x1b[H\x1b[2J${await frame()}\n`);
      for (let i = 0; i < 20 && !stop; i++) await Bun.sleep(100);
    }
  } finally {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }
  return 0;
}
