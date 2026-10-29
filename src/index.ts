import {
  beginAttempt,
  EMPTY_STATE,
  ensureSchema,
  finishAttempt,
  FRESH_MS,
  readLatest,
  readState,
  saveBulletin,
  type Database,
  type FetchState
} from './cache';
import { schoolDate, SCHOOL_TZ } from './parse';
import { DEFAULT_BULLETIN_URL, scrapeBulletin } from './source';
import type { Bulletin } from './types';

export interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  BULLETIN_URL?: string;
  FIRECRAWL_URL?: string;
  FIRECRAWL_API_KEY?: string;
}

function json(data: unknown, status: number): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

interface ResponseOptions {
  now: number;
  today: string;
  state: FetchState;
  cached: boolean;
  stale: boolean;
  checking: boolean;
  error?: string | null;
}

function bulletinResponse(bulletin: Bulletin, options: ResponseOptions): Response {
  const { now, today, state, cached, stale, checking, error } = options;
  return json(
    {
      bulletin: {
        date: bulletin.date,
        dateText: bulletin.dateText,
        weekday: bulletin.weekday,
        dayColor: bulletin.dayColor,
        title: bulletin.title,
        blocks: bulletin.blocks,
        source: bulletin.source,
        sourceUrl: bulletin.sourceUrl || DEFAULT_BULLETIN_URL,
        fetchedAt: bulletin.fetchedAt
      },
      today,
      isToday: bulletin.date === today,
      timeZone: SCHOOL_TZ,
      cached,
      stale,
      checking,
      ageSeconds: Math.max(0, Math.round((now - bulletin.fetchedAt) / 1000)),
      lastSuccessAt: state.lastSuccessAt,
      error: error ?? null
    },
    200
  );
}

async function refresh(
  env: Env,
  db: Database | null,
  now: number,
  today: string
): Promise<Bulletin> {
  if (db && !(await beginAttempt(db, now))) {
    throw new Error('A bulletin check is already running. Try again in a moment.');
  }
  try {
    const scraped = await scrapeBulletin(env, today);
    const bulletin: Bulletin = {
      ...scraped.parsed,
      source: scraped.source,
      sourceUrl: scraped.url,
      fetchedAt: now
    };
    if (db) {
      await saveBulletin(db, bulletin);
      await finishAttempt(db, now, null);
    }
    return bulletin;
  } catch (error) {
    const reason = messageOf(error);
    if (db) await finishAttempt(db, now, reason);
    throw new Error(reason);
  }
}

function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

async function handleBulletin(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const now = Date.now();
  const today = schoolDate(new Date(now));
  let db = (env.DB ?? null) as unknown as Database | null;
  if (db) {
    // A database we cannot prepare must not take the bulletin down with it:
    // serving a fresh scrape beats serving an error page.
    try {
      await ensureSchema(db);
    } catch {
      db = null;
    }
  }
  const force = new URL(request.url).searchParams.get('refresh') === '1';

  const cached = db ? await readLatest(db).catch(() => null) : null;
  const state = db ? await readState(db).catch(() => ({ ...EMPTY_STATE })) : { ...EMPTY_STATE };
  const ageMs = cached ? now - cached.fetchedAt : Number.POSITIVE_INFINITY;

  if (cached && !force && ageMs < FRESH_MS) {
    return bulletinResponse(cached, { now, today, state, cached: true, stale: false, checking: false });
  }

  // Today's bulletin is already stored, so a slower re-read can only pick up an
  // edit. Show what we have and look again behind the scenes.
  if (cached && cached.date === today && !force) {
    ctx.waitUntil(refresh(env, db, now, today).catch(() => undefined));
    return bulletinResponse(cached, { now, today, state, cached: true, stale: false, checking: true });
  }

  try {
    const bulletin = await refresh(env, db, now, today);
    return bulletinResponse(bulletin, {
      now,
      today,
      state: { lastAttemptAt: now, lastSuccessAt: now, lastError: null },
      cached: false,
      stale: false,
      checking: false
    });
  } catch (error) {
    const reason = messageOf(error);
    if (cached) {
      return bulletinResponse(cached, { now, today, state, cached: true, stale: true, checking: false, error: reason });
    }
    return json({ bulletin: null, today, stale: false, error: reason }, 503);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      let databaseReady = false;
      if (env.DB) {
        try {
          await ensureSchema(env.DB as unknown as Database);
          databaseReady = true;
        } catch {
          databaseReady = false;
        }
      }
      return json(
        {
          ok: true,
          service: 'daily-bulletin',
          database: Boolean(env.DB),
          databaseReady,
          firecrawl: Boolean(env.FIRECRAWL_API_KEY),
          source: env.BULLETIN_URL || DEFAULT_BULLETIN_URL
        },
        200
      );
    }

    if (url.pathname === '/api/bulletin') {
      if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
      if (!sameOrigin(request, url)) return json({ error: 'Cross-origin requests are not allowed.' }, 403);
      return handleBulletin(request, env, ctx);
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);

    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'"
    );
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    // No X-Frame-Options: this page is meant to be embedded by the topping host.
    response.headers.set('Cache-Control', 'no-cache');
    return response;
  }
};
