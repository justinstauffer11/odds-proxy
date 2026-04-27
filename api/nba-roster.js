// nba-roster.js — Round 1 NBA upgrade
// Fetches each team's roster with minutes per game (MPG) for star-player-aware
// injury weighting. Without MPG, all injuries are weighted equally — but losing
// LeBron (35 MPG) is far more significant than losing a 5-MPG bench player.
//
// GET /api/nba-roster?team=LAL  (single team)
// GET /api/nba-roster              (all 30 teams — heavy, ~30 calls)
//
// Returns: { [abbrev]: { players: [{ id, name, mpg, ppg, position }] } }
//
// Strategy: ESPN's per-team /roster endpoint includes a stats summary per
// player. We pull MPG (minutes per game) and PPG. Both are useful:
//   - MPG = how much the player normally plays (proxy for importance)
//   - PPG = scoring contribution
// For injury weighting we'll primarily use MPG.

const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

const ESPN_IDS = {
  ATL:1, BOS:2, BKN:17, CHA:30, CHI:4, CLE:5, DAL:6, DEN:7, DET:8, GSW:9,
  HOU:10, IND:11, LAC:12, LAL:13, MEM:29, MIA:14, MIL:15, MIN:16, NOP:3,
  NYK:18, OKC:25, ORL:19, PHI:20, PHX:21, POR:22, SAC:23, SAS:24, TOR:28,
  UTA:26, WAS:27,
};

async function fetchTeamRoster(abbr) {
  const teamId = ESPN_IDS[abbr];
  if (!teamId) return { abbr, players: [] };
  try {
    // ESPN team endpoint returns roster + per-player season stats summary
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/roster?enable=stats`,
      { headers: HEADERS }
    );
    if (!res.ok) return { abbr, players: [] };
    const data = await res.json();

    // Roster shape varies — try both common patterns
    const athletes = data.athletes || data.team?.athletes || [];
    const flatList = [];

    function pushAthlete(p) {
      if (!p) return;
      // ESPN exposes stats either as p.statistics or as a separate splits array
      // Look for common stat keys: 'avgMinutes', 'avgPoints', 'minutesPerGame'
      const stats = p.statistics?.splits?.categories || [];
      let mpg = null, ppg = null;
      for (const cat of stats) {
        for (const s of (cat.stats || [])) {
          const n = (s.name || '').toLowerCase();
          if (mpg == null && (n === 'avgminutes' || n === 'minutespergame' || n === 'minutes')) {
            mpg = parseFloat(s.value);
          }
          if (ppg == null && (n === 'avgpoints' || n === 'pointspergame' || n === 'points')) {
            ppg = parseFloat(s.value);
          }
        }
      }
      // Fallback: athlete-level stats
      if (mpg == null && p.stats) {
        for (const s of p.stats) {
          const n = (s.name || s.shortDisplayName || '').toLowerCase();
          if (mpg == null && (n.includes('min') && !n.includes('total'))) mpg = parseFloat(s.value);
          if (ppg == null && (n === 'pts' || n.includes('point'))) ppg = parseFloat(s.value);
        }
      }
      flatList.push({
        id: String(p.id || p.uid || ''),
        name: p.fullName || p.displayName || p.name || '',
        mpg: Number.isFinite(mpg) ? +mpg.toFixed(1) : null,
        ppg: Number.isFinite(ppg) ? +ppg.toFixed(1) : null,
        position: p.position?.abbreviation || p.position?.name || null,
      });
    }

    // Athletes can be flat array OR grouped by position
    if (Array.isArray(athletes)) {
      for (const item of athletes) {
        // Sometimes a "group" with items[] inside, sometimes just the player
        if (item.items && Array.isArray(item.items)) {
          for (const p of item.items) pushAthlete(p);
        } else {
          pushAthlete(item);
        }
      }
    }

    // Filter out players with no MPG (haven't played) and sort by MPG desc
    const ranked = flatList
      .filter(p => p.name && (p.mpg == null || p.mpg > 0))
      .sort((a, b) => (b.mpg ?? 0) - (a.mpg ?? 0));

    return { abbr, players: ranked };
  } catch {
    return { abbr, players: [] };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { team } = req.query || {};

  try {
    if (team) {
      // Single team mode — fast
      const result = await fetchTeamRoster(team.toUpperCase());
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
      return res.status(200).json({ [result.abbr]: result });
    }

    // All teams — runs 30 fetches in parallel
    const abbrs = Object.keys(ESPN_IDS);
    const all = await Promise.all(abbrs.map(a => fetchTeamRoster(a)));
    const out = {};
    for (const r of all) out[r.abbr] = r;

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
