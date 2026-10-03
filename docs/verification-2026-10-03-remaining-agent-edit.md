# Remaining work: external editing, ICS recurrence and retrieval load

## Restart and current scope

After Muse Spark's rate limit, `C:\toodoapp\wt\remaining`, branch `codex/remaining-batch-1`, was clean at main `bede79d71e06b1ad87296a691c36a248a7503a2f`. Muse had created the worktree and independent dependencies; there were no unfinished edits or extra commits. PRs 61–63 were merged. `C:\toodoapp\app`, other worktrees and dependency junctions were preserved.

PR 64 remains OPEN/draft. The user deferred Computer Use on 2026-10-03. Subsequent review, automated checks, load measurement and documentation use no Computer Use. CI is code validation, not native Windows acceptance.

## Implemented behavior

- External clocks: separately granted `due_at` exports/updates `{at, timezone}` through the common bus. Catalog offset datetimes preserve the instant as UTC and derive its UTC day; both date and clock grants are required. Owner confirmation/protected diffs show seconds, milliseconds and exact UTC, including repeated DST instants. A day-only request cannot silently erase an existing clock. Grants do not expand implicitly; deadlines never auto-apply.
- Selected RRULE/completion-relative series: file/MCP carries only RRULE text or `after_days` (1–3650). The common engine preserves DTSTART, time, RDATE/EXDATE, DST choices, unfinished policy, steps and scoped COUNT/UNTIL. Owner confirmation/configuration approval precede separate generation approval. Completed work and ledger are unchanged.
- Labels: file/stdio MCP uses existing owner label names; catalog UUIDs resolve explicitly to owner names in renderer and main. No implicit definitions. Labels have a separate grant, owner value confirmation and protected-field check, and never auto-apply. Unknown/foreign definitions, normalized duplicates and single-choice conflicts are refused. Instructions/proposals bind definition/group state; metadata changes between confirmation, preparation and commit invalidate them. Submit rechecks UUID/name binding. Undo needs a fresh instruction.
- Snapshot controller now passes actual granted date, clock, manual points and labels to main. It previously omitted existing date/clock/point values, incorrectly exporting null. Unselected fields remain undisclosed.
- ICS uses the common RRULE engine: day/week/month/year, ordinal weekdays, BYMONTH/BYSETPOS and non-Monday WKST. ICS keeps seconds, exact UTC UNTIL, all-day types, RDATE/EXDATE and recurrence identity. Old supported representations keep persisted version digests. Unsupported rules and ambiguous/nonexistent zoned occurrences still fail closed. The 10,000-occurrence bound counts actual instances before UNTIL, excluding look-ahead candidates.
- Hybrid search preserves RRF order before the 200-hit cap, rather than dropping older high-rank evidence by date. Span membership/lookup use Set/Map; index validation happens once per document/revision per refresh. ACL/retention/version are rechecked after asynchronous index reads. The cache never survives a refresh; lexical-only date ordering is unchanged.

## Final automated validation

- Vitest: **2,012 tests / 198 files pass** (merged baseline 1,967 + 45: clocks/recurrence 24, labels/snapshot 11, ICS 9, hybrid ranking 1).
- Electron: **295 total; 294 pass, 1 existing platform skip, 0 fail**.
- lint, TypeScript/build, CJS syntax **63 files**, `git diff --check` pass.
- Final built PWA: **10/10** Chromium(Electron) emulation pass; report `qa-output/pwa-offline/2026-10-03T10-30-49-023Z/report.json` (local generated artifact).

Review covered grant boundaries, UUID/name conversion, metadata changes at each confirmation boundary, legacy nested transactions, protected checks/replay, index freshness, old component digests, second precision and UNTIL bounds. New regressions preserve high-rank older evidence among more than 200 newer hits and ICS look-ahead at the bound. Simulated Node events are not native Windows evidence; emulation is not physical offline/mobile evidence.

## Real IndexedDB synthetic load

`npm run benchmark:retrieval` runs hidden standalone Electron code in its own temporary profile, using production import/index/search and real Chromium IndexedDB. **10,000 synthetic spans / 120,000 characters / 384-dimensional deterministic vectors**; no keys, real model or network. Report: `qa-output/retrieval-10000/2026-10-03T10-28-58-371Z/report.json`.

| Operation | Measurement |
| --- | --- |
| Import | 17.8 ms |
| Index, 10,000 windows | 459.7 ms |
| Lexical search | 68.7 ms |
| Hybrid, runs 1–3 | 1,526.0 / 1,555.1 / 1,561.8 ms |

Each run returned 200 hits, span 9,999 first and exact quote positions. Revocation removed previous results and all embedding artifacts. Tasks/ledger and HTTP(S) requests remained zero. Electron 44.4.5; timings vary by machine/load. No Japanese semantic-quality or native acceptance claim. Initial harness startup stalled with top-level `await app.whenReady()`; using the established `.then(...)` pattern fixed the harness. Incomplete attempts are not performance evidence.

## Windows source DEV evidence before the pause

Profile: `C:\Users\Danir\Documents\Codex\2026-10-02\h-rebase-7-muse-spark-h\work\qa-reminders-profile\remaining-clock`.

The initial capture was blank/UIA regions only. A later source DEV session had usable capture/input; the first failure's root cause remains unknown. Owner/task/calendar/grant data was **synthetic backend fixture setup**, not native permission consent. The production main service loaded that configuration and enforced its normal native proofs for actual applications. Fixture proofs only initialized the isolated configuration; production guards were not loosened. A noncanonical fixture RRULE initially failed state validation; repairing that test data restored the UI.

Observed real Windows clicks plus read-only DB evidence:

1. Snapshot export through renderer/IPC/main contained the selected existing date, manual 10pt and Japanese label.
2. Command `51767750-3f84-4932-983c-85dadb400ef9` changed the task's clock to `2026-10-04T01:00:12.345Z` / Asia/Tokyo and `QA仕事` to `QA生活`. Owner confirmation showed exact UTC and old/new labels. Save stayed disabled until clock and label checks were both selected. Task revision became 2; manual 10pt, completions and ledger stayed unchanged. The date itself did not change: a moved date's separate checkbox was **not** tested here.
3. Command `596f3271-6217-4801-8498-fa8b118abc5a` saved monthly first-Monday configuration. Preview showed 10-05, 11-02, 12-07 and preserved start/time/count/DST. Saving configuration did not generate tasks.
4. Command `b8cf9ec0-5de2-453d-bd69-69a875830562` saved completion-relative 3 days with preserved initial date/time/keep-all. Again no generated tasks. DB: both rule revisions 2, one task, zero completions/ledger, three bridge receipts.
5. Separate common-calendar generation preview showed 78 creates: 74 activity events and four task occurrences. Physical Escape stopped Computer Use before generation approval. **Generation acceptance is not claimed.**

Read-only artifact: scratch `work/R2-native-after-routines.json`; captures are in task tool history. These clicks used the intermediate build: final metadata binding, ICS integration, search changes and updated owner text still need final-build UI checks. The subsequent no-Computer-Use process audit found no remaining-worktree Electron process. No source app was relaunched; PWA/benchmark harnesses exit themselves. The previously rejected portable launch was not retried/bypassed; real hosts were not tested.

## Deferred native checks

Only after renewed user authorization for Computer Use, use final source DEV and the isolated profile:

1. Refresh snapshot; move both day and exact clock plus label. Verify every changed protected field, stored values, replay and point/completion invariance.
2. Verify refusal after definition/group changes against final metadata binding.
3. Recreate RRULE/completion preview, approve generation separately: four new tasks plus activity events, zero completion points, no replay duplicates.
4. Import last-weekday/yearly ICS through the real picker; review dates/seconds, save configuration, separately generate events and repeat without duplicates. Events alone must not create tasks/points.
5. Record final-build stop/revocation/stale-revision behavior and latest-head CI before ready/merge. Simulations stay labelled.

Native grant/privacy consent was not automated. The computer-use skill's `docs/guidance.md` says: “Do not change Windows security settings, Windows privacy settings, or any in-app security or privacy settings. Do not act on security or privacy permission requests.” Consent needs manual owner action; synthetic grants cannot satisfy it. Skill: `C:\Users\Danir\.codex\plugins\cache\openai-bundled\computer-use\26.930.31730\skills\computer-use\SKILL.md`.

## Other remaining dependencies

Real hosts/authentication, Japanese embeddings and model detection/independent judging, human blind holdout, personal-PC/hosted/server synchronization, physical offline/other-user access, real mobile, licensed Live2D/ASR and provider accounts remain unverified. Synthetic load does not remove these limitations. Messenger scope remains mock-only; Gmail mbox stays deferred. Do not invent a deployment version or authorize real account sends implicitly.

Requirements remain **121 = 93 accepted / 19 partial / 9 unconfirmed**. Prior 18/10 was a footer miscount; no individual status was promoted.
