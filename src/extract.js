import { load as cheerioLoad } from 'cheerio';

const BASE_URL = 'https://www.allrecipes.com';
const RECIPE_PATH_PATTERN = /\/recipe\/(\d+)\/([a-z0-9-]+)/i;
const NAMED_ENTITIES = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    rsquo: '\u2019',
    lsquo: '\u2018',
    rdquo: '\u201d',
    ldquo: '\u201c',
    ndash: '\u2013',
    mdash: '\u2014',
    hellip: '\u2026',
};

const BLOCK_PATTERNS = [
    /support@people\.inc/i,
    /contentlicensing@people\.inc/i,
    /reader experiencing an access issue/i,
    /cf-mitigated/i,
    /cf-chl/i,
    /challenge-platform/i,
    /verify you are (?:a )?human/i,
    /enable javascript and cookies to continue/i,
    /sorry, you have been blocked/i,
];

const BLOCK_TITLE_PATTERNS = [
    /access denied/i,
    /just a moment/i,
    /attention required/i,
];

const NUTRITION_FIELDS = [
    ['Calories', 'calories'],
    ['Total Fat', 'fatContent'],
    ['Saturated Fat', 'saturatedFatContent'],
    ['Cholesterol', 'cholesterolContent'],
    ['Sodium', 'sodiumContent'],
    ['Total Carbohydrate', 'carbohydrateContent'],
    ['Dietary Fiber', 'fiberContent'],
    ['Total Sugars', 'sugarContent'],
    ['Protein', 'proteinContent'],
];

export function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined) return [];
    return [value];
}

export function cleanText(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\s+/g, ' ').trim();
}

export function decodeEntities(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
        const normalized = code.toLowerCase();
        if (normalized.startsWith('#x')) {
            const parsed = Number.parseInt(normalized.slice(2), 16);
            return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
        }
        if (normalized.startsWith('#')) {
            const parsed = Number.parseInt(normalized.slice(1), 10);
            return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
        }
        return NAMED_ENTITIES[normalized] ?? match;
    });
}

export function decodeText(value) {
    return cleanText(decodeEntities(value));
}

export function parseNumber(value) {
    const text = cleanText(value);
    if (!text) return null;
    const match = text.match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0].replace(/,/g, ''));
    return Number.isFinite(number) ? number : null;
}

export function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const normalized = decodeText(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

export function canonicalRecipeUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
        const parsed = new URL(rawUrl, BASE_URL);
        if (!RECIPE_PATH_PATTERN.test(parsed.pathname)) return null;
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

export function isRecipeUrl(rawUrl) {
    return Boolean(canonicalRecipeUrl(rawUrl));
}

export function isBlockedBody(body) {
    if (!body) return false;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (BLOCK_PATTERNS.some((pattern) => pattern.test(text))) return true;

    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : '';
    return BLOCK_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

export function isBlockedStatus(status) {
    return status === 401 || status === 402 || status === 403 || status === 407 || status === 429 || status === 451;
}

export function isTemporaryStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isNullish(value) {
    if (value === null || value === undefined || value === '') return true;
    if (Array.isArray(value) && value.length === 0) return true;
    if (value && typeof value === 'object' && Object.keys(value).length === 0) return true;
    return false;
}

function dedupeValues(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const key = typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(value);
    }
    return result;
}

export function pruneNullish(value) {
    if (Array.isArray(value)) {
        const cleaned = value.map(pruneNullish).filter((entry) => !isNullish(entry));
        const deduped = dedupeValues(cleaned);
        return deduped.length ? deduped : null;
    }

    if (value && typeof value === 'object') {
        const entries = Object.entries(value)
            .map(([key, entry]) => [key, pruneNullish(entry)])
            .filter(([, entry]) => !isNullish(entry));
        return entries.length ? Object.fromEntries(entries) : null;
    }

    return value;
}

function parseJsonCandidate(value) {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function collectJsonLdNodes(value, output) {
    if (Array.isArray(value)) {
        for (const entry of value) collectJsonLdNodes(entry, output);
        return;
    }

    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value['@graph'])) {
        for (const entry of value['@graph']) collectJsonLdNodes(entry, output);
    }

    output.push(value);
}

export function extractJsonLdNodes(html) {
    if (!html) return [];
    const $ = cheerioLoad(html);
    const nodes = [];

    $('script[type="application/ld+json"]').each((_, script) => {
        const raw = $(script).text() || $(script).html() || '';
        const parsed = parseJsonCandidate(raw);
        if (parsed) collectJsonLdNodes(parsed, nodes);
    });

    return nodes.filter((node) => node && typeof node === 'object');
}

function nodeTypes(node) {
    return asArray(node?.['@type'])
        .map((value) => cleanText(value).toLowerCase().replace(/^https?:\/\/schema\.org\//, ''))
        .filter(Boolean);
}

function hasType(node, expected) {
    return nodeTypes(node).includes(expected.toLowerCase());
}

function findNode(nodes, expected) {
    return nodes.find((node) => hasType(node, expected)) || null;
}

function firstValue(value) {
    if (Array.isArray(value)) return value.find((entry) => !isNullish(entry)) ?? null;
    return value;
}

function imageUrl(value) {
    const first = firstValue(value);
    if (!first) return null;
    if (typeof first === 'string') return cleanText(first) || null;
    if (typeof first === 'object') {
        return decodeText(first.url || first.contentUrl || first['@id'] || '') || null;
    }
    return null;
}

function personName(value) {
    const entries = asArray(value);
    const names = entries
        .map((entry) => {
            if (typeof entry === 'string') return decodeText(entry);
            return decodeText(entry?.name || '');
        })
        .filter(Boolean);
    return names.length ? names.join(', ') : null;
}

function flattenInstructions(value, output) {
    for (const entry of asArray(value)) {
        if (typeof entry === 'string') {
            const text = decodeText(entry);
            if (text) output.push(text);
            continue;
        }

        if (!entry || typeof entry !== 'object') continue;

        if (entry.itemListElement) {
            flattenInstructions(entry.itemListElement, output);
            continue;
        }

        const text = decodeText(entry.text || entry.name || '');
        if (text) output.push(text);
    }
}

function keywordList(value) {
    if (Array.isArray(value)) return uniqueStrings(value);
    const text = decodeText(value);
    if (!text) return [];
    return uniqueStrings(text.split(','));
}

function parseIsoDuration(value) {
    const text = cleanText(value);
    return text || null;
}

function detailValue(details, names) {
    const normalized = new Map(
        Object.entries(details || {}).map(([key, value]) => [cleanText(key).toLowerCase().replace(/:$/, ''), value]),
    );
    for (const name of names) {
        const value = normalized.get(name.toLowerCase());
        if (value) return value;
    }
    return null;
}

function extractDetails($) {
    const details = {};
    $('.mm-recipes-details__item').each((_, item) => {
        const label = cleanText($(item).find('.mm-recipes-details__label').first().text()).replace(/:$/, '');
        const value = cleanText($(item).find('.mm-recipes-details__value').first().text());
        if (label && value) details[label] = value;
    });
    return details;
}

function extractBreadcrumbs($, nodes) {
    const breadcrumbNode = findNode(nodes, 'BreadcrumbList');
    if (breadcrumbNode) {
        const items = asArray(breadcrumbNode.itemListElement)
            .map((entry) => decodeText(entry?.name || entry?.item?.name || ''))
            .filter(Boolean);
        if (items.length) return uniqueStrings(items);
    }

    const htmlItems = $('.mntl-breadcrumbs__item a, .mntl-universal-breadcrumbs a')
        .map((_, link) => cleanText($(link).text()))
        .get();

    return uniqueStrings(htmlItems);
}

function extractIngredientItems($, nodes) {
    const items = [];

    $('.mm-recipes-structured-ingredients__list-item').each((_, item) => {
        const quantity = cleanText($(item).find('[data-ingredient-quantity]').first().text())
            || cleanText($(item).find('.mm-recipes-structured-ingredients__list-item-quantity').first().text());
        const unit = cleanText($(item).find('[data-ingredient-unit]').first().text())
            || cleanText($(item).find('.mm-recipes-structured-ingredients__list-item-unit').first().text());
        const name = cleanText($(item).find('[data-ingredient-name]').first().text())
            || cleanText($(item).find('.mm-recipes-structured-ingredients__list-item-name').first().text());
        const fallbackText = cleanText($(item).find('p').first().text()) || cleanText($(item).text());
        const text = cleanText([quantity, unit, name].filter(Boolean).join(' ')) || fallbackText;

        if (!text) return;

        items.push({
            quantity: quantity || null,
            unit: unit || null,
            name: name || text,
            text,
        });
    });

    if (items.length) return dedupeValues(items);

    const recipeNode = findNode(nodes, 'Recipe');
    const fallback = uniqueStrings(asArray(recipeNode?.recipeIngredient).map((entry) => {
        if (typeof entry === 'string') return entry;
        return entry?.name || '';
    }));

    return fallback.map((text) => ({
        quantity: null,
        unit: null,
        name: text,
        text,
    }));
}

function extractSteps($, nodes) {
    const steps = [];
    const images = [];

    $('.mm-recipes-steps__content li, .mntl-sc-block-group--LI').each((_, item) => {
        const parts = $(item)
            .find('p.mntl-sc-block-html')
            .map((__, paragraph) => cleanText($(paragraph).text()))
            .get()
            .filter(Boolean);

        const text = cleanText(parts.join(' ')) || cleanText($(item).text());
        if (text) steps.push(text);

        const image = $(item).find('img').first();
        const imageSource = cleanText(image.attr('data-hi-res-src'))
            || cleanText(image.attr('data-src'))
            || cleanText(image.attr('src'));
        if (imageSource && !imageSource.startsWith('data:')) images.push(imageSource);
    });

    const uniqueSteps = uniqueStrings(steps);
    if (uniqueSteps.length) {
        return {
            instructions: uniqueSteps,
            instructionImages: uniqueStrings(images),
        };
    }

    const recipeNode = findNode(nodes, 'Recipe');
    const fallback = [];
    flattenInstructions(recipeNode?.recipeInstructions, fallback);

    return {
        instructions: uniqueStrings(fallback),
        instructionImages: uniqueStrings(images),
    };
}

function extractNutrition($, nodes) {
    const summary = {};
    const dailyValues = {};
    const values = {};
    const extra = {};

    $('.mm-recipes-nutrition-facts-summary__table tr, .mm-recipes-nutrition-facts-summary table tr').each((_, row) => {
        const cells = $(row)
            .find('th, td')
            .map((__, cell) => cleanText($(cell).text()))
            .get()
            .filter(Boolean);

        if (cells.length === 2) {
            const [value, label] = cells;
            const key = label.replace(/:$/, '');
            if (key && value) summary[key] = value;
        }
    });

    $('.mm-recipes-nutrition-facts-label__table tr, .mm-recipes-nutrition-facts table tr').each((_, row) => {
        const cells = $(row)
            .find('th, td')
            .map((__, cell) => cleanText($(cell).text()))
            .get()
            .filter(Boolean);

        if (!cells.length) return;

        const nameElement = $(row).find('.mm-recipes-nutrition-facts-label__nutrient-name').first();
        if (nameElement.length) {
            const label = cleanText(nameElement.text()).replace(/:$/, '');
            const percent = cells.find((cell) => /^<?\d+(?:\.\d+)?\s*%$/.test(cell));
            // Rows without a % Daily Value (Total Sugars, Added Sugars, trans fat, vitamin D)
            // are a single cell holding the label and the amount.
            const amount = cleanText(
                cells
                    .filter((cell) => cell !== percent)
                    .join(' ')
                    .replace(nameElement.text(), '')
                    .replace(/^[:\s]+/, ''),
            );

            if (label && amount) {
                values[label] = amount;
                if (percent) dailyValues[`${label} ${amount}`] = percent;
            }
            return;
        }

        if (cells.length === 1) {
            const line = cells[0];
            if (/servings per recipe/i.test(line)) {
                extra.servingsPerRecipe = cleanText(line.replace(/servings per recipe/i, ''));
            }
            if (/calories/i.test(line)) {
                extra.calories = cleanText(line.replace(/calories/i, ''));
                if (extra.calories) values.Calories = extra.calories;
            }
            return;
        }

        const first = cells[0].replace(/:$/, '');
        const last = cells[cells.length - 1].replace(/:$/, '');
        if (/%$/.test(last)) {
            dailyValues[first] = last;
        } else if (/%$/.test(first)) {
            dailyValues[last] = first;
        }
    });

    const nutrition = findNode(nodes, 'Recipe')?.nutrition;
    if (nutrition && typeof nutrition === 'object') {
        for (const [label, key] of NUTRITION_FIELDS) {
            const value = decodeText(nutrition[key] || '');
            if (value && !values[label]) values[label] = value;
        }

        if (!Object.keys(summary).length) {
            for (const [label, key] of NUTRITION_FIELDS) {
                const value = decodeText(nutrition[key] || '');
                if (value) summary[label] = value;
            }
        }
    }

    return { summary, dailyValues, values, extra };
}

function htmlReviewValues($) {
    const ratingValue = parseNumber($('.mm-recipes-review-bar__rating').first().text());
    const ratingCount = parseNumber($('.mm-recipes-review-bar__rating-count').first().text());
    const reviewCount = parseNumber($('.mm-recipes-review-bar__comment-count').first().text());
    const photoCount = parseNumber($('.recipe-review-bar__photo-count').first().text())
        ?? parseNumber($('[class*="total-photos"]').first().attr('class') || '');
    return { ratingValue, ratingCount, reviewCount, photoCount };
}

function jsonLdReviewValues(recipeNode) {
    const rating = recipeNode?.aggregateRating || {};
    return {
        ratingValue: parseNumber(rating.ratingValue),
        ratingCount: parseNumber(rating.ratingCount),
        reviewCount: parseNumber(rating.reviewCount),
        photoCount: null,
    };
}

export function extractRecipeFromHtml(html, recipeUrl) {
    if (!html || typeof html !== 'string') return null;

    const $ = cheerioLoad(html);
    const nodes = extractJsonLdNodes(html);
    const recipeNode = findNode(nodes, 'Recipe');
    const htmlReviews = htmlReviewValues($);
    const jsonLdReviews = jsonLdReviewValues(recipeNode);
    const details = extractDetails($);
    const ingredientItems = extractIngredientItems($, nodes);
    const { instructions, instructionImages } = extractSteps($, nodes);
    const nutrition = extractNutrition($, nodes);
    const breadcrumbs = extractBreadcrumbs($, nodes);

    const name = decodeText(recipeNode?.name || recipeNode?.headline || '')
        || cleanText($('h1.article-heading').first().text())
        || cleanText($('h1').first().text())
        || null;

    const description = decodeText(recipeNode?.description || '')
        || cleanText($('.article-header--recipe p').first().text())
        || cleanText($('.mm-recipes-intro p').first().text())
        || cleanText($('meta[property="og:description"]').attr('content') || '')
        || null;

    const image = imageUrl(recipeNode?.image)
        || cleanText($('.article__photo-ribbon img').first().attr('data-hi-res-src') || '')
        || cleanText($('.article__photo-ribbon img').first().attr('data-src') || '')
        || cleanText($('.article__photo-ribbon img').first().attr('src') || '')
        || cleanText($('meta[property="og:image"]').attr('content') || '')
        || null;

    const author = personName(recipeNode?.author)
        || cleanText($('.mntl-bylines__group--ugc_recipe .mntl-attribution__item-name').first().text())
        || null;

    const testedBy = cleanText($('.mntl-bylines__group--recipe_tester .mntl-attribution__item-name').first().text())
        || null;

    const updatedOn = cleanText($('.mntl-attribution__item-date').first().text())
        .replace(/^updated on\s*/i, '')
        || decodeText(recipeNode?.dateModified || '')
        || null;

    const categories = uniqueStrings(asArray(recipeNode?.recipeCategory));
    const cuisines = uniqueStrings(asArray(recipeNode?.recipeCuisine));
    const keywords = keywordList(recipeNode?.keywords);
    const category = categories[0] || (breadcrumbs.length ? breadcrumbs[breadcrumbs.length - 1] : null);
    const cuisine = cuisines[0] || null;

    const ratingValue = htmlReviews.ratingValue ?? jsonLdReviews.ratingValue;
    const ratingCount = htmlReviews.ratingCount ?? jsonLdReviews.ratingCount;
    const reviewCount = htmlReviews.reviewCount ?? jsonLdReviews.reviewCount;
    const photoCount = htmlReviews.photoCount ?? null;

    const prepTime = detailValue(details, ['Prep Time']) || parseIsoDuration(recipeNode?.prepTime);
    const cookTime = detailValue(details, ['Cook Time']) || parseIsoDuration(recipeNode?.cookTime);
    const additionalTime = detailValue(details, ['Additional Time']);
    const totalTime = detailValue(details, ['Total Time']) || parseIsoDuration(recipeNode?.totalTime);
    const servings = detailValue(details, ['Servings'])
        || decodeText(firstValue(recipeNode?.recipeYield) || '')
        || detailValue(details, ['Yield']);

    const ingredients = uniqueStrings(ingredientItems.map((item) => item.text));

    const recipe = {
        name,
        description,
        url: canonicalRecipeUrl(recipeNode?.mainEntityOfPage || recipeNode?.url || recipeUrl) || recipeUrl,
        image,
        author,
        testedBy,
        updatedOn,
        breadcrumbs,
        category,
        cuisine,
        keywords,
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
        details,
        nutrition,
        scrapedAt: new Date().toISOString(),
    };

    const useful = Boolean(name) && (ingredients.length > 0 || instructions.length > 0);
    if (!useful) return null;

    return pruneNullish(recipe);
}

export function extractSearchLinks(html) {
    if (!html || typeof html !== 'string') {
        return { recipeUrls: [], galleryUrls: [], noResults: false, hasNextPage: null };
    }

    const $ = cheerioLoad(html);
    const scopes = [
        $('#mntl-search-results__list_1-0'),
        $('.mntl-search-results__list'),
        $('.mntl-card-list'),
        $('.mntl-document-card-list'),
    ].filter((scope) => scope.length > 0);

    const collect = (scope, selector) => {
        const urls = [];
        scope.find(selector).each((_, link) => {
            const href = $(link).attr('href');
            if (href) urls.push(href);
        });
        return urls;
    };

    const recipeHrefs = [];
    const galleryHrefs = [];

    for (const scope of scopes) {
        recipeHrefs.push(...collect(scope, 'a[href*="/recipe/"]'));
        galleryHrefs.push(...collect(scope, 'a[href*="/gallery/"]'));
    }

    if (!recipeHrefs.length) {
        $('a[href*="/recipe/"]').each((_, link) => {
            const href = $(link).attr('href');
            if (href) recipeHrefs.push(href);
        });
    }

    if (!galleryHrefs.length) {
        $('a[href*="/gallery/"]').each((_, link) => {
            const href = $(link).attr('href');
            if (href) galleryHrefs.push(href);
        });
    }

    const recipeUrls = uniqueStrings(recipeHrefs.map((href) => canonicalRecipeUrl(href)).filter(Boolean));
    const galleryUrls = uniqueStrings(galleryHrefs.map((href) => {
        try {
            const parsed = new URL(href, BASE_URL);
            parsed.hash = '';
            return parsed.toString();
        } catch {
            return '';
        }
    }).filter(Boolean));

    const bodyText = cleanText($('body').text()).toLowerCase();
    const noResults = recipeUrls.length === 0
        && (bodyText.includes('no results') || bodyText.includes('0 results') || bodyText.includes("couldn't find"));

    // null means pagination markup was absent, so the caller falls back to page size.
    const pagination = $('#mntl-pagination_1-0, .mntl-pagination').first();
    const nextHref = pagination.length
        ? pagination.find('a[rel="next"], a[aria-label*="next page" i], .mntl-pagination__item--next a').first().attr('href')
        : null;
    const hasNextPage = pagination.length && !noResults ? Boolean(nextHref) : null;

    return { recipeUrls, galleryUrls, noResults, hasNextPage };
}

export function extractSearchLinksFromPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return { recipeUrls: [], galleryUrls: [], noResults: false, hasNextPage: null };
    }

    const html = Object.entries(payload)
        .filter(([key, value]) => /search-results|pagination|card-list/i.test(key) && typeof value?.html === 'string')
        .map(([, value]) => value.html)
        .join('\n');

    return extractSearchLinks(html);
}

export function assembleComponentHtml(payload) {
    if (!payload || typeof payload !== 'object') return '';
    return Object.values(payload)
        .filter((value) => value && typeof value === 'object' && typeof value.html === 'string')
        .map((value) => value.html)
        .join('\n');
}
