export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ESPN public standings API — free, no key, returns all 30 teams
    // with PPG, opp PPG, win%, home/road splits, L10, streak, point differential
    const r = await fetch(
      'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=2025',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    const data = await r.json();

    const teams = {};

    for (const conf of (data.children || [])) {
      for (const entry of (conf.standings?.entries || [])) {
        const t    = entry.team;
        const abbr = t.abbreviation;
        if (!abbr) continue;

        // Build a stat lookup map from the stats array
        const stats = {};
        for (const s of (entry.stats || [])) {
          stats[s.name] = { value: s.value, display: s.displayValue, summary: s.summary };
        }

        // Parse home/road/L10 from summary strings like "34-7"
        function parseRecord(summary) {
          if (!summary) return { wins: 0, losses: 0, gp: 1 };
          const [w, l] = summary.split('-').map(Number);
          return { wins: w || 0, losses: l || 0, gp: (w || 0) + (l || 0) || 1 };
        }

        const overall = parseRecord(stats['overall']?.summary);
        const home    = parseRecord(stats['Home']?.summary);
        const road    = parseRecord(stats['Road']?.summary);
        const l10     = parseRecord(stats['Last Ten Games']?.summary);

        const gp       = overall.gp || 1;
        const ppg      = stats['avgPointsFor']?.value  || 0;
        const oppPpg   = stats['avgPointsAgainst']?.value || 0;
        const pointDiff = ppg - oppPpg;

        // Streak: ESPN returns negative for losses (e.g. -1 = L1), positive for wins
        const streakVal  = stats['streak']?.value ?? 0;
        const streakDisp = stats['streak']?.display || '—';
        const streakCode = streakVal >= 0 ? 'W' : 'L';
        const streakCount = Math.abs(streakVal);

        teams[abbr] = {
          name:          t.shortDisplayName || t.displayName || abbr,
          fullName:      t.displayName || abbr,

          // Overall season
          wins:          overall.wins,
          losses:        overall.losses,
          gamesPlayed:   gp,
          winPct:        stats['winPercent']?.value ?? (overall.wins / gp),
          pointsPG:      +ppg.toFixed(1),
          oppPointsPG:   +oppPpg.toFixed(1),
          pointDiffPG:   +pointDiff.toFixed(1),

          // Home splits
          homeWins:      home.wins,
          homeLosses:    home.losses,
          homeGP:        home.gp,
          homeWinPct:    home.gp > 0 ? +(home.wins / home.gp).toFixed(3) : 0,

          // Road splits
          roadWins:      road.wins,
          roadLosses:    road.losses,
          roadGP:        road.gp,
          roadWinPct:    road.gp > 0 ? +(road.wins / road.gp).toFixed(3) : 0,

          // Last 10
          l10Wins:       l10.wins,
          l10Losses:     l10.losses,
          l10GP:         l10.gp || 10,
          l10WinPct:     l10.gp > 0 ? +(l10.wins / l10.gp).toFixed(3) : 0,

          // Streak
          streak:        streakDisp,
          streakCode,
          streakCount,
          streakVal,

          // Display records (for UI)
          homeRecord:    `${home.wins}-${home.losses}`,
          roadRecord:    `${road.wins}-${road.losses}`,
          l10Record:     `${l10.wins}-${l10.losses}`,

          // Rankings
          playoffSeed:   stats['playoffSeed']?.value ?? 99,
          leagueWinPct:  stats['leagueWinPercent']?.value ?? 0,
        };
      }
    }

    res.status(200).json(teams);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
