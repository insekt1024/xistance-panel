# Admin bootstrap gap fix — a first install had no way to log in

**Status:** fixed and verified locally
**Origin:** found while fixing the migration gap. The migration applier creates
the schema, but a fresh install still had **no account**, so the panel was
unusable even when healthy.

## Root cause

`packages/db/prisma/seed.ts` creates the initial super-admin, but it is
TypeScript and imports the Prisma client, so it cannot run from the release
artifact. The zero-build path therefore deployed a panel with an empty `User`
table.

## Fix

`scripts/create-admin.mjs` — creates the first `SUPER_ADMIN` using `node:sqlite`
and **the identical scrypt scheme the application already verifies against**:

```
scrypt:16384:8:1:<salt base64>:<hash base64>
```

That scheme match is the whole point, and it is proven rather than asserted: the
test imports the real `verifyPassword` from `seed.ts` and checks that a
generated admin authenticates, and that a wrong password does not.

## Verified end-to-end from the staged artifact

Not just the repo script — the artifact's copy, in the installer's order:

```
1. migrations -> applied 20260823214332_init, 11 tables, Tunnel queryable
2. admin      -> created super admin: admin@xistance.local, role SUPER_ADMIN
3. real app verifyPassword:
     AUTH_OK: true      (correct password)
     AUTH_NO: false     (wrong password)
```

## Properties covered by `scripts/test-create-admin.ts`

| Property | Assertion |
| --- | --- |
| Account is a `SUPER_ADMIN` | role read back from the database |
| Authenticates against the **real** `verifyPassword` | imported from `seed.ts`, not reimplemented |
| Wrong password rejected | `verifyPassword("not-the-password", …) === false` |
| Stored scheme matches `seed.ts` | `hashPassword` still yields `scrypt:16384:8:1:` |
| Re-running never rotates a live credential | password hash unchanged, count stays 1 |
| Missing password refused | exit non-zero, "password is required" |
| Invalid email refused | exit non-zero |
| Unique salt | two admins with the same password hash differently |

## Installer behaviour

- Password is generated only when `XT_ADMIN_PASSWORD` is unset.
- It is printed **once**, and only when this run actually created the account —
  the creator's output is captured so a re-install does not print a password
  that was never set.
- An existing admin is never overwritten.
- A missing `create-admin.mjs` aborts the install rather than producing an
  unusable panel.

## Bugs found and fixed

1. **`SqliteStatement.get()` declared with no parameters** in the test's local
   type, so a bound-parameter query failed `tsc`. Fixed the declaration rather
   than weakening the call.
2. **First draft of the installer block invoked the creator twice** (once to
   create, once to probe its output). Replaced with a single captured-output
   call.
3. **`node:sqlite` types absent from this repo's TypeScript version.** The tests
   load the module through `createRequire` with an explicit local interface, so
   they typecheck and still exercise the real module.
4. **`npx tsx -e` did not run the dynamic import** in a shell probe; switched to
   a temp file, which is also how the permanent test does it.

## Recorded gaps

1. **Not yet proven on Linux.** `node:sqlite` on Ubuntu's Node 22 is still
   flagged experimental and may print a warning. Both scripts must be confirmed
   on the VPS.
2. **No password-reset path in the zero-build flow.** A forgotten admin password
   currently requires the source installer or manual SQL.
3. **Demo data is not seeded.** `XT_DEMO=true` seeding lives in `seed.ts` and is
   unavailable to the artifact; a fresh zero-build install is empty apart from
   the admin.
4. **Email is not verified or reset-forced**; it is stored as given.

## Gates

`test-create-admin` green; 8 TS release suites and 3 shell suites green
(installer suite now 23/23); `bash -n` on all shell scripts; version:check,
lint, typecheck and release `tsc` all clean; harness 77/77.
