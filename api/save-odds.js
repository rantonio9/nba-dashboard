const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d.result ? JSON.parse(d.result) : null;
}

async function kvSet(key, value, exSeconds = 60 * 60 * 24 * 14) {
  const r = await fetch(
    `${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${exSeconds}`,
    { method: "GET", headers: { Authorization: `Bearer ${KV_TOKEN}` } }
  );
  if (!r.ok) throw new Error(`KV set failed: ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { games } = req.body;
    if (!Array.isArray(games)) return res.status(400).json({ error: "games array required" });

    const saved   = [];
    const skipped = [];

    for (const game of games) {
      if (!game.id || !game.over_under) continue;

      const key      = `odds_${game.id}`;
      const existing = await kvGet(key);

      // ── CORREÇÃO PRINCIPAL ────────────────────────────────────────
      // Se já existe uma entrada salva para este jogo, NÃO sobrescrever.
      // O primeiro save sempre acontece antes do início (jogo "Agendado"),
      // então o proj ali é legítimo — nunca contaminado pelo resultado.
      if (existing) {
        skipped.push(game.id);
        continue;
      }
      // ─────────────────────────────────────────────────────────────

      await kvSet(key, {
        over_under: game.over_under,
        spread:     game.spread || null,
        proj:       game.proj,
        savedAt:    new Date().toISOString(),
      });

      saved.push(game.id);
    }

    return res.status(200).json({ saved, skipped, count: saved.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
