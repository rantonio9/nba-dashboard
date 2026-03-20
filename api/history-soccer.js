const ESPN_BASE_SOCCER = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const cache = {};
const CACHE_TTL = 60 * 60 * 1000;
const NEUTRAL_ZONE = 0.5;

async function espnFetch(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

// Usa soccer/all para pegar resultados de todas as competições do time
async function getTeamGoalsScored(teamId, n = 20) {
  const key = `scored_${teamId}`;
  if (cache[key] && Date.now() - cache[key].ts < CACHE_TTL) return cache[key].data;

  const url = `${ESPN_BASE_SOCCER}/all/teams/${teamId}/schedule`;
  const data = await espnFetch(url);
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

async function getTeamGoalsConceded(teamId, n = 20) {
  const key = `conceded_${teamId}`;
  if (cache[key] && Date.now() - cache[key].ts < CACHE_TTL) return cache[key].data;

  const url = `${ESPN_BASE_SOCCER}/all/teams/${teamId}/schedule`;
  const data = await espnFetch(url);
  const events = data.events || [];
  const conceded = [];

  for (const ev of events) {
    const comp = ev.competitions?.[0];
    if (!comp?.status?.type?.completed) continue;
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
function classify(value, avg) {
  if (value > avg + NEUTRAL_ZONE) return "above";
  if (value < avg - NEUTRAL_ZONE) return "below";
  return "neutral";
}

// Calcula above/below/total ignorando neutros + pct para força do sinal
function calc(scores, avg) {
  let above = 0, below = 0, total = 0;
  for (const s of scores) {
    const cls = classify(s, avg);
    if (cls === "neutral") continue;
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
  const pctSeason = total > 0 ? above / total : 0;
  const pctLast5  = t5   > 0 ? a5   / t5   : 0;
  return {
    above, below, total,
    pctSeason,   // % acima na temporada
    pctLast5,    // % acima nos últimos 5
    last5: { above: a5, below: b5, total: t5 },
  };
}

// ── Score de aposta (0–8 pts) ────────────────────────────────────
function calcBetScore(homeStats, awayStats) {
  let score = 0;
  const breakdown = [];

  // ── Bloco 1: Força do sinal na temporada ──────────────────────
  // homeStats = gols marcados mandante | awayStats = gols sofridos visitante
  const homeSeasonStrong = homeStats.pctSeason >= 0.65;
  const awaySeasonStrong = awayStats.pctSeason >= 0.65;

  if (homeSeasonStrong) {
    score += 1.5;
    breakdown.push({ label: "Ataque mandante (temporada)", pts: 1.5, ok: true });
    if (homeStats.pctSeason >= 0.75) {
      score += 0.5;
      breakdown.push({ label: "Bônus ataque ≥75%", pts: 0.5, ok: true });
    }
  } else {
    breakdown.push({ label: "Ataque mandante (temporada)", pts: 0, ok: false });
  }

  if (awaySeasonStrong) {
    score += 1.5;
    breakdown.push({ label: "Defesa visitante (temporada)", pts: 1.5, ok: true });
    if (awayStats.pctSeason >= 0.75) {
      score += 0.5;
      breakdown.push({ label: "Bônus defesa ≥75%", pts: 0.5, ok: true });
    }
  } else {
    breakdown.push({ label: "Defesa visitante (temporada)", pts: 0, ok: false });
  }

  // ── Bloco 2: Consistência recente (últimos 5) ─────────────────
  const homeRecentStrong = homeStats.last5.total >= 3 && homeStats.last5.above >= 4;
  const awayRecentStrong = awayStats.last5.total >= 3 && awayStats.last5.above >= 4;

  // Penalidade: inconsistência entre temporada e últimos 5
  const homeConflict = homeSeasonStrong && homeStats.pctLast5 < 0.4;
  const awayConflict = awaySeasonStrong && awayStats.pctLast5 < 0.4;

  if (homeRecentStrong) {
    score += 1.5;
    breakdown.push({ label: "Ataque mandante (últimos 5)", pts: 1.5, ok: true });
  } else {
    breakdown.push({ label: "Ataque mandante (últimos 5)", pts: 0, ok: false });
  }

  if (awayRecentStrong) {
    score += 1.5;
    breakdown.push({ label: "Defesa visitante (últimos 5)", pts: 1.5, ok: true });
  } else {
    breakdown.push({ label: "Defesa visitante (últimos 5)", pts: 0, ok: false });
  }

  if (homeConflict) {
    score -= 1;
    breakdown.push({ label: "Penalidade: inconsistência mandante", pts: -1, ok: false });
  }
  if (awayConflict) {
    score -= 1;
    breakdown.push({ label: "Penalidade: inconsistência visitante", pts: -1, ok: false });
  }

  // ── Bloco 3: Convergência dos dois lados ─────────────────────
  const bothSeasonAlign  = homeSeasonStrong && awaySeasonStrong;
  const bothRecentAlign  = homeRecentStrong && awayRecentStrong;
  const fullConvergence  = bothSeasonAlign && bothRecentAlign;

  if (fullConvergence) {
    score += 2;
    breakdown.push({ label: "Convergência total (temporada + recente)", pts: 2, ok: true });
  } else if (bothSeasonAlign || bothRecentAlign) {
    score += 1;
    breakdown.push({ label: "Convergência parcial", pts: 1, ok: true });
  } else {
    breakdown.push({ label: "Sem convergência", pts: 0, ok: false });
  }

  // Garante score entre 0 e 10
  score = Math.max(0, Math.min(10, score));

  // Perfis de decisão
  const profiles = {
    precision:  score >= 7,    // máxima precisão
    balanced:   score >= 5.5,  // equilíbrio (padrão)
    volume:     score >= 4,    // volume
  };

  return { score: parseFloat(score.toFixed(1)), breakdown, profiles };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { home_id, away_id, matchup_avg } = req.query;
  if (!home_id || !away_id || !matchup_avg) {
    return res.status(400).json({ error: "home_id, away_id e matchup_avg são obrigatórios" });
  }

  const avg = parseFloat(matchup_avg);

  try {
    const [homeScored, awayConceded] = await Promise.all([
      getTeamGoalsScored(home_id),
      getTeamGoalsConceded(away_id),
    ]);

    const homeStats = calc(homeScored,   avg);
    const awayStats = calc(awayConceded, avg);
    const bet       = calcBetScore(homeStats, awayStats);

    return res.status(200).json({
      home:        homeStats,
      away:        awayStats,
      matchup_avg: avg,
      neutral_zone: NEUTRAL_ZONE,
      bet,          // { score, breakdown, profiles }
      updatedAt:   new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
