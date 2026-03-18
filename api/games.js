const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

async function espnFetch(path) {
  const r = await fetch(`${ESPN_BASE}${path}`);
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

function getBrazilDate(utcStr) {
  const d = new Date(utcStr);
  const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().split("T")[0];
}

function getBrazilToday() {
  return getBrazilDate(new Date().toISOString());
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

function parseESPNGame(event, dateStr) {
  const comp   = event.competitions?.[0];
  const home   = comp?.competitors?.find(c => c.homeAway === "home");
  const away   = comp?.competitors?.find(c => c.homeAway === "away");
  const status = event.status?.type?.name;

  const isFinal = status === "STATUS_FINAL";
  const isLive  = status === "STATUS_IN_PROGRESS";

  return {
    id:       event.id,
    home:     home?.team?.displayName || "",
    away:     away?.team?.displayName || "",
    home_ppg: parseFloat(home?.statistics?.find(s => s.name === "avgPoints")?.value) || null,
    away_ppg: parseFloat(away?.statistics?.find(s => s.name === "avgPoints")?.value) || null,
    hs:       isFinal || isLive ? parseInt(home?.score) || null : null,
    vs:       isFinal || isLive ? parseInt(away?.score) || null : null,
    status:   isFinal ? "Final" : isLive ? event.status?.type?.detail || "Em andamento" : "Agendado",
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  try {
    const today     = getBrazilToday();
    const weekDates = getWeekDates(today);

    // Busca PPG da temporada (season averages por time)
    let ppgMap = {};
    try {
      const standing = await espnFetch("/teams?limit=30");
      // PPG vem nos jogos individuais via statistics, não precisa buscar separado
    } catch (e) {}

    // Busca jogos de cada dia da semana
    const scheduleRaw = {};
    weekDates.forEach(d => { scheduleRaw[d] = []; });

    const errors = [];
    for (const date of weekDates) {
      try {
        const espnDate = date.replace(/-/g, "");
        const data = await espnFetch(`/scoreboard?dates=${espnDate}&limit=30`);
        const events = data.events || [];
        events.forEach(ev => {
          const game = parseESPNGame(ev, date);
          if (game.home) scheduleRaw[date].push(game);
        });
      } catch (e) {
        errors.push(`${date}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // Busca PPG separado via scoreboard do dia atual para pegar season stats
    // ESPN retorna avgPoints nos competitors quando disponível
    // Para os que ficaram null, buscamos via team stats
    const allGames = Object.values(scheduleRaw).flat();
    const teamsNeedingPPG = [...new Set(
      allGames.filter(g => !g.home_ppg).flatMap(g => [g.home, g.away])
    )];

    if (teamsNeedingPPG.length > 0) {
      try {
        const statsData = await espnFetch(`/teams?limit=30`);
        const teams = statsData.sports?.[0]?.leagues?.[0]?.teams || [];
        for (const t of teams) {
          const name = t.team?.displayName;
          if (name) ppgMap[name] = null; // placeholder
        }
      } catch (e) {}

      // Busca stats da temporada via summary de um jogo recente
      try {
        const today_espn = today.replace(/-/g, "");
        const data = await espnFetch(`/scoreboard?dates=${today_espn}&limit=30`);
        (data.events || []).forEach(ev => {
          const comp = ev.competitions?.[0];
          comp?.competitors?.forEach(c => {
            const ppgStat = c.statistics?.find(s => s.name === "avgPoints");
            if (ppgStat && c.team?.displayName) {
              ppgMap[c.team.displayName] = parseFloat(ppgStat.value) || null;
            }
          });
        });
      } catch(e) {}
    }

    // Aplica PPG do mapa nos jogos que ficaram sem
    Object.values(scheduleRaw).flat().forEach(g => {
      if (!g.home_ppg && ppgMap[g.home]) g.home_ppg = ppgMap[g.home];
      if (!g.away_ppg && ppgMap[g.away]) g.away_ppg = ppgMap[g.away];
    });

    const schedule = {};
    weekDates.forEach(date => {
      schedule[date] = scheduleRaw[date];
    });

    res.status(200).json({
      schedule,
      updatedAt: new Date().toISOString(),
      debug: { today, weekDates, totalGames: allGames.length, errors }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
