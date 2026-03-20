const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/bra.1";
const cache = {};
const CACHE_TTL = 30 * 60 * 1000;

async function espnFetch(path) {
  const r = await fetch(`${ESPN_BASE}${path}`);
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

function getBrazilToday() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().split("T")[0];
}

function getLast14Dates() {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(brt); d.setDate(brt.getDate() - (6 - i));
    return d.toISOString().split("T")[0];
  });
}

function buildDates(startStr, endStr) {
  const s = new Date(`${startStr.slice(0,4)}-${startStr.slice(4,6)}-${startStr.slice(6,8)}T12:00:00`);
  const e = new Date(`${endStr.slice(0,4)}-${endStr.slice(4,6)}-${endStr.slice(6,8)}T12:00:00`);
  const days = Math.round((e - s) / (1000*60*60*24)) + 1;
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(s); d.setDate(s.getDate() + i);
    return d.toISOString().split("T")[0];
  });
}

function getGPJ(competitor) {
  const names = ["avgGoals", "avgGoalsScored", "goalsPerGame"];
  for (const name of names) {
    const s = competitor?.statistics?.find(s => s.name === name);
    if (s) return parseFloat(s.displayValue);
  }
  const goals  = competitor?.statistics?.find(s => s.name === "goals");
  const played = competitor?.statistics?.find(s => s.name === "gamesPlayed");
  if (goals && played && parseFloat(played.displayValue) > 0) {
    return parseFloat((parseFloat(goals.displayValue) / parseFloat(played.displayValue)).toFixed(2));
  }
  return null;
}

function parseScore(competitor) {
  const s = competitor?.score;
  if (s == null) return null;
  if (typeof s === "object") {
    const v = s.value ?? parseInt(s.displayValue);
    return isNaN(v) ? null : v;
  }
  const v = parseInt(s);
  return isNaN(v) ? null : v;
}

function parseGame(ev) {
  const comp  = ev.competitions?.[0];
  const home  = comp?.competitors?.find(c => c.homeAway === "home");
  const away  = comp?.competitors?.find(c => c.homeAway === "away");
  const stype = ev.status?.type?.name;
  const isFinal = stype === "STATUS_FINAL" || stype === "STATUS_FULL_TIME";
  const isLive  = stype === "STATUS_IN_PROGRESS" || stype === "STATUS_HALFTIME";

  const oddsObj   = comp?.odds?.[0];
  const overUnder = oddsObj?.overUnder ?? null;
  const spread    = oddsObj?.details   ?? null;

  const round = comp?.series?.summary ?? ev.week?.number ?? null;

  return {
    id:          ev.id,
    home:        home?.team?.displayName || "",
    away:        away?.team?.displayName || "",
    home_id:     home?.team?.id || null,
    away_id:     away?.team?.id || null,
    home_abbr:   home?.team?.abbreviation || "",
    away_abbr:   away?.team?.abbreviation || "",
    home_logo:   home?.team?.logo || null,
    away_logo:   away?.team?.logo || null,
    home_ppg:    getGPJ(home),
    away_ppg:    getGPJ(away),
    home_record: home?.records?.find(r => r.type === "total")?.summary || null,
    away_record: away?.records?.find(r => r.type === "total")?.summary || null,
    hs:   isFinal || isLive ? parseScore(home) : null,
    vs:   isFinal || isLive ? parseScore(away) : null,
    status: isFinal ? "Final"
          : stype === "STATUS_HALFTIME" ? "Intervalo"
          : isLive  ? ev.status?.type?.detail || "Em andamento"
          : "Agendado",
    over_under: overUnder,
    spread:     spread,
    round:      round,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const defaults = getLast14Dates();
    const startStr = req.query.start || defaults[0].replace(/-/g, "");
    const endStr   = req.query.end   || defaults[13].replace(/-/g, "");
    const cacheKey = `${startStr}-${endStr}`;

    if (cache[cacheKey] && Date.now() - cache[cacheKey].ts < CACHE_TTL) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(cache[cacheKey].data);
    }

    const dates  = buildDates(startStr, endStr);
    const data   = await espnFetch(`/scoreboard?dates=${startStr}-${endStr}&limit=200`);
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

    const result = { schedule: scheduleRaw, updatedAt: new Date().toISOString() };
    cache[cacheKey] = { data: result, ts: Date.now() };
    res.setHeader("X-Cache", "MISS");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(result);
  } catch (e) {
    const fallback = Object.values(cache)[0];
    if (fallback) {
      res.setHeader("X-Cache", "STALE");
      return res.status(200).json(fallback.data);
    }
    return res.status(500).json({ error: e.message });
  }
}
