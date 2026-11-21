# CFTC Commitments of Traders and Revisions

Get weekly open interest and positions by trader category from the U.S. Commodity Futures Trading Commission (CFTC). Use the Actor to update a positioning dashboard, compare market exposure across weeks or alert when the CFTC revises a value used in a report.

## Input

Run with `{}` to retrieve the latest Disaggregated Futures Only rows for corn (`002602`), WTI crude oil (`067651`) and gold (`088691`).

| Input | Behavior |
| --- | --- |
| `reports` | Select one or more of the six official report variants below. The default is `disaggregated_futures_only`. |
| `contractCodes` | Up to 10 exact CFTC contract market codes as strings. An empty list includes all codes. Omitting this field for Disaggregated Futures Only with no name or group filter selects the three default contracts. |
| `marketNameContains` | Case-insensitive literal substring of the market and exchange name. |
| `commodityGroups` | Case-insensitive names such as `AGRICULTURE`, `NATURAL RESOURCES` or `FINANCIAL INSTRUMENTS`. Any listed group matches. |
| `from`, `to` | Inclusive CFTC report dates in `YYYY-MM-DD` format. |
| `latestOnly` | Defaults to `true`. Selects the latest date in bounds for each report, then applies the market filters. A valid filter can produce zero rows. Set to `false` for history. |
| `onlyNew` | Defaults to `false`. Set to `true` to emit first observations and revisions. |
| `stateKey` | Defaults to `default`. Use 1–50 letters, digits, underscores or hyphens to select the persistent monitoring baseline. |

History queries cover up to 52 weeks. With no `to`, the latest available date anchors the interval. With no `from`, the interval starts 52 weeks before the end date, counting the end date inclusively. Market filters are combined with AND.

| Report value | CFTC view |
| --- | --- |
| `disaggregated_futures_only` | [Disaggregated Futures Only (`72hh-3qpy`)](https://publicreporting.cftc.gov/d/72hh-3qpy) |
| `disaggregated_combined` | [Disaggregated Combined (`kh3c-gbw2`)](https://publicreporting.cftc.gov/d/kh3c-gbw2) |
| `legacy_futures_only` | [Legacy Futures Only (`6dca-aqww`)](https://publicreporting.cftc.gov/d/6dca-aqww) |
| `legacy_combined` | [Legacy Combined (`jun7-fc8e`)](https://publicreporting.cftc.gov/d/jun7-fc8e) |
| `tff_futures_only` | [Traders in Financial Futures (TFF) Futures Only (`gpe5-46if`)](https://publicreporting.cftc.gov/d/gpe5-46if) |
| `tff_combined` | [TFF Combined (`yw9f-hn96`)](https://publicreporting.cftc.gov/d/yw9f-hn96) |

Compare two weeks of futures-only and futures-and-options reports for euro FX.

```json
{
  "reports": ["tff_futures_only", "tff_combined"],
  "contractCodes": ["099741"],
  "from": "2026-11-10",
  "to": "2026-11-17",
  "latestOnly": false
}
```

Track weekly corn positions and revisions using a persistent baseline.

```json
{
  "reports": ["disaggregated_futures_only"],
  "contractCodes": ["002602"],
  "onlyNew": true,
  "stateKey": "corn-weekly"
}
```

## Output

The default dataset contains one row per report variant, contract market code and CFTC report date. `openInterestChange` is the CFTC's change from the preceding report. Positions use the CFTC's total across maturities. Within each category, `long`, `short` and `spreading` each expose `position`, `change`, `percentOfOpenInterest` and `traders`. Missing and unpublished measures are `null`. `fetchedAt` is the UTC retrieval timestamp.

Example corn snapshot with one of the position categories shown.

```json
{
  "reportType": "disaggregated_futures_only",
  "reportDate": "2026-11-17",
  "contractCode": "002602",
  "marketName": "CORN - CHICAGO BOARD OF TRADE",
  "commodityGroup": "AGRICULTURE",
  "openInterest": 1954229,
  "positions": {
    "producerMerchant": {
      "long": { "position": 466484, "change": 2645, "percentOfOpenInterest": 23.9, "traders": 353 },
      "short": { "position": 838543, "change": -24424, "percentOfOpenInterest": 42.9, "traders": 346 },
      "spreading": { "position": null, "change": null, "percentOfOpenInterest": null, "traders": null }
    }
  },
  "fetchedAt": "2026-11-22T00:00:00.000Z",
  "source": "https://publicreporting.cftc.gov/resource/72hh-3qpy.json",
  "changeType": "snapshot"
}
```

## Monitoring

With `onlyNew`, first observations have `changeType: "new"`. Changes to previously emitted rows have `changeType: "revision"`, `rowHash`, `previousRowHash` and `changedFields`. Each changed field has a dotted path and its previous and current values, for example `{"field":"positions.managedMoney.long.position","previous":100,"current":110}`. Unchanged rows are skipped.

With `latestOnly`, each run also rechecks dates it already reported within `from` and `to`. Older dates become eligible for first observations in history mode. Revisions reflect values observed in matching CFTC rows, so intermediate versions between runs and withdrawn rows produce no event. Use the same `stateKey` across runs and distinct keys for independent monitors. In local testing, run a given key sequentially.

The Actor commits the baseline after all pages and dataset writes succeed. If a run fails, the next run compares against the last committed baseline. Consumers should read datasets from successful runs.

## Source and terms

Data source is the U.S. Commodity Futures Trading Commission's Public Reporting Environment. The Actor selects and normalizes published aggregate figures. It is an independent implementation. CFTC requests acknowledgment when reusing its public-domain government information. [CFTC COT reports](https://publicreporting.cftc.gov/stories/s/r4w3-av2u) · [CFTC Web Policy](https://www.cftc.gov/WebPolicy/index.htm)

The Actor uses the anonymous Socrata API. It sends requests sequentially with at least 2.3 seconds after each response and honors `Retry-After` on retries. [Socrata rate limits](https://dev.socrata.com/docs/app-tokens.html) · [CFTC robots.txt](https://publicreporting.cftc.gov/robots.txt)

## Local development

Run `npm ci`, `npm test`, `apify validate-schema` and `apify run --purge` from this directory with Node.js 22. The unit tests run without network access using responses from five CFTC API calls.

## 日本語概要

米商品先物取引委員会（CFTC）が公表する週次の建玉を、レポート種別・契約コード・報告日で取得します。既定では Disaggregated Futures Only の最新週からトウモロコシ、WTI 原油、金を取得します。`onlyNew` を有効にして同じ `stateKey` で定期実行すると、新規行と報告済みの行に対する訂正が出力されます。
