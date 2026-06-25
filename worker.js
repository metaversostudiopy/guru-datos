/* ============================================================
   ORÁCULO MUNDIAL — Worker de datos en vivo
   Combina:  Elo de eloratings.net (gratis, sin llave)
           + API-Football (fixtures, resultados y posiciones)
   Devuelve JSON en  /datos  y cachea para no gastar pedidos.

   CÓMO USARLO:
   1. Cloudflare → Workers → Create Worker → pegá este código → Deploy.
   2. En ese Worker → Settings → Variables and Secrets → Add:
        Nombre:  API_FOOTBALL_KEY     Valor: (tu llave de API-Football)
      (Es un SECRETO. No lo pegues en ningún otro lado.)
   3. Probá abriendo:  https://TU-WORKER.workers.dev/datos
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
        // ordeno por fecha; marco los próximos no jugados para pedirles predicción
        const noJugado = s => ["NS","TBD","PST"].includes(s);
        const upcoming = fx.filter(f => noJugado(f.fixture.status.short))
                           .sort((a,b)=> new Date(a.fixture.date) - new Date(b.fixture.date))
                           .slice(0, 16);
        const predIds = new Set(upcoming.map(f => f.fixture.id));
        // pido la PREDICCIÓN de la API solo para esos próximos (cachea, no gasta de más)
        const preds = {};
        for(const f of upcoming){
          try{
            const pr = await apiGet(`/predictions?fixture=${f.fixture.id}`, key);
            const p = pr[0]?.predictions;
            if(p) preds[f.fixture.id] = { home:p.percent?.home, draw:p.percent?.draw, away:p.percent?.away, advice:p.advice };
          }catch(e){}
        }
        fixtures = fx.map(f => ({
          id: f.fixture.id, date: f.fixture.date, status: f.fixture.status.short,
          group: f.league.round,
          home: f.teams.home.name, away: f.teams.away.name,
          gh: f.goals.home, ga: f.goals.away,
          pred: preds[f.fixture.id] || null
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
