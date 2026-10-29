import type { Block, ParsedBulletin } from './types';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const SCHOOL_TZ = 'America/New_York';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×'
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Flatten one HTML fragment to a single line of text. `\s` also folds `&nbsp;`. */
function inlineText(html: string): string {
  const flattened = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(flattened).replace(/\s+/g, ' ').trim();
}

function collectBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const pattern = /<(p|h[1-6]|li)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const text = inlineText(match[2]);
    if (!text) continue;
    const tag = match[1].toLowerCase();
    blocks.push({ type: tag === 'li' ? 'li' : tag.startsWith('h') ? 'h' : 'p', text });
    if (blocks.length >= 150) break;
  }
  return blocks;
}

/** Slice from the first `start` marker to the nearest of the `end` markers after it. */
function sliceRegion(html: string, start: string, ends: string[]): string | null {
  const from = html.indexOf(start);
  if (from < 0) return null;
  let to = html.length;
  for (const end of ends) {
    const index = html.indexOf(end, from + start.length);
    if (index > from && index < to) to = index;
  }
  return html.slice(from, to);
}

export function isoFromText(text: string): string | null {
  const match = new RegExp(`(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'i').exec(text);
  if (!match) return null;
  const month = MONTHS.findIndex(name => name.toLowerCase() === match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (month < 0 || day < 1 || day > 31 || year < 2000) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function weekdayFor(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return '';
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? '';
}

export function formatLongDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return iso;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** The school's calendar date right now. Bulletins are dated in Vermont, not UTC. */
export function schoolDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHOOL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const pick = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  if (!year || !month || !day) {
    return now.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}

const DAY_LABEL = /^(green|white)\s+day\b/i;
const DATE_ONLY = /^[A-Z][a-z]+ \d{1,2}(?:st|nd|rd|th)?,? \d{4}$/;

function normalizeDayLabel(text: string): string {
  const match = DAY_LABEL.exec(text);
  if (match) return `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} Day`;
  return text.replace(/\s+/g, ' ').trim().slice(0, 40);
}

/**
 * The bulletin's day label ("Green Day") is the first short subhead in the
 * body, ahead of any paragraphs. Pull it out and return the rest.
 */
function splitDayLabel(blocks: Block[]): { dayColor: string | null; blocks: Block[] } {
  const limit = Math.min(blocks.length, 3);
  let index = -1;
  for (let i = 0; i < limit; i += 1) {
    const block = blocks[i];
    if (block.type === 'h' && DAY_LABEL.test(block.text)) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    for (let i = 0; i < limit; i += 1) {
      const block = blocks[i];
      if (block.type === 'h' && block.text.length <= 40) {
        index = i;
        break;
      }
    }
  }
  if (index < 0) return { dayColor: null, blocks };
  const dayColor = normalizeDayLabel(blocks[index].text);
  return { dayColor, blocks: blocks.filter((_, i) => i !== index) };
}

function finish(
  blocks: Block[],
  fields: { date: string; dateText: string; weekday: string; title: string }
): ParsedBulletin | null {
  // A bare date line is metadata we already show above the text.
  const trimmed = blocks.filter(block => block.text.length > 0 && !DATE_ONLY.test(block.text));
  const hasParagraph = trimmed.some(block => block.type === 'p' || block.type === 'li');
  if (!trimmed.length || !hasParagraph) return null;
  const { dayColor, blocks: body } = splitDayLabel(trimmed);
  return {
    date: fields.date,
    dateText: fields.dateText || formatLongDate(fields.date),
    weekday: fields.weekday || weekdayFor(fields.date),
    dayColor,
    title: fields.title || 'Daily Bulletin',
    blocks: body
  };
}

/**
 * The live page keeps the newest bulletin in `.latest-article`, with the
 * subhead and paragraphs inside `.peapod-stripper`. Firecrawl's cleaned HTML
 * may keep only the inner markup, so each marker is optional.
 */
export function parseBulletinHtml(html: string, options: { today: string }): ParsedBulletin | null {
  if (!html || html.length < 40) return null;

  const article = sliceRegion(html, 'latest-article', ['news-wrap', '<footer', '</main>']) ?? html.slice(0, 80000);
  const bodyStart = article.indexOf('peapod-stripper');
  const header = bodyStart >= 0 ? article.slice(0, bodyStart) : article.slice(0, 4000);

  const headingMatch = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(header);
  const headingText = headingMatch ? inlineText(headingMatch[1]) : '';
  const [rawTitle, rawWeekday] = headingText.split('|').map(part => part.trim());
  const title = rawTitle || 'Daily Bulletin';

  const dateMatch = /<div\b[^>]*class="[^"]*\bdate\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(header);
  const headerText = inlineText(header);
  const dateText = (dateMatch ? inlineText(dateMatch[1]) : '') || (/[A-Z][a-z]+ \d{1,2},? \d{4}/.exec(headerText)?.[0] ?? '');
  const date = isoFromText(dateText) || isoFromText(headerText) || options.today;

  const body = bodyStart >= 0
    ? sliceRegion(article, 'peapod-stripper', ['news-wrap', '<footer', '</main>']) ?? article.slice(bodyStart)
    : article;

  let blocks = collectBlocks(body);
  // Without the wrapper the header blocks are in the body; drop the ones we
  // already showed above the text.
  const headingKey = headingText.toLowerCase();
  blocks = blocks.filter((block, index) => {
    if (index > 1) return true;
    const text = block.text.toLowerCase();
    if (headingKey && text === headingKey) return false;
    if (dateText && text === dateText.toLowerCase()) return false;
    return true;
  });

  return finish(blocks, {
    date,
    dateText,
    weekday: rawWeekday || '',
    title
  });
}

function cleanMarkdownInline(input: string): string {
  return input
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/\\([\\`*_[\]()#+\-.!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fallback for Firecrawl responses whose HTML no longer matches the theme. */
export function parseBulletinMarkdown(markdown: string, options: { today: string }): ParsedBulletin | null {
  if (!markdown) return null;

  const blocks: Block[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const text = cleanMarkdownInline(buffer.join(' '));
    buffer = [];
    if (text) blocks.push({ type: 'p', text });
  };

  for (const rawLine of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || /^([-*_]\s*){3,}$/.test(line)) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const text = cleanMarkdownInline(heading[2]);
      if (text) blocks.push({ type: 'h', text });
      continue;
    }
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const text = cleanMarkdownInline(item[1]);
      if (text) blocks.push({ type: 'li', text });
      continue;
    }
    if (blocks.length >= 150) break;
    buffer.push(line);
  }
  flush();

  if (!blocks.length) return null;

  const headingIndex = blocks.findIndex(block => block.type === 'h' && /daily bulletin/i.test(block.text));
  let title = 'Daily Bulletin';
  let weekday = '';
  if (headingIndex >= 0) {
    const [, rest] = blocks[headingIndex].text.split('|');
    if (rest) weekday = rest.trim();
    title = 'Daily Bulletin';
  }

  const dateText = blocks.map(block => block.text).map(text => /[A-Z][a-z]+ \d{1,2},? \d{4}/.exec(text)?.[0]).find(Boolean) ?? '';
  const date = isoFromText(dateText) || isoFromText(markdown) || options.today;

  const body = blocks.filter((block, index) => index !== headingIndex);
  return finish(body, { date, dateText, weekday, title });
}
