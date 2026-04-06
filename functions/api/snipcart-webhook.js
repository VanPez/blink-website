/**
 * POST /api/snipcart-webhook
 *
 * Receives Snipcart webhook events.  We only act on "order.completed".
 * For each purchased item + colour variant, we decrement stock in KV.
 *
 * KV binding : INVENTORY
 * Env secret : SNIPCART_SECRET  (your Snipcart secret API key – used to
 *              validate the webhook token so nobody can fake an order)
 *
 * Snipcart sends a POST with JSON body:
 *   { eventName: "order.completed", content: { items: [ ... ] } }
 *
 * Each item has: uniqueId, id (= data-item-id), customFields: [{ name, value }]
 */

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env.INVENTORY;

  if (!kv) {
    return Response.json({ error: 'KV not bound' }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // ── Validate the webhook token with Snipcart ──────────────────────
  const token = request.headers.get('X-Snipcart-RequestToken');
  if (token && env.SNIPCART_SECRET) {
    const valid = await validateSnipcartToken(token, env.SNIPCART_SECRET);
    if (!valid) {
      return Response.json({ error: 'Invalid token' }, { status: 401 });
    }
  }

  // ── Only process order.completed ──────────────────────────────────
  if (body.eventName !== 'order.completed') {
    return Response.json({ ok: true, skipped: body.eventName });
  }

  const items = body.content?.items || [];
  const updates = [];

  for (const item of items) {
    const productId = item.id;                    // "a975" or "g912"
    // Prefer the explicit slug field; fall back to slugifying the name
    const slugField = (item.customFields || [])
      .find((f) => f.name === 'ColourSlug');
    const colourField = (item.customFields || [])
      .find((f) => f.name === 'Colour');
    if (!slugField && !colourField) continue;

    const colourSlug = slugField ? slugField.value : slugify(colourField.value);
    const key = `stock:${productId}:${colourSlug}`;

    // Decrement (floor at 0)
    const current = parseInt(await kv.get(key), 10) || 0;
    const newVal = Math.max(0, current - item.quantity);
    await kv.put(key, String(newVal));

    updates.push({ key, from: current, to: newVal });
  }

  // ── Send Telegram alert ───────────────────────────────────────────
  if (updates.length > 0 && env.TELEGRAM_WEBHOOK) {
    const lines = updates.map(
      (u) => `${u.key.slice(6)}: ${u.from} → ${u.to}`
    );
    const text =
      `🛒 *Order completed*\nStock updated:\n` + lines.join('\n');
    try {
      await fetch(env.TELEGRAM_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, parse_mode: 'Markdown' }),
      });
    } catch {
      // best-effort
    }
  }

  return Response.json({ ok: true, updates });
}

// ── Helpers ──────────────────────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\s*\/\s*/g, '-')     // " / " → "-"
    .replace(/\s+/g, '-')          // spaces → "-"
    .replace(/[^a-z0-9-]/g, '');   // strip anything else
}

async function validateSnipcartToken(token, secret) {
  try {
    const resp = await fetch(
      `https://app.snipcart.com/api/requestvalidation/${token}`,
      {
        headers: {
          Authorization: `Basic ${btoa(secret + ':')}`,
          Accept: 'application/json',
        },
      }
    );
    return resp.ok;
  } catch {
    return false;
  }
}
