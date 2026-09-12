# S-07 live verification

Record of Phase 7: the content approval gate driven against real, naturally-produced digests —
real generated copy from real LLM calls, real rendered visuals from real Google Slides exports, a
real Gmail send, and the operator's own decision through the real UI. Written 2026-09-12.

## Approve path (7.3, 7.4, 7.5)

**Digest**: `c92aa3c5-d565-4408-8a27-fb087948aaa9`, week 2026-08-31 → 2026-09-06 — a real digest
already sitting in `ready_for_approval` from S-05/S-06's own live verification, with 4 real
generated stories, 4 real rendered assets, and a confirmed `single_post` selection for
Instagram/LinkedIn/Facebook. Chosen deliberately over a fresh pipeline run for this half: it was
already the most genuinely real, fully-prepared candidate available, and using it meant the
approve path exercised real content the operator had never seen through this gate before.

### FR-019 email (7.3)

`notifyApprovalReady` called directly (mirroring exactly what `npm run visuals`'s `main()` does)
since this digest was rendered before Phase 5 added the email call. Sent successfully to
`konporeba@gmail.com`; CTA confirmed to resolve to
`http://localhost:4321/dashboard/c92aa3c5-d565-4408-8a27-fb087948aaa9/approve`.

### Review and decision (7.4, 7.5)

The operator reviewed the complete post on the approval page and confirmed the decision verbally
("I approve") rather than clicking through the UI themselves; the decision was then recorded via
the same `POST /api/approval/decide` endpoint the UI calls, on the operator's explicit instruction.

**Not independently confirmed**: whether the operator specifically traced a key statistic back to
its source article via the page's Source panel before deciding, as the plan's criterion asks. The
page's layout (key statistics beside the original title/lede and a source link, per Phase 4) makes
that check available on the same screen, and the operator had the page open before approving, but
this was not verified as a discrete step the way it was for the automated criteria. Recorded here
rather than silently assumed.

Confirmed after the decision:

- `digest.status` → `approved`
- Exactly one `approval` row, `decision: "approved"`, no note
- The approve page re-fetched shows the "Approved on 9/12/2026, 10:31:32 PM." banner and **zero**
  hydrated islands (`grep -c astro-island` → 0) — genuinely read-only, not just visually so
- `/dashboard/c92aa3c5-.../` also reflects the decision via its own entry-point banner

## Reject path — attempted for real, accepted a lighter-weight proof instead

**Intent**: drive a second real digest through collect → rank → select → generate → visuals to
`ready_for_approval`, then reject it with a note and recover it via `npm run generate`.

**What was actually run**, all for real, all real spend:

1. `npm run collect -- --week=2026-09-07` → 33 articles, one source (`expansion-empresas-inmobiliario`)
   hit a transient DNS failure (`ENOTFOUND`), pool threshold still met. Digest
   `47625f14-8017-4124-a10d-bbd6c1e77a48`.
2. `npm run rank -- --digest=47625f14-...` → $0.1658, 15-cluster shortlist, real FR-010 email sent.
3. `confirm_selection` called directly for the top 2 ranked clusters (`single_post`, Instagram) —
   a technical pick for this test, not a real editorial judgment, since the point was to exercise
   the plumbing rather than choose the week's actual content.
4. `npm run generate -- --digest=47625f14-...` → $0.2641, 2 stories generated.
5. `npm run visuals -- --digest=47625f14-...` → **failed**:
   `"Bruksela miesza się w spór o mieszkania turystyczne w Barcelonie": insufficient_statistics —
the story has 2 usable key statistic(s); the template has 3 fixed slots and Slides cannot hide
the unfilled ones.`

### Why this could not be recovered within the session

`STAT_SLOT_COUNT = 3` (`src/lib/visuals/slots.ts:20`) is a single global constant applied
identically to every story regardless of format — checked before switching to carousel, which
would **not** have helped, correcting an earlier wrong assumption made mid-session. The Brussels
story's source article genuinely does not contain three extractable numeric figures; this is a
property of the source content, not something a second LLM pass can manufacture.

- **Regenerating in place** (`npm run generate -- --digest=47625f14-...` again, exercising the
  `failed → generating` recovery edge exactly as designed): $0.3844 total, same story, same 2
  usable statistics, same downstream rendering failure. The recovery mechanism itself worked
  correctly — it just could not change what the source material contains.
- **Re-picking different stories** was not possible: `selection` is unique on `digest_id` and the
  RPC only accepts one confirm per digest (by design — S-04's own gate), so the top-2 pick from
  step 3 was permanent for this digest.
- **A fresh week's pool** (`npm run collect -- --week=2026-09-14`) returned 0 articles: collection
  windows tile from the previous digest's `collection_completed_at` checkpoint to the current run's
  start time (S-01's own design), so a second collection minutes after the first necessarily sees a
  near-empty window. A genuinely fresh, rich pool needs real elapsed time, not another invocation.

Given both remaining paths (wait for real time to pass, or fabricate statistics data to force the
render through) were rejected — fabricating data would defeat the entire point of a live
verification — the operator chose to accept the reject/recover state-machine mechanics as already
proven live, just not through the full pipeline:

- `src/lib/digest/state-machine.test.ts` — the `rejected` state and both its edges, parsed
  directly from the live-applied migration
- `src/lib/approval/record.test.ts` — `record_approval` rejecting with and without a note, against
  the real database (Phase 2)
- `src/worker/generate.test.ts`'s `"puts a rejected digest with a confirmed selection back into
generating"` — the exact recovery path, against the real database (Phase 1)

**Not exercised live**: a rejection travelling through the real UI's `ApprovalPanel` reject dialog,
and `npm run generate`'s recovery being triggered on a digest that reached `ready_for_approval`
through the full real pipeline rather than direct RPC calls. Worth revisiting the next time a
digest naturally reaches `ready_for_approval` and the operator has one to spare for the exercise.

### Cleanup

Digest `47625f14-8017-4124-a10d-bbd6c1e77a48` is left in the database in real `failed` status —
genuine pipeline state from a genuine run, not synthetic test data manufactured for this
verification. It cost $0.3844 in real generation spend across two attempts. Left as-is rather than
deleted, pending the operator's own call on whether to keep, recover, or discard it.

## Monday reminder (6.7-6.10, exercised again here incidentally)

Already recorded in Phase 6's own Progress rows. Two genuine pre-existing outstanding digests
(one per gate) were named correctly by `npm run remind` during that phase's own live verification;
the "nothing outstanding" case remains unverified live for the same reason — real outstanding
digests currently exist and resolving them is the operator's call, not this slice's.

## Summary

The approve half of the gate is fully verified against real content: real email, real page,
real decision, real read-only re-render. The reject half's state-machine mechanics are verified
against the real database at every layer this slice controls (migration, RPC, recovery edge), but
the specific combination of "reached `ready_for_approval` via the full real pipeline, then
rejected through the real UI" was not achieved this session — not from a code defect, but from two
independent, genuine constraints (a source article's thin numeric content, and the collection
window's time-tiling) that a live attempt was exactly the right way to discover.
