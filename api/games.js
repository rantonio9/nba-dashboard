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

// Converte uma data UTC para a data local no fuso de Brasília (UTC-3)
function toBrazilDate(utcDateStr) {
  const d = new Date(utcDateStr);
  // Brasília é UTC-3
  const brazil = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return brazil.toISOString().split("T")[0];
}

// Retorna os 7 dias da semana atual no fuso de Brasília
function getWeekDates() {
  const nowUTC = new Date();
  const nowBrazil = new Date(nowUTC.getTime() - 3 * 60 * 60 * 1000);
  const mon = new Date(nowBrazil);
  mon.setDate(nowBrazil.getDate() - ((nowBrazil.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d.toISOString().split("T")[0];
  });
}

// Retorna datas para buscar na API (inclui dia anterior e posterior para cobrir diferença de fuso)
function getAPIFetchDates(weekDates) {
  const first = new Date(weekDates[0]);
  const last  = new Date(weekDates[6]);
  first.setDate(first.getDate() - 1);
  last.setDate(last.getDate() + 1);

  const dates = [];
  const cur = new Date(first);
  while (cur <= last) {
    dates.push(cur.toISOString().split("T")[0]);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  try {
    const weekDates   = getWeekDates();
    const fetchDates  = getAPIFetchDates(weekDates);

    // Busca jogos para todas as datas necessárias em paralelo
    const allGames = [];
    await Promise.all(
      fetchDates.map(date =>
        bdl("/games", { "dates[]": date, per_page: 30, season: SEASON })
          .then(d => { if (d.data) allGames.push(...d.data); })
          .catch(() => {})
      )
    );

    // Remover duplicatas por ID
    const seen = new Set();
    const uniqueGames = allGames.filter(g => {
      if (seen.has(g.id)) return false;
      seen.add(g.id);
      return true;
    });

    // Agrupa os jogos pela data no fuso do Brasil
    // A balldontlie retorna o campo "date" como "YYYY-MM-DD" no horário local do jogo (ET)
    // Mas para garantir, usamos o campo datetime se disponível, senão usamos date
    const scheduleRaw = {};
    weekDates.forEach(d => { scheduleRaw[d] = []; });

    uniqueGames.forEach(g => {
      // Tenta todas as formas possíveis de obter a data no fuso do Brasil
      const candidates = [];

      // 1. datetime em UTC (mais preciso)
      if (g.datetime) candidates.push(toBrazilDate(g.datetime));

      // 2. date como string ISO com hora
      if (g.date && g.date.includes("T")) candidates.push(toBrazilDate(g.date));

      // 3. date como string simples YYYY-MM-DD (já é ET, próximo ao Brasil)
      if (g.date && !g.date.includes("T")) candidates.push(g.date.split("T")[0]);

      // Usa o primeiro candidato que cai numa data da semana
      const brazilDate = candidates.find(d => scheduleRaw[d] !== undefined) || null;

      if (brazilDate) {
        scheduleRaw[brazilDate].push(g);
      }
    });

    // Busca PPG de todos os times envolvidos
    const teamIds = [...new Set(
      Object.values(scheduleRaw).flat().flatMap(g => [g.home_team.id, g.visitor_team.id])
    )];

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

    // Monta o schedule final
    const schedule = {};
    weekDates.forEach(date => {
      schedule[date] = (scheduleRaw[date] || []).map(g => ({
        id:       g.id,
        home:     g.home_team.full_name,
        away:     g.visitor_team.full_name,
        home_ppg: ppgMap[g.home_team.id] || null,
        away_ppg: ppgMap[g.visitor_team.id] || null,
        hs:       g.home_team_score  || null,
        vs:       g.visitor_team_score || null,
        status:   g.status === "Final" ? "Final"
                : g.status?.includes("Qtr") || g.status?.includes("Half") ? g.status
                : "Agendado",
      }));
    });

    res.status(200).json({ schedule, updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
