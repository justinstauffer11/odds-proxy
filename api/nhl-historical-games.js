// nhl-historical-games.js — returns completed NHL games over a date range.
// GET /api/nhl-historical-games?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Used by the rolling-validation backtester to walk through a season and
// reconstruct point-in-time team stats. This proxy ONLY returns completed
// games (final scores known) — it does NOT compute stats. Stat reconstruction
// happens client-side because the logic is easier to verify there.
//
// Strategy: NHL API exposes daily score endpoints. We fetch each day in the
// range in parallel (capped at 50 in flight). Days with no games return an
// empty array — that's fine.
//
// Cached at Vercel for 6 hours (historical data doesn't change).

const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

// Concurrency-limited Promise.all
async function parallelMap(items, fn, limit = 25) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await fn(items[i]); }
      catch { results[i] = null; }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// Walk dates from `from` to `to` inclusive
function dateRange(fromStr, toStr) {
  const out = [];
  const from = new Date(fromStr + 'T12:00:00Z');
  const to   = new Date(toStr   + 'T12:00:00Z');
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function fetchOneDay(date) {
  try {
    const res = await fetch(
      `https://api-web.nhle.com/v1/score/${date}`,
      { headers: HEADERS }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const games = [];
    for (const g of (data.games || [])) {
      // Only completed games — gameState 'OFF' or 'FINAL'
      const state = g.gameState || g.gameScheduleState;
      if (state !== 'OFF' && state !== 'FINAL') continue;

      const home = g.homeTeam, away = g.awayTeam;
      if (!home || !away) continue;
      const hScore = home.score ?? 0;
      const aScore = away.score ?? 0;

      // Detect overtime/shootout — periodDescriptor.number > 3 or shootout flag
      const lastPeriodDesc = g.periodDescriptor || (g.gameOutcome && g.gameOutcome.lastPeriodType);
      const wentToOT = (lastPeriodDesc?.number ?? 3) > 3 ||
                       (g.gameOutcome?.lastPeriodType === 'OT' || g.gameOutcome?.lastPeriodType === 'SO');

      games.push({
        id:       String(g.id),
        date:     g.gameDate || date,
        homeAbbr: home.abbrev,
        awayAbbr: away.abbrev,
        homeName: (home.placeName?.default || '') + ' ' + (home.commonName?.default || ''),
        awayName: (away.placeName?.default || '') + ' ' + (away.commonName?.default || ''),
        homeScore: hScore,
        awayScore: aScore,
        wentToOT,
      });
    }
    return games;
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

  // Hard cap range at 200 days to avoid runaway scrapes
  const dates = dateRange(from, to);
  if (dates.length > 200) {
    return res.status(400).json({ error: `Date range too large (${dates.length} days, max 200)` });
  }

  try {
    const allDays = await parallelMap(dates, fetchOneDay, 25);
    const games = [].concat(...allDays.filter(Boolean));
    games.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate');
    res.status(200).json({
      from, to,
      daysScanned: dates.length,
      gamesFound: games.length,
      games,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
