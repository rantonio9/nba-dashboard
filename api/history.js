const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const cache = {};
const CACHE_TTL = 60 * 60 * 1000;

async function espnFetch(path) {
  const r = await fetch(`${ESPN_BASE}${path}`);
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

// Retorna scores históricos do time EXCLUINDO jogos a partir de cutoffDate
// cutoffDate = data do jogo que queremos prever (formato "YYYY-MM-DD")
async function getTeamScores(teamId, cutoffDate, n = 20) {
  const key = `${teamId}_${cutoffDate}`;
  if (cache[key] && Date.now() - cache[key].ts < CACHE_TTL) {
    return cache[key].data;
  }

  const data = await espnFetch(`/teams/${teamId}/schedule?season=2026`);
  const events = data.events || [];
  const scores = [];

  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;

    const completed = comp.status?.type?.completed === true;
    if (!completed) continue;

    // ── CORREÇÃO PRINCIPAL ──────────────────────────────────────────
    // Ignorar jogos ocorridos NO MESMO DIA ou DEPOIS do jogo a prever.
    // Assim o histórico reflete apenas o que era conhecido ANTES da partida.
    const gameDate = new Date(ev.date).toISOString().split("T")[0];
    if (gameDate >= cutoffDate) continue;
    // ───────────────────────────────────────────────────────────────

    const competitor = comp.competitors?.find(
      c => String(c.id) === String(teamId) || String(c.team?.id) === String(teamId)
    );
    if (!competitor) continue;

    const score = competitor.score?.value ?? parseInt(competitor.score);
    if (score > 0 && !isNaN(score)) scores.push(score);
  }

  const result = scores.slice(-n);
  cache[key] = { data: result, ts: Date.now() };
  return result;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // game_date agora é obrigatório — deve ser a data do jogo no formato YYYY-MM-DD
  const { home_id, away_id, matchup_avg, game_date } = req.query;

  if (!home_id || !away_id || !matchup_avg || !game_date) {
    return res.status(400).json({
      error: "home_id, away_id, matchup_avg e game_date são obrigatórios"
    });
  }

  const avg = parseFloat(matchup_avg);

  try {
    const [homeScores, awayScores] = await Promise.all([
      getTeamScores(home_id, game_date),
      getTeamScores(away_id, game_date),
    ]);

    const calc = scores => ({
      above: scores.filter(s => s > avg).length,
      below: scores.filter(s => s <= avg).length,
      total: scores.length,
      last5: {
        above: scores.slice(-5).filter(s => s > avg).length,
        below: scores.slice(-5).filter(s => s <= avg).length,
        total: Math.min(scores.length, 5),
      },
    });

    return res.status(200).json({
      home: calc(homeScores),
      away: calc(awayScores),
      matchup_avg: avg,
      game_date,                          // retorna para debug/auditoria
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
