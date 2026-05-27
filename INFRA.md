# BLiNK — Project Infrastructure

Last updated: May 27, 2026

BLiNK is a concept store in Ibiza and Formentera, curating slow fashion, natural fabrics, and island style. This document covers the public website (`blinkformentera.com`), the Instagram publishing agent, and the surrounding tooling.

For shared infrastructure (Cloudflare account, GitHub org, Umbrel server, secrets policy) see `~/Documents/CLAUDE/INFRA.md`.

---

## 1. At a glance

| Layer | What | Where |
|---|---|---|
| Public website | `blinkformentera.com` | Cloudflare Pages (project `blink-website`) |
| Media subdomain | `media.blinkformentera.com` | `SERVER_URL` in the agent env — purpose to confirm (see § 12) |
| Repository | `VanPez/blink-website` (private) | GitHub |
| Build | `build.js` (Node, no deps) | Runs on Cloudflare Pages auto-deploy from `main` |
| E-commerce | Snipcart overlay | Webhook at `functions/api/snipcart-webhook.js` |
| Instagram + GBP publishing | `blink-instagram-agent` Docker container | Umbrel: `/home/umbrel/blink-agent/`, port 3000 |
| Inventory | KV namespace `INVENTORY` | Cloudflare Pages binding (set in CF dashboard, not `wrangler.toml`) |
| Physical stores | Ibiza, Formentera | GBP location IDs in agent env |

---

## 2. Domain & DNS

- `blinkformentera.com` — primary site, Cloudflare zone, Cloudflare Pages auto-deploy from `main`.
- `media.blinkformentera.com` — set as `SERVER_URL` in the Instagram agent. Purpose unconfirmed (likely serves staged media before commit). Tracked in § 12.
- Registrar: see shared INFRA.md § 2 ("check Cloudflare zone for current registrar").

---

## 3. Repository layout

| Path | Purpose |
|---|---|
| `index.html` | Single-file source for the home page (~2 MB, all CSS + JS inline) |
| `privacy.html` | Standalone Privacy & Legal Notice page, copied verbatim to `dist/privacy.html` by `build.js` (see § 9) |
| `build.js` | Reads `data/posts/*.json`, generates `dist/` (home, journal feed, per-post pages, sitemap, robots, redirects, headers) |
| `data/posts/<slug>.json` | One JSON per journal post (id, slug, publishedAt, caption, images, postType, location, brandTags, generator) |
| `journal-images/<slug>/*.jpg` | Locally-mirrored Instagram images (see § 6) |
| `icons/` | Favicons, apple-touch-icon, PWA icons, `manifest.webmanifest` — copied to `dist/` root by `build.js` |
| `assets/` | Logo, shop product photos, brand imagery |
| `functions/api/` | Cloudflare Pages Functions (`snipcart-webhook.js`, `stock.js`) |
| `scripts/migrate-journal-images.js` | One-shot backfill for posts with expired IG CDN URLs |
| `journal-publisher.js` | Module used by the Instagram agent. **Source of truth lives in this repo; a copy is `scp`d to Umbrel at `/home/umbrel/blink-agent/journal-publisher.js`.** Not symlinked — must be synced manually. |
| `gbp-publisher.js`, `gbp-get-token.js` | Google Business Profile publishing + OAuth refresh-token bootstrap |

---

## 4. Build & deploy

Cloudflare Pages auto-builds on push to `main`. Build command runs `node build.js` (no install step — zero deps). Output: `dist/`.

```bash
# Edit and deploy
cd ~/Documents/CLAUDE/blink-website
# ...changes...
node build.js                 # optional local sanity build
git add . && git commit -m "..." && git push origin main
```

No build-time secrets are required — the publishing tokens (`META_ACCESS_TOKEN`, `GITHUB_TOKEN`, etc.) live on Umbrel inside the agent container, not in CI.

---

## 5. Instagram + GBP publishing pipeline

End-to-end flow run by the `blink-instagram-agent` Docker container on Umbrel:

1. Generates copy + selects images (xAI Grok or Anthropic Claude — `generator` field in the post JSON records which).
2. Posts to Instagram via Meta Graph API (`META_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID=17841402068412035`, `FB_PAGE_ID=231165690232555`).
3. Mirrors to Google Business Profile via Google OAuth (`GBP_REFRESH_TOKEN`). Locations:
   - Ibiza: `accounts/118213970870134866386/locations/8378450892476062175`
   - Formentera: `accounts/118213970870134866386/locations/13740599725654011078`
4. Downloads each image, commits to `journal-images/<slug>/<i>.jpg` in the repo (via GitHub API using `GITHUB_TOKEN`).
5. Commits `data/posts/<slug>.json` last so the post only appears once images are present.
6. Cloudflare Pages auto-rebuilds.

Full env-var inventory and rebuild procedure: shared INFRA.md § 5.

---

## 6. Journal image mirroring (May 2026)

**Problem.** Instagram CDN URLs are signed with a ~5-day expiry (`oe=<unix_ts_hex>` param). Hot-linking them means images go 403 after ~5 days. Pre-May 2026, the journal cards went broken for everything older than the last ~3 posts.

**Solution.** The publisher downloads image bytes at publish time and commits them to the repo at `journal-images/<slug>/<i>.jpg`. The post JSON stores root-absolute paths like `/journal-images/<slug>/0.jpg`. `build.js` copies `journal-images/` to `dist/`. Cards now have a permanent local source.

**Backfill an old post (or batch).** Re-fetch fresh URLs from the Graph API (the IG media ID is permanent, only the signed URLs expire):
```bash
META_ACCESS_TOKEN='<token>' node scripts/migrate-journal-images.js
```
Idempotent — skips posts whose images already point at `/journal-images/`. Posts whose `instagramId` no longer resolves on Meta will FAIL — delete the JSON manually if you don't want a broken card.

**Size sanity.** ~150–300 KB per IG-served JPEG. At current cadence (~4 posts/week × ~1.5 images), the repo grows ~1 MB/week, ~50 MB/year. Comfortable for both GitHub and Cloudflare Pages.

---

## 7. Brand assets

### Master logo
- `assets/blink-logo.jpg` (and `.png` mirror) — 2000×1010 — "BLiNk" wordmark in `#3a3a3a` + cyan dot in `#38BCD4` + "IBIZA & FORMENTERA" subtitle.

### Favicon / PWA icon set
| File | Purpose | Source crop |
|---|---|---|
| `icons/favicon.ico` | Legacy browser tab (multi-resolution 16+32+48) | wordmark crop |
| `icons/favicon-{16,32,48}.png` | Browser tab at 1x / 2x / Windows tile | wordmark crop (subtitle illegible below 180px) |
| `icons/apple-touch-icon.png` (180×180) | iOS "Add to Home Screen" | full logo |
| `icons/icon-192.png` | Android home screen | full logo, 80% safe-zone for maskable |
| `icons/icon-512.png` | PWA splash, Android adaptive | full logo, 80% safe-zone for maskable |
| `icons/manifest.webmanifest` | PWA metadata (`theme_color: #38BCD4`, `display: standalone`) | — |

`build.js` flattens `icons/` to `dist/` root so browsers find `/favicon.ico`, `/apple-touch-icon.png`, `/manifest.webmanifest` without needing HTML refs (though the link tags are also present in every page head).

### Regenerating the icon set

If the master logo changes, regenerate from the JPG (ImageMagick required):

```bash
cd ~/Documents/CLAUDE/blink-website
SRC=assets/blink-logo.jpg

# 1. Trim outer white border to get true content bbox
convert "$SRC" -trim +repage /tmp/blink-trimmed.png

# 2. Crop just the wordmark (drop the subtitle) — top 85% is a safe heuristic.
#    Verify visually if the logo proportions change.
convert /tmp/blink-trimmed.png -gravity north -crop 100x85%+0+0 +repage /tmp/blink-wordmark.png

# 3. Small icons (wordmark only, padded square)
for sz in 16 32 48; do
  convert /tmp/blink-wordmark.png -resize ${sz}x${sz} \
    -background white -gravity center -extent ${sz}x${sz} -strip icons/favicon-${sz}.png
done

# 4. apple-touch-icon (full logo)
convert /tmp/blink-trimmed.png -resize 180x180 \
  -background white -gravity center -extent 180x180 -strip icons/apple-touch-icon.png

# 5. PWA icons (full logo with 80% maskable safe zone)
for sz in 192 512; do
  inner=$((sz * 80 / 100))
  convert /tmp/blink-trimmed.png -resize ${inner}x${inner} \
    -background white -gravity center -extent ${sz}x${sz} -strip icons/icon-${sz}.png
done

# 6. Multi-resolution .ico
convert icons/favicon-16.png icons/favicon-32.png icons/favicon-48.png icons/favicon.ico
```

### Brand colors

| Name | Hex | Use |
|---|---|---|
| Cyan | `#38BCD4` | Accent, links, PWA theme color |
| Dark | `#3a3a3a` | Primary text, logo wordmark |
| Mid | `#6b6b6b` | Secondary text |
| Light | `#f5f3ef` | Section backgrounds |
| Border | `#e0ddd8` | Dividers |

---

## 8. E-commerce — Snipcart

Snipcart overlays the cart/checkout UI. Loaded inline in `index.html`:
```html
<link rel="stylesheet" href="https://cdn.snipcart.com/themes/v3.7.1/default/snipcart.css">
<script async src="https://cdn.snipcart.com/themes/v3.7.1/default/snipcart.js"></script>
```
- Order webhook: `functions/api/snipcart-webhook.js` (Cloudflare Pages Function)
- Stock management: `functions/api/stock.js`, backed by Cloudflare KV namespace `INVENTORY` (binding configured in CF dashboard, not `wrangler.toml`)

---

## 9. Privacy & legal

Standalone page at `https://blinkformentera.com/privacy.html`, source: `privacy.html` at the repo root. Linked from every page footer (added in `footerHtml()` in `build.js` for journal + post pages, hardcoded in `index.html` for the home page).

Structure mirrors the Massivan privacy page (same layout, nav, footer pattern) but adapted for BLiNK:
- BLiNK fonts (Cormorant Garamond + Outfit) and cyan accent (`#38BCD4`)
- Dedicated **"When you place an order"** section disclosing Snipcart as data processor, Stripe/PayPal as payment providers, shipping carriers, and Spanish accounting/tax retention (4–6 years tax, up to 10 years accounting)
- **"The Journal"** section explains that images are self-hosted (downloaded via Graph API at publish time, see § 6) so Instagram does not receive visitor data when reading journal posts
- Both store addresses listed as the data controller's physical operations
- Contact: `blinkformentera@gmail.com` (the shared main mailbox — no domain mailbox at `@blinkformentera.com` exists yet)
- GDPR + Spanish LSSI-CE rights, AEPD as supervisory authority

**Build flow.** `build.js` has a `buildPrivacy()` step that does a straight `fs.copyFileSync(privacy.html → dist/privacy.html)` — no templating, no injection. Edit `privacy.html` directly when content changes.

**Update the "Last updated" date** at the top of `privacy.html` whenever you change the policy substantively — this is the only meaningful signal to returning visitors that something changed.

---

## 10. Runbook

### Edit and deploy the website
```bash
cd ~/Documents/CLAUDE/blink-website
# ...edits...
node build.js                 # optional sanity build
git add . && git commit -m "..." && git push origin main
```

### Update the Instagram agent (source baked into image)
```bash
# Edit in repo first
cd ~/Documents/CLAUDE/blink-website
# ...edit journal-publisher.js...

# Sync to Umbrel + rebuild container
scp journal-publisher.js umbrel@100.88.95.57:/home/umbrel/blink-agent/journal-publisher.js
ssh umbrel@100.88.95.57 'cd /home/umbrel/blink-agent && sudo docker compose up -d --build'

# Verify the new code is inside the running container
ssh umbrel@100.88.95.57 'sudo docker exec blink-instagram-agent grep -c downloadImageBuffer /app/journal-publisher.js'
```

⚠️ The repo's `journal-publisher.js` and `/home/umbrel/blink-agent/journal-publisher.js` are two unlinked copies. Always edit in the repo, then `scp` + rebuild. (See § 12 for a planned fix.)

### Backfill expired journal images
```bash
cd ~/Documents/CLAUDE/blink-website
META_ACCESS_TOKEN='<token>' node scripts/migrate-journal-images.js
git add journal-images data/posts && git commit -m "Backfill journal images" && git push origin main
```

### Delete a journal post
```bash
cd ~/Documents/CLAUDE/blink-website
rm data/posts/<slug>.json
rm -rf journal-images/<slug>
git commit -am "Remove journal post: <slug>" && git push origin main
```

### Regenerate icons (after logo change)
See § 7 above for the full ImageMagick recipe.

### Update the privacy policy
```bash
cd ~/Documents/CLAUDE/blink-website
# Edit privacy.html — update the "Last updated" date at the top
git commit -am "Update privacy policy: <what changed>" && git push origin main
```

---

## 11. Known constants

| What | Value |
|---|---|
| Meta App ID | `1664532291197042` |
| Instagram Account ID | `17841402068412035` |
| Facebook Page ID | `231165690232555` |
| GBP Account | `accounts/118213970870134866386` |
| GBP Location — Ibiza | `8378450892476062175` |
| GBP Location — Formentera | `13740599725654011078` |
| Site URL | `https://blinkformentera.com` |
| Media subdomain | `https://media.blinkformentera.com` |
| Posts per journal page | 12 |
| Sector color (Command Center) | `#ec4899` (pink) |

---

## 12. Open items

- [ ] Identify what `media.blinkformentera.com` actually serves and where (Cloudflare zone? Worker? Umbrel via tunnel?). It's set as `SERVER_URL` in the agent env but its role in the publishing flow isn't documented.
- [ ] Replace the `scp`-and-rebuild pattern for `journal-publisher.js` with a bind mount in `docker-compose.yml` (mount `/home/umbrel/blink-agent` into `/app` read-only) OR move the agent source into the same repo so editing in one place propagates everywhere.
- [ ] Document the 6 BLiNK AI assistant agents (CEO, Finance & Operations, Marketing & Social, Security & IT, Store Operations, + one planned). Each: port, repo location, restart procedure. Currently only mentioned by name in `~/Documents/CLAUDE/CLAUDE.md` and shared INFRA.md § 5.
- [ ] Remove `GBP_REFRESH_TOKEN.rtf` from the repo root if it's tracked (should live in Apple Passwords; check `.gitignore`).
- [ ] Set up a lightweight monitor (Pages Function on cron or external uptime check) that probes the first image of the latest journal post and alerts if it 404s — safety net against any future image-mirror regression.
- [ ] When the Instagram Agent posts a Reel where the Graph API returns no `media_url` (only `thumbnail_url`), the current pipeline stores only the thumbnail. Confirm that's the desired behavior or hot-link the IG permalink as the click target.
