import { Actor, Dataset, log } from 'apify';

import {
    assembleComponentHtml,
    canonicalRecipeUrl,
    cleanText,
    extractRecipeFromHtml,
    extractSearchLinks,
    extractSearchLinksFromPayload,
} from './extract.js';
import { ResilientHttpClient } from './http.js';

const BASE_URL = 'https://www.allrecipes.com';
const SEARCH_PAGE_SIZE = 24;
const RECIPE_CONCURRENCY = 5;
const DATASET_BATCH_SIZE = 25;
const MAX_GALLERY_EXPANSIONS = 3;
const DEFAULT_QUERY = 'chicken';
const DEFAULT_RESULTS = 20;
const DEFAULT_MAX_PAGES = 5;
const MAX_RESULTS = 10000;
const MAX_PAGES_LIMIT = 100;

const SEARCH_COMPONENTS = 'mntl-search-results__list_1,mntl-pagination_1';
const RECIPE_COMPONENTS = [
    'allrecipes-schema_1',
    'article-preheading_1',
    'article-header--recipe_1',
    'mntl-article-meta-dynamic_1',
    'mm-recipes-review-bar__rating_1',
    'mm-recipes-review-bar__rating-count_1',
    'mm-recipes-review-bar__comment-count_1',
    'recipe-review-bar__photo-count_1',
    'mm-recipes-details_1',
    'mm-recipes-nutrition-facts-summary_1',
    'mm-recipes-nutrition-facts-label_1',
].join(',');

const runStats = {
    searchPages: 0,
    searchFailures: 0,
    recipeSuccesses: 0,
    recipeFailures: 0,
    componentFallbacks: 0,
};

function toBoundedInt(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(Math.max(Math.trunc(number), minimum), maximum);
}

function asUrl(value) {
    if (typeof value === 'string') return cleanText(value);
    if (value && typeof value === 'object' && typeof value.url === 'string') return cleanText(value.url);
    return '';
}

function normalizeStartUrls(value) {
    if (!value) return [];
    const entries = Array.isArray(value) ? value : [value];
    return entries.map(asUrl).filter(Boolean);
}

function isAllrecipesUrl(url) {
    try {
        const parsed = new URL(url);
        return /(^|\.)allrecipes\.com$/i.test(parsed.hostname);
    } catch {
        return false;
    }
}

function searchQueryFromUrl(url) {
    try {
        const parsed = new URL(url);
        if (!/\/search\/?$/i.test(parsed.pathname)) return '';
        return cleanText(parsed.searchParams.get('q') || parsed.searchParams.get('search') || '');
    } catch {
        return '';
    }
}

function buildSearchUrl(query, offset) {
    const url = new URL('/search', BASE_URL);
    url.searchParams.set('q', query);
    if (offset > 0) url.searchParams.set('offset', String(offset));
    return url.toString();
}

function apiHeaders(referer) {
    return {
        origin: BASE_URL,
        referer,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
}

function componentBody(components, csrfToken) {
    return new URLSearchParams({
        globeDeferVersion: '2',
        cr: components,
        loaded_cr: '',
        cis: '1',
        force_cis: '',
        pv: 'undefined',
        CSRFToken: csrfToken || '',
    }).toString();
}

function isValidSearchBody(body) {
    return /mntl-search-results|mntl-card-list|\/recipe\/|no results|0 results|couldn't find|didn't match/i.test(body);
}

function isValidRecipeBody(body) {
    return /application\/ld\+json|mm-recipes|article-heading|\/recipe\/\d+|mntl-card/i.test(body);
}

async function fetchSearchPage(client, query, offset) {
    const searchUrl = buildSearchUrl(query, offset);
    const apiUrl = new URL('/search', BASE_URL);
    apiUrl.searchParams.set('q', query);
    apiUrl.searchParams.set('offset', String(offset));
    apiUrl.searchParams.set('url', searchUrl);
    let htmlSession;

    try {
        const response = await client.request(searchUrl, { isValidBody: isValidSearchBody });
        htmlSession = response.session;
        const links = extractSearchLinks(response.body);
        if (links.recipeUrls.length || links.noResults) {
            return { ...links, source: 'html', session: response.session };
        }
        log.debug(`Search page for "${query}" returned no recipe links, trying the component endpoint.`);
    } catch (error) {
        if (error.notFound) {
            return { recipeUrls: [], galleryUrls: [], noResults: true, source: 'html', session: null };
        }
        log.debug(`Search page request for "${query}" offset=${offset} failed: ${error.message}`);
    }

    const csrfToken = htmlSession ? await client.getCsrfToken(htmlSession, searchUrl) : '';
    const response = await client.request(apiUrl.toString(), {
        method: 'POST',
        headers: apiHeaders(searchUrl),
        body: componentBody(SEARCH_COMPONENTS, csrfToken),
        isValidBody: (body) => body.trim().startsWith('{'),
        preferredSession: htmlSession,
    });

    let payload;
    try {
        payload = JSON.parse(response.body);
    } catch {
        throw new Error(`Search component endpoint returned invalid JSON for "${query}"`);
    }

    const links = extractSearchLinksFromPayload(payload);
    if (!links.recipeUrls.length && !links.noResults) {
        throw new Error(`Search component endpoint returned no recipe links for "${query}"`);
    }

    return { ...links, source: 'component', session: response.session };
}

async function fetchListingLinks(client, url) {
    const response = await client.request(url, { isValidBody: isValidRecipeBody });
    return { ...extractSearchLinks(response.body), session: response.session };
}

async function fetchComponentRecipe(client, recipeUrl, preferredSession) {
    const apiUrl = `${recipeUrl}?url=${encodeURIComponent(recipeUrl)}&cr=${encodeURIComponent(RECIPE_COMPONENTS)}`;
    const csrfToken = preferredSession ? await client.getCsrfToken(preferredSession, recipeUrl) : '';

    const response = await client.request(apiUrl, {
        method: 'POST',
        headers: apiHeaders(recipeUrl),
        body: componentBody(RECIPE_COMPONENTS, csrfToken),
        isValidBody: (body) => body.trim().startsWith('{'),
        preferredSession,
    });

    let payload;
    try {
        payload = JSON.parse(response.body);
    } catch {
        throw new Error('Recipe component endpoint returned invalid JSON');
    }

    const html = assembleComponentHtml(payload);
    const recipe = extractRecipeFromHtml(html, recipeUrl);
    if (!recipe) {
        throw new Error('Recipe component endpoint did not contain usable recipe data');
    }

    return { recipe, session: response.session, source: 'component' };
}

async function fetchRecipe(client, recipeUrl) {
    let htmlError;
    let htmlSession;

    try {
        const response = await client.request(recipeUrl, {
            isValidBody: isValidRecipeBody,
        });

        htmlSession = response.session;
        const recipe = extractRecipeFromHtml(response.body, recipeUrl);
        if (recipe) {
            return { recipe, session: response.session, source: 'html' };
        }

        htmlError = new Error('Recipe HTML did not contain usable recipe data');
    } catch (error) {
        if (error.notFound) throw error;
        htmlError = error;
    }

    log.debug(`Recipe HTML path failed for ${recipeUrl}: ${htmlError.message}. Trying component endpoint.`);

    try {
        return await fetchComponentRecipe(client, recipeUrl, htmlSession);
    } catch (componentError) {
        throw new Error(`Recipe extraction failed. HTML: ${htmlError.message}. Component: ${componentError.message}`);
    }
}

async function discoverRecipes(client, { queries, directRecipeUrls, listingUrls, resultsWanted, maxPages }) {
    const recipeUrls = new Set(directRecipeUrls);
    const galleryUrls = new Set();
    const buffer = Math.min(resultsWanted, 40);
    const discoveryTarget = resultsWanted + buffer;

    for (const query of queries) {
        if (recipeUrls.size >= discoveryTarget) break;

        let pagesFetched = 0;

        for (let page = 0; page < maxPages; page += 1) {
            if (recipeUrls.size >= discoveryTarget) break;

            const offset = page * SEARCH_PAGE_SIZE;
            try {
                const result = await fetchSearchPage(client, query, offset);
                runStats.searchPages += 1;
                pagesFetched += 1;

                for (const url of result.recipeUrls) recipeUrls.add(url);
                for (const url of result.galleryUrls) galleryUrls.add(url);

                if (result.noResults || result.recipeUrls.length === 0) break;
                if (result.recipeUrls.length < SEARCH_PAGE_SIZE) break;
            } catch (error) {
                runStats.searchFailures += 1;
                log.warning(`Search failed for "${query}" page ${page + 1}: ${error.message}`);
                break;
            }
        }

        if (pagesFetched > 0) {
            const pageLabel = pagesFetched === 1 ? 'page' : 'pages';
            log.info(`Search "${query}": ${pagesFetched} ${pageLabel}, ${recipeUrls.size} recipe links discovered.`);
        }
    }

    for (const listingUrl of listingUrls) {
        if (recipeUrls.size >= discoveryTarget) break;

        try {
            const result = await fetchListingLinks(client, listingUrl);
            for (const url of result.recipeUrls) recipeUrls.add(url);
            for (const url of result.galleryUrls) galleryUrls.add(url);
            log.info(`Listing ${listingUrl}: ${result.recipeUrls.length} recipe links (${recipeUrls.size} discovered).`);
        } catch (error) {
            runStats.searchFailures += 1;
            log.warning(`Listing request failed for ${listingUrl}: ${error.message}`);
        }
    }

    let expansions = 0;
    for (const galleryUrl of galleryUrls) {
        if (recipeUrls.size >= discoveryTarget || expansions >= MAX_GALLERY_EXPANSIONS) break;
        expansions += 1;

        try {
            const result = await fetchListingLinks(client, galleryUrl);
            for (const url of result.recipeUrls) recipeUrls.add(url);
            log.info(`Gallery ${galleryUrl}: ${result.recipeUrls.length} recipe links (${recipeUrls.size} discovered).`);
        } catch (error) {
            log.debug(`Gallery request failed for ${galleryUrl}: ${error.message}`);
        }
    }

    return [...recipeUrls].slice(0, discoveryTarget);
}

async function processRecipes(client, recipeUrls, resultsWanted) {
    let saved = 0;
    let failed = 0;
    const failureSamples = [];
    let pendingBatch = [];

    for (let offset = 0; offset < recipeUrls.length; offset += RECIPE_CONCURRENCY) {
        if (saved >= resultsWanted || saved + pendingBatch.length >= resultsWanted) break;

        const chunk = recipeUrls.slice(offset, offset + RECIPE_CONCURRENCY);
        const chunkResults = await Promise.all(chunk.map(async (recipeUrl) => {
            try {
                const result = await fetchRecipe(client, recipeUrl);
                runStats.recipeSuccesses += 1;
                if (result.source === 'component') runStats.componentFallbacks += 1;
                return { recipe: result.recipe, recipeUrl };
            } catch (error) {
                runStats.recipeFailures += 1;
                return { error, recipeUrl };
            }
        }));

        for (const result of chunkResults) {
            if (result.recipe) {
                if (saved + pendingBatch.length >= resultsWanted) continue;
                pendingBatch.push(result.recipe);
            } else if (result.error) {
                failed += 1;
                if (failureSamples.length < 3) {
                    failureSamples.push(`${result.recipeUrl} (${result.error.message})`);
                }
            }
        }

        while (pendingBatch.length >= DATASET_BATCH_SIZE) {
            const batch = pendingBatch.slice(0, DATASET_BATCH_SIZE);
            pendingBatch = pendingBatch.slice(DATASET_BATCH_SIZE);
            await Dataset.pushData(batch);
            saved += batch.length;
        }

        if (saved >= resultsWanted) break;
    }

    if (pendingBatch.length && saved < resultsWanted) {
        const batch = pendingBatch.slice(0, resultsWanted - saved);
        await Dataset.pushData(batch);
        saved += batch.length;
    }

    if (failed > 0) {
        const samples = failureSamples.length ? ` Samples: ${failureSamples.join(' | ')}` : '';
        log.warning(`Failed ${failed} recipe requests.${samples}`);
    }

    return { saved, failed };
}

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const startUrls = normalizeStartUrls(input.startUrls);
    const suppliedQuery = cleanText(input.query);
    const resultsWanted = toBoundedInt(input.results_wanted, DEFAULT_RESULTS, 1, MAX_RESULTS);
    const maxPages = toBoundedInt(input.max_pages, DEFAULT_MAX_PAGES, 1, MAX_PAGES_LIMIT);

    let proxyConfiguration;
    const proxyInput = input.proxyConfiguration;
    const wantsProxy = Boolean(proxyInput && typeof proxyInput === 'object' && (
        proxyInput.useApifyProxy === true
        || (Array.isArray(proxyInput.proxyUrls) && proxyInput.proxyUrls.length > 0)
    ));

    if (wantsProxy) {
        try {
            proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
        } catch (error) {
            log.warning(`Could not initialize the supplied proxy configuration: ${error.message}`);
        }
    }

    const directRecipeUrls = new Set();
    const queries = new Set();
    const listingUrls = [];

    for (const startUrl of startUrls) {
        if (!isAllrecipesUrl(startUrl)) {
            log.warning(`Skipping unsupported start URL: ${startUrl}`);
            continue;
        }

        const canonicalRecipe = canonicalRecipeUrl(startUrl);
        if (canonicalRecipe) {
            directRecipeUrls.add(canonicalRecipe);
            continue;
        }

        const searchQuery = searchQueryFromUrl(startUrl);
        if (searchQuery) {
            queries.add(searchQuery);
            continue;
        }

        listingUrls.push(startUrl);
    }

    if (!directRecipeUrls.size && !queries.size && !listingUrls.length) {
        queries.add(suppliedQuery || DEFAULT_QUERY);
    }

    log.info(`Starting run | mode=${startUrls.length ? 'startUrls' : 'query'} | queries=${[...queries].join(', ') || 'none'} | directRecipes=${directRecipeUrls.size} | listings=${listingUrls.length} | target=${resultsWanted} | maxPages=${maxPages} | proxy=${proxyConfiguration ? 'enabled' : 'disabled'}`);

    const client = new ResilientHttpClient({ proxyConfiguration });
    const recipeUrls = await discoverRecipes(client, {
        queries: [...queries],
        directRecipeUrls: [...directRecipeUrls],
        listingUrls,
        resultsWanted,
        maxPages,
    });

    if (!recipeUrls.length) {
        if (runStats.searchFailures > 0) {
            throw new Error(`No recipe URLs were discovered and ${runStats.searchFailures} search requests failed. Check logs for the failing profile and response details.`);
        }

        log.warning('No recipes matched the supplied search. The run completed without dataset items.');
        return;
    }

    log.info(`Discovered ${recipeUrls.length} recipe URLs. Extracting with concurrency ${RECIPE_CONCURRENCY}.`);

    const { saved, failed } = await processRecipes(client, recipeUrls, resultsWanted);
    const stats = client.getStats();

    if (saved === 0) {
        throw new Error(`No recipes could be extracted from ${recipeUrls.length} discovered URLs (${failed} failed). The site may be blocking requests or the page structure may have changed.`);
    }

    if (saved < resultsWanted) {
        log.warning(`Only ${saved} of ${resultsWanted} requested recipes were saved (${recipeUrls.length} URLs discovered, ${failed} failed).`);
    }

    log.info(`Finished | saved=${saved} | target=${resultsWanted} | failed=${failed} | searchPages=${runStats.searchPages} | searchFailures=${runStats.searchFailures} | recipeFailures=${runStats.recipeFailures} | componentFallbacks=${runStats.componentFallbacks} | requests=${stats.requests} | profiles=${stats.profilesUsed || 'none'}`);
});
