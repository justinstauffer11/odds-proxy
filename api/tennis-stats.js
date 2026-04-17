// tennis-stats.js — Vercel serverless proxy
// Fetches ATP player stats from Jeff Sackmann's open GitHub dataset
// Returns a lookup map: playerName → { rank, rankPoints, surface stats, recent form, serveStats }
//
// Data source: github.com/JeffSackmann/tennis_atp (public domain)
// Rankings: atp_rankings_current.csv  → rank + points per player_id
// Players:  atp_players.csv           → player_id → full name
// Matches:  atp_matches_2024.csv      → surface/serve/form stats computed from last 52 weeks

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const BASE = 'https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master';

    // Fetch all three files in parallel
    const [rankRaw, playerRaw, matchRaw] = await Promise.all([
      fetch(`${BASE}/atp_rankings_current.csv`).then(r => r.text()),
      fetch(`${BASE}/atp_players.csv`).then(r => r.text()),
      fetch(`${BASE}/atp_matches_2024.csv`).then(r => r.text()),
    ]);

    // ── 1. Build player_id → { firstName, lastName, fullName } ──
    const playerMap = {};
    const playerLines = playerRaw.trim().split('\n').slice(1);
    for (const line of playerLines) {
      const [id, firstName, lastName] = line.split(',');
      if (!id || !lastName) continue;
      const fullName = `${firstName.trim()} ${lastName.trim()}`.trim();
      playerMap[id.trim()] = { firstName: firstName.trim(), lastName: lastName.trim(), fullName };
    }

    // ── 2. Build player_id → { rank, rankPoints } from most recent date ──
    const rankMap = {};
    const rankLines = rankRaw.trim().split('\n').slice(1);
    // Find most recent date
    let maxDate = '0';
    for (const line of rankLines) {
      const [date] = line.split(',');
      if (date > maxDate) maxDate = date;
    }
    for (const line of rankLines) {
      const [date, rank, playerId, points] = line.split(',');
      if (date !== maxDate) continue;
      rankMap[playerId?.trim()] = { rank: parseInt(rank), rankPoints: parseInt(points) };
    }

    // ── 3. Parse match data → surface win%, serve stats, recent form ──
    // We compute per-player stats from ALL 2024 tour-level matches
    const stats = {}; // player_id → accumulated stats

    function getOrCreate(id) {
      if (!stats[id]) {
        stats[id] = {
          // Overall
          wins: 0, losses: 0,
          // By surface
          hard: { w: 0, l: 0 }, clay: { w: 0, l: 0 }, grass: { w: 0, l: 0 },
          // Serve totals (winner perspective)
          aces: 0, dfs: 0, svpt: 0, firstIn: 0, firstWon: 0, secondWon: 0,
          // Recent form (last 15 matches, most recent first)
          recent: [], // 'W' or 'L'
        };
      }
      return stats[id];
    }

    const matchLines = matchRaw.trim().split('\n');
    const headers = matchLines[0].split(',');
    const idx = (name) => headers.indexOf(name);

    // Column indices
    const iSurface     = idx('surface');
    const iWinnerId    = idx('winner_id');
    const iLoserId     = idx('loser_id');
    const iWAce        = idx('w_ace');
    const iWDf         = idx('w_df');
    const iWSvpt       = idx('w_svpt');
    const iW1stIn      = idx('w_1stIn');
    const iW1stWon     = idx('w_1stWon');
    const iW2ndWon     = idx('w_2ndWon');
    const iLAce        = idx('l_ace');
    const iLDf         = idx('l_df');
    const iLSvpt       = idx('l_svpt');
    const iL1stIn      = idx('l_1stIn');
    const iL1stWon     = idx('l_1stWon');
    const iL2ndWon     = idx('l_2ndWon');

    for (let i = 1; i < matchLines.length; i++) {
      const cols = matchLines[i].split(',');
      if (cols.length < 20) continue;

      const surface   = (cols[iSurface] || '').trim().toLowerCase();
      const winnerId  = (cols[iWinnerId] || '').trim();
      const loserId   = (cols[iLoserId]  || '').trim();

      const w = getOrCreate(winnerId);
      const l = getOrCreate(loserId);

      // Overall record
      w.wins++; l.losses++;

      // Surface splits
      const surf = surface === 'hard' ? 'hard' : surface === 'clay' ? 'clay' : surface === 'grass' ? 'grass' : null;
      if (surf) { w[surf].w++; l[surf].l++; }

      // Winner serve stats
      w.aces     += parseFloat(cols[iWAce]    || 0) || 0;
      w.dfs      += parseFloat(cols[iWDf]     || 0) || 0;
      w.svpt     += parseFloat(cols[iWSvpt]   || 0) || 0;
      w.firstIn  += parseFloat(cols[iW1stIn]  || 0) || 0;
      w.firstWon += parseFloat(cols[iW1stWon] || 0) || 0;
      w.secondWon+= parseFloat(cols[iW2ndWon] || 0) || 0;

      // Loser serve stats
      l.aces     += parseFloat(cols[iLAce]    || 0) || 0;
      l.dfs      += parseFloat(cols[iLDf]     || 0) || 0;
      l.svpt     += parseFloat(cols[iLSvpt]   || 0) || 0;
      l.firstIn  += parseFloat(cols[iL1stIn]  || 0) || 0;
      l.firstWon += parseFloat(cols[iL1stWon] || 0) || 0;
      l.secondWon+= parseFloat(cols[iL2ndWon] || 0) || 0;

      // Recent form (appended in match order = chronological)
      if (w.recent.length < 20) w.recent.push('W'); else w.recent = [...w.recent.slice(1), 'W'];
      if (l.recent.length < 20) l.recent.push('L'); else l.recent = [...l.recent.slice(1), 'L'];
    }

    // ── 4. Assemble final output ──
    // Key by FULL NAME (lowercased, trimmed) for easy lookup from Odds API names
    const output = {};

    for (const [playerId, rankInfo] of Object.entries(rankMap)) {
      const player = playerMap[playerId];
      if (!player) continue;
      const s = stats[playerId];
      if (!s) continue; // no 2024 matches — skip (likely retired/inactive)

      const totalMatches = s.wins + s.losses;
      if (totalMatches < 5) continue; // too little data

      const winPct = s.wins / totalMatches;
      const hardWinPct  = (s.hard.w + s.hard.l) > 0  ? s.hard.w  / (s.hard.w  + s.hard.l)  : winPct;
      const clayWinPct  = (s.clay.w + s.clay.l) > 0  ? s.clay.w  / (s.clay.w  + s.clay.l)  : winPct;
      const grassWinPct = (s.grass.w + s.grass.l) > 0 ? s.grass.w / (s.grass.w + s.grass.l) : winPct;

      // Recent form: last 10 results (most recent = end of array)
      const last10 = s.recent.slice(-10);
      const l10Wins = last10.filter(r => r === 'W').length;
      const l10WinPct = last10.length > 0 ? l10Wins / last10.length : winPct;
      const l10Record = `${l10Wins}-${last10.length - l10Wins}`;

      // Serve stats
      const first1stPct = s.svpt  > 0 ? s.firstIn  / s.svpt   : null;
      const firstWonPct = s.firstIn > 0 ? s.firstWon / s.firstIn : null;
      const secondWonPct = (s.svpt - s.firstIn) > 0 ? s.secondWon / (s.svpt - s.firstIn) : null;
      const acesPerMatch = totalMatches > 0 ? s.aces / totalMatches : null;

      const key = player.fullName.toLowerCase();
      output[key] = {
        name:         player.fullName,
        playerId,
        rank:         rankInfo.rank,
        rankPoints:   rankInfo.rankPoints,

        // Overall
        wins:         s.wins,
        losses:       s.losses,
        totalMatches,
        winPct:       +winPct.toFixed(3),

        // Surface splits
        hardWinPct:   +hardWinPct.toFixed(3),
        clayWinPct:   +clayWinPct.toFixed(3),
        grassWinPct:  +grassWinPct.toFixed(3),
        hardRecord:   `${s.hard.w}-${s.hard.l}`,
        clayRecord:   `${s.clay.w}-${s.clay.l}`,
        grassRecord:  `${s.grass.w}-${s.grass.l}`,

        // Recent form
        l10WinPct:    +l10WinPct.toFixed(3),
        l10Record,

        // Serve (nulls if no data)
        first1stPct:  first1stPct  !== null ? +first1stPct.toFixed(3)  : null,
        firstWonPct:  firstWonPct  !== null ? +firstWonPct.toFixed(3)  : null,
        secondWonPct: secondWonPct !== null ? +secondWonPct.toFixed(3) : null,
        acesPerMatch: acesPerMatch !== null ? +acesPerMatch.toFixed(1) : null,
      };
    }

    res.status(200).json(output);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
