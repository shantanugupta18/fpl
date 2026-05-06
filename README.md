# FPL Calculator API 

Node.js API to calculate Federal Poverty Level (FPL) percentage and return `consumer_eligible_benefit` for both 2025 and 2026 using Oregon-applicable rules.

## Run locally

```bash
npm install
npm start
```

`npm start` runs in watch mode, so API restarts automatically when code changes.

Development mode:

```bash
npm run dev
```

Default base URL: `http://127.0.0.1:3000`

## Postman quick start

- Method: `POST`
- URL (BASIC): `http://127.0.0.1:3000/fpl/calculate/basic`
- URL (ADVANCE): `http://127.0.0.1:3000/fpl/calculate/advance`
- URL (single route with filter): `http://127.0.0.1:3000/fpl/calculate?mode=BASIC` or `mode=ADVANCE`
- Headers: `Content-Type: application/json`
- Body (raw JSON):

```json
{
  "household_size": 3,
  "household_income": 42000,
  "tax_filing": "Y",
  "is_ai_an": false
}
```

## Request contract

- `household_size`: integer, required, `1..20`
- `household_income`: number, required, `>= 0`
- `tax_filing`: string, required, allowed values: `Y`, `N`
- `is_ai_an`: boolean, optional, default `false`

## Response contract

- Top-level fields:
  - `household_size`
  - `household_income`
  - `tax_filing`
  - `results`
- `results` contains two keys: `2025` and `2026`
- Each year object contains:
  - `year`
  - `fpl_base_value`
  - `fpl_percentage`
  - `consumer_eligible_benefit` (array of strings)

Example response:

```json
{
  "results": {
    "2025": {
      "year": 2025,
      "fpl_base_value": 26650,
      "fpl_percentage": 157.6,
      "consumer_eligible_benefit": [
        "BHP (OHP Bridge)",
        "Child Medicaid/OHP (if child in household)",
        "CSR (Silver plan only)"
      ]
    },
    "2026": {
      "year": 2026,
      "fpl_base_value": 27320,
      "fpl_percentage": 153.73,
      "consumer_eligible_benefit": [
        "BHP (OHP Bridge)",
        "Child Medicaid/OHP (if child in household)",
        "CSR (Silver plan only)"
      ]
    }
  }
}
```

## Endpoints

### POST `/fpl/calculate/basic`

Uses BASIC rule set (original implementation, no AI/AN threshold extension).

### POST `/fpl/calculate/advance`

Uses ADVANCE rule set (includes AI/AN-specific threshold and cost-sharing mapping).
ADVANCE response follows the policy-spec style JSON (same keys as your reference):
- `specVersion`, `jurisdiction`, `effectiveYears`
- `definitions`, `fplBaseValues`, `inputsRequired`
- `programRules`, `messagingRules`, `timingRules`, `decisionOrder`, `outputShape`
- `evaluationByYear` with:
  - `fplPercent`
  - `eligiblePrograms`
  - `ineligibleReasons`
  - `messages`
  - `consumer_eligible_benefit` (compatibility)

ADVANCE request body (policy style):

```json
{
  "year": "ALL",
  "householdSize": 3,
  "household_income": 42000,
  "isPregnant": false,
  "isChild": false,
  "taxFilingStatus": "Y",
  "hasAffordableEmployerCoverage": false,
  "citizenshipImmigrationEligible": true,
  "enrolledInMedicare": false,
  "isAiAn": false
}
```

Notes:
- `year` supports `2025`, `2026`, or `"ALL"`.
- For compatibility, snake_case inputs are also accepted (for example `household_size`, `household_income`, `tax_filing`, `is_ai_an`).

### POST `/fpl/calculate?mode=BASIC|ADVANCE`

Single endpoint with mode filter. Defaults to `BASIC` when `mode` is not provided.

## Route insights

- Use `POST /fpl/calculate/basic` when you want stable baseline behavior without AI/AN-specific threshold expansion.
- Use `POST /fpl/calculate/advance` when you want Oregon AI/AN-aware logic:
  - OHP Bridge extension to `205%` for AI/AN (`is_ai_an=true`)
  - AI/AN marketplace cost-sharing messaging bands.
- Use `POST /fpl/calculate?mode=...` if your client prefers one endpoint and controls behavior by query filter.
- Recommended integration approach:
  - UI/API clients with explicit feature toggle: use `mode=ADVANCE` only where policy-approved.
  - Existing clients needing backward compatibility: continue using BASIC route.

### GET `/health`

Returns service status.

```json
{
  "status": "ok"
}
```

## Oregon eligibility mapping in code

- Adults:
  - `<= 138%` FPL: `Medicaid (OHP Plus)`
- `> 138% and <= 200%` FPL: `BHP (OHP Bridge)`
- If `is_ai_an = true`, OHP Bridge extends to `<= 205%` FPL:
  - `> 200% and <= 205%` FPL: `BHP (OHP Bridge - AI/AN Basic Medicaid)`
- Children (conditional because payload does not include age/member role):
  - `< 163%` FPL: `Child Medicaid/OHP (if child in household)`
  - `>= 163% and <= 300%` FPL: `CHIP (if child in household)`
- Tax filing:
  - `tax_filing = Y` and above OHP Bridge limit:
    - non-AI/AN: `> 200%` FPL
    - AI/AN: `> 205%` FPL
  - `APTC` in those above-threshold cases
  - `tax_filing = Y` and `100% to 250%` FPL: `CSR (Silver plan only)`
  - If `is_ai_an = true` and above OHP Bridge limit:
    - `100% to 300%` FPL: `AI/AN Zero Cost Sharing (Marketplace, 100-300%)`
    - `> 300%` FPL: `AI/AN Limited Cost Sharing (Marketplace, >300%)`
  - `tax_filing = N`: `APTC/CSR not available (non-tax filer)`

## FPL base values (annual 100% FPL)

These values are mapped by `household_size` in `server.js` (`FPL_BASE_VALUES`) for `1..20`.

- 2025:
  - 1: 15650, 2: 21150, 3: 26650, 4: 32150, 5: 37650
  - 6: 43150, 7: 48650, 8: 54150, 9: 59650, 10: 65150
  - 11: 70650, 12: 76150, 13: 81650, 14: 87150, 15: 92650
  - 16: 98150, 17: 103650, 18: 109150, 19: 114650, 20: 120150
- 2026:
  - 1: 15960, 2: 21640, 3: 27320, 4: 33000, 5: 38680
  - 6: 44360, 7: 50040, 8: 55720, 9: 61400, 10: 67080
  - 11: 72760, 12: 78440, 13: 84120, 14: 89800, 15: 95480
  - 16: 101160, 17: 106840, 18: 112520, 19: 118200, 20: 123880

## Validation errors

The API returns `400` with an `error` message for invalid input.

Example:

```json
{
  "error": "tax_filing must be 'Y' or 'N'"
}
```

## References

- 2025 HHS Poverty Guidelines: https://www.govinfo.gov/content/pkg/FR-2025-01-17/html/2025-01377.htm
- 2026 HHS Poverty Guidelines: https://www.govinfo.gov/content/pkg/FR-2026-01-15/html/2026-00755.htm
