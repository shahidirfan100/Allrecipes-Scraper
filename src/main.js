import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';

const BASE_URL = 'https://www.allrecipes.com';
const SEARCH_COMPONENTS = 'mntl-search-results__list_1,mntl-pagination_1';
const RECIPE_COMPONENTS = [
    'article-preheading_1',
    'article-header--recipe_1',
    'mntl-article-meta-dynamic_1',
    'mm-recipes-review-bar_1',
    'article__photo-ribbon_1',
    'mm-recipes-details_1',
    'mm-recipes-intro_1',
    'mm-recipes-structured-ingredients_1',
    'mm-recipes-steps_1',
    'mm-recipes-nutrition-facts_1',
].join(',');
const SEARCH_PAGE_SIZE = 24;

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined) return [];
    return [value];
}

function cleanText(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\s+/g, ' ').trim();
}

function parseResponseBody(body) {
    if (!body) return {};
    if (typeof body === 'object') return body;
    try {
        return JSON.parse(body);
    } catch {
        return {};
    }
}

function parseNumber(value) {
    const text = cleanText(value);
    if (!text) return null;
    const match = text.match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0].replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
}

function canonicalRecipeUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl, BASE_URL);
        if (!/\/recipe\/\d+/i.test(parsed.pathname)) return null;
        parsed.hash = '';
        parsed.search = '';
        parsed.hostname = 'www.allrecipes.com';
        parsed.protocol = 'https:';
        parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/';
        return parsed.toString();
    } catch {
        return null;
    }
}

function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const normalized = cleanText(value);
        if (!normalized) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function isNullish(value) {
    if (value === null || value === undefined || value === '') return true;
    if (Array.isArray(value) && value.length === 0) return true;
    if (value && typeof value === 'object' && Object.keys(value).length === 0) return true;
    return false;
}

function dedupeArray(values) {
    const seen = new Set();
    const deduped = [];

    for (const value of values) {
        const key = typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(value);
    }

    return deduped;
}

function removeNullishDeep(value) {
    if (Array.isArray(value)) {
        const cleaned = value
            .map(removeNullishDeep)
            .filter((entry) => !isNullish(entry));
        const deduped = dedupeArray(cleaned);
        return deduped.length ? deduped : null;
    }

    if (value && typeof value === 'object') {
        const entries = Object.entries(value)
            .map(([key, val]) => [key, removeNullishDeep(val)])
            .filter(([, val]) => !isNullish(val));

        return entries.length ? Object.fromEntries(entries) : null;
    }

    return value;
}

function getComponentHtml(payload, key) {
    const html = payload?.[key]?.html;
    return typeof html === 'string' ? html : '';
}

function parseSearchLinks(componentHtml) {
    const links = new Set();

    for (const match of componentHtml.matchAll(/https?:\/\/www\.allrecipes\.com\/recipe\/\d+\/[a-z0-9-]+\/?/gi)) {
        const canonical = canonicalRecipeUrl(match[0]);
        if (canonical) links.add(canonical);
    }

    for (const match of componentHtml.matchAll(/href=["'](\/recipe\/\d+\/[^"'?#]+)["']/gi)) {
        const canonical = canonicalRecipeUrl(new URL(match[1], BASE_URL).toString());
        if (canonical) links.add(canonical);
    }

    return [...links];
}

function extractDetailMap(detailsHtml) {
    const $ = cheerioLoad(detailsHtml);
    const detailMap = {};

    $('.mm-recipes-details__item').each((_, item) => {
        const label = cleanText($(item).find('.mm-recipes-details__label').first().text()).replace(/:$/, '');
        const value = cleanText($(item).find('.mm-recipes-details__value').first().text());
        if (label && value) detailMap[label] = value;
    });

    return detailMap;
}

function extractIngredients(ingredientsHtml) {
    const $ = cheerioLoad(ingredientsHtml);
    const ingredientItems = [];

    $('.mm-recipes-structured-ingredients__list-item, li').each((_, li) => {
        const quantity = cleanText($(li).find('[data-ingredient-quantity]').first().text());
        const unit = cleanText($(li).find('[data-ingredient-unit]').first().text());
        const name = cleanText($(li).find('[data-ingredient-name]').first().text());

        let text = cleanText([quantity, unit, name].filter(Boolean).join(' '));
        if (!text) text = cleanText($(li).text());
        if (!text) return;

        ingredientItems.push({
            quantity: quantity || null,
            unit: unit || null,
            name: name || text,
            text,
        });
    });

    const uniqueItems = dedupeArray(ingredientItems);
    const ingredients = uniqueStrings(uniqueItems.map((item) => item.text));

    return {
        ingredients,
        ingredientItems: uniqueItems,
    };
}

function extractInstructions(stepsHtml) {
    const $ = cheerioLoad(stepsHtml);
    const instructions = [];
    const instructionImages = [];

    $('ol li, .mm-recipes-steps__content li').each((_, li) => {
        const stepParts = $(li)
            .find('p.mntl-sc-block-html')
            .map((__, p) => cleanText($(p).text()))
            .get()
            .filter(Boolean);

        const stepText = cleanText(stepParts.join(' ')) || cleanText($(li).text());
        if (stepText) instructions.push(stepText);

        const image = $(li).find('img').first();
        const imageUrl =
            cleanText(image.attr('data-hi-res-src'))
            || cleanText(image.attr('data-src'))
            || cleanText(image.attr('src'));

        if (imageUrl) instructionImages.push(imageUrl);
    });

    if (!instructions.length) {
        $('.mntl-sc-block-html').each((_, block) => {
            const text = cleanText($(block).text());
            if (text) instructions.push(text);
        });
    }

    return {
        instructions: uniqueStrings(instructions),
        instructionImages: uniqueStrings(instructionImages),
    };
}

function extractNutrition(nutritionHtml) {
    const $ = cheerioLoad(nutritionHtml);
    const tables = $('table');
    const summary = {};
    const dailyValues = {};
    const extra = {};

    const summaryTable = tables.eq(0);
    summaryTable.find('tr').each((_, row) => {
        const cols = $(row)
            .find('th, td')
            .map((__, col) => cleanText($(col).text()))
            .get()
            .filter(Boolean);

        if (cols.length === 2) {
            const [first, second] = cols;
            if (/calories|fat|carbs|protein/i.test(second)) {
                summary[second] = first;
            } else if (/calories|fat|carbs|protein/i.test(first)) {
                summary[first] = second;
            }
        }
    });

    const detailTable = tables.eq(1);
    detailTable.find('tr').each((_, row) => {
        const cols = $(row)
            .find('th, td')
            .map((__, col) => cleanText($(col).text()))
            .get()
            .filter(Boolean);

        if (cols.length === 2) {
            dailyValues[cols[0]] = cols[1];
            return;
        }

        if (cols.length === 1) {
            const line = cols[0];
            if (/Servings Per Recipe/i.test(line)) {
                extra.servingsPerRecipe = cleanText(line.replace(/Servings Per Recipe/i, ''));
            }
            if (/Calories/i.test(line) && !summary.Calories) {
                extra.calories = line.replace(/Calories/i, '').trim();
            }
        }
    });

    return { summary, dailyValues, extra };
}

function extractRecipeData(recipeUrl, payload) {
    const headerHtml = getComponentHtml(payload, 'article-header--recipe_1');
    const preheadingHtml = getComponentHtml(payload, 'article-preheading_1');
    const metaHtml = getComponentHtml(payload, 'mntl-article-meta-dynamic_1');
    const reviewHtml = getComponentHtml(payload, 'mm-recipes-review-bar_1');
    const photoHtml = getComponentHtml(payload, 'article__photo-ribbon_1');
    const detailsHtml = getComponentHtml(payload, 'mm-recipes-details_1');
    const introHtml = getComponentHtml(payload, 'mm-recipes-intro_1');
    const ingredientsHtml = getComponentHtml(payload, 'mm-recipes-structured-ingredients_1');
    const stepsHtml = getComponentHtml(payload, 'mm-recipes-steps_1');
    const nutritionHtml = getComponentHtml(payload, 'mm-recipes-nutrition-facts_1');

    const $header = cheerioLoad(headerHtml);
    const $pre = cheerioLoad(preheadingHtml);
    const $meta = cheerioLoad(metaHtml);
    const $review = cheerioLoad(reviewHtml);
    const $photo = cheerioLoad(photoHtml);
    const $intro = cheerioLoad(introHtml);

    const name = cleanText($header('h1').first().text()) || null;
    const description = cleanText($header('p').first().text()) || cleanText($intro('p').first().text()) || null;

    const breadcrumbs = uniqueStrings(
        $pre('a')
            .map((_, link) => cleanText($pre(link).text()))
            .get(),
    );

    const author =
        cleanText($meta('.mntl-bylines__group--ugc_recipe .mntl-attribution__item-name').first().text())
        || cleanText($meta('.mntl-attribution__item-descriptor:contains("Submitted by")').next('.mntl-attribution__item-name').first().text())
        || null;

    const testedBy =
        cleanText($meta('.mntl-bylines__group--recipe_tester .mntl-attribution__item-name').first().text())
        || null;

    const updatedOnRaw = cleanText($meta('.mntl-attribution__item-date').first().text());
    const updatedOn = updatedOnRaw.replace(/^Updated on\s*/i, '') || null;

    const ratingValue = parseNumber($review('.mm-recipes-review-bar__rating').first().text());
    const ratingCount = parseNumber($review('.mm-recipes-review-bar__rating-count').first().text());
    const reviewCount = parseNumber($review('.mm-recipes-review-bar__comment-count').first().text());
    const photoCount = parseNumber($review('.recipe-review-bar__photo-count').first().text());

    const image =
        cleanText($photo('img').first().attr('data-hi-res-src'))
        || cleanText($photo('img').first().attr('data-src'))
        || cleanText($photo('img').first().attr('src'))
        || null;

    const detailMap = extractDetailMap(detailsHtml);

    const prepTime = detailMap['Prep Time'] || null;
    const cookTime = detailMap['Cook Time'] || null;
    const additionalTime = detailMap['Additional Time'] || null;
    const totalTime = detailMap['Total Time'] || null;
    const servings = detailMap.Servings || detailMap.Yield || null;

    const { ingredients, ingredientItems } = extractIngredients(ingredientsHtml);
    const { instructions, instructionImages } = extractInstructions(stepsHtml);
    const nutrition = extractNutrition(nutritionHtml);

    const category = breadcrumbs.length ? breadcrumbs[breadcrumbs.length - 1] : null;

    return {
        name,
        description,
        url: recipeUrl,
        image,
        author,
        testedBy,
        updatedOn,
        breadcrumbs,
        category,
        prepTime,
        cookTime,
        additionalTime,
        totalTime,
        servings,
        rating: {
            value: ratingValue,
            count: ratingCount,
            reviewCount,
        },
        photoCount,
        ingredients,
        ingredientItems,
        instructions,
        instructionImages,
        details: detailMap,
        nutrition,
        apiComponents: Object.keys(payload).filter((key) => !['externalScripts', 'externalStylesheets', 'inlineSVGs'].includes(key)),
        scrapedAt: new Date().toISOString(),
    };
}

async function main() {
    const input = (await Actor.getInput()) || {};
    const {
        query,
        startUrls,
        results_wanted = 20,
        max_pages = 5,
        proxyConfiguration,
    } = input;

    const resultsWanted = Number.isFinite(Number(results_wanted)) ? Math.max(1, Number(results_wanted)) : 20;
    const maxPages = Number.isFinite(Number(max_pages)) ? Math.max(1, Number(max_pages)) : 5;

    const proxyConfig = proxyConfiguration
        ? await Actor.createProxyConfiguration(proxyConfiguration)
        : undefined;

    const getProxyUrl = async () => (proxyConfig ? proxyConfig.newUrl() : undefined);

    const requestWithProxy = async (options) => {
        const proxyUrl = await getProxyUrl();
        return gotScraping({
            ...options,
            proxyUrl,
            throwHttpErrors: false,
            responseType: options.responseType || 'text',
            timeout: { request: 45000 },
        });
    };

    const startUrlValues = asArray(startUrls)
        .map((entry) => (typeof entry === 'string' ? entry : entry?.url))
        .filter(Boolean);

    const directRecipeUrls = new Set();
    const searchQueries = new Set();

    for (const startUrl of startUrlValues) {
        const canonical = canonicalRecipeUrl(startUrl);
        if (canonical) {
            directRecipeUrls.add(canonical);
            continue;
        }

        try {
            const parsed = new URL(startUrl);
            if (/\/search\/?$/i.test(parsed.pathname)) {
                const q = cleanText(parsed.searchParams.get('q'));
                if (q) searchQueries.add(q);
            }
        } catch {
            // Skip malformed URL entries.
        }
    }

    const trimmedQuery = cleanText(query);
    if (trimmedQuery) searchQueries.add(trimmedQuery);

    if (!searchQueries.size && !directRecipeUrls.size) {
        throw new Error('Missing input. Provide `query`, `startUrls` with search URL, or direct recipe URLs.');
    }

    log.info(`Input resolved. queries=${searchQueries.size}, directRecipes=${directRecipeUrls.size}, resultsWanted=${resultsWanted}, maxPages=${maxPages}`);

    const collectedRecipeUrls = new Set(directRecipeUrls);

    async function createSession(url) {
        const cookieJar = new CookieJar();

        const response = await requestWithProxy({
            url,
            cookieJar,
            headers: {
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
            },
        });

        if (response.statusCode >= 400) {
            throw new Error(`Session bootstrap failed (${response.statusCode}) for ${url}`);
        }

        const cookies = await cookieJar.getCookies(url);
        const csrfToken = cookies.find((cookie) => cookie.key === 'CSRFToken')?.value || '';

        return { cookieJar, csrfToken };
    }

    async function fetchSearchPage(queryValue, offset, session) {
        const searchUrl = new URL('/search', BASE_URL);
        searchUrl.searchParams.set('q', queryValue);

        const endpoint = new URL('/search', BASE_URL);
        endpoint.searchParams.set('q', queryValue);
        endpoint.searchParams.set('offset', String(offset));
        endpoint.searchParams.set('url', searchUrl.toString());

        const body = new URLSearchParams({
            globeDeferVersion: '2',
            cr: SEARCH_COMPONENTS,
            loaded_cr: '',
            cis: '1',
            force_cis: '',
            pv: 'undefined',
            CSRFToken: session.csrfToken,
        });

        const response = await requestWithProxy({
            method: 'POST',
            url: endpoint.toString(),
            cookieJar: session.cookieJar,
            body: body.toString(),
            headers: {
                accept: 'application/json, text/javascript, */*; q=0.01',
                'x-requested-with': 'XMLHttpRequest',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                origin: BASE_URL,
                referer: searchUrl.toString(),
                'accept-language': 'en-US,en;q=0.9',
            },
        });

        if (response.statusCode >= 400) {
            throw new Error(`Search API failed (${response.statusCode}) for query="${queryValue}" offset=${offset}`);
        }

        const payload = parseResponseBody(response.body);
        return getComponentHtml(payload, 'mntl-search-results__list_1');
    }

    for (const queryValue of searchQueries) {
        if (collectedRecipeUrls.size >= resultsWanted) break;

        log.info(`Discovering recipe URLs for query: "${queryValue}"`);

        const searchUrl = new URL('/search', BASE_URL);
        searchUrl.searchParams.set('q', queryValue);
        const session = await createSession(searchUrl.toString());

        for (let page = 0; page < maxPages; page++) {
            if (collectedRecipeUrls.size >= resultsWanted) break;

            const offset = page * SEARCH_PAGE_SIZE;
            const listHtml = await fetchSearchPage(queryValue, offset, session);
            const recipeUrls = parseSearchLinks(listHtml);

            if (!recipeUrls.length) {
                log.info(`No more search results for "${queryValue}" at offset=${offset}.`);
                break;
            }

            let added = 0;
            for (const recipeUrl of recipeUrls) {
                if (collectedRecipeUrls.size >= resultsWanted) break;
                if (collectedRecipeUrls.has(recipeUrl)) continue;
                collectedRecipeUrls.add(recipeUrl);
                added++;
            }

            log.info(`Search page ${page + 1} (offset ${offset}) returned ${recipeUrls.length} links, added ${added}. Total queued: ${collectedRecipeUrls.size}`);

            if (recipeUrls.length < SEARCH_PAGE_SIZE) {
                break;
            }
        }
    }

    const recipeQueue = [...collectedRecipeUrls].slice(0, resultsWanted);

    if (!recipeQueue.length) {
        log.warning('No recipe URLs discovered from API search.');
        return;
    }

    log.info(`Processing ${recipeQueue.length} recipe URLs via component API.`);

    const pushedCanonical = new Set();
    let saved = 0;

    async function fetchRecipePayload(recipeUrl) {
        const session = await createSession(recipeUrl);

        const endpoint = `${recipeUrl}?url=${encodeURIComponent(recipeUrl)}`;
        const body = new URLSearchParams({
            globeDeferVersion: '2',
            cr: RECIPE_COMPONENTS,
            loaded_cr: '',
            cis: '1',
            force_cis: '',
            pv: 'undefined',
            CSRFToken: session.csrfToken,
        });

        const response = await requestWithProxy({
            method: 'POST',
            url: endpoint,
            cookieJar: session.cookieJar,
            body: body.toString(),
            headers: {
                accept: 'application/json, text/javascript, */*; q=0.01',
                'x-requested-with': 'XMLHttpRequest',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                origin: BASE_URL,
                referer: recipeUrl,
                'accept-language': 'en-US,en;q=0.9',
            },
        });

        if (response.statusCode >= 400) {
            throw new Error(`Recipe API failed (${response.statusCode}) for ${recipeUrl}`);
        }

        return parseResponseBody(response.body);
    }

    for (const recipeUrl of recipeQueue) {
        const canonical = canonicalRecipeUrl(recipeUrl);
        if (!canonical || pushedCanonical.has(canonical)) continue;

        try {
            const payload = await fetchRecipePayload(canonical);
            const extracted = extractRecipeData(canonical, payload);
            const cleaned = removeNullishDeep(extracted);

            if (!cleaned || (!cleaned.name && !cleaned.ingredients && !cleaned.instructions)) {
                log.warning(`Skipping ${canonical} because no usable fields were extracted.`);
                continue;
            }

            await Dataset.pushData(cleaned);
            pushedCanonical.add(canonical);
            saved++;
            log.info(`Saved ${saved}/${recipeQueue.length}: ${cleaned.name || canonical}`);
        } catch (error) {
            log.warning(`Failed recipe ${canonical}: ${error.message}`);
        }
    }

    log.info(`Done. Saved ${saved} unique recipes (null/duplicate fields cleaned).`);
}

await Actor.main(async () => {
    await main();
});
