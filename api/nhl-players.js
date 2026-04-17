// nhl-players.js — Fetches per-game player data from the NHL API
// Accepts ?homeTeam=Carolina+Hurricanes&awayTeam=Ottawa+Senators (full names)
// OR     ?gameId=2025030131 (NHL game ID directly)
//
// Strategy when only team names provided:
//   1. Fetch NHL schedule for today + next 3 days
//   2. Match home/away team names (fuzzy — strips "é" → "e", etc.)
//   3. Fetch game landing for matched game ID
//
// Returns:
//   homeTeam: { goalies, skaters (top 8 by pts), starterRating }
//   awayTeam: { goalies, skaters (top 8 by pts), starterRating }
//   leaders:  last-5-game stat leaders per category

const TEAM_NAME_FIXES = {
  'montr\u00e9al canadiens': 'montreal canadiens',
  'montreal canadiens': 'montreal canadiens',
  'utah hockey club': 'utah mammoth',
  'vegas golden knights': 'vegas golden knights',
};

function normalizeName(name) {
  return (name || '').toLowerCase()
    .replace(/[éèê]/g, 'e')
    .replace(/[àâ]/g, 'a')
    .replace(/[ôo]/g, 'o')
    .trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { gameId, homeTeam, awayTeam } = req.query;

  try {
    // ── Step 1: Resolve NHL game ID if not directly provided ──
    if (!gameId) {
      if (!homeTeam || !awayTeam) {
        return res.status(400).json({ error: 'Provide gameId or homeTeam + awayTeam' });
      }

      const normHome = TEAM_NAME_FIXES[normalizeName(homeTeam)] || normalizeName(homeTeam);
      const normAway = TEAM_NAME_FIXES[normalizeName(awayTeam)] || normalizeName(awayTeam);

      // Try today + next 4 days
      const today = new Date();
      let found = null;
      for (let d = 0; d < 5 && !found; d++) {
        const dateStr = new Date(today.getTime() + d * 86400000)
          .toISOString().slice(0, 10);
        try {
          const schRes = await fetch(
            `https://api-web.nhle.com/v1/score/${dateStr}`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          if (!schRes.ok) continue;
          const schData = await schRes.json();
          for (const g of (schData.games || [])) {
            const hn = normalizeName(g.homeTeam?.placeName?.default + ' ' + g.homeTeam?.commonName?.default);
            const an = normalizeName(g.awayTeam?.placeName?.default + ' ' + g.awayTeam?.commonName?.default);
            // Also try full name field
            const hn2 = normalizeName(g.homeTeam?.name?.default || '');
            const an2 = normalizeName(g.awayTeam?.name?.default || '');
            if (
              (hn.includes(normHome) || normHome.includes(hn) || hn2.includes(normHome) || normHome.includes(hn2)) &&
              (an.includes(normAway) || normAway.includes(an) || an2.includes(normAway) || normAway.includes(an2))
            ) {
              found = g.id;
              break;
            }
          }
        } catch (_) { continue; }
      }

      if (!found) {
        return res.status(404).json({ error: 'Game not found in NHL schedule', homeTeam, awayTeam });
      }
      gameId = found;
    }

    // ── Step 2: Fetch game landing ──
    const landingRes = await fetch(
      `https://api-web.nhle.com/v1/gamecenter/${gameId}/landing`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!landingRes.ok) {
      return res.status(landingRes.status).json({ error: 'NHL API error', status: landingRes.status });
    }
    const data = await landingRes.json();

    // ── Helper: parse "MM:SS" TOI string to minutes ──
    function toiToMin(str) {
      if (!str) return 0;
      const parts = String(str).split(':');
      return parseInt(parts[0] || 0) + (parseInt(parts[1] || 0) / 60);
    }

    // ── Process a team node from the landing response ──
    function processTeam(teamObj) {
      if (!teamObj) return null;

      // Goalies — sort by GP desc so [0] = likely starter
      const goalies = (teamObj.goalies || [])
        .map(g => ({
          id:       g.playerId,
          name:     g.name?.default || [g.firstName?.default, g.lastName?.default].filter(Boolean).join(' '),
          number:   g.sweaterNumber,
          headshot: g.headshot || null,
          gamesPlayed: g.gamesPlayed || 0,
          record:   g.record || '0-0-0',
          gaa:      g.gaa      != null ? +Number(g.gaa).toFixed(2)      : null,
          savePct:  g.savePctg != null ? +Number(g.savePctg).toFixed(3) : null,
          shutouts: g.shutouts || 0,
        }))
        .sort((a, b) => b.gamesPlayed - a.gamesPlayed);

      // Skaters — top 8 by season points
      const skaters = (teamObj.skaters || [])
        .filter(s => s.gamesPlayed > 0)
        .map(s => ({
          id:       s.playerId,
          name:     s.name?.default || [s.firstName?.default, s.lastName?.default].filter(Boolean).join(' '),
          number:   s.sweaterNumber,
          position: s.position,
          headshot: s.headshot || null,
          gamesPlayed: s.gamesPlayed || 0,
          goals:    s.goals    || 0,
          assists:  s.assists  || 0,
          points:   s.points   || 0,
          plusMinus: s.plusMinus || 0,
          ppGoals:  s.powerPlayGoals || 0,
          avgTOI:   +toiToMin(s.avgTimeOnIce).toFixed(1),
          avgPts:   s.avgPoints ? +Number(s.avgPoints).toFixed(2) : 0,
          shootPct: s.shootingPctg ? +(s.shootingPctg * 100).toFixed(1) : 0,
        }))
        .sort((a, b) => b.points - a.points)
        .slice(0, 8);

      return { goalies, skaters };
    }

    // ── Last-5-game stat leaders ──
    function processLeaders(matchupObj) {
      if (!matchupObj) return null;
      const cats = {};
      for (const cat of (matchupObj.skaterComparison || [])) {
        cats[cat.category] = {
          away: cat.awayLeader ? {
            id: cat.awayLeader.playerId,
            name: cat.awayLeader.name,
            value: cat.awayLeader.value,
            headshot: cat.awayLeader.headshot,
          } : null,
          home: cat.homeLeader ? {
            id: cat.homeLeader.playerId,
            name: cat.homeLeader.name,
            value: cat.homeLeader.value,
            headshot: cat.homeLeader.headshot,
          } : null,
        };
      }
      return cats;
    }

    // ── Goalie quality rating (0–1) ──
    // 50% GAA (inverted, lower=better), 40% SV%, 10% win%
    // Benchmarks: GAA 2.0–3.5, SV% 0.880–0.930
    function goalieRating(g) {
      if (!g || g.gamesPlayed < 5) return 0.5; // too few games — treat as average
      const gaaNorm = g.gaa  != null ? Math.max(0, Math.min(1, (3.5 - g.gaa)  / 1.5)) : 0.5;
      const svNorm  = g.savePct != null ? Math.max(0, Math.min(1, (g.savePct - 0.88) / 0.05)) : 0.5;
      const [w, l, otl] = (g.record || '0-0-0').split('-').map(Number);
      const gp = (w || 0) + (l || 0) + (otl || 0);
      const winPct = gp > 0 ? w / gp : 0.5;
      return gaaNorm * 0.50 + svNorm * 0.40 + winPct * 0.10;
    }

    const home = processTeam(data.homeTeam);
    const away = processTeam(data.awayTeam);
    const leaders = processLeaders(data.matchup);

    res.status(200).json({
      gameId,
      homeTeam: {
        ...home,
        starterRating: home ? +goalieRating(home.goalies?.[0]).toFixed(3) : 0.5,
      },
      awayTeam: {
        ...away,
        starterRating: away ? +goalieRating(away.goalies?.[0]).toFixed(3) : 0.5,
      },
      leaders,
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
