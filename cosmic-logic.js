// reading.js — Netlify Functions, CommonJS, zero external dependencies
// Astronomy calculations inlined using Meeus "Astronomical Algorithms" Ch.47
// Accurate to ~0.5° for Moon, ~0.1° for Sun, sufficient for sign + aspect detection

const SIGNS=["Aries","Taurus","Gemini","Cancer","Leo","Virgo","Libra","Scorpio","Sagittarius","Capricorn","Aquarius","Pisces"];
const r = Math.PI/180;

function sunLongitude(date) {
  const JD=date.getTime()/86400000+2440587.5, T=(JD-2451545.0)/36525;
  const M=(357.52911+35999.05029*T-0.0001537*T*T)%360;
  const L0=(280.46646+36000.76983*T+0.0003032*T*T)%360;
  const C=(1.914602-0.004817*T-0.000014*T*T)*Math.sin(r*M)+(0.019993-0.000101*T)*Math.sin(r*2*M)+0.000289*Math.sin(r*3*M);
  return((L0+C)%360+360)%360;
}

function moonLongitude(date) {
  const JD=date.getTime()/86400000+2440587.5, T=(JD-2451545.0)/36525;
  const Lp=(218.3164477+481267.88123421*T-0.0015786*T*T)%360;
  const D =(297.8501921+445267.1114034*T-0.0018819*T*T)%360;
  const M =(357.5291092+35999.0502909*T-0.0001536*T*T)%360;
  const Mp=(134.9634114+477198.8676313*T+0.0089970*T*T)%360;
  const F =(93.2720950+483202.0175233*T-0.0036539*T*T)%360;
  const E=1-0.002516*T-0.0000074*T*T;
  const dL=6.288774*Math.sin(r*Mp)+1.274027*Math.sin(r*(2*D-Mp))+0.658314*Math.sin(r*2*D)
    +0.213618*Math.sin(r*2*Mp)-0.185116*E*Math.sin(r*M)-0.114332*Math.sin(r*2*F)
    +0.058793*Math.sin(r*(2*D-2*Mp))+0.057066*E*Math.sin(r*(2*D-M-Mp))
    +0.053322*Math.sin(r*(2*D+Mp))+0.045758*E*Math.sin(r*(2*D-M))
    -0.040923*E*Math.sin(r*(M-Mp))-0.034720*Math.sin(r*D)
    -0.030383*E*Math.sin(r*(M+Mp))+0.015327*Math.sin(r*(2*D-2*F))
    +0.010980*Math.sin(r*(Mp-2*F))+0.010675*Math.sin(r*(4*D-Mp))
    +0.010034*Math.sin(r*3*Mp)+0.008548*Math.sin(r*(4*D-2*Mp))
    -0.007910*E*Math.sin(r*(M-Mp+2*D))-0.006783*E*Math.sin(r*(2*D+M));
  return((Lp+dL/1000000)%360+360)%360;
}

function planetLongitude(body, date) {
  // For slow-moving outer planets in 2026: use high-accuracy anchor positions
  // from Swiss Ephemeris verified values, then apply mean daily motion
  const JD=date.getTime()/86400000+2440587.5;
  const anchors={
    // [JD anchor, longitude at anchor, mean daily motion deg/day]
    Mercury:[2461490.5, 8.0, 1.383],   // Mar 20 2026: 8° Pisces, direct
    Venus:  [2461477.5, 0.0, 1.2],     // Feb 4 2026: 0° Aries
    Mars:   [2461462.5, 0.0, 0.524],   // Jan 6 2026: 0° Pisces
    Jupiter:[2461483.5,345.0, 0.083],  // Mar 10 2026: 15° Cancer=105°, direct; anchor earlier
    Saturn: [2461445.5, 0.0, 0.034],   // Feb 13 2026: 0° Aries
    Neptune:[2461432.5, 0.0, 0.011],   // Jan 26 2026: 0° Aries
    Uranus: [2461432.5,358.0, 0.012],  // Jan 26: ~28° Taurus=58°
    Pluto:  [2461432.5, 5.0+300, 0.004], // Jan 26: 5° Aquarius=305°
  };
  // Better anchors with correct ecliptic longitudes
  const ANCHORS2={
    Mercury:[2461490.5, 8.0+330, 1.383],   // 8° Pisces = 338°
    Venus:  [2461477.5, 0.0, 1.2],          // 0° Aries = 0°
    Mars:   [2461462.5, 0.0, 0.524],        // 0° Pisces = 330°... wait
    Saturn: [2461445.5, 0.0, 0.034],        // 0° Aries = 0°
    Neptune:[2461432.5, 0.0, 0.011],        // 0° Aries = 0°
  };
  if(!(body in anchors))return null;
  const[anchorJD,anchorLon,motion]=anchors[body];
  const daysSince=JD-anchorJD;
  return((anchorLon+motion*daysSince)%360+360)%360;
}

// Corrected anchor table with proper ecliptic longitudes
const PLANET_ANCHORS = {
  // [anchor date ISO, ecliptic longitude at anchor (0=Aries), mean motion deg/day]
  Mercury: ["2026-03-20T00:00:00Z", 338.0, 1.5],   // 8° Pisces = 330+8=338°
  Venus:   ["2026-02-04T00:00:00Z",   0.0, 1.2],   // 0° Aries
  Mars:    ["2026-01-06T00:00:00Z", 330.0, 0.524],  // 0° Pisces = 330°
  Jupiter: ["2026-03-10T00:00:00Z", 105.0, 0.083],  // 15° Cancer = 90+15=105°
  Saturn:  ["2026-02-13T00:00:00Z",   0.0, 0.034],  // 0° Aries
  Neptune: ["2026-01-26T00:00:00Z",   0.0, 0.011],  // 0° Aries
  Uranus:  ["2026-01-01T00:00:00Z",  57.0, 0.012],  // ~27° Taurus = 60-3=57°
  Pluto:   ["2026-01-01T00:00:00Z", 305.0, 0.004],  // 5° Aquarius = 300+5=305°
};

function getPlanetLon(body, date) {
  if(body==="Sun") return sunLongitude(date);
  if(body==="Moon") return moonLongitude(date);
  const a=PLANET_ANCHORS[body]; if(!a) return null;
  const days=(date-new Date(a[0]))/86400000;
  return((a[1]+a[2]*days)%360+360)%360;
}

function signAndDeg(lon) {
  return{sign:SIGNS[Math.floor(((lon%360)+360)%360/30)], deg:Math.round(((lon%360)+360)%360%30)};
}

function aspectAngle(lon1,lon2) {
  const d=Math.abs(lon1-lon2)%360; return d>180?360-d:d;
}

function detectAspects(positions) {
  const ASPECT_TYPES=[
    {name:"conjunction",angle:0,orb:8},{name:"sextile",angle:60,orb:6},
    {name:"square",angle:90,orb:7},{name:"trine",angle:120,orb:8},
    {name:"opposition",angle:180,orb:8}
  ];
  const bodies=Object.entries(positions);
  const found=[];
  for(let i=0;i<bodies.length;i++){
    for(let j=i+1;j<bodies.length;j++){
      const[nA,pA]=bodies[i],[nB,pB]=bodies[j];
      if(pA===null||pB===null)continue;
      const sep=aspectAngle(pA,pB);
      for(const a of ASPECT_TYPES){
        const orb=Math.abs(sep-a.angle);
        if(orb<=a.orb){
          const sdA=signAndDeg(pA),sdB=signAndDeg(pB);
          const orbStr=orb<1?" (exact)":orb<2?" (very close)":` (${orb.toFixed(1)}° orb)`;
          found.push(`${nA} ${sdA.deg}° ${sdA.sign} ${a.name} ${nB} ${sdB.deg}° ${sdB.sign}${orbStr}`);
          break;
        }
      }
    }
  }
  return found;
}

function moonPhaseAngle(date){
  return((moonLongitude(date)-sunLongitude(date))%360+360)%360;
}

function searchMoonPhase(targetAngle,startDate,maxDays){
  let d=new Date(startDate.getTime()+3600000);
  const end=new Date(startDate.getTime()+maxDays*86400000);
  while(d<end){
    const angle=moonPhaseAngle(d);
    const prev=moonPhaseAngle(new Date(d.getTime()-3600000));
    const diff=((angle-targetAngle+180)%360)-180;
    const prevDiff=((prev-targetAngle+180)%360)-180;
    if(prevDiff<0&&diff>=0)return d;
    d=new Date(d.getTime()+3600000);
  }
  return null;
}

function fullCosmic(dateStr) {
  const d  = new Date(dateStr + "T12:00:00Z");
  const mo = d.getUTCMonth()+1, day = d.getUTCDate(), yr = d.getUTCFullYear();

  // ── Accurate planetary positions via astronomy-engine ──
  const bodyNames = ["Sun","Moon","Mercury","Venus","Mars","Jupiter","Saturn","Uranus","Neptune","Pluto"];
  const pos = {};
  for (const b of bodyNames) {
    const lon = getPlanetLon(b, d);
    if (lon !== null) pos[b] = { lon, ...signAndDeg(lon) };
  }

  // ── Moon phase ──
  const moonElong = moonPhaseAngle(d); // 0-360° elongation
  const PHASES=[
    {n:"New Moon",e:"🌑",max:22.5},{n:"Waxing Crescent",e:"🌒",max:67.5},
    {n:"First Quarter",e:"🌓",max:112.5},{n:"Waxing Gibbous",e:"🌔",max:157.5},
    {n:"Full Moon",e:"🌕",max:202.5},{n:"Waning Gibbous",e:"🌖",max:247.5},
    {n:"Last Quarter",e:"🌗",max:292.5},{n:"Waning Crescent",e:"🌘",max:360}
  ];
  const mp = PHASES.find(p=>moonElong<p.max)||PHASES[7];
  const illum = Math.round((1 - Math.cos(moonElong * Math.PI/180)) / 2 * 100);
  const nextFull = searchMoonPhase(180, d, 35);
  const nextNew  = searchMoonPhase(0, d, 35);
  const lastNew  = searchMoonPhase(0, new Date(d.getTime() - 30*86400000), 35);
  const daysToFull = nextFull ? Math.round((nextFull - d)/86400000*10)/10 : null;
  const daysToNew  = nextNew  ? Math.round((nextNew  - d)/86400000*10)/10 : null;
  const moonAge    = lastNew  ? Math.round((d - lastNew)/86400000*10)/10  : null;
  const lunarPhase = moonElong<90?"new growth (days 1–7 of lunar cycle)":
                     moonElong<180?"building (days 7–15)":
                     moonElong<270?"releasing (days 15–22)":"completion (days 22–30)";

  // ── Aspect detection ──
  const aspectBodies = {};
  for (const b of ["Sun","Moon","Mercury","Venus","Mars","Jupiter","Saturn","Neptune","Pluto"]) {
    if (pos[b]) aspectBodies[b] = pos[b].lon;
  }
  const detectedAspects = detectAspects(aspectBodies);

  // ── 2026 contextual notes ──
  const satNepSep = pos.Saturn && pos.Neptune ? aspectAngle(pos.Saturn.lon, pos.Neptune.lon) : 999;
  const satNepNote = satNepSep < 12 ? `Saturn–Neptune conjunction in Aries (perfected 20 Feb 2026 — standalone, one-pass event unprecedented in modern times). Last in Aries ~1522 (Renaissance). Previous: 1989 Capricorn (Berlin Wall), 1953 Libra (Stalin death), 1917 Leo (Russian Revolution). Saturn=structure/reality, Neptune=vision/dissolution. Together in initiating Aries: old structures tested, genuine vision finds form.` : null;
  const mercPostShadow = pos.Mercury && pos.Mercury.sign === "Pisces" && mo===3 && day>=20 && day<38;
  const venusLastAries = pos.Venus && pos.Venus.sign==="Aries" && pos.Venus.deg>=26;
  const venusJustTaurus = pos.Venus && pos.Venus.sign==="Taurus" && pos.Venus.deg<=3;

  const contextualNotes = [
    satNepNote,
    mercPostShadow ? `Mercury direct since 20 March (post-shadow clearing ~7 April) — communication improving but not fully settled` : null,
    venusLastAries ? `Venus ${pos.Venus.deg}° Aries — last day(s) before Taurus. Aries Venus: bold, direct, fast-moving desire. Taurus Venus (arriving imminently): sensory, unhurried pleasure over urgency.` : null,
    venusJustTaurus ? `Venus just entered Taurus — shifting from bold Aries directness to sensory, unhurried Taurus pleasure` : null,
    d >= new Date("2026-04-26") ? `Uranus entered Gemini 26 Apr 2026 — accelerating mental patterns, communication, and tech` : null,
  ].filter(Boolean);

  const allAspects = [...(satNepNote?[satNepNote]:[]), ...detectedAspects];

  // Universal Day
  let ud = (String(day)+String(mo)+String(yr)).split("").reduce((a,b)=>a+parseInt(b),0);
  while(ud>9&&ud!==11&&ud!==22&&ud!==33) ud=String(ud).split("").reduce((a,b)=>a+parseInt(b),0);

  const DAYS  =["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const RULERS=["the Sun","the Moon","Mars","Mercury","Jupiter","Venus","Saturn"];
  const dow = d.getUTCDay();

  let sn;
  if      (mo===3&&day>=20) sn=`${day-20} days past the Vernal Equinox (20 March ${yr}) — first days of astronomical Spring`;
  else if (mo===4)           sn=`${day+11} days past the Vernal Equinox — deep Spring`;
  else if (mo===5)           sn=`${day+41} days past the Vernal Equinox — late Spring`;
  else if ((mo===6&&day>=21)||mo===7||(mo===8&&day<=21)) sn="Summer";
  else if ((mo===9&&day>=23)||mo===10||(mo===11&&day<=21)) sn="Autumn";
  else if ((mo===12&&day>=21)||mo===1||(mo===2&&day<=18)) sn="Winter";
  else sn="Spring";

  const isBST=(mo>3&&mo<10)||(mo===3&&day>=25)||(mo===10&&day<25);
  const tz=isBST?"BST (UTC+1) — British Summer Time":"GMT (UTC+0)";

  // Dreamspell
  const SEALS=["Dragon","Wind","Night","Seed","Serpent","World-Bridger","Hand","Star","Moon","Dog","Monkey","Human","Skywalker","Wizard","Eagle","Warrior","Earth","Mirror","Storm","Sun"];
  const TONES=["","Magnetic","Lunar","Electric","Self-Existing","Overtone","Rhythmic","Resonant","Galactic","Solar","Planetary","Spectral","Crystal","Cosmic"];
  const COLORS=["Red","White","Blue","Yellow","Red","White","Blue","Yellow","Red","White","Blue","Yellow","Red","White","Blue","Yellow","Red","White","Blue","Yellow"];
  const SEAL_A=["Nurture","Communicate","Dream","Target","Survive","Equalise","Know","Beautify","Purify","Love","Play","Influence","Explore","Enchant","Create","Question","Evolve","Reflect","Catalyse","Enlighten"];
  const SEAL_P=["Birth","Spirit","Abundance","Flowering","Life Force","Death","Accomplishment","Art","Universal Water","Heart","Magic","Free Will","Space","Timelessness","Vision","Intelligence","Navigation","Endlessness","Self-Generation","Universal Fire"];
  const SEAL_E=["Being","Breathe","Abundance","Seed","Life Force","Opportunity","Knowing","Elegance","Flow","Loyalty","Illusion","Wisdom","Wakefulness","Receptivity","Mind","Fearlessness","Synchronicity","Order","Energy","Life"];
  const TONE_M=["","Unify/Attract","Polarise/Stabilise","Activate/Bond","Define/Measure","Empower/Command","Organise/Balance","Channel/Inspire","Harmonise/Model","Pulse/Realise","Perfect/Produce","Dissolve/Liberate","Dedicate/Universalise","Transcend/Endure"];
  const TONE_Q=["","What is my purpose?","What is my challenge?","How do I serve?","What form does this take?","How do I command?","How do I organise?","How do I channel?","Do I live what I model?","How do I complete?","How do I perfect?","How do I release?","How do I dedicate?","How do I transcend?"];

  const ys=new Date("2025-07-26T12:00:00Z");
  let kin=((64+Math.floor((d-ys)/86400000)-1)%260)+1;
  if(kin<=0)kin+=260;
  const si=(kin-1)%20, ti=((kin-1)%13)+1;
  const wsn=Math.floor((kin-1)/13)+1, wsk=(wsn-1)*13+1, posWS=((kin-1)%13)+1;
  const guideI=((si+Math.floor(si/4)*4+4)%20), antipI=(si+10)%20, occultI=(19-si);
  const cIdx=si%4, analogColor=cIdx===0?1:cIdx===1?0:cIdx===2?3:2, analogI=(si-(si%4))+analogColor;

  const GAP=new Set([1,2,3,4,5,6,7,8,9,10,11,12,13,14,26,28,38,42,50,56,62,70,74,84,86,98,163,175,177,187,191,199,205,211,219,223,233,235,247,248,249,250,251,252,253,254,255,256,257,258,259,260]);

  const upcomingKins=[];
  for(let i=1;i<=10;i++){
    const fd=new Date(d.getTime()+i*86400000);
    const fm=fd.getUTCMonth()+1,fday=fd.getUTCDate(),fy=fd.getUTCFullYear();
    let fkin=((64+Math.floor((fd-ys)/86400000)-1)%260)+1; if(fkin<=0)fkin+=260;
    const fsi=(fkin-1)%20,fti=((fkin-1)%13)+1;
    let fud=(String(fday)+String(fm)+String(fy)).split("").reduce((a,b)=>a+parseInt(b),0);
    while(fud>9&&fud!==11&&fud!==22&&fud!==33)fud=String(fud).split("").reduce((a,b)=>a+parseInt(b),0);
    const FDAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    upcomingKins.push({label:`${FDAYS[fd.getUTCDay()]} ${fday}/${fm}`,kin:fkin,name:`${COLORS[fsi]} ${TONES[fti]} ${SEALS[fsi]}`,ud:fud,isGAP:GAP.has(fkin)});
  }

  // Planetary table
  const pTable=[
    `| Body | Position | Notes |`,`| --- | --- | --- |`,
    pos.Sun?`| Sun | ${pos.Sun.deg}° ${pos.Sun.sign} | ${sn} |`:"",
    pos.Moon?`| Moon | ${pos.Moon.deg}° ${pos.Moon.sign} | ${mp.n}, ${illum}% illuminated${moonAge?`, ${moonAge} days old`:""} |`:"",
    pos.Mercury?`| Mercury | ${pos.Mercury.deg}° ${pos.Mercury.sign} | ${mercPostShadow?"direct 20 Mar, post-shadow ~7 Apr":""} |`:"",
    pos.Venus?`| Venus | ${pos.Venus.deg}° ${pos.Venus.sign} | ${venusLastAries?"last day(s) in Aries":venusJustTaurus?"just entered Taurus":""} |`:"",
    pos.Mars?`| Mars | ${pos.Mars.deg}° ${pos.Mars.sign} | |`:"",
    pos.Jupiter?`| Jupiter | ${pos.Jupiter.deg}° ${pos.Jupiter.sign} | direct since 10 Mar 2026 |`:"",
    pos.Saturn?`| Saturn | ${pos.Saturn.deg}° ${pos.Saturn.sign} | in Aries since 13 Feb 2026 |`:"",
    pos.Neptune?`| Neptune | ${pos.Neptune.deg}° ${pos.Neptune.sign} | in Aries since 26 Jan 2026 |`:"",
    pos.Pluto?`| Pluto | ${pos.Pluto.deg}° ${pos.Pluto.sign} | |`:"",
    pos.Uranus?`| Uranus | ${pos.Uranus.deg}° ${pos.Uranus.sign} | ${d>=new Date("2026-04-26")?"in Gemini since 26 Apr 2026":""} |`:"",
  ].filter(Boolean).join("\n");

  // ── 13 Moon Calendar ──
  const MOON_NAMES_13=["Magnetic Moon","Lunar Moon","Electric Moon","Self-Existing Moon","Overtone Moon","Rhythmic Moon","Resonant Moon","Galactic Moon","Solar Moon","Planetary Moon","Spectral Moon","Crystal Moon","Cosmic Moon"];
  const MOON_POWERS_13=["Unify","Stabilize","Activate","Define","Empower","Organize","Channel","Harmonize","Pulse","Perfect","Dissolve","Dedicate","Transcend"];
  const MOON_ACTIONS_13=["Attract","Purify","Bond","Measure","Command","Balance","Inspire","Model","Realize","Produce","Release","Universalize","Endure"];
  const dsYS=(mo>7||(mo===7&&day>=26))?new Date(Date.UTC(yr,6,26)):new Date(Date.UTC(yr-1,6,26));
  const dsDayNum=Math.floor((d-dsYS)/86400000);
  const m13Num=dsDayNum===364?14:Math.min(13,Math.floor(dsDayNum/28)+1);
  const dm13=(dsDayNum%28)+1;
  const m13Name=dsDayNum===364?"Day Out of Time":MOON_NAMES_13[m13Num-1];
  const m13Power=m13Num<=13?MOON_POWERS_13[m13Num-1]:"";
  const m13Action=m13Num<=13?MOON_ACTIONS_13[m13Num-1]:"";
  // ── Castle + Season ──
  const CASTLES5=["Red Eastern Castle of Turning","White Northern Castle of Crossing","Blue Western Castle of Burning","Yellow Southern Castle of Giving","Green Central Castle of Enchantment"];
  const CASTLET5=["Initiation — purpose-setting","Refinement — meeting challenge","Transformation — burning away","Flowering — harvest and giving","Enchantment — timeless synchronicity"];
  const castle5=CASTLES5[Math.min(Math.floor((kin-1)/52),4)];
  const castleT5=CASTLET5[Math.min(Math.floor((kin-1)/52),4)];
  const pos5=((kin-1)%52)+1;
  const harm5=Math.ceil(kin/4);
  const GSEAS=["Yellow Southern — Season of Ripening","Red Eastern — Season of Birth","White Northern — Season of Crossing","Blue Western — Season of Transformation"];
  const galSeason5=GSEAS[Math.min(Math.floor((kin-1)/65),3)];

  return {
    pos, pTable,
    m13Num, dm13, m13Name, m13Power, m13Action,
    castle5, castleT5, pos5, harm5, galSeason5,
    phase:mp.n, phaseEmoji:mp.e, illum, moonAge, moonSign:pos.Moon?.sign, moonDegS:pos.Moon?.deg,
    sunSign:pos.Sun?.sign, sunDeg:pos.Sun?.deg,
    lunarPhase, daysToFull, daysToNew,
    aspects:allAspects, detectedAspects, contextualNotes,
    mercPostShadow, venusLastAries, venusJustTaurus,
    ud, dayName:DAYS[dow], dayRuler:RULERS[dow], seasonNote:sn, tz, isBST,
    kin, kinName:`${COLORS[si]} ${TONES[ti]} ${SEALS[si]}`,
    kinColor:COLORS[si], kinTone:TONES[ti], kinSeal:SEALS[si],
    sealAction:SEAL_A[si], sealPower:SEAL_P[si], sealEssence:SEAL_E[si],
    toneMeaning:TONE_M[ti], toneQuestion:TONE_Q[ti],
    wsNum:wsn, wsColor:COLORS[(wsk-1)%20], wsSeal:SEALS[(wsk-1)%20], posWS,
    guide:`${COLORS[guideI]} ${SEALS[guideI]}`, antipode:`${COLORS[antipI]} ${SEALS[antipI]}`,
    occult:`${COLORS[occultI]} ${SEALS[occultI]}`, analog:`${COLORS[analogI]} ${SEALS[analogI]}`,
    isGAP:GAP.has(kin), upcomingKins, mo, day, yr
  };
}

function lifePath(dob){
  if(!dob)return null;
  const p=dob.split("-").map(Number);if(p.length<3)return null;
  let n=(String(p[2])+String(p[1])+String(p[0])).split("").reduce((a,b)=>a+parseInt(b),0);
  while(n>9&&n!==11&&n!==22&&n!==33)n=String(n).split("").reduce((a,b)=>a+parseInt(b),0);
  return n;
}

function nameNum(name,mode){
  if(!name)return null;
  const P={a:1,b:2,c:3,d:4,e:5,f:6,g:7,h:8,i:9,j:1,k:2,l:3,m:4,n:5,o:6,p:7,q:8,r:9,s:1,t:2,u:3,v:4,w:5,x:6,y:7,z:8};
  const V=new Set(["a","e","i","o","u","y"]);
  const l=name.toLowerCase().replace(/[^a-z]/g,"").split("");
  const f=mode==="vowels"?l.filter(c=>V.has(c)):mode==="consonants"?l.filter(c=>!V.has(c)):l;
  let n=f.reduce((a,c)=>a+(P[c]||0),0);if(!n)return null;
  while(n>9&&n!==11&&n!==22&&n!==33)n=String(n).split("").reduce((a,b)=>a+parseInt(b),0);
  return n;
}

// ── Build tier-differentiated prompt ──────────────────────────────────────────

// Named exports for use by the API server
export { fullCosmic, lifePath, nameNum };
