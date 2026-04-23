// nhl-standings.js — fetch NHL standings for a specific date
// GET /api/nhl-standings?date=YYYY-MM-DD
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { date } = req.query || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Missing or invalid date param (YYYY-MM-DD required)' });

  try {
    const r = await fetch(`https://api-web.nhle.com/v1/standings/${date}`);
    if (!r.ok) return res.status(r.status).json({ error: `NHL API returned ${r.status}` });
    const body = await r.json();

    const out = {};
    for (const t of (body.standings || [])) {
      const abbrev = t.teamAbbrev?.default || t.teamAbbrev;
      if (!abbrev) continue;
      const gp = t.gamesPlayed || 1;
      const hgp = t.homeGamesPlayed || 1;
      const rgp = t.roadGamesPlayed || 1;
      const l10gp = t.l10GamesPlayed || 10;
      out[abbrev] = {
        name: t.teamName?.default || abbrev, abbrev,
        gamesPlayed: gp, wins: t.wins ?? 0, losses: t.losses ?? 0, otLosses: t.otLosses ?? 0,
        points: t.points ?? 0, winPct: t.winPctg ?? ((t.wins ?? 0) / gp),
        goalsForPG: (t.goalFor ?? 0) / gp, goalsAgainstPG: (t.goalAgainst ?? 0) / gp,
        goalDiff: t.goalDifferential ?? 0,
        homeWins: t.homeWins ?? 0, homeGamesPlayed: hgp, homeWinPct: (t.homeWins ?? 0) / hgp,
        roadWins: t.roadWins ?? 0, roadGamesPlayed: rgp, roadWinPct: (t.roadWins ?? 0) / rgp,
        l10Wins: t.l10Wins ?? 0, l10Losses: t.l10Losses ?? 0, l10OtLosses: t.l10OtLosses ?? 0,
        l10GamesPlayed: l10gp, l10WinPct: (t.l10Wins ?? 0) / l10gp,
        l10GoalsForPG: (t.l10GoalsFor ?? 0) / l10gp, l10GoalsAgainstPG: (t.l10GoalsAgainst ?? 0) / l10gp,
        streakCode: t.streakCode || null, streakCount: t.streakCount || 0,
        cfPct: null, pdo: null, ppPct: null, pkPct: null,
        ozFaceoffPct: null, shotsPG: null, shotsAgPG: null, tgRatio: null,
      };
    }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
