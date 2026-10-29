import type { Bulletin } from './types';
import type { Block } from './types';

/** How long a stored bulletin is trusted before we look again. */
export const FRESH_MS = 10 * 60 * 1000;
/** One request at a time may talk to the school; the winner holds this long. */
export const LOCK_MS = 45 * 1000;
const KEEP_ROWS = 30;

/**
 * The slice of D1 this file uses. Keeping it narrow lets the tests drive the
 * cache with a plain object instead of a real database.
 */
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface Database {
  prepare(query: string): Statement;
}

export interface FetchState {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export const EMPTY_STATE: FetchState = { lastAttemptAt: null, lastSuccessAt: null, lastError: null };

interface BulletinRow {
  bulletin_date: string;
  title: string;
  weekday: string | null;
  day_color: string | null;
  date_text: string;
  blocks_json: string;
  source: string;
  fetched_at: number;
}

function rowToBulletin(row: BulletinRow): Bulletin | null {
  let blocks: Block[];
  try {
    blocks = JSON.parse(row.blocks_json) as Block[];
  } catch {
    return null;
  }
  if (!Array.isArray(blocks) || !blocks.length) return null;
  return {
    date: row.bulletin_date,
    dateText: row.date_text,
    weekday: row.weekday ?? '',
    dayColor: row.day_color,
    title: row.title,
    blocks: blocks.filter(block => block && typeof block.text === 'string'),
    source: row.source === 'firecrawl' ? 'firecrawl' : 'direct',
    sourceUrl: '',
    fetchedAt: Number(row.fetched_at) || 0
  };
}

// The same statements as migrations/0001_init.sql, run once per isolate so a new
// database works without anyone remembering to apply the migration.
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS bulletins (
    bulletin_date TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    weekday       TEXT,
    day_color     TEXT,
    date_text     TEXT NOT NULL,
    blocks_json   TEXT NOT NULL,
    source        TEXT NOT NULL,
    fetched_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fetch_state (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    last_attempt_at INTEGER,
    last_success_at INTEGER,
    last_error      TEXT
  )`,
  'INSERT OR IGNORE INTO fetch_state (id) VALUES (1)'
];

let schemaReady: Promise<void> | null = null;

export function ensureSchema(db: Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        for (const statement of SCHEMA_STATEMENTS) {
          await db.prepare(statement).run();
        }
      } catch (error) {
        // Let the next request try again rather than caching a failure forever.
        schemaReady = null;
        throw error;
      }
    })();
  }
  return schemaReady;
}

export async function readLatest(db: Database): Promise<Bulletin | null> {
  const row = await db
    .prepare(
      `SELECT bulletin_date, title, weekday, day_color, date_text, blocks_json, source, fetched_at
         FROM bulletins
        ORDER BY bulletin_date DESC
        LIMIT 1`
    )
    .first<BulletinRow>();
  return row ? rowToBulletin(row) : null;
}

export async function readState(db: Database): Promise<FetchState> {
  const row = await db
    .prepare('SELECT last_attempt_at, last_success_at, last_error FROM fetch_state WHERE id = 1')
    .first<{ last_attempt_at: number | null; last_success_at: number | null; last_error: string | null }>();
  if (!row) return { ...EMPTY_STATE };
  return {
    lastAttemptAt: row.last_attempt_at ?? null,
    lastSuccessAt: row.last_success_at ?? null,
    lastError: row.last_error ?? null
  };
}

export async function saveBulletin(db: Database, bulletin: Bulletin): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bulletins (bulletin_date, title, weekday, day_color, date_text, blocks_json, source, fetched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT (bulletin_date) DO UPDATE SET
         title = excluded.title,
         weekday = excluded.weekday,
         day_color = excluded.day_color,
         date_text = excluded.date_text,
         blocks_json = excluded.blocks_json,
         source = excluded.source,
         fetched_at = excluded.fetched_at`
    )
    .bind(
      bulletin.date,
      bulletin.title,
      bulletin.weekday,
      bulletin.dayColor,
      bulletin.dateText,
      JSON.stringify(bulletin.blocks),
      bulletin.source,
      bulletin.fetchedAt
    )
    .run();

  await db
    .prepare(
      `DELETE FROM bulletins
        WHERE bulletin_date NOT IN (
          SELECT bulletin_date FROM bulletins ORDER BY bulletin_date DESC LIMIT ${KEEP_ROWS}
        )`
    )
    .run();
}

/**
 * Claim the right to scrape. Returns false when another request already holds
 * it, so a burst of page opens still costs one request to the school.
 */
export async function beginAttempt(db: Database, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE fetch_state SET last_attempt_at = ?1 WHERE id = 1 AND (last_attempt_at IS NULL OR last_attempt_at <= ?2)'
    )
    .bind(now, now - LOCK_MS)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function finishAttempt(db: Database, now: number, error: string | null): Promise<void> {
  if (error) {
    await db.prepare('UPDATE fetch_state SET last_error = ?1 WHERE id = 1').bind(error.slice(0, 300)).run();
    return;
  }
  await db
    .prepare('UPDATE fetch_state SET last_success_at = ?1, last_error = NULL WHERE id = 1')
    .bind(now)
    .run();
}
