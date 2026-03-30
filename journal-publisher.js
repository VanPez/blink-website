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

    // Create the post JSON file
    const postData = {
      id: opts.instagramId || `local-${Date.now()}`,
      slug: slug,
      publishedAt: now.toISOString(),
      postType: opts.postType || 'single',
      caption: opts.caption,
      images: images,
      thumbnailUrl: thumbnailUrl,
      instagramId: opts.instagramId || null,
      instagramUrl: instagramUrl,
      location: opts.location || null,
      brandTags: opts.brandTags || [],
      generator: opts.generator || 'claude'
    };

    const filePath = `data/posts/${slug}.json`;
    const content = Buffer.from(JSON.stringify(postData, null, 2)).toString('base64');

    // Commit the file to GitHub
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
