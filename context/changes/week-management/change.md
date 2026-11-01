---
change_id: week-management
title: Manage weeks from the dashboard — delete, close, retry, edit the post text, instant filters
status: implementing
created: 2026-11-01
updated: 2026-11-01
archived_at: null
---

## Notes

Operator request (2026-11-01): the "Previous weeks" list holds outdated weeks that can't be removed
or changed, and its filter buttons reload the whole page. Decisions: removing a week deletes it for
good (confirmation dialog; a week the worker is actively running can't be deleted). "Modify" means
three things: close an outdated week (nothing publishes, it leaves "Needs me" and the reminder),
retry a failed week from the stage that failed, and edit a story's Polish text on the approval page
before approving (the slides are re-rendered). Not wanted: reopening story selection.

Found while planning: nothing in production runs the writing (`generate`) or slide (`visuals`)
stages — after the operator confirms picks, the week waits in "Writing copy" until someone runs the
commands by hand. Retry and edit both need the Pi to run those stages on its own, so this change
adds that.

Also open: the 31 Aug digest `c92aa3c5` is still `approved`, so the Pi's Tuesday publish job would
post it. "Close" resolves it from the dashboard before the Pi is updated.
