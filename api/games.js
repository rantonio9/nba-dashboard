const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

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

function getWeekDates(today) {
  const d = new Date(today + "T12:00:00");
  const mon = new Date(d);
  mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(mon);
    x.setDate(mon.getDate() + i);
    return x.toISOString().split("T")[0];
  });
}

function parseGame(ev) {
  const comp  = ev.competitions?.[0];
  const home  = comp?.competitors?.find(c => c.homeAway === "home");
  const away  = comp?.competitors?.find(c => c.homeAway === "away");
  const stype = ev.status?.type?.name;

  const isFinal = stype === "STATUS_FINAL";
  const isLive  = stype === "STATUS_IN_PROGRESS";

  const getPPG = c => {
    const s = c?.statistics?.find(s => s.name === "avgPoints");
    return s ? parseFloat(s.displayValue) : null;
  };

  // Odds já vêm da ESPN — campo overUnder do DraftKings
  const oddsObj   = comp?.odds?.[0];
  const overUnder = oddsObj?.overUnder || null;
  const spread    = oddsObj?.details || null;

  return {
    id:          ev.id,
    home:        home?.team?.displayName || "",
    away:        away?.team?.displayName || "",
    home_id:     home?.team?.id || null,
    away_id:     away?.team?.id || null,
    home_abbr:   home?.team?.abbreviation || "",
    away_abbr:   away?.team?.abbreviation || "",
    home_ppg:    getPPG(home),
    away_ppg:    getPPG(away),
    home_record: home?.records?.find(r => r.type === "total")?.summary || null,
    away_record: away?.records?.find(r => r.type === "total")?.summary || null,
    hs:          isFinal || isLive ? parseInt(home?.score) || null : null,
    vs:          isFinal || isLive ? parseInt(away?.score) || null : null,
    status:      isFinal ? "Final"
               : isLive  ? ev.status?.type?.detail || "Em andamento"
               : "Agendado",
    over_under:  overUnder,
    spread:      spread,
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
    const weekDates = getWeekDates(today);
    const start     = weekDates[0].replace(/-/g, "");
    const end       = weekDates[6].replace(/-/g, "");

    const data   = await espnFetch(`/scoreboard?dates=${start}-${end}&limit=100`);
    const events = data.events || [];

    const scheduleRaw = {};
    weekDates.forEach(d => { scheduleRaw[d] = []; });

    events.forEach(ev => {
      const brt  = new Date(new Date(ev.date).getTime() - 3 * 60 * 60 * 1000);
      const date = brt.toISOString().split("T")[0];
      if (scheduleRaw[date] !== undefined) {
        const game = parseGame(ev);
        if (game.home) scheduleRaw[date].push(game);
      }
    });

    const schedule = {};
    weekDates.forEach(d => { schedule[d] = scheduleRaw[d]; });

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
