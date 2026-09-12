# Market Intelligence Layer

## Purpose

The soccer predictor remains statistically independent from bookmaker prices.
Bookmaker odds are observed only after the core model has produced its own probabilities.
The market data is used to measure how bookmaker movements relate to outcomes and to the model's predictions.

## Independence rule

- Core prediction probabilities do **not** use bookmaker odds as a feature.
- Core training/calibration assigns `marketOdds: 0`.
- Existing value/edge calculations may compare the finished model probability with bookmaker odds, but that comparison does not feed back into the probability itself.
- Market-learning results are reported separately and must not silently change core model weights.

## Competition scope

The shared competition configuration covers only the product's European club scope:

- England: Premier League, Championship, FA Cup, EFL Cup
- France: Ligue 1, Ligue 2, Coupe de France
- Spain: La Liga, Segunda Division, Copa del Rey
- Portugal: Primeira Liga, Liga Portugal 2, Taca de Portugal
- Germany: Bundesliga, 2. Bundesliga, DFB-Pokal
- Italy: Serie A, Serie B, Coppa Italia
- Netherlands: Eredivisie, Eerste Divisie, KNVB Beker
- UEFA Champions League, Europa League, and Conference League

The core predictor covers every competition above. Market intelligence is optional per competition: if The Odds API does not expose a dedicated v4 sport key for a competition, that competition continues to receive independent statistical predictions but no bookmaker snapshot is attached.

## Data captured

The Odds API requires a competition-specific sport key. `soccerService.ts` derives the required sport keys from the active tracked fixtures, fetches only supported competitions, and caches each competition response before the dashboard/background learner can request it again.

Market capture itself adds **zero extra Odds API requests**. It passively reuses the competition odds responses already fetched for the match feed. Unsupported competitions simply return `null` bookmaker odds rather than affecting the core prediction.

For each fixture/bookmaker/time bucket the database stores:

- fixture and league
- teams and kickoff
- bookmaker key/name
- home/draw/away decimal odds
- margin-removed (no-vig) implied probabilities
- capture bucket and observation time

Default capture bucket: 30 minutes.
Default maximum bookmakers per fixture: 4.
Default Odds API cache: 5 minutes per active supported competition.

Environment settings:

```text
MARKET_INTELLIGENCE_ENABLED=true
MARKET_INTELLIGENCE_BUCKET_MINUTES=30
MARKET_INTELLIGENCE_MAX_BOOKMAKERS=4
MARKET_INTELLIGENCE_BOOKMAKERS=pinnacle,betfair_ex_eu,betfair,bet365,unibet_eu,williamhill
ODDS_CACHE_TTL_MS=300000
```

## Market-learning report

`GET /api/market-intelligence/report`

The report compares settled results with:

- the predictor's independent pre-match pick
- bookmaker consensus opening pick
- bookmaker consensus closing pick
- the side receiving the strongest positive implied-probability movement
- disagreement cases where the predictor and closing market pick differ
- larger price movements (default analysis threshold: 2.5 probability points)
- closing-pick accuracy by bookmaker

`GET /api/market-intelligence/fixture/:fixtureId`

Returns the price history and movement analysis for one fixture.

`GET /api/market-intelligence/policy`

Returns the runtime policy confirming that bookmaker data does not feed the core prediction model.

## Database migration

Run:

```bash
pnpm migrate:market-intelligence
```

or the full migration command:

```bash
pnpm migrate
```

The migration is `lib/db/002_market_intelligence.sql`.

## Future learning rule

Market intelligence can be used to discover patterns such as:

- whether sharp late moves tend to identify winners
- which bookmakers lead useful movements
- whether market/model disagreement is informative
- which leagues show the strongest or weakest market signal

Any future use of those findings in the core predictor should be an explicit, separately tested change. The default architecture keeps bookmaker prices outside the prediction formula.
