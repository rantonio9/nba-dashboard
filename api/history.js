const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

const cache = {};
const CACHE_TTL = 60 * 60 * 1000; // 1 hora

async function espnFetch(path) {
  const r = await fetch(`${ESPN_BASE}${path}`);
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

async function getTeamHistory(teamId, n = 20) {
  const cacheKey = `${teamId}`;
  if (cache[cacheKey] && Date.now() - cache[cacheKey].ts < CACHE_TTL) {
    return cache[cacheKey].data;
  }

  // Busca os últimos N jogos do time
  const data = await espnFetch(`/teams/${teamId}/schedule?season=2026`);
  const events = data.events || [];

  // Filtra apenas jogos já realizados
  const played = events
    .filter(ev => ev.competitions?.[0]?.status?.type?.name === "STATUS_FINAL")
    .slice(-n);

  const scores = played.map(ev => {
    const comp = ev.competitions?.[0];
    const team = comp?.competitors?.find(c => c.team?.id === String(teamId));
    return parseInt(team?.score) || null;
  }).filter(s => s !== null);

  cache[cacheKey] = { data: scores, ts: Date.now() };
  return scores;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { home_id, away_id, matchup_avg } = req.query;

  if (!home_id || !away_id || !matchup_avg) {
    return res.status(400).json({ error: "home_id, away_id e matchup_avg são obrigatórios" });
  }

  const avg = parseFloat(matchup_avg);

  try {
    const [homeScores, awayScores] = await Promise.all([
      getTeamHistory(home_id, 20),
      getTeamHistory(away_id, 20),
    ]);

    const calc = (scores, threshold) => ({
      above: scores.filter(s => s > threshold).length,
      below: scores.filter(s => s <= threshold).length,
      total: scores.length,
      last5: {
        above: scores.slice(-5).filter(s => s > threshold).length,
        below: scores.slice(-5).filter(s => s <= threshold).length,
        total: Math.min(scores.length, 5),
      }
    });

    return res.status(200).json({
      home: calc(homeScores, avg),
      away: calc(awayScores, avg),
      matchup_avg: avg,
      updatedAt: new Date().toISOString(),
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
