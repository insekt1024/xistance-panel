# XUI suite: a test that asserted a correct security control was broken

## The failure

`scripts/test-xui.ts` reported `48 passed, 1 failed`:

```
FAIL 203.0.113.10 is not private
     reported private
```

## The cause was the test, not the guard

`apps/web/src/lib/ssrf.ts` classifies `203.0.113.0/24` correctly, at line 131:

```ts
if (a === 203 && b === 0) return true; // TEST-NET-3
```

The assertion listed `203.0.113.10` among **public literals that must be
allowed**. It is not public. `203.0.113.0/24` is TEST-NET-3, a reserved
documentation range (RFC 5737), and it can never host a reachable service. So
the suite was asserting that a correct SSRF guard was defective.

No source change was made, because none was warranted.

## Why this matters beyond the red suite

The list was not merely mislabelled — it encoded the wrong model of the guard.
Anyone reading `["8.8.8.8", "1.1.1.1", "203.0.113.10", ...]` as *the public
addresses* would conclude that documentation ranges are outside the filter's
scope. They are inside it, deliberately, and the distinction is the point: a
range that cannot host a real service should never be a dial target.

The replacement assertions encode the model explicitly, in both directions:

- routable literals (`8.8.8.8`, `1.1.1.1`, `93.184.216.34`,
  `2001:4860:4860::8888`) must be allowed
- all four documentation/benchmark ranges (`192.0.2.1`, `198.51.100.1`,
  `203.0.113.1`, `198.18.0.1`) must be refused as reserved

## Non-vacuity

The new refusal assertion is proven by mutation. Deleting the TEST-NET-3 line
from the guard:

```
mutant:  FAIL 203.0.113.1 (reserved documentation range) is blocked
         --- 49 passed, 1 failed ---   exit 1
```

The source was restored (`grep -c TEST-NET-3` → 1) and the suite returns to
**50 passed, 0 failed**, exit 0.

Note that this assertion was written conditionally, not as a bare `ok()`. A
first draft printed a success line unconditionally, which would have passed even
if every reserved range were allowed — the same vacuity that made the original
assertion wrong in the opposite direction.

## Wider context

This is the third time in this effort a **stale or inverted expectation** produced
a red suite rather than a real defect (the other two were the XUI diagnostic
ordering and an Origin matrix case). A failing suite is evidence of a problem
somewhere, not evidence of a problem in the code under test — the test is part
of the system, and it is the more likely defect when the code has already been
reviewed and the failure contradicts its own docstring.
