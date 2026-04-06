/**
 * GET /api/stock
 *
 * Returns current stock levels for every colour variant.
 * Response shape:
 *   { "a975:blackcurrent-video-drone": 1, "g912:earthy": 0, ... }
 *
 * KV binding: INVENTORY  (set in CF Pages → Settings → Functions → KV)
 */

export async function onRequestGet(context) {
  const { env } = context;
  const kv = env.INVENTORY;

  if (!kv) {
    return Response.json(
      { error: 'INVENTORY KV namespace not bound' },
      { status: 500, headers: corsHeaders() }
    );
  }

  // List all keys with the "stock:" prefix
  const list = await kv.list({ prefix: 'stock:' });
  const stock = {};

  // Batch-read values
  await Promise.all(
    list.keys.map(async (key) => {
      const val = await kv.get(key.name);
      // Strip "stock:" prefix → "a975:blackcurrent-video-drone"
      const variant = key.name.slice(6);
      stock[variant] = parseInt(val, 10) || 0;
    })
  );

  return Response.json(stock, { headers: corsHeaders() });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
