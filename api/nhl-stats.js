export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SEASON = '20252026';
  const BASE   = 'https://api.nhle.com/stats/rest/en/team';
  const qBase  = `?isAggregate=false&isGame=false&start=0&limit=32&cayenneExp=gameTypeId%3D2%20and%20seasonId%3D${SEASON}`;
  const HEADERS = { 'User-Agent': 'Mozilla/5.0' };

  try {
    // Fetch all NHL stat endpoints + standings in parallel
    const [
      standingsRes,
      specialTeamsRes,   // PP%, PK%, SOG/game, faceoff%
      percentagesRes,    // CF% (satPct), Fenwick% (usatPct), PDO, 5v5 sh%/sv%, zone starts
      realtimeRes,       // hits, giveaways, takeaways, blocked shots
      penaltiesRes,      // penalties taken/drawn per 60
      faceoffRes,        // zone faceoff breakdown (offensive/defensive/neutral)
    ] = await Promise.all([
      fetch('https://api-web.nhle.com/v1/standings/now', { redirect: 'follow', headers: HEADERS }),
      fetch(`${BASE}/summary${qBase}`, { headers: HEADERS }),
      fetch(`${BASE}/percentages${qBase}`, { headers: HEADERS }),
      fetch(`${BASE}/realtime${qBase}`, { headers: HEADERS }),
      fetch(`${BASE}/penalties${qBase}`, { headers: HEADERS }),
      fetch(`${BASE}/faceoffwins${qBase}`, { headers: HEADERS }),
    ]);

    const data = await standingsRes.json();

    // ── Helper: build team lookup map keyed by normalized full name ──
    async function buildMap(response, fields) {
      if (!response.ok) return {};
      try {
        const json = await response.json();
        const map = {};
        for (const t of (json.data || [])) {
          const key = (t.teamFullName || '').toLowerCase().trim();
          map[key] = {};
          for (const f of fields) {
            if (t[f] != null) map[key][f] = t[f];
          }
        }
        return map;
      } catch { return {}; }
    }

    const [specialTeamsMap, percentagesMap, realtimeMap, penaltiesMap, faceoffMap] = await Promise.all([
      buildMap(specialTeamsRes, ['powerPlayPct', 'penaltyKillPct', 'faceoffWinPct', 'shotsForPerGame', 'shotsAgainstPerGame']),
      buildMap(percentagesRes, ['satPct', 'usatPct', 'satPctClose', 'usatPctClose', 'shootingPlusSavePct5v5', 'shootingPct5v5', 'savePct5v5', 'zoneStartPct5v5']),
      buildMap(realtimeRes, ['satPct', 'hits', 'hitsPer60', 'giveaways', 'giveawaysPer60', 'takeaways', 'takeawaysPer60', 'blockedShots']),
      buildMap(penaltiesRes, ['penaltiesTakenPer60', 'penaltiesDrawnPer60', 'netPenalties', 'netPenaltiesPer60']),
      buildMap(faceoffRes, ['faceoffWinPct', 'offensiveZoneFaceoffWins', 'offensiveZoneFaceoffs', 'defensiveZoneFaceoffWins', 'defensiveZoneFaceoffs']),
    ]);

    // Fetch all team schedules to find last game date (for rest days)
    const abbrevList = (data.standings || []).map(t => t.teamAbbrev?.default).filter(Boolean);
    const scheduleMap = {};
    await Promise.allSettled(
      abbrevList.map(abbrev =>
        fetch(`https://api-web.nhle.com/v1/club-schedule-season/${abbrev}/20242025`, { headers: HEADERS })
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (!d) return;
            const today = new Date().toISOString().slice(0, 10);
            const played = (d.games || [])
              .filter(g => g.gameState === 'OFF' && g.gameDate <= today)
              .sort((a, b) => b.gameDate.localeCompare(a.gameDate));
            if (played.length) scheduleMap[abbrev] = played[0].gameDate;
          })
      )
    );

    const teams = {};
    const todayDate = new Date();

    for (const t of (data.standings || [])) {
      const abbrev = t.teamAbbrev?.default;
      if (!abbrev) continue;

      const gp   = t.gamesPlayed || 1;
      const hGP  = t.homeGamesPlayed || 1;
      const rGP  = t.roadGamesPlayed || 1;
      const l10GP = t.l10GamesPlayed || 10;
      const fullName = (t.teamName?.default || '').toLowerCase().trim();

      // Merge all data sources
      const st  = specialTeamsMap[fullName] || {};
      const pct = percentagesMap[fullName]  || {};
      const rt  = realtimeMap[fullName]     || {};
      const pen = penaltiesMap[fullName]    || {};
      const fo  = faceoffMap[fullName]      || {};

      // Rest days
      let restDays = null;
      if (scheduleMap[abbrev]) {
        const lastGame = new Date(scheduleMap[abbrev] + 'T12:00:00Z');
        restDays = Math.floor((todayDate - lastGame) / (1000 * 60 * 60 * 24));
      }

      // Offensive zone faceoff%: drives zone starts → possession
      const ozFO = fo.offensiveZoneFaceoffs > 0
        ? fo.offensiveZoneFaceoffWins / fo.offensiveZoneFaceoffs
        : null;
      const dzFO = fo.defensiveZoneFaceoffs > 0
        ? fo.defensiveZoneFaceoffWins / fo.defensiveZoneFaceoffs
        : null;

      // Takeaway/giveaway ratio: proxy for puck handling quality
      const tgRatio = (rt.giveaways > 0 && rt.takeaways > 0)
        ? rt.takeaways / rt.giveaways
        : null;

      // PDO — league avg = 1.000. shootingPlusSavePct5v5 is expressed as decimal (e.g. 1.012)
      // or sometimes as a percentage-pair sum like 102.5 — normalise both cases
      let pdo = pct.shootingPlusSavePct5v5 ?? null;
      if (pdo != null && pdo > 5) pdo = pdo / 100; // normalise 102.5 → 1.025

      // CF% (satPct) — may come from percentages or realtime endpoint
      // Use close-game satPct as primary (most score-independent), fall back to overall
      const cfPct = pct.satPctClose ?? pct.satPct ?? rt.satPct ?? null;
      const ffPct = pct.usatPctClose ?? pct.usatPct ?? null;  // Fenwick

      teams[abbrev] = {
        name:     t.teamCommonName?.default || abbrev,
        fullName: t.teamName?.default || abbrev,

        // Season totals
        wins: t.wins, losses: t.losses, otLosses: t.otLosses,
        gamesPlayed: gp, winPct: t.winPctg,

        // Goals per game
        goalsForPG:     +(t.goalFor    / gp).toFixed(2),
        goalsAgainstPG: +(t.goalAgainst / gp).toFixed(2),
        goalDiffPG:     +((t.goalFor - t.goalAgainst) / gp).toFixed(2),

        // Home splits
        homeWins: t.homeWins,
        homeLosses: t.homeLosses + (t.homeOtLosses || 0),
        homeGoalsForPG:     +(t.homeGoalsFor     / hGP).toFixed(2),
        homeGoalsAgainstPG: +(t.homeGoalsAgainst / hGP).toFixed(2),
        homeWinPct: +((t.homeWins / hGP)).toFixed(3),

        // Road splits
        roadWins: t.roadWins,
        roadLosses: t.roadLosses + (t.roadOtLosses || 0),
        roadGoalsForPG:     +(t.roadGoalsFor     / rGP).toFixed(2),
        roadGoalsAgainstPG: +(t.roadGoalsAgainst / rGP).toFixed(2),
        roadWinPct: +((t.roadWins / rGP)).toFixed(3),

        // Last 10
        l10Wins: t.l10Wins,
        l10Losses: t.l10Losses + (t.l10OtLosses || 0),
        l10GoalsForPG:     +(t.l10GoalsFor     / l10GP).toFixed(2),
        l10GoalsAgainstPG: +(t.l10GoalsAgainst / l10GP).toFixed(2),
        l10WinPct: +((t.l10Wins / l10GP)).toFixed(3),

        // Streak
        streak: `${t.streakCode}${t.streakCount}`,
        streakCode: t.streakCount ? t.streakCode : null,
        streakCount: t.streakCount,

        // Points + rank
        points: t.points, leagueRank: t.leagueSequence,

        // Rest
        restDays, lastGameDate: scheduleMap[abbrev] || null,

        // ── SPECIAL TEAMS (from team/summary) ──
        ppPct:      st.powerPlayPct      != null ? +st.powerPlayPct.toFixed(4)      : null,
        pkPct:      st.penaltyKillPct    != null ? +st.penaltyKillPct.toFixed(4)    : null,
        faceoffPct: st.faceoffWinPct     != null ? +st.faceoffWinPct.toFixed(4)     : null,
        shotsPG:    st.shotsForPerGame   != null ? +st.shotsForPerGame.toFixed(2)   : null,
        shotsAgPG:  st.shotsAgainstPerGame != null ? +st.shotsAgainstPerGame.toFixed(2) : null,

        // ── POSSESSION / ADVANCED (from team/percentages) ──
        // CF% close: the most score-independent possession metric
        cfPct:      cfPct != null ? +cfPct.toFixed(4) : null,   // e.g. 0.523
        ffPct:      ffPct != null ? +ffPct.toFixed(4) : null,   // Fenwick
        pdo:        pdo   != null ? +pdo.toFixed(4)   : null,   // e.g. 1.023 = 102.3
        shootingPct5v5: pct.shootingPct5v5 != null ? +pct.shootingPct5v5.toFixed(4) : null,
        savePct5v5:     pct.savePct5v5     != null ? +pct.savePct5v5.toFixed(4)     : null,
        zoneStartPct:   pct.zoneStartPct5v5 != null ? +pct.zoneStartPct5v5.toFixed(4) : null,

        // ── PHYSICAL / PUCK HANDLING (from team/realtime) ──
        hitsPerGame:       rt.hits ? +(rt.hits / gp).toFixed(2)           : null,
        giveawaysPer60:    rt.giveawaysPer60  != null ? +rt.giveawaysPer60.toFixed(2)  : null,
        takeawaysPer60:    rt.takeawaysPer60  != null ? +rt.takeawaysPer60.toFixed(2)  : null,
        tgRatio:           tgRatio != null ? +tgRatio.toFixed(3) : null,  // >1 = more TKWs than GVWs

        // ── DISCIPLINE (from team/penalties) ──
        penaltiesTakenPer60:  pen.penaltiesTakenPer60  != null ? +pen.penaltiesTakenPer60.toFixed(2)  : null,
        penaltiesDrawnPer60:  pen.penaltiesDrawnPer60  != null ? +pen.penaltiesDrawnPer60.toFixed(2)  : null,

        // ── ZONE FACEOFFS ──
        ozFaceoffPct: ozFO != null ? +ozFO.toFixed(4) : null,
        dzFaceoffPct: dzFO != null ? +dzFO.toFixed(4) : null,
      };
    }

    res.status(200).json(teams);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
