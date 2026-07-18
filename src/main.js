import { readFile } from 'node:fs/promises';

import { Actor, log } from 'apify';
import { load as cheerioLoad } from 'cheerio';
import { Dataset } from 'crawlee';
import { Impit } from 'impit';
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
const RECIPE_CONCURRENCY = 8;
const DATASET_BATCH_SIZE = 25;
const MAX_RECOVERY_ATTEMPTS = 2;
const REQUEST_JITTER_MS = 300;
const BLOCKED_BODY_PATTERNS = [
    /support@people\.inc/i,
    /reader experiencing an access issue/i,
    /contentlicensing@people\.inc/i,
];
const RECIPE_COMPONENT_KEYS = [
    'article-header--recipe_1',
    'mm-recipes-details_1',
    'mm-recipes-structured-ingredients_1',
    'mm-recipes-steps_1',
];

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

function getObjectKeys(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.keys(value);
}

async function loadInputJsonFallback() {
    try {
        const raw = await readFile('INPUT.json', 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        return {};
    } catch {
        return {};
    }
}

async function loadSchemaInputFallback() {
    try {
        const raw = await readFile('.actor/input_schema.json', 'utf8');
        const schema = JSON.parse(raw);
        const properties = schema?.properties;

        if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
            return {};
        }

        const fallback = {};
        for (const [key, config] of Object.entries(properties)) {
            if (!config || typeof config !== 'object' || Array.isArray(config)) continue;

            if (config.prefill !== undefined) {
                fallback[key] = config.prefill;
                continue;
            }

            if (config.default !== undefined) {
                fallback[key] = config.default;
            }
        }

        return fallback;
    } catch {
        return {};
    }
}

function hasAnyInputFields(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function parseNumber(value) {
    const text = cleanText(value);
    if (!text) return null;
    const match = text.match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0].replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
}

function parseJsonCandidate(value) {
    if (!value) return null;

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function canonicalRecipeUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl, BASE_URL);
        if (!/\/recipe\/\d+/i.test(parsed.pathname)) return null;
        parsed.hash = '';
        parsed.search = '';
        parsed.hostname = 'www.allrecipes.com';
        parsed.protocol = 'https:';
        parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/`;
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

function isBlockedBody(body) {
    if (!body) return false;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return BLOCKED_BODY_PATTERNS.some((pattern) => pattern.test(text));
}

function hasRecipePayload(payload) {
    return RECIPE_COMPONENT_KEYS.some((key) => getComponentHtml(payload, key));
}

function toStringArray(value) {
    return uniqueStrings(asArray(value).flatMap((entry) => {
        if (typeof entry === 'string') return [entry];
        if (entry && typeof entry === 'object') return Object.values(entry).filter((part) => typeof part === 'string');
        return [];
    }));
}

function extractJsonLdObjects(html) {
    const $ = cheerioLoad(html);
    const objects = [];

    $('script[type="application/ld+json"]').each((_, script) => {
        const parsed = parseJsonCandidate($(script).contents().text());
        if (!parsed) return;

        if (Array.isArray(parsed)) {
            objects.push(...parsed);
            return;
        }

        if (Array.isArray(parsed['@graph'])) {
            objects.push(...parsed['@graph']);
            return;
        }

        objects.push(parsed);
    });

    return objects.filter((entry) => entry && typeof entry === 'object');
}

function matchesJsonLdType(node, expectedType) {
    const types = asArray(node?.['@type']).map((value) => cleanText(value).toLowerCase());
    return types.includes(expectedType.toLowerCase());
}

function extractRecipeFromJsonLd(recipeUrl, html) {
    const objects = extractJsonLdObjects(html);
    const recipeNode = objects.find((node) => matchesJsonLdType(node, 'Recipe'));

    if (!recipeNode) {
        return null;
    }

    const breadcrumbNode = objects.find((node) => matchesJsonLdType(node, 'BreadcrumbList'));
    const breadcrumbs = uniqueStrings(asArray(breadcrumbNode?.itemListElement).map((entry) => cleanText(entry?.name || entry?.item?.name)));
    const instructions = uniqueStrings(asArray(recipeNode.recipeInstructions).map((step) => {
        if (typeof step === 'string') return step;
        return cleanText(step?.text || step?.name);
    }));
    const ingredientItems = uniqueStrings(toStringArray(recipeNode.recipeIngredient)).map((text) => ({ text, name: text }));
    const ratingValue = parseNumber(recipeNode?.aggregateRating?.ratingValue);
    const ratingCount = parseNumber(recipeNode?.aggregateRating?.ratingCount);
    const reviewCount = parseNumber(recipeNode?.aggregateRating?.reviewCount) || parseNumber(asArray(recipeNode.review).length);
    const image = cleanText(
        typeof recipeNode.image === 'string'
            ? recipeNode.image
            : recipeNode.image?.url || asArray(recipeNode.image)[0]?.url || asArray(recipeNode.image)[0],
    ) || null;

    return removeNullishDeep({
        name: cleanText(recipeNode.name) || null,
        description: cleanText(recipeNode.description) || null,
        url: canonicalRecipeUrl(recipeNode.mainEntityOfPage || recipeNode.url || recipeUrl) || recipeUrl,
        image,
        author: cleanText(recipeNode.author?.name || asArray(recipeNode.author)[0]?.name) || null,
        updatedOn: cleanText(recipeNode.dateModified) || cleanText(recipeNode.datePublished) || null,
        breadcrumbs,
        category: cleanText(recipeNode.recipeCategory) || breadcrumbs[breadcrumbs.length - 1] || null,
        cuisine: cleanText(recipeNode.recipeCuisine) || null,
        keywords: uniqueStrings(toStringArray(recipeNode.keywords)),
        prepTime: cleanText(recipeNode.prepTime) || null,
        cookTime: cleanText(recipeNode.cookTime) || null,
        totalTime: cleanText(recipeNode.totalTime) || null,
        servings: cleanText(recipeNode.recipeYield) || null,
        rating: {
            value: ratingValue,
            count: ratingCount,
            reviewCount,
        },
        ingredients: ingredientItems.map((item) => item.text),
        ingredientItems,
        instructions,
        nutrition: recipeNode.nutrition || null,
        scrapedAt: new Date().toISOString(),
        source: 'jsonld-fallback',
    });
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
        const imageUrl = cleanText(image.attr('data-hi-res-src'))
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

    const author = cleanText($meta('.mntl-bylines__group--ugc_recipe .mntl-attribution__item-name').first().text())
        || cleanText($meta('.mntl-attribution__item-descriptor:contains("Submitted by")').next('.mntl-attribution__item-name').first().text())
        || null;

    const testedBy = cleanText($meta('.mntl-bylines__group--recipe_tester .mntl-attribution__item-name').first().text())
        || null;

    const updatedOnRaw = cleanText($meta('.mntl-attribution__item-date').first().text());
    const updatedOn = updatedOnRaw.replace(/^Updated on\s*/i, '') || null;

    const ratingValue = parseNumber($review('.mm-recipes-review-bar__rating').first().text());
    const ratingCount = parseNumber($review('.mm-recipes-review-bar__rating-count').first().text());
    const reviewCount = parseNumber($review('.mm-recipes-review-bar__comment-count').first().text());
    const photoCount = parseNumber($review('.recipe-review-bar__photo-count').first().text());

    const image = cleanText($photo('img').first().attr('data-hi-res-src'))
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
        scrapedAt: new Date().toISOString(),
    };
}

async function main() {
    const actorInput = (await Actor.getInput()) || {};
    const schemaInput = await loadSchemaInputFallback();
    const inputJsonFallback = await loadInputJsonFallback();
    const input = hasAnyInputFields(actorInput)
        ? actorInput
        : {
            ...inputJsonFallback,
            ...schemaInput,
        };

    const {
        query,
        startUrls,
        results_wanted: resultsWantedInput,
        max_pages: maxPagesInput,
        proxyConfiguration,
    } = input;

    const resultsWanted = Number.isFinite(Number(resultsWantedInput)) ? Math.max(1, Number(resultsWantedInput)) : 20;
    const maxPages = Number.isFinite(Number(maxPagesInput)) ? Math.max(1, Number(maxPagesInput)) : 5;

    const proxyConfig = proxyConfiguration
        ? await Actor.createProxyConfiguration(proxyConfiguration)
        : undefined;
    let fallbackProxyConfigPromise;

    const getProxyUrl = async (activeProxyConfig) => (activeProxyConfig ? activeProxyConfig.newUrl() : undefined);
    const getFallbackProxyConfig = async () => {
        if (proxyConfiguration) return null;
        if (!fallbackProxyConfigPromise) {
            fallbackProxyConfigPromise = Actor.createProxyConfiguration({ useApifyProxy: true });
        }
        return fallbackProxyConfigPromise;
    };

    const clientCache = new Map();

    function getCachedClient(proxyUrl) {
        const key = proxyUrl || '__direct__';
        if (clientCache.has(key)) return clientCache.get(key);
        const client = new Impit({
            browser: 'chrome',
            ignoreTlsErrors: true,
            ...(proxyUrl && { proxyUrl }),
        });
        clientCache.set(key, client);
        return client;
    }

    const executeRequest = async (options, activeProxyConfig) => {
        const proxyUrl = await getProxyUrl(activeProxyConfig);
        const client = getCachedClient(proxyUrl);

        const fetchUrl = options.url || options;
        const fetchOptions = {
            method: options.method || 'GET',
            headers: { ...(options.headers || {}) },
        };

        if (options.body) {
            fetchOptions.body = options.body;
        }

        if (options.cookieJar) {
            try {
                const cookies = await options.cookieJar.getCookieString(fetchUrl);
                if (cookies) {
                    fetchOptions.headers.cookie = cookies;
                }
            } catch {
                // Cookie read errors are non-fatal
            }
        }

        fetchOptions.signal = AbortSignal.timeout(45000);

        const response = await client.fetch(fetchUrl, fetchOptions);

        if (options.cookieJar) {
            try {
                const setCookies = typeof response.headers.getSetCookie === 'function'
                    ? response.headers.getSetCookie()
                    : [];
                for (const cookieStr of setCookies) {
                    try {
                        await options.cookieJar.setCookie(cookieStr, fetchUrl);
                    } catch {
                        // Skip invalid cookies
                    }
                }
            } catch {
                // Cookie storage errors are non-fatal
            }
        }

        const body = await response.text();

        return {
            statusCode: response.status,
            body,
        };
    };

    const requestWithRecovery = async (options, contextLabel) => {
        const proxyChain = [proxyConfig];
        const fallbackProxyConfig = await getFallbackProxyConfig();
        if (fallbackProxyConfig) proxyChain.push(fallbackProxyConfig);

        let lastResponse;
        let lastError;

        for (const [proxyIndex, activeProxyConfig] of proxyChain.entries()) {
            for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
                try {
                    const response = await executeRequest(options, activeProxyConfig);
                    if (response.statusCode < 400 && !isBlockedBody(response.body)) {
                        return response;
                    }

                    lastResponse = response;
                    log.debug(`${contextLabel} attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS} on route ${proxyIndex + 1}/${proxyChain.length} returned ${response.statusCode}${isBlockedBody(response.body) ? ' with blocked page' : ''}.`);
                } catch (error) {
                    lastError = error;
                    log.debug(`${contextLabel} attempt ${attempt}/${MAX_RECOVERY_ATTEMPTS} on route ${proxyIndex + 1}/${proxyChain.length} failed: ${error.message}`);
                }

                if (attempt < MAX_RECOVERY_ATTEMPTS) {
                    await delay(500 * attempt);
                }
            }
        }

        if (lastResponse) {
            return lastResponse;
        }

        throw new Error(`${contextLabel} failed without a response.${lastError ? ` Last error: ${lastError.message}` : ''}`);
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

    log.debug(`Input resolved. queries=${searchQueries.size}, directRecipes=${directRecipeUrls.size}, resultsWanted=${resultsWanted}, maxPages=${maxPages}`);

    const collectedRecipeUrls = new Set(directRecipeUrls);

    async function createSession(url) {
        const cookieJar = new CookieJar();

        const response = await requestWithRecovery({
            url,
            cookieJar,
            headers: {
                referer: BASE_URL,
            },
        }, `Session bootstrap for ${url}`);

        if (response.statusCode >= 400 || isBlockedBody(response.body)) {
            log.debug(`Session bootstrap failed (${response.statusCode}) for ${url}. Continuing without session-bound API access.`);
            return { cookieJar, csrfToken: '', unavailable: true };
        }

        const cookies = await cookieJar.getCookies(url);
        const csrfToken = cookies.find((cookie) => cookie.key === 'CSRFToken')?.value || '';

        return { cookieJar, csrfToken };
    }

    async function fetchSearchPage(queryValue, offset, session) {
        const searchUrl = new URL('/search', BASE_URL);
        searchUrl.searchParams.set('q', queryValue);
        if (offset) searchUrl.searchParams.set('offset', String(offset));

        if (session?.unavailable) {
            log.debug(`Skipping search API for "${queryValue}" offset=${offset} because session bootstrap was unavailable.`);
            const fallbackResponse = await requestWithRecovery({
                url: searchUrl.toString(),
                headers: {
                    referer: BASE_URL,
                },
            }, `Search HTML for "${queryValue}" offset=${offset}`);

            if (fallbackResponse.statusCode >= 400 || isBlockedBody(fallbackResponse.body)) {
                throw new Error(`Search discovery failed (${fallbackResponse.statusCode}) for query="${queryValue}" offset=${offset}`);
            }

            return typeof fallbackResponse.body === 'string' ? fallbackResponse.body : '';
        }

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

        const response = await requestWithRecovery({
            method: 'POST',
            url: endpoint.toString(),
            cookieJar: session.cookieJar,
            body: body.toString(),
            headers: {
                origin: BASE_URL,
                referer: searchUrl.toString(),
                'x-requested-with': 'XMLHttpRequest',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
        }, `Search API for "${queryValue}" offset=${offset}`);

        if (response.statusCode < 400 && !isBlockedBody(response.body)) {
            const payload = parseResponseBody(response.body);
            const componentHtml = getComponentHtml(payload, 'mntl-search-results__list_1');
            if (componentHtml) return componentHtml;

            log.debug(`Search API returned unexpected payload keys for "${queryValue}" offset=${offset}: ${getObjectKeys(payload).join(', ') || 'none'}`);
        }

        log.debug(`Falling back to HTML search discovery for "${queryValue}" offset=${offset}.`);

        const fallbackResponse = await requestWithRecovery({
            url: searchUrl.toString(),
            headers: {
                referer: BASE_URL,
            },
        }, `Search HTML for "${queryValue}" offset=${offset}`);

        if (fallbackResponse.statusCode >= 400 || isBlockedBody(fallbackResponse.body)) {
            throw new Error(`Search discovery failed (${fallbackResponse.statusCode}) for query="${queryValue}" offset=${offset}`);
        }

        return typeof fallbackResponse.body === 'string' ? fallbackResponse.body : '';
    }

    for (const queryValue of searchQueries) {
        if (collectedRecipeUrls.size >= resultsWanted) break;

        log.info(`Discovering recipe URLs for query: "${queryValue}"`);

        const searchUrl = new URL('/search', BASE_URL);
        searchUrl.searchParams.set('q', queryValue);
        const session = await createSession(searchUrl.toString());

        try {
            for (let page = 0; page < maxPages; page++) {
                if (collectedRecipeUrls.size >= resultsWanted) break;

                const offset = page * SEARCH_PAGE_SIZE;
                const listHtml = await fetchSearchPage(queryValue, offset, session);
                const recipeUrls = parseSearchLinks(listHtml);

                if (!recipeUrls.length) {
                    break;
                }

                for (const recipeUrl of recipeUrls) {
                    if (collectedRecipeUrls.size >= resultsWanted) break;
                    if (collectedRecipeUrls.has(recipeUrl)) continue;
                    collectedRecipeUrls.add(recipeUrl);
                }

                if (recipeUrls.length < SEARCH_PAGE_SIZE) {
                    break;
                }
            }
        } catch (error) {
            log.debug(`Search discovery failed for query "${queryValue}": ${error.message}`);
        }

        log.debug(`Queued ${collectedRecipeUrls.size} recipe URLs so far for query "${queryValue}".`);
    }

    const recipeQueue = [...collectedRecipeUrls].slice(0, resultsWanted);

    if (!recipeQueue.length) {
        log.debug('No recipe URLs discovered from API search.');
        return;
    }

    const canonicalQueue = [];
    const seenCanonical = new Set();
    for (const recipeUrl of recipeQueue) {
        const canonical = canonicalRecipeUrl(recipeUrl);
        if (!canonical || seenCanonical.has(canonical)) continue;
        seenCanonical.add(canonical);
        canonicalQueue.push(canonical);
    }

    if (!canonicalQueue.length) {
        log.debug('No canonical recipe URLs available for processing.');
        return;
    }

    log.info(`Processing ${canonicalQueue.length} recipe URLs via component API (concurrency=${RECIPE_CONCURRENCY}, batch=${DATASET_BATCH_SIZE}).`);

    const sharedRecipeSession = await createSession(BASE_URL);

    async function postRecipePayload(recipeUrl, session) {
        if (session?.unavailable) {
            return { statusCode: 599, body: '' };
        }

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

        const response = await requestWithRecovery({
            method: 'POST',
            url: endpoint,
            cookieJar: session.cookieJar,
            body: body.toString(),
            headers: {
                origin: BASE_URL,
                referer: recipeUrl,
                'x-requested-with': 'XMLHttpRequest',
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
        }, `Recipe API for ${recipeUrl}`);

        return response;
    }

    async function fetchRecipeHtml(recipeUrl) {
        const response = await requestWithRecovery({
            url: recipeUrl,
            headers: {
                referer: BASE_URL,
            },
        }, `Recipe HTML for ${recipeUrl}`);

        if (response.statusCode >= 400 || isBlockedBody(response.body)) {
            throw new Error(`Recipe HTML failed (${response.statusCode}) for ${recipeUrl}`);
        }

        return typeof response.body === 'string' ? response.body : '';
    }

    async function fetchRecipePayload(recipeUrl) {
        let response = await postRecipePayload(recipeUrl, sharedRecipeSession);

        // Fallback session for blocked/expired shared-cookie requests.
        if (response.statusCode >= 400 || isBlockedBody(response.body)) {
            const fallbackSession = await createSession(recipeUrl);
            response = await postRecipePayload(recipeUrl, fallbackSession);
        }

        if (response.statusCode < 400 && !isBlockedBody(response.body)) {
            const payload = parseResponseBody(response.body);
            if (hasRecipePayload(payload)) {
                return { payload, source: 'component-api' };
            }

            log.debug(`Recipe API payload missing expected components for ${recipeUrl}. Keys: ${getObjectKeys(payload).join(', ') || 'none'}`);
        }

        log.debug(`Falling back to recipe HTML JSON-LD extraction for ${recipeUrl}.`);
        const html = await fetchRecipeHtml(recipeUrl);
        const fallbackRecipe = extractRecipeFromJsonLd(recipeUrl, html);

        if (!fallbackRecipe) {
            throw new Error(`Recipe API failed (${response.statusCode}) and JSON-LD fallback was unavailable for ${recipeUrl}`);
        }

        return { payload: fallbackRecipe, source: 'jsonld-fallback' };
    }

    let saved = 0;
    let failed = 0;
    const failureSamples = [];
    const pendingBatch = [];

    for (let offset = 0; offset < canonicalQueue.length; offset += RECIPE_CONCURRENCY) {
        if (offset > 0) {
            await delay(Math.random() * REQUEST_JITTER_MS);
        }
        const chunk = canonicalQueue.slice(offset, offset + RECIPE_CONCURRENCY);

        const chunkResults = await Promise.all(chunk.map(async (canonical, i) => {
            if (i > 0) await delay(Math.random() * 100);
            try {
                const { payload, source } = await fetchRecipePayload(canonical);
                const extracted = source === 'component-api'
                    ? extractRecipeData(canonical, payload)
                    : payload;
                const cleaned = removeNullishDeep(extracted);

                if (!cleaned || (!cleaned.name && !cleaned.ingredients && !cleaned.instructions)) {
                    return { ok: false, sample: null };
                }

                return { ok: true, item: cleaned };
            } catch (error) {
                return { ok: false, sample: `${canonical} (${error.message})` };
            }
        }));

        for (const result of chunkResults) {
            if (result.ok) {
                pendingBatch.push(result.item);
                continue;
            }

            failed++;
            if (result.sample && failureSamples.length < 3) {
                failureSamples.push(result.sample);
            }
        }

        while (pendingBatch.length >= DATASET_BATCH_SIZE) {
            const batch = pendingBatch.splice(0, DATASET_BATCH_SIZE);
            await Dataset.pushData(batch);
            saved += batch.length;
            log.info(`Saved ${saved}/${canonicalQueue.length} recipes.`);
        }
    }

    if (pendingBatch.length) {
        await Dataset.pushData(pendingBatch);
        saved += pendingBatch.length;
        log.info(`Saved ${saved}/${canonicalQueue.length} recipes.`);
    }

    if (failed > 0) {
        const sampleText = failureSamples.length ? ` Samples: ${failureSamples.join(' | ')}` : '';
        log.warning(`Failed ${failed} recipe requests.${sampleText}`);
    }

    log.info(`Done. Saved ${saved} unique recipes (null/duplicate fields cleaned).`);
}

await Actor.main(async () => {
    await main();
});
