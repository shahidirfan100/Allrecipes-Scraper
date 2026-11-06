# Allrecipes discovery notes

Last verified: 2026-11-06

This file records what the scraper was rebuilt against. It is a technical record, not legal advice. Allrecipes is operated by People Inc., and its terms restrict automated collection. Use this scraper only for public recipe data you are allowed to collect.

## Environment

| Item | Value |
|------|-------|
| Local Node.js | 26.13.0 |
| Container Node.js | 22 |
| impit | 0.14.8 |
| apify SDK | 3.7.2 |
| cheerio | 1.2.0 |

## Selected sources

Recipe:

| Order | Source | Use |
|-------|--------|-----|
| 1 | Recipe page HTML | Full JSON-LD block plus server-rendered ingredients, steps, details, and nutrition |
| 2 | Deferred component endpoint | Fallback when the recipe HTML is incomplete or changes |

Search:

| Order | Source | Use |
|-------|--------|-----|
| 1 | Search page HTML | 24 unique recipe links per page, offset pagination, next-page link |
| 2 | Search component endpoint | Fallback when the search HTML returns no usable links |

A plain HTTP client without browser fingerprinting gets a 402 block page from People Inc. impit profiles return the normal site. No mobile app API was found.

## Sources checked

Live probes on 2026-11-06:

| Target | Result |
|--------|--------|
| `https://www.allrecipes.com/search?q=chicken` | 200, about 379 KB, 24 unique recipe links |
| `https://www.allrecipes.com/recipe/8858/cream-of-chicken-breasts/` | 200, about 519 KB, complete JSON-LD and recipe markup |
| `https://m.allrecipes.com/` | DNS failure |
| `https://mobile.allrecipes.com/` | DNS failure |
| `https://api.allrecipes.com/` | DNS failure |
| `https://api.allrecipes.com/v1/recipes` | DNS failure |
| `https://www.allrecipes.com/api/` | 301 to `/api` |
| `https://www.allrecipes.com/api/v1/recipes` | 404 HTML page |
| `https://www.allrecipes.com/graphql` | 404 HTML page |
| `https://www.allrecipes.com/search/api?q=chicken` | 404 HTML page |
| `https://www.allrecipes.com/recipe/.../.json` | 404 HTML page |

Public repository survey:

| Repository | Approach | Result |
|------------|----------|--------|
| `turbotoad12/py-allrecipes` (2025) | `requests` plus BeautifulSoup on search and recipe HTML | Uses the same HTML surfaces |
| `remaudcorentin-dev/python-allrecipes` (2024) | urllib plus BeautifulSoup | Uses the same HTML surfaces |
| `dtrungtin/actor-allrecipes-scraper` (2024) | Apify CheerioCrawler | Uses search cards and recipe selectors |
| `VastHornet/allrecipes-*` (2026) | README-only repositories | No implementation to reuse |

No repository documented a mobile, GraphQL, or JSON search endpoint that works today. The usable source remains the public HTML and its deferred component endpoint.

## Search pages

Base URL:

```text
https://www.allrecipes.com/search?q=<query>&offset=<0,24,48,...>
```

Observed behavior:

| Item | Value |
|------|-------|
| Unique recipe links per page | 24 on most queries, sometimes fewer when a result is duplicated |
| Recipe link pattern | `/recipe/<id>/<slug>/` |
| Pagination control | `#mntl-pagination_1-0`, five-page window |
| Next-page signal | An `a` with `aria-label` containing "next page", or `.mntl-pagination__item--next a` |
| Page size as a stop signal | Not reliable: page 1 for `vegan soup` had 23 unique links and page 2 still existed |
| No-results signal | HTTP 404, or page text containing "no results", "0 results", or "couldn't find" |
| Overlap between pages | Possible, so deduplicate by canonical URL |

The scraper reads the next-page link first and falls back to the old page-size rule only when the pagination markup is absent. `max_pages` still caps the loop.

Search pages also contain gallery links. Galleries are a secondary discovery source with a small expansion limit.

## Search component endpoint

Working request:

```text
POST https://www.allrecipes.com/search?q=<query>&offset=<offset>&url=<encoded searchUrl>
```

Component keys:

```text
mntl-search-results__list_1,mntl-pagination_1
```

The response was 108,337 bytes of JSON. Keys matched the requested names, and the payload contained recipe links. The same link extractor runs on the HTML strings inside the JSON.

## Recipe pages

The recipe page contains:

- One `script[type="application/ld+json"]` block with `@type: ["Recipe"]` or `@type: "Recipe"`.
- Server-rendered ingredient markup under `.mm-recipes-structured-ingredients__list-item`.
- Server-rendered instruction markup under `.mm-recipes-steps__content` and `.mntl-sc-block-group--LI`.
- Details, rating, review count, photo count, category, cuisine, breadcrumbs, and nutrition blocks.

The extractor accepts string and array `@type` values and merges supporting JSON-LD nodes, including `BreadcrumbList`, when the recipe node does not carry every field.

## Deferred component endpoint

Working request:

```text
POST <recipeUrl>?url=<encoded recipeUrl>&cr=<comma-separated component keys>
```

Headers observed in a working request:

```text
origin: https://www.allrecipes.com
referer: <recipeUrl>
x-requested-with: XMLHttpRequest
content-type: application/x-www-form-urlencoded; charset=UTF-8
```

Body:

```text
globeDeferVersion=2&cr=<keys>&loaded_cr=&cis=1&force_cis=&pv=undefined&CSRFToken=<token>
```

The response was 50,601 bytes of JSON. The page exposes `window.Mntl.csrfInit('<token>', true)`, and the same value is set as the `CSRFToken` cookie. On 2026-11-06 the endpoint returned usable JSON with the inline token, with the cookie token, and with no token at all. The scraper still sends the token when it can find one, so a future token requirement does not need a code change.

Component key findings:

| Key | Status |
|-----|--------|
| `allrecipes-schema_1` | Returns the full JSON-LD block, about 14.5 KB |
| `mm-recipes-structured-ingredients_1` | Not used; the schema block carries the ingredients |
| `mm-recipes-steps_1` | Not used; the schema block carries the steps |
| `mm-recipes-steps__content_1` | Returns step markup when requested |
| `mm-recipes-details_1` | Works |
| `mm-recipes-nutrition-facts-summary_1` | Works |
| `mm-recipes-nutrition-facts-label_1` | Works |
| `article-preheading_1` | Works |
| `article-header--recipe_1` | Works |
| `mntl-article-meta-dynamic_1` | Works |
| Review bar rating, rating count, comment count, photo count | Work |

Fallback key list used by the scraper:

```text
allrecipes-schema_1,article-preheading_1,article-header--recipe_1,mntl-article-meta-dynamic_1,mm-recipes-review-bar__rating_1,mm-recipes-review-bar__rating-count_1,mm-recipes-review-bar__comment-count_1,recipe-review-bar__photo-count_1,mm-recipes-details_1,mm-recipes-nutrition-facts-summary_1,mm-recipes-nutrition-facts-label_1
```

## Browser profile matrix

Tested with impit 0.14.8 on 2026-11-06 against the chicken search page and the cream of chicken recipe page. Each profile made four requests: two rounds over both pages, a fresh client per request, and a 0.9s gap between requests. A pass means HTTP 200, the expected markup, and no block markers. Times are milliseconds.

| Profile | Passes | Avg | Max |
|---------|--------|-----|-----|
| `chrome151` | 4/4 | 568 | 694 |
| `chrome142` | 4/4 | 530 | 609 |
| `firefox158` | 4/4 | 606 | 886 |
| `chrome110` | 4/4 | 520 | 572 |
| `chrome100` | 4/4 | 520 | 592 |
| `chrome116` | 4/4 | 542 | 579 |
| `firefox144` | 4/4 | 552 | 671 |
| `okhttp3` | 4/4 | 564 | 605 |
| `chrome124` | 4/4 | 572 | 740 |
| `ios18` | 4/4 | 590 | 676 |
| `okhttp` | 4/4 | 587 | 773 |
| `firefox` | 4/4 | 590 | 652 |
| `chrome104` | 4/4 | 591 | 786 |
| `chrome125` | 4/4 | 600 | 691 |
| `okhttp5` | 4/4 | 605 | 862 |
| `firefox128` | 4/4 | 617 | 774 |
| `chrome131` | 4/4 | 628 | 903 |
| `firefox133` | 4/4 | 669 | 1029 |
| `chrome101` | 4/4 | 788 | 1500 |
| `okhttp4` | 4/4 | 842 | 1500 |
| `chrome` | 4/4 | 1201 | 2990 |
| `firefox135` | 4/4 | 1319 | 2539 |
| `chrome107` | 4/4 | 1388 | 3276 |
| `chrome136` | 3/4 | 829 | 1708 |

Only `chrome136` failed a request: one 403 on the recipe page. Every other profile passed all four.

Rotation order:

```text
chrome151, chrome142, firefox158, chrome110, chrome100, chrome116,
firefox144, okhttp3, chrome124, ios18, okhttp, firefox, chrome104,
chrome125, okhttp5, firefox128, chrome131, firefox133, chrome101,
okhttp4, chrome, firefox135, chrome107, chrome136
```

`chrome151` stays first after a 107-request cloud run with no block. `firefox158` is third because it carried a cloud run after three Chrome profiles were blocked. The rest follow pass rate, then measured latency, so older Chrome builds that still pass are not buried. `ios18` is inside the first ten as a mobile fallback. `chrome131` moves up after passing all four requests, and `chrome136` sits last after its 403.

## Request headers

The scraper lets impit generate the profile headers. It does not set `user-agent`, `accept`, `accept-language`, `sec-ch-ua`, or `sec-fetch-*` by hand. The component endpoint gets only the headers the server expects: `origin`, `referer`, `x-requested-with`, and `content-type`.

## Resilience model

The client keeps one impit client and cookie jar per profile.

- A request tries up to ten profiles, ordered by recent failures and then by last success.
- A profile with more failures moves later.
- A blocked profile cools down for five minutes; a temporary response cools down for thirty seconds.
- HTTP 402, 403, 429, 451, and known block-page bodies trigger a fresh cookie jar and a proxy rotation when a proxy is configured.
- HTTP 5xx, timeouts, and network errors trigger rotation with a short backoff.
- HTTP 404 and 410 return immediately as not found, without rotating profiles.
- `Retry-After` is honored on 429, capped at thirty seconds.
- A 200 response with an invalid body counts as a failure, which covers soft blocks and changed markup.
- A failed logical request recycles the cookie jar and connection of every failed profile.
- The inline CSRF token is captured from every successful page, not only from the cookie jar.
- If a proxy is configured, a session gets a fresh proxy URL after repeated failures, up to two refreshes.
- If proxy requests fail repeatedly, the run falls back to direct connections instead of stopping.
- A site-wide circuit opens after four failed logical requests and pauses new requests for fifteen seconds.
- No cookie, token, proxy URL, or full response body is logged.

## Extraction contract

Each dataset item contains:

```text
name, description, url, image, author, testedBy, updatedOn, breadcrumbs, category,
cuisine, keywords, prepTime, cookTime, additionalTime, totalTime, servings, rating,
photoCount, ingredients, ingredientItems, instructions, instructionImages, details,
nutrition, scrapedAt
```

Fields with no source value are omitted. `ingredients` is an array of display strings. `ingredientItems` is a parallel array with `quantity`, `unit`, `name`, and `text` when those parts can be parsed. `instructions` is an array of strings. `instructionImages` appears only when step images exist. `details` keeps the labeled page values. Nutrition has `summary` (headline values), `dailyValues` (percentage rows), `values` (every full-label amount, including rows without a percentage), and `extra` (servings per recipe and calories).

## Reproduction checks

Local run with the default search input:

```json
{
  "query": "chicken",
  "results_wanted": 20,
  "max_pages": 5
}
```

Observed on 2026-11-06:

```text
Search "chicken": 2 pages, 44 recipe links discovered.
Discovered 44 recipe URLs. Extracting with concurrency 3.
Finished | saved=20 | target=20 | failed=0 | searchPages=2 | searchFailures=0 | recipeFailures=0 | componentFallbacks=0 | proxy=off | requests=23 | profiles=chrome151:23
```

A separate `vegan soup` run with `results_wanted` 50 and `max_pages` 3 read three pages and saved 50 recipes. Page 1 for that query had 23 unique links and page 2 still existed, which confirms that the pagination signal, not the page size, decides when to stop.

A 20-result chicken run completed in about 25 seconds with no failed requests.

## Known limits

- A removed recipe returns 404 and is skipped.
- Search and recipe markup can change. The extractor keeps selector fallbacks and reads JSON-LD separately from the visible HTML.
- The deferred endpoint can change its component keys. The key list is centralized in `src/main.js`.
- The block page can change. Detection covers known status codes and body markers in `src/extract.js`.
- A query with no matches returns HTTP 404 for the search page. That is treated as an empty result, not a run failure.
- The scraper does not claim to bypass anti-bot systems. If every profile is blocked, configure a proxy or wait for the cooldown.
- Proxy is off by default. A 100-recipe run from the Apify cloud network completed without one, while local runs without proxy credentials also fall back to direct connections. Enable Apify Residential Proxy only if repeated runs return block pages.

## Removed approaches

- Mobile host and mobile API discovery: `m.`, `mobile.`, and `api.` hosts do not resolve.
- `/api/`, `/api/v1/`, `/graphql`, and `/search/api`: no working JSON endpoint.
- Plain Node `fetch` without a browser profile: 402 block page.
- Ingredient and step component keys as the primary source: the schema block is more complete.
- Old Chrome and iOS profiles as the first choice: they work as fallbacks but are slower or less consistent than current profiles.
