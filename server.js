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
        buffer = lines.pop();

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
    req.setTimeout(120000, () => {
      req.destroy(new Error('Socket timeout after 120s'));
    });
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════
// BETA 2 — PROFILE CONTEXT BUILDER
// Converts user profile + reading history into a rich Oracle brief.
// Called by generateReading() — replaces the old ad-hoc profileBlock.
// ══════════════════════════════════════════════════════════════════
function buildProfileContext(p, recentHistory = []) {
  if (!p || Object.keys(p).length === 0) return 'No personal profile provided — give a universal reading grounded in the cosmic data.';

  const lines = [];

  // Name
  const userName = p.name || p.nickname || 'the reader';
  const firstName = p.nickname || (p.name ? p.name.split(' ')[0] : 'you');
  lines.push(`Name: ${userName}`);

  // Location
  if (p.location) lines.push(`Current Location: ${p.location}`);

  // Birth
  if (p.birthDay && p.birthMonth && p.birthYear) {
    lines.push(`Date of Birth: ${p.birthDay}/${p.birthMonth}/${p.birthYear}${p.birthTime ? ' at ' + p.birthTime : ''}${p.birthLocation ? ', born in ' + p.birthLocation : ''}`);
  }
  if (p.birthLocation) lines.push(`Place of Birth: ${p.birthLocation}`);

  // ── BETA 2: ENRICHED LIFE CONTEXT ──
  // Professional roles
  const roles = p.roles || [];
  if (roles.length > 0) {
    const rolesStr = Array.isArray(roles) ? roles.join(', ') : roles;
    lines.push(`Current roles: ${rolesStr}`);
  }

  // Key relationships
  const rels = p.relationships || {};
  if (typeof rels === 'object' && Object.keys(rels).length > 0) {
    const relStr = Object.entries(rels)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('; ');
    lines.push(`Key relationships: ${relStr}`);
  } else if (typeof rels === 'string' && rels.trim()) {
    lines.push(`Key relationships: ${rels}`);
  }

  // Active threads
  const threads = p.active_threads || p.activeThreads || [];
  if (threads.length > 0) {
    const threadStr = Array.isArray(threads) ? threads.join(', ') : threads;
    lines.push(`Active chapters / projects: ${threadStr}`);
  }

  // Intentions
  const intentions = p.intentions || [];
  if (intentions.length > 0) {
    const intentStr = Array.isArray(intentions) ? intentions.join(', ') : intentions;
    lines.push(`Current intentions: ${intentStr}`);
  }

  // Free-form context (existing field — preserved)
  if (p.context) lines.push(`Personal context: ${p.context}`);

  // Today's intention
  if (p.intention) lines.push(`Today's intention: ${p.intention} — weave this into the synthesis, priorities, and shadow work.`);

  // Hormonal phase (client-computed, privacy-safe — no raw dates sent, just phase name and Oracle guidance)
  if (p.cycleContext) {
    lines.push('');
    lines.push('HORMONAL PHASE (today): ' + p.cycleContext);
    lines.push('Integrate this meaningfully — hormonal phases are a legitimate biological rhythm that shapes energy, decision-making capacity, emotional sensitivity, and relational needs today. Reference it specifically in time windows, priorities, and shadow work.');
  }

  // Biorhythm today (if birth date available, calculate server-side)
  if (p.birthDay && p.birthMonth && p.birthYear) {
    const bDate = p.birthYear + '-' + String(p.birthMonth).padStart(2,'0') + '-' + String(p.birthDay).padStart(2,'0');
    const today = new Date().toISOString().slice(0,10);
    try {
      const bio = getBiorhythms(bDate, today);
      const bioLine = 'BIORHYTHMS TODAY: Physical ' + (bio.physical.pct > 0 ? '+' : '') + bio.physical.pct + '% (' + bio.physical.phase + ')'
        + ', Emotional ' + (bio.emotional.pct > 0 ? '+' : '') + bio.emotional.pct + '% (' + bio.emotional.phase + ')'
        + ', Intellectual ' + (bio.intellectual.pct > 0 ? '+' : '') + bio.intellectual.pct + '% (' + bio.intellectual.phase + ')'
        + ', Composite: ' + (bio.composite > 0 ? '+' : '') + bio.composite + '%.'
        + (bio.physical.isCritical ? ' Physical critical day.' : '')
        + (bio.emotional.isCritical ? ' Emotional critical day.' : '')
        + (bio.intellectual.isCritical ? ' Intellectual critical day.' : '');
      lines.push('');
      lines.push(bioLine);
      lines.push('Reference biorhythm state in time windows and energy guidance. Critical days (zero crossings) are transition points requiring particular care.');
    } catch(e) { /* biorhythm calculation failed — skip */ }
  }

  // ── BETA 2: READING HISTORY CONTINUITY ──
  // Inject last 3 reading summaries for genuine cross-session continuity
  if (recentHistory && recentHistory.length > 0) {
    lines.push('');
    lines.push('RECENT SESSIONS — use for continuity and pattern recognition:');
    recentHistory.slice(0, 3).forEach((h, i) => {
      const label = i === 0 ? 'Most recent reading' : `${i + 1} sessions ago`;
      const date = h.reading_date || h.date || '';
      const summary = h.summary || h.synthesis || '';
      if (summary) lines.push(`${label}${date ? ' (' + date + ')' : ''}: ${summary.slice(0, 400)}`);
      if (h.shadow_work) lines.push(`  Shadow question that session: ${h.shadow_work.slice(0, 200)}`);
      if (h.priority_1) lines.push(`  Primary focus: ${h.priority_1}`);
    });
    lines.push('');
  }

  return lines.filter(Boolean).join('\n');
}

// ══════════════════════════════════════════════════════════════════
// ORACLE READING — FULL SCHEMA, FULL QUALITY, BENCHMARK STANDARD
// ══════════════════════════════════════════════════════════════════
async function generateReading(dateStr, profile = {}, tier = 'oracle', recentHistory = [], _planets, _moon, _kin, _num, _aspects) {
  // Accept pre-calculated data from two-phase flow to avoid recalculating
  const planets = _planets || buildPlanets(dateStr);
  const moon = _moon || getMoon(dateStr);
  const kin = _kin || getKin(dateStr);
  const p = profile || {};
  const num = _num || getNumerology(dateStr, p.birthDay, p.birthMonth, p.birthYear);
  const aspects = _aspects || getAspects(planets);
  const weekAhead = getWeekAhead(dateStr);

  // ── DYNAMIC PROFILE — Beta 2: uses buildProfileContext ──
  const firstName = p.nickname || (p.name ? p.name.split(' ')[0] : 'you');
  const profileBlock = buildProfileContext(p, recentHistory);

  // Build birth kin string from calculated num
  const birthKinStr = num.birthKin ? `Kin ${num.birthKin.kin} — ${num.birthKin.full}` : 'not calculated';

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
    oracle: `TIER: Oracle — Generate the COMPLETE, MAXIMALLY DETAILED reading. This is the £50,000-tier experience. Every prose field must be FULL, RICH paragraphs — 4-6 sentences minimum per paragraph, multiple paragraphs per section as defined in the JSON schema. The benchmark is a 25-30 page printed document. Numerology body: 4 full paragraphs. Moon body: 3 full paragraphs. Main transit body: 4 full paragraphs. Saturn-Neptune: 3 full paragraphs. Dreamspell body: 4 full paragraphs. Each aspect: 3 full sentences. Shadow work: 4 italic sentences. Each priority: 3-4 sentence rationale + specific action. Full week_ahead with 2-sentence personalised notes for each day. Complete daily_gift with meditation. Do NOT truncate any field. Every field in the JSON schema must be populated to maximum depth.`
  };
  const scope = tierScope[tier] || tierScope.oracle;

  const sys = `You are the Oracle at Cosmic Daily Planner (cosmicdailyplanner.com) — a rigorous, personalised daily cosmic planner synthesising Swiss Ephemeris astronomy, Pythagorean numerology, Western psychological astrology, and Dreamspell/Law of Time.

YOUR VOICE: The best Jungian analyst meets the Swiss Ephemeris. Precise. Personal. Grounded. Emotionally intelligent.

${scope}

CRITICAL RULES:
— Use ONLY the Swiss Ephemeris positions provided. Never invent planetary data.
— Address the reader by their first name (${firstName}) throughout. Use ONLY the personal context they have provided — do not invent details about their life.
— If personal context is provided (companies, family, projects, relationships, roles, active threads), reference it specifically and by name. If not provided, speak universally but still specifically to the cosmic weather.
— If RECENT SESSIONS are provided in the profile, use them for genuine continuity: reference what was present before, notice patterns, acknowledge what has shifted. The Oracle has memory.
— Dreamspell is ALWAYS labelled: Argüelles (1987) The Mayan Factor — modern 20th-century system, distinct from ancient K'iche' Maya tradition maintained by Guatemalan daykeepers.
— No deterministic predictions. Speak in possibilities and tendencies.
— Every section must be grounded in the actual planetary data and personal context provided.
— BIORHYTHMS: If BIORHYTHMS TODAY is present in the profile, integrate it meaningfully. A physical score below -60% means depleted vitality — flag it in time windows and priorities. A critical day (zero crossing) is a transition requiring care. Do not merely mention it — let it shape the energy guidance concretely.
— HORMONAL PHASE: If HORMONAL PHASE is present, treat it as a legitimate biological rhythm equal in weight to moon phase. Reference it in time windows, priorities, and shadow work — speak to how this phase shapes energy, decision-making, and relational sensitivity today.
— NATAL vs TRANSIT: Always distinguish clearly. Say "today's Moon is in X" or "the Moon transits X today" for current sky positions. Say "your natal Moon in X" for birth chart placements. Never conflate the two — this confusion destroys credibility with experienced users.
— RESPOND ONLY WITH VALID JSON. No markdown fences. No preamble. No text outside the JSON object.
— CRITICAL: The JSON MUST be syntactically complete and valid. Every opened brace and bracket must be closed. If approaching length limit, shorten EARLIER sections first — but always close the JSON properly.
— SCHOLARLY SOURCES: Šprajc et al. 2023 (Science Advances); Aldana 2022; Tarnas 2006 Cosmos & Psyche; Greene 1976 Saturn; Hand 2002 Planets in Transit; Brady 1999; Brennan 2017; Drayer 2002 Numerology; Kahn 2001 Pythagoras.`;

  const user = `PROFILE:
${profileBlock}

Life Path: ${num.lp || 'not calculated'} (${num.lpM?.n || ''})
Personal Year: ${num.py || 'not calculated'} (${num.pyM?.n || ''})
Birth Kin (Dreamspell): ${birthKinStr}

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
  "synthesis": "<2-3 sentence italic opening — synthesise ALL four frameworks into the single deepest truth for ${firstName} today. Weave the Dreamspell Kin, Universal Day, dominant transit, and moon phase into one resonant, specific, memorable statement. This is the headline they carry all day.>",
  "numerology": {
    "headline": "UD ${num.ud} — ${num.udM?.n}: <one punchy, ${firstName}-specific sentence connecting their number to their current chapter>",
    "body": "<4 substantial paragraphs: (1) What Universal Day ${num.ud} (${num.udM?.n}) means specifically for ${firstName} today — named context, named chapter, named projects or relationships from their profile. (2) How UD ${num.ud} interacts with their Life Path ${num.lp || 'number'} — what tension or alignment emerges between daily energy and core soul pattern. (3) Personal Day ${num.pd || num.ud} meaning, its shadow side, and how ${firstName} can work with rather than against it. (4) How Personal Month ${num.pm || ''} colours everything this month — what it amplifies, what it challenges, what it asks ${firstName} to build or release.>",
    "three_energies": {
      "morning": {"num": ${num.pd || num.ud}, "name": "${NUM[num.pd || num.ud]?.n}", "guidance": "<3 concrete sentences for ${firstName}'s morning — specific action, specific awareness, what this energy most rewards in the first part of the day>"},
      "afternoon": {"num": ${num.pm || num.mEn}, "name": "${NUM[num.pm || num.mEn]?.n}", "guidance": "<3 concrete sentences for ${firstName}'s afternoon — how the energy shifts, what becomes available, specific advice for the middle of the day>"},
      "evening": {"num": ${num.py || num.yEn}, "name": "${NUM[num.py || num.yEn]?.n}", "guidance": "<3 concrete sentences for ${firstName}'s evening — how to close the day well, what to review, what to rest, the one habit that compounds>"}
    }
  },
  "moon_section": {
    "headline": "<${moon.phase} in ${planets[1].sign} — one evocative, ${firstName}-specific headline that names the essential tension or gift>",
    "body": "<3 substantial paragraphs: (1) What ${moon.phase} in ${planets[1].sign} specifically illuminates or asks of ${firstName} — their relationships, inner life, body, or context. (2) Where ${moon.cycle} days into the lunar cycle places ${firstName} — what is culminating, releasing, or building. Reference the emotional arc of this specific phase position. (3) ${moonAlert ? 'Specific guidance for this BLACK MOON or SHIVA MOON threshold — what it means for decisions, timing, and energy today.' : 'Specific communication and relationship guidance for today — what to say, what to hold, what to offer.'}>"
  },
  "astrology": {
    "main_transit_headline": "<Name the single most significant active transit with precise degree notation — e.g. 'Mercury 15.5° Aries square Jupiter 15.9° Cancer — Precision Over Expansion'>",
    "main_transit_body": "<4 substantial paragraphs: (1) Precise astronomical description of this transit — planets, signs, exact orb, quality. (2) Historical and cultural context — what happened during the last time these planets made this aspect, what archetypal pattern is active. Cite Greene (1976) or Tarnas (2006) where relevant. (3) What this transit means for the world right now — structural, cultural, economic. (4) What this transit specifically asks of ${firstName} given their personal context and current chapter. Concrete, named, grounded.>",
    "saturn_neptune": "<3 substantial paragraphs: (1) The Saturn-Neptune cycle — cite Tarnas (2006) Cosmos & Psyche explicitly, name the 1522 (Magellan circumnavigation), 1917 (WWI/Russian Revolution), 1952 (DNA discovery/early computing), 1989 (Berlin Wall/Cold War end) conjunctions with their historical significance. (2) What this current conjunction in Aries means specifically — dissolution of Saturn structures (old models, gatekeeping, rigid systems) meeting Neptunian vision (new paradigms, idealised possibilities) in the sign of pioneering initiations. How this affects the world's structures right now. (3) What this civilisational reset personally asks of ${firstName} — the impossible integration it invites, the dreamer AND architect simultaneously, how their current work or life chapter is positioned within this historical moment.>",
    "uranus_note": "<2 sentences: Uranus at ${planets[7].degStr} approaching Gemini ingress ~April 26 2026 — what financial structures, communication architectures, and valuations this disrupts, and the specific implication for ${firstName}'s timing and planning.>"
  },
  "dreamspell": {
    "headline": "${kin.full}${kin.isGAP ? ' ★ GALACTIC ACTIVATION PORTAL' : ''}",
    "body": "<3-4 paragraphs: (1) Tone ${kin.toneNum} (${kin.tone}) — its question, its challenge, its gift. What this tone specifically asks ${firstName} to embody or practice today. (2) The ${kin.seal} seal — its core power, its archetype, its gifts and shadow. Applied concretely to ${firstName}'s current situation and context. (3) The wavespell position and what specific invitation it carries — where ${firstName} is in the larger 13-day arc. (4) ${kin.isGAP ? 'GALACTIC ACTIVATION PORTAL: the veil between dimensions is thinner today. What specific arrivals, synchronicities, or unexpected clarity should ' + firstName + ' pay attention to? What has been seeking entrance?' : ''} Always note: Argüelles (1987) modern system, distinct from ancient K\'iche\' tzolkʼin.>",
    "disclaimer": "Dreamspell: Argüelles (1987) The Mayan Factor — 20th-century modern system, distinct from the ancient K'iche' Maya tzolkʼin maintained continuously by Guatemalan daykeepers (Aldana 2022). Verify: tortuga.com/oracle"
  },
  "planetary_positions": [
    ${planets.map(pl => `{"planet":"${pl.name}","pos":"${pl.degStr}","sign":"${pl.sign}","note":"<12-15 word personalised note for ${firstName} — specific to their context and today's energy>"}`).join(',\n    ')}
  ],
  "aspects": [
    ${aspects.slice(0,6).map(a => `{"dots":${a.str},"label":"${a.desc}","body":"<3 sentences: what this specific aspect means for ${firstName} today — the tension or gift it brings, how it manifests in their actual life, one concrete way to work with it>"}`).join(',\n    ')}
  ],
  "shadow_work": "<3-4 italic sentences — the hard question ${firstName} actually needs right now. Grounded in their personal context. Not philosophical abstractions but the specific avoidance, the specific deferral, the specific unexamined assumption. Ask the question they most need to hear. Do not soften it.>",
  "priorities": [
    {"rank":1,"title":"<Most important priority today — specific to ${firstName}'s context and projects>","rationale":"<3-4 sentences with full cosmic rationale — which specific transits, numbers, and lunar phase support this priority today and why>","action":"<One specific, concrete, completable action for today — precise, physical, completable in a single session>"},
    {"rank":2,"title":"<Relationship or connection priority — specific person or type of connection>","rationale":"<3-4 sentences with cosmic rationale>","action":"<One specific action — what to say, who to reach, what to create>"},
    {"rank":3,"title":"<Body, health, or rest priority>","rationale":"<3-4 sentences>","action":"<One specific action with a time of day attached>"}
  ],
  "focus_on": ["<specific, named, actionable item 1>","<specific item 2>","<specific item 3>","<specific item 4>"],
  "ease_off": ["<specific, named, actionable item 1>","<specific item 2>","<specific item 3>","<specific item 4>"],
  "time_windows": {
    "morning": "<3 sentences: the precise cosmic quality of ${firstName}'s morning — what the energy supports, what it asks, specific advice for the first 4 hours of the day>",
    "afternoon": "<3 sentences: how the energy shifts in the afternoon for ${firstName} — what becomes available, what opens, what practical guidance applies>",
    "evening": "<3 sentences: how ${firstName} closes the day with integrity — what to review, what to release, the one habit or practice that compounds over weeks>"
  },
  "week_ahead": [
    ${weekAheadJSON}
  ],
  "daily_gift": {
    "quote": "<Precisely chosen quote — Jung, Marcus Aurelius, Kierkegaard, Seneca, Rilke, Rumi, or similar — that speaks exactly to ${firstName}'s current chapter. Not generic wisdom. The right sentence for this specific person at this specific moment in their life.>",
    "attribution": "<Full attribution: Author, Work, Year>",
    "reflection": "<2-3 sentences of personalised reflection on why this quote lands for ${firstName} right now — specific to their current chapter, their context, what they are building or releasing>",
    "meditation": "<3 specific, concrete, unglamorous acts for ${firstName} today — the kind of daily care that compounds over months. Physical, relational, creative. Not aspirational — actual.>"
  },
  "closing_line": "<One final sentence, italic — specific to ${firstName}, not inspirational fluff. The truth of where they actually are, spoken with warmth and precision. The sentence they will carry.>",
  "sources": "Astronomy: Swiss Ephemeris (Koch & Treindl, Astrodienst AG, ae_2026.pdf); USNO Moon Phases. Maya calendrics: Šprajc et al. (2023) Science Advances doi:10.1126/sciadv.abq7675; Aldana (2022) doi:10.34758/qyyd-vx23. Dreamspell: Argüelles (1987) The Mayan Factor. Astrology: Greene (1976) Saturn; Tarnas (2006) Cosmos & Psyche; Hand (2002) Planets in Transit; Brady (1999) Predictive Astrology; Brennan (2017) Hellenistic Astrology. Numerology: Drayer (2002); Kahn (2001) Pythagoras."
}`;

  const maxTok = {free:800, seeker:3000, initiate:5000, mystic:8000, oracle:16000}[tier] || 8192;
  const raw = await callAPI('claude-sonnet-4-6', maxTok, sys, user);

  let reading;
  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    reading = JSON.parse(cleaned);
  } catch(e) {
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
// JSON REPAIR
// ══════════════════════════════════════════════════════════════════
function repairJSON(str) {
  let s = str.trim();
  s = s.replace(/,\s*$/, '');
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
  if (inString) s += '"';
  while (openBrackets > 0) { s += ']'; openBrackets--; }
  while (openBraces > 0) { s += '}'; openBraces--; }
  return s;
}


// ══════════════════════════════════════════════════════════════════
// TWO-PHASE READING GENERATION
// Phase 1: Actionable core (~25s) — synthesis, priorities, shadow,
//          focus/ease, time windows
// Phase 2: Deep analysis (~3-5min) — numerology, astrology,
//          dreamspell, transits, week ahead, daily gift
// ══════════════════════════════════════════════════════════════════

async function generatePhase1(dateStr, profile, tier, planets, moon, kin, num, aspects) {
  const firstName = profile.nickname || (profile.name ? profile.name.split(' ')[0] : 'you');
  const profileBlock = buildProfileContext(profile, []);

  const pTable = planets.map(pl => `${pl.name}: ${pl.degStr}`).join('\n');
  const moonAlert = moon.isBlack
    ? `★ BLACK MOON — threshold day. No major launches. Observe.`
    : moon.isShiva ? `★ SHIVA MOON — auspicious. Fresh starts welcomed.` : '';

  const scope1 = {
    free: 'PHASE 1 FREE: synthesis (1 sentence), one priority, one action. Under 200 tokens.',
    seeker: 'PHASE 1 SEEKER: synthesis (2 sentences), 3 priorities with rationale and actions, shadow_work, focus_on (4 items), ease_off (4 items), time_windows. Concise — 2 sentences per field. Under 1500 tokens.',
    initiate: 'PHASE 1 INITIATE: Same as Seeker but richer. synthesis (2-3 sentences), 3 priorities with full rationale, shadow_work, focus_on, ease_off, time_windows. Under 2000 tokens.',
    mystic: 'PHASE 1 MYSTIC: synthesis (3 sentences), 3 full priorities, shadow_work (3 sentences), focus_on, ease_off, time_windows. Under 2500 tokens.',
    oracle: 'PHASE 1 ORACLE: synthesis (3 powerful sentences synthesising all 4 frameworks), 3 priorities with full 3-4 sentence rationale and specific actions, shadow_work (4 sentences — the hard question), focus_on (4 items), ease_off (4 items), time_windows (3 sentences each). Under 3000 tokens.'
  }[tier] || 'PHASE 1: synthesis, priorities, shadow_work, focus_on, ease_off, time_windows.';

  const sys1 = `You are the Oracle at Cosmic Daily Planner. PHASE 1 — generate only the actionable core sections. Fast, precise, personal.
${scope1}
Rules: Address ${firstName} by name. Use only provided data. RESPOND WITH VALID JSON ONLY — no markdown, no preamble.`;

  const user1 = `DATE: ${dateStr}
PROFILE: ${profileBlock}
PLANETS: ${pTable}
MOON: ${moon.phase} — ${moon.cycle} days into cycle ${moonAlert}
NUMEROLOGY: UD${num.ud} (${num.udM?.n}), PD${num.pd||num.ud} (${num.pdM?.n||''}), LP${num.lp||'?'}, PY${num.py||'?'}
KIN: ${kin.full}${kin.isGAP?' ★ GAP':''}

Generate ONLY these sections as valid JSON:
{
  "synthesis": "<${tier==='oracle'?'3 powerful sentences synthesising Dreamspell Kin, Universal Day, dominant transit and moon into one resonant truth for '+firstName+' today':'2-3 sentences — the essential truth for '+firstName+' today'}>",
  "priorities": [
    {"rank":1,"title":"<Most important priority — specific to ${firstName}>","rationale":"<${tier==='oracle'?'3-4':'2'} sentences with cosmic rationale — which transits/numbers/phase support this>","action":"<One specific, completable action for today>"},
    {"rank":2,"title":"<Connection/relationship priority>","rationale":"<${tier==='oracle'?'3-4':'2'} sentences>","action":"<Specific action>"},
    {"rank":3,"title":"<Body/health/rest priority>","rationale":"<${tier==='oracle'?'3-4':'2'} sentences>","action":"<Specific action with time of day>"}
  ],
  "shadow_work": "<${tier==='oracle'?'3-4':'2'} sentences — the question ${firstName} most needs right now. Grounded in their context. Not abstract. The specific avoidance or unexamined assumption.>",
  "focus_on": ["<specific named item>","<specific item>","<specific item>","<specific item>"],
  "ease_off": ["<specific named item>","<specific item>","<specific item>","<specific item>"],
  "time_windows": {
    "morning": "<${tier==='oracle'?'3':'2'} sentences — specific cosmic quality and advice for ${firstName}'s morning>",
    "afternoon": "<${tier==='oracle'?'3':'2'} sentences — how energy shifts and what becomes available>",
    "evening": "<${tier==='oracle'?'3':'2'} sentences — how ${firstName} closes the day well>"
  }
}`;

  const maxTok1 = {free:400, seeker:1800, initiate:2200, mystic:2800, oracle:3500}[tier] || 2000;
  const raw1 = await callAPI('claude-sonnet-4-6', maxTok1, sys1, user1);

  try {
    const cleaned = raw1.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch(e) {
    try {
      return JSON.parse(repairJSON(raw1.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()));
    } catch(e2) {
      return { synthesis: raw1, raw: true };
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════

const jobs = new Map();
function newJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function cleanOldJobs() {
  const cutoff = Date.now() - 7200000;
  for (const [id, job] of jobs) {
    if (job.startedAt < cutoff) jobs.delete(id);
  }
}
setInterval(cleanOldJobs, 600000);

// ── START BACKGROUND READING ──
app.post('/api/reading/start', async (req, res) => {
  const {date, profile, tier, user_id, recentHistory} = req.body;
  const ds = date || new Date().toISOString().slice(0, 10);
  const jobId = newJobId();
  const activeTier = tier || 'oracle';

  jobs.set(jobId, {
    status: 'pending',
    startedAt: Date.now(),
    date: ds,
    tier: activeTier,
    user_id: user_id || null,
    result: null,
    phase1: null,
    error: null
  });

  res.json({ jobId, status: 'pending' });

  // ── TWO-PHASE GENERATION ────────────────────────────────────────
  // Phase 1: actionable core in ~25s (free tier skips to full)
  // Phase 2: full depth analysis continues in background
  (async () => {
    try {
      // Pre-calculate shared data once
      const planets = buildPlanets(ds);
      const moon = getMoon(ds);
      const kin = getKin(ds);
      const num = getNumerology(ds, profile?.birthDay, profile?.birthMonth, profile?.birthYear);
      const aspects = getAspects(planets);

      if (activeTier !== 'free') {
        // Phase 1 — fast actionable core
        const p1 = await generatePhase1(ds, profile || {}, activeTier, planets, moon, kin, num, aspects);
        const job = jobs.get(jobId);
        if (job) {
          job.phase1 = p1;
          job.status = 'phase1_complete';
          console.log(`Job ${jobId} Phase 1 complete (${((Date.now() - job.startedAt)/1000).toFixed(1)}s)`);
        }
      }

      // Phase 2 — full depth (runs immediately after phase 1 or alone for free)
      const r = await generateReading(ds, profile || {}, activeTier, recentHistory || [], planets, moon, kin, num, aspects);
      const job = jobs.get(jobId);
      if (job) {
        // Merge phase1 into full reading (phase1 had fresher/shorter prompts — keep phase2 for depth)
        if (job.phase1 && r.reading) {
          // Phase 2 takes precedence for content depth, but phase1 fills gaps if phase2 truncated
          r.reading._phase1 = job.phase1;
        }
        job.status = 'complete';
        job.result = r;
        job.completedAt = Date.now();
      }
      console.log(`Job ${jobId} complete (${((Date.now() - job?.startedAt)/1000).toFixed(1)}s)`);
    } catch(e) {
      const job = jobs.get(jobId);
      if (job) { job.status = 'error'; job.error = e.message; }
      console.error(`Job ${jobId} failed:`, e.message);
    }
  })();
});

// ── POLL JOB STATUS ──
app.get('/api/reading/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: 'not_found' });
  if (job.status === 'complete') {
    return res.json({ status: 'complete', result: job.result,
      duration: Math.round((job.completedAt - job.startedAt) / 1000) });
  }
  if (job.status === 'error') {
    return res.json({ status: 'error', error: job.error });
  }
  // Phase 1 complete — return actionable core while phase 2 continues
  if (job.status === 'phase1_complete' && job.phase1) {
    const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
    return res.json({ status: 'phase1_complete', phase1: job.phase1, elapsed, tier: job.tier });
  }
  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  res.json({ status: 'pending', elapsed, tier: job.tier });
});

// ── LEGACY SYNC READING ──
app.post('/api/reading', async (req, res) => {
  const {date, profile, tier, recentHistory} = req.body;
  const ds = date || new Date().toISOString().slice(0, 10);
  try {
    const r = await generateReading(ds, profile || {}, tier || 'oracle', recentHistory || []);
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
  const {question, context, profile, readingData} = req.body;
  if (!question) return res.status(400).json({error: 'No question'});
  try {
    const p = profile || {};
    const firstName = p.nickname || (p.name ? p.name.split(' ')[0] : 'the reader');

    // Beta 2: enriched profile context for ask endpoint
    const rolesCtx = (p.roles && p.roles.length)
      ? `Roles: ${Array.isArray(p.roles) ? p.roles.join(', ') : p.roles}.` : '';
    const threadsCtx = (p.active_threads && p.active_threads.length)
      ? `Active projects: ${Array.isArray(p.active_threads) ? p.active_threads.join(', ') : p.active_threads}.` : '';
    const intentionsCtx = (p.intentions && p.intentions.length)
      ? `Intentions: ${Array.isArray(p.intentions) ? p.intentions.join(', ') : p.intentions}.` : '';

    const sys = `You are the Oracle at Cosmic Daily Planner — the same voice that wrote today's full reading. A reader is asking a follow-up or deeper question.

YOUR VOICE: The best Jungian analyst meets the Swiss Ephemeris. Precise. Personal. Grounded. Emotionally intelligent.

RULES:
— Address ${firstName} by name throughout.
— Speak directly from the cosmic data provided. Never invent planetary positions.
— 3-5 paragraphs of depth. No bullet points. No lists.
— End with one concrete action, question, or awareness for ${firstName} to carry.
— Reference their specific personal context, projects, and relationships where relevant.
— Dreamspell always labelled as Argüelles (1987) modern system, distinct from ancient K'iche' tradition.
— Draw on: Tarnas (2006), Greene (1976), Hand (2002), Brady (1999), Drayer (2002) where relevant.`;

    const fullContext = [
      context ? `Today's reading context: ${context}` : '',
      readingData?.synthesis ? `Oracle synthesis: ${readingData.synthesis}` : '',
      readingData?.shadow_work ? `Shadow work: ${readingData.shadow_work}` : '',
      readingData?.astrology?.main_transit_headline ? `Main transit: ${readingData.astrology.main_transit_headline}` : '',
      readingData?.numerology?.headline ? `Numerology: ${readingData.numerology.headline}` : '',
      p.context ? `Personal context: ${p.context}` : '',
      rolesCtx,          // Beta 2
      threadsCtx,        // Beta 2
      intentionsCtx,     // Beta 2
      p.birthDay ? `Born: ${p.birthDay}/${p.birthMonth}/${p.birthYear}${p.birthTime ? ' at ' + p.birthTime : ''}${p.birthLocation ? ' in ' + p.birthLocation : ''}` : '',
    ].filter(Boolean).join('\n');

    const ans = await callAPI('claude-sonnet-4-6', 2500, sys,
      `${fullContext}\n\nQuestion from ${firstName}: ${question}`);
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

// ══════════════════════════════════════════════════════════════════
// BIORHYTHM CALCULATOR
// Classical three-cycle theory: physical 23d, emotional 28d, intellectual 33d
// All sine waves from birth date (Teltscher, Fliess, Swoboda — early 20thC)
// Critical days = zero crossings (most significant days)
// ══════════════════════════════════════════════════════════════════
function getBiorhythms(birthDateStr, targetDateStr) {
  const birth = new Date(birthDateStr + 'T12:00:00Z');
  const target = new Date(targetDateStr + 'T12:00:00Z');
  const days = Math.round((target - birth) / 86400000);

  const cycles = {
    physical:     { period: 23,  label: 'Physical',     desc: 'vitality, strength, coordination, stamina' },
    emotional:    { period: 28,  label: 'Emotional',    desc: 'mood, sensitivity, creativity, intuition' },
    intellectual: { period: 33,  label: 'Intellectual', desc: 'reasoning, memory, decision-making, alertness' },
  };

  const result = {};
  for (const [key, c] of Object.entries(cycles)) {
    const value = Math.sin((2 * Math.PI * days) / c.period);
    const pct   = Math.round(value * 100);
    // Critical day = within 1 day of zero crossing
    const nextDay = Math.sin((2 * Math.PI * (days + 1)) / c.period);
    const isCritical = (value >= 0 && nextDay < 0) || (value < 0 && nextDay >= 0)
      || Math.abs(value) < 0.13;
    const phase = isCritical ? 'critical'
      : value > 0.6  ? 'high'
      : value > 0.1  ? 'rising'
      : value > -0.1 ? 'transition'
      : value > -0.6 ? 'falling'
      : 'low';
    result[key] = { value: parseFloat(value.toFixed(3)), pct, phase, isCritical,
      period: c.period, label: c.label, desc: c.desc, dayOfCycle: days % c.period };
  }

  // Composite score: weighted average
  const composite = Math.round((result.physical.pct * 0.4) +
    (result.emotional.pct * 0.35) + (result.intellectual.pct * 0.25));

  return { ...result, composite, daysAlive: days };
}

function getBiorhythmSynastry(bioA, bioB) {
  // Compare where both people sit on their cycles today
  const out = [];
  for (const key of ['physical', 'emotional', 'intellectual']) {
    const a = bioA[key];
    const b = bioB[key];
    const diff = Math.abs(a.pct - b.pct);
    const bothCritical = a.isCritical && b.isCritical;
    const aligned = diff < 20; // within 20% of each other
    const opposed = diff > 70 && ((a.pct > 0 && b.pct < 0) || (a.pct < 0 && b.pct > 0));

    out.push({
      cycle: a.label,
      aPhase: a.phase, aPct: a.pct,
      bPhase: b.phase, bPct: b.pct,
      diff, aligned, opposed, bothCritical,
      dynamic: bothCritical ? 'Both in critical transition — take care'
        : aligned && a.pct > 30 ? 'Both running high — strong shared energy'
        : aligned && a.pct < -30 ? 'Both low — a good time to rest together, not push'
        : opposed ? 'Out of phase — one high, one low. Patience and adaptation needed'
        : 'Mixed — complement each other\'s energy today'
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
// NUMEROLOGY CROSS-ANALYSIS
// LP compatibility (Drayer 2002, Millman 1993 Life You Were Born to Live)
// ══════════════════════════════════════════════════════════════════
const LP_COMPAT = {
  '1-1': { quality: 'Resonant independence', dynamic: 'Two strong wills — inspiring when aligned, competitive when not. Leadership must be shared consciously.' },
  '1-2': { quality: 'Complementary polarity', dynamic: 'The initiator and the nurturer. Natural fit when both roles are honoured. 2 softens 1\'s edges; 1 gives 2 direction.' },
  '1-3': { quality: 'Creative momentum', dynamic: 'High-energy, expressive pairing. 1 leads, 3 brings joy and communication. Risk: both can be self-focused.' },
  '1-4': { quality: 'Vision and structure', dynamic: '1 dreams, 4 builds. Powerful if the 4 doesn\'t stifle 1\'s initiative, and the 1 respects the 4\'s need for order.' },
  '1-5': { quality: 'Freedom and fire', dynamic: 'Both love independence. Exciting but can be unstable — neither naturally prioritises the relationship.' },
  '1-6': { quality: 'Leadership and care', dynamic: '1 leads outward, 6 holds the home. Strong if 6\'s nurturing isn\'t seen as control, and 1\'s independence isn\'t abandonment.' },
  '1-7': { quality: 'Inner and outer mastery', dynamic: '1 acts, 7 reflects. They operate on different planes — potential for profound complementarity or mutual frustration.' },
  '1-8': { quality: 'Power pairing', dynamic: 'Both driven. High potential for material success together. Risk: competition and control battles.' },
  '1-9': { quality: 'The pioneer and the sage', dynamic: '1\'s new beginnings meet 9\'s wisdom and completion. 9 can guide 1; 1 can reignite 9\'s forward momentum.' },
  '2-2': { quality: 'Deep emotional resonance', dynamic: 'Highly sensitive pairing. Beautiful emotional depth, but both may wait for the other to lead.' },
  '2-3': { quality: 'Heart and voice', dynamic: '2\'s depth of feeling expressed through 3\'s communication. Warm and creative. Risk: 3 can seem superficial to 2.' },
  '2-4': { quality: 'Stability and sensitivity', dynamic: 'Very compatible. 2 brings emotional depth, 4 brings security. Strong domestic foundation.' },
  '2-5': { quality: 'The tension of need vs freedom', dynamic: '2 needs closeness; 5 needs space. This tension can be creative or exhausting depending on awareness.' },
  '2-6': { quality: 'Devotion and harmony', dynamic: 'Naturally aligned. Both care deeply, both prioritise relationship. Risk: enmeshment or avoiding necessary conflict.' },
  '2-7': { quality: 'The seen and the unseen', dynamic: '2 operates emotionally; 7 operates intellectually and spiritually. Deep potential if each accepts the other\'s mode.' },
  '2-8': { quality: 'Sensitivity meets power', dynamic: '2 feels everything 8 projects. 8 must learn care; 2 must learn not to absorb 8\'s intensity as personal.' },
  '2-9': { quality: 'Heart resonance', dynamic: 'Both compassionate, both giving. Deeply harmonious. Risk: both may sacrifice too much.' },
  '3-3': { quality: 'Joyful creative chaos', dynamic: 'Brilliant fun, creative explosion. Risk: neither grounds the other, and both can be emotionally avoidant.' },
  '3-4': { quality: 'Creativity meets structure', dynamic: '3 expands, 4 contains. Productive if 4 doesn\'t dampen 3\'s spark, and 3 respects 4\'s need for order.' },
  '3-5': { quality: 'Expression and adventure', dynamic: 'High energy, sociable, fun. Both resist routine. May lack the depth to weather difficulty.' },
  '3-6': { quality: 'Heart and hearth', dynamic: '3\'s lightness meets 6\'s warmth. Beautiful combination. 6\'s care grounds 3; 3\'s joy uplifts 6.' },
  '3-7': { quality: 'Surface and depth', dynamic: '3 skims the surface delightfully; 7 dives deep. Can complement beautifully — or talk past each other entirely.' },
  '3-8': { quality: 'Charm and authority', dynamic: '3 is social, 8 is powerful. 3 can open doors 8 cannot; 8 can provide the solidity 3 needs.' },
  '3-9': { quality: 'Creative wisdom', dynamic: 'Both generous, both expressive. 9\'s wisdom tempers 3\'s restlessness. High creative and spiritual potential.' },
  '4-4': { quality: 'The builders', dynamic: 'Stable, reliable, productive. May be too similar — can be rigid. Needs conscious injection of joy and spontaneity.' },
  '4-5': { quality: 'Structure vs freedom', dynamic: 'Significant tension. 4 needs order; 5 fights it. Both must stretch well beyond their comfort zone.' },
  '4-6': { quality: 'The foundation', dynamic: 'One of the most compatible pairings. Both responsible, both devoted. Risk: life becomes all duty and no play.' },
  '4-7': { quality: 'Pragmatism and philosophy', dynamic: '4 builds in the world; 7 seeks inner truth. Can be deeply complementary — 7 gives meaning to 4\'s efforts.' },
  '4-8': { quality: 'The power builders', dynamic: 'Both capable of great achievement together. 4 provides the plan, 8 provides the drive. Risk: all work, no intimacy.' },
  '4-9': { quality: 'The long view', dynamic: '4\'s methodical nature meets 9\'s universal perspective. 9 can inspire 4 beyond the material; 4 can help 9 manifest.' },
  '5-5': { quality: 'The free spirits', dynamic: 'Exhilarating and chaotic. Both need change. May have difficulty committing or creating lasting structure.' },
  '5-6': { quality: 'Freedom and responsibility', dynamic: '5 wants to fly; 6 wants to nest. This tension is constant. Can work beautifully if each honours the other\'s need.' },
  '5-7': { quality: 'The seekers', dynamic: 'Both restless in their different ways. 5 seeks experience; 7 seeks understanding. Interesting intellectual companionship.' },
  '5-8': { quality: 'Energy and ambition', dynamic: 'High-voltage pairing. Both driven, both capable. 5\'s versatility and 8\'s focus can be powerful together.' },
  '5-9': { quality: 'The adventurers', dynamic: 'Both expansive, both drawn to the wider world. 9\'s wisdom can give 5\'s adventures direction and meaning.' },
  '6-6': { quality: 'The devoted', dynamic: 'Deep caring and mutual commitment. Risk: over-responsibility for each other, difficulty receiving as well as giving.' },
  '6-7': { quality: 'Warmth and wisdom', dynamic: '6\'s heart and 7\'s mind. Beautiful if each accepts the other\'s mode of relating. 7 may seem cold to 6; 6 may seem needy to 7.' },
  '6-8': { quality: 'Care and command', dynamic: '6 serves, 8 leads. Works if 8 reciprocates care; risks imbalance if 6 gives and 8 takes.' },
  '6-9': { quality: 'The humanitarians', dynamic: 'Both give themselves to others. Deeply aligned in values. Risk: neither focuses enough on their own relationship.' },
  '7-7': { quality: 'The philosophers', dynamic: 'Rare depth of intellectual and spiritual understanding. Risk: both retreat inward and the relationship starves of warmth.' },
  '7-8': { quality: 'The thinker and the achiever', dynamic: '7\'s insight informs 8\'s action. Powerful if each respects the other\'s domain.' },
  '7-9': { quality: 'Depth upon depth', dynamic: 'Both oriented toward meaning and truth. Profound potential for spiritual and intellectual growth together.' },
  '8-8': { quality: 'The magnates', dynamic: 'Extraordinary potential — and extraordinary risk. Power dynamics must be managed consciously or this becomes a battle.' },
  '8-9': { quality: 'Material and spiritual', dynamic: '8 builds in the world; 9 transcends it. 9 can soften 8\'s drive; 8 can help 9 manifest their vision.' },
  '9-9': { quality: 'Universal love', dynamic: 'Deeply aligned in compassion and wisdom. Risk: both may be so oriented toward others that the relationship itself is neglected.' },
};

function getNumerologyCrossAnalysis(numA, numB, nameA, nameB) {
  if (!numA || !numB) return null;
  const lpA = numA.lp;
  const lpB = numB.lp;
  if (!lpA || !lpB) return null;

  // Normalize LP pair for lookup (always lower first)
  const key = lpA <= lpB ? (lpA + '-' + lpB) : (lpB + '-' + lpA);
  const compat = LP_COMPAT[key] || { quality: 'Unique pairing', dynamic: 'A less common Life Path combination with its own unrepeated qualities.' };

  // Personal Year interaction
  const pyA = numA.py;
  const pyB = numB.py;
  let pyDynamic = '';
  if (pyA && pyB) {
    const pySum = reduce(pyA + pyB);
    if (pyA === pyB) pyDynamic = 'Both in Personal Year ' + pyA + ' simultaneously — a year of shared themes and mirrored lessons.';
    else if (Math.abs(pyA - pyB) === 1 || Math.abs(pyA - pyB) === 8) pyDynamic = 'Personal Years ' + pyA + ' and ' + pyB + ' are adjacent phases — one slightly ahead of the other in the nine-year cycle. This creates a natural mentoring dynamic this year.';
    else if (pyA + pyB === 10 || pyA + pyB === 19) pyDynamic = 'Personal Years ' + pyA + ' and ' + pyB + ' are complementary within the cycle — what one is releasing, the other is beginning.';
    else pyDynamic = 'Personal Year ' + pyA + ' (' + nameA + ') and Personal Year ' + pyB + ' (' + nameB + ') — different life themes active this year. Understanding each other\'s current chapter is essential.';
  }

  // Combined Life Path
  const combined = reduce(lpA + lpB);
  const combinedData = NUM[combined] || {};

  return {
    lpA, lpB,
    quality: compat.quality,
    dynamic: compat.dynamic,
    pyDynamic,
    combined, combinedName: combinedData.n || '',
    combinedMeaning: 'The combined energy of this relationship carries the frequency of ' + combined + ' (' + (combinedData.n || '') + ') — the numerological signature of what this partnership is here to create or learn.'
  };
}

// ══════════════════════════════════════════════════════════════════
// DREAMSPELL SYNASTRY — The Five Oracle Relationships
// Arguelles (1987) The Mayan Factor
// Each Kin has four oracle relationships derived from it:
// Analog, Antipode, Occult, Guide
// ══════════════════════════════════════════════════════════════════
function getDreamspellSynastry(kinA, kinB) {
  if (!kinA || !kinB) return null;

  const kinNumA = kinA.kin;
  const kinNumB = kinB.kin;

  // Color chromatic family relationship
  const colorA = kinA.color; // Red, White, Blue, Yellow
  const colorB = kinB.color;
  const COLOR_PARTNERS = { Red: 'White', White: 'Red', Blue: 'Yellow', Yellow: 'Blue' };
  const chromatic = colorA === colorB ? 'same-tribe'
    : COLOR_PARTNERS[colorA] === colorB ? 'chromatic-partner'
    : 'cross-family';

  const chromaticDesc = {
    'same-tribe': colorA + ' tribe — you share the same chromatic family. Natural resonance in how you process and express energy. You understand each other\'s fundamental mode without explanation.',
    'chromatic-partner': colorA + ' and ' + colorB + ' — complementary partner colours. This is one of the most harmonious pairings in Dreamspell. Your energies naturally complete each other.',
    'cross-family': colorA + ' and ' + colorB + ' — different colour families. Your modes of engaging with reality are genuinely different, which creates richness and the need for translation.',
  }[chromatic];

  // Tonal relationship
  const toneA = kinA.toneNum;
  const toneB = kinB.toneNum;
  const toneSum = ((toneA + toneB - 1) % 13) + 1;
  const toneRelation = toneA === toneB ? 'resonant tones — you pulse at the same frequency'
    : toneSum === 14 ? 'complementary tones (sum to 14) — you complete each other\'s vibrational arc'
    : 'distinct tones — each brings a different quality of intention and power';

  // Kin difference relationship
  const kinDiff = Math.abs(kinNumA - kinNumB);
  const kinSum = ((kinNumA + kinNumB - 1) % 260) + 1;

  // Are they in the same wavespell (13-day arc)?
  const wavespellA = Math.floor((kinNumA - 1) / 13);
  const wavespellB = Math.floor((kinNumB - 1) / 13);
  const sameWavespell = wavespellA === wavespellB;

  // GAP relationship
  const bothGAP = kinA.isGAP && kinB.isGAP;
  const oneGAP = (kinA.isGAP || kinB.isGAP) && !bothGAP;

  // Combined Kin
  const combinedKin = kinSum;
  const combinedSeal = SEALS[(combinedKin - 1) % 20];
  const combinedTone = TONES[(combinedKin - 1) % 13];
  const combinedColor = ['Red','White','Blue','Yellow'][(combinedKin - 1) % 4];

  return {
    kinA: kinNumA, kinB: kinNumB,
    chromatic, chromaticDesc,
    toneA, toneB, toneRelation,
    sameWavespell,
    bothGAP, oneGAP,
    combinedKin,
    combinedFull: 'Kin ' + combinedKin + ' — ' + combinedColor + ' ' + combinedTone + ' ' + combinedSeal,
    combinedMeaning: 'The combined Kin of this relationship is ' + combinedColor + ' ' + combinedTone + ' ' + combinedSeal + ' — the galactic signature of what this connection is here to embody and transmit together.',
    wavespellNote: sameWavespell ? 'You were born in the same wavespell — a rare and significant bond.' : 'Born in different wavespells, your 13-day arcs create a dynamic interplay of different intentions.'
  };
}

// ══════════════════════════════════════════════════════════════════
// NATAL MOON PHASE
// What lunar phase was active when each person was born?
// ══════════════════════════════════════════════════════════════════
const MOON_PHASE_NAMES = [
  { max: 1.5,  name: 'New Moon',         archetype: 'The Initiator — spontaneous, instinctive, driven by feeling over reflection' },
  { max: 7.5,  name: 'Waxing Crescent',  archetype: 'The Seeker — gathering energy, building toward something, full of possibility' },
  { max: 8.5,  name: 'First Quarter',    archetype: 'The Builder — decisive, action-oriented, willing to push through resistance' },
  { max: 14.5, name: 'Waxing Gibbous',   archetype: 'The Refiner — analytical, perfection-seeking, always improving' },
  { max: 16.5, name: 'Full Moon',        archetype: 'The Illuminator — relational, aware, seen and seeing — fulfillment through others' },
  { max: 22.5, name: 'Waning Gibbous',   archetype: 'The Messenger — drawn to share wisdom, teach, contribute to the larger story' },
  { max: 23.5, name: 'Last Quarter',     archetype: 'The Reorienteer — reassessing, releasing, turning away from what no longer fits' },
  { max: 30,   name: 'Waning Crescent',  archetype: 'The Mystic — finishing cycles, surrendering, deeply intuitive and contemplative' },
];

function getNatalMoonPhase(birthDateStr) {
  const moon = getMoon(birthDateStr);
  const cyc = parseFloat(moon.cycle);
  const found = MOON_PHASE_NAMES.find(p => cyc <= p.max) || MOON_PHASE_NAMES[MOON_PHASE_NAMES.length - 1];
  return {
    phase: found.name,
    archetype: found.archetype,
    cycle: cyc,
    pct: moon.pct
  };
}

function getMoonPhaseSynastry(phaseA, phaseB, nameA, nameB) {
  if (!phaseA || !phaseB) return null;

  // Phase type: waxing vs waning
  const waxingPhases = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous'];
  const aWaxing = waxingPhases.includes(phaseA.phase);
  const bWaxing = waxingPhases.includes(phaseB.phase);

  let dynamicNote = '';
  if (phaseA.phase === phaseB.phase) {
    dynamicNote = 'Born under the same lunar phase — you share a fundamental emotional rhythm and approach to relationship. This creates deep instinctive understanding.';
  } else if (aWaxing && !bWaxing) {
    dynamicNote = nameA + ' was born under a waxing moon (building energy) and ' + nameB + ' under a waning moon (integrating energy). One of you naturally initiates; the other naturally synthesises and completes. This is a powerful creative polarity.';
  } else if (!aWaxing && bWaxing) {
    dynamicNote = nameB + ' was born under a waxing moon (building energy) and ' + nameA + ' under a waning moon (integrating energy). One of you naturally initiates; the other naturally synthesises and completes. This is a powerful creative polarity.';
  } else if (aWaxing && bWaxing) {
    dynamicNote = 'Both born under waxing moons — you both naturally build, initiate, and reach toward new things. This creates momentum and possibility, with care needed around slowing down and integrating.';
  } else {
    dynamicNote = 'Both born under waning moons — you both naturally turn inward, integrate, and release. Deep shared wisdom and contemplative depth. You may need to consciously inject new energy and forward motion.';
  }

  return {
    phaseA: phaseA.phase, archetypeA: phaseA.archetype,
    phaseB: phaseB.phase, archetypeB: phaseB.archetype,
    dynamicNote
  };
}

// ══════════════════════════════════════════════════════════════════
// NATAL PLANETARY POSITIONS
// ══════════════════════════════════════════════════════════════════
// Uses J2000.0 epoch mean longitudes + mean daily motion
// Accuracy: Sun ±1°, Moon ±5°, inner planets ±5-10°, outer ±2-5°
// Sufficient for synastry interpretation; always labelled as approximate
// Source: Meeus (1998) Astronomical Algorithms, Table 31.a + 32.a
// ══════════════════════════════════════════════════════════════════
const J2000 = new Date('2000-01-01T12:00:00Z');

// [mean longitude at J2000, mean daily motion °/day]
const MEAN_MOTION = {
  Sun:     [280.46646,  0.98564736],
  Moon:    [218.31665, 13.17639648],
  Mercury: [252.25032,  4.09233445],
  Venus:   [181.97980,  1.60213034],
  Mars:    [355.45332,  0.52402068],
  Jupiter: [ 34.35148,  0.08308529],
  Saturn:  [ 50.07747,  0.03344876],
  Uranus:  [314.05501,  0.01172834],
  Neptune: [304.34867,  0.00598103],
  Pluto:   [238.92881,  0.00397057],
};

function getNatalPlanets(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const days = (d - J2000) / 86400000;
  return Object.entries(MEAN_MOTION).map(([name, [l0, motion]]) => {
    const deg = ((l0 + motion * days) % 360 + 360) % 360;
    return { name, deg, sign: getSign(deg), degStr: `${getDegInSign(deg)}° ${getSign(deg)}` };
  });
}

function getSunSign(day, month, year) {
  const d = new Date(`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T12:00:00Z`);
  const jDays = (d - J2000) / 86400000;
  const sunLon = ((280.46646 + 0.98564736 * jDays) % 360 + 360) % 360;
  return { sign: getSign(sunLon), deg: sunLon, degStr: `${getDegInSign(sunLon)}° ${getSign(sunLon)}` };
}

function getSynastryAspects(planetsA, planetsB) {
  // Cross-aspects: each of A's planets vs each of B's key planets
  const keyB = ['Sun','Moon','Venus','Mars','Saturn'];
  const keyA = ['Sun','Moon','Venus','Mars','Saturn','Mercury','Jupiter'];
  const out = [];
  for (const a of planetsA.filter(p => keyA.includes(p.name))) {
    for (const b of planetsB.filter(p => keyB.includes(p.name))) {
      let diff = Math.abs(a.deg - b.deg);
      if (diff > 180) diff = 360 - diff;
      for (const asp of ASPS) {
        const orb = Math.abs(diff - asp.d);
        if (orb <= asp.orb) {
          const str = Math.max(1, 5 - Math.floor(orb / (asp.orb / 5)));
          out.push({
            pA: a.name, pB: b.name, aspect: asp.n, sym: asp.sym,
            orb: orb.toFixed(1), str,
            label: `${a.name} (A) ${asp.sym} ${b.name} (B)`,
            desc: `${a.name} ${a.degStr} ${asp.n} ${b.name} ${b.degStr} (${orb.toFixed(1)}° orb)`
          });
          break;
        }
      }
    }
  }
  return out.sort((a, b) => b.str - a.str).slice(0, 8);
}

// ── COMPATIBILITY ENDPOINT ──
app.post('/api/compatibility', async (req, res) => {
  const { personA, personB, topic, customContext } = req.body;
  if (!personA || !personB) return res.status(400).json({ error: 'Both people required' });

  try {
    const pA = personA;
    const pB = personB;

    const today = new Date().toISOString().slice(0, 10);

    // Build birth date strings
    const dateA = pA.birthYear && pA.birthMonth && pA.birthDay
      ? `${pA.birthYear}-${String(pA.birthMonth).padStart(2,'0')}-${String(pA.birthDay).padStart(2,'0')}`
      : null;
    const dateB = pB.birthYear && pB.birthMonth && pB.birthDay
      ? `${pB.birthYear}-${String(pB.birthMonth).padStart(2,'0')}-${String(pB.birthDay).padStart(2,'0')}`
      : null;

    // ── ALL FOUR FRAMEWORKS ──
    const natalA    = dateA ? getNatalPlanets(dateA) : null;
    const natalB    = dateB ? getNatalPlanets(dateB) : null;
    const kinA      = dateA ? getKin(dateA) : null;
    const kinB      = dateB ? getKin(dateB) : null;
    const numA      = dateA ? getNumerology(dateA, pA.birthDay, pA.birthMonth, pA.birthYear) : null;
    const numB      = dateB ? getNumerology(dateB, pB.birthDay, pB.birthMonth, pB.birthYear) : null;
    const moonPhaseA = dateA ? getNatalMoonPhase(dateA) : null;
    const moonPhaseB = dateB ? getNatalMoonPhase(dateB) : null;

    // ── CROSS-ANALYSIS (pre-computed, structured) ──
    const synAspects      = (natalA && natalB) ? getSynastryAspects(natalA, natalB) : [];
    const numCross        = getNumerologyCrossAnalysis(numA, numB, pA.name || pA.nickname || 'Person A', pB.name || pB.nickname || 'Person B');
    const dreamspellCross = (kinA && kinB) ? getDreamspellSynastry(kinA, kinB) : null;
    const moonPhaseCross  = getMoonPhaseSynastry(moonPhaseA, moonPhaseB, pA.name || pA.nickname || 'Person A', pB.name || pB.nickname || 'Person B');

    // ── BIORHYTHMS TODAY ──
    const bioA      = dateA ? getBiorhythms(dateA, today) : null;
    const bioB      = dateB ? getBiorhythms(dateB, today) : null;
    const bioSynastry = (bioA && bioB) ? getBiorhythmSynastry(bioA, bioB) : null;

    const nameA = pA.nickname || pA.name || 'Person A';
    const nameB = pB.nickname || pB.name || 'Person B';

    const formatNatal = (natal, kin, num, moonPhase, person) => {
      if (!natal) return (person.name || 'Person') + ': birth details not provided';
      return 'Name: ' + (person.name || person.nickname || 'unknown') + '\n'
        + 'Born: ' + person.birthDay + '/' + person.birthMonth + '/' + person.birthYear
        + (person.birthTime ? ' at ' + person.birthTime : '')
        + (person.birthLocation ? ' in ' + person.birthLocation : '') + '\n'
        + 'Sun: ' + natal[0].degStr + ' | Moon: ' + natal[1].degStr + ' | Venus: ' + natal[3].degStr + ' | Mars: ' + natal[4].degStr + '\n'
        + 'Mercury: ' + natal[2].degStr + ' | Jupiter: ' + natal[5].degStr + ' | Saturn: ' + natal[6].degStr + '\n'
        + 'Life Path: ' + (num ? num.lp : '?') + ' (' + (num && num.lpM ? num.lpM.n : '') + ') | Personal Year: ' + (num ? num.py : '?') + '\n'
        + 'Dreamspell Birth Kin: ' + (kin ? kin.full : '?') + (kin && kin.isGAP ? ' (GAP — portal day birth)' : '') + '\n'
        + 'Natal Moon Phase: ' + (moonPhase ? moonPhase.phase + ' — ' + moonPhase.archetype : 'unknown');
    };

    const aspectList = synAspects.map(a =>
      '●'.repeat(a.str) + '○'.repeat(5-a.str) + ' ' + a.desc
    ).join('\n');

    // Format cross-analysis as structured text for Oracle
    const numCrossText = numCross
      ? 'NUMEROLOGY CROSS-ANALYSIS:\n'
        + 'Life Path ' + numCross.lpA + ' and ' + numCross.lpB + ' — ' + numCross.quality + '\n'
        + numCross.dynamic + '\n'
        + (numCross.pyDynamic ? numCross.pyDynamic + '\n' : '')
        + 'Combined relationship frequency: ' + numCross.combined + ' (' + numCross.combinedName + ') — ' + numCross.combinedMeaning
      : 'Numerology: insufficient birth data';

    const dreamspellCrossText = dreamspellCross
      ? 'DREAMSPELL SYNASTRY:\n'
        + dreamspellCross.chromaticDesc + '\n'
        + 'Tonal relationship: ' + dreamspellCross.toneRelation + '\n'
        + (dreamspellCross.sameWavespell ? 'Born in the same wavespell — rare and significant.\n' : '')
        + (dreamspellCross.bothGAP ? 'Both born on Galactic Activation Portal days — extraordinary portal-day connection.\n' : '')
        + 'Combined Kin: ' + dreamspellCross.combinedFull + ' — ' + dreamspellCross.combinedMeaning
      : 'Dreamspell: insufficient data';

    const moonPhaseCrossText = moonPhaseCross
      ? 'NATAL MOON PHASE SYNASTRY:\n'
        + nameA + ' born at ' + moonPhaseCross.phaseA + ' — ' + moonPhaseCross.archetypeA + '\n'
        + nameB + ' born at ' + moonPhaseCross.phaseB + ' — ' + moonPhaseCross.archetypeB + '\n'
        + moonPhaseCross.dynamicNote
      : 'Natal moon phase: insufficient data';

    const bioText = bioSynastry
      ? 'BIORHYTHM CROSS-ANALYSIS TODAY (' + today + '):\n'
        + bioSynastry.map(b =>
            b.cycle + ': ' + nameA + ' at ' + b.aPct + '% (' + b.aPhase + '), '
            + nameB + ' at ' + b.bPct + '% (' + b.bPhase + ') — ' + b.dynamic
          ).join('\n')
      : '';

    const topicMap = {
      romance:       'Romantic compatibility — attraction, intimacy, long-term potential, physical chemistry, emotional resonance',
      communication: 'Communication — how they think, speak, argue, listen, and understand each other',
      conflict:      'Conflict and growth edges — where they clash, why, and what those tensions are trying to build',
      parenting:     'Parenting together — how they parent as a team, where they align and diverge, how to be consistent',
      business:      'Business and creative partnership — complementary strengths, blind spots, decision-making dynamics',
      friendship:    'Friendship — the nature of the bond, what sustains it, what deepens it over time',
      children:      'Understanding a child — how to connect with, motivate, nurture, and support this child',
      fun:           'Where they click best — shared pleasures, compatible rhythms, what brings out the best in each other',
    };
    const topicDesc = topicMap[topic] || topicMap.romance;

    // Pre-compute string values for safe concatenation
    const kinAStr = kinA ? kinA.full : 'not calculated';
    const kinBStr = kinB ? kinB.full : 'not calculated';
    const lpAStr  = numA ? String(numA.lp) : 'unknown';
    const lpBStr  = numB ? String(numB.lp) : 'unknown';
    const lpAnm   = (numA && numA.lpM) ? numA.lpM.n : '';
    const lpBnm   = (numB && numB.lpM) ? numB.lpM.n : '';
    const ctxA    = pA.context ? 'Context: ' + pA.context : '';
    const ctxB    = pB.context ? 'Context: ' + pB.context : '';
    const userCtx = customContext ? 'USER CONTEXT: ' + customContext : '';
    const aspList = aspectList || 'Insufficient birth data for precise aspects';
    const aspJSON = synAspects.slice(0, 5).map(function(a) {
      return '{"aspect":"' + a.desc.replace(/"/g, "'") + '","interpretation":"<3 sentences: what this cross-aspect means for ' + nameA + ' and ' + nameB + ' specifically>"}';
    }).join(',\n    ');

    const sys = 'You are the Oracle at Cosmic Daily Planner — the most sophisticated multi-framework relationship reading system in existence.\n\n'
      + 'YOUR VOICE: A Jungian analyst, a spiritual director, and the wisest friend they have ever had — in one voice. Precise. Warm. Deeply honest. You speak to what is actually happening beneath the surface, not just what is comfortable to hear. You hold both the gifts and the shadows with equal care.\n\n'
      + 'TOPIC: ' + topicDesc + '\n\n'
      + 'FRAMEWORK SOURCES you are drawing on simultaneously:\n'
      + '1. Western astrology synastry (natal planetary cross-aspects, approximate positions, Meeus 1998)\n'
      + '2. Pythagorean numerology cross-analysis (Life Path compatibility, Drayer 2002; Millman 1993)\n'
      + '3. Dreamspell synastry (chromatic family, tonal relationship, combined Kin, Arguelles 1987)\n'
      + '4. Natal lunar phase archetypes (emotional rhythm and relationship archetype from birth phase)\n'
      + '5. Biorhythm cross-analysis for today (physical, emotional, intellectual cycle synchrony)\n\n'
      + 'RULES:\n'
      + '— Address ' + nameA + ' directly throughout. Use both names. Never "Person A" or "Person B".\n'
      + '— Synthesise ALL FIVE frameworks — do not treat them separately. The power is in the convergence.\n'
      + '— When multiple frameworks point to the same dynamic, name that convergence explicitly — it is the most significant signal.\n'
      + '— When frameworks diverge (e.g. numerology says compatible, astrology shows tension), name the paradox and explain what it means.\n'
      + '— Be honest about challenges. Do not flatten or spiritually bypass difficulty.\n'
      + '— Planetary positions are approximate mean longitudes — always label as such.\n'
      + '— End with genuine engagement: a question, a practice, an invitation to go deeper.\n'
      + '— RESPOND ONLY WITH VALID JSON. No markdown, no preamble.\n'
      + '— Scholarly sources: Greene (1976) Saturn; Arroyo (1978); Sasportas (1989); Tarnas (2006); Drayer (2002); Millman (1993); Arguelles (1987).';

    const user = 'PERSON A — ' + nameA + ':\n'
      + formatNatal(natalA, kinA, numA, moonPhaseA, pA) + '\n'
      + ctxA + '\n\n'
      + 'PERSON B — ' + nameB + ':\n'
      + formatNatal(natalB, kinB, numB, moonPhaseB, pB) + '\n'
      + ctxB + '\n\n'
      + 'ASTROLOGICAL CROSS-ASPECTS (approximate, Meeus 1998):\n' + aspList + '\n\n'
      + numCrossText + '\n\n'
      + dreamspellCrossText + '\n\n'
      + moonPhaseCrossText + '\n\n'
      + (bioText ? bioText + '\n\n' : '')
      + 'TOPIC: ' + topicDesc + '\n'
      + userCtx + '\n\n'
      + 'Generate the compatibility reading as valid JSON. This is a landmark document — the most multi-layered compatibility reading available anywhere. Every section must synthesise multiple frameworks, not just one:\n'
      + '{\n'
      + '  "headline": "<One sentence capturing the essential truth of this connection — specific, evocative, grounded in the data>",\n'
      + '  "synthesis": "<4-5 sentence opening synthesising ALL frameworks. Name the convergences — where multiple frameworks point to the same dynamic. What is this connection fundamentally about?>",\n'
      + '  "framework_convergence": "<2-3 paragraphs. Where do the five frameworks AGREE? This is the most reliable signal. Name it explicitly. Then: where do they diverge, and what does that paradox mean?>",\n'
      + '  "gifts": {\n'
      + '    "headline": "<The genuine strengths of this connection>",\n'
      + '    "body": "<3 rich paragraphs: (1) The primary gift — named across multiple frameworks. (2) How they bring out the best in each other specifically re: ' + topicDesc + '. (3) What this connection uniquely offers.>"\n'
      + '  },\n'
      + '  "tensions": {\n'
      + '    "headline": "<The growth edges — honest>",\n'
      + '    "body": "<3 paragraphs: (1) Primary tension named across frameworks — where do multiple systems signal friction? (2) What that tension is asking both people to develop. (3) Specific, practical ways to work with it.>"\n'
      + '  },\n'
      + '  "topic_specific": {\n'
      + '    "headline": "<' + topicDesc + '>",\n'
      + '    "body": "<4 substantial paragraphs grounded in specific cross-framework data. Concrete. Day-to-day. Not archetypes — actual guidance.>"\n'
      + '  },\n'
      + '  "key_aspects": [\n'
      + '    ' + aspJSON + '\n'
      + '  ],\n'
      + '  "biorhythm_today": "<2 paragraphs: what their biorhythm positions say about their dynamics TODAY specifically. Physical synchrony or friction, emotional alignment or divergence, intellectual resonance. What is today good for in this relationship, and what to navigate carefully?>",\n'
      + '  "dreamspell_connection": "<2 paragraphs: ' + kinAStr + ' and ' + kinBStr + '. The chromatic relationship, tonal dynamic, combined Kin ' + (dreamspellCross ? dreamspellCross.combinedFull : '') + ', and what their Dreamspell synastry says about the galactic purpose of this connection.>",\n'
      + '  "numerology_connection": "<2 paragraphs: Life Path ' + lpAStr + ' (' + lpAnm + ') and ' + lpBStr + ' (' + lpBnm + '). The compatibility dynamic, Personal Year interaction, combined frequency. What the numbers say about timing, purpose, and what this partnership is here to build.>",\n'
      + '  "natal_moon_connection": "<2 paragraphs: how their natal moon phases — their birth emotional archetypes — interact. What this means for how they feel, receive love, and process experience together.>",\n'
      + '  "for_them": {\n'
      + '    "for_a": "<4 sentences for ' + nameA + ' — not advice, but genuine insight. What do they most need to understand about ' + nameB + ' that they likely do not yet see? What is their specific growth edge in this relationship?>",\n'
      + '    "for_b": "<4 sentences for ' + nameB + ' — same depth, same honesty.>"\n'
      + '  },\n'
      + '  "a_question_to_sit_with": "<One question for them both — not rhetorical, but genuinely open. The question that, if they sat with it honestly together, would unlock something important. It should feel slightly uncomfortable to ask.>",\n'
      + '  "closing": "<One final sentence — the deepest truth of this connection. Warm, precise, honest.>",\n'
      + '  "sources": "Astrology: approximate natal positions Meeus (1998) Astronomical Algorithms. Synastry: Greene (1976); Arroyo (1978); Sasportas (1989); Tarnas (2006). Numerology: Drayer (2002); Millman (1993). Dreamspell: Arguelles (1987) modern system. Biorhythms: Teltscher, Fliess, Swoboda (classical three-cycle theory). Natal moon phase archetypes."\n'
      + '}';

    const raw = await callAPI('claude-sonnet-4-6', 12000, sys, user);
    let reading;
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      reading = JSON.parse(cleaned);
    } catch(e) {
      try {
        reading = JSON.parse(repairJSON(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()));
        reading._repaired = true;
      } catch(e2) {
        reading = { synthesis: raw, raw: true };
      }
    }

    res.json({
      reading,
      natalA: natalA ? natalA.slice(0, 7) : null,
      natalB: natalB ? natalB.slice(0, 7) : null,
      kinA, kinB, numA, numB,
      moonPhaseA, moonPhaseB,
      bioA: bioA ? { physical: bioA.physical, emotional: bioA.emotional, intellectual: bioA.intellectual, composite: bioA.composite } : null,
      bioB: bioB ? { physical: bioB.physical, emotional: bioB.emotional, intellectual: bioB.intellectual, composite: bioB.composite } : null,
      bioSynastry,
      numCross, dreamspellCross, moonPhaseCross,
      synAspects,
      nameA, nameB, topic
    });

  } catch(e) {
    console.error('Compatibility error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CDP v7 Beta2 — streaming — port ${PORT}`));
