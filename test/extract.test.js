import assert from 'node:assert/strict';
import test from 'node:test';

import { extractRecipeFromHtml, extractSearchLinks, isBlockedBody } from '../src/extract.js';

const recipeJsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Sugar Test Cake',
    recipeIngredient: ['1 cup sugar'],
    recipeInstructions: [{ '@type': 'HowToStep', text: 'Mix and bake.' }],
    nutrition: {
        '@type': 'NutritionInformation',
        calories: '200 kcal',
        fatContent: '8 g',
        sugarContent: '12 g',
    },
});

function pageWithNutrition(labelRows) {
    return `<html><head>
<script type="application/ld+json">${recipeJsonLd}</script>
</head><body>
<h1 class="article-heading">Sugar Test Cake</h1>
<div class="mm-recipes-nutrition-facts-label__table"><table class="mm-recipes-nutrition-facts-label__table">
<thead>
<tr><th colspan="2">Nutrition Facts</th></tr>
<tr><th colspan="2"><span class="mm-recipes-nutrition-facts-label__table-head-pretext">Calories</span><span>200</span></th></tr>
</thead>
<tbody>${labelRows}</tbody>
</table></div>
</body></html>`;
}

const nameCell = (label, amount) => `<span class="mm-recipes-nutrition-facts-label__nutrient-name">${label}</span> ${amount}`;

test('nutrition keeps rows without a daily value', () => {
    const html = pageWithNutrition(`
        <tr><td>${nameCell('Total Fat', '8g')}</td><td>10%</td></tr>
        <tr><td colspan="2">${nameCell('Total Sugars', '12g')}</td></tr>
        <tr><td>${nameCell('Added Sugars', '5g')}</td><td>10%</td></tr>
    `);

    const recipe = extractRecipeFromHtml(html, 'https://www.allrecipes.com/recipe/1/sugar-test-cake/');

    assert.equal(recipe.nutrition.values['Total Fat'], '8g');
    assert.equal(recipe.nutrition.values['Total Sugars'], '12g');
    assert.equal(recipe.nutrition.values['Added Sugars'], '5g');
    assert.equal(recipe.nutrition.dailyValues['Total Fat 8g'], '10%');
    assert.equal(recipe.nutrition.dailyValues['Added Sugars 5g'], '10%');
    assert.equal(recipe.nutrition.dailyValues['Total Sugars 12g'], undefined);
});

test('nutrition falls back to JSON-LD when the label table is absent', () => {
    const html = `<html><head><script type="application/ld+json">${recipeJsonLd}</script></head>
<body><h1 class="article-heading">Sugar Test Cake</h1><p>Mix and bake.</p></body></html>`;

    const recipe = extractRecipeFromHtml(html, 'https://www.allrecipes.com/recipe/1/sugar-test-cake/');

    assert.equal(recipe.nutrition.values['Total Sugars'], '12 g');
    assert.equal(recipe.nutrition.summary['Total Sugars'], '12 g');
});

test('search links trust pagination over a short page', () => {
    const html = `<html><body>
<div id="mntl-search-results__list_1-0">
    <a href="https://www.allrecipes.com/recipe/1/short-page/">Short page recipe</a>
</div>
<ol id="mntl-pagination_1-0" class="mntl-pagination">
    <li class="mntl-pagination__item--next">
        <a aria-label="Go to the next page of search results, page 2" href="/search?q=soup&offset=24">Next</a>
    </li>
</ol>
</body></html>`;

    const links = extractSearchLinks(html);

    assert.equal(links.recipeUrls.length, 1);
    assert.equal(links.hasNextPage, true);
});

test('search links report unknown pagination when the markup is absent', () => {
    const links = extractSearchLinks('<html><body><a href="/recipe/1/test/">Test</a></body></html>');

    assert.equal(links.hasNextPage, null);
});

test('block detection catches Cloudflare challenge markup', () => {
    assert.equal(isBlockedBody('<html><body><div id="cf-chl-widget"></div></body></html>'), true);
});
