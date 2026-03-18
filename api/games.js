const BALLDONTLIE_KEY = "c900e07c-e941-49d4-8ccd-0884b0fdfa01";
const BASE = "https://api.balldontlie.io/nba/v1";
const SEASON = 2025;

async function bdl(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  Object.entries(params).forEach(([k, v]) =>
    Array.isArray(v) ? v.forEach(i => url.searchParams.append(k, i)) : url.searchParams.set(k, v)
  );
  const r = await fetch(url, { headers: { Authorization: BALLDONTLIE_KEY } });
  if (!r.ok) throw new Error(`BDL ${r.status}: ${await r.text()}`);
  return r.json();
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function getBrazilToday() {
  const now = new Date();
  const brazil = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brazil.toISOString().split("T")[0];
}

function getWeekDates(today) {
  const d = new Date(today);
  const mon = new Date(d);
  mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(mon);
    x.setDate(mon.getDate() + i);
    return x.toISOString().split("T")[0];
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  try {
    const today = getBrazilToday();
    const weekDates = getWeekDates(today);

    // Busca 2 dias antes e 8 dias depois para cobrir qualquer diferença de fuso
    const fetchDates = [];
    for (let i = -2; i <= 8; i++) fetchDates.push(addDays(today, i));

    // Busca todos os jogos em paralelo
    const allGames = [];
    const errors = [];
    await Promise.all(
      fetchDates.map(date =>
        bdl("/games", { "dates[]": date, per_page: 30, season: SEASON })
          .then(d => { if (d.data) allGames.push(...d.data); })
          .catch(e => errors.push(e.message))
      )
    );

    // Remove duplicatas
    const seen = new Set();
    const games = allGames.filter(g => {
      if (seen.has(g.id)) return false;
      seen.add(g.id);
      return true;
    });

    // Agrupa por data — usa o campo date da API diretamente (já é ET, muito próximo de BRT)
    // Para jogos com datetime, converte para BRT
    const scheduleRaw = {};
    weekDates.forEach(d => { scheduleRaw[d] = []; });

    games.forEach(g => {
      let date = null;

      if (g.datetime) {
        // Converte UTC para BRT (UTC-3)
        const brt = new Date(new Date(g.datetime).getTime() - 3 * 60 * 60 * 1000);
        date = brt.toISOString().split("T")[0];
      } else if (g.date) {
        date = g.date.split("T")[0];
      }

      if (date && scheduleRaw[date] !== undefined) {
        scheduleRaw[date].push(g);
      }
    });

    // Busca PPG de todos os times
    const teamIds = [...new Set(games.flatMap(g => [g.home_team.id, g.visitor_team.id]))];
    let ppgMap = {};

    if (teamIds.length > 0) {
      try {
        const avgs = await bdl("/season_averages", { season: SEASON, "team_ids[]": teamIds });
        avgs.data.forEach(a => { ppgMap[a.team_id] = parseFloat(a.pts) || 0; });
      } catch (e) {
        console.error("PPG fetch failed:", e.message);
      }
    }

    // Monta schedule final
    const schedule = {};
    weekDates.forEach(date => {
      schedule[date] = (scheduleRaw[date] || []).map(g => ({
        id:       g.id,
        home:     g.home_team.full_name,
        away:     g.visitor_team.full_name,
        home_ppg: ppgMap[g.home_team.id] || null,
        away_ppg: ppgMap[g.visitor_team.id] || null,
        hs:       g.home_team_score || null,
        vs:       g.visitor_team_score || null,
        status:   g.status === "Final" ? "Final"
                : g.status?.includes("Qtr") || g.status?.includes("Half") ? g.status
                : "Agendado",
      }));
    });

    res.status(200).json({ schedule, updatedAt: new Date().toISOString(), debug: { today, weekDates, totalGames: games.length, errors } });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
