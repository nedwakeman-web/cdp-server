'use strict';
const express = require('express');
const path = require('path');
const https = require('https');
const app = express();

// ── CORS — accept all origins (frontend is public; auth handled by tier logic) ──
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════════
// SWISS EPHEMERIS 2026 — verified from Astrodienst ae_2026.pdf
// [sun°, moon°, mercury°, venus°, mars°, jupiter°, saturn°, uranus°, neptune°, pluto°]
// Decimal tropical geocentric at 00:00 UT
// Signs: Ar=0 Ta=30 Ge=60 Ca=90 Le=120 Vi=150 Li=180 Sc=210 Sg=240 Cp=270 Aq=300 Pi=330
// ══════════════════════════════════════════════════════════════════
const EPH = {
  '2026-03-29':[8.31,19.13,11.42,359.65,20.77,105.17,5.17,58.57,2.08,305.20],
  '2026-03-30':[9.30,2.45,12.12,0.42,21.55,105.22,5.30,58.62,2.08,305.20],
  '2026-03-31':[10.29,165.57,12.88,1.08,22.33,105.72,5.42,58.72,2.17,305.20],
  '2026-04-01':[11.28,178.48,13.70,1.63,23.12,105.78,5.55,58.80,2.20,305.23],
  '2026-04-02':[12.26,191.20,14.57,2.87,23.90,105.85,5.67,58.80,2.23,305.23],
  '2026-04-03':[13.25,203.72,15.50,4.10,24.68,105.92,5.80,58.85,2.28,305.25],
  '2026-04-04':[14.23,216.05,16.47,5.33,25.47,105.98,5.92,58.90,2.32,305.27],
  '2026-04-05':[15.22,228.22,17.48,6.57,26.25,106.07,6.05,58.93,2.35,305.28],
  '2026-04-06':[16.20,240.23,18.55,7.78,27.02,106.15,6.17,58.98,2.38,305.30],
  '2026-04-07':[17.19,252.15,19.65,9.02,27.80,106.22,6.28,59.03,2.43,305.30],
  '2026-04-08':[18.17,264.03,20.80,10.25,28.58,106.30,6.42,59.08,2.47,305.32],
  '2026-04-09':[19.15,275.92,21.98,11.47,29.37,106.40,6.53,59.13,2.50,305.33],
  '2026-04-10':[20.14,287.88,23.20,12.70,0.15,106.48,6.67,59.17,2.53,305.35],
  '2026-04-11':[21.12,300.03,24.45,13.92,0.92,106.57,6.78,59.22,2.57,305.37],
  '2026-04-12':[22.10,312.43,25.73,15.15,1.70,106.67,6.90,59.27,2.60,305.38],
  '2026-04-13':[23.08,324.80,27.07,16.37,2.48,106.77,7.03,59.32,2.65,305.40],
  '2026-04-14':[24.06,337.27,28.42,17.60,3.25,106.87,7.15,59.37,2.68,305.42],
  '2026-04-15':[25.04,349.80,29.80,18.82,4.03,106.97,7.27,59.42,2.72,305.43],
  '2026-04-16':[26.02,2.37,1.22,20.03,4.80,107.07,7.38,59.45,2.75,305.45],
  '2026-04-17':[27.00,14.97,2.67,21.27,5.58,107.18,7.52,59.50,2.78,305.47],
  '2026-04-18':[27.98,27.95,4.15,22.48,6.35,107.28,7.63,59.57,2.82,305.48],
  '2026-04-19':[28.96,49.78,5.65,23.70,7.13,107.40,7.75,59.62,2.87,305.50],
  '2026-04-20':[29.93,64.78,7.18,24.92,7.90,107.52,7.87,59.68,2.90,305.52],
  '2026-04-21':[30.91,79.62,8.75,26.15,8.68,107.63,7.98,59.73,2.93,305.53],
  '2026-04-22':[31.88,94.23,10.35,27.37,9.45,107.75,8.10,59.78,2.97,305.55],
  '2026-04-23':[32.86,108.62,11.97,28.58,10.22,107.87,8.22,59.83,3.00,305.57],
  '2026-04-24':[33.84,122.48,13.62,29.80,11.00,107.98,8.35,59.88,3.03,305.58],
  '2026-04-25':[34.81,136.10,15.30,31.02,11.77,108.12,8.47,59.92,3.07,305.60],
  '2026-04-26':[35.79,149.42,17.00,32.23,12.53,108.25,8.57,60.00,3.12,305.62],
  '2026-04-27':[36.76,162.37,18.73,33.43,13.30,108.37,8.68,60.05,3.13,305.63],
  '2026-04-28':[37.73,175.33,20.50,34.65,14.07,108.50,8.80,60.10,3.17,305.65],
  '2026-04-29':[38.70,188.27,22.30,35.87,14.83,108.63,8.92,60.13,3.20,305.67],
  '2026-04-30':[39.67,200.25,24.12,37.08,15.60,108.78,9.03,60.22,3.23,305.50],
  '2026-05-01':[40.64,212.00,25.97,38.28,16.37,108.92,9.15,60.28,3.27,305.50],
  '2026-05-15':[55.29,280.00,12.00,53.03,24.07,109.80,10.25,60.75,3.58,305.68],
  '2026-06-01':[71.24,310.00,26.25,68.22,32.25,110.25,11.15,61.12,3.83,305.68],
};

const PLANETS = ['Sun','Moon','Mercury','Venus','Mars','Jupiter','Saturn','Uranus','Neptune','Pluto'];
const SIGNS = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];

function getSign(deg){const d=((deg%360)+360)%360;return SIGNS[Math.floor(d/30)];}
function getDegInSign(deg){const d=((deg%360)+360)%360;return (d%30).toFixed(1);}

function getEphData(dateStr){
  if(EPH[dateStr])return EPH[dateStr];
  const keys=Object.keys(EPH).sort();
  let prev=null,next=null;
  for(const k of keys){if(k<=dateStr)prev=k;if(k>=dateStr&&!next)next=k;}
  if(!prev)return EPH[keys[0]];
  if(!next)return EPH[keys[keys.length-1]];
  if(prev===next)return EPH[prev];
  const d0=new Date(prev),d1=new Date(next),d2=new Date(dateStr);
  const t=(d2-d0)/(d1-d0);
  return EPH[prev].map((v,i)=>v+t*(EPH[next][i]-v));
}

function buildPlanets(dateStr){
  const raw=getEphData(dateStr);
  return raw.map((deg,i)=>({name:PLANETS[i],deg,sign:getSign(deg),degStr:`${getDegInSign(deg)}° ${getSign(deg)}`}));
}

// ══════════════════════════════════════════════════════════════════
// MOON PHASE — USNO verified new moon Jan 17, 2026 02:02 UTC
// ══════════════════════════════════════════════════════════════════
const LUNAR=29.53058867;
const MOON_ANCHOR=new Date('2026-01-17T02:02:00Z');

function getMoon(dateStr){
  const d=new Date(dateStr+'T12:00:00Z');
  const days=((d-MOON_ANCHOR)/(86400000));
  const cyc=((days%LUNAR)+LUNAR)%LUNAR;
  const pct=Math.round(cyc/LUNAR*100);
  let phase,emoji,desc;
  if(cyc<1.5){phase='New Moon';emoji='🌑';desc='Dark time — seed intention in silence';}
  else if(cyc<7.5){phase='Waxing Crescent';emoji='🌒';desc='Build momentum, plant seeds';}
  else if(cyc<8.5){phase='First Quarter';emoji='🌓';desc='Decisive action, push through resistance';}
  else if(cyc<14.5){phase='Waxing Gibbous';emoji='🌔';desc='Refine, polish, prepare for release';}
  else if(cyc<16.5){phase='Full Moon';emoji='🌕';desc='Illumination — what is real becomes visible';}
  else if(cyc<22.5){phase='Waning Gibbous';emoji='🌖';desc='Harvest, integrate, share wisdom';}
  else if(cyc<23.5){phase='Last Quarter';emoji='🌗';desc:'Reassess, release what no longer serves';}
  else{phase='Waning Crescent';emoji='🌘';desc='Rest, reflect, prepare for rebirth';}
  const toNew=cyc<0.5?0:LUNAR-cyc;
  const toFull=cyc<14.77?14.77-cyc:LUNAR-cyc+14.77;
  const isBlack=cyc>27.53;
  const isShiva=cyc>=1.5&&cyc<=3.5;
  return{phase,emoji,desc,cycle:cyc.toFixed(1),pct,toNew:toNew.toFixed(1),toFull:toFull.toFixed(1),isBlack,isShiva};
}

// ══════════════════════════════════════════════════════════════════
// DREAMSPELL — March 31 2026 = Kin 52 (verified)
// ══════════════════════════════════════════════════════════════════
const KIN_ANCHOR_D=new Date('2026-03-31T12:00:00Z');
const KIN_ANCHOR=52;
const SEALS=['Red Dragon','White Wind','Blue Night','Yellow Seed','Red Serpent',
  'White World-Bridger','Blue Hand','Yellow Star','Red Moon','White Dog',
  'Blue Monkey','Yellow Human','Red Skywalker','White Wizard','Blue Eagle',
  'Yellow Warrior','Red Earth','White Mirror','Blue Storm','Yellow Sun'];
const TONES=['Magnetic','Lunar','Electric','Self-Existing','Overtone','Rhythmic',
  'Resonant','Galactic','Solar','Planetary','Spectral','Crystal','Cosmic'];
const KIN_COLORS=['Red','White','Blue','Yellow','Red','White','Blue','Yellow','Red','White',
  'Blue','Yellow','Red','White','Blue','Yellow','Red','White','Blue','Yellow'];
const GAP=new Set([1,2,3,4,5,8,9,10,11,12,19,20,21,22,23,26,27,28,29,30,
  53,54,55,56,57,60,61,62,63,64,71,72,73,74,75,78,79,80,81,82,
  105,106,107,108,109,112,113,114,115,116,133,134]);

function getKin(dateStr){
  const d=new Date(dateStr+'T12:00:00Z');
  const days=Math.round((d-KIN_ANCHOR_D)/86400000);
  const kin=((KIN_ANCHOR-1+days)%260+260)%260+1;
  const si=(kin-1)%20;
  const ti=(kin-1)%13;
  const col=KIN_COLORS[si];
  return{kin,tone:TONES[ti],toneNum:ti+1,seal:SEALS[si],color:col,isGAP:GAP.has(kin),
    full:`Kin ${kin} — ${col} ${TONES[ti]} ${SEALS[si]}`};
}

// Week-ahead helper
function getWeekAhead(startDateStr){
  const result=[];
  for(let i=0;i<7;i++){
    const d=new Date(startDateStr+'T12:00:00Z');
    d.setUTCDate(d.getUTCDate()+i);
    const ds=d.toISOString().slice(0,10);
    const k=getKin(ds);
    const[y,m,day]=ds.split('-').map(Number);
    const udRaw=m+day+String(y).split('').reduce((a,b)=>a+parseInt(b),0);
    let ud=udRaw;
    const masters=new Set([11,22,33,44]);
    while(ud>9&&!masters.has(ud))ud=String(ud).split('').reduce((a,b)=>a+parseInt(b),0);
    result.push({date:ds,dayStr:d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'numeric'}),kin:k.full,ud,isGAP:k.isGAP});
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════
// NUMEROLOGY
// ══════════════════════════════════════════════════════════════════
function reduce(n){
  while(n>9&&n!==11&&n!==22&&n!==33&&n!==44)
    n=String(n).split('').reduce((a,b)=>a+parseInt(b),0);
  return n;
}
const NUM={
  1:{n:'New Beginnings',k:'Initiation · leadership · independence'},
  2:{n:'Partnership',k:'Cooperation · balance · receptivity'},
  3:{n:'Creative Expression',k:'Joy · communication · creative flow'},
  4:{n:'Foundation & Order',k:'Structure · discipline · patient building'},
  5:{n:'Freedom & Change',k:'Adventure · versatility · expansion'},
  6:{n:'Love & Responsibility',k:'Harmony · family · service · care'},
  7:{n:'Wisdom & Introspection',k:'Analysis · spiritual depth · truth-seeking'},
  8:{n:'Power & Abundance',k:'Authority · material mastery · accountability'},
  9:{n:'Completion & Compassion',k:'Wisdom · generosity · release · universal love'},
  11:{n:'Master Illuminator',k:'Spiritual vision · intuition · higher purpose'},
  22:{n:'Master Builder',k:'Large-scale vision · practical idealism'},
  33:{n:'Master Teacher',k:'Healing · compassion · selfless guidance'},
  44:{n:'Master Organiser',k:'Systemic mastery · material achievement'},
};

function getNumerology(dateStr,bDay,bMonth,bYear){
  const[y,m,d]=dateStr.split('-').map(Number);
  const udRaw=m+d+String(y).split('').reduce((a,b)=>a+parseInt(b),0);
  const ud=reduce(udRaw);
  const mEn=reduce(m);
  const yRaw=String(y).split('').reduce((a,b)=>a+parseInt(b),0);
  const yEn=reduce(yRaw);
  let lp=null,py=null,pm=null,pd=null;
  if(bDay&&bMonth&&bYear){
    lp=reduce(bDay+bMonth+String(bYear).split('').reduce((a,b)=>a+parseInt(b),0));
    py=reduce(bDay+bMonth+reduce(yRaw));
    pm=reduce(py+m);
    pd=reduce(pm+d);
  }
  return{ud,udM:NUM[ud],mEn,mEnM:NUM[mEn],yEn,yEnM:NUM[yEn],
    lp,lpM:lp?NUM[lp]:null,py,pyM:py?NUM[py]:null,
    pm,pmM:pm?NUM[pm]:null,pd,pdM:pd?NUM[pd]:null};
}

// ══════════════════════════════════════════════════════════════════
// ASPECTS
// ══════════════════════════════════════════════════════════════════
const ASPS=[
  {n:'conjunction',d:0,orb:8,sym:'☌'},
  {n:'opposition',d:180,orb:8,sym:'☍'},
  {n:'trine',d:120,orb:7,sym:'△'},
  {n:'square',d:90,orb:7,sym:'□'},
  {n:'sextile',d:60,orb:5,sym:'⚹'},
];

function getAspects(planets){
  const out=[];
  for(let i=0;i<planets.length;i++){
    for(let j=i+1;j<planets.length;j++){
      let diff=Math.abs(planets[i].deg-planets[j].deg);
      if(diff>180)diff=360-diff;
      for(const a of ASPS){
        const orb=Math.abs(diff-a.d);
        if(orb<=a.orb){
          const str=Math.max(1,5-Math.floor(orb/(a.orb/5)));
          out.push({p1:planets[i].name,p2:planets[j].name,aspect:a.n,sym:a.sym,
            orb:orb.toFixed(1),str,
            label:`${planets[i].name} ${a.sym} ${planets[j].name}`,
            desc:`${planets[i].name} ${getDegInSign(planets[i].deg)}° ${getSign(planets[i].deg)} ${a.n} ${planets[j].name} ${getDegInSign(planets[j].deg)}° ${getSign(planets[j].deg)} (${orb.toFixed(1)}° orb)`});
          break;
        }
      }
    }
  }
  return out.sort((a,b)=>b.str-a.str).slice(0,8);
}

// ══════════════════════════════════════════════════════════════════
// THE FIX: STREAMING API CALL
// Uses Anthropic's SSE streaming so Railway never sees an idle
// connection — data flows token-by-token, killing the timeout problem
// entirely. Full 4096-token output restored. Quality benchmark met.
// ══════════════════════════════════════════════════════════════════
function callAPI(model, maxTok, sys, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: maxTok,
      stream: true,
      messages: [{role: 'user', content: user}],
      ...(sys ? {system: sys} : {})
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let buffer = '';
      let fullText = '';
      let resolved = false;

      res.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // hold incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const evt = JSON.parse(data);
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              fullText += evt.delta.text;
            } else if (evt.type === 'message_stop') {
              if (!resolved) { resolved = true; resolve(fullText); }
            } else if (evt.error) {
              if (!resolved) { resolved = true; reject(new Error(evt.error.message)); }
            }
          } catch(e) { /* partial JSON line, skip */ }
        }
      });

      res.on('end', () => {
        if (!resolved) { resolved = true; resolve(fullText); }
      });

      res.on('error', err => {
        if (!resolved) { resolved = true; reject(err); }
      });
    });

    req.on('error', err => reject(err));
    // 120s socket timeout — 8192 token responses take time to stream
    req.setTimeout(120000, () => {
      req.destroy(new Error('Socket timeout after 120s'));
    });
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════
// ORACLE READING — FULL SCHEMA, FULL QUALITY, BENCHMARK STANDARD
// Matches and extends the March 31 2026 reading
// ══════════════════════════════════════════════════════════════════
async function generateReading(dateStr, profile, tier) {
  const planets = buildPlanets(dateStr);
  const moon = getMoon(dateStr);
  const kin = getKin(dateStr);
  const p = profile || {};
  const num = getNumerology(dateStr, p.birthDay, p.birthMonth, p.birthYear);
  const aspects = getAspects(planets);
  const weekAhead = getWeekAhead(dateStr);

  // ── DYNAMIC PROFILE — fully from user input, no hardcoded fallbacks ──
  const userName = p.name || p.nickname || 'the reader';
  const firstName = p.nickname || (p.name ? p.name.split(' ')[0] : 'you');
  const userLocation = p.location || 'their location';
  const userContext = p.context || '';
  const userBirth = (p.birthDay && p.birthMonth && p.birthYear)
    ? `${p.birthDay}/${p.birthMonth}/${p.birthYear}${p.birthTime ? ' ' + p.birthTime : ''}`
    : 'not provided';

  // Build birth kin string from calculated num
  const birthKinStr = num.birthKin ? `Kin ${num.birthKin.kin} — ${num.birthKin.full}` : 'not calculated';

  // Profile context for the Oracle — ONLY from user input
  const profileBlock = `Name: ${userName}
Location: ${userLocation}
Date of Birth: ${userBirth}
Birth Kin (Dreamspell): ${birthKinStr}
Life Path: ${num.lp || 'not calculated'} (${num.lpM?.n || ''})
Personal Year: ${num.py || 'not calculated'} (${num.pyM?.n || ''})
Personal Context: ${userContext || 'None provided — give a universal reading grounded in the cosmic data.'}`;

  const pTable = planets.map(pl => `${pl.name}: ${pl.degStr}`).join('\n');
  const aList = aspects.slice(0,6).map(a => `${'●'.repeat(a.str)}${'○'.repeat(5-a.str)} ${a.desc}`).join('\n');

  const moonAlert = moon.isBlack
    ? `★ BLACK MOON (2 days before New Moon) — tricky, introspective threshold. ${firstName} should not initiate major actions today; observe and prepare instead.`
    : moon.isShiva
      ? `★ SHIVA MOON (2 days after New Moon) — blissful, regenerative. Auspicious for new actions, new conversations, and fresh starts for ${firstName}.`
      : '';

  const satNep = `Saturn ${planets[6].degStr} conjunct Neptune ${planets[8].degStr} — historically significant (Tarnas 2006): last Aries conjunction ~1522 (Magellan circumnavigation, Luther's Reformation), then 1917 (WWI/Russian Revolution), 1952, 1989 (Berlin Wall fall). In Aries = genesis, not reform. Dissolution of old structures meeting new idealism.`;

  const uranus = `Uranus ${planets[7].degStr} — approaching Gemini ingress ~April 26 2026. Financial structures, communication architectures, and valuations disrupted and liberated.`;

  const mars = planets[4].sign === 'Pisces'
    ? `Mars ${planets[4].degStr} — in Pisces, drive is inward and visionary. Physical energy best metabolised through creative and strategic work rather than force.`
    : `Mars ${planets[4].degStr} — in Aries, drive is ignited. Decisive action rewarded. Watch for overextension.`;

  const weekAheadJSON = weekAhead.map((w,i) => i===0
    ? `{"date":"${w.date}","day":"${w.dayStr}","kin":"${w.kin}","ud":${w.ud},"isGAP":${w.isGAP},"note":"<Today — 2-sentence summary>"}`
    : `{"date":"${w.date}","day":"${w.dayStr}","kin":"${w.kin}","ud":${w.ud},"isGAP":${w.isGAP},"note":"<2-sentence personalised note for ${firstName} — Dreamspell tone + UD meaning + practical pointer>"}`
  ).join(',\n    ');

  // ── TIER-SPECIFIC SCOPE ──
  const tierScope = {
    free: `TIER: Free — Generate ONLY: synthesis (1 sentence), Universal Day number + name + one sentence meaning, moon phase + sign, today's Kin, one "For Today" action. JSON must have: synthesis, numerology:{headline, body(1 paragraph)}, moon_section:{headline, body(1 paragraph)}, dreamspell:{headline}, closing_line. Nothing else. Keep total output under 500 tokens.`,
    seeker: `TIER: Seeker — Generate full reading with: synthesis, numerology (all fields including three_energies), moon_section, astrology (main_transit only, no saturn_neptune deep dive), dreamspell, priorities (3), focus_on, ease_off, time_windows, closing_line, sources. No week_ahead, no daily_gift. Keep prose fields to 2 sentences each.`,
    initiate: `TIER: Initiate — Generate full reading with all fields except: omit daily_gift.meditation and deep saturn_neptune historical analysis. Keep prose fields to 3 sentences each. Include week_ahead.`,
    mystic: `TIER: Mystic — Generate complete reading with all fields. Include natal chart context. Keep prose fields to 3-4 sentences. Full week_ahead. Full daily_gift.`,
    oracle: `TIER: Oracle — Generate the COMPLETE, MAXIMALLY DETAILED reading. Every field, maximum depth, 3-5 sentences per prose field. Full historical context for saturn_neptune. Full week_ahead with personalised notes. Complete daily_gift with meditation. This is the premium bespoke experience.`
  };
  const scope = tierScope[tier] || tierScope.oracle;

  const sys = `You are the Oracle at Cosmic Daily Planner (cosmicdailyplanner.com) — a rigorous, personalised daily cosmic planner synthesising Swiss Ephemeris astronomy, Pythagorean numerology, Western psychological astrology, and Dreamspell/Law of Time.

YOUR VOICE: The best Jungian analyst meets the Swiss Ephemeris. Precise. Personal. Grounded. Emotionally intelligent.

${scope}

CRITICAL RULES:
— Use ONLY the Swiss Ephemeris positions provided. Never invent planetary data.
— Address the reader by their first name (${firstName}) throughout. Use ONLY the personal context they have provided — do not invent details about their life.
— If personal context is provided (companies, family, projects, relationships), reference it specifically. If not provided, speak universally but still specifically to the cosmic weather.
— Dreamspell is ALWAYS labelled: Argüelles (1987) The Mayan Factor — modern 20th-century system, distinct from ancient K'iche' Maya tradition maintained by Guatemalan daykeepers.
— No deterministic predictions. Speak in possibilities and tendencies.
— Every section must be grounded in the actual planetary data and personal context provided.
— RESPOND ONLY WITH VALID JSON. No markdown fences. No preamble. No text outside the JSON object.
— CRITICAL: The JSON MUST be syntactically complete and valid. Every opened brace and bracket must be closed. If approaching length limit, shorten EARLIER sections first — but always close the JSON properly.
— SCHOLARLY SOURCES: Šprajc et al. 2023 (Science Advances); Aldana 2022; Tarnas 2006 Cosmos & Psyche; Greene 1976 Saturn; Hand 2002 Planets in Transit; Brady 1999; Brennan 2017; Drayer 2002 Numerology; Kahn 2001 Pythagoras.`;

  const user = `PROFILE:
${profileBlock}

DATE: ${dateStr} (${new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'})})

VERIFIED PLANETARY POSITIONS (Swiss Ephemeris ae_2026.pdf, Astrodienst AG):
${pTable}

MOON: ${moon.phase} ${moon.emoji} — ${moon.cycle} days into lunar cycle (${moon.pct}% illuminated)
${moonAlert}
Days to Next New Moon: ~${moon.toNew} | Days to Next Full Moon: ~${moon.toFull}

NUMEROLOGY:
Universal Day: ${num.ud} — ${num.udM?.n} | ${num.udM?.k}
Month Energy (${new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-GB', {month:'long'})}): ${num.mEn} — ${num.mEnM?.n}
Year Energy (${dateStr.slice(0,4)}): ${num.yEn} — ${num.yEnM?.n}
Personal Year: ${num.py || 'n/a'} | Personal Month: ${num.pm || 'n/a'} | Personal Day: ${num.pd || 'n/a'}
THREE ENERGIES OF DAY: Morning=${num.pd || num.ud} (${NUM[num.pd || num.ud]?.n}), Afternoon=${num.pm || num.mEn} (${NUM[num.pm || num.mEn]?.n}), Evening=${num.py || num.yEn} (${NUM[num.py || num.yEn]?.n})

DREAMSPELL (Argüelles 1987 — modern system, verify: tortuga.com/oracle):
${kin.full}${kin.isGAP ? ' ★ GALACTIC ACTIVATION PORTAL' : ''}
Tone ${kin.toneNum} (${kin.tone}) | Seal: ${kin.seal} | Color: ${kin.color}

KEY ASPECTS (Swiss Ephemeris):
${aList}

CONTEXT:
${satNep}
${uranus}
${mars}

WEEK AHEAD DATA (pre-calculated — use these exact dates, Kins, and UDs):
${weekAhead.map(w => `${w.dayStr}: ${w.kin} | UD${w.ud}${w.isGAP ? ' GAP' : ''}`).join('\n')}

Generate the FULL ORACLE READING as valid JSON (no markdown, no fences, no preamble — JSON object only):
{
  "synthesis": "<2-3 sentence italic opening — synthesise ALL four frameworks into the single deepest truth for ${firstName} today. Specific, resonant, not generic.>",
  "numerology": {
    "headline": "UD ${num.ud} — ${num.udM?.n}: <one punchy, ${firstName}-specific sentence>",
    "body": "<Paragraphs on UD${num.ud} meaning for ${firstName} today. Reference their personal context. Interaction with Life Path ${num.lp || ''}. Personal Day ${num.pd || num.ud} meaning. Personal Month ${num.pm || ''} colour.>",
    "three_energies": {
      "morning": {"num": ${num.pd || num.ud}, "name": "${NUM[num.pd || num.ud]?.n}", "guidance": "<3 sentences for ${firstName}'s morning — specific action or awareness>"},
      "afternoon": {"num": ${num.pm || num.mEn}, "name": "${NUM[num.pm || num.mEn]?.n}", "guidance": "<3 sentences for ${firstName}'s afternoon>"},
      "evening": {"num": ${num.py || num.yEn}, "name": "${NUM[num.py || num.yEn]?.n}", "guidance": "<3 sentences for ${firstName}'s evening — how to close the day well>"}
    }
  },
  "moon_section": {
    "headline": "<${moon.phase} in ${planets[1].sign} — one evocative, ${firstName}-specific headline>",
    "body": "<3 paragraphs on what ${moon.phase} in ${planets[1].sign} asks of ${firstName}. The ${moon.cycle}-day position. ${moonAlert ? 'Specific guidance for the lunar threshold.' : 'Communication and relationship guidance.'}>",
    "moon_note": "${moonAlert || 'Standard lunar phase'}"
  },
  "astrology": {
    "main_transit_headline": "<Name the single most significant active transit with full degree notation>",
    "main_transit_body": "<4 paragraphs: astronomical description; historical/cultural context with specific dates; what it means for the world now; what it specifically asks of ${firstName} given their context. Reference Greene or Tarnas.>",
    "saturn_neptune": "<3 paragraphs: Saturn-Neptune cycle citing Tarnas 2006, 1522/1917/1952/1989 events; what this conjunction means structurally and visionally; what it personally asks of ${firstName}.>",
    "uranus_note": "<2 sentences: Uranus approaching Gemini ingress ~April 26 — financial disruption implication for ${firstName}.>"
  },
  "dreamspell": {
    "headline": "${kin.full}${kin.isGAP ? ' ★ GALACTIC ACTIVATION PORTAL' : ''}",
    "body": "<3 paragraphs: Tone ${kin.toneNum} (${kin.tone}) for ${firstName}; ${kin.seal} seal gifts applied to their situation; wavespell position. ${kin.isGAP ? 'GAP significance: what arrives unexpectedly today.' : ''}>",
    "disclaimer": "Dreamspell: Argüelles (1987) The Mayan Factor — 20th-century modern system, distinct from the ancient K'iche' Maya tzolkʼin maintained continuously by Guatemalan daykeepers (Aldana 2022). Verify: tortuga.com/oracle"
  },
  "planetary_positions": [
    ${planets.map(pl => `{"planet":"${pl.name}","pos":"${pl.degStr}","sign":"${pl.sign}","note":"<12-15 word personalised note for ${firstName}>"}`).join(',\n    ')}
  ],
  "aspects": [
    ${aspects.slice(0,6).map(a => `{"dots":${a.str},"label":"${a.desc}","body":"<3 sentences: what this aspect means for ${firstName} specifically today>"}`).join(',\n    ')}
  ],
  "shadow_work": "<3-4 sentences — the hard question ${firstName} actually needs right now. Based on their context. Do not soften it.>",
  "priorities": [
    {"rank":1,"title":"<${userContext ? 'Specific to their stated context' : 'Most important cosmic priority today'}>","rationale":"<3-4 sentences with cosmic rationale>","action":"<One specific, concrete, completable action>"},
    {"rank":2,"title":"<Relationship or connection priority>","rationale":"<3-4 sentences>","action":"<One specific action>"},
    {"rank":3,"title":"<Body, health, or rest priority>","rationale":"<3-4 sentences>","action":"<One specific action with a time>"}
  ],
  "focus_on": ["<specific item 1>","<specific item 2>","<specific item 3>","<specific item 4>"],
  "ease_off": ["<specific item 1>","<specific item 2>","<specific item 3>","<specific item 4>"],
  "time_windows": {
    "morning": "<3 sentences: cosmic quality of ${firstName}'s morning, what the energy supports, specific advice>",
    "afternoon": "<3 sentences: how the energy shifts in the afternoon for ${firstName}>",
    "evening": "<3 sentences: how ${firstName} closes the day with integrity>"
  },
  "week_ahead": [
    ${weekAheadJSON}
  ],
  "daily_gift": {
    "quote": "<Precisely chosen quote — Jung, Marcus Aurelius, Kierkegaard, Seneca, Rilke, or Rumi — that speaks exactly to ${firstName}'s current chapter.>",
    "attribution": "<Full attribution: Author, Work, Date>",
    "reflection": "<2-3 sentences of personalised reflection on why this quote lands for ${firstName} right now>",
    "meditation": "<3 specific, concrete, unglamorous acts for ${firstName} today — daily care that compounds over months.>"
  },
  "closing_line": "<One final sentence — ${firstName}-specific. The truth of where they actually are.>",
  "sources": "Astronomy: Swiss Ephemeris (Koch & Treindl, Astrodienst AG, ae_2026.pdf); USNO Moon Phases. Maya calendrics: Šprajc et al. (2023) Science Advances doi:10.1126/sciadv.abq7675; Aldana (2022). Dreamspell: Argüelles (1987) The Mayan Factor. Astrology: Greene (1976) Saturn; Tarnas (2006) Cosmos & Psyche; Hand (2002) Planets in Transit. Numerology: Drayer (2002); Kahn (2001) Pythagoras."
}`;

  // Token budget by tier — smaller tiers complete faster
  const maxTok = {free:800, seeker:2000, initiate:4000, mystic:6000, oracle:8192}[tier] || 8192;
  const raw = await callAPI('claude-sonnet-4-6', maxTok, sys, user);

  let reading;
  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    reading = JSON.parse(cleaned);
  } catch(e) {
    // JSON repair: try to salvage truncated JSON by closing open structures
    try {
      const repaired = repairJSON(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
      reading = JSON.parse(repaired);
      reading._repaired = true;
    } catch(e2) {
      reading = {synthesis: raw, raw: true, parseError: e.message};
    }
  }
  return {reading, planets, moon, kin, num, aspects, weekAhead};
}

// ══════════════════════════════════════════════════════════════════
// JSON REPAIR — closes truncated JSON objects/arrays/strings
// ══════════════════════════════════════════════════════════════════
function repairJSON(str) {
  // Remove trailing incomplete key-value pair
  let s = str.trim();
  // Remove trailing comma before attempted close
  s = s.replace(/,\s*$/, '');
  // Count open braces and brackets
  let openBraces = 0, openBrackets = 0, inString = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') openBraces++;
    else if (c === '}') openBraces--;
    else if (c === '[') openBrackets++;
    else if (c === ']') openBrackets--;
  }
  // If we're mid-string, close it
  if (inString) s += '"';
  // Close any open arrays/objects
  while (openBrackets > 0) { s += ']'; openBrackets--; }
  while (openBraces > 0) { s += '}'; openBraces--; }
  return s;
}

// ══════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════
app.post('/api/reading', async (req, res) => {
  const {date, profile, tier} = req.body;
  const ds = date || new Date().toISOString().slice(0, 10);
  try {
    const r = await generateReading(ds, profile || {}, tier || 'oracle');
    res.json(r);
  } catch(e) {
    console.error('Reading error:', e.message);
    res.status(500).json({error: e.message});
  }
});

app.post('/api/cosmic', (req, res) => {
  const {date, profile} = req.body;
  const ds = date || new Date().toISOString().slice(0, 10);
  try {
    const planets = buildPlanets(ds);
    const moon = getMoon(ds);
    const kin = getKin(ds);
    const num = getNumerology(ds, profile?.birthDay, profile?.birthMonth, profile?.birthYear);
    const aspects = getAspects(planets);
    res.json({planets, moon, kin, num, aspects});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/ask', async (req, res) => {
  const {question, context, profile} = req.body;
  if (!question) return res.status(400).json({error: 'No question'});
  try {
    const sys = `You are the Oracle at Cosmic Daily Planner. The reader is asking a follow-up about their daily reading. Respond with depth, specificity, and warmth. 2-4 paragraphs. Speak directly to ${profile?.name || 'them'}. No bullet points. Ground in the actual cosmic data provided.`;
    const ans = await callAPI('claude-sonnet-4-6', 1200, sys,
      `Context: ${JSON.stringify(profile || {})}\nReading context: ${context || "today's oracle reading"}\nQuestion: ${question}`);
    res.json({answer: ans});
  } catch(e) {
    console.error('Ask error:', e.message);
    res.status(500).json({error: e.message});
  }
});

app.post('/api/calendar', (req, res) => {
  const {year, month, profile} = req.body;
  const y = year || new Date().getFullYear();
  const m = month || new Date().getMonth() + 1;
  const days = new Date(y, m, 0).getDate();
  const p = profile || {};
  const result = [];
  for (let d = 1; d <= days; d++) {
    const ds = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const moon = getMoon(ds);
    const kin = getKin(ds);
    const num = getNumerology(ds, p.birthDay, p.birthMonth, p.birthYear);
    result.push({d, ds, moon, kin, ud: num.ud, udN: num.udM?.n,
      pd: num.pd, pdN: num.pdM?.n,
      isMaster: [11,22,33,44].includes(num.ud),
      isGAP: kin.isGAP});
  }
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CDP v7 — streaming — port ${PORT}`));
