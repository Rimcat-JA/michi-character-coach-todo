# Remaining work: external deadline clocks and recurrence editing

## Restart checkpoint

After Muse Spark reported a provider rate limit, the live repository was inspected. `C:\toodoapp\wt\remaining`, branch `codex/remaining-batch-1`, was clean at `bede79d71e06b1ad87296a691c36a248a7503a2f`. The remote main was the same commit. Muse had created this worktree and installed independent dependencies; there were no additional commits or unfinished edits to recover. PRs 61, 62 and 63 were already merged. Existing worktrees and `C:\toodoapp\app` were preserved.

## Added behavior

- File/stdio MCP connections can separately grant `due_at`, export its current `{at, timezone}` value, and propose a change through the existing command bus. Dates remain `due_date`; clocks use a canonical UTC ISO instant and a valid IANA zone. Malformed dates, invalid zones and extra authority fields fail closed in both main and renderer boundaries.
- The catalog's `due.kind=datetime` carries an offset instant but no IANA zone. Conversion preserves that instant as UTC and derives its UTC deadline day. Both `due_date` and `due_at` permissions are required. Native value confirmation and protected diffs display the date, local time, zone and exact UTC instant, including seconds/milliseconds and the distinction between repeated DST times, followed by separate checks for both protected fields. Existing grants are not expanded implicitly. Deadlines never qualify for automatic application.
- Day-only catalog requests against an existing clock deadline remain unsupported: they cannot silently erase its clock. File/MCP callers may explicitly clear or replace a clock through the existing protected bus path.
- Owner-selected RRULE and completion-relative series now export and accept recurrence proposals through the same file/MCP route as other series. Wire triggers are `{kind:"rrule",rrule:"..."}` or `{kind:"completion_relative",after_days:7}`. Requests cannot set DTSTART, RDATE/EXDATE, DST choices, unfinished policy, title, points or steps. RRULE text is bounded to 2,000 characters; completion intervals to 1–3,650 days. The existing app parser and `routineAssistTrigger` perform semantic validation and preserve start, clock, exceptions, DST and scoped COUNT/UNTIL behavior.
- The person reviews the next occurrences and approves the configuration; generation still requires its own approval. Completed tasks, completion records and point ledger stay unchanged. The owner screen uses the existing recurrence description, including start and preserved choices.
- Capabilities no longer claim that implemented handoff/reference or clock functionality is unavailable. Real hosts remain unverified.

## Automated validation

Final local validation: Vitest **1,991 tests / 197 files** pass (baseline 1,967 + 24 added); Electron **295 tests: 294 pass, 1 existing platform skip, 0 fail**; lint, TypeScript/build, CJS syntax **63 files**, and PWA emulation **10/10** pass. The final PWA report is `qa-output/pwa-offline/2026-10-03T08-55-52-356Z/report.json` (generated local artifact). Added coverage exercises actual main file bridge, signed inbox, MCP client/router and app DB; native clicks in these Node tests are simulated and are **not** Windows acceptance evidence.

The clock cases cover file/MCP approval and replay, catalog-to-inbox conversion across an offset date boundary, each missing field grant, malformed clocks, protected checks and inconsistent local days. Recurrence cases cover RRULE and completion-relative changes through both entrances, native confirmation requirements, separate generation approval, preserved COUNT/exceptions/DST/unfinished choices, completed work and ledger invariance, forbidden extra fields and invalid RRULE semantics.

## Windows DEV limitation — acceptance not claimed

A source development Electron app was launched from this worktree with its own fresh profile at `C:\Users\Danir\Documents\Codex\2026-10-02\h-rebase-7-muse-spark-h\work\qa-reminders-profile\remaining-clock`. The first background launch hid the window; it was stopped and relaunched visibly for Computer Use. The target window was then selectable, but Computer Use capture showed an empty client area and accessibility exposed only region nodes. Activating the exact returned window and retrying with `--force-renderer-accessibility --disable-gpu` did not recover usable controls. Read-only inspection found the app DOM and empty, dedicated DB initialized normally. No native confirmation or application was performed in this window.

The source app was quit after the failed UI verification attempts. The portable-distribution launch previously rejected by approval review was not retried or bypassed. Chromium PWA emulation and Node simulated clicks must not be described as native Windows acceptance. This change remains a draft until the new clock and recurrence routes receive Windows UI evidence and the current PR head passes both CI jobs. Requirement statuses remain partial.

## Next work

1. Restore usable Windows source DEV capture/input and verify new grants, exact clock value display, both protected checks, saving/replay, RRULE/completion-relative preview/configuration/generation, stop/revoke/stale revision behavior. Record actual evidence, then review final-head CI before any merge.
2. Audit remaining local gaps, including label proxy edits and ICS use of the common recurrence engine; do not invent support by changing status text.
3. Real ChatGPT/Claude hosts, independent semantic judging, personal-PC/hosted deployments, physical offline and other-user intrusion, licensed Live2D/real ASR, actual provider accounts and messenger APIs remain external/unverified work. Keep mock messenger scope and the previously deferred Gmail mbox alternative unchanged.

Recounting the actual rows at baseline `bede79d` gives 121 entries: 93 accepted, 19 partial, 9 unconfirmed. Its footer (and previous report) incorrectly said 18 partial/10 unconfirmed. The footer is corrected to match the unchanged individual statuses. This batch does not promote any entry to accepted.
