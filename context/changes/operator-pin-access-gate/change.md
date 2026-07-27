---
change_id: operator-pin-access-gate
roadmap_id: F-02
title: Operator access gate (PIN + lockout, private path)
status: implementing
created: 2026-07-27
updated: 2026-07-27
prd_refs: [US-22, NFR-access, "§Access Control"]
roadmap: context/foundation/roadmap.md
---

# F-02: Operator access gate (PIN + lockout, private path)

Replaces the scaffolded Supabase email/password auth with a 6-digit PIN gate: a
DB-backed atomic lockout/rate-limit counter (5 failed attempts → 15-minute cooldown),
an HMAC-signed stateless session cookie, and full removal of the email/password
scaffold. The private-path (Cloudflare Tunnel) network exposure is explicitly
out of scope — this change covers only the application-level gate.

Unlocks S-03 (translated-shortlist-view, the north star) and every later
dashboard slice. See the roadmap for the full dependency graph.
