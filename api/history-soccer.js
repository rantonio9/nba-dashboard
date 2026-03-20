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

// ── Score de aposta — Modelo A (thresholds fixos) ────────────────
function calcBetScoreA(homeStats, awayStats) {
  let score = 0;
  const breakdown = [];

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

  const homeRecentStrong = homeStats.last5.total >= 3 && homeStats.last5.above >= 4;
  const awayRecentStrong = awayStats.last5.total >= 3 && awayStats.last5.above >= 4;
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

  if (homeConflict) { score -= 1; breakdown.push({ label: "Penalidade: inconsistência mandante", pts: -1, ok: false }); }
  if (awayConflict) { score -= 1; breakdown.push({ label: "Penalidade: inconsistência visitante", pts: -1, ok: false }); }

  const bothSeasonAlign = homeSeasonStrong && awaySeasonStrong;
  const bothRecentAlign = homeRecentStrong && awayRecentStrong;

  if (bothSeasonAlign && bothRecentAlign) {
    score += 2;
    breakdown.push({ label: "Convergência total", pts: 2, ok: true });
  } else if (bothSeasonAlign || bothRecentAlign) {
    score += 1;
    breakdown.push({ label: "Convergência parcial", pts: 1, ok: true });
  } else {
    breakdown.push({ label: "Sem convergência", pts: 0, ok: false });
  }

  score = Math.max(0, Math.min(10, parseFloat(score.toFixed(1))));

  return {
    score,
    breakdown,
    profiles: {
      precision: score >= 7,
      balanced:  score >= 5.5,
      volume:    score >= 4,
    },
  };
}

// ── Score de aposta — Modelo B (relativo à taxa base da liga) ─────
// leagueBaseRate = % de mandantes que marcaram historicamente (calculado dinamicamente)
// Só recomenda quando a probabilidade estimada supera a taxa base por margem mínima
function calcBetScoreB(homeStats, awayStats, leagueBaseRate = 0.65) {
  // Estima probabilidade do mandante marcar com base nos 4 campos
  // Cada campo contribui proporcionalmente
  const fields = [
    { pct: homeStats.pctSeason,  weight: 0.35, label: "Ataque temporada" },
    { pct: homeStats.pctLast5,   weight: 0.25, label: "Ataque últimos 5" },
    { pct: awayStats.pctSeason,  weight: 0.25, label: "Defesa temporada" },
    { pct: awayStats.pctLast5,   weight: 0.15, label: "Defesa últimos 5" },
  ];

  // Calcula probabilidade ponderada
  let totalWeight = 0;
  let weightedSum = 0;
  const breakdown = [];

  for (const f of fields) {
    if (f.pct === null || f.pct === undefined) continue;
    weightedSum += f.pct * f.weight;
    totalWeight += f.weight;
    breakdown.push({
      label: f.label,
      pct: parseFloat((f.pct * 100).toFixed(1)),
      weight: f.weight,
      pts: parseFloat((f.pct * f.weight * 10).toFixed(2)),
      ok: f.pct > leagueBaseRate,
    });
  }

  const estimatedProb = totalWeight > 0 ? weightedSum / totalWeight : leagueBaseRate;

  // Margem acima da taxa base (edge)
  const edge = estimatedProb - leagueBaseRate;

  // Penalidade por inconsistência (temporada forte mas recente fraca)
  const homeConflict = homeStats.pctSeason >= 0.65 && homeStats.pctLast5 < 0.4;
  const awayConflict = awayStats.pctSeason >= 0.65 && awayStats.pctLast5 < 0.4;
  const conflictPenalty = (homeConflict ? 0.05 : 0) + (awayConflict ? 0.05 : 0);
  const adjustedProb = Math.max(0, Math.min(1, estimatedProb - conflictPenalty));
  const adjustedEdge = adjustedProb - leagueBaseRate;

  if (homeConflict) breakdown.push({ label: "Penalidade: inconsistência mandante", pct: -5, weight: 0, pts: -0.5, ok: false });
  if (awayConflict) breakdown.push({ label: "Penalidade: inconsistência visitante", pct: -5, weight: 0, pts: -0.5, ok: false });

  // Perfis baseados no edge acima da taxa base
  // Precisão: edge ≥ 15% (prob ≥ baseRate + 0.15)
  // Equilíbrio: edge ≥ 8%
  // Volume: edge ≥ 3%
  const profiles = {
    precision: adjustedEdge >= 0.15,
    balanced:  adjustedEdge >= 0.08,
    volume:    adjustedEdge >= 0.03,
  };

  return {
    estimatedProb:  parseFloat((adjustedProb  * 100).toFixed(1)),
    leagueBaseRate: parseFloat((leagueBaseRate * 100).toFixed(1)),
    edge:           parseFloat((adjustedEdge  * 100).toFixed(1)),
    breakdown,
    profiles,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { home_id, away_id, matchup_avg, league_base_rate } = req.query;
  if (!home_id || !away_id || !matchup_avg) {
    return res.status(400).json({ error: "home_id, away_id e matchup_avg são obrigatórios" });
  }

  const avg = parseFloat(matchup_avg);
  // Taxa base da liga passada pelo frontend (calculada dinamicamente nos jogos finalizados)
  // Se não fornecida, usa 0.65 como fallback conservador
  const baseRate = league_base_rate ? parseFloat(league_base_rate) : 0.65;

  try {
    const [homeScored, awayConceded] = await Promise.all([
      getTeamGoalsScored(home_id),
      getTeamGoalsConceded(away_id),
    ]);

    const homeStats = calc(homeScored,   avg);
    const awayStats = calc(awayConceded, avg);

    const modelA = calcBetScoreA(homeStats, awayStats);
    const modelB = calcBetScoreB(homeStats, awayStats, baseRate);

    return res.status(200).json({
      home:        homeStats,
      away:        awayStats,
      matchup_avg: avg,
      neutral_zone: NEUTRAL_ZONE,
      // Modelo B como principal, Modelo A como comparativo
      bet:    { ...modelB, modelLabel: "B" },
      betA:   { ...modelA, modelLabel: "A" },
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
