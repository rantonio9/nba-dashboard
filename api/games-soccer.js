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

function parseScore(competitor) {
  // ESPN pode retornar score como objeto {value, displayValue} ou string direta
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
    home_logo:   home?.team?.logo || null,
    away_logo:   away?.team?.logo || null,
    home_ppg:    getGPJ(home),
    away_ppg:    getGPJ(away),
    home_record: home?.records?.find(r => r.type === "total")?.summary || null,
    away_record: away?.records?.find(r => r.type === "total")?.summary || null,
    hs:  isFinal || isLive ? parseScore(home) : null,
    vs:  isFinal || isLive ? parseScore(away) : null,
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

  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cache.data);
  }

  try {
    const today = getBrazilToday();
    const qStart = req.query.start;
    const qEnd   = req.query.end;

    const startStr = qStart || getLast7Dates(today)[0].replace(/-/g,"");
    const endStr   = qEnd   || getLast7Dates(today)[6].replace(/-/g,"");
    const startDate = new Date(`${startStr.slice(0,4)}-${startStr.slice(4,6)}-${startStr.slice(6,8)}T12:00:00`);
    const endDate   = new Date(`${endStr.slice(0,4)}-${endStr.slice(4,6)}-${endStr.slice(6,8)}T12:00:00`);
    const diffDays  = Math.round((endDate-startDate)/(1000*60*60*24))+1;
    const dates = Array.from({length:diffDays},(_,i)=>{
      const d=new Date(startDate); d.setDate(startDate.getDate()+i);
      return d.toISOString().split("T")[0];
    });

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
