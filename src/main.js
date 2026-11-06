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
const RECIPE_CONCURRENCY = 3;
const PROXY_RECIPE_CONCURRENCY = 6;
const DATASET_BATCH_SIZE = 25;
const MAX_GALLERY_EXPANSIONS = 3;
const RECIPE_RETRY_DELAY_MS = 5000;
const DISCOVERY_RETRY_DELAY_MS = 15000;
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

function wait(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
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
        const response = await client.request(searchUrl, { isValidBody: isValidSearchBody, maxAttempts: 3 });
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
            maxAttempts: 3,
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

                // A short page can still have a next page, so trust pagination markup first.
                const hasNextPage = result.hasNextPage === true
                    || (result.hasNextPage !== false && result.recipeUrls.length >= SEARCH_PAGE_SIZE);
                if (!hasNextPage) break;
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

    // Keep every direct URL: if some fail, the later ones are still valid fallbacks.
    return [...recipeUrls];
}

async function runRecipePass(client, recipeUrls, resultsWanted, alreadySaved, concurrency) {
    let saved = 0;
    const failures = [];
    const savedUrls = [];
    let pendingBatch = [];

    for (let offset = 0; offset < recipeUrls.length; offset += concurrency) {
        if (alreadySaved + saved + pendingBatch.length >= resultsWanted) break;

        const chunk = recipeUrls.slice(offset, offset + concurrency);
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
                savedUrls.push(result.recipeUrl);
                if (alreadySaved + saved + pendingBatch.length >= resultsWanted) continue;
                pendingBatch.push(result.recipe);
            } else if (result.error) {
                failures.push({
                    url: result.recipeUrl,
                    message: result.error.message,
                    retryable: !result.error.notFound,
                });
            }
        }

        while (pendingBatch.length >= DATASET_BATCH_SIZE) {
            const batch = pendingBatch.slice(0, DATASET_BATCH_SIZE);
            pendingBatch = pendingBatch.slice(DATASET_BATCH_SIZE);
            await Dataset.pushData(batch);
            saved += batch.length;
        }

        if (alreadySaved + saved >= resultsWanted) break;
    }

    if (pendingBatch.length && alreadySaved + saved < resultsWanted) {
        const batch = pendingBatch.slice(0, resultsWanted - alreadySaved - saved);
        await Dataset.pushData(batch);
        saved += batch.length;
    }

    return { saved, failures, savedUrls };
}

async function processRecipes(client, recipeUrls, resultsWanted, concurrency) {
    let saved = 0;
    let remaining = [...recipeUrls];
    const failedByUrl = new Map();

    // Second pass gives transient blocks and rate limits a chance to clear.
    for (let pass = 0; pass < 2 && saved < resultsWanted && remaining.length; pass += 1) {
        if (pass > 0) {
            const circuitWait = typeof client.circuitRemainingMs === 'function' ? client.circuitRemainingMs() : 0;
            const delayMs = Math.max(RECIPE_RETRY_DELAY_MS, circuitWait + 500) + Math.floor(Math.random() * 2000);
            log.info(`Retrying ${remaining.length} failed recipes after ${Math.round(delayMs / 1000)}s.`);
            await wait(delayMs);
        }

        const result = await runRecipePass(client, remaining, resultsWanted, saved, concurrency);
        saved += result.saved;

        for (const failure of result.failures) failedByUrl.set(failure.url, failure);
        for (const url of result.savedUrls) failedByUrl.delete(url);

        remaining = [...failedByUrl.values()]
            .filter((failure) => failure.retryable)
            .map((failure) => failure.url);
    }

    if (failedByUrl.size) {
        const samples = [...failedByUrl.values()]
            .slice(0, 3)
            .map((failure) => `${failure.url} (${failure.message})`);
        log.warning(`Failed ${failedByUrl.size} recipe requests after retry. Samples: ${samples.join(' | ')}`);
    }

    return { saved, failed: failedByUrl.size };
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
    let recipeUrls = await discoverRecipes(client, {
        queries: [...queries],
        directRecipeUrls: [...directRecipeUrls],
        listingUrls,
        resultsWanted,
        maxPages,
    });

    if (!recipeUrls.length && runStats.searchFailures > 0) {
        const circuitWait = client.circuitRemainingMs();
        const delayMs = Math.max(DISCOVERY_RETRY_DELAY_MS, circuitWait + 500) + Math.floor(Math.random() * 3000);
        log.warning(`Discovery returned nothing after request retries. Retrying once in ${Math.round(delayMs / 1000)}s.`);
        await wait(delayMs);
        recipeUrls = await discoverRecipes(client, {
            queries: [...queries],
            directRecipeUrls: [...directRecipeUrls],
            listingUrls,
            resultsWanted,
            maxPages,
        });
    }

    if (!recipeUrls.length) {
        if (runStats.searchFailures > 0) {
            const proxyHint = proxyConfiguration
                ? ''
                : ' Enable proxyConfiguration with Apify Proxy if this repeats from a datacenter network.';
            throw new Error(`No recipe URLs were discovered and ${runStats.searchFailures} search requests failed.${proxyHint} Check logs for the failing profile and response details.`);
        }

        log.warning('No recipes matched the supplied search. The run completed without dataset items.');
        return;
    }

    const recipeConcurrency = proxyConfiguration ? PROXY_RECIPE_CONCURRENCY : RECIPE_CONCURRENCY;
    log.info(`Discovered ${recipeUrls.length} recipe URLs. Extracting with concurrency ${recipeConcurrency}.`);

    const { saved, failed } = await processRecipes(client, recipeUrls, resultsWanted, recipeConcurrency);
    const stats = client.getStats();

    if (saved === 0) {
        const proxyHint = proxyConfiguration
            ? ''
            : ' Enable proxyConfiguration with Apify Proxy if this repeats from a datacenter network.';
        throw new Error(`No recipes could be extracted from ${recipeUrls.length} discovered URLs (${failed} failed).${proxyHint} The site may be blocking requests or the page structure may have changed.`);
    }

    if (saved < resultsWanted) {
        log.warning(`Only ${saved} of ${resultsWanted} requested recipes were saved (${recipeUrls.length} URLs discovered, ${failed} failed).`);
    }

    let proxyState = 'off';
    if (stats.proxyDisabled) proxyState = 'fallback-direct';
    else if (proxyConfiguration) proxyState = 'enabled';
    log.info(`Finished | saved=${saved} | target=${resultsWanted} | failed=${failed} | searchPages=${runStats.searchPages} | searchFailures=${runStats.searchFailures} | recipeFailures=${runStats.recipeFailures} | componentFallbacks=${runStats.componentFallbacks} | proxy=${proxyState} | requests=${stats.requests} | profiles=${stats.profilesUsed || 'none'}`);
});
