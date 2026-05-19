#!/usr/bin/env node
/**
 * One-shot migration: pull every existing journal post's image into the repo
 * so we no longer depend on Instagram's short-lived signed CDN URLs.
 *
 * For each JSON in data/posts/:
 *   1. Re-fetch fresh media URLs from the Graph API using post.instagramId
 *      (the IG ID is permanent — only the signed URLs expire).
 *   2. Download each image / thumbnail to journal-images/<slug>/.
 *   3. Rewrite the JSON so .images and .thumbnailUrl point at the local paths
 *      (e.g. "/journal-images/<slug>/0.jpg").
 *
 * Idempotent: skips posts whose images already live under /journal-images/.
 *
 * Usage:
 *   META_ACCESS_TOKEN=<token> node scripts/migrate-journal-images.js
 *
 * After it finishes:
 *   git add data/posts journal-images
 *   git commit -m "Backfill journal images locally (no more IG CDN expiry)"
 *   git push origin main
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const META_TOKEN = process.env.META_ACCESS_TOKEN;
if (!META_TOKEN) {
  console.error('ERROR: set META_ACCESS_TOKEN env var (the long-lived Instagram Graph API token).');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const POSTS_DIR = path.join(ROOT, 'data', 'posts');
const IMAGES_DIR = path.join(ROOT, 'journal-images');

// ─── HTTP helpers ────────────────────────────────────────────────────────────

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https
      .get(url, { headers: { 'User-Agent': 'Blink-Migrate' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return httpGet(res.headers.location, redirects + 1).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks),
          })
        );
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function getInstagramMediaUrls(instagramId) {
  const url =
    `https://graph.facebook.com/v19.0/${instagramId}` +
    `?fields=media_url,thumbnail_url,media_type,permalink,children{media_url,media_type}` +
    `&access_token=${META_TOKEN}`;
  const res = await httpGet(url);
  if (res.statusCode !== 200) {
    throw new Error(`Graph API ${res.statusCode}: ${res.body.toString('utf8').slice(0, 200)}`);
  }
  const data = JSON.parse(res.body.toString('utf8'));
  const result = { images: [], thumbnailUrl: null, mediaType: data.media_type, permalink: data.permalink || null };

  if (data.media_type === 'VIDEO') {
    result.thumbnailUrl = data.thumbnail_url || null;
  } else if (data.media_type === 'CAROUSEL_ALBUM' && data.children && data.children.data) {
    result.images = data.children.data
      .filter((c) => c.media_type === 'IMAGE')
      .map((c) => c.media_url)
      .filter(Boolean);
  } else if (data.media_url) {
    result.images = [data.media_url];
  }
  return result;
}

// ─── Per-post migration ──────────────────────────────────────────────────────

function isAlreadyLocal(post) {
  const imagesLocal =
    Array.isArray(post.images) &&
    post.images.length > 0 &&
    post.images.every((u) => typeof u === 'string' && u.startsWith('/journal-images/'));
  const thumbOk =
    !post.thumbnailUrl ||
    (typeof post.thumbnailUrl === 'string' && post.thumbnailUrl.startsWith('/journal-images/'));
  // Posts with no images and no thumb (e.g. those weird zero-image rows) — count them as "done"
  if ((!post.images || post.images.length === 0) && !post.thumbnailUrl) return true;
  return imagesLocal && thumbOk;
}

async function migratePost(filePath) {
  const post = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const slug = post.slug;

  if (isAlreadyLocal(post)) {
    return { slug, status: 'skip', reason: 'already-local' };
  }
  if (!post.instagramId) {
    return { slug, status: 'skip', reason: 'no-instagramId' };
  }

  let media;
  try {
    media = await getInstagramMediaUrls(post.instagramId);
  } catch (err) {
    return { slug, status: 'fail', reason: `graph-api: ${err.message}` };
  }

  const postDir = path.join(IMAGES_DIR, slug);
  fs.mkdirSync(postDir, { recursive: true });

  const localImages = [];
  for (let i = 0; i < media.images.length; i++) {
    const res = await httpGet(media.images[i]);
    if (res.statusCode !== 200) {
      return { slug, status: 'fail', reason: `image ${i} HTTP ${res.statusCode}` };
    }
    const fname = `${i}.jpg`;
    fs.writeFileSync(path.join(postDir, fname), res.body);
    localImages.push(`/journal-images/${slug}/${fname}`);
    process.stdout.write(`  → ${fname} (${(res.body.length / 1024).toFixed(0)}KB)\n`);
  }

  let localThumb = null;
  if (media.thumbnailUrl) {
    const res = await httpGet(media.thumbnailUrl);
    if (res.statusCode !== 200) {
      return { slug, status: 'fail', reason: `thumb HTTP ${res.statusCode}` };
    }
    fs.writeFileSync(path.join(postDir, 'thumb.jpg'), res.body);
    localThumb = `/journal-images/${slug}/thumb.jpg`;
    process.stdout.write(`  → thumb.jpg (${(res.body.length / 1024).toFixed(0)}KB)\n`);
  }

  // If Graph API returned absolutely nothing usable, don't mangle the JSON
  if (localImages.length === 0 && !localThumb) {
    return { slug, status: 'fail', reason: 'graph-api returned no media' };
  }

  post.images = localImages;
  post.thumbnailUrl = localThumb;
  // Keep the Graph permalink fresh while we're at it (only if we have one)
  if (media.permalink) post.instagramUrl = media.permalink;

  fs.writeFileSync(filePath, JSON.stringify(post, null, 2));
  return { slug, status: 'ok', count: localImages.length + (localThumb ? 1 : 0) };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.error(`No posts dir at ${POSTS_DIR}`);
    process.exit(1);
  }
  fs.mkdirSync(IMAGES_DIR, { recursive: true });

  const files = fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  console.log(`Migrating ${files.length} posts → ${path.relative(ROOT, IMAGES_DIR)}/\n`);

  const results = { ok: [], skip: [], fail: [] };

  for (const file of files) {
    const filePath = path.join(POSTS_DIR, file);
    const slug = file.replace(/\.json$/, '');
    process.stdout.write(`[${slug}]\n`);
    try {
      const r = await migratePost(filePath);
      results[r.status].push(r);
      const tag = r.status === 'ok' ? '  ✅' : r.status === 'skip' ? '  ⤵️ ' : '  ❌';
      const detail = r.status === 'ok' ? `${r.count} file(s)` : r.reason;
      console.log(`${tag} ${r.status.toUpperCase()} — ${detail}\n`);
    } catch (err) {
      results.fail.push({ slug, reason: err.message });
      console.log(`  ❌ FAIL — ${err.message}\n`);
    }
  }

  console.log('─'.repeat(60));
  console.log(`Done. ok=${results.ok.length}  skipped=${results.skip.length}  failed=${results.fail.length}`);
  if (results.fail.length) {
    console.log('\nFailures:');
    for (const r of results.fail) console.log(`  • ${r.slug}: ${r.reason}`);
  }
  if (results.skip.length) {
    console.log('\nSkipped:');
    for (const r of results.skip) console.log(`  • ${r.slug}: ${r.reason}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
