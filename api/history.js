const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

const cache = {};
const CACHE_TTL = 60 * 60 * 1000;

async function espnFetch(path) {
  const r = await fetch(`${ESPN_BASE}${path}`);
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

async function getTeamScores(teamId, n = 20) {
  const key = String(teamId);
  if (cache[key] && Date.now() - cache[key].ts < CACHE_TTL) {
    return cache[key].data;
  }

  const data   = await espnFetch(`/teams/${teamId}/schedule?season=2026`);
  const events = data.events || [];
  const scores = [];

  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;

    const completed = comp.status?.type?.completed === true;
    if (!completed) continue;

    const competitor = comp.competitors?.find(
      c => String(c.id) === key || String(c.team?.id) === key
    );
    if (!competitor) continue;

    // score é um objeto {value, displayValue}
    const score = competitor.score?.value ?? parseInt(competitor.score);
    if (score > 0 && !isNaN(score)) scores.push(score);
  }

  const result = scores.slice(-n);
  cache[key] = { data: result, ts: Date.now() };
  return result;
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
      getTeamScores(home_id),
      getTeamScores(away_id),
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
      home:        calc(homeScores),
      away:        calc(awayScores),
      matchup_avg: avg,
      updatedAt:   new Date().toISOString(),
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
