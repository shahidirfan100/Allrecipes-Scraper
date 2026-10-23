/* eslint-disable no-param-reassign */
import { log } from 'apify';
import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';

import { isBlockedBody, isBlockedStatus, isTemporaryStatus } from './extract.js';

const PROFILE_ORDER = [
    'chrome',
    'chrome142',
    'chrome136',
    'firefox144',
    'okhttp5',
    'chrome131',
    'firefox',
    'okhttp4',
    'chrome125',
    'chrome124',
];

const REQUEST_TIMEOUT_MS = 25000;
const MAX_PROFILE_ATTEMPTS = 4;
const PROFILE_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_PROXY_REFRESHES = 2;
const MAX_BACKOFF_MS = 2000;

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
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 10000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 10000);
    return null;
}

export class ResilientHttpClient {
    constructor({ proxyConfiguration } = {}) {
        this.proxyConfiguration = proxyConfiguration || null;
        this.sessions = new Map();
        this.proxyDisabled = false;
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
            requests: 0,
            successes: 0,
            refreshes: 0,
            disabledUntil: 0,
            warned: false,
        };

        this.sessions.set(profile, session);
        return session;
    }

    async refreshSession(session) {
        if (!this.proxyConfiguration || this.proxyDisabled || session.refreshes >= MAX_PROXY_REFRESHES) return false;

        try {
            const proxyUrl = await this.proxyConfiguration.newUrl();
            const jar = new CookieJar();
            session.client = new Impit({
                browser: session.profile,
                cookieJar: jar,
                timeout: REQUEST_TIMEOUT_MS,
                ...(proxyUrl && { proxyUrl }),
            });
            session.jar = jar;
            session.proxyUrl = proxyUrl;
            session.refreshes += 1;
            session.failures = 0;
            return true;
        } catch (error) {
            this.proxyDisabled = true;
            log.warning(`Proxy rotation failed, continuing without it: ${error.message}`);
            return false;
        }
    }

    async recordFailure(session, reason) {
        session.failures += 1;
        this.stats.failures += 1;

        if (session.failures >= 3) {
            session.disabledUntil = Date.now() + PROFILE_COOLDOWN_MS;
        }

        if (session.failures === 2) {
            await this.refreshSession(session);
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
            return match ? decodeURIComponent(match[1]) : '';
        } catch {
            return '';
        }
    }

    orderedProfiles(preferredSession) {
        const now = Date.now();
        const available = PROFILE_ORDER.filter((profile) => {
            const session = this.sessions.get(profile);
            return !session || session.disabledUntil <= now;
        });

        const pool = available.length ? available : [...PROFILE_ORDER];
        pool.sort((left, right) => {
            const leftFailures = this.sessions.get(left)?.failures ?? 0;
            const rightFailures = this.sessions.get(right)?.failures ?? 0;
            return leftFailures - rightFailures;
        });

        if (preferredSession?.profile) {
            const index = pool.indexOf(preferredSession.profile);
            if (index > 0) {
                pool.splice(index, 1);
                pool.unshift(preferredSession.profile);
            } else if (index === -1 && available.length) {
                pool.unshift(preferredSession.profile);
            }
        }

        return [...new Set(pool)].slice(0, MAX_PROFILE_ATTEMPTS);
    }

    async request(url, options = {}) {
        const {
            method = 'GET',
            headers = {},
            body,
            isValidBody,
            preferredSession,
        } = options;

        const profiles = this.orderedProfiles(preferredSession);
        let lastStatus = null;
        let lastReason = 'no response';
        const failures = [];

        for (const profile of profiles) {
            const session = await this.getSession(profile);
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
                    session.failures = 0;
                    session.successes += 1;
                    session.disabledUntil = 0;
                    session.warned = false;
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
                await this.recordFailure(session, lastReason);

                if (status === 429 && retryAfter) {
                    await delay(retryAfter);
                } else {
                    await delay(jitter(Math.min(400 * session.failures, MAX_BACKOFF_MS)));
                }
            } catch (error) {
                if (error.notFound) throw error;
                lastReason = error.message;
                failures.push(`${profile}:error`);
                await this.recordFailure(session, `network error (${error.message})`);
                await delay(jitter(300));
            }
        }

        const error = new Error(`Request failed after ${profiles.length} profile attempts (last status: ${lastStatus ?? 'none'}, reason: ${lastReason})`);
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
