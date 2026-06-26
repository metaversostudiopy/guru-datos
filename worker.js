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
const CACHE_MIN = 45;    // minutos de caché (cuidar el límite de pedidos)

// Última copia BUENA de /datos en memoria del worker (respaldo anti-parpadeo, sin configurar nada).
let LAST_GOOD = null;

// ====== CANDADO DE SERVICIO ======
// Fecha de vencimiento del servicio (formato AÑO-MES-DÍA).
// Para renovar: cambiá SOLO esta fecha y subí el worker a GitHub.
const VENCE = "2026-07-26";
// ==================================

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

// igual que apiGet pero además devuelve el texto de error (p.ej. límite) para diagnóstico
async function apiGet2(path, key){
  const r = await fetch(API_BASE + path, { headers: { "x-apisports-key": key } });
  const j = await r.json();
  let err = "";
  if (j.errors) {
    if (Array.isArray(j.errors)) err = j.errors.join("; ");
    else err = Object.values(j.errors).filter(Boolean).join("; ");
  }
  return { data: j.response || [], err };
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

// ====== ORÁCULO IA (chat con Opus 4.8) ======
// Resume los datos del torneo para pasárselos al modelo.
function oraDigest(d){
  try{
    const noJug = s => ["NS","TBD","PST"].includes(s);
    const fd = iso => { try{ return new Date(iso).toLocaleString("es-PY",{timeZone:"America/Asuncion",weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}); }catch(e){ return iso; } };
    const fx = (d.fixtures||[]).filter(f=>noJug(f.status)).sort((a,b)=>new Date(a.date)-new Date(b.date)).slice(0,16);
    const dISO = iso => { try{ return new Date(iso).toLocaleDateString("en-CA",{timeZone:"America/Asuncion"}); }catch(e){ return ""; } };
    const hoyISO = (()=>{ try{ return new Date().toLocaleDateString("en-CA",{timeZone:"America/Asuncion"}); }catch(e){ return ""; } })();
    const manISO = (()=>{ try{ return new Date(Date.now()+86400000).toLocaleDateString("en-CA",{timeZone:"America/Asuncion"}); }catch(e){ return ""; } })();
    const hoy = (()=>{ try{ return new Date().toLocaleDateString("es-PY",{timeZone:"America/Asuncion",weekday:"long",day:"2-digit",month:"long",year:"numeric"}); }catch(e){ return ""; } })();
    const hoyList = fx.filter(f=>dISO(f.date)===hoyISO).map(f=>`${f.home} vs ${f.away}`);
    let s = (hoy? `HOY es ${hoy} (hora de Paraguay).\n` : "");
    s += hoyList.length ? `PARTIDOS DE HOY (por jugarse): ${hoyList.join(" · ")}.\n\n` : `Los partidos de HOY ya se jugaron (o no hay para hoy). Para armar jugadas, usá directamente los PRÓXIMOS partidos a disputarse que están listados abajo (los primeros son los más cercanos). NO le pidas la grilla al usuario.\n\n`;
    s += "PRÓXIMOS PARTIDOS A JUGARSE DEL MUNDIAL 2026 (ya los tenés acá, usalos directamente; el primero es el más próximo):\n";
    for(const f of fx){
      const dd=dISO(f.date); const tag = dd===hoyISO ? " 🔴 HOY" : dd===manISO ? " (MAÑANA)" : "";
      s += `• ${f.home} vs ${f.away} — ${fd(f.date)}${tag}`;
      if(f.pred && f.pred.home!=null) s += ` [modelo: local ${f.pred.home}, empate ${f.pred.draw}, visitante ${f.pred.away}]`;
      if(f.odds && f.odds.r) s += ` [cuota casa: ${f.odds.r.h}/${f.odds.r.d}/${f.odds.r.a}]`;
      s += "\n";
      const gl = t => (t||[]).filter(p=>p&&p.n).slice(0,3).map(p=>`${p.n} (${p.g||0} goles, ${p.so||0}/${p.s||0} al arco)`).join(", ");
      if(f.players){ const h=gl(f.players.home), a=gl(f.players.away); if(h) s+=`   Goleadores ${f.home}: ${h}\n`; if(a) s+=`   Goleadores ${f.away}: ${a}\n`; }
    }
    if(Array.isArray(d.standings) && d.standings.length){
      s += "\nPOSICIONES (grupo · equipo · pts · G-E-P · GF-GC):\n";
      for(const x of d.standings){ if(x.group && /group [a-l]/i.test(x.group)) s += `• ${x.group}: ${x.team} ${x.pts}pts (${x.w}-${x.d}-${x.l}) ${x.gf}-${x.ga}\n`; }
    }
    return s;
  }catch(e){ return "(sin datos del torneo en este momento)"; }
}
function oraSystem(digest){
  return `Sos «El Oráculo», el tipster estrella de Gurú Digital: un asistente de apuestas canchero, seguro y con calle, especializado en el Mundial 2026. Hablás como el mejor pronosticador deportivo, no como un abogado ni un académico.

TU SISTEMA (Gurú Digital) calcula y vos DOMINÁS todas estas jugadas:
- Resultado 1X2 (gana local / empate / gana visitante).
- Doble oportunidad (1X, X2, 12).
- Ambos equipos marcan (sí / no).
- Más/Menos goles (Over/Under 2.5 y otras líneas).
- Hándicap.
- Goleadores: probabilidad de que un jugador concreto marque.
- COMBINADAS: combinás varias jugadas, multiplicás sus probabilidades para la probabilidad combinada y mostrás la cuota justa (cuota justa = 1 ÷ probabilidad).
El motor combina rating Elo + modelo de Poisson + simulación Monte Carlo. Hablá de los números con seguridad y soltura.

CÓMO HABLÁS:
1. Español rioplatense, canchero y claro, para gente que NO sabe de fútbol.
2. SIEMPRE tirás la jugada. Das tu pronóstico, los porcentajes y, si piden combinada, la armás completa con probabilidad combinada y cuota justa. Sos resolutivo: vas al grano y mojás.
2d. NOMBRÁ SIEMPRE los equipos concretos de la lista de próximos (ej. "Gana Portugal en Portugal vs Colombia", "Over 2.5 en Brasil vs Japón"). PROHIBIDO hablar en abstracto de "el favorito", "el primer cruce" o "el partido picante" sin decir qué selecciones son. Cada pata de la combinada lleva el nombre real del partido.
2c. Cuando te pidan "las mejores combinadas/jugadas" SIN especificar partidos, está PROHIBIDO preguntar cuáles querés. Agarrá VOS directamente los 2 a 4 PRIMEROS partidos de la lista de próximos y armá las combinadas YA, completas, con sus porcentajes y la cuota justa. Nada de "decime qué selecciones" ni "con cuáles arrancamos": vos elegís los próximos y tirás la boleta lista para jugar. Cerrá siempre con la jugada armada, no con una pregunta.
2b. Sos AUDAZ y jugado, NADA conservador. Cuando hay un favorito, bancalo con el 1X2 directo (gana tal), no te escondas siempre en la doble oportunidad. Buscá las jugadas de VALOR que pagan grande: resultados secos, Over goles, Ambos Marcan, goleadores. Armá combinadas con buen premio (3-4 patas) para ir por la cuota gorda. La doble oportunidad usala solo como la opción "tranqui" opcional, no como tu jugada principal. Cuando tenga sentido, ofrecé las dos: la PEGADA FUERTE (paga grande) y la SEGURA (paga menos), y resaltá la fuerte.
3. Usá los DATOS de abajo. Los PRÓXIMOS PARTIDOS A JUGARSE ya están listados ahí con su fecha: usalos directamente. NUNCA le pidas al usuario que te pase los partidos, la grilla ni las cuotas; vos YA tenés todo. Si te piden "los de hoy" y los de hoy ya se jugaron o no hay, NO te frenes ni pidas nada: ofrecé al toque los PRÓXIMOS partidos a jugarse (los primeros de la lista) y armá las jugadas con esos, aclarando en una línea "los de hoy ya se jugaron, te tiro los próximos que vienen". Si te falta algún dato puntual, lo completás con tu conocimiento del fútbol y tirás igual tu mejor pronóstico. JAMÁS te excuses: NUNCA digas "no puedo", "no tengo datos", "necesito que me pases", "tengo que ser honesto", "sería inventar" ni "no vendo humo". Esas frases están PROHIBIDAS. Sos el experto: siempre tenés una jugada para dar.
4. Tono confiado y con onda, breve y al hueso. Nada de discursos largos ni advertencias repetidas.
5. Recién si te preguntan cuánto poner, tirás UNA frase corta de jugar tranqui y listo.
6. Tu tema es el fútbol y el Mundial 2026. Si te preguntan otra cosa, lo devolvés con gracia al fútbol.
7. Sos El Oráculo de Gurú Digital. No hablás de la tecnología que te impulsa.

DATOS ACTUALES DEL MUNDIAL 2026:
${digest}`;
}

export default {
  async fetch(req, env){
    const cors = { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Methods":"GET,POST,OPTIONS", "Access-Control-Allow-Headers":"content-type", "content-type":"application/json; charset=utf-8" };
    const url = new URL(req.url);
    if(req.method === "OPTIONS") return new Response("ok", { headers: cors });

    // ====== CHAT del Oráculo (IA · Opus 4.8) ======
    if(url.pathname === "/chat"){
      if(req.method !== "POST") return new Response(JSON.stringify({ error:"usá POST" }), { status:405, headers: cors });
      if(!env.ANTHROPIC_KEY) return new Response(JSON.stringify({ error:"Falta configurar la llave de IA (ANTHROPIC_KEY) en el Worker." }), { status:500, headers: cors });
      let body; try{ body = await req.json(); }catch(e){ body = {}; }
      const message = (body.message||"").toString().slice(0, 1500);
      let history = Array.isArray(body.history) ? body.history.slice(-10) : [];
      if(!message) return new Response(JSON.stringify({ error:"mensaje vacío" }), { status:400, headers: cors });
      // datos del torneo para fundamentar la respuesta
      let digest = "(sin datos)";
      try{
        const dr = await fetch(url.origin + "/datos");
        let d = await dr.json();
        if((!d.fixtures || !d.fixtures.length) && LAST_GOOD){ try{ d = JSON.parse(LAST_GOOD); }catch(e){} }
        digest = oraDigest(d);
      }catch(e){ if(LAST_GOOD){ try{ digest = oraDigest(JSON.parse(LAST_GOOD)); }catch(e2){} } }
      const messages = [...history.filter(m=>m && (m.role==="user"||m.role==="assistant") && m.content), { role:"user", content: message }];
      try{
        const ar = await fetch("https://api.anthropic.com/v1/messages", {
          method:"POST",
          headers:{ "content-type":"application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version":"2023-06-01" },
          body: JSON.stringify({ model:"claude-opus-4-8", max_tokens:1024, system: oraSystem(digest), messages })
        });
        const aj = await ar.json();
        if(aj.error) return new Response(JSON.stringify({ error: aj.error.message || "error de IA" }), { status:502, headers: cors });
        const answer = (aj.content||[]).map(b=> b.type==="text" ? b.text : "").join("").trim();
        return new Response(JSON.stringify({ answer: answer || "No pude generar una respuesta. Probá de nuevo." }), { headers: cors });
      }catch(e){
        return new Response(JSON.stringify({ error:"No se pudo consultar la IA: "+e }), { status:502, headers: cors });
      }
    }

    // Candado de servicio: la app lee la fecha de vencimiento de acá.
    if(url.pathname === "/lic"){
      return new Response(JSON.stringify({ vence: VENCE }), {
        headers: { ...cors, "Cache-Control": "max-age=60" }
      });
    }

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
      let standings = [], fixtures = [], dbg = { tsc:0, inj:0, equiposConGol:0 };

      if(key){
        // PARTIDOS primero: es lo esencial. Así el límite por minuto no nos deja sin fixtures.
        let fxR = await apiGet2(`/fixtures?league=${LEAGUE}&season=${SEASON}`, key);
        let fx = fxR.data, fxSrc = "all", fxErr = fxR.err;
        if (!fx.length) {
          const fb = await apiGet2(`/fixtures?league=${LEAGUE}&season=${SEASON}&next=40`, key);
          if (fb.data.length) { fx = fb.data; fxSrc = "next40"; }
          if (fb.err) fxErr = (fxErr ? fxErr + " | " : "") + "next:" + fb.err;
        }
        dbg.fx = fx.length; dbg.fxSrc = fxSrc; dbg.fxErr = fxErr;

        const st = await apiGet(`/standings?league=${LEAGUE}&season=${SEASON}`, key);
        const grupos = st[0]?.league?.standings || [];
        grupos.forEach(grp => grp.forEach(row => {
          standings.push({
            team: row.team.name, group: row.group,
            w: row.all.win, d: row.all.draw, l: row.all.lose, pts: row.points,
            gf: row.all.goals.for, ga: row.all.goals.against
          });
        }));

        // GOLEADORES + TIROS por jugador (una sola llamada; trae goles, tiros y minutos)
        const scorersByTeam = {};
        let tscRaw = 0;
        try{
          const ts = await apiGet(`/players/topscorers?league=${LEAGUE}&season=${SEASON}`, key);
          tscRaw = ts.length;
          ts.forEach(p => {
            const stats = p.statistics || [];
            // elijo la estadística de ESTE torneo (no la del club), si existe
            const st = stats.find(x => x && x.league && x.league.id === LEAGUE) || stats[0] || {};
            const tid = st.team && st.team.id; if(!tid) return;
            (scorersByTeam[tid] = scorersByTeam[tid] || []).push({
              n:  p.player && p.player.name,
              g:  (st.goals && st.goals.total) || 0,
              s:  (st.shots && st.shots.total) || 0,
              so: (st.shots && st.shots.on) || 0,
              min:(st.games && st.games.minutes) || 0,
              ap: (st.games && st.games.appearences) || 0
            });
          });
        }catch(e){}

        // LESIONADOS / dudas por equipo (una sola llamada)
        const injByTeam = {};
        let injRaw = 0;
        try{
          const ij = await apiGet(`/injuries?league=${LEAGUE}&season=${SEASON}`, key);
          injRaw = ij.length;
          ij.forEach(x => {
            const tid = x.team && x.team.id; if(!tid) return;
            const nom = x.player && x.player.name; if(!nom) return;
            (injByTeam[tid] = injByTeam[tid] || []);
            if(!injByTeam[tid].includes(nom)) injByTeam[tid].push(nom);
          });
        }catch(e){}

        dbg = { tsc: tscRaw, inj: injRaw, equiposConGol: Object.keys(scorersByTeam).length };


        // ordeno por fecha; marco los próximos no jugados para pedirles predicción
        const noJugado = s => ["NS","TBD","PST"].includes(s);
        const upcoming = fx.filter(f => noJugado(f.fixture.status.short))
                           .sort((a,b)=> new Date(a.fixture.date) - new Date(b.fixture.date))
                           .slice(0, 16);
        // PREDICCIÓN de la API solo para los PRÓXIMOS 6 (no quemar el límite por minuto). La cuota la calcula la app.
        const preds = {};
        for(const f of upcoming.slice(0, 6)){
          const id = f.fixture.id;
          try{
            const pr = await apiGet(`/predictions?fixture=${id}`, key);
            const p = pr[0]?.predictions;
            if(p) preds[id] = { home:p.percent?.home, draw:p.percent?.draw, away:p.percent?.away, advice:p.advice };
          }catch(e){}
        }
        fixtures = fx.map(f => {
          const up = noJugado(f.fixture.status.short);
          const hid = f.teams.home.id, aid = f.teams.away.id;
          return {
            id: f.fixture.id, date: f.fixture.date, status: f.fixture.status.short,
            group: f.league.round,
            home: f.teams.home.name, away: f.teams.away.name,
            gh: f.goals.home, ga: f.goals.away,
            pred: preds[f.fixture.id] || null,
            odds: null,
            players: up ? { home: scorersByTeam[hid] || [], away: scorersByTeam[aid] || [] } : null,
            bajas:   up ? { home: injByTeam[hid] || [],    away: injByTeam[aid] || [] }    : null
          };
        });
      }

      // ¿la respuesta vino completa? lo esencial son los partidos; los goleadores son un extra
      const completo = (!key) || (fixtures.length > 0);
      const body = JSON.stringify({ actualizado: new Date().toISOString(), conLlave: !!key, completo, dbg, elo, standings, fixtures });

      if(completo){
        // resultado bueno: caché de borde (CACHE_MIN) + respaldo durable en KV (24 h)
        const toCache = new Response(body, { headers: { ...cors, "Cache-Control": `max-age=${CACHE_MIN*60}` } });
        await cache.put(cacheKey, toCache.clone());
        try{ if(env.DATOS_KV) await env.DATOS_KV.put("datos", body, { expirationTtl: 86400 }); }catch(e){}
        LAST_GOOD = body;
        return new Response(body, { headers: cors });
      }

      // incompleto (límite de la API): sirvo el último respaldo BUENO que tenga.
      const prev = await cache.match(cacheKey);
      if(prev) return prev;
      // respaldo en memoria del worker (anti-parpadeo, sin configurar nada)
      if(LAST_GOOD){
        const r = new Response(LAST_GOOD, { headers: { ...cors, "Cache-Control": "max-age=600" } });
        try{ await cache.put(cacheKey, r.clone()); }catch(e){}
        return r;
      }
      // respaldo durable en KV: si ya cargó bien alguna vez, lo uso (y lo dejo en borde 10 min)
      try{
        if(env.DATOS_KV){
          const saved = await env.DATOS_KV.get("datos");
          if(saved){
            const r = new Response(saved, { headers: { ...cors, "Cache-Control": "max-age=600" } });
            await cache.put(cacheKey, r.clone());
            return r;
          }
        }
      }catch(e){}
      // todavía no hay ningún respaldo bueno: espero 2 min antes de reintentar (no golpear la API)
      return new Response(body, { headers: { ...cors, "Cache-Control": "max-age=120" } });

    }catch(e){
      return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: cors });
    }
  }
};
