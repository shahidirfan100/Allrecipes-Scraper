// Allrecipes.com scraper - JSON API + HTML fallback implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            query = 'Chicken', 
            results_wanted: RESULTS_WANTED_RAW = 50,
            max_pages: MAX_PAGES_RAW = 10, 
            startUrls, 
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 10;

        const toAbs = (href, base = 'https://www.allrecipes.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (searchQuery) => {
            const u = new URL('https://www.allrecipes.com/search');
            if (searchQuery) u.searchParams.set('q', String(searchQuery).trim());
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) {
            initial.push(...startUrls.map(item => typeof item === 'string' ? item : item.url));
        } else {
            initial.push(buildStartUrl(query));
        }

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;

        // Try to fetch recipes via JSON API first
        async function fetchRecipesViaAPI(searchQuery, page = 1) {
            try {
                const apiUrl = `https://www.allrecipes.com/search?q=${encodeURIComponent(searchQuery)}`;
                const response = await gotScraping({ 
                    url: apiUrl, 
                    proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                    responseType: 'text'
                });
                
                const $ = cheerioLoad(response.body);
                const recipes = [];
                
                // Look for structured data in JSON-LD
                $('script[type="application/ld+json"]').each((_, script) => {
                    try {
                        const json = JSON.parse($(script).html() || '{}');
                        if (json['@type'] === 'Recipe' || (Array.isArray(json) && json.some(item => item['@type'] === 'Recipe'))) {
                            const recipeData = Array.isArray(json) ? json.find(item => item['@type'] === 'Recipe') : json;
                            if (recipeData) {
                                recipes.push({
                                    name: recipeData.name,
                                    description: recipeData.description,
                                    image: recipeData.image?.url || recipeData.image,
                                    prepTime: recipeData.prepTime,
                                    cookTime: recipeData.cookTime,
                                    totalTime: recipeData.totalTime,
                                    recipeYield: recipeData.recipeYield,
                                    recipeIngredient: recipeData.recipeIngredient,
                                    recipeInstructions: recipeData.recipeInstructions,
                                    aggregateRating: recipeData.aggregateRating,
                                    author: recipeData.author?.name || recipeData.author,
                                    url: recipeData.url,
                                    source: 'json-ld'
                                });
                            }
                        }
                    } catch (e) { /* ignore */ }
                });
                
                return { recipes, html: response.body };
            } catch (err) {
                log.warning(`API fetch failed: ${err.message}`);
                return { recipes: [], html: null };
            }
        }

        function extractRecipeFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) {
                            return {
                                name: e.name || null,
                                description: e.description || null,
                                image: e.image?.url || e.image || null,
                                prepTime: e.prepTime || null,
                                cookTime: e.cookTime || null,
                                totalTime: e.totalTime || null,
                                recipeYield: e.recipeYield || null,
                                recipeIngredient: e.recipeIngredient || [],
                                recipeInstructions: e.recipeInstructions || [],
                                aggregateRating: e.aggregateRating || null,
                                author: e.author?.name || e.author || null,
                                recipeCategory: e.recipeCategory || null,
                                recipeCuisine: e.recipeCuisine || null,
                                keywords: e.keywords || null,
                                nutrition: e.nutrition || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        function findRecipeLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                // Allrecipes recipe URLs typically contain /recipe/
                if (/\/recipe\/\d+/i.test(href) || /allrecipes\.com\/recipe/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs && !abs.includes('#')) links.add(abs);
                }
            });
            
            // Also check for card components commonly used on Allrecipes
            $('.card--no-image a, .mntl-card-list-items a, .comp.mntl-card-list-items a, article a').each((_, a) => {
                const href = $(a).attr('href');
                if (href && /\/recipe\/\d+/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs && !abs.includes('#')) links.add(abs);
                }
            });
            
            return [...links];
        }

        function findNextPage($, base, currentPage) {
            // Allrecipes search uses pagination with page numbers
            const nextPageNum = currentPage + 1;
            const u = new URL(base);
            u.searchParams.set('page', String(nextPageNum));
            
            // Check if next page button exists
            const hasNext = $('a[aria-label*="next"], .pagination__next, button[aria-label*="next"]').length > 0;
            if (hasNext) return u.href;
            
            return null;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 5,
            requestHandlerTimeoutSecs: 90,
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    const links = findRecipeLinks($, request.url);
                    crawlerLog.info(`SEARCH PAGE ${pageNo} -> found ${links.length} recipe links`);

                    const remaining = RESULTS_WANTED - saved;
                    const toEnqueue = links.slice(0, Math.max(0, remaining));
                    
                    if (toEnqueue.length) {
                        await enqueueLinks({ urls: toEnqueue, userData: { label: 'RECIPE' } });
                    }

                    // Handle pagination
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES && links.length > 0) {
                        const next = findNextPage($, request.url, pageNo);
                        if (next) {
                            await enqueueLinks({ urls: [next], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                        }
                    }
                    return;
                }

                if (label === 'RECIPE') {
                    if (saved >= RESULTS_WANTED) return;
                    
                    try {
                        // Priority 1: Try JSON-LD structured data
                        let recipeData = extractRecipeFromJsonLd($);
                        
                        // Priority 2: Fallback to HTML parsing if JSON-LD not available
                        if (!recipeData || !recipeData.name) {
                            crawlerLog.info(`JSON-LD not found for ${request.url}, falling back to HTML parsing`);
                            recipeData = {};
                            
                            // Extract recipe name
                            recipeData.name = $('h1.article-heading, h1.headline, h1').first().text().trim() || null;
                            
                            // Extract description
                            recipeData.description = $('p.article-subheading, .recipe-summary, p.description').first().text().trim() || null;
                            
                            // Extract image
                            const imgSrc = $('img.primary-image, .recipe-image img, img[src*="recipe"]').first().attr('src');
                            recipeData.image = imgSrc ? toAbs(imgSrc, request.url) : null;
                            
                            // Extract times
                            recipeData.prepTime = $('[data-unit*="min"]:contains("Prep"), .recipe-meta-item:contains("Prep Time")').first().text().trim() || null;
                            recipeData.cookTime = $('[data-unit*="min"]:contains("Cook"), .recipe-meta-item:contains("Cook Time")').first().text().trim() || null;
                            recipeData.totalTime = $('[data-unit*="min"]:contains("Total"), .recipe-meta-item:contains("Total Time")').first().text().trim() || null;
                            
                            // Extract servings/yield
                            recipeData.recipeYield = $('[data-unit="serving"], .recipe-meta-item:contains("Servings"), #recipe-serving').first().text().trim() || null;
                            
                            // Extract ingredients
                            const ingredients = [];
                            $('li.mntl-structured-ingredients__list-item, .ingredients-item, [data-ingredient], ul.ingredients li').each((_, li) => {
                                const text = $(li).text().trim();
                                if (text) ingredients.push(text);
                            });
                            recipeData.recipeIngredient = ingredients.length > 0 ? ingredients : null;
                            
                            // Extract instructions
                            const instructions = [];
                            $('#recipe__steps li, .recipe-directions li, [data-instruction], ol.instructions li, .mntl-sc-block-html').each((_, li) => {
                                const text = $(li).text().trim();
                                if (text && text.length > 5) instructions.push(text);
                            });
                            recipeData.recipeInstructions = instructions.length > 0 ? instructions : null;
                            
                            // Extract rating
                            const ratingValue = $('[data-rating], .rating-value, meta[itemprop="ratingValue"]').first().attr('content') || 
                                               $('[data-rating], .rating-value').first().text().trim();
                            const reviewCount = $('[data-review-count], .review-count, meta[itemprop="reviewCount"]').first().attr('content') || 
                                               $('[data-review-count], .review-count').first().text().trim();
                            
                            if (ratingValue || reviewCount) {
                                recipeData.aggregateRating = {
                                    ratingValue: ratingValue || null,
                                    reviewCount: reviewCount || null
                                };
                            }
                            
                            // Extract author
                            recipeData.author = $('[rel="author"], .author-name, meta[name="author"]').first().attr('content') || 
                                               $('[rel="author"], .author-name').first().text().trim() || null;
                        }

                        const item = {
                            name: recipeData.name || null,
                            description: recipeData.description || null,
                            image: recipeData.image || null,
                            prepTime: recipeData.prepTime || null,
                            cookTime: recipeData.cookTime || null,
                            totalTime: recipeData.totalTime || null,
                            servings: recipeData.recipeYield || null,
                            ingredients: recipeData.recipeIngredient || [],
                            instructions: recipeData.recipeInstructions || [],
                            rating: recipeData.aggregateRating ? {
                                value: recipeData.aggregateRating.ratingValue || null,
                                count: recipeData.aggregateRating.reviewCount || recipeData.aggregateRating.ratingCount || null
                            } : null,
                            author: recipeData.author || null,
                            category: recipeData.recipeCategory || null,
                            cuisine: recipeData.recipeCuisine || null,
                            keywords: recipeData.keywords || null,
                            nutrition: recipeData.nutrition || null,
                            url: request.url,
                            scrapedAt: new Date().toISOString()
                        };

                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(`Scraped recipe: ${item.name} (${saved}/${RESULTS_WANTED})`);
                    } catch (err) {
                        crawlerLog.error(`Failed to scrape recipe ${request.url}: ${err.message}`);
                    }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`✓ Scraping completed. Total recipes saved: ${saved}`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
