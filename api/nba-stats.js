// nba-stats.js — Round 1 NBA upgrade
//
// Adds NHL-parity data fields:
//   • restDays + lastGameDate         (rest differential signal)
//   • home/road points-for/against PG (venue scoring splits)
//   • L10 points-for/against PG       (recent scoring trend)
//   • pace estimate                   (possessions per game)
//   • opponent shooting splits        (3pt% allowed, eFG% allowed)
//   • threeRate                       (3pt-attempt rate — feeds 3pt regression)
//
// Strategy:
//   1) Standings (1 call) for record, splits summary, season points-for/against
//   2) Per-team /statistics endpoint (30 parallel) for shooting + opponent splits
//   3) Per-team /schedule endpoint   (30 parallel) for rest days + L10 scoring
//
// All scheduling work is heavily defensive — if any single call fails, the
// rest of the build still works. Missing fields surface as null on output.

export default async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘GET, OPTIONS’);
if (req.method === ‘OPTIONS’) return res.status(200).end();

const HEADERS = { ‘User-Agent’: ‘Mozilla/5.0’, ‘Accept’: ‘application/json’ };

const ESPN_IDS = {
ATL:1, BOS:2, BKN:17, CHA:30, CHI:4, CLE:5, DAL:6, DEN:7, DET:8, GSW:9,
HOU:10, IND:11, LAC:12, LAL:13, MEM:29, MIA:14, MIL:15, MIN:16, NOP:3,
NYK:18, OKC:25, ORL:19, PHI:20, PHX:21, POR:22, SAC:23, SAS:24, TOR:28,
UTA:26, WAS:27,
};

// Possessions per game estimate (Oliver simplified):
//   poss ≈ (FGA + 0.475*FTA - OREB + TOV) / GP
// Returns possessions per single team’s game; doubled this is roughly the
// standard “pace” stat. Modern NBA pace ≈ 99-101.
function estimatePace(adv) {
const fga  = adv[‘fieldGoalsAttempted’]     || 0;
const fta  = adv[‘freeThrowsAttempted’]     || 0;
const oreb = adv[‘offensiveRebounds’]       || 0;
const tov  = adv[‘turnovers’]               || 0;
const gp   = adv[‘gamesPlayed’]             || 1;
if (fga === 0) return null;
const teamPossessionsPG = (fga + 0.475 * fta - oreb + tov) / gp;
return +(teamPossessionsPG).toFixed(1);
}

try {
// ── 1. Standings ──
const standingsRes = await fetch(
‘https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=2025’,
{ headers: HEADERS }
);
const standingsData = await standingsRes.json();

```
const teamAbbrevs = Object.keys(ESPN_IDS);

// ── 2. Per-team statistics (parallel) ──
// ESPN groups stats into categories like 'general', 'offensive', 'defensive'.
// Defensive category contains the opponent stats — what other teams did vs us.
const teamStatResults = await Promise.allSettled(
  teamAbbrevs.map(abbr =>
    fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${ESPN_IDS[abbr]}/statistics`,
      { headers: HEADERS }
    )
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return { abbr, stats: {}, opp: {} };
        const cats = d.results?.stats?.categories || [];
        const statMap = {};
        const oppMap  = {};
        for (const cat of cats) {
          const isDef = cat.name === 'defensive';
          for (const s of (cat.stats || [])) {
            if (isDef) oppMap[s.name] = s.value;
            else       statMap[s.name] = s.value;
          }
        }
        return { abbr, stats: statMap, opp: oppMap };
      })
      .catch(() => ({ abbr, stats: {}, opp: {} }))
  )
);
const advancedByAbbr = {};
const oppByAbbr      = {};
for (const r of teamStatResults) {
  if (r.status === 'fulfilled' && r.value) {
    advancedByAbbr[r.value.abbr] = r.value.stats;
    oppByAbbr[r.value.abbr]      = r.value.opp;
  }
}

// ── 3. Per-team schedule (parallel) for rest + L10 + venue scoring ──
const todayMs = Date.now();
const scheduleResults = await Promise.allSettled(
  teamAbbrevs.map(abbr =>
    fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${ESPN_IDS[abbr]}/schedule`,
      { headers: HEADERS }
    )
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d || !Array.isArray(d.events)) return { abbr };
        const teamId = String(ESPN_IDS[abbr]);
        const completed = d.events
          .filter(ev => ev.competitions?.[0]?.status?.type?.completed)
          .map(ev => {
            const comp = ev.competitions[0];
            const us   = comp.competitors.find(c => c.team?.id === teamId);
            const them = comp.competitors.find(c => c.team?.id !== teamId);
            if (!us || !them) return null;
            return {
              date:        ev.date,
              ourScore:    parseInt(us.score, 10) || 0,
              theirScore:  parseInt(them.score, 10) || 0,
              homeAway:    us.homeAway,
            };
          })
          .filter(Boolean)
          .sort((a, b) => new Date(b.date) - new Date(a.date));

        if (!completed.length) return { abbr };

        const lastDate = completed[0].date;
        const l10 = completed.slice(0, 10);
        const l10For = l10.reduce((s, g) => s + g.ourScore, 0)   / l10.length;
        const l10Ag  = l10.reduce((s, g) => s + g.theirScore, 0) / l10.length;

        // Venue scoring splits — use ALL home/road games to date for stability
        const homeGames = completed.filter(g => g.homeAway === 'home');
        const roadGames = completed.filter(g => g.homeAway === 'away');
        const avg = (arr, k) => arr.length
          ? +(arr.reduce((s, g) => s + g[k], 0) / arr.length).toFixed(1)
          : null;

        return {
          abbr, lastDate,
          l10Pts:    +l10For.toFixed(1),
          l10OppPts: +l10Ag.toFixed(1),
          homePtsFor: avg(homeGames, 'ourScore'),
          homePtsAg:  avg(homeGames, 'theirScore'),
          roadPtsFor: avg(roadGames, 'ourScore'),
          roadPtsAg:  avg(roadGames, 'theirScore'),
        };
      })
      .catch(() => ({ abbr }))
  )
);
const scheduleByAbbr = {};
for (const r of scheduleResults) {
  if (r.status === 'fulfilled' && r.value) {
    scheduleByAbbr[r.value.abbr] = r.value;
  }
}

// ── 4. Build team objects ──
const teams = {};

for (const conf of (standingsData.children || [])) {
  for (const entry of (conf.standings?.entries || [])) {
    const t    = entry.team;
    const abbr = t.abbreviation;
    if (!abbr) continue;

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
    const ppg     = stats['avgPointsFor']?.value     || 0;
    const oppPpg  = stats['avgPointsAgainst']?.value || 0;

    const streakVal   = stats['streak']?.value ?? 0;
    const streakCode  = streakVal >= 0 ? 'W' : 'L';
    const streakCount = Math.abs(streakVal);

    const adv   = advancedByAbbr[abbr] || {};
    const opp   = oppByAbbr[abbr]      || {};
    const sched = scheduleByAbbr[abbr] || {};

    // ── Existing computed stats (preserved from v4) ──
    const fgm  = adv['fieldGoalsMade']      || 0;
    const fga  = adv['fieldGoalsAttempted'] || 1;
    const tpm  = adv['threePointFieldGoalsMade']      || 0;
    const tpa  = adv['threePointFieldGoalsAttempted'] || 0;
    const efgPct = fga > 0 ? (fgm + 0.5 * tpm) / fga : null;
    const pts  = adv['points'] || 0;
    const fta  = adv['freeThrowsAttempted'] || 0;
    const tsPct = (fga + 0.44 * fta) > 0 ? pts / (2 * (fga + 0.44 * fta)) : null;

    const tovPct = adv['turnovers'] && fga > 0
      ? adv['turnovers'] / (fga + 0.44 * fta + adv['turnovers'])
      : null;
    const ftRate = fga > 0 ? fta / fga : null;
    const orbPct = adv['offensiveRebounds'] && adv['totalRebounds']
      ? adv['offensiveRebounds'] / adv['totalRebounds']
      : null;

    const avgFgPct  = adv['fieldGoalPct']    || null;
    const avg3pPct  = adv['threePointPct']   || null;
    const avgFtPct  = adv['freeThrowPct']    || null;
    const avgAst    = adv['avgAssists']      || null;
    const avgTov    = adv['avgTurnovers']    || null;
    const avgReb    = adv['avgRebounds']     || null;
    const avgStl    = adv['avgSteals']       || null;
    const avgBlk    = adv['avgBlocks']       || null;
    const astTovRatio = adv['assistTurnoverRatio'] || null;

    const defIntensity = (avgStl != null && avgBlk != null)
      ? ((avgStl - 7.5) / 7.5 + (avgBlk - 5.0) / 5.0) / 2
      : null;

    // ── ROUND 1 NEW FIELDS ──

    // Pace
    const pace = estimatePace(adv);

    // 3pt attempt rate
    const threeRate = fga > 0 ? tpa / fga : null;

    // Opponent shooting (defensive proxy)
    const oppFgm  = opp['fieldGoalsMade']                || 0;
    const oppFga  = opp['fieldGoalsAttempted']           || 0;
    const opp3pm  = opp['threePointFieldGoalsMade']      || 0;
    const opp3pa  = opp['threePointFieldGoalsAttempted'] || 0;
    const oppEfgPct   = oppFga > 0 ? (oppFgm + 0.5 * opp3pm) / oppFga : null;
    const oppThreePct = opp3pa > 0 ? opp3pm / opp3pa : null;

    // Rest days
    let restDays = null;
    let lastGameDate = null;
    if (sched.lastDate) {
      const lastMs = new Date(sched.lastDate).getTime();
      if (Number.isFinite(lastMs) && lastMs <= todayMs) {
        restDays = Math.floor((todayMs - lastMs) / (24 * 60 * 60 * 1000));
        lastGameDate = sched.lastDate;
      }
    }

    // Venue scoring splits
    const homePointsForPG     = sched.homePtsFor ?? null;
    const homePointsAgainstPG = sched.homePtsAg  ?? null;
    const roadPointsForPG     = sched.roadPtsFor ?? null;
    const roadPointsAgainstPG = sched.roadPtsAg  ?? null;

    // L10 scoring
    const l10PointsForPG     = sched.l10Pts    ?? null;
    const l10PointsAgainstPG = sched.l10OppPts ?? null;
    const l10PointDiffPG     = (l10PointsForPG != null && l10PointsAgainstPG != null)
      ? +(l10PointsForPG - l10PointsAgainstPG).toFixed(1)
      : null;

    teams[abbr] = {
      name:      t.shortDisplayName || t.displayName || abbr,
      fullName:  t.displayName || abbr,
      espnId:    ESPN_IDS[abbr] || null,

      // Season record
      wins: overall.wins, losses: overall.losses, gamesPlayed: gp,
      winPct: stats['winPercent']?.value ?? (overall.wins / gp),
      pointsPG:    +ppg.toFixed(1),
      oppPointsPG: +oppPpg.toFixed(1),
      pointDiffPG: +(ppg - oppPpg).toFixed(1),

      // Home/road records
      homeWins: home.wins, homeLosses: home.losses, homeGP: home.gp,
      homeWinPct: home.gp > 0 ? +(home.wins / home.gp).toFixed(3) : 0,
      homeRecord: `${home.wins}-${home.losses}`,
      roadWins: road.wins, roadLosses: road.losses, roadGP: road.gp,
      roadWinPct: road.gp > 0 ? +(road.wins / road.gp).toFixed(3) : 0,
      roadRecord: `${road.wins}-${road.losses}`,

      // L10 record
      l10Wins: l10.wins, l10Losses: l10.losses, l10GP: l10.gp || 10,
      l10WinPct: l10.gp > 0 ? +(l10.wins / l10.gp).toFixed(3) : 0,
      l10Record: `${l10.wins}-${l10.losses}`,

      streak: stats['streak']?.display || '—',
      streakCode, streakCount, streakVal,
      playoffSeed: stats['playoffSeed']?.value ?? 99,

      // Shooting
      fgPct:    avgFgPct != null ? +(avgFgPct).toFixed(1) : null,
      threePct: avg3pPct != null ? +(avg3pPct).toFixed(1) : null,
      ftPct:    avgFtPct != null ? +(avgFtPct).toFixed(1) : null,

      // Four Factors
      efgPct:   efgPct  != null ? +(efgPct * 100).toFixed(1)  : null,
      tsPct:    tsPct   != null ? +(tsPct  * 100).toFixed(1)  : null,
      tovPct:   tovPct  != null ? +(tovPct * 100).toFixed(1)  : null,
      ftRate:   ftRate  != null ? +(ftRate * 100).toFixed(1)  : null,
      orbPct:   orbPct  != null ? +(orbPct * 100).toFixed(1)  : null,

      // Per-game
      astPG:  avgAst  != null ? +avgAst.toFixed(1)  : null,
      tovPG:  avgTov  != null ? +avgTov.toFixed(1)  : null,
      rebPG:  avgReb  != null ? +avgReb.toFixed(1)  : null,
      stlPG:  avgStl  != null ? +avgStl.toFixed(1)  : null,
      blkPG:  avgBlk  != null ? +avgBlk.toFixed(1)  : null,
      astTovRatio: astTovRatio != null ? +astTovRatio.toFixed(2) : null,
      defIntensity: defIntensity != null ? +defIntensity.toFixed(3) : null,

      // ── ROUND 1 NEW ──
      restDays,
      lastGameDate,
      homePointsForPG,
      homePointsAgainstPG,
      roadPointsForPG,
      roadPointsAgainstPG,
      l10PointsForPG,
      l10PointsAgainstPG,
      l10PointDiffPG,
      pace,
      threeRate:    threeRate    != null ? +(threeRate    * 100).toFixed(1) : null,
      oppEfgPct:    oppEfgPct    != null ? +(oppEfgPct    * 100).toFixed(1) : null,
      oppThreePct:  oppThreePct  != null ? +(oppThreePct  * 100).toFixed(1) : null,
    };
  }
}

res.status(200).json(teams);
```

} catch (e) {
res.status(500).json({ error: e.message, stack: e.stack });
}
}
