# Fundup AI Mock API

A local, zero-dependency mock of the [Fundup AI API v1.4.0](https://fundup.ai/api/docs/), backed by
`data/fundings.json` — a real dump of 1,738 funding events pulled from `GET /fundings`. It mirrors
the real API's routes, query parameters, pagination envelope, auth, and error response shapes, so
you can point client code at it instead of the real service for testing.

## Run it

```
npm start
# or: node server.js
```

Listens on `http://localhost:4010/api/v1` by default. Override with `PORT` and
`FUNDUP_MOCK_API_KEY` env vars (default key: `test_api_key_123`).

Auth works exactly like the real API: send `Authorization: Bearer <key>`, or get a 401
`{"error":"Invalid API key"}`.

```
curl -H "Authorization: Bearer test_api_key_123" \
  "http://localhost:4010/api/v1/fundings?funding_date_start=2026-01-01&funding_date_end=2026-12-31&limit=10"
```

## What's faithfully implemented

- **Endpoints**: `/health`, `/fundings`, `/companies`, `/companies/{id}`, `/companies/{id}/fundings`,
  `/companies/{id}/contacts`, `/companies/{id}/tech-stack`, `/companies/{id}/highlights`,
  `/companies/{id}/news`, `/companies/{id}/open-roles`, `/filters`, `/stats`.
- **Required params**: `funding_date_start`/`funding_date_end` on `/fundings` and `/companies` return
  a 400 if missing.
- **Filtering** (backed by real fields in the dump): date range, `stages`, `countries`, `industries`,
  `currency`, `tags`, `min_amount`/`max_amount` (accepts `"1M"`, `"500K"`, `"2.5B"` shorthand),
  `search` (name/description/industry).
- **Pagination**: `limit` (1–50) / `offset` (0–499), capped at 500 total accessible records, same
  `{data, pagination: {limit, offset, total, has_more}}` envelope as the real API. Out-of-range
  values return 400.
- **Auth**: Bearer token, 401 on missing/invalid.
- **Rate limiting**: the per-minute limit (20 req/min) is actually enforced and returns the real
  429 shape (`rate_limit_exceeded`, `retry_after`, etc.) once tripped. Only 2xx responses count
  against it, matching the documented behavior.
- **404s**: match each endpoint's documented shape (`Company not found`, `CONTACTS_NOT_AVAILABLE`,
  `HIGHLIGHTS_NOT_FOUND`, `NEWS_NOT_FOUND`, `Tech stack not found`).
- **`/filters`**: values (countries, industries, stages, currencies, tags) are derived from what's
  actually in the dump, not hardcoded — so dropdowns in your test UI reflect real values.

## Known gaps (the dump doesn't contain this data)

These are accepted-but-inert or always-empty, since `data/fundings.json` genuinely has no such
fields to serve from:

- **`technologies`, `company_size`, `validated_contacts`, `investors`, `has_open_roles` (+
  `hiring_departments`/`hiring_seniority`/`hiring_role_type`)** filters: accepted as query params
  but not applied (no-op), since the dump has no tech-stack, headcount, contact-reveal, investor,
  or hiring data.
- **Contacts, tech-stack, highlights, news, open-roles**: always return the real API's "not
  available" response for every company (rather than fabricating fake contacts/news), since none of
  that data exists in the dump. Real API responses for these are populated only for companies you've
  actually looked up through Fundup — that data was never captured in this dump.
- **`countries` filter matches full country names** (e.g. `"Sweden"`, `"United States"`), not
  2-letter ISO codes as the real docs describe — the dump's `country`/`country_name` fields are
  identical full names with no ISO code present.
- **`/companies/{id}/fundings` `fundingAmountUsd`**: only populated when currency is already USD
  (no FX rates available to convert other currencies).
- **`/stats`**: `per_minute` is a live, enforced counter. `daily`/`monthly`/`monthly_export`/
  `daily_company_detail`/`monthly_pagination` are surfaced for shape-compatibility but not enforced
  as hard limits.
- **400 error bodies** are slightly more descriptive here (`{"error": "Bad Request", "message":
  "..."}`) than the real API's documented (and rather bare) `{}` example — useful for debugging
  your own client, since the doc doesn't specify real body content for that case.

## Files

- `server.js` — the whole server (Node built-ins only, no npm install needed).
- `data/fundings.json` — your dumped dataset; swap in a fresher dump anytime and restart.
