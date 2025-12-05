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

        const safeJsonParse = (text) => {
            try { return JSON.parse(text); } catch { return null; }
        };

        const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
        const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];

        const normalizeInstructions = (instructions) => {
            const steps = [];
            const walk = (node) => {
                if (!node) return;
                if (Array.isArray(node)) {
                    node.forEach(walk);
                    return;
                }
                if (typeof node === 'string') {
                    const t = cleanText(node);
                    if (t) steps.push(t);
                    return;
                }
                if (Array.isArray(node.itemListElement)) {
                    walk(node.itemListElement);
                    return;
                }
                const text = node.text || node.name || node.description;
                if (text) {
                    const t = cleanText(text);
                    if (t) steps.push(t);
                }
            };

            walk(instructions);
            return steps;
        };

        const normalizeRating = (aggregateRating) => {
            if (!aggregateRating) return null;
            const ratingValue = aggregateRating.ratingValue ?? aggregateRating.rating ?? aggregateRating.value ?? null;
            const ratingCount = aggregateRating.ratingCount ?? aggregateRating.reviewCount ?? aggregateRating.ratingVotes ?? aggregateRating.count ?? null;
            if (!ratingValue && !ratingCount) return null;
            return {
                ratingValue: ratingValue ?? null,
                ratingCount: ratingCount ?? null,
                reviewCount: aggregateRating.reviewCount ?? ratingCount ?? null,
            };
        };

        const mergeRecipeData = (primary = {}, fallback = {}) => {
            const merged = { ...primary };
            for (const [key, value] of Object.entries(fallback)) {
                const current = merged[key];
                const isEmptyArray = Array.isArray(current) && current.length === 0;
                if (current === undefined || current === null || current === '' || isEmptyArray) {
                    merged[key] = value;
                }
            }
            return merged;
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
            const candidates = [];

            for (let i = 0; i < scripts.length; i++) {
                const parsed = safeJsonParse($(scripts[i]).contents().text());
                if (!parsed) continue;

                const nodes = [];
                nodes.push(...asArray(parsed));
                nodes.push(...asArray(parsed['@graph']));
                nodes.push(...asArray(parsed.graph));
                if (parsed.mainEntity) nodes.push(parsed.mainEntity);
                if (parsed.mainEntityOfPage) nodes.push(parsed.mainEntityOfPage);

                nodes.forEach((node) => {
                    if (!node) return;
                    const types = asArray(node['@type'] || node.type);
                    if (types.includes('Recipe')) candidates.push(node);
                });
            }

            const recipe = candidates.find((r) => r.name) || candidates[0];
            if (!recipe) return null;

            const instructions = normalizeInstructions(recipe.recipeInstructions || recipe.instructions);
            const ingredients = asArray(recipe.recipeIngredient || recipe.ingredients).map(cleanText).filter(Boolean);
            const rating = normalizeRating(recipe.aggregateRating);

            return {
                name: recipe.name || null,
                description: recipe.description || null,
                image: (typeof recipe.image === 'string' ? recipe.image : recipe.image?.url) || null,
                prepTime: recipe.prepTime || recipe.prep_time || null,
                cookTime: recipe.cookTime || recipe.cook_time || null,
                totalTime: recipe.totalTime || recipe.total_time || null,
                servings: recipe.servings || recipe.recipeYield || null,
                recipeYield: recipe.recipeYield || recipe.servings || null,
                recipeIngredient: ingredients.length ? ingredients : null,
                recipeInstructions: instructions.length ? instructions : null,
                aggregateRating: rating,
                author: uniq(asArray(recipe.author).map((a) => (typeof a === 'string' ? a : a?.name))).join(', ') || null,
                recipeCategory: uniq(asArray(recipe.recipeCategory)).join(', ') || null,
                recipeCuisine: uniq(asArray(recipe.recipeCuisine)).join(', ') || null,
                keywords: uniq(asArray(recipe.keywords || recipe.keyword)).join(', ') || null,
                nutrition: recipe.nutrition || null,
            };
        }

        function extractRecipeFromHtml($, pageUrl) {
            const pickAttr = (selectors, attr) => {
                for (const sel of selectors) {
                    const val = $(sel).first().attr(attr);
                    if (val && String(val).trim()) return String(val).trim();
                }
                return null;
            };

            const pickText = (selectors) => {
                for (const sel of selectors) {
                    const val = $(sel).first().text();
                    if (val && String(val).trim()) return cleanText(val);
                }
                return null;
            };

            const title = pickText(['h1.article-heading', 'h1.headline', 'h1#article-heading', 'h1[data-testid="Heading"]', 'h1']);

            const description = pickAttr(['meta[property="og:description"]', 'meta[name="description"]'], 'content') ||
                pickText(['p.article-subheading', '.recipe-summary p', '.mntl-recipe-summary__content', '.article-subheading', 'p.description']);

            const image = pickAttr(['meta[property="og:image"]', 'meta[name="twitter:image"]'], 'content') ||
                pickAttr(['img.primary-image', '.recipe-image img', 'img[src*="/recipe/"]'], 'src');

            let prepTime = pickAttr(['meta[itemprop="prepTime"]', 'time[itemprop="prepTime"]'], 'content') ||
                pickAttr(['time[data-prep-time]'], 'datetime');
            let cookTime = pickAttr(['meta[itemprop="cookTime"]', 'time[itemprop="cookTime"]'], 'content') ||
                pickAttr(['time[data-cook-time]'], 'datetime');
            let totalTime = pickAttr(['meta[itemprop="totalTime"]', 'time[itemprop="totalTime"]'], 'content') ||
                pickAttr(['time[data-total-time]'], 'datetime');

            let servings = pickAttr(['meta[itemprop="recipeYield"]'], 'content') ||
                pickText(['.recipe-meta-item:contains("Servings") .recipe-meta-item-body', '#recipe-serving', '[data-ingredient-servings]']);

            const ratingValueRaw = pickAttr(['meta[itemprop="ratingValue"]', 'meta[property="og:rating"]'], 'content') ||
                pickText(['.review-star-text', '[data-rating]', '.rating-value']);
            const ratingCountRaw = pickAttr(['meta[itemprop="ratingCount"]', 'meta[itemprop="reviewCount"]'], 'content') ||
                pickText(['.review-count', '[data-review-count]']);
            const aggregateRating = normalizeRating({
                ratingValue: ratingValueRaw,
                ratingCount: ratingCountRaw,
                reviewCount: ratingCountRaw,
            });

            const author = pickAttr(['meta[name="author"]', 'meta[property="article:author"]'], 'content') ||
                pickText(['[rel="author"]', '.author-name', '.mntl-attribution__item-name']);

            const nutrition = {};
            $('.mntl-nutrition-facts-summary__table .mntl-nutrition-facts-summary__item, .nutrition-summary-facts li, [data-nutrition-item]').each((_, el) => {
                const label = cleanText($(el).find('.mntl-nutrition-facts-summary__heading, .label, .nutrition-card__label').text() || '');
                const value = cleanText($(el).find('.mntl-nutrition-facts-summary__value, .value, .nutrition-card__value').text() || '');
                if (label && value) nutrition[label.replace(/:$/, '')] = value;
            });
            const calories = pickText(['.calorie-count', '[data-calories]']);
            if (calories && !nutrition.calories) nutrition.calories = calories;
            const nutritionInfo = Object.keys(nutrition).length ? nutrition : null;

            const ingredients = [];
            $('.ingredients-item, .mntl-structured-ingredients__list-item, [data-ingredient], ul.ingredients li').each((_, li) => {
                const text = cleanText($(li).text());
                if (text) ingredients.push(text);
            });

            const instructions = [];
            $('.instructions-section-item, .recipe-directions__list--item, #recipe__steps li, ol.instructions li').each((_, li) => {
                const text = cleanText($(li).text());
                if (text && text.length > 3) instructions.push(text);
            });
            if (!instructions.length) {
                $('.mntl-sc-block-html').each((_, el) => {
                    const text = cleanText($(el).text());
                    if (text) instructions.push(text);
                });
            }

            const breadcrumbs = $('.breadcrumbs__item a, nav.breadcrumbs a').map((_, a) => cleanText($(a).text())).get().filter(Boolean);
            const category = breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2] : breadcrumbs[breadcrumbs.length - 1] || null;
            const cuisine = breadcrumbs.find((b) => /cuisine|world/i.test(b)) || null;

            const keywords = pickAttr(['meta[name="keywords"]'], 'content') ||
                $('.recipe-tags a, .mntl-inline-list__item a').map((_, a) => cleanText($(a).text())).get().filter(Boolean).join(', ');

            $('.recipe-meta-item, .mntl-recipe-details__item').each((_, el) => {
                const label = cleanText($(el).find('.recipe-meta-item-header, .mntl-recipe-details__item-label').text()).toLowerCase();
                const value = cleanText($(el).find('.recipe-meta-item-body, .mntl-recipe-details__item-value').text());
                if (!label || !value) return;
                if (!prepTime && label.includes('prep')) prepTime = value;
                if (!cookTime && label.includes('cook')) cookTime = value;
                if (!totalTime && label.includes('total')) totalTime = value;
                if (!servings && label.includes('servings')) servings = value;
            });

            return {
                name: title || null,
                description: description || null,
                image: image ? toAbs(image, pageUrl) : null,
                prepTime: prepTime || null,
                cookTime: cookTime || null,
                totalTime: totalTime || null,
                servings: servings || null,
                recipeYield: servings || null,
                recipeIngredient: ingredients.length ? uniq(ingredients) : null,
                recipeInstructions: instructions.length ? uniq(instructions) : null,
                aggregateRating,
                author: author || null,
                recipeCategory: category || null,
                recipeCuisine: cuisine || null,
                keywords: keywords || null,
                nutrition: nutritionInfo,
            };
        }

        function findRecipeLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                // Allrecipes recipe URLs always contain /recipe/<id>/
                if (/\/recipe\/\d+/i.test(href)) {
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
            const candidates = new Set();
            const addHref = (href) => {
                const abs = toAbs(href, base);
                if (abs) candidates.add(abs);
            };

            // Explicit rel=next
            const relNext = $('link[rel="next"], a[rel="next"]').attr('href');
            if (relNext) addHref(relNext);

            // Specific Allrecipes pagination component
            const mntlNext = $('span.mntl-pagination__next-text').closest('a, button').attr('href');
            if (mntlNext) addHref(mntlNext);

            // Elements that suggest "next"
            $('a[aria-label], button[aria-label]').each((_, el) => {
                const label = ($(el).attr('aria-label') || '').toLowerCase();
                if (label.includes('next')) addHref($(el).attr('href'));
            });
            $('a, button').each((_, el) => {
                const text = cleanText($(el).text() || '').toLowerCase();
                if (text.includes('next')) addHref($(el).attr('href'));
            });

            // Any page query param > current
            $('a[href*="page="]').each((_, el) => {
                const href = $(el).attr('href');
                if (!href) return;
                const abs = toAbs(href, base);
                if (!abs) return;
                try {
                    const u = new URL(abs);
                    const page = Number(u.searchParams.get('page'));
                    if (Number.isFinite(page) && page > currentPage) candidates.add(abs);
                } catch { /* ignore bad urls */ }
            });

            // Fallback: increment page param on current URL
            const fallbackUrl = (() => {
                try {
                    const u = new URL(base);
                    u.searchParams.set('page', String(currentPage + 1));
                    return u.href;
                } catch { return null; }
            })();
            if (fallbackUrl) candidates.add(fallbackUrl);

            const next = [...candidates][0];
            return next || null;
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
                        // Safety: if a non-recipe URL slipped in, treat page as listing
                        if (!/\/recipe\/\d+/i.test(request.url)) {
                            const links = findRecipeLinks($, request.url);
                            if (links.length) {
                                const remaining = RESULTS_WANTED - saved;
                                const toEnqueue = links.slice(0, Math.max(0, remaining));
                                if (toEnqueue.length) {
                                    await enqueueLinks({ urls: toEnqueue, userData: { label: 'RECIPE' } });
                                    crawlerLog.info(`Reclassified ${request.url} as LIST; enqueued ${toEnqueue.length} recipes`);
                                }
                            }
                            return;
                        }

                        const jsonRecipe = extractRecipeFromJsonLd($) || {};
                        const htmlRecipe = extractRecipeFromHtml($, request.url) || {};
                        const recipeData = mergeRecipeData(jsonRecipe, htmlRecipe);
                        const rating = normalizeRating(recipeData.aggregateRating);

                        if (!recipeData.name && !recipeData.recipeIngredient && !recipeData.recipeInstructions) {
                            const links = findRecipeLinks($, request.url);
                            if (links.length) {
                                const remaining = RESULTS_WANTED - saved;
                                const toEnqueue = links.slice(0, Math.max(0, remaining));
                                if (toEnqueue.length) {
                                    await enqueueLinks({ urls: toEnqueue, userData: { label: 'RECIPE' } });
                                    crawlerLog.info(`Recipe data not found; treating ${request.url} as LIST and enqueuing ${toEnqueue.length} recipes`);
                                }
                            }
                            return;
                        }

                        const item = {
                            name: recipeData.name || null,
                            description: recipeData.description || null,
                            image: recipeData.image || null,
                            prepTime: recipeData.prepTime || null,
                            cookTime: recipeData.cookTime || null,
                            totalTime: recipeData.totalTime || null,
                            servings: recipeData.servings || recipeData.recipeYield || null,
                            ingredients: recipeData.recipeIngredient || [],
                            instructions: recipeData.recipeInstructions || [],
                            rating: rating ? {
                                value: rating.ratingValue ?? null,
                                count: rating.ratingCount ?? rating.reviewCount ?? null
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
        log.info(`Scraping completed. Total recipes saved: ${saved}`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
