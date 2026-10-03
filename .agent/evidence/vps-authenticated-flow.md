# Live authenticated flow + two release-blocking bugs

**Status:** 19/19 on the real host. The full login → session → protected route
→ logout path works, and the security controls behave correctly.

---

## Bug 5 — a lost admin password was unrecoverable

`create-admin.mjs` correctly refused to overwrite an existing admin (install
idempotency), but that left a real trap: an admin who lost the password could
not sign in to change it, and had no supported way back. The probe hit this
exactly — it set a new password, was silently ignored, and every login returned
401.

**Fix:** an explicit `--reset-password` flag, which is the only path that
rewrites an existing hash. A plain re-run stays idempotent, so the recovery
route cannot be triggered by accident. Tested against the application's real
`verifyPassword`: the new password authenticates, the old one stops working,
no duplicate row is created, and a subsequent plain re-run leaves the reset
password in place.

## Bug 6 — the path rewriter corrupted Next route manifests (release-blocking)

Every `/api/tunnels` call returned **500**:

```
Error: Cannot find module
'/opt/xistance/current/apps/web/.next/server/tunnels/route.js'
```

Next stores a per-route manifest:

```json
{ "/api/tunnels/route": "app/api/tunnels/route.js" }
```

The staging rewriter changed the **value** to `app../../tunnels/route.js`.
The artifact installed cleanly, verified its checksum, passed the manifest
check, reported healthy, and then failed on every tunnels request — the worst
possible failure shape, because everything observable said it worked.

Two separate defects combined:

1. The POSIX pattern fired partway through an already-*relative* path, so a
   value that needed no rewriting got rewritten. A negative lookbehind was not
   enough: `[\w.\-/]` puts the hyphen between `.` and `\/`, which the engine
   reads as a character *range*, so the class did not mean what it looked like.
   Fixed by requiring an explicit leading boundary (quote, bracket, colon,
   comma or whitespace) so a match can only begin at a real filesystem root.

2. The route guard read the wrong capture. The POSIX pattern captures
   `(boundary, root, segment, tail)`, so `groups[2]` was the workspace segment
   (`tunnels/`) rather than the tail (`route`), and every route string passed
   straight through the rewrite. Now the last capture is inspected, and each
   pattern declares its own arity instead of the callback inferring it.

**This function had no test at all** — it edits build output in place and had
never been exercised on a real route manifest. `scripts/test-rewrite-build-paths.ts`
now pins the exact failing input, proves absolute Windows and POSIX paths are
still relocated, and asserts idempotency on a second pass.

Verified non-vacuous: restoring the old pattern fails
`a release-relative route manifest must not be rewritten at all`.

---

## Verified on the host

| Check | Result |
| --- | --- |
| Real login with a correct password | **200** |
| `/api/auth/me` | `SUPER_ADMIN` |
| Password echoed by `/api/auth/me` | not present |
| Protected `/en/tunnels` page | 200 |
| Unauthenticated `/api/tunnels` | 401 (was 500) |
| Session cookie issued | yes |
| CSRF cookie readable by script | yes (double-submit needs that) |
| POST without CSRF header | 403 |
| POST with CSRF header | 422 (reached validation) |
| POST with foreign Origin | 403 |
| POST without Origin | 403 |
| Login from a foreign Origin | refused |
| Invalid login body | 422 |
| Logout | 200 |
| Session after logout | 401 |
| Route manifest on host | `app/api/tunnels/route.js` — uncorrupted |

## Corrections to my own tests

Two of the original probe failures were **my test being wrong, not the app**:

- It required a CSRF cookie on the login page. The token is issued *at login*,
  and the login route is deliberately CSRF-exempt because a client has no
  session yet. Requiring it invented a bug.
- It probed origin enforcement on `/api/auth/login`, which returns 401 before
  the 403 check. Origin enforcement was verified directly on
  `/api/tunnels` — 403 for foreign origin, authenticated and not.

The password is generated on the host, never printed, and not written to any
report or log.

**18/73 tasks passed. TASK-73 has live proof.**
