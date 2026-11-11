import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { has } from "./args.ts";

/**
 * `sieve service install | uninstall | status` (slice 11): start the daemon at login.
 *
 *   macOS    a launchd agent in ~/Library/LaunchAgents
 *   Linux    a systemd user unit in ~/.config/systemd/user
 *   Windows  a scheduled task at logon (written, but the daemon itself has no Windows build yet)
 *
 * Both restart the daemon after a crash and stop after a few quick crashes in a row, so a crash loop
 * cannot spin. `--dry-run` prints what would be written and run. Tests use a fake command runner:
 * nothing here touches the real launchd or systemd unless you run it yourself.
 */

export type Runner = (cmd: string, args: string[]) => void;

export interface ServicePlan {
  platform: NodeJS.Platform;
  file: string | null;
  content: string | null;
  install: Array<[string, ...string[]]>;
  uninstall: Array<[string, ...string[]]>;
  label: string;
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const LABEL = "dev.sieve.daemon";

export function planService(opts: {
  platform: NodeJS.Platform;
  bin: string;
  home: string;
  sieveHome: string;
  uid?: number;
  user?: string;
}): ServicePlan {
  const { platform, bin, home, sieveHome } = opts;
  if (platform === "darwin") {
    const file = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    const uid = opts.uid ?? 501;
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(bin)}</string><string>daemon</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SIEVE_IDLE_MINUTES</key><string>0</string>
    <key>SIEVE_HOME</key><string>${xml(sieveHome)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>${xml(join(sieveHome, "logs", "launchd.err"))}</string>
</dict>
</plist>
`;
    return {
      platform,
      file,
      content,
      label: LABEL,
      install: [["launchctl", "bootstrap", `gui/${uid}`, file]],
      uninstall: [["launchctl", "bootout", `gui/${uid}/${LABEL}`]],
    };
  }
  if (platform === "linux") {
    const file = join(home, ".config", "systemd", "user", "sieve.service");
    const content = `[Unit]
Description=Sieve daemon
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
ExecStart="${bin}" daemon run
Environment=SIEVE_IDLE_MINUTES=0
Environment=SIEVE_HOME=${sieveHome}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
    return {
      platform,
      file,
      content,
      label: "sieve.service",
      install: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "sieve.service"],
      ],
      uninstall: [
        ["systemctl", "--user", "disable", "--now", "sieve.service"],
        ["systemctl", "--user", "daemon-reload"],
      ],
    };
  }
  if (platform === "win32") {
    return {
      platform,
      file: null,
      content: null,
      label: "SieveDaemon",
      install: [
        [
          "schtasks",
          "/Create",
          "/SC",
          "ONLOGON",
          "/TN",
          "SieveDaemon",
          "/TR",
          `"${bin}" daemon run`,
          "/RL",
          "LIMITED",
          "/F",
        ],
      ],
      uninstall: [["schtasks", "/Delete", "/TN", "SieveDaemon", "/F"]],
    };
  }
  throw new Error(`no login service for ${platform}`);
}

const real: Runner = (cmd, args) => {
  execFileSync(cmd, args, { stdio: "pipe" });
};

export function installService(plan: ServicePlan, run: Runner = real): string[] {
  const did: string[] = [];
  if (plan.file && plan.content !== null) {
    mkdirSync(dirname(plan.file), { recursive: true });
    writeFileSync(plan.file, plan.content);
    did.push(`wrote ${plan.file}`);
  }
  for (const [cmd, ...args] of plan.install) {
    run(cmd, args);
    did.push(`ran ${[cmd, ...args].join(" ")}`);
  }
  return did;
}

export function uninstallService(plan: ServicePlan, run: Runner = real): string[] {
  const did: string[] = [];
  for (const [cmd, ...args] of plan.uninstall) {
    try {
      run(cmd, args);
      did.push(`ran ${[cmd, ...args].join(" ")}`);
    } catch (e) {
      // already stopped or never loaded: removing the file is still what was asked
      did.push(`${cmd} said: ${String((e as Error).message).split("\n")[0]}`);
    }
  }
  if (plan.file && existsSync(plan.file)) {
    rmSync(plan.file);
    did.push(`removed ${plan.file}`);
  }
  return did;
}

/** The compiled binary this was started from, or null when run from source (no stable path to give the service). */
export function currentBinary(): string | null {
  const env = process.env.SIEVE_BIN;
  if (env && existsSync(env)) return env;
  return basename(process.execPath).startsWith("sieve") ? process.execPath : null;
}

export function serviceCommand(args: string[]): number {
  const sub = args.shift();
  const dry = has(args, "--dry-run");
  if (sub !== "install" && sub !== "uninstall" && sub !== "status") {
    console.error("usage: sieve service install [--dry-run] | uninstall [--dry-run] | status");
    return sub ? 2 : 0;
  }
  const bin = currentBinary();
  if (!bin && sub === "install") {
    console.error(
      "Run this from the installed `sieve` binary (or set SIEVE_BIN to it): a login service needs a fixed path, and this is running from source.",
    );
    return 1;
  }
  let plan: ServicePlan;
  try {
    plan = planService({
      platform: process.platform,
      bin: bin ?? "sieve",
      home: homedir(),
      sieveHome: process.env.SIEVE_HOME || join(homedir(), ".sieve"),
      uid: process.getuid?.(),
    });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  if (sub === "status") {
    console.log(
      plan.file
        ? `${plan.file}: ${existsSync(plan.file) ? "installed" : "not installed"}`
        : `${plan.label}: check with schtasks /Query /TN ${plan.label}`,
    );
    return 0;
  }
  if (dry) {
    if (plan.file) console.log(`# ${plan.file}\n${plan.content}`);
    for (const c of sub === "install" ? plan.install : plan.uninstall) console.log(`$ ${c.join(" ")}`);
    return 0;
  }
  try {
    for (const l of sub === "install" ? installService(plan) : uninstallService(plan)) console.log(l);
    if (process.platform === "win32" && sub === "install")
      console.log("Note: the Sieve daemon has no Windows build yet, so the task will not stay running.");
  } catch (e) {
    console.error(`failed: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
  return 0;
}
