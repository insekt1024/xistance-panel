# TASK-5 red-phase evidence

Date: 2026-09-24

- Test: `npx tsx scripts/test-release-artifact.ts`
- Expected failure: `ERR_MODULE_NOT_FOUND` for the not-yet-created `scripts/inspect-release-artifact.ts`.
- The fixture contains a standalone-style app, static chunks, and public assets but intentionally omits the release manifest; the future test will assert a structured rejection.
- No production implementation existed at the time of the red run.
- No secrets, credentials, database values, or environment-file values were used.
