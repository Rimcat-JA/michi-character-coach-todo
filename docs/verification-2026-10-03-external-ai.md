# Batch L — work in progress

This is an intermediate implementation checkpoint, not Windows acceptance or a completed batch.

Implemented: restricted Markdown edit copies and `michi-cli validate/submit`; external AI defaults OFF and has an independent processing epoch from OpenRouter BYOK; N09 global stops still stop both. Multiple signed file connections now have isolated roots, journals, scan references, leases, scopes and application receipts. Selection does not retarget a prepared operation. Global revocation also invalidates a configuration still awaiting IO. Existing legacy native connections are revoked on migration and need fresh owner registration; keys and registrations are excluded from backup.

Local stdio self-test uses the app executable, its own adapter and the selected registered root, with bounded output, timeout and app-close cancellation. It records only `verified_local` read/revoke evidence. Authentication and writes stay `not_tested`. A result is discarded if owner, dataset, external epoch or registration changes during the diagnostic. No host is promoted to `integration_verified`.

Host setup commands are references checked on 2026-10-03: [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Claude Code](https://code.claude.com/docs/en/mcp), [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/). Codex local CLI help was read, but no host configuration was modified and no real host was connected. Commands preserve PowerShell quoting; Gemini uses `trust: false`.

Checkpoint validation: TypeScript and lint passed; 1,856 Vitest tests / 177 files passed; 263 Electron Node tests passed. Tests include two actual local coordinators wired to fake-indexeddb, the same command UUID applied independently, A revoked while B remains pending, immutable ledger/manual 25pt/deadline preservation, BYOK-OFF automatic delegation, concurrent configure/revoke, and a real Node stdio subprocess. Native clicks in these tests are simulated; this is not Windows UI evidence.

Remaining: external basis/request-key gate, 15 `coach_*` tools over app IPC, grant revision editing, handoff/context shares, opt-in loopback OAuth/HTTP, per-scenario ledger, Windows DEV UI QA, final review/PR/CI/merge. Actual hosts/accounts, physical offline testing, packaged UI launch and other deployment modes are unverified. Packaged launch was previously rejected by automatic approval review (“blocked by policy”); it must not be relabeled accepted or retried through another launcher.
