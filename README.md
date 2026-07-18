# Allrecipes Scraper

Extract comprehensive recipe data from Allrecipes with ease. Collect complete recipes including ingredients, cooking times, ratings, and nutritional information at scale. Perfect for building recipe databases, meal planning services, and food content research.

## Features

- **Complete Recipe Extraction** - Collect full ingredients, step-by-step instructions, and cooking times
- **Rich Media Support** - Extract high-quality recipe images and author details
- **Nutritional Information** - Gather complete macro and micronutrient data
- **User Engagement Data** - Capture ratings, review counts, and popularity metrics
- **Search Capabilities** - Find recipes by ingredients, dish names, or cuisine types
- **Automatic Pagination** - Collect bulk data across multiple search result pages

## Use Cases

### Recipe Database Creation
Build a comprehensive recipe database for your cooking app or website. Search for various cuisines, ingredients, and meal types to create a diverse collection without manual entry.

### Meal Planning Applications
Extract recipes with detailed nutritional information to power meal planning and dietary tracking apps. Provide users with accurate calorie and macronutrient data for informed choices.

### Market Intelligence
Analyze ingredient combinations, seasonal trends, and usage patterns across thousands of recipes. Use this data for culinary research, product development, or content planning.

### Food Content Research
Study recipe formats, ingredient ratios, and cooking techniques at scale. Identify emerging food trends and popular ingredient combinations.

### Competitive Analysis
Monitor recipe collections from competitors and track content strategies. Understand what types of recipes drive engagement in your niche.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | String | No | `"Chicken"` | Search term for recipes (e.g. "Chicken Pasta", "Vegan Desserts") |
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
| `rating` | Object | User rating containing `value`, `count`, and `reviewCount` |
| `prepTime` | String | Preparation time |
| `cookTime` | String | Cooking time |
| `totalTime` | String | Total time required |
| `servings` | String | Number of servings or yield |
| `ingredients` | Array | Complete ingredient list with measurements |
| `ingredientItems` | Array | Structured ingredients with `quantity`, `unit`, and `name` |
| `instructions` | Array | Step-by-step cooking directions |
| `instructionImages` | Array | Images for individual cooking steps |
| `category` | String | Recipe category (appetizer, main dish, etc.) |
| `cuisine` | String | Cuisine type (Italian, Mexican, etc.) |
| `keywords` | Array | Recipe tags and search keywords |
| `nutrition` | Object | Nutritional information including summary, daily values, and extra details |
| `details` | Object | Normalized detail map from recipe metadata |
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
        "value": 4.7,
        "count": 1234,
        "reviewCount": 89
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
    "ingredientItems": [
        {
            "quantity": "4",
            "unit": null,
            "name": "boneless chicken breasts",
            "text": "4 boneless chicken breasts"
        }
    ],
    "instructions": [
        "Preheat oven to 375 degrees F (190 degrees C).",
        "Coat chicken breasts in breadcrumbs and fry until golden.",
        "Bake with marinara and cheese until melted."
    ],
    "category": "Main Dish",
    "cuisine": "Italian",
    "keywords": ["chicken", "italian", "comfort food", "parmesan"],
    "nutrition": {
        "summary": {},
        "dailyValues": {},
        "extra": {}
    },
    "url": "https://www.allrecipes.com/recipe/12345/classic-chicken-parmesan/",
    "scrapedAt": "2026-07-18T10:30:00.000Z"
}
```

---

## Tips for Best Results

### Optimize Search Queries
- Use specific phrases like "Gluten-Free Desserts" instead of broad terms like "Cake" for more targeted datasets
- Try combining ingredients (e.g. "Chicken Spinach Pasta") to discover unique recipe variations
- Use dietary keywords (Keto, Vegan, Low-Carb) for niche collections

### Manage Collection Size
- Start small for testing (20-30 results) to ensure output matches expectations
- Increase `results_wanted` and `max_pages` for production runs
- Balance extraction scope based on available search results for your query

### Handle Large Datasets
- Use batch processing for collections over 500 recipes
- Schedule regular runs to keep your database updated with new recipes
- Monitor extraction results and adjust parameters as needed

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

- **Google Sheets** - Export for team sharing and analysis
- **Airtable** - Build searchable recipe databases
- **Make** - Create automated content publishing workflows
- **Zapier** - Trigger notifications or synchronization actions
- **Webhooks** - Send new recipes directly to your custom backends

### Export Formats

Download data in multiple formats:

- **JSON** - For developers and direct API consumption
- **CSV** - For spreadsheet analysis and manual review
- **Excel** - For business reporting and sharing
- **XML** - For specific system integrations

---

## Frequently Asked Questions

### How many recipes can I extract?
You can extract thousands of recipes by adjusting the `results_wanted` and `max_pages` parameters. The total depends on the availability of recipes for a specific search term.

### Does the scraper handle pagination?
Yes, it automatically handles pagination to reach your desired result count across multiple pages of search results.

### Are nutritional details always available?
The scraper extracts nutritional information when provided by Allrecipes. User-submitted recipes may lack this data, and those specific fields will be omitted in the output.

### What fields are included in the output?
Each recipe includes name, description, image, author, ratings, cooking times, servings, structured ingredients, step-by-step instructions with images, nutrition details, category, cuisine, and keywords.

### Can I scrape recipes by URL directly?
Yes, you can provide direct recipe URLs through `startUrls` to extract specific recipes without using search queries.

### What happens if a recipe page fails to load?
The scraper includes automatic retry logic with proxy rotation. If the primary extraction method fails, it falls back to an alternative method to maximize data recovery.

### Does this work with any cuisine type?
Yes, any search query that returns results on Allrecipes will work. This includes cuisines like Italian, Mexican, Asian, American, and more.

### How long does a typical extraction take?
Extraction speed depends on your result target and proxy configuration. A typical run of 100 recipes completes within a few minutes with residential proxies.

### Can I schedule regular extractions?
Yes, you can schedule recurring runs through the Apify Console to keep your recipe database updated with fresh content.

### What data formats are available for download?
Data can be exported in JSON, CSV, Excel, and XML formats through the Apify platform.

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
