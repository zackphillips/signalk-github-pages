// Ship's Docs — renders the Markdown files in docs/ inside the site UI.
//
// Everything is client-side: docs/index.json lists the documents (written by
// scripts/build_docs_index.py, rebuilt in CI on every push to docs/), and each
// .md file is fetched verbatim and rendered with marked. Adding a document is
// therefore just "commit a .md file" — including from the GitHub web UI.
//
// Loads after constants.js, which must define window.VESSEL_CONSTANTS.

if (!window.VESSEL_CONSTANTS) throw new Error('constants.js must load before docs.js');
const C = window.VESSEL_CONSTANTS;

const DARK_THEMES = new Set(C.DARK_THEMES);
const isDarkTheme = (theme) => DARK_THEMES.has(theme);

// Front matter is metadata for the index builder, not prose — never render it.
const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;

const el = {
  nav:        document.getElementById('docs-nav'),
  search:     document.getElementById('docs-search-input'),
  article:    document.getElementById('docs-article'),
  header:     document.getElementById('docs-doc-header'),
  title:      document.getElementById('docs-doc-title'),
  meta:       document.getElementById('docs-doc-meta'),
  themeBtn:   document.getElementById('darkModeToggle'),
};

let docsIndex = [];        // entries from docs/index.json
let activeSlug = null;     // slug of the document on screen
let activeToc = [];        // [{ id, text, level }] for the document on screen
let expandedToc = new Set(); // ids of h2 TOC entries currently expanded
let searchTerm = '';
const markdownCache = new Map();

// ── Helpers ─────────────────────────────────────────────────────────────────

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function relativeDate(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function readingTime(words) {
  return `${Math.max(1, Math.round((words || 0) / 220))} min read`;
}

// ── Index loading ───────────────────────────────────────────────────────────

// `cache: 'no-cache'` revalidates against the server instead of trusting the
// 10-minute Pages cache, so a doc edited in the GitHub UI appears right away.
// A cache-busting query string would defeat the service worker, whose offline
// fallback is keyed on the exact request URL.
const FRESH = { cache: 'no-cache' };

// docs/index.json itself sorts categories alphabetically (see
// scripts/build_docs_index.py) so the file stays predictable to diff.
// C.DOCS_CATEGORY_ORDER is what actually controls sidebar section order —
// applied here, once, so every consumer of docsIndex (nav grouping, the
// default-document fallback in route()) sees the same order. A stable
// sort by category rank alone preserves the existing (order, title)
// ordering within each category. Categories not listed sort alphabetically
// after the ones that are.
function sortByCategoryOrder(docs) {
  const order = C.DOCS_CATEGORY_ORDER || [];
  const rank = (category) => {
    const i = order.indexOf(category);
    return i === -1 ? order.length : i;
  };
  return [...docs].sort((a, b) => {
    const diff = rank(a.category) - rank(b.category);
    return diff !== 0 ? diff : a.category.localeCompare(b.category);
  });
}

async function loadIndex() {
  const response = await fetch(C.DOCS_INDEX_URL, FRESH);
  if (!response.ok) throw new Error(`${C.DOCS_INDEX_URL} → HTTP ${response.status}`);
  const payload = await response.json();
  return sortByCategoryOrder(Array.isArray(payload.docs) ? payload.docs : []);
}

async function loadMarkdown(entry) {
  if (markdownCache.has(entry.slug)) return markdownCache.get(entry.slug);
  const response = await fetch(entry.path, FRESH);
  if (!response.ok) throw new Error(`${entry.path} → HTTP ${response.status}`);
  const text = (await response.text()).replace(FRONT_MATTER_RE, '');
  markdownCache.set(entry.slug, text);
  return text;
}

// Pull every document into the service worker's cache once the first one is on
// screen. They are small text files, and a crew member offshore with no signal
// is exactly who needs the safety procedures.
function prefetchAllDocs() {
  for (const entry of docsIndex) {
    if (markdownCache.has(entry.slug)) continue;
    loadMarkdown(entry).catch(() => {});
  }
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

function matchesSearch(entry) {
  if (!searchTerm) return true;
  const haystack = [
    entry.title,
    entry.category,
    entry.description,
    ...(entry.headings || []).map((h) => h.text),
  ].join(' ').toLowerCase();
  return searchTerm.split(/\s+/).every((word) => haystack.includes(word));
}

// Group the flat h2/h3 heading list into h2 sections with their h3 children
// nested underneath, so the sidebar can render each section collapsed until
// the reader opens it.
function buildTocTree(toc) {
  const roots = [];
  let current = null;
  for (const heading of toc) {
    if (heading.level <= 2 || !current) {
      current = { heading, children: [] };
      roots.push(current);
    } else {
      current.children.push({ heading, children: [] });
    }
  }
  return roots;
}

function renderToc(tree) {
  const html = ['<div class="docs-nav__toc">'];
  for (const { heading, children } of tree) {
    const hasChildren = children.length > 0;
    const expanded = expandedToc.has(heading.id);
    const classes = `docs-nav__toc-item docs-nav__toc-item--h${heading.level}` +
      (hasChildren ? ' docs-nav__toc-item--parent' : '');
    html.push(
      `<a class="${classes}" href="#${heading.id}" data-toc-id="${heading.id}"` +
      (hasChildren ? ` aria-expanded="${expanded}"` : '') + '>' +
      (hasChildren ? '<span class="docs-nav__toc-caret" aria-hidden="true"></span>' : '') +
      `${escapeHtml(heading.text)}</a>`
    );
    if (hasChildren) {
      html.push(`<div class="docs-nav__toc-children"${expanded ? '' : ' hidden'}>`);
      for (const child of children) {
        html.push(
          `<a class="docs-nav__toc-item docs-nav__toc-item--h${child.heading.level}" href="#${child.heading.id}">` +
          `${escapeHtml(child.heading.text)}</a>`
        );
      }
      html.push('</div>');
    }
  }
  html.push('</div>');
  return html.join('');
}

// A direct link to a nested (h3) heading is useless if the sidebar keeps it
// hidden — open whichever section owns it.
function expandTocAncestor(headingId) {
  if (!headingId) return;
  const index = activeToc.findIndex((h) => h.id === headingId);
  if (index === -1 || activeToc[index].level <= 2) return;
  for (let i = index - 1; i >= 0; i--) {
    if (activeToc[i].level <= 2) {
      expandedToc.add(activeToc[i].id);
      return;
    }
  }
}

function renderNav() {
  const visible = docsIndex.filter(matchesSearch);

  if (!visible.length) {
    el.nav.innerHTML = `<div class="docs-nav__empty">${
      docsIndex.length ? 'No documents match that search.' : 'No documents yet.'
    }</div>`;
    return;
  }

  const groups = new Map();
  for (const entry of visible) {
    if (!groups.has(entry.category)) groups.set(entry.category, []);
    groups.get(entry.category).push(entry);
  }

  const html = [];
  for (const [category, entries] of groups) {
    html.push(`<div class="docs-nav__group"><div class="docs-nav__category">${escapeHtml(category)}</div>`);
    for (const entry of entries) {
      const active = entry.slug === activeSlug;
      html.push(
        `<a class="docs-nav__item${active ? ' is-active' : ''}" href="?doc=${encodeURIComponent(entry.slug)}"` +
        ` data-slug="${escapeHtml(entry.slug)}">${escapeHtml(entry.title)}</a>`
      );
      // The table of contents nests under whichever document is open, so the
      // sidebar never needs a third column. Sections start collapsed — only
      // headings, not their sub-entries, show until a heading is clicked.
      if (active && activeToc.length) {
        html.push(renderToc(buildTocTree(activeToc)));
      }
    }
    html.push('</div>');
  }
  el.nav.innerHTML = html.join('');
}

// ── Checklists ──────────────────────────────────────────────────────────────
//
// operations.md and friends are full of `- [ ]` items. marked renders those as
// disabled checkboxes; a pre-departure checklist you cannot tick is useless, so
// they are re-enabled and their state is remembered per device.
//
// The storage key is derived from the item's text rather than its position, so
// editing an unrelated line in the document does not clear the ticks below it.

function checklistKey(slug) {
  return `${C.DOCS_CHECKLIST_PREFIX}${slug}`;
}

function loadChecklistState(slug) {
  try {
    return JSON.parse(localStorage.getItem(checklistKey(slug)) || '{}');
  } catch {
    return {};
  }
}

function saveChecklistState(slug, state) {
  try {
    localStorage.setItem(checklistKey(slug), JSON.stringify(state));
  } catch { /* private mode or quota — ticks just will not persist */ }
}

function initChecklists(slug) {
  const boxes = [...el.article.querySelectorAll('input[type="checkbox"]')];
  if (!boxes.length) return null;

  const state = loadChecklistState(slug);
  const seen = new Map();

  for (const box of boxes) {
    const label = (box.closest('li')?.textContent || '').trim().toLowerCase();
    // Identical wording in two places ("Check oil level") still needs distinct
    // keys, so repeats get a counter suffix.
    const repeat = (seen.get(label) || 0) + 1;
    seen.set(label, repeat);
    const key = repeat > 1 ? `${label}#${repeat}` : label;

    box.disabled = false;
    box.checked = Boolean(state[key]);
    box.dataset.key = key;
    box.closest('li')?.classList.toggle('is-checked', box.checked);
    box.addEventListener('change', () => {
      const current = loadChecklistState(slug);
      if (box.checked) current[box.dataset.key] = true;
      else delete current[box.dataset.key];
      saveChecklistState(slug, current);
      box.closest('li')?.classList.toggle('is-checked', box.checked);
      updateChecklistCount();
    });
  }

  return boxes;
}

function updateChecklistCount() {
  const counter = document.getElementById('docs-checklist-count');
  if (!counter) return;
  const boxes = el.article.querySelectorAll('input[type="checkbox"]');
  const done = el.article.querySelectorAll('input[type="checkbox"]:checked').length;
  counter.textContent = `${done} / ${boxes.length} checked`;
}

function renderChecklistControls(slug, boxes) {
  if (!boxes) return '';
  return (
    '<span class="docs-doc-meta__item docs-checklist-controls">' +
    '<span id="docs-checklist-count"></span>' +
    '<button type="button" class="docs-reset-btn" id="docs-checklist-reset">Reset</button>' +
    '</span>'
  );
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderMarkdown(markdown) {
  const html = marked.parse(markdown, { gfm: true, breaks: false });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
}

// Assign stable ids to headings and collect the table of contents. Doing this
// on the rendered DOM (rather than trusting the index) guarantees the anchors
// in the sidebar always match the anchors in the document.
function decorateHeadings() {
  const used = new Set();
  const toc = [];
  for (const heading of el.article.querySelectorAll('h2, h3')) {
    let id = slugify(heading.textContent) || 'section';
    let candidate = id;
    let n = 1;
    while (used.has(candidate)) candidate = `${id}-${++n}`;
    used.add(candidate);
    heading.id = candidate;
    toc.push({ id: candidate, text: heading.textContent.trim(), level: Number(heading.tagName[1]) });
  }
  return toc;
}

function decorateLinks() {
  for (const link of el.article.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) continue;

    // Cross-references between documents stay inside the reader.
    if (/^[^/:]+\.md(#.*)?$/i.test(href)) {
      const [file, hash] = href.split('#');
      const slug = file.replace(/\.md$/i, '');
      link.setAttribute('href', `?doc=${encodeURIComponent(slug)}${hash ? `#${hash}` : ''}`);
      link.dataset.slug = slug;
      continue;
    }

    if (/^https?:/i.test(href)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  }
}

// Wide tables (systems.md has several) must scroll inside the article rather
// than pushing the whole page sideways on a phone.
function wrapTables() {
  for (const table of el.article.querySelectorAll('table')) {
    if (table.parentElement?.classList.contains('docs-table-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'docs-table-wrap';
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
}

function renderDocMeta(entry, boxes) {
  const bits = [];
  if (entry.category) bits.push(`<span class="docs-doc-meta__item">${escapeHtml(entry.category)}</span>`);
  if (entry.words) bits.push(`<span class="docs-doc-meta__item">${readingTime(entry.words)}</span>`);
  if (entry.updated) {
    bits.push(`<span class="docs-doc-meta__item">Updated ${escapeHtml(relativeDate(entry.updated))}</span>`);
  }
  bits.push(renderChecklistControls(entry.slug, boxes));
  bits.push(
    `<a class="docs-doc-meta__item docs-edit-link" target="_blank" rel="noopener noreferrer"` +
    ` href="https://github.com/${C.GITHUB_REPO}/edit/${C.GITHUB_DEFAULT_BRANCH}/${escapeHtml(entry.path)}">Edit on GitHub</a>`
  );
  return bits.join('');
}

async function showDoc(slug, { scrollToHash = true } = {}) {
  const entry = docsIndex.find((d) => d.slug === slug);
  if (!entry) {
    showPlaceholder(`No document named “${escapeHtml(slug)}”.`);
    return;
  }

  activeSlug = slug;
  activeToc = [];  // the outgoing document's headings must not linger in the nav
  expandedToc = new Set();  // every document opens with its TOC sections collapsed
  el.article.innerHTML = '<p class="docs-placeholder">Loading…</p>';
  el.header.style.display = '';
  el.title.textContent = entry.title;
  el.meta.innerHTML = '';
  document.title = `${entry.title} — Ship's Docs`;
  renderNav();

  let markdown;
  try {
    markdown = await loadMarkdown(entry);
  } catch (error) {
    el.article.innerHTML =
      `<p class="docs-error">Could not load <code>${escapeHtml(entry.path)}</code>.<br />` +
      `${escapeHtml(error.message)}</p>`;
    return;
  }

  // A stale response can land after the reader has moved on.
  if (activeSlug !== slug) return;

  el.article.innerHTML = renderMarkdown(markdown);

  // A leading H1 is the document's own title, already shown in the header.
  if (el.article.firstElementChild?.tagName === 'H1') el.article.firstElementChild.remove();

  wrapTables();
  decorateLinks();
  activeToc = decorateHeadings();
  expandTocAncestor(location.hash ? decodeURIComponent(location.hash.slice(1)) : null);
  const boxes = initChecklists(entry.slug);
  el.meta.innerHTML = renderDocMeta(entry, boxes);
  updateChecklistCount();

  document.getElementById('docs-checklist-reset')?.addEventListener('click', () => {
    saveChecklistState(entry.slug, {});
    for (const box of el.article.querySelectorAll('input[type="checkbox"]')) {
      box.checked = false;
      box.closest('li')?.classList.remove('is-checked');
    }
    updateChecklistCount();
  });

  renderNav();

  if (scrollToHash && location.hash) {
    document.getElementById(decodeURIComponent(location.hash.slice(1)))
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function showPlaceholder(message) {
  activeSlug = null;
  activeToc = [];
  expandedToc = new Set();
  el.header.style.display = 'none';
  el.article.innerHTML = `<p class="docs-placeholder">${message}</p>`;
  renderNav();
}

// ── Routing ─────────────────────────────────────────────────────────────────

function slugFromUrl() {
  return new URLSearchParams(location.search).get('doc');
}

function navigate(slug, { replace = false, hash = '' } = {}) {
  const url = `?doc=${encodeURIComponent(slug)}${hash}`;
  if (replace) history.replaceState({ slug }, '', url);
  else history.pushState({ slug }, '', url);
  showDoc(slug);
}

function route({ replace = false } = {}) {
  const slug = slugFromUrl();
  if (slug) {
    // A same-page anchor click (e.g. a sidebar TOC entry) is a same-document
    // navigation, and per spec that also fires 'popstate' — not just actual
    // back/forward. Re-running showDoc for the document already on screen
    // would re-fetch nothing useful but would blow away sidebar state (which
    // TOC sections are expanded, checklist DOM); just honor the new hash.
    if (slug === activeSlug) {
      if (location.hash) {
        document.getElementById(decodeURIComponent(location.hash.slice(1)))
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    showDoc(slug);
    return;
  }
  if (docsIndex.length) navigate(docsIndex[0].slug, { replace: true });
  else showPlaceholder('No documents yet. Add a Markdown file under <code>docs/</code>.');
}

// ── Theme toggle ────────────────────────────────────────────────────────────

function initTheme() {
  const html = document.documentElement;
  const apply = (theme) => {
    html.setAttribute('data-theme', theme);
    el.themeBtn.textContent = theme.charAt(0).toUpperCase() + theme.slice(1);
    el.themeBtn.style.background = isDarkTheme(theme) ? '#555e6e' : '#2c3e50';
    el.themeBtn.style.color = '#fff';
  };

  let theme = html.getAttribute('data-theme') || 'marine';
  if (!C.THEMES.includes(theme)) theme = C.THEMES[0];
  apply(theme);

  el.themeBtn.addEventListener('click', () => {
    const next = C.THEMES[(C.THEMES.indexOf(html.getAttribute('data-theme')) + 1) % C.THEMES.length];
    apply(next);
    try { localStorage.setItem('theme', next); } catch { /* private mode */ }
  });
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function initEvents() {
  // Intercept in-app links so switching documents does not reload the page.
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-slug]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    const hash = link.getAttribute('href').includes('#')
      ? `#${link.getAttribute('href').split('#')[1]}`
      : '';
    navigate(link.dataset.slug, { hash });
    if (window.matchMedia('(max-width: 900px)').matches) {
      document.getElementById('docs-main')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  // Clicking a TOC heading that has sub-entries expands/collapses them in
  // place; the link's href still takes the reader to that heading as normal.
  el.nav.addEventListener('click', (event) => {
    const parent = event.target.closest('.docs-nav__toc-item--parent');
    if (!parent) return;
    const id = parent.dataset.tocId;
    if (expandedToc.has(id)) expandedToc.delete(id);
    else expandedToc.add(id);
    renderNav();
  });

  el.search.addEventListener('input', () => {
    searchTerm = el.search.value.trim().toLowerCase();
    renderNav();
  });

  window.addEventListener('popstate', () => route({ replace: true }));

  // "/" focuses search, the way every docs site behaves.
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== el.search) {
      event.preventDefault();
      el.search.focus();
    }
  });
}

async function init() {
  initTheme();
  initEvents();

  try {
    docsIndex = await loadIndex();
  } catch (error) {
    el.nav.innerHTML = '<div class="docs-nav__empty">Index unavailable.</div>';
    el.header.style.display = 'none';
    el.article.innerHTML =
      `<p class="docs-error">Could not load the document index.<br />${escapeHtml(error.message)}` +
      `<br /><span class="docs-error__hint">Run <code>make docs-index</code> to regenerate ` +
      `<code>docs/index.json</code>.</span></p>`;
    return;
  }

  route({ replace: true });
  prefetchAllDocs();
}

init();
