# Security notes

## The honest limitation of 4-digit PINs

A 4-digit PIN has 10,000 combinations. That is fine for a friendly league **only** because guessing is throttled online. It is not strong enough to protect anything valuable, and no hashing scheme changes that: anyone holding both the database and the server secret could try all 10,000 in milliseconds.

## Safeguards in place

| Safeguard | Detail |
|---|---|
| Hashed PINs | `HMAC-SHA256(PIN_PEPPER, pin)`. The pepper lives in Vercel's environment settings, not the database, so a leaked database alone reveals no PINs. The deterministic hash lets the database enforce unique PINs. |
| No PIN retrieval | PINs are shown once when issued, then only replaced. Never in logs, exports, API responses or browser storage. |
| Member lockout | 5 wrong PINs lock that name for 15 min, doubling on each further lockout (max 24 h). The lock is checked before the PIN, so a locked account leaks nothing. |
| IP throttling | 10 failures in 15 min, or 40 in 24 h, from one address blocks it. Each failure costs ~0.4 s. |
| Weak PINs avoided | 0000, 1234, repeated digits and similar are never issued. |
| Sessions | Random 256-bit token in an HttpOnly, SameSite=Lax, Secure cookie; only its SHA-256 is stored. 30 days for members, 7 for admins. Logout and PIN reset revoke sessions server-side. Deactivating a member ends their sessions. |
| Authorisation | Every admin page and every admin server action calls `requireAdmin()` on the server. Hidden buttons are not relied on. Members can only save their own prediction (member id comes from the session, never the form). |
| Kick-off lock | Enforced in SQL with the database clock and the stored kick-off, inside a transaction that locks the fixture row. |
| Database exposure | Row Level Security is enabled on every table with no policies, and `anon`/`authenticated` privileges are revoked, so Supabase's public REST API can read nothing. The app connects server-side only; no Supabase keys are used in the browser at all. |
| Admin bootstrap | `/setup` works only while no admin has a PIN, needs `ADMIN_SETUP_TOKEN`, and is rate-limited. Remove the token afterwards. |
| Cron endpoints | Require `Authorization: Bearer $CRON_SECRET`. |
| Audit log | Member changes, PIN resets (never the PIN), overrides, results, adjustments, recalculations, settings, exports. |
| Headers | `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, no indexing. |

## Practical advice for the group

- Send each member their PIN privately (DM, not the group chat).
- If someone suspects their PIN is known, reset it from Admin → Members.
- Admins: don't share a device session; log out on shared devices.
