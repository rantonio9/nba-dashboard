const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const data = await r.json();
  if (!data.result) return null;
  try {
    // Upstash pode retornar string direta ou objeto {value, ex}
    const raw = typeof data.result === "string" ? data.result : data.result?.value;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Se ainda for string (double-encoded), parseia de novo
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { ids } = req.query;
  if (!ids) return res.status(400).json({ error: "ids query param required" });

  const gameIds = ids.split(",").filter(Boolean);

  try {
    const results = {};
    await Promise.all(gameIds.map(async id => {
      const data = await kvGet(`odds_${id}`);
      if (data) results[id] = data;
    }));

    return res.status(200).json({ odds: results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
