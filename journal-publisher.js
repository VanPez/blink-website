/**
 * journal-publisher.js — Publishes blog entries to GitHub after each Instagram post.
 *
 * Usage: require this module in blink-server-updated.js and call publishToJournal()
 * after a successful Instagram publish.
 *
 * Environment variables needed:
 *   GITHUB_TOKEN          — Personal access token (repo scope)
 *   GITHUB_REPO_OWNER     — e.g. "yourusername"
 *   GITHUB_REPO_NAME      — e.g. "blink-website"
 *   GITHUB_BRANCH         — e.g. "main" (default)
 */

const https = require('https');

const GITHUB_API = 'api.github.com';
const BRANCH = process.env.GITHUB_BRANCH || 'main';

// ─── Image download helper ───────────────────────────────────────────────────
// Instagram CDN URLs are signed with a short expiry (~5 days), so we mirror the
// bytes into the repo at publish time and reference local paths from the JSON.

function downloadImageBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'Blink-Journal' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImageBuffer(res.headers.location, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        // Drain the response so the socket can close
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching image`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── GitHub API helper ───────────────────────────────────────────────────────

function githubRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return reject(new Error('GITHUB_TOKEN not set'));

    const options = {
      hostname: GITHUB_API,
      path: apiPath,
      method: method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'Blink-Journal-Publisher',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`GitHub API ${res.statusCode}: ${parsed.message || data}`));
          }
        } catch (e) {
          reject(new Error(`GitHub API parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('GitHub API timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Slug generator ──────────────────────────────────────────────────────────

function makeSlug(caption, date) {
  const datePrefix = date.toISOString().split('T')[0]; // 2026-03-29
  const words = caption
    .replace(/#\w+/g, '')           // strip hashtags
    .replace(/[^a-zA-Z0-9\s]/g, '') // strip special chars
    .trim()
    .split(/\s+/)
    .slice(0, 6)                    // first 6 words
    .join('-')
    .toLowerCase();
  return `${datePrefix}-${words || 'post'}`;
}

// ─── Get Instagram media URLs from Graph API ─────────────────────────────────

async function getInstagramMediaUrls(instagramId, token) {
  // After publishing, we can fetch the actual IG CDN URLs via the Graph API
  // This gives us the permanent(ish) CDN links to hotlink from the blog
  try {
    const data = await new Promise((resolve, reject) => {
      const url = `https://graph.facebook.com/v19.0/${instagramId}?fields=media_url,thumbnail_url,media_type,permalink,children{media_url,media_type}&access_token=${token}`;
      https.get(url, { headers: { 'User-Agent': 'Blink-Journal' } }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });

    const result = { images: [], thumbnailUrl: null, mediaType: data.media_type, permalink: data.permalink || null };

    if (data.media_type === 'VIDEO') {
      result.thumbnailUrl = data.thumbnail_url || null;
    } else if (data.media_type === 'CAROUSEL_ALBUM' && data.children) {
      result.images = data.children.data
        .filter(c => c.media_type === 'IMAGE')
        .map(c => c.media_url);
    } else {
      result.images = data.media_url ? [data.media_url] : [];
    }

    return result;
  } catch (err) {
    console.error('[Journal] Failed to fetch IG media URLs:', err.message);
    return { images: [], thumbnailUrl: null, mediaType: 'IMAGE' };
  }
}

// ─── Main publish function ───────────────────────────────────────────────────

/**
 * Publishes a blog post to GitHub, triggering a Netlify rebuild.
 *
 * @param {Object} opts
 * @param {string} opts.caption      — The full Instagram caption
 * @param {string} opts.postType     — 'single', 'carousel', or 'video'
 * @param {string} opts.instagramId  — The IG media ID (used to fetch CDN URLs)
 * @param {string} opts.location     — 'Ibiza' or 'Formentera' (optional)
 * @param {string[]} opts.brandTags  — Brand names mentioned (optional)
 * @param {string} opts.generator    — 'claude' or 'grok' (optional)
 */
async function publishToJournal(opts) {
  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_REPO_NAME;
  const token = process.env.META_ACCESS_TOKEN;

  if (!owner || !repo) {
    console.log('[Journal] GitHub repo not configured — skipping blog publish');
    return;
  }

  if (!process.env.GITHUB_TOKEN) {
    console.log('[Journal] GITHUB_TOKEN not set — skipping blog publish');
    return;
  }

  try {
    const now = new Date();
    const slug = makeSlug(opts.caption, now);

    // Fetch actual IG CDN URLs and permalink for the published post
    let images = [];
    let thumbnailUrl = null;
    let instagramUrl = null;

    if (opts.instagramId && token) {
      console.log(`[Journal] Fetching IG media URLs for ${opts.instagramId}...`);
      const media = await getInstagramMediaUrls(opts.instagramId, token);
      images = media.images;
      thumbnailUrl = media.thumbnailUrl;
      instagramUrl = media.permalink || null;
    }

    // Mirror images into the repo so we don't depend on Instagram's signed URLs
    // (which expire after ~5 days). Each image is committed separately to the
    // repo at journal-images/<slug>/<i>.jpg, then we reference local paths.
    const localImages = [];
    for (let i = 0; i < images.length; i++) {
      const remoteUrl = images[i];
      const repoPath = `journal-images/${slug}/${i}.jpg`;
      try {
        const buf = await downloadImageBuffer(remoteUrl);
        await githubRequest('PUT', `/repos/${owner}/${repo}/contents/${repoPath}`, {
          message: `Add journal image: ${slug}/${i}.jpg`,
          content: buf.toString('base64'),
          branch: BRANCH
        });
        console.log(`[Journal] ✅ Stored ${repoPath} (${buf.length} bytes)`);
        localImages.push(`/${repoPath}`);
      } catch (err) {
        console.error(`[Journal] ⚠️  Failed to mirror image ${i} (${err.message}); keeping remote URL as fallback`);
        localImages.push(remoteUrl);
      }
    }

    let localThumbnailUrl = null;
    if (thumbnailUrl) {
      const repoPath = `journal-images/${slug}/thumb.jpg`;
      try {
        const buf = await downloadImageBuffer(thumbnailUrl);
        await githubRequest('PUT', `/repos/${owner}/${repo}/contents/${repoPath}`, {
          message: `Add journal thumbnail: ${slug}/thumb.jpg`,
          content: buf.toString('base64'),
          branch: BRANCH
        });
        console.log(`[Journal] ✅ Stored ${repoPath} (${buf.length} bytes)`);
        localThumbnailUrl = `/${repoPath}`;
      } catch (err) {
        console.error(`[Journal] ⚠️  Failed to mirror thumbnail (${err.message}); keeping remote URL as fallback`);
        localThumbnailUrl = thumbnailUrl;
      }
    }

    // Create the post JSON file
    const postData = {
      id: opts.instagramId || `local-${Date.now()}`,
      slug: slug,
      publishedAt: now.toISOString(),
      postType: opts.postType || 'single',
      caption: opts.caption,
      images: localImages,
      thumbnailUrl: localThumbnailUrl,
      instagramId: opts.instagramId || null,
      instagramUrl: instagramUrl,
      location: opts.location || null,
      brandTags: opts.brandTags || [],
      generator: opts.generator || 'claude'
    };

    const filePath = `data/posts/${slug}.json`;
    const content = Buffer.from(JSON.stringify(postData, null, 2)).toString('base64');

    // Commit the JSON last so the post only "appears" once its images are in place
    console.log(`[Journal] Committing ${filePath} to ${owner}/${repo}...`);

    await githubRequest('PUT', `/repos/${owner}/${repo}/contents/${filePath}`, {
      message: `New post: ${slug}`,
      content: content,
      branch: BRANCH
    });

    console.log(`[Journal] ✅ Blog post published: ${slug}`);
    console.log(`[Journal] Netlify will auto-rebuild and deploy.`);

    return { success: true, slug, filePath };

  } catch (err) {
    // Journal publishing should never block the main Instagram flow
    console.error(`[Journal] ❌ Failed to publish blog post: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { publishToJournal };
