import { beforeEach, describe, expect, it, vi } from 'vitest';

const scrapeBulletin = vi.fn();

vi.mock('./source', () => ({
  DEFAULT_BULLETIN_URL: 'https://stjacademy.org/daily-bulletin/',
  scrapeBulletin: (...args: unknown[]) => scrapeBulletin(...args)
}));

const { default: worker } = await import('./index');

function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  const state = { lastAttemptAt: null as number | null, lastSuccessAt: null as number | null, lastError: null as string | null };
  const statement = (query: string) => {
    let values: unknown[] = [];
    const api = {
      bind(...next: unknown[]) {
        values = next;
        return api;
      },
      async first() {
        if (query.includes('FROM bulletins')) {
          const sorted = [...rows].sort((a, b) => String(b.bulletin_date).localeCompare(String(a.bulletin_date)));
          return sorted[0] ?? null;
        }
        return { last_attempt_at: state.lastAttemptAt, last_success_at: state.lastSuccessAt, last_error: state.lastError };
      },
      async run() {
        if (query.startsWith('INSERT INTO bulletins')) {
          const [date, title, weekday, dayColor, dateText, blocks, source, fetchedAt] = values;
          rows.push({
            bulletin_date: date,
            title,
            weekday,
            day_color: dayColor,
            date_text: dateText,
            blocks_json: blocks,
            source,
            fetched_at: fetchedAt
          });
        } else if (query.startsWith('UPDATE fetch_state SET last_attempt_at')) {
          state.lastAttemptAt = values[0] as number;
        } else if (query.startsWith('UPDATE fetch_state SET last_success_at')) {
          state.lastSuccessAt = values[0] as number;
        }
        return { meta: { changes: 1 } };
      }
    };
    return api;
  };
  return { rows, prepare: statement };
}

const env = (db: unknown) => ({
  ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
  DB: db as D1Database
});

const ctx = () => ({ waitUntil: () => undefined, passThroughOnException: () => undefined }) as unknown as ExecutionContext;

const parsed = {
  date: '2026-10-28',
  dateText: 'October 28, 2026',
  weekday: 'Wednesday',
  dayColor: 'Green Day',
  title: 'Daily Bulletin',
  blocks: [{ type: 'p' as const, text: 'Hello.' }]
};

beforeEach(() => {
  scrapeBulletin.mockReset();
  vi.useRealTimers();
});

describe('GET /api/bulletin', () => {
  it('scrapes once, then serves the stored copy', async () => {
    const db = fakeDb();
    scrapeBulletin.mockResolvedValue({
      parsed,
      source: 'direct',
      url: 'https://stjacademy.org/daily-bulletin/'
    });
    const request = new Request('https://bulletin.example/api/bulletin');

    const first = await worker.fetch(request, env(db), ctx());
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    expect(firstBody.bulletin.date).toBe('2026-10-28');
    expect(firstBody.bulletin.blocks).toEqual([{ type: 'p', text: 'Hello.' }]);
    expect(firstBody.cached).toBe(false);
    expect(firstBody.isToday).toBe(true);
    expect(scrapeBulletin).toHaveBeenCalledTimes(1);

    const second = await worker.fetch(request, env(db), ctx());
    const secondBody = await second.json() as any;
    expect(secondBody.cached).toBe(true);
    expect(secondBody.stale).toBe(false);
    expect(scrapeBulletin).toHaveBeenCalledTimes(1);
  });

  it('serves the stored bulletin when the school site fails', async () => {
    const db = fakeDb();
    scrapeBulletin.mockResolvedValue({ parsed, source: 'direct', url: 'https://stjacademy.org/x/' });
    await worker.fetch(new Request('https://bulletin.example/api/bulletin'), env(db), ctx());

    // Push the stored copy past its freshness window, then break the scrape.
    db.rows[0].fetched_at = Date.now() - 60 * 60 * 1000;
    db.rows[0].bulletin_date = '2026-10-27';
    scrapeBulletin.mockRejectedValue(new Error('The school page answered 403.'));

    const response = await worker.fetch(new Request('https://bulletin.example/api/bulletin'), env(db), ctx());
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.stale).toBe(true);
    expect(body.bulletin.date).toBe('2026-10-27');
    expect(body.error).toContain('403');
  });

  it('reports 503 when there is nothing stored and the scrape fails', async () => {
    const db = fakeDb();
    scrapeBulletin.mockRejectedValue(new Error('Firecrawl answered 402: Payment required'));
    const response = await worker.fetch(new Request('https://bulletin.example/api/bulletin'), env(db), ctx());
    expect(response.status).toBe(503);
    const body = await response.json() as any;
    expect(body.bulletin).toBeNull();
    expect(body.error).toContain('Payment required');
  });

  it('rejects non-GET and cross-origin calls', async () => {
    const db = fakeDb();
    const post = await worker.fetch(new Request('https://bulletin.example/api/bulletin', { method: 'POST' }), env(db), ctx());
    expect(post.status).toBe(405);

    const crossOrigin = await worker.fetch(
      new Request('https://bulletin.example/api/bulletin', { headers: { Origin: 'https://evil.example' } }),
      env(db),
      ctx()
    );
    expect(crossOrigin.status).toBe(403);
  });
});

describe('GET /api/health', () => {
  it('reports what is configured', async () => {
    const response = await worker.fetch(new Request('https://bulletin.example/api/health'), env(fakeDb()), ctx());
    const body = await response.json() as any;
    expect(body.ok).toBe(true);
    expect(body.database).toBe(true);
    expect(body.firecrawl).toBe(false);
  });
});
