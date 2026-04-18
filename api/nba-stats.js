export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

  // ESPN team ID map — needed to fetch per-team advanced stats
  // Format: abbreviation -> ESPN numeric id
  const ESPN_IDS = {
    ATL:1, BOS:2, BKN:17, CHA:30, CHI:4, CLE:5, DAL:6, DEN:7, DET:8, GSW:9,
    HOU:10, IND:11, LAC:12, LAL:13, MEM:29, MIA:14, MIL:15, MIN:16, NOP:3,
    NYK:18, OKC:25, ORL:19, PHI:20, PHX:21, POR:22, SAC:23, SAS:24, TOR:28,
    UTA:26, WAS:27,
  };

  try {
    // ── 1. Standings (wins/losses/streaks/splits) ──────────────────────────
    const standingsRes = await fetch(
      'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=2025',
      { headers: HEADERS }
    );
    const standingsData = await standingsRes.json();

    // ── 2. Fetch per-team advanced stats in parallel (offense + defense + general) ──
    // Each call returns eFG%, FG%, 3P%, FT%, rebounds, assists, turnovers, steals, blocks
    const teamAbbrevs = Object.keys(ESPN_IDS);
    const teamStatResults = await Promise.allSettled(
      teamAbbrevs.map(abbr =>
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${ESPN_IDS[abbr]}/statistics`, { headers: HEADERS })
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (!d) return { abbr, stats: {} };
            const cats = d.results?.stats?.categories || [];
            const statMap = {};
            for (const cat of cats) {
              for (const s of (cat.stats || [])) {
                statMap[s.name] = s.value;
              }
            }
            return { abbr, stats: statMap };
          })
      )
    );

    const advancedByAbbr = {};
    for (const r of teamStatResults) {
      if (r.status === 'fulfilled' && r.value) {
        advancedByAbbr[r.value.abbr] = r.value.stats;
      }
    }

    // ── 3. Build team objects ──────────────────────────────────────────────
    const teams = {};

    for (const conf of (standingsData.children || [])) {
      for (const entry of (conf.standings?.entries || [])) {
        const t    = entry.team;
        const abbr = t.abbreviation;
        if (!abbr) continue;

        // Parse stats array from standings
        const stats = {};
        for (const s of (entry.stats || [])) {
          stats[s.name] = { value: s.value, display: s.displayValue, summary: s.summary };
        }

        function parseRecord(summary) {
          if (!summary) return { wins: 0, losses: 0, gp: 1 };
          const [w, l] = summary.split('-').map(Number);
          return { wins: w || 0, losses: l || 0, gp: (w || 0) + (l || 0) || 1 };
        }

        const overall = parseRecord(stats['overall']?.summary);
        const home    = parseRecord(stats['Home']?.summary);
        const road    = parseRecord(stats['Road']?.summary);
        const l10     = parseRecord(stats['Last Ten Games']?.summary);

        const gp      = overall.gp || 1;
        const ppg     = stats['avgPointsFor']?.value  || 0;
        const oppPpg  = stats['avgPointsAgainst']?.value || 0;

        const streakVal   = stats['streak']?.value ?? 0;
        const streakCode  = streakVal >= 0 ? 'W' : 'L';
        const streakCount = Math.abs(streakVal);

        // ── Advanced stats from per-team endpoint ──
        const adv = advancedByAbbr[abbr] || {};

        // eFG% = (FGM + 0.5 * 3PM) / FGA  — shooting efficiency
        const fgm  = adv['fieldGoalsMade']     || 0;
        const fga  = adv['fieldGoalsAttempted'] || 1;
        const tpm  = adv['threePointFieldGoalsMade'] || 0;
        const efgPct = fga > 0 ? (fgm + 0.5 * tpm) / fga : null;

        // True Shooting % = PTS / (2 * (FGA + 0.44 * FTA))
        const pts  = adv['points'] || 0;
        const fta  = adv['freeThrowsAttempted'] || 0;
        const tsPct = (fga + 0.44 * fta) > 0 ? pts / (2 * (fga + 0.44 * fta)) : null;

        // Four Factors
        const ftm  = adv['freeThrowsMade'] || 0;
        const tovPct = adv['turnovers'] && fga > 0
          ? adv['turnovers'] / (fga + 0.44 * fta + adv['turnovers'])
          : null;
        const ftRate = fga > 0 ? fta / fga : null;  // FTA/FGA — gets to the line
        const orbPct = adv['offensiveRebounds'] && adv['totalRebounds']
          ? adv['offensiveRebounds'] / adv['totalRebounds']
          : null;

        // Shooting per game
        const avgPts    = adv['avgPoints']     || ppg;
        const avgFgPct  = adv['fieldGoalPct']  || null;
        const avg3pPct  = adv['threePointPct'] || null;
        const avgFtPct  = adv['freeThrowPct']  || null;
        const avgAst    = adv['avgAssists']    || null;
        const avgTov    = adv['avgTurnovers']  || null;
        const avgReb    = adv['avgRebounds']   || null;
        const avgStl    = adv['avgSteals']     || null;
        const avgBlk    = adv['avgBlocks']     || null;
        const astTovRatio = adv['assistTurnoverRatio'] || null;

        // Defensive efficiency proxy: blocks + steals per game vs league avg
        // NBA avg: steals ~7.5/g, blocks ~5.0/g
        const defIntensity = (avgStl != null && avgBlk != null)
          ? ((avgStl - 7.5) / 7.5 + (avgBlk - 5.0) / 5.0) / 2  // -1 to +1 scale approx
          : null;

        teams[abbr] = {
          name:      t.shortDisplayName || t.displayName || abbr,
          fullName:  t.displayName || abbr,
          espnId:    ESPN_IDS[abbr] || null,

          // Season
          wins: overall.wins, losses: overall.losses, gamesPlayed: gp,
          winPct: stats['winPercent']?.value ?? (overall.wins / gp),
          pointsPG:    +ppg.toFixed(1),
          oppPointsPG: +oppPpg.toFixed(1),
          pointDiffPG: +(ppg - oppPpg).toFixed(1),

          // Home
          homeWins: home.wins, homeLosses: home.losses, homeGP: home.gp,
          homeWinPct: home.gp > 0 ? +(home.wins / home.gp).toFixed(3) : 0,
          homeRecord: `${home.wins}-${home.losses}`,

          // Road
          roadWins: road.wins, roadLosses: road.losses, roadGP: road.gp,
          roadWinPct: road.gp > 0 ? +(road.wins / road.gp).toFixed(3) : 0,
          roadRecord: `${road.wins}-${road.losses}`,

          // L10
          l10Wins: l10.wins, l10Losses: l10.losses, l10GP: l10.gp || 10,
          l10WinPct: l10.gp > 0 ? +(l10.wins / l10.gp).toFixed(3) : 0,
          l10Record: `${l10.wins}-${l10.losses}`,

          // Streak
          streak: stats['streak']?.display || '—',
          streakCode, streakCount, streakVal,

          // Seeds / rank
          playoffSeed: stats['playoffSeed']?.value ?? 99,

          // ── ADVANCED (Four Factors + shooting) ──
          // Shooting
          fgPct:    avgFgPct != null ? +(avgFgPct).toFixed(1) : null,    // e.g. 47.2
          threePct: avg3pPct != null ? +(avg3pPct).toFixed(1) : null,    // e.g. 36.5
          ftPct:    avgFtPct != null ? +(avgFtPct).toFixed(1) : null,    // e.g. 76.8

          // Four Factors (Oliver): eFG%, TOV%, ORB%, FT rate
          efgPct:   efgPct  != null ? +(efgPct * 100).toFixed(1)  : null, // e.g. 54.2
          tsPct:    tsPct   != null ? +(tsPct  * 100).toFixed(1)  : null, // e.g. 58.4
          tovPct:   tovPct  != null ? +(tovPct * 100).toFixed(1)  : null, // e.g. 13.8
          ftRate:   ftRate  != null ? +(ftRate * 100).toFixed(1)  : null, // e.g. 27.3
          orbPct:   orbPct  != null ? +(orbPct * 100).toFixed(1)  : null, // e.g. 24.5

          // Per-game
          astPG:  avgAst  != null ? +avgAst.toFixed(1)  : null,
          tovPG:  avgTov  != null ? +avgTov.toFixed(1)  : null,
          rebPG:  avgReb  != null ? +avgReb.toFixed(1)  : null,
          stlPG:  avgStl  != null ? +avgStl.toFixed(1)  : null,
          blkPG:  avgBlk  != null ? +avgBlk.toFixed(1)  : null,
          astTovRatio: astTovRatio != null ? +astTovRatio.toFixed(2) : null,
          defIntensity: defIntensity != null ? +defIntensity.toFixed(3) : null,
        };
      }
    }

    res.status(200).json(teams);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
