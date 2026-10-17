# Performance baseline

Benchmarks for the in-memory paths in `packages/core`, run with:

```
pnpm bench
```

The data is generated from a fixed seed (100,000 events, 10,000 holders), so runs are comparable. Numbers vary by machine; treat them as a baseline for spotting regressions, not as a guarantee.

## Environment

- Runner: GitHub Actions `ubuntu-latest`
- Node: 24
- Date recorded: TODO

## Results

| Benchmark | mean (ms) | p99 (ms) | ops/sec |
| --- | --- | --- | --- |
| `replay`, events already in id order | TODO | TODO | TODO |
| `replay`, events in random order | TODO | TODO | TODO |
| `reconcilePositions`, register matches chain | TODO | TODO | TODO |
| `reconcilePositions`, 1% of holders mismatched | TODO | TODO | TODO |

## Notes

- `replay` copies and re-sorts the full event array on every call (`sortEvents`), so its cost grows with event count even when the input is already ordered.
- `reconcilePositions` sorts all addresses once and builds one line per address.
- The CI `bench` job is advisory (`continue-on-error`) and does not fail the build.
