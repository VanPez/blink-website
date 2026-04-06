/**
 * POST /api/admin/stock
 *
 * Protected endpoint to manage inventory.  Requires Bearer token
 * matching the ADMIN_TOKEN environment variable.
 *
 * Actions:
 *
 * 1. Initialize all stock (quantity 1 for every variant):
 *    POST /api/admin/stock
 *    { "action": "init" }
 *
 * 2. Set stock for a specific variant:
 *    POST /api/admin/stock
 *    { "action": "set", "variant": "a975:blackcurrent-video-drone", "qty": 1 }
 *
 * 3. Get current stock overview:
 *    POST /api/admin/stock
 *    { "action": "list" }
 *
 * KV binding: INVENTORY
 * Env var   : ADMIN_TOKEN
 */

// All known variants — keep in sync with index.html products
const ALL_VARIANTS = [
  'a975:blackcurrent-video-drone',
  'a975:bulb-hibiscus-frangipani',
  'a975:electric-video-drone',
  'a975:bodywork-macassar-chrysalis',
  'a975:dark-drone-cover',
  'a975:drone-morningglory-chalcedony',
  'a975:drone-video-bodywork-morningglory',
  'a975:macassar-cover-bowl',
  'a975:drone-blackcurrent-hibiscus',
  'a975:dark-macassar-sap',
  'g912:earthy',
  'g912:greys',
];

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = env.INVENTORY;

  // ── Auth ──
  if (!env.ADMIN_TOKEN) {
    return Response.json({ error: 'ADMIN_TOKEN not configured' }, { status: 500 });
  }
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!kv) {
    return Response.json({ error: 'KV not bound' }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const action = body.action;

  // ── INIT: set every variant to qty 1 ──────────────────────────────
  if (action === 'init') {
    await Promise.all(
      ALL_VARIANTS.map((v) => kv.put(`stock:${v}`, '1'))
    );
    return Response.json({
      ok: true,
      message: `Initialized ${ALL_VARIANTS.length} variants to qty 1`,
    });
  }

  // ── SET: set a single variant ─────────────────────────────────────
  if (action === 'set') {
    const { variant, qty } = body;
    if (!variant || qty === undefined) {
      return Response.json({ error: 'Need variant and qty' }, { status: 400 });
    }
    await kv.put(`stock:${variant}`, String(qty));
    return Response.json({ ok: true, variant, qty });
  }

  // ── LIST: return current stock ────────────────────────────────────
  if (action === 'list') {
    const stock = {};
    await Promise.all(
      ALL_VARIANTS.map(async (v) => {
        const val = await kv.get(`stock:${v}`);
        stock[v] = val !== null ? parseInt(val, 10) : null;
      })
    );
    return Response.json({ ok: true, stock });
  }

  return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
