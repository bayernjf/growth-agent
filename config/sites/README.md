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

All `siteUrl` values are production properties. Domain sources:

- `zeus-landing` → `https://zeus.bayjf.com/` (`zeus-landing/src/consts.ts`
  `SITE_URL`; `zeus-landing/docs/DEPLOYMENT.md` records the live custom domain).
- `job-agent-landing` → `https://job-agent.bayjf.com/`
  (`job-agent-landing/astro.config.mjs` `site`; `job-agent-landing/docs/DEPLOYMENT.md`
  lists the custom domain as the primary entry).
- `bayjf.com` → `https://bayjf.com/`.

`scripts/check-site-urls.mjs` runs in CI and in `npm run check:all`. It fails and
names the offending file + field when any `config/sites/*.json` still points at a
`*.pages.dev` / `*.workers.dev` host or another placeholder form (`example.com`,
`localhost`, `placeholder`, `<...>` templates), so a pages.dev value cannot
silently return. It accepts an optional directory argument, e.g.
`node scripts/check-site-urls.mjs /path/to/host/config/sites`, to audit the
deployment host copy as well.
