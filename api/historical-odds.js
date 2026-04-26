// historical-odds.js — opening + closing line fetcher
// GET /api/historical-odds?sport=icehockey_nhl&homeTeam=X&awayTeam=Y&gameDate=ISO&apiKey=KEY
//
// Optional: &mode=opening  → fetch only the opening snapshot (saves 1 credit).
// Used for live game line-movement signal where the closing snapshot doesn’t
// yet exist. Default mode (no param) fetches both, used for grading past bets.

const APPROVED = [‘draftkings’,‘fanduel’,‘betmgm’,‘caesars’,‘williamhill_us’,‘pinnacle’];

function norm(s) { return (s||’’).toLowerCase().trim().replace(/\s+/g,’ ’); }

function findGame(games, home, away) {
const h = norm(home), a = norm(away);
return games.find(g => {
const gh = norm(g.home_team), ga = norm(g.away_team);
return (gh.includes(h.split(’ ‘).pop()) || h.includes(gh.split(’ ‘).pop())) &&
(ga.includes(a.split(’ ‘).pop()) || a.includes(ga.split(’ ’).pop()));
}) || null;
}

function getOdds(game) {
let hSum=0, aSum=0, hW=0, aW=0;
const homeLast = norm(game.home_team).split(’ ’).pop();
for (const bm of (game.bookmakers||[])) {
const key = bm.key.toLowerCase();
if (!APPROVED.includes(key)) continue;
const mkt = (bm.markets||[]).find(m => m.key===‘h2h’);
if (!mkt) continue;
const w = key===‘pinnacle’ ? 2.5 : 1;
for (const oc of (mkt.outcomes||[])) {
const p = oc.price;
const dec = (p > 1 && p < 50) ? p : (p>0 ? p/100+1 : 100/Math.abs(p)+1);
if (norm(oc.name).includes(homeLast)) { hSum+=dec*w; hW+=w; }
else { aSum+=dec*w; aW+=w; }
}
}
return {
homeOdds: hW>0 ? +(hSum/hW).toFixed(3) : null,
awayOdds: aW>0 ? +(aSum/aW).toFixed(3) : null,
};
}

async function snap(sport, iso, apiKey) {
const url = `https://api.the-odds-api.com/v4/historical/sports/${encodeURIComponent(sport)}/odds?apiKey=${apiKey}&regions=us&markets=h2h&oddsFormat=decimal&date=${encodeURIComponent(iso)}`;
const r = await fetch(url);
const body = await r.json().catch(() => ({}));
if (!r.ok) throw new Error(`OddsAPI ${r.status}: ${body.message||JSON.stringify(body).slice(0,120)}`);
return body;
}

export default async function handler(req, res) {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘GET,OPTIONS’);
if (req.method === ‘OPTIONS’) return res.status(200).end();

const { sport, homeTeam, awayTeam, gameDate, apiKey, mode } = req.query || {};
if (!sport || !homeTeam || !awayTeam || !gameDate || !apiKey)
return res.status(400).json({ error: ‘Missing params: sport, homeTeam, awayTeam, gameDate, apiKey’ });

const t = new Date(gameDate);
if (isNaN(t)) return res.status(400).json({ error: ‘Invalid gameDate’ });

// Opening = 24h before, Closing = 2h before (avoids dead zone near game time)
// Strip milliseconds — Odds API rejects timestamps with .000Z
const toISO = d => new Date(d).toISOString().replace(/.\d{3}Z$/, ‘Z’);
const openISO  = toISO(t - 24*60*60*1000);
const closeISO = toISO(t -  2*60*60*1000);

const openingOnly = mode === ‘opening’;

try {
// Opening-only mode: skip the closing fetch entirely (saves 1 credit).
// Used by live-game line-movement signal where closing doesn’t exist yet.
const fetches = openingOnly
? [snap(sport, openISO, apiKey), Promise.resolve(null)]
: [snap(sport, openISO, apiKey), snap(sport, closeISO, apiKey)];
const [openSnap, closeSnap] = await Promise.all(fetches);

```
const og = openSnap ? findGame(openSnap.data || [], homeTeam, awayTeam) : null;
const cg = closeSnap ? findGame(closeSnap.data || [], homeTeam, awayTeam) : null;

if (!og && !cg) return res.status(404).json({
  error: 'Game not found in snapshots',
  openISO, closeISO: openingOnly ? null : closeISO,
  openCount: (openSnap?.data || []).length,
  closeCount: openingOnly ? null : (closeSnap?.data || []).length,
});

const opening = og ? getOdds(og) : null;
const closing = cg ? getOdds(cg) : null;

let fairHome=null, fairAway=null;
if (closing?.homeOdds && closing?.awayOdds) {
  const rh=1/closing.homeOdds, ra=1/closing.awayOdds, v=rh+ra;
  fairHome = +(rh/v).toFixed(4);
  fairAway = +(ra/v).toFixed(4);
}

// Devig opening odds too — used directly by the live model
let openingFairHome = null, openingFairAway = null;
if (opening?.homeOdds && opening?.awayOdds) {
  const rh = 1/opening.homeOdds, ra = 1/opening.awayOdds, v = rh + ra;
  openingFairHome = +(rh/v).toFixed(4);
  openingFairAway = +(ra/v).toFixed(4);
}

return res.status(200).json({
  sport,
  homeTeam: og?.home_team || cg?.home_team || homeTeam,
  awayTeam: og?.away_team || cg?.away_team || awayTeam,
  openISO, closeISO: openingOnly ? null : closeISO,
  mode: openingOnly ? 'opening' : 'full',
  opening, closing,
  openingFairHome, openingFairAway,
  closingFairHome: fairHome,
  closingFairAway: fairAway,
  remaining: closeSnap?.['x-requests-remaining'] ?? openSnap?.['x-requests-remaining'] ?? null,
});
```

} catch(e) {
return res.status(500).json({ error: e.message });
}
}
