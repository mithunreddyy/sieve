import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all Sieve state. `SIEVE_HOME` overrides `~/.sieve` (tests use this). */
export function sieveHome(): string {
  return process.env.SIEVE_HOME || join(homedir(), ".sieve");
}

export const paths = {
  home: () => sieveHome(),
  runDir: () => join(sieveHome(), "run"),
  socket: () => join(sieveHome(), "run", "sieved.sock"),
  lock: () => join(sieveHome(), "run", "sieved.lock"),
  misses: () => join(sieveHome(), "run", "misses.log"),
  spawns: () => join(sieveHome(), "run", "spawns"),
  logsDir: () => join(sieveHome(), "logs"),
  daemonLog: () => join(sieveHome(), "logs", "sieved.log"),
  backupsDir: () => join(sieveHome(), "backups"),
  globalDb: () => join(sieveHome(), "global.db"),
  projectDir: (key: string) => join(sieveHome(), "projects", key),
  projectDb: (key: string) => join(sieveHome(), "projects", key, "sieve.db"),
};
