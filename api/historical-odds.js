// historical-odds.js
// Returns opening line + closing line for a given game.
//
// Query params:
//   sport      — e.g. "icehockey_nhl"
//   homeTeam   — full team name
//   awayTeam   — full team name
//   gameDate   — ISO date string of game day (e.g. "2025-12-14T00:00:00Z")
//   apiKey     — Odds API key (passed from frontend so user can rotate)
//
// Strategy:
//   Opening line  = snapshot ~24 hours before game time
//   Closing line  = snapshot ~15 minutes before game time
//
// Cost: 2 requests × 10 credits = 20 credits per game lookup
// (h2h market, us region only)

const APPROVED_BOOKS = ['draftkings','fanduel','betmgm','caesars','bet365','pinnacle'];

function normTeam(name) {
  return (name || '').toLowerCase().trim()
    .replace(/[éèê]/g, 'e')
    .replace(/\s+/g, ' ');
}

function bestMatchGame(games, homeTeam, awayTeam) {
  const nh = normTeam(homeTeam);
  const na = normTeam(awayTeam);
  return games.find(g => {
    const gh = normTeam(g.home_team);
    const ga = normTeam(g.away_team);
    return (gh.includes(nh) || nh.includes(gh)) &&
           (ga.includes(na) || na.includes(ga));
  }) || null;
}

function extractH2HOdds(game) {
  // Pull moneyline odds from approved books, Pinnacle 2.5× weighted
  let homeOddsSum = 0, awayOddsSum = 0, homeWt = 0, awayWt = 0;
  for (const bm of (game.bookmakers || [])) {
    if (!APPROVED_BOOKS.includes(bm.key.toLowerCase())) continue;
    const h2h = (bm.markets || []).find(m => m.key === 'h2h');
    if (!h2h) continue;
    const wt = bm.key.toLowerCase() === 'pinnacle' ? 2.5 : 1;
    for (const oc of (h2h.outcomes || [])) {
      const isDec = oc.price > 1 && oc.price < 50; // decimal
      const dec = isDec ? oc.price : (oc.price > 0 ? oc.price / 100 + 1 : 100 / Math.abs(oc.price) + 1);
      if (normTeam(oc.name).includes(normTeam(game.home_team).split(' ').pop())) {
        homeOddsSum += dec * wt; homeWt += wt;
      } else {
        awayOddsSum += dec * wt; awayWt += wt;
      }
    }
  }
  return {
    homeOdds: homeWt > 0 ? +(homeOddsSum / homeWt).toFixed(3) : null,
    awayOdds: awayWt > 0 ? +(awayOddsSum / awayWt).toFixed(3) : null,
  };
}

async function fetchSnapshot(sport, dateISO, apiKey) {
  const url = `https://api.the-odds-api.com/v4/historical/sports/${sport}/odds` +
    `?apiKey=${apiKey}&regions=us&markets=h2h&oddsFormat=decimal&date=${encodeURIComponent(dateISO)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Odds API ${r.status}: ${txt.slice(0, 120)}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { sport, homeTeam, awayTeam, gameDate, apiKey } = req.query;

  if (!sport || !homeTeam || !awayTeam || !gameDate || !apiKey) {
    return res.status(400).json({ error: 'Missing required params: sport, homeTeam, awayTeam, gameDate, apiKey' });
  }

  try {
    const gameTime = new Date(gameDate);
    if (isNaN(gameTime.getTime())) {
      return res.status(400).json({ error: 'Invalid gameDate — use ISO format e.g. 2025-12-14T20:00:00Z' });
    }

    // Opening line: 24 hours before game
    const openingTime = new Date(gameTime.getTime() - 24 * 60 * 60 * 1000).toISOString();
    // Closing line: 20 minutes before game
    const closingTime = new Date(gameTime.getTime() - 20 * 60 * 1000).toISOString();

    const [openSnap, closeSnap] = await Promise.all([
      fetchSnapshot(sport, openingTime, apiKey),
      fetchSnapshot(sport, closingTime, apiKey),
    ]);

    const openGame  = bestMatchGame(openSnap.data  || [], homeTeam, awayTeam);
    const closeGame = bestMatchGame(closeSnap.data || [], homeTeam, awayTeam);

    if (!openGame && !closeGame) {
      return res.status(404).json({
        error: 'Game not found in historical snapshots',
        openTimestamp: openSnap.timestamp,
        closeTimestamp: closeSnap.timestamp,
      });
    }

    const opening = openGame  ? extractH2HOdds(openGame)  : null;
    const closing = closeGame ? extractH2HOdds(closeGame) : null;

    // Fair probability from closing line (vig-removed)
    let closingFairHome = null, closingFairAway = null;
    if (closing?.homeOdds && closing?.awayOdds) {
      const rawH = 1 / closing.homeOdds;
      const rawA = 1 / closing.awayOdds;
      const vig  = rawH + rawA;
      closingFairHome = +(rawH / vig).toFixed(4);
      closingFairAway = +(rawA / vig).toFixed(4);
    }

    return res.status(200).json({
      sport, homeTeam: openGame?.home_team || homeTeam, awayTeam: openGame?.away_team || awayTeam,
      openingTimestamp:  openSnap.timestamp,
      closingTimestamp:  closeSnap.timestamp,
      opening,
      closing,
      closingFairHome,
      closingFairAway,
      remainingRequests: closeSnap['x-requests-remaining'] ?? null,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
