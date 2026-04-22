// NBA Player Props proxy
// Uses the Odds API event-level endpoint which supports player prop markets.
// Called with: /api/nba-props?eventId=ODDS_API_EVENT_ID&apiKey=KEY
//
// Markets fetched (one request per market to minimise quota):
//   player_points, player_rebounds, player_assists, player_threes
//
// Response: { eventId, homeTeam, awayTeam, players: { [playerName]: { pts, reb, ast, threes } } }
// where each prop = { over: { odds, point, bookmaker }, under: { odds, point, bookmaker }, fairProb, ev }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { eventId, apiKey } = req.query;
  if (!eventId || !apiKey) {
    return res.status(400).json({ error: 'Missing eventId or apiKey' });
  }

  // Bookmakers that have player props — only use sharp/liquid books
  // Note: Pinnacle rarely has NBA player props. DK/FD are the primary prop books.
  const PROP_BOOKS = 'draftkings,fanduel,betmgm,caesars,bet365';

  // Markets to fetch. Each costs 1 quota credit per region.
  // We fetch all 4 in parallel to save time but it costs 4 credits per call.
  const MARKETS = [
    'player_points',
    'player_rebounds',
    'player_assists',
    'player_threes',
  ];

  const BASE_URL = 'https://api.the-odds-api.com/v4';

  try {
    // Fetch all 4 markets in parallel
    const results = await Promise.allSettled(
      MARKETS.map(market =>
        fetch(
          `${BASE_URL}/sports/basketball_nba/events/${eventId}/odds?apiKey=${apiKey}&regions=us&markets=${market}&bookmakers=${PROP_BOOKS}&oddsFormat=decimal`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        )
          .then(r => r.json())
          .then(data => ({ market, data }))
          .catch(e => ({ market, error: e.message }))
      )
    );

    // Combine into a player-keyed object
    // Structure: players[playerName][statType] = { over, under, line, bestBook, fairProb, ev }
    const players = {};
    let homeTeam = '', awayTeam = '';

    const PINNACLE_WEIGHT = 2.0; // still weight sharp books more

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { market, data, error } = result.value;
      if (error || !data || data.error_code) continue;

      homeTeam = data.home_team || homeTeam;
      awayTeam = data.away_team || awayTeam;

      // Map market key → clean stat name
      const statName = {
        player_points:   'pts',
        player_rebounds: 'reb',
        player_assists:  'ast',
        player_threes:   'threes',
      }[market] || market;

      // Collect all outcomes per player across bookmakers
      // outcomes: [{ name: "Over"|"Under", description: playerName, price: 1.91, point: 25.5 }]
      const playerLines = {}; // playerName → { over: [{odds,point,book}], under: [{odds,point,book}] }

      for (const bm of (data.bookmakers || [])) {
        const bmKey = bm.key || bm.title?.toLowerCase().replace(/\s+/g, '');
        for (const mkt of (bm.markets || [])) {
          if (mkt.key !== market) continue;
          for (const o of (mkt.outcomes || [])) {
            const player = o.description; // player name is in description field
            if (!player) continue;
            if (!playerLines[player]) playerLines[player] = { over: [], under: [] };
            const side = o.name === 'Over' ? 'over' : 'under';
            const dec = o.price >= 1 ? o.price : (o.price > 0 ? o.price / 100 + 1 : 100 / Math.abs(o.price) + 1);
            playerLines[player][side].push({ odds: dec, point: o.point, book: bm.title });
          }
        }
      }

      // For each player, compute fair prob + best odds + EV
      for (const [playerName, lines] of Object.entries(playerLines)) {
        if (!lines.over.length || !lines.under.length) continue;

        // Best odds = highest decimal odds per side
        const bestOver  = lines.over.sort((a, b) => b.odds - a.odds)[0];
        const bestUnder = lines.under.sort((a, b) => b.odds - a.odds)[0];

        // Fair probability: weighted average of implied probs across all books
        // (same Pinnacle-weighted approach as main model, but Pinnacle rarely has props)
        const allOver  = lines.over;
        const allUnder = lines.under;

        let overWeightedSum = 0, overTotalWeight = 0;
        let underWeightedSum = 0, underTotalWeight = 0;

        for (const o of allOver) {
          const w = o.book?.toLowerCase().includes('pinnacle') ? PINNACLE_WEIGHT : 1;
          overWeightedSum  += (1 / o.odds) * w;
          overTotalWeight  += w;
        }
        for (const u of allUnder) {
          const w = u.book?.toLowerCase().includes('pinnacle') ? PINNACLE_WEIGHT : 1;
          underWeightedSum += (1 / u.odds) * w;
          underTotalWeight += w;
        }

        const rawOverProb  = overTotalWeight  > 0 ? overWeightedSum  / overTotalWeight  : 0.5;
        const rawUnderProb = underTotalWeight > 0 ? underWeightedSum / underTotalWeight : 0.5;
        const total        = rawOverProb + rawUnderProb;
        const fairOverProb  = rawOverProb  / total;
        const fairUnderProb = rawUnderProb / total;

        // EV for best odds on each side
        const overEV  = (fairOverProb  * (bestOver.odds  - 1)) - (1 - fairOverProb);
        const underEV = (fairUnderProb * (bestUnder.odds - 1)) - (1 - fairUnderProb);

        // Use the line from the most common book (mode of points)
        const allPoints = [...allOver, ...allUnder].map(o => o.point).filter(Boolean);
        const lineMode  = allPoints.sort((a, b) =>
          allPoints.filter(v => v === b).length - allPoints.filter(v => v === a).length
        )[0];

        // Number of books offering this prop (more books = more confidence it's real)
        const bookCount = new Set([...allOver, ...allUnder].map(o => o.book)).size;

        if (!players[playerName]) players[playerName] = {};
        players[playerName][statName] = {
          line:      lineMode ?? bestOver.point,
          over:      { odds: +bestOver.odds.toFixed(3),  book: bestOver.book  },
          under:     { odds: +bestUnder.odds.toFixed(3), book: bestUnder.book },
          fairOverProb:  +fairOverProb.toFixed(4),
          fairUnderProb: +fairUnderProb.toFixed(4),
          overEV:    +Math.round(overEV  * 1000) / 10,  // percent, 1dp
          underEV:   +Math.round(underEV * 1000) / 10,
          bookCount,
          // Best side
          bestSide:  overEV >= underEV ? 'over' : 'under',
          bestEV:    +Math.max(overEV, underEV).toFixed(3) * 100,
        };
      }
    }

    res.status(200).json({ eventId, homeTeam, awayTeam, players });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
