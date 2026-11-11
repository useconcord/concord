# User guide: recording dividends, splits and redemptions

How to fill in the **New action** form (Actions tab) and what Concord does with
each field. The form's field names are terse; this guide explains each one,
what leaving it empty does, and — with one worked example per action type —
exactly which rows to expect in the reconciliation result.

Background reading: [corporate-actions.md](corporate-actions.md) describes the
engine (snapshots, windows, break outcomes) and
[CORPORATE_ACTION_MATH.md](CORPORATE_ACTION_MATH.md) gives the exact formulas.
This guide is the operator-facing version. Examples use placeholder addresses
(`G…A`, `G…B`, …) and an asset with 7 decimals.

## The fields

| Field | Meaning | If left empty / default |
|---|---|---|
| **Type** | `Dividend or distribution`, `Split`, or `Redemption`. | — (always set) |
| **Record time** | The instant that fixes who is entitled and for how much. Holdings are snapshotted at this time; payments to people who bought afterwards do not count, and holders who sold afterwards are still entitled. | Required. |
| **Execution window ends** | The end of the window in which payments are counted. Payments after this instant are ignored. | **Open-ended**: payments keep counting on every re-reconciliation until you set an end, so an unpaid holder reads as "not yet paid" rather than broken. Set an end when the terms have a payment deadline and you want unpaid holders to surface as breaks. |
| **Label** | A name for lists and reports. | The action is titled from its terms, e.g. `Dividend 0.25 per unit`, `Split 2:1`, `Redemption 1/4`. |
| **Exclude list** (asset settings, not this form) | Holders with no entitlement, e.g. treasury stock. They get no expected row. | Only the asset's configured ignore list applies. |

Dividend-only fields:

| Field | Meaning | If left empty / default |
|---|---|---|
| **Rate per unit** | Pay-asset units paid **per one whole unit held** — `0.25` means a holder of 100 units is owed 25 pay-asset units. Any precision is accepted and treated exactly (never as a float). | Required for dividends. |
| **Paid in** | The asset the dividend is paid in, chosen from the watched assets on the same network. Selecting the asset itself (marked *(in kind)*) is a stock dividend paid in more of the same asset; selecting another asset (e.g. USDC) is a cash-style dividend. | Defaults to the asset itself (in kind). |
| **Paying agent address** | The address that sends the payments. When set, **only transfers sent by this address** count as payments; transfers between holders in the window are ignored. | **Empty counts mints instead.** On Stellar, a distribution paid by the pay asset's own issuer appears as a mint, not a transfer — so leave this empty when the issuer pays directly, and set it when a separate paying agent sends the money. |

Split and redemption fields:

| Field | Split | Redemption |
|---|---|---|
| **New units / Units redeemed** (`num`) | Units after the split per… | Units redeemed per… |
| **Old units / Out of** (`den`) | …units before it. `2` / `1` is a 2:1 forward split; `1` / `10` is a 1:10 reverse split. | …units held. `1` / `4` redeems a quarter of every holding; `1` / `1` redeems in full. |

## Why an action sits at "scheduled"

If the **Record time** is in the future — or simply later than the chain data
indexed so far — the action's state is `scheduled` and nothing is computed
yet. Concord will not snapshot holdings from an index that could still be
missing events: entitlements computed too early could silently use the wrong
balances. Once a sync pass has indexed past the record time, the snapshot
freezes (ledger, time, and every holder's units are stored on the action) and
the action reconciles automatically. Later re-reconciliations always reuse
that frozen snapshot, so the entitlement basis never shifts under you.

## Rounding, in one paragraph

Entitlements are computed per holder and rounded **down** (floor) to the
smallest unit of the asset involved — dividends to the smallest unit of the
pay asset, splits and redemptions to the smallest unit of the held asset.
A holder whose entitlement floors to zero gets no expected row. Fractions of
the smallest unit are dropped, and **cash in lieu is not modelled**: Concord
never expects a cash payment for a dropped fraction. (For splits the dropped
remainders are recorded, so an auditor can see exactly what was lost.) If your
issuer rounds fractions *up* instead, expect one-smallest-unit `EXCESS` breaks
— the report is telling the truth, not miscalculating.

## Worked example 1 — cash dividend paid in USDC

Terms: asset ACME, **Rate per unit** `0.25`, **Paid in** USDC (7 decimals),
**Paying agent address** `G…PAY`. Holdings at the record time: `G…A` 100,
`G…B` 50, `G…C` 0.0000003 (3 smallest units).

Expected rows (entitlement = floor(holding × 0.25)):

| Holder | Expected |
|---|---|
| `G…A` | 25.0000000 USDC |
| `G…B` | 12.5000000 USDC |
| `G…C` | — (floor(3 × 0.25) = 0 smallest units; no row) |

What counts as payment: USDC **transfers sent by `G…PAY`** inside the window.
If `G…A` receives 25.0 the line is `ok`; 24.9 is `SHORT`; a payment to `G…D`,
who held nothing at the record time, is `UNEXPECTED`.

## Worked example 2 — in-kind dividend (paid in the asset itself)

Terms: **Rate per unit** `0.05`, **Paid in** ACME *(in kind)*, **Paying agent
address** left **empty** — the issuer pays directly, so payments surface as
mints. Same holdings as above.

Expected rows:

| Holder | Expected |
|---|---|
| `G…A` | 5.0000000 ACME |
| `G…B` | 2.5000000 ACME |
| `G…C` | — (floors to 0; no row) |

What counts as payment: **mints** of ACME to each holder inside the window.
A transfer of ACME from another holder does *not* count — with no paying
agent set, only issuance does.

## Worked example 3 — 2:1 split

Terms: **New units** `2`, **Old units** `1`. Same holdings.

Expected rows (new balance = floor(holding × 2 ÷ 1); the expected flow is the
delta):

| Holder | Balance after | Expected flow |
|---|---|---|
| `G…A` | 200 | +100 (mint) |
| `G…B` | 100 | +50 (mint) |
| `G…C` | 0.0000006 | +0.0000003 (mint) |

What counts: **mints** add, **clawbacks** subtract. A holder of 3 smallest
units in a *3:2* split would land on floor(3 × 3 ÷ 2) = 4 smallest units — the
half unit is dropped, not paid out (see Rounding above).

## Worked example 4 — partial redemption (1 of 4)

Terms: **Units redeemed** `1`, **Out of** `4` — a quarter of every holding is
redeemed. Same holdings, plus `G…D` with 0.0000007 (7 smallest units).

Expected rows (removed = floor(holding × 1 ÷ 4), computed in smallest units):

| Holder | Redeemed | Balance after |
|---|---|---|
| `G…A` | 25 | 75 |
| `G…B` | 12.5 | 37.5 |
| `G…C` | — (floor(3 ÷ 4) = 0; no row) | 0.0000003 |
| `G…D` | 0.0000001 (floor(7 ÷ 4) = 1 smallest unit) | 0.0000006 |

What counts: **burns and clawbacks** from each holder inside the window.
Note where flooring bites: `G…B`'s 12.5 is exact in smallest units, so
nothing drops; the drop appears only when the division leaves a fraction of
the *smallest* unit, as with `G…D` (1.75 → 1) and `G…C` (0.75 → 0).
