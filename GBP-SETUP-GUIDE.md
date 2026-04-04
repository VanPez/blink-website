# Google Business Profile Auto-Posting — Setup Guide

This guide walks you through setting up automatic GBP posts for Blink Ibiza and Blink Formentera. After setup, every Instagram post will also appear as a "What's New" update on both Google Business Profile listings.

---

## How It Works

After each Instagram post succeeds, the pipeline now does three things:

1. **Journal** (existing) — commits a blog post to GitHub, Netlify rebuilds the site
2. **GBP** (new) — posts a "What's New" update to both store listings with the same caption, image, and a "Learn more" link to the blog post

The new `gbp-publisher.js` module follows the exact same pattern as `journal-publisher.js`: non-blocking, fire-and-forget, errors never block the Instagram flow.

---

## Part 1: Apply for GBP API Access (one-time, ~2 weeks)

Google requires you to apply for API access before you can create posts programmatically.

1. Go to **Google Cloud Console**: https://console.cloud.google.com/
2. Sign in with the Google account that **owns both GBP listings** (Blink Ibiza + Blink Formentera)
3. Create a new project (or use an existing one):
   - Click the project dropdown at the top → "New Project"
   - Name it something like `blink-gbp-posting`
   - Click "Create"
4. Apply for GBP API access:
   - Go to https://support.google.com/business/workflow/16726127
   - Select **"Application for Basic API Access"** from the dropdown
   - Fill in the form using your business email (the one tied to your GBP listings)
   - For "What will you use the API for?", say something like: *"Automated posting of store updates to our two retail locations after publishing to Instagram. We operate two boutique stores and want to keep our GBP listings updated with our latest arrivals and events."*
5. Wait for approval email (typically 1-2 weeks)
6. Check approval status: Go to Google Cloud Console → APIs & Services → Quotas. If you see 300 QPM for Business Profile APIs, you're approved.

---

## Part 2: Enable APIs and Create OAuth Credentials

Once approved:

### Enable the required APIs

In Google Cloud Console → APIs & Services → Library, search for and enable each of these:

- **My Business Account Management API**
- **My Business Business Information API**
- **Google My Business API** (this is the one with localPosts)

### Create OAuth2 credentials

1. Go to **APIs & Services → Credentials**
2. Click **"Create Credentials" → "OAuth client ID"**
3. If prompted, configure the OAuth consent screen first:
   - User Type: **External** (unless you have Google Workspace, then Internal)
   - App name: `Blink GBP Publisher`
   - Support email: your email
   - Scopes: add `https://www.googleapis.com/auth/business.manage`
   - Test users: add the Google account email that owns your GBP listings
   - Save
4. Back to Credentials → Create OAuth client ID:
   - Application type: **Web application**
   - Name: `Blink GBP Publisher`
   - Authorized redirect URIs: add `http://localhost:8089/callback`
   - Click "Create"
5. **Copy the Client ID and Client Secret** — you'll need them next

---

## Part 3: Get Your Refresh Token (one-time, on your Mac)

The `gbp-get-token.js` helper script handles the OAuth dance for you. Run this on your Mac (not Umbrel), since it opens a browser.

```bash
cd ~/Documents/Claude/blink-website

# Set your credentials temporarily
export GBP_CLIENT_ID="your-client-id-here.apps.googleusercontent.com"
export GBP_CLIENT_SECRET="your-client-secret-here"

# Run the token helper
node gbp-get-token.js
```

What happens:
1. The script prints a URL — open it in your browser
2. Sign in with the Google account that owns both GBP listings
3. Grant permission when prompted
4. Your browser redirects to localhost — the script catches it
5. The script prints your **refresh token** and your **location IDs**

Save the output — you need the refresh token and both location resource names (they look like `accounts/123456789/locations/987654321`).

If the script can't list locations automatically, you can find your location IDs in the GBP dashboard URL when you click on each store.

---

## Part 4: Add Environment Variables on Umbrel

SSH into your Umbrel server and edit the Blink agent's `.env` file:

```bash
ssh umbrel@100.88.95.57
nano /home/umbrel/blink-agent/.env
```

Add these lines (keep all existing vars):

```env
# Google Business Profile
GBP_CLIENT_ID=your-client-id.apps.googleusercontent.com
GBP_CLIENT_SECRET=your-client-secret
GBP_REFRESH_TOKEN=1//your-refresh-token-here
GBP_LOCATION_IBIZA=accounts/XXXXX/locations/YYYYY
GBP_LOCATION_FORMENTERA=accounts/XXXXX/locations/ZZZZZ
```

---

## Part 5: Deploy the Module

1. Copy `gbp-publisher.js` to the Blink agent directory on Umbrel:

```bash
# From your Mac
scp ~/Documents/Claude/blink-website/gbp-publisher.js umbrel@100.88.95.57:/home/umbrel/blink-agent/
```

2. SSH in and edit `server.js` to wire it up:

```bash
ssh umbrel@100.88.95.57
nano /home/umbrel/blink-agent/server.js
```

Add the require at the top (near the other requires):
```javascript
const { publishToGBP } = require('./gbp-publisher');
```

Find the line that says `console.log('✅ Posted to Instagram...')` (around line 443) and add the GBP call right after the journal publish call:

```javascript
// After the existing publishToJournal() call, add:
publishToGBP({
  caption: post.caption,
  imageUrl: images[0] || null,  // first image URL from the IG post
  slug: journalSlug || null,     // from the journal publish result
  postType: postType
}).catch(err => console.error('[GBP] Uncaught error:', err.message));
```

3. Restart the Docker container:

```bash
cd /home/umbrel/blink-agent
docker compose down && docker compose up -d
```

4. Check logs to confirm it loaded without errors:

```bash
docker compose logs -f --tail=50
```

---

## Part 6: Test It

Before going live, verify the GBP posting works:

1. Create a test Instagram post through the Blink agent as normal
2. Watch the Docker logs for `[GBP]` prefixed messages
3. Check both GBP listings in Google Maps / Google Search to confirm the posts appeared
4. Verify the "Learn more" button links to the correct blog post URL

If you see `[GBP] ✅ Posted to Ibiza` and `[GBP] ✅ Posted to Formentera` in the logs, you're good.

---

## Troubleshooting

**"GBP OAuth2 credentials not configured"** — One or more of `GBP_CLIENT_ID`, `GBP_CLIENT_SECRET`, `GBP_REFRESH_TOKEN` is missing from `.env`

**"OAuth2 token refresh 401: invalid_grant"** — Your refresh token expired or was revoked. Run `gbp-get-token.js` again on your Mac to get a new one.

**"GBP API 403"** — Either your API access hasn't been approved yet, or the Google account doesn't have owner/manager access to the GBP listings.

**"GBP API 404"** — The location resource name is wrong. Double-check `GBP_LOCATION_IBIZA` and `GBP_LOCATION_FORMENTERA` values.

**Posts appear on one location but not the other** — Each location is posted independently. Check the logs for which one failed and why.

**No image on the GBP post** — The Instagram CDN URL may have expired by the time GBP tries to fetch it. This is non-critical; the post still publishes with text only.

---

## OAuth Consent Screen: Moving to Production

While testing, your app is in "Testing" mode (limited to test users you added). Since only your own Google account uses it, this is fine permanently. But if you want to remove the "unverified app" warning:

1. Google Cloud Console → APIs & Services → OAuth consent screen
2. Click "Publish App"
3. Since you're only accessing your own data, no verification review is needed
