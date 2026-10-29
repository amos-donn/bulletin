import { describe, expect, it } from 'vitest';
import {
  formatLongDate,
  isoFromText,
  parseBulletinHtml,
  parseBulletinMarkdown,
  schoolDate,
  weekdayFor
} from './parse';

/** Trimmed copy of the live page's structure, not the page itself. */
const PAGE = `
<main>
<section class="daily-bulletin">
  <div class="container">
    <div class="latest-article">
      <div class="color-overlay"></div>
      <div class="inner">
        <h2>Daily Bulletin<span style="color:#b5cfbf;"> | Wednesday</span></h2>
        <div class="date">
            October 28, 2026        </div>
        <div class="peapod-stripper">
          <h4 class="all-caps-subhead"><span style="color: #939598;">Green Day</span></h4>
          <p>&nbsp;</p>
          <p class="body-text">Tomorrow will be a school photo day. You&#8217;ll be in Fuller Hall.</p>
          <p class="body-text"> </p>
          <p class="body-text">The Fall Concert is tonight at 7pm &amp; admission is free.</p>
          <p class="body-text">&nbsp;</p>
        </div>
      </div>
    </div>
    <div class="news-wrap">
      <div class="news-cards-container" id="bulletin-response"></div>
    </div>
  </div>
</section>
</main>
`;

describe('parseBulletinHtml', () => {
  const parsed = parseBulletinHtml(PAGE, { today: '2026-10-29' });

  it('reads the date, weekday and day label', () => {
    expect(parsed).not.toBeNull();
    expect(parsed!.date).toBe('2026-10-28');
    expect(parsed!.dateText).toBe('October 28, 2026');
    expect(parsed!.weekday).toBe('Wednesday');
    expect(parsed!.dayColor).toBe('Green Day');
    expect(parsed!.title).toBe('Daily Bulletin');
  });

  it('keeps paragraphs, decodes entities, drops spacers', () => {
    expect(parsed!.blocks).toHaveLength(2);
    expect(parsed!.blocks[0]).toEqual({
      type: 'p',
      text: 'Tomorrow will be a school photo day. You’ll be in Fuller Hall.'
    });
    expect(parsed!.blocks[1].text).toBe('The Fall Concert is tonight at 7pm & admission is free.');
  });

  it('does not repeat the day label inside the body', () => {
    expect(parsed!.blocks.some(block => block.text === 'Green Day')).toBe(false);
  });

  it('copes with cleaned HTML that lost the wrappers', () => {
    const stripped = `
      <div class="peapod-stripper">
        <h4>White Day</h4>
        <p>No school tomorrow.</p>
      </div>`;
    const fallback = parseBulletinHtml(stripped, { today: '2026-10-29' });
    expect(fallback).not.toBeNull();
    expect(fallback!.date).toBe('2026-10-29');
    expect(fallback!.dayColor).toBe('White Day');
    expect(fallback!.blocks).toEqual([{ type: 'p', text: 'No school tomorrow.' }]);
  });

  it('rejects a page with no bulletin in it', () => {
    expect(parseBulletinHtml('<html><body><nav>Menu</nav></body></html>', { today: '2026-10-29' })).toBeNull();
    expect(parseBulletinHtml('', { today: '2026-10-29' })).toBeNull();
  });

  it('keeps list items', () => {
    const html = `
      <div class="latest-article"><h2>Daily Bulletin | Friday</h2>
        <div class="date">October 30, 2026</div>
        <div class="peapod-stripper"><h4>Green Day</h4>
          <p>Reminders:</p><ul><li>Bring your ID.</li><li>Seniors meet at 9.</li></ul>
        </div>
      </div>`;
    const parsedList = parseBulletinHtml(html, { today: '2026-10-30' });
    expect(parsedList!.blocks.map(block => block.type)).toEqual(['p', 'li', 'li']);
  });
});

describe('parseBulletinMarkdown', () => {
  it('reads a Firecrawl markdown rendering', () => {
    const markdown = `
## Daily Bulletin | Thursday

October 29, 2026

#### White Day

Picture retakes are on the Fuller Hall stage at 8:30.

[Read more](https://stjacademy.org/example)
`;
    const parsed = parseBulletinMarkdown(markdown, { today: '2026-10-29' });
    expect(parsed).not.toBeNull();
    expect(parsed!.date).toBe('2026-10-29');
    expect(parsed!.weekday).toBe('Thursday');
    expect(parsed!.dayColor).toBe('White Day');
    expect(parsed!.blocks.map(block => block.text)).toEqual([
      'Picture retakes are on the Fuller Hall stage at 8:30.',
      'Read more'
    ]);
  });

  it('returns null for an empty document', () => {
    expect(parseBulletinMarkdown('', { today: '2026-10-29' })).toBeNull();
  });
});

describe('dates', () => {
  it('parses the school date format', () => {
    expect(isoFromText('October 28, 2026')).toBe('2026-10-28');
    expect(isoFromText('Sept 3, 2026')).toBeNull();
    expect(formatLongDate('2026-01-05')).toBe('January 5, 2026');
    expect(weekdayFor('2026-10-28')).toBe('Wednesday');
  });

  it('uses the school timezone, not UTC', () => {
    // 02:00 UTC on the 29th is still the evening of the 28th in Vermont.
    expect(schoolDate(new Date('2026-10-29T02:00:00Z'))).toBe('2026-10-28');
    expect(schoolDate(new Date('2026-10-28T13:00:00Z'))).toBe('2026-10-28');
  });
});
