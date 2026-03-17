const BALLDONTLIE_KEY = "9ab2a96e-303d-4fe1-a45a-154db8447384";
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

function getWeekDates() {
  const today = new Date();
  const mon = new Date(today);
  mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d.toISOString().split("T")[0];
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  try {
    const dates = getWeekDates();

    // Fetch games for all 7 days in parallel
    const results = await Promise.all(
      dates.map(date =>
        bdl("/games", { "dates[]": date, per_page: 30, season: SEASON })
          .then(d => ({ date, games: d.data || [] }))
          .catch(() => ({ date, games: [] }))
      )
    );

    // Get all unique team IDs from this week's games
    const teamIds = [...new Set(
      results.flatMap(r => r.games.flatMap(g => [g.home_team.id, g.visitor_team.id]))
    )];

    // Fetch season averages for all teams
    let ppgMap = {};
    if (teamIds.length > 0) {
      try {
        const avgs = await bdl("/season_averages", {
          season: SEASON,
          "team_ids[]": teamIds
        });
        avgs.data.forEach(a => { ppgMap[a.team_id] = parseFloat(a.pts) || 0; });
      } catch (e) {
        console.error("PPG fetch failed:", e.message);
      }
    }

    // Build schedule map
    const schedule = {};
    results.forEach(({ date, games }) => {
      schedule[date] = games.map((g, i) => ({
        id: g.id,
        home: g.home_team.full_name,
        away: g.visitor_team.full_name,
        home_ppg: ppgMap[g.home_team.id] || null,
        away_ppg: ppgMap[g.visitor_team.id] || null,
        hs: g.home_team_score || null,
        vs: g.visitor_team_score || null,
        status: g.status === "Final" ? "Final"
          : g.status?.includes("Qtr") || g.status?.includes("Half") ? g.status
          : "Agendado",
      }));
    });

    res.status(200).json({ schedule, updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
