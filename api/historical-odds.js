// historical-odds.js — opening + closing line fetcher
// GET /api/historical-odds?sport=icehockey_nhl&homeTeam=X&awayTeam=Y&gameDate=ISO&apiKey=KEY

const APPROVED = ['draftkings','fanduel','betmgm','caesars','williamhill_us','pinnacle'];

function norm(s) { return (s||'').toLowerCase().trim().replace(/\s+/g,' '); }

function findGame(games, home, away) {
  const h = norm(home), a = norm(away);
  return games.find(g => {
    const gh = norm(g.home_team), ga = norm(g.away_team);
    return (gh.includes(h.split(' ').pop()) || h.includes(gh.split(' ').pop())) &&
           (ga.includes(a.split(' ').pop()) || a.includes(ga.split(' ').pop()));
  }) || null;
}

function getOdds(game) {
  let hSum=0, aSum=0, hW=0, aW=0;
  const homeLast = norm(game.home_team).split(' ').pop();
  for (const bm of (game.bookmakers||[])) {
    const key = bm.key.toLowerCase();
    if (!APPROVED.includes(key)) continue;
    const mkt = (bm.markets||[]).find(m => m.key==='h2h');
    if (!mkt) continue;
    const w = key==='pinnacle' ? 2.5 : 1;
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { sport, homeTeam, awayTeam, gameDate, apiKey } = req.query || {};
  if (!sport || !homeTeam || !awayTeam || !gameDate || !apiKey)
    return res.status(400).json({ error: 'Missing params: sport, homeTeam, awayTeam, gameDate, apiKey' });

  const t = new Date(gameDate);
  if (isNaN(t)) return res.status(400).json({ error: 'Invalid gameDate' });

  // Opening = 24h before, Closing = 30min before
  const openISO  = new Date(t - 24*60*60*1000).toISOString();
  const closeISO = new Date(t -    30*60*1000).toISOString();

  try {
    const [openSnap, closeSnap] = await Promise.all([
      snap(sport, openISO, apiKey),
      snap(sport, closeISO, apiKey),
    ]);

    const og = findGame(openSnap.data||[], homeTeam, awayTeam);
    const cg = findGame(closeSnap.data||[], homeTeam, awayTeam);

    if (!og && !cg) return res.status(404).json({
      error: 'Game not found in snapshots',
      openISO, closeISO,
      openCount: (openSnap.data||[]).length,
      closeCount: (closeSnap.data||[]).length,
    });

    const opening = og ? getOdds(og) : null;
    const closing = cg ? getOdds(cg) : null;

    let fairHome=null, fairAway=null;
    if (closing?.homeOdds && closing?.awayOdds) {
      const rh=1/closing.homeOdds, ra=1/closing.awayOdds, v=rh+ra;
      fairHome = +(rh/v).toFixed(4);
      fairAway = +(ra/v).toFixed(4);
    }

    return res.status(200).json({
      sport,
      homeTeam: og?.home_team || cg?.home_team || homeTeam,
      awayTeam: og?.away_team || cg?.away_team || awayTeam,
      openISO, closeISO,
      opening, closing,
      closingFairHome: fairHome,
      closingFairAway: fairAway,
      remaining: closeSnap['x-requests-remaining'] ?? openSnap['x-requests-remaining'] ?? null,
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
