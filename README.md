## What does Allrecipes Scraper do?

Allrecipes Scraper collects recipe data from Allrecipes.com and saves it as a structured dataset. Enter a keyword such as `chicken`, `lasagna`, or `chocolate cake`, or supply recipe and search URLs directly. Each result includes the recipe name, ingredients, instructions, times, servings, rating, author, category, image, and nutrition when the page provides it.

Use it to build a recipe database, compare dishes, research food trends, populate a cooking app, or prepare content for a website. The Actor runs on Apify, so you can start it from the Console, schedule repeat runs, or call it through the Apify API.

## Why use Allrecipes Scraper?

- Get recipe names, ingredients, instructions, times, servings, ratings, and nutrition as structured fields.
- Start with a keyword search, a search page, a category page, a gallery, or specific recipe URLs.
- Collect ratings, review counts, and nutrition in the same run, so you do not need a second pass for that data.
- Download JSON, CSV, Excel, or XML, or send results to another tool through the Apify API.
- Schedule repeat runs to refresh a recipe collection.
- Run it from Apify Console with a search field and a result limit, even if you do not write code.

## What data can you extract from Allrecipes?

| Data group | Examples |
|------------|----------|
| Recipe identity | Name, description, canonical URL, main image |
| Source details | Author, tester, update date, breadcrumb path |
| Classification | Category, cuisine, keywords |
| Timing and yield | Prep time, cook time, additional time, total time, servings |
| Social proof | Rating value, rating count, review count, user photo count |
| Ingredients | Display lines plus parsed quantity, unit, and ingredient name |
| Instructions | Ordered step text and step images when available |
| Nutrition | Calories, fat, carbs, protein, daily value rows, servings per recipe |

Some pages do not publish every field. The Actor omits fields that have no source value instead of saving empty placeholders.

## How to use Allrecipes Scraper

1. Open the Actor on Apify.
2. Enter a search term in **Search Query**, or add recipe or search URLs in **Start URLs**.
3. Set **Maximum Recipes** and, if needed, **Maximum Pages per Search**.
4. Run the Actor.
5. Open the dataset to preview results, then export or connect it to your workflow.

When **Start URLs** contains at least one valid Allrecipes URL, the Actor uses those URLs and ignores the search query. This makes it possible to combine specific recipes with search pages in one run.

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrls` | Array | No | - | Allrecipes recipe, search, category, or gallery URLs. Takes precedence over `query`. |
| `query` | String | No | `chicken` | Search term used when `startUrls` is empty. |
| `results_wanted` | Integer | No | `20` | Maximum number of recipes to save. Range: 1 to 10,000. |
| `max_pages` | Integer | No | `5` | Maximum search result pages to read per query or search URL. Range: 1 to 100. |
| `proxyConfiguration` | Object | No | Apify proxy disabled | Optional proxy settings. Use only if your network is repeatedly blocked. |

Search pages usually contain about 24 recipes. A run can discover more URLs than the result limit and stops extracting when the limit is reached. If fewer recipes are available than requested, the Actor saves what it found and logs a warning.

## Output Data

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Recipe title. |
| `description` | String | Short recipe description from the page. |
| `url` | String | Canonical Allrecipes recipe URL. |
| `image` | String | Main recipe image URL. |
| `author` | String | Recipe author. |
| `testedBy` | String | Recipe tester when the page lists one. |
| `updatedOn` | String | Date shown for the last page update. |
| `breadcrumbs` | Array | Category path, such as Recipes, Main Dishes, Chicken. |
| `category` | String | Primary recipe category. |
| `cuisine` | String | Cuisine when listed. |
| `keywords` | Array | Recipe tags when listed. |
| `prepTime` | String | Preparation time. |
| `cookTime` | String | Cooking time. |
| `additionalTime` | String | Additional time when listed. |
| `totalTime` | String | Total time. |
| `servings` | String | Number of servings or yield. |
| `rating` | Object | `value`, `count`, and `reviewCount`. |
| `photoCount` | Number | Number of user photos when shown. |
| `ingredients` | Array | Ingredient lines ready for display. |
| `ingredientItems` | Array | Parsed `quantity`, `unit`, `name`, and `text` values. |
| `instructions` | Array | Ordered instruction text. |
| `instructionImages` | Array | Step image URLs when the page includes them. |
| `details` | Object | Labeled page values such as Prep Time, Cook Time, and Servings. |
| `nutrition` | Object | `summary`, `dailyValues`, and `extra` nutrition data. |
| `scrapedAt` | String | ISO timestamp for when the recipe was collected. |

## Usage Examples

### Basic keyword search

Collect chicken recipes with the default page limit:

```json
{
  "query": "chicken",
  "results_wanted": 20,
  "max_pages": 5
}
```

### Specific recipe URLs

Collect named recipes without running a search:

```json
{
  "startUrls": [
    { "url": "https://www.allrecipes.com/recipe/223042/chicken-parmesan/" },
    { "url": "https://www.allrecipes.com/recipe/242342/fiesta-slow-cooker-shredded-chicken-tacos/" }
  ],
  "results_wanted": 10
}
```

### Search URL with a page limit

Use an Allrecipes search URL and read up to two result pages:

```json
{
  "startUrls": [
    { "url": "https://www.allrecipes.com/search?q=lasagna" }
  ],
  "results_wanted": 40,
  "max_pages": 2
}
```

### Run with a proxy

Enable an Apify proxy if your network is repeatedly blocked:

```json
{
  "query": "vegan dinner",
  "results_wanted": 50,
  "max_pages": 5,
  "proxyConfiguration": {
    "useApifyProxy": true
  }
}
```

## Sample Output

```json
{
  "name": "Chicken Parmesan",
  "description": "For the best chicken Parmesan, try Chef John's version that's pan-fried and then baked, delivering impressive results with a crispier crust than most recipes.",
  "url": "https://www.allrecipes.com/recipe/223042/chicken-parmesan/",
  "image": "https://www.allrecipes.com/thmb/J0U0wHxsY1r-I1JUJ5jXcwCnzRI=/1500x0/filters:no_upscale():max_bytes(150000):strip_icc()/223042-Chicken-Parmesan-mfs_001-7ab952346edc4b2da36f3c0259b78543.jpg",
  "author": "John Mitzewich",
  "updatedOn": "July 20, 2026",
  "breadcrumbs": ["Recipes", "Main Dishes", "Chicken", "Parmesan"],
  "category": "Dinner",
  "cuisine": "Italian Inspired",
  "prepTime": "15 mins",
  "cookTime": "20 mins",
  "additionalTime": "10 mins",
  "totalTime": "45 mins",
  "servings": "4",
  "rating": {
    "value": 4.9,
    "count": 5194,
    "reviewCount": 3788
  },
  "photoCount": 1662,
  "ingredients": [
    "4 skinless, boneless chicken breast halves",
    "salt and freshly ground black pepper to taste",
    "2 large eggs"
  ],
  "ingredientItems": [
    {
      "quantity": "4",
      "name": "skinless, boneless chicken breast halves",
      "text": "4 skinless, boneless chicken breast halves"
    },
    {
      "name": "salt and freshly ground black pepper to taste",
      "text": "salt and freshly ground black pepper to taste"
    }
  ],
  "instructions": [
    "Gather the ingredients. Preheat the oven to 450 degrees F (230 degrees C).",
    "Place chicken breasts between two sheets of heavy plastic on a solid, level surface. Firmly pound chicken to a thickness of 1/2-inch."
  ],
  "details": {
    "Prep Time": "15 mins",
    "Cook Time": "20 mins",
    "Additional Time": "10 mins",
    "Total Time": "45 mins",
    "Servings": "4"
  },
  "nutrition": {
    "summary": {
      "Calories": "471",
      "Fat": "25g",
      "Carbs": "25g",
      "Protein": "42g"
    },
    "dailyValues": {
      "Total Fat 25g": "32%",
      "Saturated Fat 9g": "46%",
      "Cholesterol 187mg": "62%",
      "Sodium 840mg": "37%",
      "Total Carbohydrate 25g": "9%",
      "Protein 42g": "84%"
    },
    "extra": {
      "servingsPerRecipe": "4"
    }
  },
  "scrapedAt": "2026-10-23T14:10:18.796Z"
}
```

## Tips for Best Results

- Start with a specific keyword. Broad terms such as `chicken` return many pages; narrow terms such as `chicken parmesan` produce a tighter dataset.
- Set **Maximum Recipes** to the number you actually need. Smaller runs finish sooner and use fewer resources.
- Use **Maximum Pages per Search** to control how far the Actor reads through search results.
- Supply direct recipe URLs when you already know which recipes you want. This avoids search entirely.
- Some recipes do not list cuisine, tester, keywords, or step images. Missing optional fields are normal.
- Check the dataset after the first run before scheduling a larger collection.

## Integrations

- Send recipe rows to Google Sheets for review or publishing.
- Trigger another service with a webhook when a run finishes.
- Connect recipe data to Make or Zapier workflows.
- Read datasets from your own application through the Apify API.
- Download results as CSV, Excel, JSON, or XML.

## Frequently Asked Questions

### Can I scrape a specific Allrecipes recipe?

Yes. Add the recipe URL to `startUrls`. The Actor reads that page directly and saves the recipe without running a search.

### Can I search by ingredient or meal type?

Yes. Enter an ingredient, dish name, or meal type in `query`. Examples include `chicken breast`, `vegetarian dinner`, `chocolate cake`, and `slow cooker`.

### How many recipes are on one search page?

Allrecipes search pages usually show about 24 recipes. The Actor follows pagination up to the `max_pages` limit.

### Can I export the dataset to CSV or Excel?

Yes. Apify datasets can be downloaded as CSV, Excel, JSON, XML, and other supported formats.

### Can I run this Actor on a schedule?

Yes. Create a schedule in Apify Console to run the Actor hourly, daily, weekly, or at another interval. Scheduled runs keep a recipe collection current without manual work.

### Why are some fields missing from a result?

The Actor only saves values that appear on the page. A recipe may not list a tester, cuisine, keywords, step images, or full nutrition data. Missing optional fields do not mean the recipe failed.

### What happens if Allrecipes changes its pages?

The Actor checks more than one part of a recipe page and retries temporary page errors. If a run returns no recipes, check the run log and report the issue through the Issues tab so the extraction can be updated.

### Is it legal to scrape Allrecipes?

Scraping public web data can be legal, but you are responsible for complying with applicable laws, website terms, and privacy rules. Review Allrecipes' terms and use the data responsibly.

## Support

For issues, feature requests, or custom Actor work, use the Issues tab on the Actor page or contact the developer through Apify.

## Legal Notice

This Actor is designed for legitimate collection of publicly available recipe data. Users are responsible for using the data responsibly and complying with applicable laws and website terms.
