const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1";
const cache = {};
const CACHE_TTL = 60 * 60 * 1000;
const NEUTRAL_ZONE = 0.5; // ±0.5 gols — jogos dentro da faixa são descartados

async function espnFetch(path) {
  const r = await fetch(`${ESPN_BASE}${path}`);
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

// Busca os gols marcados pelo time em cada jogo da temporada
async function getTeamGoalsScored(teamId, n = 20) {
  const key = `scored_${teamId}`;
  if (cache[key] && Date.now() - cache[key].ts < CACHE_TTL) return cache[key].data;

  const data   = await espnFetch(`/teams/${teamId}/schedule?season=2026`);
  const events = data.events || [];
  const scores = [];

  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp?.status?.type?.completed) continue;
    const competitor = comp.competitors?.find(
      c => String(c.id) === String(teamId) || String(c.team?.id) === String(teamId)
    );
    if (!competitor) continue;
    const score = competitor.score?.value ?? parseInt(competitor.score);
    if (score >= 0 && !isNaN(score)) scores.push(score);
  }

  const result = scores.slice(-n);
  cache[key] = { data: result, ts: Date.now() };
  return result;
}

// Busca os gols SOFRIDOS pelo time em cada jogo (perspectiva defensiva)
async function getTeamGoalsConceded(teamId, n = 20) {
  const key = `conceded_${teamId}`;
  if (cache[key] && Date.now() - cache[key].ts < CACHE_TTL) return cache[key].data;

  const data   = await espnFetch(`/teams/${teamId}/schedule?season=2026`);
  const events = data.events || [];
  const conceded = [];

  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp?.status?.type?.completed) continue;

    // Pega o placar do adversário (time que NÃO é o teamId)
    const opponent = comp.competitors?.find(
      c => String(c.id) !== String(teamId) && String(c.team?.id) !== String(teamId)
    );
    if (!opponent) continue;
    const score = opponent.score?.value ?? parseInt(opponent.score);
    if (score >= 0 && !isNaN(score)) conceded.push(score);
  }

  const result = conceded.slice(-n);
  cache[key] = { data: result, ts: Date.now() };
  return result;
}

// Classifica cada valor com zona neutra
// Retorna "above" | "below" | "neutral"
function classify(value, avg) {
  if (value > avg + NEUTRAL_ZONE) return "above";
  if (value < avg - NEUTRAL_ZONE) return "below";
  return "neutral";
}

// Calcula above/below/total ignorando neutros
function calc(scores, avg) {
  let above = 0, below = 0, total = 0;
  for (const s of scores) {
    const cls = classify(s, avg);
    if (cls === "neutral") continue; // descarta jogos na zona neutra
    total++;
    if (cls === "above") above++; else below++;
  }
  const last5Raw = scores.slice(-5);
  let a5 = 0, b5 = 0, t5 = 0;
  for (const s of last5Raw) {
    const cls = classify(s, avg);
    if (cls === "neutral") continue;
    t5++;
    if (cls === "above") a5++; else b5++;
  }
  return {
    above, below, total,
    last5: { above: a5, below: b5, total: t5 },
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { home_id, away_id, matchup_avg } = req.query;
  if (!home_id || !away_id || !matchup_avg) {
    return res.status(400).json({ error: "home_id, away_id e matchup_avg são obrigatórios" });
  }

  const avg = parseFloat(matchup_avg);

  try {
    // Campos 1-2: gols MARCADOS pelo mandante (ataque do mandante)
    // Campos 3-4: gols SOFRIDOS pelo visitante (defesa do visitante vs ataque do mandante)
    const [homeScored, awayConceded] = await Promise.all([
      getTeamGoalsScored(home_id),
      getTeamGoalsConceded(away_id),
    ]);

    return res.status(200).json({
      home: calc(homeScored,   avg),   // ataque mandante
      away: calc(awayConceded, avg),   // defesa visitante (gols sofridos)
      matchup_avg: avg,
      neutral_zone: NEUTRAL_ZONE,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
