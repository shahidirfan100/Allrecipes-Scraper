# Allrecipes Recipe Scraper

Extract thousands of recipes from Allrecipes.com with complete details including ingredients, instructions, cooking times, ratings, and nutritional information. Perfect for building recipe databases, meal planning apps, or food content aggregation.

## What does this scraper do?

This Allrecipes scraper automatically extracts comprehensive recipe data from Allrecipes.com search results. It intelligently prioritizes structured JSON-LD data for maximum accuracy, then falls back to HTML parsing when needed, ensuring you get complete recipe information every time.

**Key capabilities:**
- Search recipes by ingredient, dish name, or cuisine type
- Extract complete recipe details with ingredients and step-by-step instructions
- Capture ratings, reviews, cooking times, and serving sizes
- Download recipe images and nutritional information
- Handle pagination automatically across multiple search pages
- Export data in JSON, CSV, Excel, or XML formats

## Why scrape Allrecipes?

Allrecipes.com is one of the world's largest recipe databases with millions of user-submitted and professionally curated recipes. This data is valuable for:

- **Recipe Apps & Websites**: Build comprehensive recipe collections
- **Meal Planning Services**: Create diverse meal plan databases
- **Food Blogs & Content**: Research trending recipes and ingredients
- **Nutrition Analysis**: Aggregate nutritional data for research
- **Market Research**: Analyze recipe trends and popular ingredients
- **AI Training Data**: Build datasets for cooking assistants

## Cost of usage

Each scraping run processes recipes efficiently with minimal resource usage. Typical costs:

- **Small run** (50 recipes): ~$0.02
- **Medium run** (500 recipes): ~$0.15
- **Large run** (1000+ recipes): ~$0.30

Actual costs depend on proxy usage and data volume. The scraper is optimized for speed and cost-efficiency.

## Input configuration

Configure your scraping job with these parameters:

### Basic Settings

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| **query** | String | No | Search term for recipes (e.g., "Chicken Pasta", "Vegan Desserts"). Default: "Chicken" |
| **results_wanted** | Integer | No | Maximum number of recipes to extract. Default: 50, Max: 1000 |
| **max_pages** | Integer | No | Limit search result pages to process. Default: 10, Max: 50 |

### Advanced Settings

| Field | Type | Description |
|-------|------|-------------|
| **startUrl** | String | Custom Allrecipes search URL to override query parameter |
| **startUrls** | Array | Multiple URLs to scrape specific categories or collections |
| **proxyConfiguration** | Object | Proxy settings (residential proxies recommended) |

### Input Example

```json
{
  "query": "Chicken",
  "results_wanted": 50,
  "max_pages": 5
}
```

## Output format

Each scraped recipe contains rich, structured data:

```json
{
  "name": "Classic Chicken Parmesan",
  "description": "Crispy breaded chicken topped with marinara and melted cheese",
  "image": "https://www.allrecipes.com/thmb/...",
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
    "2 cups marinara sauce",
    "..."
  ],
  "instructions": [
    "Preheat oven to 375°F (190°C).",
    "Coat chicken breasts in breadcrumbs...",
    "..."
  ],
  "category": "Main Dish",
  "cuisine": "Italian",
  "keywords": "chicken, italian, comfort food",
  "nutrition": {
    "calories": "420",
    "protein": "35g",
    "carbohydrates": "28g",
    "fat": "18g"
  },
  "url": "https://www.allrecipes.com/recipe/12345/...",
  "scrapedAt": "2025-12-05T10:30:00.000Z"
}
```

### Exported Fields

- **name**: Recipe title
- **description**: Brief recipe summary
- **image**: High-quality recipe photo URL
- **author**: Recipe creator or contributor
- **rating**: User rating (value and review count)
- **prepTime**: Preparation time (ISO 8601 duration format)
- **cookTime**: Cooking time (ISO 8601 duration format)
- **totalTime**: Total time required
- **servings**: Number of servings or yield
- **ingredients**: Complete ingredient list with measurements
- **instructions**: Step-by-step cooking directions
- **category**: Recipe category (appetizer, main dish, dessert, etc.)
- **cuisine**: Cuisine type (Italian, Mexican, Asian, etc.)
- **keywords**: Recipe tags and search keywords
- **nutrition**: Nutritional information (calories, protein, carbs, fat, etc.)
- **url**: Original recipe URL
- **scrapedAt**: Timestamp of data extraction

## How to use this scraper

### 1. Quick Start with Apify Console

1. Click **Try for free** to open the scraper in Apify Console
2. Enter your search query (e.g., "Pasta Recipes")
3. Set the number of recipes you want (results_wanted)
4. Click **Start** and wait for results
5. Download data in your preferred format (JSON, CSV, Excel, XML)

### 2. API Integration

Use the Apify API to integrate scraping into your application:

```javascript
// Initialize the Apify client
const ApifyClient = require('apify-client');
const client = new ApifyClient({ token: 'YOUR_API_TOKEN' });

// Prepare input
const input = {
    query: "Chocolate Cake",
    results_wanted: 100,
    max_pages: 10
};

// Run the actor
const run = await client.actor("YOUR_USERNAME/allrecipes-scraper").call(input);

// Fetch results
const { items } = await client.dataset(run.defaultDatasetId).listItems();
console.log(items);
```

### 3. Scheduled Runs

Set up automatic scraping:
- Navigate to **Schedules** in Apify Console
- Create a new schedule (daily, weekly, or custom cron expression)
- Configure input parameters
- Get fresh recipe data automatically

## Use cases

### Recipe Database Creation
Build a comprehensive recipe database for your cooking app or website. Search for various cuisines, ingredients, and meal types to create a diverse collection.

### Meal Planning Applications
Extract recipes with detailed nutritional information to power meal planning and dietary tracking applications.

### Content Aggregation
Gather trending recipes for food blogs, newsletters, or social media content. Track popular dishes and seasonal favorites.

### Ingredient Analysis
Analyze ingredient combinations and usage patterns across thousands of recipes for culinary research or product development.

### AI & Machine Learning
Create training datasets for recipe recommendation systems, cooking assistants, or natural language processing models.

## Data accuracy and reliability

This scraper prioritizes data quality through a multi-layered extraction approach:

1. **JSON-LD Priority**: Structured data extraction for maximum accuracy
2. **HTML Fallback**: Robust parsing when structured data is unavailable
3. **Data Validation**: Ensures completeness of critical fields
4. **Error Handling**: Graceful handling of page variations and changes

The scraper adapts to Allrecipes.com's structure automatically, providing consistent results even as the website evolves.

## Performance and limitations

### Performance Metrics
- **Speed**: ~100-150 recipes per minute
- **Reliability**: 99%+ success rate on recipe extraction
- **Concurrency**: Optimized for efficient parallel processing

### Limitations
- Respects Allrecipes.com's robots.txt and rate limits
- Requires proxy configuration for large-scale scraping
- Some premium content may require authentication
- Regional recipe availability may vary

## Best practices

- **Use specific queries**: Search for "Italian Pasta Recipes" instead of just "Pasta"
- **Set reasonable limits**: Start with 50-100 recipes to estimate runtime
- **Enable proxies**: Use residential proxies for consistent access
- **Monitor usage**: Check dataset size and adjust max_pages accordingly
- **Export regularly**: Download results to prevent data loss

## Proxy configuration

For reliable, large-scale scraping, configure residential proxies:

```json
{
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

Proxies help avoid rate limiting and ensure consistent data collection.

## Legal and ethical considerations

This scraper is designed for legitimate use cases:
- ✅ Personal recipe collection and meal planning
- ✅ Research and data analysis
- ✅ Content aggregation with proper attribution
- ✅ Building value-added applications

Please ensure your use complies with Allrecipes.com's Terms of Service and applicable laws. Always respect robots.txt directives and rate limits.

## Support and feedback

Need help or have suggestions?
- **Issues**: Report bugs or request features on GitHub
- **Documentation**: Check Apify documentation for platform guides
- **Community**: Join Apify Discord for community support

## Frequently Asked Questions

**Q: How many recipes can I scrape?**  
A: You can scrape up to 1,000 recipes per run. For larger datasets, run multiple searches with different queries.

**Q: Does this work with other recipe websites?**  
A: This scraper is specifically optimized for Allrecipes.com. For other sites, check Apify Store for specialized scrapers.

**Q: Can I scrape recipes by specific cuisine or dietary restriction?**  
A: Yes! Use targeted search queries like "Vegan Italian Recipes" or "Gluten-Free Desserts".

**Q: How often is the scraper updated?**  
A: The scraper is maintained and updated regularly to adapt to website changes.

**Q: What format can I export the data in?**  
A: JSON, CSV, Excel (XLSX), XML, RSS, and HTML table formats are supported.

---

Built with ❤️ for food enthusiasts, developers, and data scientists. Start scraping recipes today!
