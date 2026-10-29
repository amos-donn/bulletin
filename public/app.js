const CHANNEL = 'hilltoppers-topping-v1';
const params = new URLSearchParams(location.search);
const embedded = parent !== window;
const session = params.get('session');
const expectedHost = params.get('host');

document.documentElement.classList.toggle('embedded', embedded);

// The host sends a context message before a content-height topping reports its
// size. This topping uses a fixed height, but answering `ready` keeps it
// behaving like the others and costs nothing.
window.addEventListener('message', event => {
  if (!embedded || event.source !== parent || event.origin !== expectedHost) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL || data.session !== session || data.type !== 'context') return;
  parent.postMessage({ channel: CHANNEL, session, type: 'ready' }, event.origin);
});

const nodes = {
  card: document.getElementById('bulletin'),
  weekday: document.getElementById('weekday'),
  date: document.getElementById('date'),
  pill: document.getElementById('day-pill'),
  body: document.getElementById('body'),
  note: document.getElementById('note'),
  stamp: document.getElementById('stamp'),
  source: document.getElementById('source'),
  refresh: document.getElementById('refresh')
};

let loading = false;
let last = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function clockTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
}

function relativeAge(seconds) {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

function dayPillClass(label) {
  const lower = (label || '').toLowerCase();
  if (lower.startsWith('green')) return 'green';
  if (lower.startsWith('white')) return 'white';
  return 'neutral';
}

function renderSkeleton() {
  nodes.body.replaceChildren();
  const wrap = el('div', 'skeleton-lines');
  wrap.append(el('span', 'skeleton'), el('span', 'skeleton'), el('span', 'skeleton'), el('span', 'skeleton'));
  nodes.body.append(wrap);
}

function renderError(data) {
  nodes.body.replaceChildren();
  const wrap = el('div', 'empty');
  wrap.append(el('p', 'empty-title', 'Couldn’t reach the school site.'));
  const reason = data && data.bulletin && data.stale
    ? 'Showing the last bulletin we could read.'
    : 'The bulletin is published on stjacademy.org. Try again in a minute.';
  wrap.append(el('p', 'empty-note', reason));
  const retry = el('button', 'empty-retry', 'Try again');
  retry.type = 'button';
  retry.addEventListener('click', () => load(true));
  wrap.append(retry);
  nodes.body.append(wrap);
}

function render(data) {
  const bulletin = data && data.bulletin;
  last = bulletin || null;

  if (!bulletin) {
    nodes.card.setAttribute('aria-busy', 'false');
    renderError(data);
    nodes.pill.hidden = true;
    nodes.stamp.textContent = '';
    return;
  }

  nodes.card.setAttribute('aria-busy', 'false');
  nodes.weekday.textContent = bulletin.weekday || bulletin.title || 'Daily Bulletin';
  nodes.date.textContent = bulletin.dateText;

  if (bulletin.dayColor) {
    nodes.pill.textContent = bulletin.dayColor;
    nodes.pill.className = `day-pill ${dayPillClass(bulletin.dayColor)}`;
    nodes.pill.hidden = false;
  } else {
    nodes.pill.hidden = true;
  }

  nodes.body.replaceChildren();
  let list = null;
  for (const block of bulletin.blocks) {
    if (block.type === 'li') {
      if (!list) {
        list = el('ul', 'block-list');
        nodes.body.append(list);
      }
      list.append(el('li', 'block', block.text));
      continue;
    }
    list = null;
    nodes.body.append(el('p', block.type === 'h' ? 'block block-head' : 'block', block.text));
  }

  const retrieved = clockTime(bulletin.fetchedAt);
  nodes.stamp.textContent = retrieved ? `Checked ${retrieved} · ${relativeAge(data.ageSeconds)}` : '';

  if (data.stale) {
    nodes.note.hidden = false;
    nodes.note.dataset.tone = 'stale';
    nodes.note.textContent = 'Couldn’t check for a newer bulletin. This is the last one read.';
  } else if (!data.isToday && bulletin.date < data.today) {
    nodes.note.hidden = false;
    nodes.note.dataset.tone = 'quiet';
    nodes.note.textContent = 'Today’s bulletin isn’t up yet.';
  } else {
    nodes.note.hidden = true;
    nodes.note.textContent = '';
  }
}

async function load(forceRefresh) {
  if (loading) return;
  loading = true;
  nodes.refresh.classList.add('spinning');
  nodes.card.setAttribute('aria-busy', 'true');

  if (!last) {
    nodes.date.textContent = 'Reading…';
    renderSkeleton();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`/api/bulletin${forceRefresh ? '?refresh=1' : ''}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal
    });
    const data = await response.json();
    render(data);
  } catch {
    render(last ? { bulletin: last, stale: true, isToday: true, ageSeconds: null, today: '' } : null);
  } finally {
    clearTimeout(timer);
    loading = false;
    nodes.refresh.classList.remove('spinning');
  }
}

nodes.refresh.addEventListener('click', () => load(true));
renderSkeleton();
void load(false);
