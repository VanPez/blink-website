/**
 * gbp-publisher.js — Publishes Google Business Profile posts after each Instagram post.
 *
 * Usage: require this module in blink-server-updated.js and call publishToGBP()
 * after a successful Instagram publish (same pattern as journal-publisher.js).
 *
 * Environment variables needed:
 *   GBP_CLIENT_ID         — Google OAuth2 client ID
 *   GBP_CLIENT_SECRET     — Google OAuth2 client secret
 *   GBP_REFRESH_TOKEN     — Long-lived refresh token (obtained during one-time setup)
 *   GBP_LOCATION_IBIZA    — Location resource name, e.g. "accounts/123/locations/456"
 *   GBP_LOCATION_FORMENTERA — Location resource name for Formentera
 */

const https = require('https');

const GBP_API_HOST = 'mybusiness.googleapis.com';
const OAUTH_HOST = 'oauth2.googleapis.com';

// ─── OAuth2 token management ────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Gets a valid access token, refreshing if needed.
 * Caches the token in memory so we don't refresh on every call.
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const clientId = process.env.GBP_CLIENT_ID;
  const clientSecret = process.env.GBP_CLIENT_SECRET;
  const refreshToken = process.env.GBP_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('GBP OAuth2 credentials not configured');
  }

  const postData = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  }).toString();

  const data = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: OAUTH_HOST,
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`OAuth2 token refresh ${res.statusCode}: ${parsed.error_description || body}`));
          }
        } catch (e) {
          reject(new Error(`OAuth2 parse error: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('OAuth2 token refresh timeout'));
    });

    req.write(postData);
    req.end();
  });

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

// ─── GBP API helper ─────────────────────────────────────────────────────────

async function gbpRequest(method, apiPath, body) {
  const token = await getAccessToken();

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: GBP_API_HOST,
      path: `/v4/${apiPath}`,
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Blink-GBP-Publisher'
      }
    };

    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(`GBP API ${res.statusCode}: ${parsed.error?.message || data.slice(0, 300)}`));
          }
        } catch (e) {
          reject(new Error(`GBP API parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('GBP API request timeout'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Create a single GBP post ───────────────────────────────────────────────

async function createLocalPost(locationName, { summary, imageUrl, blogUrl }) {
  const postBody = {
    languageCode: 'en',
    summary: summary,
    topicType: 'STANDARD'
  };

  // Attach image if available
  if (imageUrl) {
    postBody.media = [{
      mediaFormat: 'PHOTO',
      sourceUrl: imageUrl
    }];
  }

  // Add "Learn more" CTA linking to the blog post
  if (blogUrl) {
    postBody.callToAction = {
      actionType: 'LEARN_MORE',
      url: blogUrl
    };
  }

  return gbpRequest('POST', `${locationName}/localPosts`, postBody);
}

// ─── Truncate caption for GBP (1500 char limit) ─────────────────────────────

function truncateForGBP(caption, maxLength = 1500) {
  // Strip Instagram hashtags (they look spammy on GBP)
  let cleaned = caption.replace(/#\w+/g, '').replace(/\s{2,}/g, ' ').trim();

  if (cleaned.length <= maxLength) return cleaned;

  // Truncate at last complete sentence or word boundary
  const truncated = cleaned.slice(0, maxLength - 3);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastPeriod > maxLength * 0.6) {
    return truncated.slice(0, lastPeriod + 1);
  }
  return truncated.slice(0, lastSpace) + '...';
}

// ─── Build blog URL from slug ────────────────────────────────────────────────

function buildBlogUrl(slug) {
  return `https://blinkformentera.com/posts/${slug}/`;
}

// ─── Main publish function ──────────────────────────────────────────────────

/**
 * Publishes a "What's New" post to both GBP locations.
 *
 * @param {Object} opts
 * @param {string} opts.caption      — The full Instagram caption
 * @param {string} opts.imageUrl     — Direct URL to the post image (IG CDN or server URL)
 * @param {string} opts.slug         — Blog post slug (for building the "Learn more" URL)
 * @param {string} opts.postType     — 'single', 'carousel', or 'video'
 * @returns {Object} { success, results: [{location, success, error?}] }
 */
async function publishToGBP(opts) {
  const locationIbiza = process.env.GBP_LOCATION_IBIZA;
  const locationFormentera = process.env.GBP_LOCATION_FORMENTERA;

  if (!locationIbiza && !locationFormentera) {
    console.log('[GBP] No GBP locations configured — skipping');
    return { success: false, error: 'No locations configured' };
  }

  if (!process.env.GBP_CLIENT_ID || !process.env.GBP_REFRESH_TOKEN) {
    console.log('[GBP] OAuth2 credentials not set — skipping');
    return { success: false, error: 'OAuth2 not configured' };
  }

  const summary = truncateForGBP(opts.caption);
  const blogUrl = opts.slug ? buildBlogUrl(opts.slug) : null;

  // For carousels, use the first image; for videos, skip image (GBP only supports photos)
  let imageUrl = null;
  if (opts.postType !== 'video' && opts.imageUrl) {
    imageUrl = opts.imageUrl;
  }

  const locations = [];
  if (locationIbiza) locations.push({ name: locationIbiza, label: 'Ibiza' });
  if (locationFormentera) locations.push({ name: locationFormentera, label: 'Formentera' });

  const results = [];

  for (const loc of locations) {
    try {
      console.log(`[GBP] Publishing to ${loc.label}...`);
      await createLocalPost(loc.name, { summary, imageUrl, blogUrl });
      console.log(`[GBP] ✅ Posted to ${loc.label}`);
      results.push({ location: loc.label, success: true });
    } catch (err) {
      console.error(`[GBP] ❌ Failed for ${loc.label}: ${err.message}`);
      results.push({ location: loc.label, success: false, error: err.message });
    }
  }

  const anySuccess = results.some(r => r.success);
  return { success: anySuccess, results };
}

module.exports = { publishToGBP };
