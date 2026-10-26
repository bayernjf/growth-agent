# Dogfood site configs (T-H1)

One JSON file per site. The daily runner loads every `*.json` here with
`loadSiteConfigs()` and fails closed on any invalid field.

Fields:

- `id` — stable site id; also used as the GSC site id in storage.
- `gsc.siteUrl` — **exact** Search Console property URL, including protocol
  and trailing slash (verify it against the property in GSC).
- `serp.locationCode` / `serp.languageCode` — DataForSEO integer location
  code and ISO language code; free-text location/language are labels only.
- `github.owner` / `repo` / `baseBranch` — where the bot opens PRs.
- `watchQueries` — queries rank-tracked daily.
- `keywordSeeds` — seeds for write-candidate expansion.

NOTE: the two `*-landing` GSC `siteUrl` values are pages.dev placeholders
(`zeus-landing.pages.dev` / `job-agent-landing.pages.dev`); replace them with
the actual verified GSC property URLs before switching GSC online.
