import { describe, expect, it } from 'vitest';
import {
  beginAttempt,
  finishAttempt,
  LOCK_MS,
  readLatest,
  readState,
  saveBulletin,
  type Database,
  type Statement
} from './cache';
import type { Bulletin } from './types';

/** Just enough D1 to exercise the queries this project runs. */
class FakeDb implements Database {
  rows: Record<string, unknown>[] = [];
  state = { lastAttemptAt: null as number | null, lastSuccessAt: null as number | null, lastError: null as string | null };
  prepare(query: string): Statement {
    return new FakeStatement(this, query);
  }
}

class FakeStatement implements Statement {
  private values: unknown[] = [];
  constructor(private db: FakeDb, private query: string) {}
  bind(...values: unknown[]): Statement {
    this.values = values;
    return this;
  }
  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes('FROM bulletins')) {
      const sorted = [...this.db.rows].sort((a, b) =>
        String(b.bulletin_date).localeCompare(String(a.bulletin_date))
      );
      return (sorted[0] as T) ?? null;
    }
    if (this.query.includes('FROM fetch_state')) {
      return {
        last_attempt_at: this.db.state.lastAttemptAt,
        last_success_at: this.db.state.lastSuccessAt,
        last_error: this.db.state.lastError
      } as T;
    }
    return null;
  }
  async run(): Promise<{ meta?: { changes?: number } }> {
    const sql = this.query.trim();
    if (sql.startsWith('INSERT INTO bulletins')) {
      const [date, title, weekday, dayColor, dateText, blocks, source, fetchedAt] = this.values;
      this.db.rows = this.db.rows.filter(row => row.bulletin_date !== date);
      this.db.rows.push({
        bulletin_date: date,
        title,
        weekday,
        day_color: dayColor,
        date_text: dateText,
        blocks_json: blocks,
        source,
        fetched_at: fetchedAt
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM bulletins')) {
      const before = this.db.rows.length;
      this.db.rows = [...this.db.rows]
        .sort((a, b) => String(b.bulletin_date).localeCompare(String(a.bulletin_date)))
        .slice(0, 30);
      return { meta: { changes: before - this.db.rows.length } };
    }
    if (sql.startsWith('UPDATE fetch_state SET last_attempt_at')) {
      const [now, cutoff] = this.values as number[];
      const current = this.db.state.lastAttemptAt;
      if (current !== null && current > cutoff) return { meta: { changes: 0 } };
      this.db.state.lastAttemptAt = now;
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('UPDATE fetch_state SET last_success_at')) {
      this.db.state.lastSuccessAt = this.values[0] as number;
      this.db.state.lastError = null;
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('UPDATE fetch_state SET last_error')) {
      this.db.state.lastError = this.values[0] as string;
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

const bulletin: Bulletin = {
  date: '2026-10-28',
  dateText: 'October 28, 2026',
  weekday: 'Wednesday',
  dayColor: 'Green Day',
  title: 'Daily Bulletin',
  blocks: [{ type: 'p', text: 'Hello.' }],
  source: 'direct',
  sourceUrl: 'https://stjacademy.org/',
  fetchedAt: 1_700_000_000_000
};

describe('bulletin cache', () => {
  it('round-trips a bulletin', async () => {
    const db = new FakeDb();
    await saveBulletin(db, bulletin);
    const stored = await readLatest(db);
    expect(stored).toMatchObject({
      date: '2026-10-28',
      dateText: 'October 28, 2026',
      weekday: 'Wednesday',
      dayColor: 'Green Day',
      title: 'Daily Bulletin',
      source: 'direct',
      fetchedAt: bulletin.fetchedAt
    });
    expect(stored!.blocks).toEqual([{ type: 'p', text: 'Hello.' }]);
  });

  it('replaces the same day instead of duplicating it', async () => {
    const db = new FakeDb();
    await saveBulletin(db, bulletin);
    await saveBulletin(db, { ...bulletin, blocks: [{ type: 'p', text: 'Edited.' }] });
    expect(db.rows).toHaveLength(1);
    expect((await readLatest(db))!.blocks[0].text).toBe('Edited.');
  });

  it('returns the newest date first', async () => {
    const db = new FakeDb();
    await saveBulletin(db, bulletin);
    await saveBulletin(db, { ...bulletin, date: '2026-10-30', dateText: 'October 30, 2026' });
    expect((await readLatest(db))!.date).toBe('2026-10-30');
  });

  it('lets only one caller hold the scrape lock at a time', async () => {
    const db = new FakeDb();
    await expect(beginAttempt(db, 1_000_000)).resolves.toBe(true);
    await expect(beginAttempt(db, 1_000_000 + 5_000)).resolves.toBe(false);
    await expect(beginAttempt(db, 1_000_000 + LOCK_MS + 1)).resolves.toBe(true);
  });

  it('records failures without claiming a success', async () => {
    const db = new FakeDb();
    await finishAttempt(db, 5_000, 'school site down');
    let state = await readState(db);
    expect(state.lastError).toBe('school site down');
    expect(state.lastSuccessAt).toBeNull();

    await finishAttempt(db, 6_000, null);
    state = await readState(db);
    expect(state.lastSuccessAt).toBe(6_000);
    expect(state.lastError).toBeNull();
  });
});
