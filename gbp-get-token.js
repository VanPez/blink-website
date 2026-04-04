#!/usr/bin/env node
/**
 * gbp-get-token.js — One-time helper to obtain a GBP refresh token.
 *
 * Run this ONCE on your laptop (not Umbrel) to get the refresh token.
 *
 * Usage:
 *   1. Set env vars: GBP_CLIENT_ID, GBP_CLIENT_SECRET
 *   2. Run: node gbp-get-token.js
 *   3. Open the URL it prints in your browser
 *   4. Sign in with the Google account that owns both GBP listings
 *   5. Copy the authorization code from the redirect URL
 *   6. Paste it when prompted
 *   7. Save the refresh_token it outputs — add it to your .env as GBP_REFRESH_TOKEN
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const CLIENT_ID = process.env.GBP_CLIENT_ID;
const CLIENT_SECRET = process.env.GBP_CLIENT_SECRET;
const REDIRECT_PORT = 8089;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/business.manage';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GBP_CLIENT_ID and GBP_CLIENT_SECRET environment variables first.');
  process.exit(1);
}

// Build the consent URL
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

console.log('\n=== Google Business Profile — Token Setup ===\n');
console.log('1. Open this URL in your browser:\n');
console.log(`   ${authUrl.toString()}\n`);
console.log('2. Sign in with the Google account that manages your GBP listings.');
console.log('3. Grant permission when prompted.\n');
console.log(`Waiting for callback on http://localhost:${REDIRECT_PORT}/callback ...\n`);

// Start a tiny local server to catch the OAuth redirect
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);

  if (reqUrl.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = reqUrl.searchParams.get('code');
  const error = reqUrl.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h2>Error: ${error}</h2><p>Try again.</p>`);
    console.error(`\nError from Google: ${error}`);
    server.close();
    return;
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h2>No authorization code received.</h2>');
    return;
  }

  // Exchange the code for tokens
  try {
    const tokens = await exchangeCode(code);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Success! You can close this tab.</h2><p>Check your terminal for the tokens.</p>');

    console.log('\n=== Tokens Received ===\n');
    console.log(`ACCESS_TOKEN:  ${tokens.access_token}`);
    console.log(`REFRESH_TOKEN: ${tokens.refresh_token || '(not returned — you may already have one)'}`);
    console.log(`EXPIRES_IN:    ${tokens.expires_in} seconds\n`);

    if (tokens.refresh_token) {
      console.log('Add this to your .env file on Umbrel:\n');
      console.log(`  GBP_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    } else {
      console.log('No refresh_token returned. This happens if you already granted access before.');
      console.log('To force a new refresh_token, revoke access at https://myaccount.google.com/permissions');
      console.log('then run this script again.\n');
    }

    // Also try to list accounts to find location IDs
    console.log('Fetching your GBP accounts and locations...\n');
    await listLocations(tokens.access_token);

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h2>Error exchanging code</h2><p>${err.message}</p>`);
    console.error('\nFailed to exchange code:', err.message);
  }

  server.close();
});

server.listen(REDIRECT_PORT);

// ─── Exchange authorization code for tokens ─────────────────────────────────

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      code: code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
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
            reject(new Error(`${res.statusCode}: ${parsed.error_description || body}`));
          }
        } catch (e) {
          reject(new Error(`Parse error: ${body.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── List GBP accounts and locations ────────────────────────────────────────

async function listLocations(accessToken) {
  try {
    // Step 1: List accounts
    const accounts = await apiGet(`https://mybusinessaccountmanagement.googleapis.com/v1/accounts`, accessToken);

    if (!accounts.accounts || accounts.accounts.length === 0) {
      console.log('No GBP accounts found for this Google account.');
      return;
    }

    for (const account of accounts.accounts) {
      console.log(`Account: ${account.name} (${account.accountName || 'unnamed'})`);

      // Step 2: List locations for each account
      try {
        const locations = await apiGet(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,storefrontAddress`,
          accessToken
        );

        if (locations.locations) {
          for (const loc of locations.locations) {
            const addr = loc.storefrontAddress;
            const addrStr = addr ? `${addr.addressLines?.[0] || ''}, ${addr.locality || ''}` : 'no address';
            console.log(`  Location: ${loc.name}`);
            console.log(`    Title: ${loc.title}`);
            console.log(`    Address: ${addrStr}`);
            console.log('');
          }
        } else {
          console.log('  No locations found for this account.\n');
        }
      } catch (err) {
        console.error(`  Error listing locations: ${err.message}\n`);
      }
    }

    console.log('Copy the location resource names (accounts/xxx/locations/yyy) to your .env:\n');
    console.log('  GBP_LOCATION_IBIZA=accounts/xxx/locations/yyy');
    console.log('  GBP_LOCATION_FORMENTERA=accounts/xxx/locations/zzz\n');

  } catch (err) {
    console.error(`Failed to list accounts: ${err.message}`);
    console.log('You can find your location IDs manually in the GBP dashboard URL.\n');
  }
}

function apiGet(url, accessToken) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'Blink-GBP-Setup'
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
            reject(new Error(`${res.statusCode}: ${parsed.error?.message || body.slice(0, 200)}`));
          }
        } catch (e) {
          reject(new Error(`Parse error: ${body.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}
