export type BlockType = 'p' | 'h' | 'li';

export interface Block {
  type: BlockType;
  text: string;
}

/** What the parser produces, before we know where it came from. */
export interface ParsedBulletin {
  /** School calendar date, `YYYY-MM-DD`. */
  date: string;
  /** The date as the school writes it, e.g. "October 28, 2026". */
  dateText: string;
  weekday: string;
  /** "Green Day", "White Day", or whatever the bulletin's own subhead says. */
  dayColor: string | null;
  title: string;
  blocks: Block[];
}

/** A parsed bulletin plus where and when we read it. */
export interface Bulletin extends ParsedBulletin {
  source: 'direct' | 'firecrawl';
  sourceUrl: string;
  fetchedAt: number;
}
