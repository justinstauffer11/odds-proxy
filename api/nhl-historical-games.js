// nhl-historical-games.js — returns completed NHL games over a date range.
// GET /api/nhl-historical-games?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// v2 strategy: instead of fetching one /score/{date} per day in the range
// (slow for long ranges, hits Vercel timeout on 90+ days), we fetch each
// team's full season schedule in parallel from /club-schedule-season.
// 32 parallel calls returning ~80 games each = ~1300 raw rows after dedup.
// Far faster than 90+ daily calls.
//
// Cached at Vercel for 6 hours (historical data doesn't change).

const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

// 32 NHL team triCode abbreviations. UTA is the new (2024+) Utah team.
// SEA was added in 2021, VGK in 2017. The schedule endpoint accepts any of these.
const TEAM_CODES = [
  'ANA','BOS','BUF','CAR','CBJ','CGY','CHI','COL','DAL','DET','EDM','FLA',
  'LAK','MIN','MTL','NJD','NSH','NYI','NYR','OTT','PHI','PIT','SEA','SJS',
  'STL','TBL','TOR','UTA','VAN','VGK','WPG','WSH',
];

// Determine NHL "season" code from a date.
// NHL seasons run Oct → Apr/Jun. Season starting Oct 2024 is "20242025".
function seasonForDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const month = d.getUTCMonth();    // 0 = Jan
  const year  = d.getUTCFullYear();
  if (month >= 8) return `${year}${year + 1}`;       // Sep..Dec → starts current year
  return `${year - 1}${year}`;                        // Jan..Aug → starts previous year
}

async function fetchTeamSeason(teamCode, season) {
  try {
    const url = `https://api-web.nhle.com/v1/club-schedule-season/${teamCode}/${season}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    return data.games || [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { from, to } = req.query || {};
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'Provide from and to in YYYY-MM-DD format' });
  }

  const fromMs = new Date(from + 'T00:00:00Z').getTime();
  const toMs   = new Date(to   + 'T23:59:59Z').getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return res.status(400).json({ error: 'Invalid date range' });
  }

  // Determine which seasons span the range. Most queries hit 1 season,
  // but ranges spanning two season starts (e.g. Sep → Nov of next year) need 2.
  const seasonStart = seasonForDate(from);
  const seasonEnd   = seasonForDate(to);
  const seasons = seasonStart === seasonEnd ? [seasonStart] : [seasonStart, seasonEnd];

  try {
    // Fetch all (team × season) combinations in parallel.
    // 32 teams × 1-2 seasons = up to 64 fetches. Each returns ~80 games.
    const fetchTasks = [];
    for (const season of seasons) {
      for (const team of TEAM_CODES) {
        fetchTasks.push(fetchTeamSeason(team, season));
      }
    }
    const allTeamSchedules = await Promise.all(fetchTasks);

    // Flatten and dedup by game ID (each game appears in 2 teams' schedules)
    const seen = new Set();
    const games = [];

    for (const schedule of allTeamSchedules) {
      for (const g of schedule) {
        const id = String(g.id);
        if (seen.has(id)) continue;
        seen.add(id);

        // Filter to completed games (gameState 'OFF' or 'FINAL')
        const state = g.gameState || g.gameScheduleState;
        if (state !== 'OFF' && state !== 'FINAL') continue;

        // Filter to date range
        const gameDate = g.gameDate || (g.startTimeUTC || '').slice(0, 10);
        if (!gameDate) continue;
        const gameMs = new Date(gameDate + 'T12:00:00Z').getTime();
        if (gameMs < fromMs || gameMs > toMs) continue;

        // Extract scores and team info
        const home = g.homeTeam, away = g.awayTeam;
        if (!home || !away) continue;
        const hScore = home.score ?? 0;
        const aScore = away.score ?? 0;

        // Detect OT/SO from gameOutcome
        const lastPeriodType = g.gameOutcome?.lastPeriodType;
        const wentToOT = lastPeriodType === 'OT' || lastPeriodType === 'SO';

        games.push({
          id,
          date:      gameDate,
          homeAbbr:  home.abbrev,
          awayAbbr:  away.abbrev,
          homeName:  ((home.placeName?.default || '') + ' ' + (home.commonName?.default || home.placeName?.default || '')).trim(),
          awayName:  ((away.placeName?.default || '') + ' ' + (away.commonName?.default || away.placeName?.default || '')).trim(),
          homeScore: hScore,
          awayScore: aScore,
          wentToOT,
        });
      }
    }

    // Sort chronologically
    games.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate');
    return res.status(200).json({
      from, to,
      seasons,
      teamsScanned: TEAM_CODES.length,
      gamesFound: games.length,
      games,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Proxy error: ' + e.message });
  }
}
