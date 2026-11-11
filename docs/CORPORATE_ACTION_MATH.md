# Corporate action arithmetic

The exact arithmetic behind expected payments for dividends, splits and
redemptions — the formulas an operator needs to predict a payment to the
smallest unit before reconciling it. The authoritative code is
`dividendEntitlements`, `splitDeltas` and `redemptionDeltas` in
`packages/core/src/distributions.ts`, built on `mulDiv` and `parseRatio` in
`packages/core/src/amount.ts`. [corporate-actions.md](corporate-actions.md)
covers the workflow around the numbers (snapshots, windows, break outcomes);
this document is the arithmetic only. Every worked number below reproduces
with the exported functions, and the dividend and split figures are also the
ones asserted in `packages/core/test/core.test.ts`.

## Conventions

- All amounts are integers in the **smallest unit** of an asset (bigint —
  no floats anywhere). An asset with 7 decimals carries 100 units as
  `1_000_000_000`.
- `baseDecimals` is the decimals of the held asset, `payDecimals` the decimals
  of the asset a dividend is paid in. Both must be integers from 0 to 38.
- A dividend `ratePerUnit` is a decimal string parsed as an **exact rational**
  (`parseRatio`): `"0.0123456789"` is exactly `123456789 / 10^10`. A rate may
  carry more precision than either asset; nothing is lost before the final
  rounding step.
- Holders on the action's `exclude` list (e.g. treasury stock) and holders
  with a zero or negative balance are skipped everywhere below. A holder whose
  computed entitlement rounds to zero is omitted from the result, so they
  cannot produce a `MISSING` break.

## Dividends

For each holder at the record time:

```
entitlement = mulDiv(units, rateNum × 10^payDecimals, rateDen × 10^baseDecimals, rounding)
            = floor(units × rate × 10^payDecimals ÷ 10^baseDecimals)     (rounding = "floor", the default)
```

where `rateNum / rateDen` is the parsed `ratePerUnit`. Rounding is per holder,
at the smallest unit of the **pay** asset, and is the only rounding in the
computation. `rounding` may be `"floor"` or `"half-up"`; the difference shows
only when the exact entitlement has a fractional part of half a smallest unit
or more.

Worked examples (base and pay assets both at 7 decimals, `ratePerUnit =
"0.0123456789"`, floor):

| Holding | Exact entitlement | Expected (smallest units) |
|---|---|---|
| 100 units | 1.23456789 pay units | `12_345_678` |
| 50 units | 0.617283945 pay units | `6_172_839` (exact 6_172_839.45, floored) |
| 3 smallest units | 0.000000037… pay units | 0 — holder omitted |

Changing only the pay asset's decimals rescales the result, not the rate:
50 units at rate `"1"` paid at 2 decimals gives
`floor(50 × 10^7 × 1 × 10^2 ÷ 10^7) = 5000` smallest units (50.00).

Floor versus half-up, same rate: a holder of 15 units has an exact entitlement
of 1_851_851.835 smallest units — `floor` yields `1_851_851`, `half-up`
yields `1_851_852`.

## Splits

For a split of `num : den` (forward when `num > den`, reverse when
`num < den`):

```
new   = floor(units × num ÷ den)
delta = new − units
```

Splits always floor — there is no rounding option. The dropped part is not
lost silently: `splitDeltas` also returns, per holder, the remainder
`(units × num) mod den`, which is the dropped fraction expressed in
`den`-ths of the smallest unit. Every remainder in one split shares the same
denominator, so the remainders add up exactly to the total dropped.

Worked examples:

| Holding | Split | New balance | Delta | Dropped fraction |
|---|---|---|---|
| 3 smallest units | 3:2 | 4 | +1 | 1/2 of a smallest unit |
| 7 smallest units | 3:2 | 10 | +3 | 1/2 of a smallest unit |
| 5 smallest units | 1:10 (reverse) | 0 | −5 | 5/10 of a smallest unit |

## Redemptions

For a pro-rata redemption of `num / den` of every holding (the fraction must
be in (0, 1]; `1/1` redeems the asset in full):

```
removed = floor(units × num ÷ den)
delta   = −removed
```

Redemptions always floor, like splits. Example: a 1:2 redemption of a holding
of 7 smallest units removes `floor(7 × 1 ÷ 2) = 3`; the holder keeps 4.

## Execution windows

Expected amounts are only half the question — reconciliation compares them
against flows observed in the action's execution window (`FlowWindow` in
`packages/core/src/distributions.ts`):

- Ledger bounds `fromLedger` / `toLedger` are **inclusive** on both ends.
- The time lower bound (`afterTime`, normally the record time) is
  **exclusive**: an event stamped exactly at the record time belongs to the
  snapshot basis, not to the execution.
- The time upper bound (`untilTime`) is **inclusive**.
- With no upper bound the window is open-ended: an unpaid entitlement is
  "not yet", not a break, until the operator closes the window.

## Limits

- **Cash in lieu is not modelled.** When a split or redemption drops a
  fraction of the smallest unit, the fraction is simply not paid. For splits
  the dropped remainders are reported (above) so an auditor can quantify what
  holders lost — e.g. as the cash-in-lieu basis for a reverse split — but
  Concord computes no cash payment for them.
- **Fractions of the smallest unit are unrepresentable.** Anything below one
  smallest unit of the relevant asset drops, in every action type.
- **Inputs are validated, not coerced.** Decimals outside 0–38, a split ratio
  with a non-positive part, or a redemption fraction outside (0, 1] throw
  instead of silently producing numbers.
- **Rates are exact, balances are snapshots.** The arithmetic is exact given
  the record-time snapshot; questions about *which* snapshot (record time,
  exclusions, late indexing) are covered in
  [corporate-actions.md](corporate-actions.md).
