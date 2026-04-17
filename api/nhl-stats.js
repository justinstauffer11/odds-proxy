export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Fetch standings + all team schedules in parallel for rest-day calculation
    // Standings has everything except last game date; schedule gives us that.
    const standingsReq = fetch('https://api-web.nhle.com/v1/standings/now', {
      redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    // Get all 32 team abbreviations from standings first, then fetch schedules
    const standingsRes = await standingsReq;
    const data = await standingsRes.json();

    // Build abbreviation list
    const abbrevList = (data.standings || [])
      .map(t => t.teamAbbrev?.default)
      .filter(Boolean);

    // Fetch all team schedules in parallel to find last game date
    // Using current season schedule — only need last played game date
    const scheduleMap = {};
    const scheduleResults = await Promise.allSettled(
      abbrevList.map(abbrev =>
        fetch(`https://api-web.nhle.com/v1/club-schedule-season/${abbrev}/20242025`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d) return;
          const today = new Date().toISOString().slice(0, 10);
          // Find most recent completed game
          const played = (d.games || [])
            .filter(g => g.gameState === 'OFF' && g.gameDate <= today)
            .sort((a, b) => b.gameDate.localeCompare(a.gameDate));
          if (played.length) scheduleMap[abbrev] = played[0].gameDate;
        })
      )
    );

    // Reshape standings into clean lookup map keyed by team abbreviation
    const teams = {};
    const todayDate = new Date();

    for (const t of (data.standings || [])) {
      const abbrev = t.teamAbbrev?.default;
      if (!abbrev) continue;

      const gp = t.gamesPlayed || 1;
      const homeGP = t.homeGamesPlayed || 1;
      const roadGP = t.roadGamesPlayed || 1;
      const l10GP = t.l10GamesPlayed || 10;

      // Rest days: days since last game (null if unknown)
      let restDays = null;
      if (scheduleMap[abbrev]) {
        const lastGame = new Date(scheduleMap[abbrev] + 'T12:00:00Z');
        restDays = Math.floor((todayDate - lastGame) / (1000 * 60 * 60 * 24));
      }

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
        streakCode: t.streakCode,
        streakCount: t.streakCount,

        // Points + rank
        points: t.points,
        leagueRank: t.leagueSequence,

        // Rest days since last game (null = unknown, 0 = played today/yesterday)
        restDays,
        lastGameDate: scheduleMap[abbrev] || null,
      };
    }

    res.status(200).json(teams);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
