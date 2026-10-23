# Allrecipes Discovery Notes

Last verified: 2026-10-23

This document records what the scraper was built against after starting discovery from scratch. It is a technical record, not legal advice. Allrecipes is operated by People Inc., and its terms of service restrict automated collection. The scraper is intended for legitimate collection of public recipe data; users are responsible for compliance.

## Environment

| Item | Value |
|------|-------|
| Node.js | 24.13.0 |
| npm | 11.6.2 |
| impit at verification | 0.14.7 |
| apify SDK | 3.7.2 |

## Primary decision

Use the normal recipe page HTML as the primary source and the deferred component endpoint as a fallback. Search results come from the search page HTML, with the search component endpoint as a fallback.

Reason: the recipe HTML contains the complete JSON-LD block plus server-rendered ingredient and step markup. The deferred component endpoint still returns JSON-LD, but two of the old component keys no longer return usable content. A scraper that depends only on those keys fails.

## Request behavior

| Test | Result |
|------|--------|
| Plain Node `fetch` with a Node user agent | HTTP 402 block page from People Inc. |
| impit with a supported browser profile | HTTP 200, normal Allrecipes page |
| `m.allrecipes.com` | Connection failure |
| `api.allrecipes.com` | Connection failure |
| `/api/` and `/graphql` | HTTP 404 |
| Recipe page HTML size | About 523 KB |
| Search page HTML size | About 382 KB |

No mobile API was found. The public site and its deferred component endpoint are the usable surfaces.

## Search pages

Base URL:

```text
https://www.allrecipes.com/search?q=<query>&offset=<0,24,48,...>
```

Observed behavior:

| Item | Value |
|------|-------|
| Page size | 24 unique recipe links |
| Recipe link pattern | `/recipe/<id>/<slug>/` |
| Card selector | `a.mntl-card-list-card--extendable` |
| Pagination | `offset` increments by 24 |
| Last page signal | Fewer than 24 unique recipe links |
| No-results signal | Page text contains "no results", "0 results", or "couldn't find" |

The search page also contains gallery links. Galleries can expose more recipe links, so the scraper treats them as a secondary discovery source with a small expansion limit.

## Recipe pages

The recipe page contains:

- A `script[type="application/ld+json"]` block.
- The JSON-LD `@type` value is an array, for example `["Recipe"]`, not a string.
- Server-rendered ingredient markup.
- Server-rendered instruction markup.
- Rating, review count, photo count, times, servings, category, cuisine, and nutrition blocks.

The extractor accepts both string and array `@type` values. It also merges supporting JSON-LD nodes, including breadcrumbs, when the recipe node does not carry all fields.

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

The endpoint returned HTTP 200 without a CSRF token or session cookie during verification. The scraper still reads `CSRFToken` from its cookie jar when one exists, so a future token requirement does not require a code change.

### Component key findings

| Key | Status |
|-----|--------|
| `allrecipes-schema_1` | Returns the full JSON-LD block, about 17.8 KB |
| `mm-recipes-structured-ingredients_1` | Empty or error banner |
| `mm-recipes-steps_1` | Empty or error banner |
| `mm-recipes-steps__content_1` | Still returns step markup |
| `mm-recipes-details_1` | Works |
| `mm-recipes-nutrition-facts-summary_1` | Works |
| `mm-recipes-nutrition-facts-label_1` | Works |
| `article-header--recipe_1` | Works |
| `mntl-article-meta-dynamic_1` | Works |
| Review bar rating and count keys | Work |

The fallback key list used by the scraper:

```text
allrecipes-schema_1,article-preheading_1,article-header--recipe_1,mntl-article-meta-dynamic_1,mm-recipes-review-bar__rating_1,mm-recipes-review-bar__rating-count_1,mm-recipes-review-bar__comment-count_1,recipe-review-bar__photo-count_1,mm-recipes-details_1,mm-recipes-nutrition-facts-summary_1,mm-recipes-nutrition-facts-label_1
```

This payload produced the following in a live check:

| Field | Result |
|-------|--------|
| Name | Chicken Parmesan |
| Author | John Mitzewich |
| Ingredients | 12 |
| Instructions | 7 |
| Rating | 4.9 from 5194 ratings |
| Review count | 3788 |
| Nutrition | Summary, daily values, extra |

Ingredients and instructions come from the JSON-LD inside `allrecipes-schema_1`, not from the two empty component keys.

## Search component fallback

Working request:

```text
POST https://www.allrecipes.com/search?q=<query>&offset=<offset>&url=<encoded searchUrl>
```

Component keys:

```text
mntl-search-results__list_1,mntl-pagination_1
```

The response is about 108 KB and contains recipe links. The extractor reads HTML strings from keys matching `search-results`, `pagination`, or `card-list`, then applies the same link extraction as the search page. Duplicate links across cards are removed.

## Browser profile matrix

Tested with impit 0.14.2 and 0.14.7. A profile is listed as working only when the recipe or search request returned a normal page.

### Working

```text
chrome
chrome124
chrome125
chrome131
chrome136
chrome142
firefox
firefox128
firefox133
firefox135
firefox144
okhttp
okhttp3
okhttp4
okhttp5
```

The generic `chrome` profile resolved to a recent Chrome fingerprint during testing. The generic `firefox` profile returned one transient HTTP 403 on a recipe request and succeeded on retry, so it is kept behind more specific profiles in the rotation order.

### Failing

```text
chrome100
chrome101
chrome104
chrome107
chrome110
chrome116
ios18
```

The older Chrome profiles failed at connection setup. `ios18` failed TLS negotiation with `TLS AlertReceived` or "failed to connect to the server".

The scraper's rotation order starts with generic `chrome`, then recent Chrome, recent Firefox, and okhttp profiles. It does not use the failing profiles.

## Resilience model

The client keeps one impit client and cookie jar per browser profile.

- Each request tries up to four profiles.
- A profile with more failures is tried later.
- A profile is cooled down for five minutes after three failures.
- HTTP 402, 403, 429, 451, and block-page bodies trigger rotation.
- HTTP 5xx triggers rotation with a short backoff.
- HTTP 404 and 410 are returned immediately as not found, without rotating profiles.
- `Retry-After` is honored on 429, capped at ten seconds.
- A soft block that returns HTTP 200 with an invalid body is treated as a failure.
- If a proxy is configured, a session gets a fresh proxy URL after repeated failures, up to two refreshes.
- A proxy is never enabled automatically.
- No secret, cookie, or proxy URL is logged.

## Extraction contract

Each dataset item contains:

```text
name, description, url, image, author, testedBy, updatedOn, breadcrumbs, category,
cuisine, keywords, prepTime, cookTime, additionalTime, totalTime, servings, rating,
photoCount, ingredients, ingredientItems, instructions, instructionImages, details,
nutrition, scrapedAt
```

Fields with no source value are omitted. `ingredients` is an array of display strings. `ingredientItems` is a parallel array of objects with `quantity`, `unit`, `name`, and `text` when those parts can be parsed. `instructions` is an array of strings, and `instructionImages` is a parallel array that appears only when step images exist. `details` keeps the page's labeled values, such as Prep Time, Cook Time, Total Time, and Servings.

## Reproduction checks

Run the actor locally with a search input:

```json
{
  "query": "chicken",
  "results_wanted": 10,
  "max_pages": 2
}
```

Expected log shape:

```text
Search "chicken" page 1: 24 recipe links
Saved 10/10 recipes
Finished | saved=10 | failed=0
```

Run with a direct recipe URL and with a search URL to verify both start URL modes.

## Known limits

- A recipe page that is removed returns 404 and is skipped.
- Search pages can change their card markup. The extractor falls back to any `/recipe/` link when card selectors return nothing.
- The deferred endpoint can change its component keys. The fallback list is centralized in `src/main.js`.
- The site can change its block page. Block detection uses known status codes and body text markers in `src/extract.js`.
- The scraper does not claim to bypass anti-bot systems. If every profile is blocked, configure a proxy or wait for the cooldown.

## Removed approaches

- Mobile host and mobile API discovery: no working host.
- `/api/` and `/graphql`: 404.
- Ingredient and step component keys as the primary source: empty responses.
- Plain Node fetch: 402.
- Old Chrome and iOS profiles: connection or TLS failures.
