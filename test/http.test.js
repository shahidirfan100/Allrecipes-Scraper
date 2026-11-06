import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ResilientHttpClient } from '../src/http.js';

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('retries a blocked response with another profile and succeeds', async () => {
    let hits = 0;
    const server = await listen((request, response) => {
        hits += 1;
        if (hits <= 2) {
            response.writeHead(403, { 'content-type': 'text/html' });
            response.end('<html><head><title>Access Denied</title></head></html>');
            return;
        }
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html><body>recipe page</body></html>');
    });

    try {
        const { port } = server.address();
        const client = new ResilientHttpClient();
        const result = await client.request(`http://127.0.0.1:${port}/`, {
            isValidBody: (body) => body.includes('recipe page'),
        });

        assert.equal(result.status, 200);
        assert.ok(hits >= 3);
    } finally {
        server.close();
    }
});

test('returns a 404 immediately without profile retries', async () => {
    let hits = 0;
    const server = await listen((request, response) => {
        hits += 1;
        response.writeHead(404);
        response.end('not found');
    });

    try {
        const { port } = server.address();
        const client = new ResilientHttpClient();

        await assert.rejects(
            client.request(`http://127.0.0.1:${port}/`),
            (error) => error.notFound === true,
        );
        assert.equal(hits, 1);
    } finally {
        server.close();
    }
});

test('reads the inline CSRF token when the cookie jar is empty', async () => {
    const server = await listen((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<html><body>recipe page<script>window.Mntl.csrfInit("inline-token", true)</script></body></html>');
    });

    try {
        const { port } = server.address();
        const url = `http://127.0.0.1:${port}/`;
        const client = new ResilientHttpClient();
        const result = await client.request(url, {
            isValidBody: (body) => body.includes('recipe page'),
        });

        assert.equal(await client.getCsrfToken(result.session, url), 'inline-token');
    } finally {
        server.close();
    }
});
