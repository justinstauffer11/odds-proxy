export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

  // ESPN MLB team IDs (abbreviation → numeric ID)
  const ESPN_IDS = {
    BAL:1, BOS:2, LAA:3, CHW:4, CLE:5, DET:6, KC:7, MIL:8, MIN:9, NYY:10,
    OAK:11, SEA:12, TEX:13, TOR:14, ATL:15, CHC:16, CIN:17, HOU:18, LAD:19,
    WSH:20, NYM:21, PHI:22, PIT:23, STL:24, SD:25, SF:26, COL:27, MIA:28,
    ARI:29, TB:30,
    // ESPN uses ATH for Oakland now
    ATH:11,
  };

  try {
    // ── 1. Standings (wins, losses, home/road splits, L10, streak, R/G, RA/G) ──
    const standingsRes = await fetch(
      'https://site.api.espn.com/apis/v2/sports/baseball/mlb/standings',
      { headers: HEADERS }
    );
    const standingsData = await standingsRes.json();

    // ── 2. Per-team batting + pitching stats in parallel ──
    const teamAbbrevs = Object.keys(ESPN_IDS).filter((k, i, arr) => arr.indexOf(k) === i);
    const teamStatResults = await Promise.allSettled(
      teamAbbrevs.map(abbr =>
        fetch(
          `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/${ESPN_IDS[abbr]}/statistics`,
          { headers: HEADERS }
        )
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (!d) return { abbr, batting: {}, pitching: {} };
            const cats = d.results?.stats?.categories || [];
            const batting  = {};
            const pitching = {};
            for (const cat of cats) {
              const target = cat.name === 'batting' ? batting : cat.name === 'pitching' ? pitching : null;
              if (!target) continue;
              for (const s of (cat.stats || [])) {
                target[s.name] = s.value;
              }
            }
            return { abbr, batting, pitching };
          })
          .catch(() => ({ abbr, batting: {}, pitching: {} }))
      )
    );

    const statsByAbbr = {};
    for (const r of teamStatResults) {
      if (r.status === 'fulfilled' && r.value) {
        statsByAbbr[r.value.abbr] = { batting: r.value.batting, pitching: r.value.pitching };
      }
    }

    // ── 3. Build team objects ──────────────────────────────────────────────
    const teams = {};

    for (const group of (standingsData.children || [])) {
      for (const entry of (group.standings?.entries || [])) {
        const t    = entry.team;
        const abbr = t.abbreviation;
        if (!abbr) continue;

        // Parse standings stats array into a map
        const st = {};
        for (const s of (entry.stats || [])) {
          st[s.name] = { value: s.value, display: s.displayValue, summary: s.summary };
        }

        function parseRecord(summary) {
          if (!summary) return { wins: 0, losses: 0, gp: 0 };
          const parts = summary.split('-').map(Number);
          const w = parts[0] || 0, l = parts[1] || 0;
          return { wins: w, losses: l, gp: w + l };
        }

        const overall = parseRecord(st['overall']?.summary);
        const home    = parseRecord(st['Home']?.summary);
        const road    = parseRecord(st['Road']?.summary);
        const l10     = parseRecord(st['Last Ten Games']?.summary);

        const gp          = overall.gp  || Math.max(1, (st['gamesPlayed']?.value ?? 1));
        const wins        = overall.wins;
        const losses      = overall.losses;
        const winPct      = gp > 0 ? wins / gp : 0.5;

        // Runs for/against per game from standings
        const runsFor       = st['pointsFor']?.value     ?? 0;
        const runsAgainst   = st['pointsAgainst']?.value ?? 0;
        const runsPerGame   = gp > 0 ? +(runsFor     / gp).toFixed(2) : 4.5;
        const raPerGame     = gp > 0 ? +(runsAgainst / gp).toFixed(2) : 4.5;
        const runDiffPerGame = +(runsPerGame - raPerGame).toFixed(2);

        // Home/road splits
        const homeWinPct = home.gp > 0 ? +(home.wins / home.gp).toFixed(3) : winPct;
        const roadWinPct = road.gp > 0 ? +(road.wins / road.gp).toFixed(3) : winPct;
        const homeRecord = `${home.wins}-${home.losses}`;
        const roadRecord = `${road.wins}-${road.losses}`;

        // L10
        const l10WinPct  = l10.gp  > 0 ? +(l10.wins / l10.gp).toFixed(3) : winPct;
        const l10Record  = `${l10.wins}-${l10.losses}`;
        const l10RunDiff = null; // not available in standings

        // Streak: positive = win streak, negative = losing streak
        const streakRaw   = st['streak']?.value ?? 0;
        const streakCode  = streakRaw >= 0 ? 'W' : 'L';
        const streakCount = Math.abs(streakRaw);
        const streakDisplay = st['streak']?.display || '—';

        // ── Advanced batting stats (from per-team endpoint) ──
        const bat = statsByAbbr[abbr]?.batting || {};
        const pit = statsByAbbr[abbr]?.pitching || {};

        // Batting
        const avg    = bat['AVG']  ?? null;  // team batting avg e.g. 0.258
        const obp    = bat['OBP']  ?? null;  // on-base %       e.g. 0.330
        const slg    = bat['SLG']  ?? null;  // slugging        e.g. 0.420
        const ops    = (obp != null && slg != null) ? +(obp + slg).toFixed(3) : null;
        const hrPG   = bat['HR'] && gp > 0  ? +(bat['HR'] / gp).toFixed(2) : null;  // HR/game
        const kPct   = bat['SO'] && bat['AB'] && bat['AB'] > 0
          ? +(bat['SO'] / bat['AB'] * 100).toFixed(1) : null; // strikeout %
        const bbPct  = bat['BB'] && bat['AB'] && bat['AB'] > 0
          ? +(bat['BB'] / bat['AB'] * 100).toFixed(1) : null; // walk %
        const rbiPG  = bat['RBI'] && gp > 0 ? +(bat['RBI'] / gp).toFixed(2) : null;
        const sbPG   = bat['SB']  && gp > 0 ? +(bat['SB']  / gp).toFixed(2) : null;

        // Pitching
        const era      = pit['ERA']   ?? null;  // e.g. 3.75
        const whip     = pit['WHIP']  ?? null;  // e.g. 1.22
        const kPer9    = pit['K/9']   ?? null;  // strikeouts per 9 IP
        const bbPer9   = pit['BB'] && pit['G'] ? null : null; // not directly available
        const qualStart= pit['QS']    ?? null;  // quality starts
        const saves    = pit['SV']    ?? null;
        const holds    = pit['HLD']   ?? null;
        const svPct    = (saves != null && qualStart != null)
          ? null : null; // would need blown saves
        const pitcherHR = pit['HR'] && gp > 0 ? +(pit['HR'] / gp).toFixed(2) : null; // HR allowed/G

        // Derived: Bullpen quality proxy
        // Quality starts / games pitched tells us how often starters go deep
        // More QS = less wear on bullpen. Combine with WHIP + ERA for proxy.
        const qsPct = qualStart != null && gp > 0 ? +(qualStart / gp).toFixed(3) : null;

        // ── Build OPS+ proxy (vs MLB avg) ──
        // MLB avg OPS ≈ 0.720. Each 0.01 above/below = meaningful edge.
        const opsDiffFromAvg = ops != null ? +(ops - 0.720).toFixed(3) : null;

        // ── ERA+ proxy (vs MLB avg ERA ≈ 4.10) ──
        const eraVsAvg = era != null ? +(4.10 - era).toFixed(2) : null; // positive = better than avg

        // ── FIP proxy: 13*HR + 3*BB - 2*K / IP  (simplified) ──
        // We don't have IP directly, but K/9 * IP/9 and HR/game let us estimate
        // If all we have is K/9, WHIP, ERA — use combined pitching score instead
        const pitchingScore = era != null && whip != null
          ? Math.max(0, Math.min(1, 1 - (era - 2.0) / 5.0) * 0.5 + Math.max(0, Math.min(1, 1 - (whip - 0.90) / 1.0)) * 0.5)
          : null;

        teams[abbr] = {
          abbrev: abbr,
          name:     t.shortDisplayName || t.displayName || abbr,
          fullName: t.displayName || abbr,
          espnId:   ESPN_IDS[abbr] || null,

          // Season record
          wins, losses, gamesPlayed: gp, winPct: +winPct.toFixed(3),
          record: `${wins}-${losses}`,

          // Scoring
          runsPerGame, raPerGame, runDiffPerGame,
          totalRunsFor: +runsFor.toFixed(0), totalRunsAgainst: +runsAgainst.toFixed(0),

          // Home/road
          homeWinPct, homeRecord,
          homeWins: home.wins, homeLosses: home.losses, homeGP: home.gp,
          roadWinPct, roadRecord,
          roadWins: road.wins, roadLosses: road.losses, roadGP: road.gp,

          // L10
          l10WinPct, l10Record, l10Wins: l10.wins, l10Losses: l10.losses,

          // Streak
          streakCode, streakCount, streakDisplay,

          // ── Batting ──
          avg:    avg  != null ? +avg.toFixed(3)  : null,  // e.g. 0.258
          obp:    obp  != null ? +obp.toFixed(3)  : null,  // e.g. 0.330
          slg:    slg  != null ? +slg.toFixed(3)  : null,  // e.g. 0.420
          ops:    ops  != null ? +ops.toFixed(3)  : null,  // e.g. 0.750
          opsDiffFromAvg,                                  // e.g. +0.030
          hrPG, kPct, bbPct, rbiPG, sbPG,

          // ── Pitching ──
          era:    era     != null ? +era.toFixed(2)    : null,
          whip:   whip    != null ? +whip.toFixed(3)   : null,
          kPer9:  kPer9   != null ? +kPer9.toFixed(1)  : null,
          qsPct,                                           // quality start rate
          pitcherHRpg: pitcherHR,                          // HR allowed per game
          eraVsAvg,                                        // positive = better than avg ERA
          pitchingScore,                                   // 0-1 composite

          // Used for display
          playoffSeed: st['playoffSeed']?.value ?? 99,
        };
      }
    }

    res.status(200).json(teams);
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
}
