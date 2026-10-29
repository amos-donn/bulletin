import { parseBulletinHtml, parseBulletinMarkdown } from './parse';
import type { ParsedBulletin } from './types';

export const DEFAULT_BULLETIN_URL =
  'https://stjacademy.org/a-culture-of-caring-and-respect/sja-news/daily-bulletin/';

const DEFAULT_FIRECRAWL_URL = 'https://api.firecrawl.dev/v2/scrape';

// The school's edge rejects obvious bot clients, so ask like a browser.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface SourceEnv {
  BULLETIN_URL?: string;
  FIRECRAWL_URL?: string;
  FIRECRAWL_API_KEY?: string;
}

export type ScrapeSource = 'direct' | 'firecrawl';

export interface ScrapeResult {
  parsed: ParsedBulletin;
  source: ScrapeSource;
  url: string;
}

export function bulletinUrl(env: SourceEnv): string {
  return env.BULLETIN_URL?.trim() || DEFAULT_BULLETIN_URL;
}

function timeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function scrapeDirect(env: SourceEnv, today: string): Promise<ParsedBulletin | null> {
  const url = bulletinUrl(env);
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': BROWSER_UA
    },
    redirect: 'follow',
    signal: timeout(8000)
  });
  if (!response.ok) throw new Error(`The school page answered ${response.status}.`);
  const html = await response.text();
  const parsed = parseBulletinHtml(html, { today });
  if (!parsed) throw new Error('The school page did not contain a bulletin we could read.');
  return parsed;
}

async function scrapeFirecrawl(env: SourceEnv, today: string): Promise<ParsedBulletin | null> {
  if (!env.FIRECRAWL_API_KEY) {
    throw new Error('The school page could not be read directly, and no Firecrawl key is configured.');
  }
  const endpoint = env.FIRECRAWL_URL?.trim() || DEFAULT_FIRECRAWL_URL;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      url: bulletinUrl(env),
      formats: ['html', 'markdown'],
      onlyMainContent: true,
      timeout: 15000
    }),
    signal: timeout(20000)
  });

  const payload = (await response.json().catch(() => null)) as
    | { success?: boolean; error?: string; data?: { html?: string; markdown?: string } }
    | null;

  if (!response.ok || !payload?.success) {
    const detail = payload?.error ? `: ${payload.error}` : '';
    throw new Error(`Firecrawl answered ${response.status}${detail}`);
  }

  const parsed =
    parseBulletinHtml(payload.data?.html ?? '', { today }) ??
    parseBulletinMarkdown(payload.data?.markdown ?? '', { today });
  if (!parsed) throw new Error('Firecrawl returned a page without a readable bulletin.');
  return parsed;
}

/**
 * Read the newest bulletin. The direct request is free and fast, so it goes
 * first; Firecrawl only picks up when the school's edge turns us away.
 */
export async function scrapeBulletin(env: SourceEnv, today: string): Promise<ScrapeResult> {
  const url = bulletinUrl(env);
  let directError = '';

  try {
    const parsed = await scrapeDirect(env, today);
    if (parsed) return { parsed, source: 'direct', url };
  } catch (error) {
    directError = error instanceof Error ? error.message : String(error);
  }

  try {
    const parsed = await scrapeFirecrawl(env, today);
    if (parsed) return { parsed, source: 'firecrawl', url };
  } catch (error) {
    const fallback = error instanceof Error ? error.message : String(error);
    throw new Error(`${directError} ${fallback}`.replace(/\s+/g, ' ').trim());
  }

  throw new Error(directError || 'The bulletin could not be read.');
}
