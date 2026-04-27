// nba-h2h.js — Round 2 NBA upgrade
// Returns this-season head-to-head record for two NBA teams.
// GET /api/nba-h2h?homeTeam=Los+Angeles+Lakers&awayTeam=Golden+State+Warriors
//
// Strategy: fetch the home team's full season schedule from ESPN, filter to
// games where the opponent was the away team, count wins/losses, sum scoring.
// Cached at Vercel for 1 hour.

const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

const ESPN_IDS = {
  'Atlanta Hawks':1,'Boston Celtics':2,'Brooklyn Nets':17,'Charlotte Hornets':30,
  'Chicago Bulls':4,'Cleveland Cavaliers':5,'Dallas Mavericks':6,'Denver Nuggets':7,
  'Detroit Pistons':8,'Golden State Warriors':9,'Houston Rockets':10,
  'Indiana Pacers':11,'LA Clippers':12,'Los Angeles Clippers':12,
  'Los Angeles Lakers':13,'Memphis Grizzlies':29,'Miami Heat':14,
  'Milwaukee Bucks':15,'Minnesota Timberwolves':16,'New Orleans Pelicans':3,
  'New York Knicks':18,'Oklahoma City Thunder':25,'Orlando Magic':19,
  'Philadelphia 76ers':20,'Phoenix Suns':21,'Portland Trail Blazers':22,
  'Sacramento Kings':23,'San Antonio Spurs':24,'Toronto Raptors':28,
  'Utah Jazz':26,'Washington Wizards':27,
};

// Fuzzy lookup — fall back to last word match (e.g. "Lakers")
function findTeamId(name) {
  if (!name) return null;
  const n = name.trim();
  if (ESPN_IDS[n] != null) return ESPN_IDS[n];
  // Try case-insensitive
  const lower = n.toLowerCase();
  for (const [k, v] of Object.entries(ESPN_IDS)) {
    if (k.toLowerCase() === lower) return v;
  }
  // Last word match (e.g. "Lakers" -> "Los Angeles Lakers")
  const last = lower.split(' ').pop();
  for (const [k, v] of Object.entries(ESPN_IDS)) {
    if (k.toLowerCase().endsWith(' ' + last)) return v;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { homeTeam, awayTeam } = req.query || {};
  if (!homeTeam || !awayTeam) {
    return res.status(400).json({ error: 'Provide homeTeam and awayTeam' });
  }

  const homeId = findTeamId(homeTeam);
  const awayId = findTeamId(awayTeam);
  if (!homeId || !awayId) {
    return res.status(404).json({ error: 'Team not found', homeTeam, awayTeam });
  }

  try {
    // Pull home team's schedule and filter to games vs away team
    const schedRes = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${homeId}/schedule`,
      { headers: HEADERS }
    );
    if (!schedRes.ok) {
      return res.status(schedRes.status).json({ error: 'Schedule fetch failed' });
    }
    const sched = await schedRes.json();

    let homeWins = 0, awayWins = 0, gamesPlayed = 0;
    let homePts = 0, awayPts = 0;

    for (const ev of (sched.events || [])) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      if (!comp.status?.type?.completed) continue;

      const us   = comp.competitors.find(c => c.team?.id === String(homeId));
      const them = comp.competitors.find(c => c.team?.id === String(awayId));
      if (!us || !them) continue;

      gamesPlayed++;
      const ourScore   = parseInt(us.score, 10)   || 0;
      const theirScore = parseInt(them.score, 10) || 0;
      homePts += ourScore;
      awayPts += theirScore;

      if (ourScore > theirScore) homeWins++;
      else awayWins++;
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    return res.status(200).json({
      homeTeam, awayTeam,
      gamesPlayed,
      homeWins, awayWins,
      homePointsAvg: gamesPlayed > 0 ? +(homePts / gamesPlayed).toFixed(1) : null,
      awayPointsAvg: gamesPlayed > 0 ? +(awayPts / gamesPlayed).toFixed(1) : null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
