// nhl-schedule.js
// Proxies the NHL daily scoreboard so the browser avoids CORS issues.
// GET /api/nhl-schedule?date=2026-01-10
// Returns the raw NHL /v1/score/{date} response filtered to completed regular-season games.

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EdgeFinder/1.0)' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Provide date in YYYY-MM-DD format' });
  }

  try {
    const r = await fetch(`https://api-web.nhle.com/v1/score/${date}`, { headers: HEADERS });
    if (!r.ok) return res.status(r.status).json({ error: `NHL API ${r.status}` });
    const data = await r.json();

    // Filter to completed regular-season games only
    const games = (data.games || []).filter(g =>
      (g.gameState === 'FINAL' || g.gameState === 'OFF') && g.gameType === 2
    ).map(g => ({
      id:            g.id,
      startTimeUTC:  g.startTimeUTC,
      gameState:     g.gameState,
      gameType:      g.gameType,
      homeTeam: {
        abbrev:  g.homeTeam?.abbrev,
        score:   g.homeTeam?.score ?? 0,
        name:    g.homeTeam?.name?.default,
        placeName: g.homeTeam?.placeName?.default,
        commonName: g.homeTeam?.commonName?.default,
      },
      awayTeam: {
        abbrev:  g.awayTeam?.abbrev,
        score:   g.awayTeam?.score ?? 0,
        name:    g.awayTeam?.name?.default,
        placeName: g.awayTeam?.placeName?.default,
        commonName: g.awayTeam?.commonName?.default,
      },
    }));

    res.status(200).json({ date, games });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
