# Step 1 verification

CONTEXT.md was compared byte-for-byte with the context section of the Step 1 brief.

66 tests passed via node --test. Coverage includes the normal CDF, monotone expiry pricing, continuous-barrier Monte Carlo within 1.5 percentage points, 14/30/90-day volatility, implied-volatility round trips and multiple roots, 18 representative claim phrases plus edge cases, cache/pagination, missing/crossed quotes, injected-fetch engine paths, and validated AI selection using fixtures.

The optional Anthropic API was tested with mocked responses; no live key was configured. Crypto runs below used no keys and real Gemini responses. Full CLI output is saved locally in output/step-1-btc.json and output/step-1-eth.json. These are observations at the given timestamps, not data used by the application.

Commands:

```sh
node scripts/try.js "Bitcoin to 150K by end of month, guaranteed"
node scripts/try.js "ETH is about to dump under 2,000 this week"
```

Observed results:

```json
[
  {
    "asset": "BTC",
    "checkedAt": "2026-10-11T19:41:59.195Z",
    "spot": 83658.67,
    "deadline": "2026-10-31T21:00:00.000Z",
    "days": 20.054175983796295,
    "speaker": 0.97,
    "marketStrike": 92500,
    "marketProb": 0.08,
    "source": "bid/ask midpoint",
    "atExpiry": {
      "lo": 7.147507736610538e-25,
      "hi": 5.305703437189925e-11
    },
    "touch": {
      "lo": 1.433230170373729e-24,
      "hi": 1.0682555318881843e-10
    },
    "verdict": "HYPE",
    "comparison": "FAIR"
  },
  {
    "asset": "ETH",
    "checkedAt": "2026-10-11T19:41:58.704Z",
    "spot": 2535.02,
    "deadline": "2026-10-11T21:00:00.000Z",
    "days": 0.05418166666666667,
    "speaker": 0.85,
    "marketStrike": 2360,
    "marketProb": 0.030000000000000027,
    "source": "complement of YES bid only",
    "atExpiry": {
      "lo": 0,
      "hi": 4.032205565446974e-294
    },
    "touch": {
      "lo": 0,
      "hi": 8.063782239553593e-294
    },
    "verdict": "HYPE",
    "comparison": "INSUFFICIENT QUOTES"
  }
]
```

The nearest contract's probability is not the exact target's odds. Bounds are indicative and only valid at the same expiry. The ETH quote is one-sided, so market mispricing is not assessed. “This week” resolves to Sunday at 21:00 UTC, making this ETH example a short-horizon prediction on October 11.

Historical note: this report covered the original Step 1 scope. The current product is the mobile web app with iPhone sharing; see mobile-verification.md for the subsequent release checks.
