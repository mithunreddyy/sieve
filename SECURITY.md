# Security

Report vulnerabilities privately through GitHub security advisories on this repository. Please do not open public issues for security bugs.

## Threat model (slice 1)

Sieve runs as the user and is local only. These are the boundaries that exist today and what they do and do not protect.

**Daemon socket** (`~/.sieve/run/sieved.sock`)
- Directory mode `0700`, socket mode `0600`: only the same user can connect. Any process running as that user can talk to the daemon, archive content, run `sieve_run`, and read anything archived. This is the same trust level as the user's shell; the socket does not defend against malware already running as the user.
- Frames are size-bounded by the shim (64 MB input) and validated with zod. Tool arguments are strict (unknown fields rejected).

**`sieve_run`: no isolation yet.** Code runs as the user with full file and network access, exactly like the agent's own shell tool. Every receipt and `sieve doctor` say so. OS sandboxing (Seatbelt, bwrap/Landlock, AppContainer) is slice 6. Do not treat `sieve_run` as a security boundary until then.

**Archive.** Tool output is stored gzip-compressed in `~/.sieve/projects/<key>/sieve.db` (mode `0700` directory). **Secrets are not masked yet** (slice 6): anything a tool printed, including credentials, is stored on disk. Purge with `rm -rf ~/.sieve/projects/<key>` until `sieve purge` lands.

**Setup.** Only Sieve's own entries are written to agent config files, every touched file is backed up first, and a failed post-write check restores them. Instruction files (CLAUDE.md, AGENTS.md) are never edited.

**Network.** The default mode makes no network calls. Slice 1 has no URL fetching.

**Guard** (command and behaviour rules) is slice 7 and does not exist yet.
