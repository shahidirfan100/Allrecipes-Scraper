# Allrecipes Scraper

Extract comprehensive recipe data from Allrecipes with ease. Collect complete recipes including ingredients, instructions, cooking times, ratings, and nutritional information at scale. Perfect for building recipe databases, meal planning services, and food content research.

---

## Features

- **Detailed Recipe Extraction** — Collect full ingredients, instructions, and cooking times
- **Rich Media Support** — Extract high-quality recipe images and author details
- **Nutritional Information** — Gather complete macro and micronutrient data
- **User Engagement Data** — Capture ratings and review counts for popularity analysis
- **Search Capabilities** — Scrape recipes by ingredients, dish names, or cuisine types
- **Pagination Handling** — Automatically navigate through search results to collect bulk data

---

## Use Cases

### Recipe Database Creation
Build a comprehensive recipe database for your cooking app or website. Search for various cuisines, ingredients, and meal types to create a diverse collection without manual data entry.

### Meal Planning Applications
Extract recipes with detailed nutritional information to power meal planning and dietary tracking applications. Provide users with accurate calorie and macronutrient data.

### Market Intelligence
Analyze ingredient combinations, seasonal trends, and usage patterns across thousands of recipes for culinary research, product development, or content planning.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | String | No | `"Chicken"` | Search term for recipes (e.g., "Chicken Pasta", "Vegan Desserts") |
| `results_wanted` | Integer | No | `20` | Maximum number of recipes to extract |
| `max_pages` | Integer | No | `5` | Limit search result pages to process |

---

## Output Data

Each item in the dataset contains:

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Recipe title |
| `description` | String | Brief recipe summary or description |
| `image` | String | High-quality recipe photo URL |
| `author` | String | Recipe creator or contributor |
| `rating` | Object | User rating containing `value` and `count` |
| `prepTime` | String | Preparation time |
| `cookTime` | String | Cooking time |
| `totalTime` | String | Total time required |
| `servings` | String | Number of servings or yield |
| `ingredients` | Array | Complete ingredient list with measurements |
| `instructions` | Array | Step-by-step cooking directions |
| `category` | String | Recipe category (appetizer, main dish, etc.) |
| `cuisine` | String | Cuisine type (Italian, Mexican, etc.) |
| `keywords` | String | Recipe tags and search keywords |
| `nutrition` | Object | Nutritional information including calories, protein, carbs, fat, etc. |
| `url` | String | Original recipe URL |
| `scrapedAt` | String | Timestamp of data extraction |

---

## Usage Examples

### Basic Recipe Search

Extract recipes based on a simple keyword search:

```json
{
    "query": "Chocolate Cake",
    "results_wanted": 20,
    "max_pages": 5
}
```

### Advanced Cuisine Targeting

Target specific cuisines or dietary preferences by refining the search query:

```json
{
    "query": "Vegan Italian Dinners",
    "results_wanted": 50,
    "max_pages": 10
}
```

### High-Volume Extraction

Extract a larger batch of recipes for database creation:

```json
{
    "query": "Healthy Breakfast",
    "results_wanted": 200,
    "max_pages": 15
}
```

---

## Sample Output

```json
{
  "name": "Classic Chicken Parmesan",
  "description": "Crispy breaded chicken topped with marinara and melted cheese.",
  "image": "https://www.allrecipes.com/thmb/example-image.jpg",
  "author": "Chef John",
  "rating": {
    "value": "4.7",
    "count": "1,234"
  },
  "prepTime": "PT20M",
  "cookTime": "PT25M",
  "totalTime": "PT45M",
  "servings": "4 servings",
  "ingredients": [
    "4 boneless chicken breasts",
    "1 cup breadcrumbs",
    "2 cups marinara sauce"
  ],
  "instructions": [
    "Preheat oven to 375°F (190°C).",
    "Coat chicken breasts in breadcrumbs and fry until golden.",
    "Bake with marinara and cheese until melted."
  ],
  "category": "Main Dish",
  "cuisine": "Italian",
  "keywords": "chicken, italian, comfort food, parmesan",
  "nutrition": {
    "calories": "420",
    "protein": "35g",
    "carbohydrates": "28g",
    "fat": "18g"
  },
  "url": "https://www.allrecipes.com/recipe/12345/classic-chicken-parmesan/",
  "scrapedAt": "2023-10-27T10:30:00.000Z"
}
```

---

## Tips for Best Results

### Optimize Search Queries
- Use specific phrases like "Gluten-Free Desserts" instead of broad terms like "Cake" for more targeted datasets
- Try combining ingredients (e.g., "Chicken Spinach Pasta") to discover unique recipe variations

### Manage Collection Size
- Start small for testing (20-30 results) to ensure the output matches your expectations
- Increase `results_wanted` and `max_pages` for production runs
- Balance the scope of extraction based on the actual number of search results available for your query

---

## Proxy Configuration

For reliable results and to avoid rate limits during large extractions, residential proxies are recommended:

```json
{
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

---

## Integrations

Connect your data with:

- **Google Sheets** — Export for team sharing and analysis
- **Airtable** — Build searchable recipe databases
- **Make** — Create automated content publishing workflows
- **Zapier** — Trigger notifications or synchronization actions
- **Webhooks** — Send new recipes directly to your custom backends

### Export Formats

Download data in multiple formats:

- **JSON** — For developers and direct API consumption
- **CSV** — For spreadsheet analysis and manual review
- **Excel** — For business reporting and sharing
- **XML** — For specific system integrations

---

## Frequently Asked Questions

### How many recipes can I extract?
You can extract thousands of recipes by adjusting the `results_wanted` and `max_pages` parameters. Keep in mind that the total depends on the availability of recipes for a specific search term.

### Does the scraper handle pagination?
Yes, the actor automatically handles pagination to reach your desired result count across multiple pages of search results.

### Are nutritional details always available?
The scraper extracts nutritional information when provided by Allrecipes. If a user-submitted recipe lacks this data, those specific fields will be omitted in the output.

### Can I scrape without using search queries?
Currently, the scraper is optimized to aggregate recipes based on search terms to ensure relevance and structure.

---

## Support

For issues or feature requests, contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [API Reference](https://docs.apify.com/api/v2)
- [Scheduling Runs](https://docs.apify.com/schedules)

---

## Legal Notice

This actor is designed for legitimate data collection purposes. Users are responsible for ensuring compliance with website terms of service and applicable laws. Use data responsibly and respect rate limits.
