# API Discovery

## Existing Actor Field Audit (Before Rewrite)
Previous actor output fields:
- `name`
- `description`
- `image`
- `prepTime`
- `cookTime`
- `totalTime`
- `servings`
- `ingredients`
- `instructions`
- `rating.value`
- `rating.count`
- `author`
- `category`
- `cuisine`
- `keywords`
- `nutrition`
- `url`
- `scrapedAt`

## Missing/Low-Coverage Fields (Before Rewrite)
- `additionalTime`
- `rating.reviewCount`
- `photoCount`
- `testedBy`
- `updatedOn`
- `breadcrumbs`
- structured ingredient parts (`quantity`, `unit`, `name`)
- instruction images
- normalized details map
- nutrition split (`summary`, `dailyValues`, `extra`)
- source component metadata

## Candidate APIs (URLScan + Network Validation)

### Candidate 1: Search Deferred Components API
- Endpoint: `https://www.allrecipes.com/search?q=<query>&offset=<offset>&url=<encoded_search_url>`
- Method: `POST`
- Auth: No account auth, but requires `CSRFToken` cookie + AJAX headers
- Pagination: `offset` (step 24)
- Response shape: JSON object with component blocks, including `mntl-search-results__list_1.html`
- Field richness: Medium (URL discovery focused)

### Candidate 2: Recipe Deferred Components API (Selected)
- Endpoint: `https://www.allrecipes.com/recipe/<id>/<slug>/?url=<encoded_recipe_url>`
- Method: `POST`
- Auth: No account auth, but requires `CSRFToken` cookie + AJAX headers
- Pagination: N/A (detail endpoint)
- Response shape: JSON object with rich component blocks:
  - `article-header--recipe_1`
  - `mntl-article-meta-dynamic_1`
  - `mm-recipes-review-bar_1`
  - `article__photo-ribbon_1`
  - `mm-recipes-details_1`
  - `mm-recipes-structured-ingredients_1`
  - `mm-recipes-steps_1`
  - `mm-recipes-nutrition-facts_1`

## Scoring
Scoring rubric from skill:
- Returns JSON directly: +30
- Has >15 unique fields: +25
- No auth required: +20
- Has pagination support: +15
- Matches or extends current fields: +10

### Candidate 2 Score
- Returns JSON directly: +30
- >15 fields: +25
- No account auth (cookie/header only): +20
- Pagination support: +0 (detail endpoint itself has no pagination)
- Matches/extends actor fields: +10
- Total: **85/100**

### Candidate 1 Score
- Returns JSON directly: +30
- >15 fields: +0 (primarily list HTML block)
- No account auth (cookie/header only): +20
- Pagination support: +15
- Matches/extends actor fields: +10
- Total: **75/100**

## Selected API
- Endpoint: `https://www.allrecipes.com/recipe/<id>/<slug>/?url=<encoded_recipe_url>`
- Method: `POST`
- Auth: CSRF cookie + standard AJAX headers; no login
- Pagination: Not needed for detail (combined with search API offset pagination)
- Fields available (after mapping):
  - `name`
  - `description`
  - `url`
  - `image`
  - `author`
  - `testedBy`
  - `updatedOn`
  - `breadcrumbs`
  - `category`
  - `prepTime`
  - `cookTime`
  - `additionalTime`
  - `totalTime`
  - `servings`
  - `rating.value`
  - `rating.count`
  - `rating.reviewCount`
  - `photoCount`
  - `ingredients`
  - `ingredientItems[].quantity`
  - `ingredientItems[].unit`
  - `ingredientItems[].name`
  - `ingredientItems[].text`
  - `instructions`
  - `instructionImages`
  - `details`
  - `nutrition.summary`
  - `nutrition.dailyValues`
  - `nutrition.extra`
  - `apiComponents`
  - `scrapedAt`
- Fields currently missing in old actor and now added:
  - `additionalTime`, `photoCount`, `testedBy`, `updatedOn`, `breadcrumbs`, `ingredientItems`, `instructionImages`, `details`, structured `nutrition`, `apiComponents`
- Field count: **30+ mapped fields** (vs ~18 in previous actor)
