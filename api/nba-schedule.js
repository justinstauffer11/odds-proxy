// nba-schedule.js — fetches completed NBA games for a given date.
// GET /api/nba-schedule?date=YYYY-MM-DD
//
// Used by EDGE's Elo auto-updater to walk historical results and apply
// rating changes. Returns a thin shape compatible with the NHL schedule
// proxy: { date, games: [{ id, homeTeam, awayTeam, homeScore, awayScore }] }.

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EdgeFinder/1.0)' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Provide date in YYYY-MM-DD format' });

  // ESPN scoreboard URL accepts YYYYMMDD
  const espnDate = date.replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${espnDate}`;

  try {
    const r = await fetch(url, { headers: HEADERS });
    if (!r.ok) return res.status(r.status).json({ error: `ESPN returned ${r.status}` });
    const data = await r.json();

    const games = [];
    for (const ev of (data.events || [])) {
      const status = ev.status?.type?.completed;
      if (!status) continue; // skip in-progress / scheduled
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      const hs = parseInt(home.score, 10);
      const as = parseInt(away.score, 10);
      if (Number.isNaN(hs) || Number.isNaN(as)) continue;
      games.push({
        id: ev.id,
        gameDate: ev.date,
        homeTeam: {
          abbrev: home.team?.abbreviation || '',
          name:   home.team?.displayName || '',
          score:  hs,
        },
        awayTeam: {
          abbrev: away.team?.abbreviation || '',
          name:   away.team?.displayName || '',
          score:  as,
        },
      });
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json({ date, games });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
