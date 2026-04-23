// nhl-schedule.js
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; EdgeFinder/1.0)' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: 'Provide date in YYYY-MM-DD format' });

  try {
    const [scoreRes, schedRes] = await Promise.all([
      fetch(`https://api-web.nhle.com/v1/score/${date}`, { headers: HEADERS }),
      fetch(`https://api-web.nhle.com/v1/schedule/${date}`, { headers: HEADERS }),
    ]);

    const scoreData = scoreRes.ok ? await scoreRes.json() : { games: [] };
    const schedData = schedRes.ok ? await schedRes.json() : { gameWeek: [] };

    const games = (scoreData.games || []).filter(g =>
      (g.gameState === 'FINAL' || g.gameState === 'OFF') && g.gameType === 2
    ).map(g => ({
      id: g.id, startTimeUTC: g.startTimeUTC, gameState: g.gameState, gameType: g.gameType,
      homeTeam: { abbrev: g.homeTeam?.abbrev, score: g.homeTeam?.score ?? 0, name: g.homeTeam?.name?.default, placeName: g.homeTeam?.placeName?.default, commonName: g.homeTeam?.commonName?.default },
      awayTeam: { abbrev: g.awayTeam?.abbrev, score: g.awayTeam?.score ?? 0, name: g.awayTeam?.name?.default, placeName: g.awayTeam?.placeName?.default, commonName: g.awayTeam?.commonName?.default },
    }));

    const playoffSeries = {};
    for (const week of (schedData.gameWeek || [])) {
      for (const g of (week.games || [])) {
        if (g.gameType !== 3 || !g.seriesStatus) continue;
        const ss = g.seriesStatus;
        const ha = g.homeTeam?.abbrev, aa = g.awayTeam?.abbrev;
        if (!ha || !aa) continue;
        const entry = {
          round: ss.round, seriesTitle: ss.seriesTitle || '1st Round', seriesLetter: ss.seriesLetter,
          gameNumberOfSeries: ss.gameNumberOfSeries, neededToWin: ss.neededToWin || 4,
          topSeedAbbrev: ss.topSeedTeamAbbrev, topSeedWins: ss.topSeedWins ?? 0,
          bottomSeedAbbrev: ss.bottomSeedTeamAbbrev, bottomSeedWins: ss.bottomSeedWins ?? 0,
          homeAbbrev: ha, awayAbbrev: aa, startTimeUTC: g.startTimeUTC,
        };
        playoffSeries[`${ha}-${aa}`] = entry;
        playoffSeries[`${aa}-${ha}`] = entry;
      }
    }

    res.status(200).json({ date, games, playoffSeries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
