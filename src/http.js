/* eslint-disable no-param-reassign */
import { log } from 'apify';
import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';

import { isBlockedBody, isBlockedStatus, isTemporaryStatus } from './extract.js';

// Order: live pass rate first, then latency. Matrix in API_DISCOVERY.md.
const PROFILE_ORDER = [
    'chrome151',
    'chrome142',
    'firefox158',
    'chrome110',
    'chrome100',
    'chrome116',
    'firefox144',
    'okhttp3',
    'chrome124',
    'ios18',
    'okhttp',
    'firefox',
    'chrome104',
    'chrome125',
    'okhttp5',
    'firefox128',
    'chrome131',
    'firefox133',
    'chrome101',
    'okhttp4',
    'chrome',
    'firefox135',
    'chrome107',
    'chrome136',
];

const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_DEADLINE_MS = 120000;
const MAX_PROFILE_ATTEMPTS = 10;
const PROFILE_COOLDOWN_MS = 5 * 60 * 1000;
const TRANSIENT_COOLDOWN_MS = 30 * 1000;
const MAX_PROXY_REFRESHES = 2;
const MAX_BACKOFF_MS = 5000;
const MAX_RETRY_AFTER_MS = 30000;
const CIRCUIT_COOLDOWN_MS = 15000;
const CIRCUIT_FAILURE_THRESHOLD = 4;

function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function jitter(ms) {
    return ms + Math.floor(Math.random() * 250);
}

function parseRetryAfter(value) {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), MAX_RETRY_AFTER_MS);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
    return null;
}

function extractInlineCsrfToken(body) {
    if (typeof body !== 'string' || !body) return '';
    const initMatch = body.match(/csrfInit\(\s*['"]([^'"]+)['"]/i);
    if (initMatch) return initMatch[1];
    const metaMatch = body.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i);
    return metaMatch ? metaMatch[1] : '';
}

export class ResilientHttpClient {
    constructor({ proxyConfiguration } = {}) {
        this.proxyConfiguration = proxyConfiguration || null;
        this.sessions = new Map();
        this.proxyDisabled = false;
        this.warnedNoProxy = false;
        this.consecutiveFailures = 0;
        this.circuitOpenUntil = 0;
        this.stats = {
            requests: 0,
            successes: 0,
            failures: 0,
            profileUsage: {},
        };
    }

    async getSession(profile) {
        const existing = this.sessions.get(profile);
        if (existing) return existing;

        let proxyUrl;
        if (this.proxyConfiguration && !this.proxyDisabled) {
            try {
                proxyUrl = await this.proxyConfiguration.newUrl();
            } catch (error) {
                this.proxyDisabled = true;
                log.warning(`Proxy configuration is unavailable, continuing without it: ${error.message}`);
            }
        }

        const jar = new CookieJar();
        const client = new Impit({
            browser: profile,
            cookieJar: jar,
            timeout: REQUEST_TIMEOUT_MS,
            ...(proxyUrl && { proxyUrl }),
        });

        const session = {
            profile,
            client,
            jar,
            proxyUrl,
            failures: 0,
            blockFailures: 0,
            requests: 0,
            successes: 0,
            refreshes: 0,
            disabledUntil: 0,
            lastSuccessAt: 0,
            csrfToken: '',
            warned: false,
        };

        this.sessions.set(profile, session);
        return session;
    }

    // A fresh jar and connection clears any block cookie and stale socket without a proxy.
    async resetSession(session, { rotateProxy = true } = {}) {
        let { proxyUrl } = session;

        if (this.proxyDisabled) {
            proxyUrl = undefined;
        } else if (rotateProxy && this.proxyConfiguration && session.refreshes < MAX_PROXY_REFRESHES) {
            try {
                proxyUrl = await this.proxyConfiguration.newUrl();
                session.refreshes += 1;
            } catch (error) {
                this.proxyDisabled = true;
                proxyUrl = undefined;
                log.warning(`Proxy rotation failed, continuing without it: ${error.message}`);
            }
        }

        const jar = new CookieJar();
        session.client = new Impit({
            browser: session.profile,
            cookieJar: jar,
            timeout: REQUEST_TIMEOUT_MS,
            ...(proxyUrl && { proxyUrl }),
        });
        session.jar = jar;
        session.proxyUrl = proxyUrl;
        session.csrfToken = '';
    }

    async resetFailedSessions() {
        for (const session of this.sessions.values()) {
            if (session.failures > 0) {
                await this.resetSession(session);
            }
        }
    }

    async resetAllSessions() {
        for (const session of this.sessions.values()) {
            await this.resetSession(session);
        }
    }

    async recordFailure(session, reason, blocked) {
        session.failures += 1;
        session.blockFailures = blocked ? session.blockFailures + 1 : 0;
        this.stats.failures += 1;

        if (blocked) {
            session.disabledUntil = Date.now()
                + (session.blockFailures >= 3 ? PROFILE_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS);
        } else {
            session.disabledUntil = Date.now() + TRANSIENT_COOLDOWN_MS;
        }

        if (session.failures === 2 || session.blockFailures === 2) {
            await this.resetSession(session);
        }

        if (!session.warned) {
            session.warned = true;
            log.warning(`Request issue on ${session.profile}: ${reason}. Rotating client profile.`);
        } else {
            log.debug(`Request issue on ${session.profile}: ${reason}.`);
        }
    }

    async getCsrfToken(session, url) {
        try {
            const cookieString = await session.jar.getCookieString(url);
            const match = cookieString.match(/(?:^|;\s*)CSRFToken=([^;]+)/i);
            if (match) return decodeURIComponent(match[1]);
            return session.csrfToken || '';
        } catch {
            return session.csrfToken || '';
        }
    }

    circuitRemainingMs() {
        return Math.max(0, this.circuitOpenUntil - Date.now());
    }

    orderedProfiles(preferredSession) {
        const now = Date.now();
        const available = PROFILE_ORDER.filter((profile) => {
            const session = this.sessions.get(profile);
            return !session || session.disabledUntil <= now;
        });

        const pool = available.length ? available : [...PROFILE_ORDER];
        pool.sort((left, right) => {
            const leftSession = this.sessions.get(left);
            const rightSession = this.sessions.get(right);
            const leftFailures = leftSession?.failures ?? 0;
            const rightFailures = rightSession?.failures ?? 0;
            if (leftFailures !== rightFailures) return leftFailures - rightFailures;
            return (rightSession?.lastSuccessAt ?? 0) - (leftSession?.lastSuccessAt ?? 0);
        });

        if (preferredSession?.profile) {
            const index = pool.indexOf(preferredSession.profile);
            if (index > 0) {
                pool.splice(index, 1);
                pool.unshift(preferredSession.profile);
            } else if (index === -1) {
                pool.unshift(preferredSession.profile);
            }
        }

        return [...new Set(pool)];
    }

    async request(url, options = {}) {
        const {
            method = 'GET',
            headers = {},
            body,
            isValidBody,
            preferredSession,
            maxAttempts = MAX_PROFILE_ATTEMPTS,
        } = options;

        if (this.circuitRemainingMs() > 0) {
            const circuitError = new Error('Request skipped because the site-wide circuit is open after repeated failures');
            circuitError.circuitOpen = true;
            throw circuitError;
        }

        const profiles = this.orderedProfiles(preferredSession);
        const attemptLimit = Math.min(maxAttempts, Math.max(profiles.length, 1));
        const startedAt = Date.now();
        let lastStatus = null;
        let lastReason = 'no response';
        const failures = [];

        for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
            if (Date.now() - startedAt >= REQUEST_DEADLINE_MS) {
                lastReason = 'request deadline exceeded';
                break;
            }

            const profile = profiles[attempt % profiles.length];
            let session;

            try {
                session = await this.getSession(profile);
            } catch (error) {
                lastReason = `session setup failed (${error.message})`;
                failures.push(`${profile}:setup`);
                continue;
            }

            session.requests += 1;
            this.stats.requests += 1;
            this.stats.profileUsage[profile] = (this.stats.profileUsage[profile] || 0) + 1;

            try {
                const fetchOptions = {
                    method,
                    headers,
                    redirect: 'follow',
                };

                if (body !== undefined) fetchOptions.body = body;

                const response = await session.client.fetch(url, fetchOptions);
                const text = await response.text();
                const { status } = response;

                if (status === 404 || status === 410) {
                    const notFound = new Error(`HTTP ${status} not found`);
                    notFound.status = status;
                    notFound.notFound = true;
                    throw notFound;
                }

                const blocked = isBlockedStatus(status) || isBlockedBody(text);
                const temporary = isTemporaryStatus(status);

                let valid = true;
                if (!blocked && !temporary && typeof isValidBody === 'function') {
                    try {
                        valid = Boolean(isValidBody(text));
                    } catch {
                        valid = false;
                    }
                }

                if (!blocked && !temporary && valid) {
                    const inlineToken = extractInlineCsrfToken(text);
                    if (inlineToken) session.csrfToken = inlineToken;
                    session.failures = 0;
                    session.blockFailures = 0;
                    session.successes += 1;
                    session.disabledUntil = 0;
                    session.lastSuccessAt = Date.now();
                    session.warned = false;
                    this.consecutiveFailures = 0;
                    this.circuitOpenUntil = 0;
                    this.stats.successes += 1;

                    return {
                        status,
                        body: text,
                        headers: response.headers,
                        profile,
                        session,
                        url: response.url || url,
                    };
                }

                lastStatus = status;
                if (blocked) {
                    lastReason = `HTTP ${status} blocked response`;
                } else if (temporary) {
                    lastReason = `HTTP ${status} temporary response`;
                } else {
                    lastReason = 'unexpected response body';
                }

                failures.push(`${profile}:${status}`);

                const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
                await this.recordFailure(session, lastReason, blocked);

                if (retryAfter) {
                    await delay(retryAfter);
                } else {
                    await delay(jitter(Math.min(500 * (attempt + 1), MAX_BACKOFF_MS)));
                }
            } catch (error) {
                if (error.notFound) throw error;
                lastReason = error.message;
                failures.push(`${profile}:error`);
                await this.recordFailure(session, `network error (${error.message})`, false);
                await delay(jitter(300));
            }
        }

        // Force fresh connections and cookie jars so the next logical request starts clean.
        try {
            await this.resetFailedSessions();
        } catch (error) {
            log.debug(`Session reset failed: ${error.message}`);
        }

        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
            this.circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;

            if (this.proxyConfiguration && !this.proxyDisabled) {
                this.proxyDisabled = true;
                log.warning('Repeated proxy failures. Falling back to direct connections for the rest of this run.');
                try {
                    await this.resetAllSessions();
                } catch (error) {
                    log.debug(`Proxy fallback reset failed: ${error.message}`);
                }
            }
        }

        if (!this.proxyConfiguration && !this.warnedNoProxy) {
            this.warnedNoProxy = true;
            log.debug('All browser profiles failed without a proxy; the caller will try its fallback path.');
        }

        const error = new Error(`Request failed after ${failures.length} attempts (last status: ${lastStatus ?? 'none'}, reason: ${lastReason})`);
        error.failures = failures;
        error.lastStatus = lastStatus;
        throw error;
    }

    getStats() {
        return {
            ...this.stats,
            proxyDisabled: this.proxyDisabled,
            profilesUsed: Object.entries(this.stats.profileUsage).map(([profile, count]) => `${profile}:${count}`).join(','),
        };
    }
}
