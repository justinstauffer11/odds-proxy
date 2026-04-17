export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Fetch standings (has everything: GF, GA, L10, home/away splits, streak)
    const r = await fetch('https://api-web.nhle.com/v1/standings/now', {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await r.json();

    // Reshape into a clean lookup map keyed by team abbreviation
    const teams = {};
    for (const t of (data.standings || [])) {
      const abbrev = t.teamAbbrev?.default;
      if (!abbrev) continue;

      const gp = t.gamesPlayed || 1;
      const homeGP = t.homeGamesPlayed || 1;
      const roadGP = t.roadGamesPlayed || 1;
      const l10GP = t.l10GamesPlayed || 10;

      teams[abbrev] = {
        name: t.teamCommonName?.default || abbrev,
        fullName: t.teamName?.default || abbrev,

        // Season totals
        wins: t.wins,
        losses: t.losses,
        otLosses: t.otLosses,
        gamesPlayed: gp,
        winPct: t.winPctg,

        // Goals per game
        goalsForPG: +(t.goalFor / gp).toFixed(2),
        goalsAgainstPG: +(t.goalAgainst / gp).toFixed(2),
        goalDiffPG: +((t.goalFor - t.goalAgainst) / gp).toFixed(2),

        // Home splits
        homeWins: t.homeWins,
        homeLosses: t.homeLosses + (t.homeOtLosses || 0),
        homeGoalsForPG: +(t.homeGoalsFor / homeGP).toFixed(2),
        homeGoalsAgainstPG: +(t.homeGoalsAgainst / homeGP).toFixed(2),
        homeWinPct: +((t.homeWins / homeGP)).toFixed(3),

        // Road splits
        roadWins: t.roadWins,
        roadLosses: t.roadLosses + (t.roadOtLosses || 0),
        roadGoalsForPG: +(t.roadGoalsFor / roadGP).toFixed(2),
        roadGoalsAgainstPG: +(t.roadGoalsAgainst / roadGP).toFixed(2),
        roadWinPct: +((t.roadWins / roadGP)).toFixed(3),

        // Last 10
        l10Wins: t.l10Wins,
        l10Losses: t.l10Losses + (t.l10OtLosses || 0),
        l10GoalsForPG: +(t.l10GoalsFor / l10GP).toFixed(2),
        l10GoalsAgainstPG: +(t.l10GoalsAgainst / l10GP).toFixed(2),
        l10WinPct: +((t.l10Wins / l10GP)).toFixed(3),

        // Streak
        streak: `${t.streakCode}${t.streakCount}`,
        streakCode: t.streakCode, // W or L
        streakCount: t.streakCount,

        // Points
        points: t.points,
        leagueRank: t.leagueSequence,
      };
    }

    res.status(200).json(teams);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
