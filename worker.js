/* ============================================================
   ORÁCULO MUNDIAL — Worker de datos en vivo
   Combina:  Elo de eloratings.net (gratis, sin llave)
           + API-Football (fixtures, resultados, posiciones,
             predicción y CUOTAS reales de casa de apuestas)
   Devuelve JSON en  /datos  y cachea para no gastar pedidos.

   CÓMO USARLO:
   1. Cloudflare → Workers → Create Worker → pegá este código → Deploy.
   2. En ese Worker → Settings → Variables and Secrets → Add:
        Nombre:  API_FOOTBALL_KEY     Valor: (tu llave de API-Football)
      (Es un SECRETO. No lo pegues en ningún otro lado.)
   3. Probá abriendo:  https://TU-WORKER.workers.dev/datos

   NOVEDAD: cada próximo partido trae ahora "odds" con la cuota real
   de una casa grande (Bet365 si está, si no la primera disponible):
     odds = { casa, r:{h,d,a}, dc:{hd,ha,da}, ou25:{o,u}, btts:{s,n} }
   Si un partido no tiene cuota, odds queda en null y la app usa la
   "cuota justa" (1 / probabilidad) como referencia.
============================================================ */

const API_BASE = "https://v3.football.api-sports.io";
const LEAGUE   = 1;      // Copa del Mundo en API-Football
const SEASON   = 2026;
const CACHE_MIN = 20;    // minutos de caché (cuidar el límite de pedidos)

// código de eloratings  ->  código FIFA del sistema
const ELO2FIFA = {AR:"ARG",ES:"ESP",FR:"FRA",EN:"ENG",BR:"BRA",CO:"COL",PT:"POR",NL:"NED",DE:"GER",NO:"NOR",JP:"JPN",CH:"SUI",HR:"CRO",MX:"MEX",MA:"MAR",BE:"BEL",EC:"ECU",UY:"URU",AT:"AUT",US:"USA",SN:"SEN",PY:"PAR",TR:"TUR",AU:"AUS",DZ:"DZA",KR:"KOR",IR:"IRN",CA:"CAN",SQ:"SCO",EG:"EGY",CI:"CIV",SE:"SWE",CZ:"CZE",UZ:"UZB",PA:"PAN",CD:"COD",JO:"JOR",CV:"CPV",BA:"BIH",IQ:"IRQ",GH:"GHA",NZ:"NZL",ZA:"RSA",HT:"HTI",SA:"KSA",TN:"TUN",CW:"CUW",QA:"QAT"};

async function getElo(){
  const elo = {};
  try{
    const r = await fetch("https://www.eloratings.net/World.tsv", { cf:{ cacheTtl: 3600 } });
    const txt = await r.text();
    for(const line of txt.split("\n")){
      const c = line.split("\t");
      if(c.length < 4) continue;
      const code = ELO2FIFA[c[2]];
      if(code) elo[code] = parseInt(c[3], 10);
    }
  }catch(e){}
  return elo;
}

async function apiGet(path, key){
  const r = await fetch(API_BASE + path, { headers: { "x-apisports-key": key } });
  const j = await r.json();
  return j.response || [];
}

/* ----------- CUOTAS: helpers para leer el /odds de API-Football -----------
   La respuesta trae varios "bookmakers", cada uno con "bets" (mercados),
   y cada bet con "values" ({value, odd}). Elegimos UNA casa y sacamos
   solo los 4 mercados que la app entiende. Todo a prueba de faltantes. */
function oddNum(x){ const n = parseFloat(x); return isFinite(n) ? n : null; }

function pickBookmaker(bms){
  if(!Array.isArray(bms) || !bms.length) return null;
  const tiene1x2 = bm => (bm.bets||[]).some(b => /match winner/i.test(b.name||""));
  return bms.find(bm => /bet365/i.test(bm.name||"") && tiene1x2(bm))
      || bms.find(tiene1x2)
      || bms[0];
}
function findBet(bets, rx){ return (bets||[]).find(b => rx.test(b.name||"")); }
function betVal(bet, rx){
  const v = (bet && bet.values || []).find(x => rx.test(String(x.value)));
  return v ? oddNum(v.odd) : null;
}

// Convierte la respuesta de /odds de UN partido en nuestro formato chico.
function mapOdds(resp){
  const entry = Array.isArray(resp) ? resp[0] : null;
  const bm = pickBookmaker(entry && entry.bookmakers);
  if(!bm) return null;
  const bets = bm.bets || [];
  const out = { casa: bm.name || "Casa" };
  let any = false;

  // 1X2 (Resultado)
  const mw = findBet(bets, /match winner/i) || findBet(bets, /^1x2$/i);
  if(mw){
    const h = betVal(mw, /^home$/i), d = betVal(mw, /^draw$/i), a = betVal(mw, /^away$/i);
    if(h || d || a){ out.r = { h, d, a }; any = true; }
  }
  // Doble oportunidad
  const dc = findBet(bets, /double chance/i);
  if(dc){
    const hd = betVal(dc, /home\/draw|^1x$/i);   // 1X
    const ha = betVal(dc, /home\/away|^12$/i);   // 12
    const da = betVal(dc, /draw\/away|^x2$/i);   // X2
    if(hd || ha || da){ out.dc = { hd, ha, da }; any = true; }
  }
  // Más / Menos 2.5 goles
  const ou = findBet(bets, /goals over\/under|over\/under/i);
  if(ou){
    const o = betVal(ou, /over 2\.5/i), u = betVal(ou, /under 2\.5/i);
    if(o || u){ out.ou25 = { o, u }; any = true; }
  }
  // Ambos marcan
  const bt = findBet(bets, /both teams (to )?score/i);
  if(bt){
    const s = betVal(bt, /^yes$/i), n = betVal(bt, /^no$/i);
    if(s || n){ out.btts = { s, n }; any = true; }
  }
  return any ? out : null;
}

export default {
  async fetch(req, env){
    const cors = { "Access-Control-Allow-Origin":"*", "content-type":"application/json; charset=utf-8" };
    const url = new URL(req.url);
    if(req.method === "OPTIONS") return new Response("ok", { headers: cors });

    if(url.pathname !== "/datos"){
      return new Response(JSON.stringify({ ok:true, uso:"GET /datos" }), { headers: cors });
    }

    // caché (para no quemar los pedidos de la API)
    const cache = caches.default;
    const cacheKey = new Request(url.origin + "/datos-cache");
    if(!url.searchParams.get("fresh")){
      const hit = await cache.match(cacheKey);
      if(hit) return hit;
    }

    try{
      const key = env.API_FOOTBALL_KEY;
      const elo = await getElo();
      let standings = [], fixtures = [];

      if(key){
        const st = await apiGet(`/standings?league=${LEAGUE}&season=${SEASON}`, key);
        const grupos = st[0]?.league?.standings || [];
        grupos.forEach(grp => grp.forEach(row => {
          standings.push({
            team: row.team.name, group: row.group,
            w: row.all.win, d: row.all.draw, l: row.all.lose, pts: row.points,
            gf: row.all.goals.for, ga: row.all.goals.against
          });
        }));

        const fx = await apiGet(`/fixtures?league=${LEAGUE}&season=${SEASON}`, key);
        // ordeno por fecha; marco los próximos no jugados para pedirles predicción + cuotas
        const noJugado = s => ["NS","TBD","PST"].includes(s);
        const upcoming = fx.filter(f => noJugado(f.fixture.status.short))
                           .sort((a,b)=> new Date(a.fixture.date) - new Date(b.fixture.date))
                           .slice(0, 16);
        // pido la PREDICCIÓN y las CUOTAS de la API solo para esos próximos (cachea, no gasta de más)
        const preds = {};
        const odds  = {};
        for(const f of upcoming){
          const id = f.fixture.id;
          try{
            const pr = await apiGet(`/predictions?fixture=${id}`, key);
            const p = pr[0]?.predictions;
            if(p) preds[id] = { home:p.percent?.home, draw:p.percent?.draw, away:p.percent?.away, advice:p.advice };
          }catch(e){}
          try{
            const od = await apiGet(`/odds?fixture=${id}&league=${LEAGUE}&season=${SEASON}`, key);
            const m = mapOdds(od);
            if(m) odds[id] = m;
          }catch(e){}
        }
        fixtures = fx.map(f => ({
          id: f.fixture.id, date: f.fixture.date, status: f.fixture.status.short,
          group: f.league.round,
          home: f.teams.home.name, away: f.teams.away.name,
          gh: f.goals.home, ga: f.goals.away,
          pred: preds[f.fixture.id] || null,
          odds: odds[f.fixture.id] || null
        }));
      }

      const body = JSON.stringify({ actualizado: new Date().toISOString(), conLlave: !!key, elo, standings, fixtures });
      const toCache = new Response(body, { headers: { ...cors, "Cache-Control": `max-age=${CACHE_MIN*60}` } });
      await cache.put(cacheKey, toCache.clone());
      return new Response(body, { headers: cors });

    }catch(e){
      return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: cors });
    }
  }
};
