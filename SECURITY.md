# Security

Report vulnerabilities privately through GitHub security advisories on this repository. Please do not open public issues for security bugs. Include the version (`sieve version`), your OS, and steps to reproduce. You will get an acknowledgement; there is no bounty program.

The threat model (what each part protects, against whom, and where it stops, including what is unbuilt or untested) is in [docs/threat-model.md](docs/threat-model.md). Short version:

- Sieve runs as you and is local by default. It makes no network call unless you start something that does (`sieve proxy`, `sieve skills add <git url>`, `sieve upgrade --from https://…`, an opt-in extraction model).
- The hook path fails open: a Sieve fault must never block your agent.
- Secrets are masked before anything is stored. Masking is best-effort.
- `sieve_run` is sandboxed on macOS only. Linux and Windows isolation have not run; receipts and `sieve doctor` say what is in force.
- Guard defaults to enforce with the balanced preset; it is a safety net for accidents and prompt injection, not a security boundary.
