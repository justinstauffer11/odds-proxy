// tennis-stats.js — Vercel serverless proxy
// Fetches ATP player stats from Jeff Sackmann's open GitHub dataset
// Returns a lookup map: playerName → { rank, rankPoints, surface stats, recent form, serveStats, h2h }
//
// Data source: github.com/JeffSackmann/tennis_atp (public domain)
// Rankings: atp_rankings_current.csv  → rank + points per player_id
// Players:  atp_players.csv           → player_id → full name
// Matches:  atp_matches_2024.csv + atp_matches_2023.csv → merged for richer sample
// H2H:      computed from merged match history

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const BASE = 'https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master';

    // Fetch all files in parallel — 2024 + 2023 matches for larger sample
    const [rankRaw, playerRaw, matchRaw2024, matchRaw2023] = await Promise.all([
      fetch(`${BASE}/atp_rankings_current.csv`).then(r => r.text()),
      fetch(`${BASE}/atp_players.csv`).then(r => r.text()),
      fetch(`${BASE}/atp_matches_2024.csv`).then(r => r.text()),
      fetch(`${BASE}/atp_matches_2023.csv`).then(r => r.text()),
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

    // ── 3. Parse match data → per-player stats + H2H records ──
    const stats = {};    // player_id → accumulated stats
    const h2hMap = {};   // "id1_id2" → { p1wins, p2wins } (sorted id order)

    function getOrCreate(id) {
      if (!stats[id]) {
        stats[id] = {
          wins: 0, losses: 0,
          hard: { w: 0, l: 0 }, clay: { w: 0, l: 0 }, grass: { w: 0, l: 0 },
          aces: 0, dfs: 0, svpt: 0, firstIn: 0, firstWon: 0, secondWon: 0,
          recent: [], // match results in chronological order, 'W' or 'L'
          // 2024-only counters for recency weighting
          wins2024: 0, losses2024: 0,
          hard2024: { w: 0, l: 0 }, clay2024: { w: 0, l: 0 }, grass2024: { w: 0, l: 0 },
        };
      }
      return stats[id];
    }

    function recordH2H(winnerId, loserId) {
      const [a, b] = winnerId < loserId ? [winnerId, loserId] : [loserId, winnerId];
      const key = `${a}_${b}`;
      if (!h2hMap[key]) h2hMap[key] = { a, b, aWins: 0, bWins: 0 };
      if (winnerId === a) h2hMap[key].aWins++;
      else h2hMap[key].bWins++;
    }

    function parseMatchFile(raw, is2024 = false) {
      const lines = raw.trim().split('\n');
      const headers = lines[0].split(',');
      const idx = (name) => headers.indexOf(name);

      const iSurface  = idx('surface');
      const iWinnerId = idx('winner_id');
      const iLoserId  = idx('loser_id');
      const iWAce     = idx('w_ace');
      const iWDf      = idx('w_df');
      const iWSvpt    = idx('w_svpt');
      const iW1stIn   = idx('w_1stIn');
      const iW1stWon  = idx('w_1stWon');
      const iW2ndWon  = idx('w_2ndWon');
      const iLAce     = idx('l_ace');
      const iLDf      = idx('l_df');
      const iLSvpt    = idx('l_svpt');
      const iL1stIn   = idx('l_1stIn');
      const iL1stWon  = idx('l_1stWon');
      const iL2ndWon  = idx('l_2ndWon');

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        if (cols.length < 20) continue;

        const surface  = (cols[iSurface] || '').trim().toLowerCase();
        const winnerId = (cols[iWinnerId] || '').trim();
        const loserId  = (cols[iLoserId]  || '').trim();

        const w = getOrCreate(winnerId);
        const l = getOrCreate(loserId);

        w.wins++; l.losses++;

        const surf = surface === 'hard' ? 'hard' : surface === 'clay' ? 'clay' : surface === 'grass' ? 'grass' : null;
        if (surf) { w[surf].w++; l[surf].l++; }

        // 2024 surface splits (recency boost)
        if (is2024 && surf) {
          w[surf + '2024'].w++; l[surf + '2024'].l++;
          w.wins2024++; l.losses2024++;
        }

        // Serve stats from winner
        w.aces      += parseFloat(cols[iWAce]    || 0) || 0;
        w.dfs       += parseFloat(cols[iWDf]     || 0) || 0;
        w.svpt      += parseFloat(cols[iWSvpt]   || 0) || 0;
        w.firstIn   += parseFloat(cols[iW1stIn]  || 0) || 0;
        w.firstWon  += parseFloat(cols[iW1stWon] || 0) || 0;
        w.secondWon += parseFloat(cols[iW2ndWon] || 0) || 0;

        // Serve stats from loser
        l.aces      += parseFloat(cols[iLAce]    || 0) || 0;
        l.dfs       += parseFloat(cols[iLDf]     || 0) || 0;
        l.svpt      += parseFloat(cols[iLSvpt]   || 0) || 0;
        l.firstIn   += parseFloat(cols[iL1stIn]  || 0) || 0;
        l.firstWon  += parseFloat(cols[iL1stWon] || 0) || 0;
        l.secondWon += parseFloat(cols[iL2ndWon] || 0) || 0;

        // Rolling recent form (keep last 20)
        if (w.recent.length >= 20) w.recent.shift();
        w.recent.push('W');
        if (l.recent.length >= 20) l.recent.shift();
        l.recent.push('L');

        // H2H
        recordH2H(winnerId, loserId);
      }
    }

    // Parse 2023 first (older), then 2024 (more recent — recent[] ends with newest)
    parseMatchFile(matchRaw2023, false);
    parseMatchFile(matchRaw2024, true);

    // ── 4. Assemble final output ──
    const output = {};

    for (const [playerId, rankInfo] of Object.entries(rankMap)) {
      const player = playerMap[playerId];
      if (!player) continue;
      const s = stats[playerId];
      if (!s) continue;

      const totalMatches = s.wins + s.losses;
      if (totalMatches < 8) continue; // need reasonable sample

      const winPct = s.wins / totalMatches;

      // Surface win% — blend 2024 (weight 0.65) with 2023+2024 combined (weight 0.35)
      // for more stable estimates, favouring recency
      function surfWinPct(surf) {
        const total = s[surf].w + s[surf].l;
        if (total === 0) return winPct;
        const combined = s[surf].w / total;
        const t24 = s[surf + '2024'].w + s[surf + '2024'].l;
        if (t24 < 3) return combined; // not enough 2024 data — use combined
        const recent24 = s[surf + '2024'].w / t24;
        return recent24 * 0.65 + combined * 0.35;
      }

      const hardWinPct  = surfWinPct('hard');
      const clayWinPct  = surfWinPct('clay');
      const grassWinPct = surfWinPct('grass');

      // Recent form: last 10 results
      const last10 = s.recent.slice(-10);
      const l10Wins = last10.filter(r => r === 'W').length;
      const l10WinPct = last10.length > 0 ? l10Wins / last10.length : winPct;
      const l10Record = `${l10Wins}-${last10.length - l10Wins}`;

      // Serve stats
      const first1stPct  = s.svpt > 0     ? s.firstIn  / s.svpt    : null;
      const firstWonPct  = s.firstIn > 0  ? s.firstWon / s.firstIn  : null;
      const secondWonPct = (s.svpt - s.firstIn) > 0 ? s.secondWon / (s.svpt - s.firstIn) : null;
      const acesPerMatch = totalMatches > 0 ? s.aces / totalMatches : null;

      // Build H2H lookup for this player: opponentId → { wins, losses }
      const h2h = {};
      for (const [key, rec] of Object.entries(h2hMap)) {
        if (rec.a === playerId || rec.b === playerId) {
          const isA = rec.a === playerId;
          const oppId = isA ? rec.b : rec.a;
          const wins   = isA ? rec.aWins : rec.bWins;
          const losses = isA ? rec.bWins : rec.aWins;
          if (wins + losses >= 2) h2h[oppId] = { wins, losses }; // only keep if 2+ meetings
        }
      }

      const key = player.fullName.toLowerCase();
      output[key] = {
        name:         player.fullName,
        playerId,
        rank:         rankInfo.rank,
        rankPoints:   rankInfo.rankPoints,

        wins, losses, totalMatches,
        winPct: +winPct.toFixed(3),

        hardWinPct:   +hardWinPct.toFixed(3),
        clayWinPct:   +clayWinPct.toFixed(3),
        grassWinPct:  +grassWinPct.toFixed(3),
        hardRecord:   `${s.hard.w}-${s.hard.l}`,
        clayRecord:   `${s.clay.w}-${s.clay.l}`,
        grassRecord:  `${s.grass.w}-${s.grass.l}`,

        l10WinPct:    +l10WinPct.toFixed(3),
        l10Record,

        first1stPct:  first1stPct  !== null ? +first1stPct.toFixed(3)  : null,
        firstWonPct:  firstWonPct  !== null ? +firstWonPct.toFixed(3)  : null,
        secondWonPct: secondWonPct !== null ? +secondWonPct.toFixed(3) : null,
        acesPerMatch: acesPerMatch !== null ? +acesPerMatch.toFixed(1) : null,

        // H2H: keyed by opponent player_id → { wins, losses }
        h2h,
      };
    }

    res.status(200).json(output);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
