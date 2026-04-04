/**
 * Blink Website Build Script
 *
 * Reads JSON post files from data/posts/, generates:
 *   - dist/index.html (main site with journal preview)
 *   - dist/journal/index.html (full journal feed, paginated)
 *   - dist/journal/page/2/index.html, etc.
 *   - dist/posts/{slug}/index.html (individual post pages)
 *
 * Runs on Netlify at build time — no dependencies needed.
 */

const fs = require('fs');
const path = require('path');

const POSTS_PER_PAGE = 12;
const SITE_URL = 'https://blinkformentera.com';
const DIST = path.join(__dirname, 'dist');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDirRecursive(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function formatDate(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatDateShort(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip hashtags and trim for clean display */
function cleanCaption(caption) {
  return caption
    .replace(/#\w+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract hashtags from caption */
function extractHashtags(caption) {
  const matches = caption.match(/#\w+/g);
  return matches || [];
}

// ─── Load posts ──────────────────────────────────────────────────────────────

function loadPosts() {
  const postsDir = path.join(__dirname, 'data', 'posts');
  if (!fs.existsSync(postsDir)) return [];

  const files = fs.readdirSync(postsDir).filter(f => f.endsWith('.json'));
  const posts = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(postsDir, file), 'utf8');
      const post = JSON.parse(raw);
      post._file = file;
      posts.push(post);
    } catch (e) {
      console.warn(`Skipping invalid post file: ${file} — ${e.message}`);
    }
  }

  // Sort newest first
  posts.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return posts;
}

// ─── Shared HTML parts ──────────────────────────────────────────────────────

const HEAD_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&family=Outfit:wght@300;400;500&display=swap" rel="stylesheet">`;

const CSS_VARS = `
:root {
  --cyan: #38BCD4;
  --dark: #3a3a3a;
  --mid: #6b6b6b;
  --light: #f5f3ef;
  --white: #ffffff;
  --border: #e0ddd8;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: "Outfit", sans-serif;
  font-weight: 300;
  color: var(--dark);
  background: var(--white);
  overflow-x: hidden;
}
`;

const NAV_CSS = `
nav {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.8rem 3rem;
  background: rgba(255,255,255,0.95);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}
.nav-logo { text-decoration: none; display: block; }
.nav-logo img { height: 48px; width: auto; display: block; }
.nav-links { display: flex; gap: 2.5rem; list-style: none; }
.nav-links a {
  text-decoration: none;
  font-size: 0.75rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--mid);
  transition: color 0.2s;
}
.nav-links a:hover { color: var(--cyan); }
.nav-links a.active { color: var(--cyan); }
.hamburger { display: none; }
.nav-right { display: flex; align-items: center; gap: 1rem; }
.cart-button { position: relative; background: none; border: none; cursor: pointer; color: var(--dark); transition: color 0.2s; padding: 0.3rem; }
.cart-button:hover { color: var(--cyan); }
.cart-count { position: absolute; top: -4px; right: -6px; background: var(--cyan); color: white; font-size: 0.55rem; font-family: "Outfit", sans-serif; width: 16px; height: 16px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 500; }
@media (max-width: 900px) {
  nav { padding: 0; }
  .nav-logo img { height: 60px; }
  .nav-links { display: none; padding-right: 1rem; }
  .nav-links.open { display: flex; flex-direction: column; gap: 0; position: absolute; top: 60px; left: 0; right: 0; background: rgba(255,255,255,0.97); border-bottom: 1px solid var(--border); padding: 0.5rem 0; }
  .nav-links.open li a { display: block; padding: 0.8rem 1.5rem; font-size: 0.72rem; letter-spacing: 0.2em; }
  .hamburger { display: flex; flex-direction: column; justify-content: center; gap: 5px; padding: 1rem 1.2rem; cursor: pointer; background: none; border: none; }
  .hamburger span { display: block; width: 22px; height: 1.5px; background: var(--dark); transition: all 0.3s; }
  .hamburger.open span:nth-child(1) { transform: translateY(6.5px) rotate(45deg); }
  .hamburger.open span:nth-child(2) { opacity: 0; }
  .hamburger.open span:nth-child(3) { transform: translateY(-6.5px) rotate(-45deg); }
}
`;

const FOOTER_CSS = `
footer {
  background: var(--dark);
  padding: 2.5rem 6rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.footer-logo span {
  font-size: 0.68rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: rgba(255,255,255,0.4);
}
.footer-links { display: flex; gap: 2rem; list-style: none; }
.footer-links a {
  color: rgba(255,255,255,0.35);
  text-decoration: none;
  font-size: 0.72rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  transition: color 0.2s;
}
.footer-links a:hover { color: var(--cyan); }
.footer-copy {
  font-size: 0.68rem;
  color: rgba(255,255,255,0.2);
}
@media (max-width: 900px) {
  footer { flex-direction: column; gap: 1.5rem; text-align: center; padding: 2rem 1.5rem; }
}
`;

const JOURNAL_CSS = `
.journal-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2rem;
  padding: 0;
}

.journal-card {
  background: var(--white);
  border: 1px solid var(--border);
  overflow: hidden;
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}

.journal-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 40px rgba(0,0,0,0.08);
}

.journal-card a {
  text-decoration: none;
  color: inherit;
  display: block;
}

.journal-card-img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  display: block;
  background: var(--light);
}

.journal-card-body {
  padding: 1.5rem;
}

.journal-card-meta {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  margin-bottom: 0.8rem;
}

.journal-card-date {
  font-size: 0.68rem;
  letter-spacing: 0.1em;
  color: var(--mid);
  text-transform: uppercase;
}

.journal-card-location {
  font-size: 0.6rem;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--cyan);
  border: 1px solid var(--cyan);
  padding: 0.1rem 0.5rem;
  border-radius: 2px;
}

.journal-card-caption {
  font-size: 0.88rem;
  line-height: 1.7;
  color: var(--dark);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.journal-card-type {
  display: inline-block;
  font-size: 0.58rem;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--mid);
  margin-top: 0.8rem;
}

@media (max-width: 900px) {
  .journal-grid { grid-template-columns: 1fr 1fr; gap: 1rem; }
  .journal-card-body { padding: 1rem; }
}

@media (max-width: 560px) {
  .journal-grid { grid-template-columns: 1fr; }
}

/* Pagination */
.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  margin-top: 4rem;
  padding: 2rem 0;
}

.pagination a, .pagination span {
  font-size: 0.75rem;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--mid);
  padding: 0.5rem 1.2rem;
  border: 1px solid var(--border);
  transition: all 0.2s;
}

.pagination a:hover { color: var(--cyan); border-color: var(--cyan); }
.pagination .current { color: var(--cyan); border-color: var(--cyan); }
`;

const SINGLE_POST_CSS = `
.post-hero {
  padding-top: 90px;
  max-width: 720px;
  margin: 0 auto;
  padding-left: 1.5rem;
  padding-right: 1.5rem;
}

.post-meta {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.5rem;
  padding-top: 2rem;
}

.post-date {
  font-size: 0.7rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--mid);
}

.post-location-tag {
  font-size: 0.62rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--cyan);
  border: 1px solid var(--cyan);
  padding: 0.15rem 0.6rem;
}

.post-brand-tag {
  font-size: 0.62rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--mid);
  background: var(--light);
  padding: 0.15rem 0.6rem;
}

.post-images {
  margin: 2rem 0;
}

.post-images img {
  width: 100%;
  display: block;
  background: var(--light);
}

.post-images img + img {
  margin-top: 1rem;
}

.post-caption {
  font-size: 1.05rem;
  line-height: 2;
  color: var(--dark);
  margin-bottom: 2rem;
  white-space: pre-line;
}

.post-hashtags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 2rem;
}

.post-hashtags span {
  font-size: 0.72rem;
  color: var(--cyan);
  letter-spacing: 0.05em;
}

.post-ig-link {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.72rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--mid);
  text-decoration: none;
  border: 1px solid var(--border);
  padding: 0.6rem 1.2rem;
  transition: all 0.2s;
  margin-bottom: 4rem;
}

.post-ig-link:hover { color: var(--cyan); border-color: var(--cyan); }

.post-ig-link svg { width: 16px; height: 16px; }

.post-reel-embed {
  position: relative;
  margin: 2rem 0;
  text-align: center;
}

.post-reel-thumb {
  position: relative;
  display: inline-block;
  max-width: 100%;
}

.post-reel-thumb img {
  width: 100%;
  display: block;
}

.post-reel-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.3);
  transition: background 0.2s;
}

.post-reel-play:hover { background: rgba(0,0,0,0.5); }

.post-reel-play svg { width: 64px; height: 64px; fill: white; }

.post-nav {
  display: flex;
  justify-content: space-between;
  padding: 2rem 0 4rem;
  border-top: 1px solid var(--border);
}

.post-nav a {
  font-size: 0.72rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--mid);
  text-decoration: none;
  transition: color 0.2s;
}

.post-nav a:hover { color: var(--cyan); }

@media (max-width: 900px) {
  .post-hero { padding-top: 70px; }
}
`;

function navHtml(activePage, basePath = '') {
  const prefix = basePath || '';
  const aboutHref = activePage === 'home' ? '#about' : `${prefix}/index.html#about`;
  const brandsHref = activePage === 'home' ? '#brands' : `${prefix}/index.html#brands`;
  const shopHref = activePage === 'home' ? '#shop' : `${prefix}/index.html#shop`;
  const storesHref = activePage === 'home' ? '#stores' : `${prefix}/index.html#stores`;

  return `<nav>
  <a href="${prefix}/index.html" class="nav-logo">
    <img src="${prefix}/assets/blink-logo.jpg" alt="Blink" onerror="this.parentElement.innerHTML='<span style=&quot;font-family:Cormorant Garamond,serif;font-size:1.6rem;font-weight:300;font-style:italic;color:var(--dark)&quot;>Blink</span>'">
  </a>
  <ul class="nav-links">
    <li><a href="${aboutHref}">About</a></li>
    <li><a href="${brandsHref}">Brands</a></li>
    <li><a href="${shopHref}">Shop</a></li>
    <li><a href="${storesHref}">Stores</a></li>
    <li><a href="${prefix}/journal/index.html"${activePage === 'journal' ? ' class="active"' : ''}>Journal</a></li>
    <li><a href="${storesHref}">Contact</a></li>
  </ul>
  <div class="nav-right">
    <button class="cart-button snipcart-checkout" aria-label="Shopping bag">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="3" y1="6" x2="21" y2="6"/>
        <path d="M16 10a4 4 0 01-8 0"/>
      </svg>
      <span class="cart-count snipcart-items-count">0</span>
    </button>
    <button class="hamburger" id="hamburger" aria-label="Menu">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>
<script>
  const btn = document.getElementById('hamburger');
  const links = document.querySelector('.nav-links');
  btn.addEventListener('click', () => {
    btn.classList.toggle('open');
    links.classList.toggle('open');
  });
</script>`;
}

function footerHtml(basePath = '') {
  const prefix = basePath || '';
  return `<footer>
  <div class="footer-logo"><span>Blink Ibiza &amp; Formentera</span></div>
  <ul class="footer-links">
    <li><a href="${prefix}/index.html#about">About</a></li>
    <li><a href="${prefix}/index.html#brands">Brands</a></li>
    <li><a href="${prefix}/index.html#shop">Shop</a></li>
    <li><a href="${prefix}/journal/index.html">Journal</a></li>
    <li><a href="${prefix}/index.html#stores">Stores</a></li>
  </ul>
  <p class="footer-copy">&copy; ${new Date().getFullYear()} Blink Ibiza &amp; Formentera</p>
</footer>`;
}

function postCardHtml(post, basePath = '') {
  const prefix = basePath || '';
  const displayCaption = escapeHtml(cleanCaption(post.caption));
  const img = post.thumbnailUrl || (post.images && post.images[0]) || '';
  const typeLabel = post.postType === 'carousel' ? 'Gallery' : post.postType === 'video' ? 'Reel' : '';

  return `<article class="journal-card">
  <a href="${prefix}/posts/${post.slug}/index.html">
    ${img ? `<img class="journal-card-img" src="${escapeHtml(img)}" alt="${escapeHtml(cleanCaption(post.caption).slice(0, 80))}" loading="lazy">` : `<div class="journal-card-img" style="display:flex;align-items:center;justify-content:center;color:var(--mid);font-size:0.8rem;">No image</div>`}
    <div class="journal-card-body">
      <div class="journal-card-meta">
        <span class="journal-card-date">${formatDateShort(post.publishedAt)}</span>
        ${post.location ? `<span class="journal-card-location">${escapeHtml(post.location)}</span>` : ''}
      </div>
      <p class="journal-card-caption">${displayCaption}</p>
      ${typeLabel ? `<span class="journal-card-type">${typeLabel}</span>` : ''}
    </div>
  </a>
</article>`;
}

// ─── Build individual post pages ─────────────────────────────────────────────

function buildPostPage(post, prevPost, nextPost) {
  const postDir = path.join(DIST, 'posts', post.slug);
  ensureDir(postDir);

  const hashtags = extractHashtags(post.caption);
  const caption = cleanCaption(post.caption);
  const isReel = post.postType === 'video';

  let imagesHtml = '';
  if (isReel) {
    const thumb = post.thumbnailUrl || (post.images && post.images[0]) || '';
    imagesHtml = `<div class="post-reel-embed">
  <a href="${escapeHtml(post.instagramUrl || '#')}" target="_blank" rel="noopener" class="post-reel-thumb">
    ${thumb ? `<img src="${escapeHtml(thumb)}" alt="Reel thumbnail">` : ''}
    <div class="post-reel-play">
      <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
    </div>
  </a>
</div>`;
  } else if (post.images && post.images.length > 0) {
    imagesHtml = `<div class="post-images">
  ${post.images.map(url => `<img src="${escapeHtml(url)}" alt="${escapeHtml(caption.slice(0, 80))}" loading="lazy">`).join('\n  ')}
</div>`;
  }

  const brandTagsHtml = (post.brandTags || []).map(b =>
    `<span class="post-brand-tag">${escapeHtml(b)}</span>`
  ).join(' ');

  const navHtmlStr = `<div class="post-nav">
  ${prevPost ? `<a href="../../posts/${prevPost.slug}/index.html">&larr; Previous</a>` : '<span></span>'}
  <a href="../../journal/index.html">All Posts</a>
  ${nextPost ? `<a href="../../posts/${nextPost.slug}/index.html">Next &rarr;</a>` : '<span></span>'}
</div>`;

  const igLinkHtml = post.instagramUrl ? `<a href="${escapeHtml(post.instagramUrl)}" target="_blank" rel="noopener" class="post-ig-link">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="5"/><circle cx="17.5" cy="6.5" r="1.5" fill="currentColor" stroke="none"/></svg>
  ${isReel ? 'Watch on Instagram' : 'View on Instagram'}
</a>` : '';

  const seoTitle = `${caption.slice(0, 60)} — Blink Ibiza & Formentera`;
  const seoDesc = caption.slice(0, 155).replace(/\n/g, ' ');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(seoTitle)}</title>
<meta name="description" content="${escapeHtml(seoDesc)}">
<meta property="og:title" content="${escapeHtml(seoTitle)}">
<meta property="og:description" content="${escapeHtml(seoDesc)}">
${post.images && post.images[0] ? `<meta property="og:image" content="${escapeHtml(post.images[0])}">` : ''}
<meta property="og:type" content="article">
<link rel="canonical" href="${SITE_URL}/posts/${post.slug}/">
${HEAD_FONTS}
<style>
${CSS_VARS}
${NAV_CSS}
${SINGLE_POST_CSS}
${FOOTER_CSS}
</style>
</head>
<body>
${navHtml('journal', '../..')}

<main class="post-hero">
  <div class="post-meta">
    <span class="post-date">${formatDate(post.publishedAt)}</span>
    ${post.location ? `<span class="post-location-tag">${escapeHtml(post.location)}</span>` : ''}
    ${brandTagsHtml}
  </div>

  ${imagesHtml}

  <div class="post-caption">${escapeHtml(caption)}</div>

  ${hashtags.length > 0 ? `<div class="post-hashtags">${hashtags.map(h => `<span>${escapeHtml(h)}</span>`).join(' ')}</div>` : ''}

  ${igLinkHtml}

  ${navHtmlStr}
</main>

${footerHtml('../..')}
</body>
</html>`;

  fs.writeFileSync(path.join(postDir, 'index.html'), html);
}

// ─── Build journal feed pages ────────────────────────────────────────────────

function buildJournalPages(posts) {
  const totalPages = Math.max(1, Math.ceil(posts.length / POSTS_PER_PAGE));

  for (let page = 1; page <= totalPages; page++) {
    const start = (page - 1) * POSTS_PER_PAGE;
    const pagePosts = posts.slice(start, start + POSTS_PER_PAGE);
    const isFirst = page === 1;
    const pageDir = isFirst ? path.join(DIST, 'journal') : path.join(DIST, 'journal', 'page', String(page));
    ensureDir(pageDir);

    // Base path relative to where this page sits
    const basePath = isFirst ? '..' : '../../..';

    const cardsHtml = pagePosts.map(p => postCardHtml(p, basePath)).join('\n');

    let paginationHtml = '';
    if (totalPages > 1) {
      const items = [];
      if (page > 1) {
        const prevHref = page === 2 ? '../journal/index.html' : `../journal/page/${page - 1}/index.html`;
        items.push(`<a href="${prevHref}">&larr; Newer</a>`);
      }
      for (let i = 1; i <= totalPages; i++) {
        const href = i === 1 ? '../journal/index.html' : `../journal/page/${i}/index.html`;
        if (i === page) {
          items.push(`<span class="current">${i}</span>`);
        } else {
          items.push(`<a href="${href}">${i}</a>`);
        }
      }
      if (page < totalPages) {
        items.push(`<a href="../journal/page/${page + 1}/index.html">Older &rarr;</a>`);
      }
      paginationHtml = `<div class="pagination">${items.join('\n')}</div>`;
    }

    const seoTitle = isFirst
      ? 'Journal — Blink Ibiza & Formentera'
      : `Journal — Page ${page} — Blink Ibiza & Formentera`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${seoTitle}</title>
<meta name="description" content="Stories from Blink — a concept store in Ibiza and Formentera curating slow fashion, natural fabrics, and island style.">
${page > 1 ? `<link rel="prev" href="${page === 2 ? '../journal/index.html' : `../journal/page/${page - 1}/index.html`}">` : ''}
${page < totalPages ? `<link rel="next" href="../journal/page/${page + 1}/index.html">` : ''}
<link rel="canonical" href="${SITE_URL}/journal/${isFirst ? '' : `page/${page}/`}">
${HEAD_FONTS}
<style>
${CSS_VARS}
${NAV_CSS}
${JOURNAL_CSS}
${FOOTER_CSS}

.journal-header {
  padding: 8rem 6rem 4rem;
  text-align: center;
}

.journal-header-label {
  font-size: 0.65rem;
  letter-spacing: 0.35em;
  text-transform: uppercase;
  color: var(--cyan);
  margin-bottom: 1rem;
}

.journal-header-title {
  font-family: "Cormorant Garamond", serif;
  font-size: clamp(2.2rem, 4vw, 3.5rem);
  font-weight: 300;
  font-style: italic;
  color: var(--dark);
}

.journal-body {
  padding: 0 6rem 4rem;
}

@media (max-width: 900px) {
  .journal-header { padding: 6rem 1.5rem 2rem; }
  .journal-body { padding: 0 1.5rem 2rem; }
}
</style>
</head>
<body>
${navHtml('journal', basePath)}

<header class="journal-header">
  <p class="journal-header-label">From the islands</p>
  <h1 class="journal-header-title">Journal</h1>
</header>

<main class="journal-body">
  ${posts.length === 0 ? '<p style="text-align:center;color:var(--mid);padding:4rem 0;">No posts yet. Check back soon.</p>' : `<div class="journal-grid">\n${cardsHtml}\n</div>`}
  ${paginationHtml}
</main>

${footerHtml(basePath)}
</body>
</html>`;

    fs.writeFileSync(path.join(pageDir, 'index.html'), html);
  }
}

// ─── Update main index.html (inject Journal nav link) ───────────────────────

function buildMainSite() {
  const srcPath = path.join(__dirname, 'index.html');
  if (!fs.existsSync(srcPath)) {
    console.warn('No index.html found — skipping main site copy.');
    return;
  }

  let html = fs.readFileSync(srcPath, 'utf8');

  // Inject Journal link into nav if not already present
  if (!html.includes('Journal</a>')) {
    html = html.replace(
      /<li><a href="#stores">Contact<\/a><\/li>/,
      '<li><a href="/journal/index.html">Journal</a></li>\n    <li><a href="#stores">Contact</a></li>'
    );
  }

  // Inject Journal link into footer if not already present
  if (!html.includes('journal') && html.includes('footer-links')) {
    html = html.replace(
      /<li><a href="#stores">Formentera<\/a><\/li>/,
      '<li><a href="#stores">Formentera</a></li>\n    <li><a href="/journal/index.html">Journal</a></li>'
    );
  }

  fs.writeFileSync(path.join(DIST, 'index.html'), html);
}

// ─── Generate sitemap.xml ───────────────────────────────────────────────────

function buildSitemap(posts) {
  const urls = [
    { loc: SITE_URL + '/', priority: '1.0' },
    { loc: SITE_URL + '/journal/', priority: '0.9' }
  ];

  for (const post of posts) {
    urls.push({
      loc: `${SITE_URL}/posts/${post.slug}/`,
      lastmod: post.publishedAt.split('T')[0],
      priority: '0.7'
    });
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    ${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), xml);
}

// ─── Generate robots.txt ─────────────────────────────────────────────────────

function buildRobots() {
  const txt = `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
  fs.writeFileSync(path.join(DIST, 'robots.txt'), txt);
}

// ─── Main build ──────────────────────────────────────────────────────────────

function build() {
  console.log('Building Blink website...');

  // Clean dist
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true, force: true });
  }
  ensureDir(DIST);

  // Copy assets directory recursively if it exists
  const assetsDir = path.join(__dirname, 'assets');
  if (fs.existsSync(assetsDir)) {
    copyDirRecursive(assetsDir, path.join(DIST, 'assets'));
  }

  const posts = loadPosts();
  console.log(`Found ${posts.length} posts`);

  // Build individual post pages
  for (let i = 0; i < posts.length; i++) {
    const prev = i > 0 ? posts[i - 1] : null;
    const next = i < posts.length - 1 ? posts[i + 1] : null;
    buildPostPage(posts[i], prev, next);
  }

  // Build journal feed pages
  buildJournalPages(posts);

  // Build main site (copy + inject nav)
  buildMainSite();

  // SEO files
  buildSitemap(posts);
  buildRobots();

  console.log(`Built: ${posts.length} post pages, ${Math.ceil(posts.length / POSTS_PER_PAGE)} journal pages, sitemap, robots.txt`);
  console.log('Done!');
}

build();
