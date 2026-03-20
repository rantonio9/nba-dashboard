const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1";
let cache = { data: null, ts: 0 };
const CACHE_TTL = 30 * 60 * 1000;

async function espnFetch(path) {
  const r = await fetch(`${ESPN_BASE}${path}`);
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

function getBrazilToday() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split("T")[0];
}

function getLast7Dates(today) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today + "T12:00:00");
    d.setDate(d.getDate() - (6 - i));
    return d.toISOString().split("T")[0];
  });
}

function getGPJ(competitor) {
  // Tenta avgGoals primeiro, depois avgGoalsScored, depois statistic genérica
  const names = ["avgGoals", "avgGoalsScored", "goalsPerGame"];
  for (const name of names) {
    const s = competitor?.statistics?.find(s => s.name === name);
    if (s) return parseFloat(s.displayValue);
  }
  // Fallback: divide gols totais pelo número de jogos
  const goals = competitor?.statistics?.find(s => s.name === "goals");
  const played = competitor?.statistics?.find(s => s.name === "gamesPlayed");
  if (goals && played && parseFloat(played.displayValue) > 0) {
    return parseFloat((parseFloat(goals.displayValue) / parseFloat(played.displayValue)).toFixed(2));
  }
  return null;
}

function parseGame(ev) {
  const comp  = ev.competitions?.[0];
  const home  = comp?.competitors?.find(c => c.homeAway === "home");
  const away  = comp?.competitors?.find(c => c.homeAway === "away");
  const stype = ev.status?.type?.name;
  const isFinal = stype === "STATUS_FINAL";
  const isLive  = stype === "STATUS_IN_PROGRESS";

  const oddsObj   = comp?.odds?.[0];
  const overUnder = oddsObj?.overUnder ?? null;
  const spread    = oddsObj?.details   ?? null;

  // Número da rodada
  const round = ev.season?.slug
    ? null
    : (comp?.series?.summary ?? ev.week?.number ?? null);

  return {
    id:          ev.id,
    home:        home?.team?.displayName || "",
    away:        away?.team?.displayName || "",
    home_id:     home?.team?.id || null,
    away_id:     away?.team?.id || null,
    home_abbr:   home?.team?.abbreviation || "",
    away_abbr:   away?.team?.abbreviation || "",
    home_ppg:    getGPJ(home),   // gols por jogo (ataque)
    away_ppg:    getGPJ(away),   // gols por jogo (ataque)
    home_record: home?.records?.find(r => r.type === "total")?.summary || null,
    away_record: away?.records?.find(r => r.type === "total")?.summary || null,
    hs:  isFinal || isLive ? parseInt(home?.score) || null : null,
    vs:  isFinal || isLive ? parseInt(away?.score) || null : null,
    status: isFinal ? "Final"
          : isLive  ? ev.status?.type?.detail || "Em andamento"
          : "Agendado",
    over_under: overUnder,
    spread:     spread,
    round:      round,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cache.data);
  }

  try {
    const today     = getBrazilToday();
    const dates     = getLast7Dates(today);
    const start     = dates[0].replace(/-/g, "");
    const end       = dates[6].replace(/-/g, "");

    const data   = await espnFetch(`/scoreboard?dates=${start}-${end}&limit=100`);
    const events = data.events || [];

    const scheduleRaw = {};
    dates.forEach(d => { scheduleRaw[d] = []; });

    events.forEach(ev => {
      const brt  = new Date(new Date(ev.date).getTime() - 3 * 60 * 60 * 1000);
      const date = brt.toISOString().split("T")[0];
      if (scheduleRaw[date] !== undefined) {
        const game = parseGame(ev);
        if (game.home) scheduleRaw[date].push(game);
      }
    });

    const schedule = {};
    dates.forEach(d => { schedule[d] = scheduleRaw[d]; });

    const result = { schedule, updatedAt: new Date().toISOString() };
    cache = { data: result, ts: Date.now() };
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(result);
  } catch (e) {
    if (cache.data) {
      res.setHeader("X-Cache", "STALE");
      return res.status(200).json(cache.data);
    }
    return res.status(500).json({ error: e.message });
  }
}
