/* ============================================================
   Live ranking engine. No DOM here, so it can be tested in Node.

   Data comes from ESPN's public tennis feeds (free, no key, unofficial):
     rankings : sports.core.api.espn.com/v2/sports/tennis/leagues/{atp|wta}/rankings
     scores   : site.api.espn.com/apis/site/v2/sports/tennis/{atp|wta}/scoreboard
   Live points = official points
                 − points from last year's edition of each event being played
                 + points secured at this year's edition.
   ============================================================ */
const Engine=(()=>{
  const CORE=t=>`https://sports.core.api.espn.com/v2/sports/tennis/leagues/${t}`;
  const BOARD=(t,dates)=>`https://site.api.espn.com/apis/site/v2/sports/tennis/${t}/scoreboard${dates?"?dates="+dates:""}`;
  const https=u=>u.replace(/^http:\/\//,"https://");

  /* ---------- points tables: index = depth (0 champion, 1 finalist, 2 SF, 3 QF, 4 R16, 5 R32, 6 R64, 7 R128/R96) ---------- */
  const LEVELS={
    atp:{slam:{label:"Grand Slam",pts:[2000,1300,800,400,200,100,50,10],entry:10},
         1000:{label:"Masters 1000",pts:[1000,650,400,200,100,50,30,10],entry:10},
         500:{label:"ATP 500",pts:[500,330,200,100,50,25,0,0],entry:0},
         250:{label:"ATP 250",pts:[250,150,90,45,20,10,0,0],entry:0}},
    wta:{slam:{label:"Grand Slam",pts:[2000,1300,780,430,240,130,70,10],entry:10},
         1000:{label:"WTA 1000",pts:[1000,650,390,215,120,65,35,10],entry:10},
         500:{label:"WTA 500",pts:[500,325,195,108,60,1,0,0],entry:1},
         250:{label:"WTA 250",pts:[250,163,98,54,30,1,0,0],entry:1},
         125:{label:"WTA 125",pts:[125,81,49,27,15,1,0,0],entry:1}}
  };
  const RX={
    slam:/australian open|roland garros|french open|wimbledon|\bus open\b/i,
    atp1000:/indian wells|bnp paribas open|miami open|monte[- ]?carlo|madrid|italian open|internazionali|rome|canadian open|national bank open|rogers cup|cincinnati|western & southern|shanghai|paris masters|rolex paris/i,
    wta1000:/indian wells|bnp paribas open|miami open|madrid|italian open|internazionali|rome|canadian open|national bank open|cincinnati|western & southern|dubai|doha|qatar|china open|beijing|wuhan/i,
    atp500:/rotterdam|abn amro|rio open|dubai|acapulco|abierto mexicano|barcelona|godo|hamburg|halle|terra wortmann|queen|cinch|hsbc|washington|citi open|china open|beijing|japan open|tokyo|basel|swiss indoors|vienna|erste bank/i,
    wta125:/rovereto|lisboa|belem|tolentino|porto|ankara|jingshan|adana|samsun|suzhou|midland|puerto vallarta|angers|cali|montevideo|bogota/i,
    wta500:/brisbane|adelaide|abu dhabi|linz|charleston|credit one|stuttgart|porsche|berlin|bad homburg|eastbourne|rothesay|san diego|tokyo|toray|ningbo|guadalajara|seoul|strasbourg|monterrey|merida|washington|citi open|queen|hsbc/i
  };
  function guessLevel(tour,e){
    if(e.major||RX.slam.test(e.name))return{level:"slam",sure:true};
    if(RX[tour+"1000"].test(e.name))return{level:1000,sure:true};
    if(RX[tour+"500"].test(e.name))return{level:500,sure:false};
    if(tour==="wta"&&RX.wta125.test(e.name))return{level:125,sure:false};
    return{level:250,sure:false};
  }
  const table=(tour,level)=>LEVELS[tour][level]||LEVELS[tour][250];
  const ptsLose=(tour,level,depth,first)=>{const t=table(tour,level);return first?t.entry:(t.pts[depth]??0)};
  const ptsWin=(tour,level,depth)=>depth===1?table(tour,level).pts[0]:table(tour,level).pts[depth-1];

  /* ---------- tournament levels from Wikipedia's season calendar (free, CC BY-SA) ---------- */
  const WIKI=p=>`https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(p)}&prop=wikitext&format=json&origin=*`;
  const CATMAP={"Grand Slam":"slam","ATP 1000":1000,"WTA 1000":1000,"ATP 500":500,"WTA 500":500,"ATP 250":250,"WTA 250":250};
  const STOP=new Set("open tennis championships championship international presented by the of women womens mens men masters grand prix atp wta classic trophy group san las new los del des and von van club ladies".split(" "));
  const norm=s=>s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
  const toks=s=>norm(s).replace(/<[^>]*>/g," ").replace(/\[\[|\]\]|'s\b/g," ").split(/[^a-z]+/).filter(t=>t.length>=3&&!STOP.has(t));
  const cpl=(a,b)=>{let i=0;while(i<a.length&&i<b.length&&a[i]===b[i])i++;return i};
  const tokMatch=(a,b)=>a===b||(a.length>=5&&b.length>=5&&cpl(a,b)>=5&&cpl(a,b)>=0.8*Math.min(a.length,b.length));
  function parseCalendar(wikitext,defaultCat){
    // Anchor on each "category" (or, on the WTA 125 page, each surface/prize line), then look back for the event link.
    const out=[],links=[];
    const lre=/\[\[(20\d\d [^\]|]+)(?:\|([^\]]*))?\]\]/g;let m;
    while((m=lre.exec(wikitext)))links.push({i:m.index,end:m.index+m[0].length,page:m[1],display:m[2]||m[1]});
    const are=defaultCat
      ?/<br\s*\/?>\s*(?:Hard|Clay|Grass|Carpet)[^<\n]*?(\d+)\s*S\//g
      :/<br\s*\/?>\s*(Grand Slam|ATP 1000|WTA 1000|ATP 500|WTA 500|ATP 250|WTA 250)\s*<br\s*\/?>([^<]*)/g;
    while((m=are.exec(wikitext))){
      let k=links.length-1;while(k>=0&&links[k].i>m.index)k--;
      const l=links[k];if(!l||m.index-l.end>400)continue;
      const between=wikitext.slice(l.end,m.index),cm=/\[\[([^\]|]+)/.exec(between);
      const level=defaultCat?defaultCat:CATMAP[m[1]];
      const dm=defaultCat?{1:m[1]}:/(\d+)\s*S\//.exec(m[2]||"");
      out.push({page:l.page,display:l.display,city:cm?cm[1]:"",level,draw:dm?+dm[1]:null});
    }
    return out;
  }
  async function fetchCalendar(tour,year,cache){
    const key=`cal1:${tour}:${year}`;
    try{const c=JSON.parse(cache.getItem(key)||"null");if(c&&Date.now()-c.t<864e5)return c.v}catch(e){}
    const pages=tour==="atp"?[[`${year}_ATP_Tour`,null]]:[[`${year}_WTA_Tour`,null],[`${year}_WTA_125_tournaments`,125]];
    let rows=[];
    for(const[p,def]of pages){
      try{const d=await getJSON(WIKI(p),2);rows=rows.concat(parseCalendar(d.parse.wikitext["*"],def))}catch(e){}
    }
    if(rows.length)try{cache.setItem(key,JSON.stringify({t:Date.now(),v:rows}))}catch(e){}
    return rows;
  }
  function levelFromCalendar(rows,e){
    if(!rows||!rows.length)return null;
    const rts=rows.map(r=>toks(r.page.replace(/^\d{4} /,"")+" "+r.display+" "+r.city));
    const et=new Set(toks(e.name));let best=null,bs=0;
    rows.forEach((r,i)=>{
      let sc=0;
      et.forEach(a=>{
        if(!rts[i].some(b=>tokMatch(a,b)))return;
        const df=rts.filter(rt=>rt.some(b=>tokMatch(a,b))).length; // generic words ("internazionali") appear in many rows
        sc+=Math.min(a.length,7)/df;
      });
      if(sc>bs){bs=sc;best=r}
    });
    return bs>=3?{level:best.level,sure:true,draw:best.draw,from:best.page}:null;
  }

  /* ---------- network ---------- */
  async function getJSON(url,tries=3){
    let err;
    for(let i=0;i<tries;i++){
      try{const r=await fetch(url);if(!r.ok)throw new Error("HTTP "+r.status);return await r.json()}
      catch(e){err=e;await new Promise(r=>setTimeout(r,400*(i+1)))}
    }
    throw err;
  }
  const idOf=ref=>ref.split("/athletes/")[1].split("?")[0];

  /* ---------- official rankings ---------- */
  async function fetchRankings(tour){
    const idx=await getJSON(CORE(tour)+"/rankings");
    const url=https(idx.items[0].$ref),cur=await getJSON(url);
    const mapOf=r=>{const m={};r.ranks.forEach(x=>m[idOf(x.athlete.$ref)]={id:idOf(x.athlete.$ref),rank:x.current,prev:x.previous,points:x.points});return m};
    const week=cur.occurrence.number;
    // ESPN's "week N" is the Nth Monday of the year, which is the date the ranking took effect
    const yr=cur.season.year,jan1=new Date(Date.UTC(yr,0,1)),fm=new Date(jan1.getTime()+((8-jan1.getUTCDay())%7)*864e5);
    const effective=new Date(fm.getTime()+(week-1)*7*864e5).toISOString().slice(0,10);
    let prevMap={};
    for(let k=1;k<=3&&!Object.keys(prevMap).length;k++){
      try{prevMap=mapOf(await getJSON(url.replace(`/weeks/${week}/`,`/weeks/${week-k}/`),1))}catch(e){}
    }
    return{week,effective,headline:cur.headline,updated:cur.lastUpdated,map:mapOf(cur),list:cur.ranks.map(x=>({id:idOf(x.athlete.$ref),rank:x.current,prev:x.previous,points:x.points})),prevMap};
  }
  /* Player details come from a bundle in the repo (data/athletes.json, refreshed by the scheduled job)
     and only fall back to ESPN for anyone not in it yet. Age is always worked out from the birth date. */
  const FLAG=code=>`https://a.espncdn.com/i/teamlogos/countries/500/${code}.png`;
  const ageFrom=dob=>{
    if(!dob)return undefined;const d=new Date(dob),n=new Date();if(isNaN(d))return undefined;
    let a=n.getUTCFullYear()-d.getUTCFullYear();
    if(n.getUTCMonth()<d.getUTCMonth()||(n.getUTCMonth()===d.getUTCMonth()&&n.getUTCDate()<d.getUTCDate()))a--;
    return a;
  };
  let _bundle=null;
  async function loadBundle(){
    if(_bundle)return _bundle;
    try{_bundle=await getJSON("data/athletes.json?"+Math.floor(Date.now()/36e5),1)}catch(e){_bundle={}}
    return _bundle;
  }
  const fromBundle=(id,b)=>{const x=b[id];if(!x)return null;
    return{id,name:x.n,age:ageFrom(x.b),dob:x.b,flag:x.f?FLAG(x.f):undefined,country:x.c,hand:x.h,heightIn:x.ht,debutYear:x.d,birthPlace:x.p}};
  function fromEspn(id,a){
    const bp=a.birthPlace||{},dob=(a.dateOfBirth||"").slice(0,10);
    return{id,name:a.displayName||a.fullName,dob,age:ageFrom(dob)??a.age,flag:a.flag&&a.flag.href,country:a.flag&&a.flag.alt,
      hand:a.hand&&a.hand.displayValue,heightIn:a.height,debutYear:a.debutYear,birthPlace:[bp.city,bp.country].filter(Boolean).join(", ")};
  }
  async function fetchAthlete(id,cache){
    const k="ath2:"+id;
    try{const c=JSON.parse(cache.getItem(k)||"null");if(c&&Date.now()-c.t<30*864e5)return{...c.v,age:ageFrom(c.v.dob)??c.v.age}}catch(e){}
    const v=fromEspn(id,await getJSON(`https://sports.core.api.espn.com/v2/sports/tennis/athletes/${id}?lang=en&region=us`,2));
    try{cache.setItem(k,JSON.stringify({t:Date.now(),v}))}catch(e){}
    return v;
  }
  async function fetchAthleteDetail(id){
    const b=await loadBundle(),x=fromBundle(id,b);
    if(x)return x;
    return fromEspn(id,await getJSON(`https://sports.core.api.espn.com/v2/sports/tennis/athletes/${id}?lang=en&region=us`,2));
  }
  async function fetchAthletes(ids,cache,onProgress,pool=10){
    const bundle=await loadBundle(),out={};let done=0;
    const rest=[];
    ids.forEach(id=>{const x=fromBundle(id,bundle);if(x){out[id]=x;onProgress&&onProgress(++done,ids.length)}else rest.push(id)});
    let i=0;
    async function worker(){while(i<rest.length){const id=rest[i++];try{out[id]=await fetchAthlete(id,cache)}catch(e){out[id]={id,name:"Player "+id}}onProgress&&onProgress(++done,ids.length)}}
    await Promise.all(Array.from({length:Math.min(pool,rest.length)},worker));
    return out;
  }

  /* ---------- scoreboard parsing ---------- */
  function parseEvent(e,tour){
    const slug=tour==="atp"?"mens-singles":"womens-singles";
    const g=(e.groupings||[]).find(x=>x.grouping&&x.grouping.slug===slug);if(!g)return null;
    const comps=g.competitions.filter(c=>c.round&&!/qualif/i.test(c.round.displayName));
    if(!comps.length)return null;
    let N=0;comps.forEach(c=>{const m=/^Round (\d+)/.exec(c.round.displayName);if(m)N=Math.max(N,+m[1])});
    const depthOf=n=>{if(n==="Final")return 1;if(n==="Semifinal")return 2;if(n==="Quarterfinal")return 3;const m=/^Round (\d+)/.exec(n);return m?3+(N-(+m[1])+1):null};
    const per={};let champion=null,finalist=null,complete=false,live=0;
    comps.forEach(c=>{
      const d=depthOf(c.round.displayName);if(d==null)return;
      const state=c.status.type.state,first=/^Round 1$/.test(c.round.displayName);
      if(state==="in")live++;
      const cs=(c.competitors||[]).filter(x=>x.athlete||x.id);
      cs.forEach(x=>{
        const opp=cs.find(y=>y!==x);
        const m={d,first,state,won:!!x.winner,round:c.round.displayName,
          sets:(x.linescores||[]).map(l=>l.value),oppSets:opp?(opp.linescores||[]).map(l=>l.value):[],
          opp:opp&&opp.athlete?opp.athlete.displayName:null,oppId:opp?opp.id:null,court:c.venue&&c.venue.court,start:c.startDate||c.date||null,timed:c.timeValid!==false};
        const cur=per[x.id];if(!cur||m.d<cur.d)per[x.id]=m;
      });
      if(d===1&&state==="post"){complete=true;const w=cs.find(x=>x.winner),l=cs.find(x=>!x.winner);if(w)champion=w.id;if(l)finalist=l.id}
    });
    return{id:e.id,tid:e.id.split("-")[0],year:+e.id.split("-")[1],name:e.name,major:!!e.major,start:e.date,end:e.endDate,per,N,champion,finalist,complete,live};
  }
  function pointsFor(tour,level,m){
    if(!m)return 0;
    if(m.state==="post"){
      if(m.won)return ptsWin(tour,level,m.d);
      return ptsLose(tour,level,m.d,m.first);
    }
    return ptsLose(tour,level,m.d,m.first);
  }
  const statusOf=m=>!m?null:m.state==="in"?"live":m.state==="pre"?"next":m.won?(m.d===1?"champ":"adv"):"out";

  /* ---------- event discovery ---------- */
  const fmtD=d=>d.toISOString().slice(0,10).replace(/-/g,"");
  const shift=(d,days)=>new Date(d.getTime()+days*864e5);
  async function fetchEvents(tour,now=new Date(),days=14){
    const d=await getJSON(BOARD(tour,`${fmtD(shift(now,-days))}-${fmtD(now)}`));
    return(d.events||[]).map(e=>parseEvent(e,tour)).filter(Boolean);
  }
  async function fetchToday(tour){
    const d=await getJSON(BOARD(tour));
    return(d.events||[]).map(e=>parseEvent(e,tour)).filter(Boolean);
  }
  /* last year's result per player at the same tournament, stored as compact codes */
  async function fetchLastYear(tour,events,cache,now=new Date(),days=14){
    const need=events.filter(e=>{try{return !cache.getItem("ly1:"+tour+":"+e.tid+"-"+(e.year-1))}catch(x){return true}});
    if(need.length){
      let d=null;
      try{d=await getJSON(BOARD(tour,`${fmtD(shift(now,-days-371))}-${fmtD(shift(now,-343))}`))}catch(e){}
      if(d){
        const byId={};(d.events||[]).forEach(ev=>byId[ev.id]=ev);
        need.forEach(e=>{
          const ev=byId[e.tid+"-"+(e.year-1)],p=ev&&parseEvent(ev,tour),codes={};
          if(p)Object.entries(p.per).forEach(([id,m])=>{
            codes[id]=m.state!=="post"?[m.d,m.first?1:0,0]:m.won?[m.d,0,1]:[m.d,m.first?1:0,0]});
          // an event with no prior edition (new tournament) simply defends nothing
          try{cache.setItem("ly1:"+tour+":"+e.tid+"-"+(e.year-1),JSON.stringify(codes))}catch(x){}
          e._ly=codes;
        });
      }
    }
    events.forEach(e=>{if(!e._ly){try{const c=cache.getItem("ly1:"+tour+":"+e.tid+"-"+(e.year-1));e._ly=c?JSON.parse(c):null}catch(x){e._ly=null}}});
  }
  const lyPoints=(tour,level,code)=>!code?0:code[2]?ptsWin(tour,level,code[0]):ptsLose(tour,level,code[0],!!code[1]);

  /* ---------- are an event's points already in the official ranking? ---------- */
  function inferCounted(tour,e,level,rk){
    // Compare each player's actual week-over-week points change with what this event
    // should have added. Only gains (expected >= 60) vote; the champion counts double.
    if(!e.complete)return false;
    let yes=0,no=0;
    Object.entries(e.per).forEach(([id,m])=>{
      const c=rk.map[id],p=rk.prevMap[id];if(!c||!p)return;
      const exp=pointsFor(tour,level,m)-lyPoints(tour,level,e._ly&&e._ly[id]);
      if(exp<60)return;
      const obs=c.points-p.points,w=id===e.champion?2:1;
      Math.abs(obs-exp)<Math.abs(obs)?yes+=w:no+=w;
    });
    return yes+no===0?true:yes>=no;
  }

  /* ---------- live table ---------- */
  function computeLive(tour,rk,events,cfg){
    // cfg[eventId] = {level, counted}
    const applied=events.filter(e=>!cfg[e.id].counted);
    const rows=rk.list.map(r=>{
      let earned=0,def=0,best=null,defKnown=true;
      applied.forEach(e=>{
        const lvl=cfg[e.id].level,m=e.per[r.id];
        if(!e._ly)defKnown=false;
        def+=lyPoints(tour,lvl,e._ly&&e._ly[r.id]);
        if(m){const pts=pointsFor(tour,lvl,m);earned+=pts;
          const st=statusOf(m),pri={live:4,next:3,adv:2,champ:2,out:1}[st];
          if(!best||pri>=best.pri)best={e,m,st,pri,pts,lvl}}
      });
      return{p:r,earned,def,defKnown,best,live:r.points-def+earned};
    });
    rows.sort((a,b)=>b.live-a.live||a.p.rank-b.p.rank);
    // players level on points share a rank (shown as "T41"); the tours' own tiebreak needs data the free feeds don't have
    for(let i=0;i<rows.length;){
      let j=i;while(j+1<rows.length&&rows[j+1].live===rows[i].live)j++;
      for(let k=i;k<=j;k++){rows[k].rank=i+1;rows[k].tied=j>i}
      i=j+1;
    }
    rows.forEach(r=>{r.move=r.p.rank-r.rank;r.diff=r.live-r.p.points});
    const projRank=(row,v)=>1+rows.filter(o=>o!==row&&o.live>v).length;
    return{rows,applied,projRank};
  }
  function ifResults(tour,row){
    const b=row.best;if(!b||b.st==="out"||b.st==="champ"||b.st==="adv")return null;
    const base=row.live-b.pts;
    return{win:base+ptsWin(tour,b.lvl,b.m.d),lose:base+ptsLose(tour,b.lvl,b.m.d,b.m.first)};
  }
  return{LEVELS,table,guessLevel,lyPoints,fetchAthleteDetail,fetchCalendar,levelFromCalendar,parseCalendar,getJSON,fetchRankings,fetchAthletes,fetchEvents,fetchToday,fetchLastYear,inferCounted,computeLive,ifResults,parseEvent,pointsFor,statusOf};
})();
if(typeof module!=="undefined")module.exports=Engine;
