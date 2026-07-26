/* ============ STATE ============ */
let files = [];  // entries: {file,name,size,images:[b64]|null,compBytes,status,msg}
let lastRows = [], lastTotals = {};
let lastLabor = {rows:[], phases:[], totHrs:0, totLaborCost:0, projWorkDays:0};

/* ============ UPLOAD HANDLING ============ */
const drop = document.getElementById('drop');
const fileinput = document.getElementById('fileinput');
drop.onclick = () => fileinput.click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('hover'); };
drop.ondragleave = () => drop.classList.remove('hover');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('hover'); addFiles(e.dataTransfer.files); };
fileinput.onchange = e => addFiles(e.target.files);

function addFiles(list){
  try{
    const arr=Array.from(list||[]);
    if(!arr.length) return;
    for(const f of arr){
      const entry={file:f,name:f.name,size:f.size,images:null,compBytes:0,status:'pending',msg:''};
      files.push(entry);
      compressEntry(entry).then(renderFiles).catch(err=>{
        entry.status='error'; entry.msg=(err&&err.message)||'could not prepare file'; renderFiles();
      });
    }
    renderFiles();  // show the file immediately, before compression finishes
  }catch(err){ showBanner('Could not add that file: '+((err&&err.message)||err)); }
}
function showBanner(text){
  const el=document.getElementById('err-banner');
  if(el){ el.textContent=text; el.classList.remove('hidden'); }
  else { alert(text); }
}

// Compress on upload: render PDF pages / images to downscaled JPEGs so the
// payload is well under the 4 MB request limit before analysis ever runs.
async function compressEntry(entry){
  try{
    const f=entry.file;
    let imgs=[];
    if(f.type==='application/pdf') imgs=await pdfToImages(f);
    else if(f.type.startsWith('image/')) imgs=[await imageToScaled(f)];
    else { entry.status='error'; entry.msg='unsupported type (use PDF/PNG/JPG)'; return; }
    entry.images=imgs;
    entry.compBytes=imgs.reduce((s,b)=>s+Math.ceil(b.length*0.75),0); // base64 → bytes
    entry.status='done';
  }catch(e){ entry.status='error'; entry.msg=(e&&e.message)||'could not compress'; }
}

function renderFiles(){
  const el = document.getElementById('filelist');
  el.innerHTML = files.map((e,i)=>{
    const mb = (e.size/1048576).toFixed(1);
    let tail;
    if(e.status==='pending') tail = `<span style="color:#928f86">(${mb} MB · compressing…)</span>`;
    else if(e.status==='error') tail = `<span style="color:#b5340b">(${mb} MB · ${e.msg})</span>`;
    else { const pages=(e.images||[]).length; const c=(e.compBytes/1048576).toFixed(1);
           tail = `<span style="color:#0F7A5A">(${mb} MB → ${c} MB · ${pages} page${pages===1?'':'s'} ready ✓)</span>`; }
    return `<div class="fileitem">📄 ${e.name} ${tail}<button class="rm" onclick="removeFile(${i})">×</button></div>`;
  }).join('');
  const anyReady = files.some(e=>e.status==='done');
  const btn=document.getElementById('analyze-btn');
  if(btn) btn.disabled = !anyReady;
}
function removeFile(i){ files.splice(i,1); renderFiles(); }

function fileToBase64(file){
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>res(r.result.split(',')[1]);
    r.onerror=rej; r.readAsDataURL(file);
  });
}

/* ============ AI PLAN ANALYSIS ============ */
/* NOTE: the AI plan-reading step calls the Anthropic API. That call only
   succeeds in an environment that provides credentials/proxying (e.g. running
   inside Claude, or behind your own backend that injects an API key). When the
   call is unavailable the app cleanly falls back to manual entry, and the full
   takeoff + labor/schedule engine still works. See README for hosting notes. */
/* When deployed to Netlify with the analyze function, calls go through the
   backend proxy (which holds the API key). Large PDFs are rendered to downscaled
   JPEGs in the browser and sent in batches that stay under the request limit, so
   you can upload big plan sets without the "file too large" error. */
const PROXY_URL='/.netlify/functions/analyze';
const PROXY_ALTS=['/.netlify/functions/analyze','/api/analyze','/.netlify/functions/analyze/'];
async function postProxy(payload){
  let last=null;
  for(const url of PROXY_ALTS){
    try{
      const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(r.status===404){ last={status:404,url}; continue; }   // try the next path
      return r;
    }catch(e){ last={err:e,url}; }
  }
  const e=new Error(last&&last.status===404
    ? 'could not reach the analyze function at any known path'
    : ('network error contacting the server'+(last&&last.err?': '+last.err.message:'')));
  e.allFailed=true; throw e;
}
const MAX_DIM=1300;        // px — longest side of each rendered page
const JPEG_Q=0.62;         // page image quality
const BATCH_BUDGET=3.2e6;  // ~3.2 MB of base64 per request (safely under Netlify's 6 MB)

let _pdfjs=null;
function loadScript(src){
  return new Promise((res,rej)=>{
    const el=document.createElement('script');
    el.src=src;
    el.onload=()=>res();
    el.onerror=()=>{ el.remove(); rej(new Error('failed: '+src)); };  // remove failed tag
    document.head.appendChild(el);
  });
}
function ensurePdfJs(){
  if(_pdfjs) return _pdfjs;
  _pdfjs=(async()=>{
    if(window.pdfjsLib) return window.pdfjsLib;
    const CDN_LIB='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    const CDN_WORKER='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    // main library: local copy first, CDN if it isn't there
    try{ await loadScript('vendor/pdf.min.js'); }
    catch(e){ await loadScript(CDN_LIB); }
    if(!window.pdfjsLib) throw new Error('PDF library did not load');
    // worker: never assume the local file exists - probe it, else use the CDN
    let worker=CDN_WORKER;
    try{
      const r=await fetch('vendor/pdf.worker.min.js',{method:'HEAD'});
      if(r.ok) worker='vendor/pdf.worker.min.js';
    }catch(e){ /* keep CDN */ }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc=worker;
    return window.pdfjsLib;
  })();
  return _pdfjs;
}

// Render each PDF page to a downscaled JPEG (base64). Shrinks an 18 MB plan set
// to a few hundred KB per page, so size is no longer a barrier.
async function pdfToImages(file,onProg){
  const pdfjs=await ensurePdfJs();
  const buf=await file.arrayBuffer();
  const pdf=await pdfjs.getDocument({data:buf}).promise;
  const out=[];
  const MAXPAGES=40;
  const N=Math.min(pdf.numPages,MAXPAGES);
  for(let p=1;p<=N;p++){
    const page=await pdf.getPage(p);
    const base=page.getViewport({scale:1});
    const scale=Math.min(MAX_DIM/Math.max(base.width,base.height),2)||1;
    const vp=page.getViewport({scale});
    const canvas=document.createElement('canvas');
    canvas.width=Math.ceil(vp.width); canvas.height=Math.ceil(vp.height);
    await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
    out.push(canvas.toDataURL('image/jpeg',JPEG_Q).split(',')[1]);
    if(onProg) onProg(p,N);
  }
  return out;
}

// Downscale an uploaded image to keep the request small.
function imageToScaled(file){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      const scale=Math.min(MAX_DIM/Math.max(img.width,img.height),1)||1;
      const c=document.createElement('canvas');
      c.width=Math.ceil(img.width*scale); c.height=Math.ceil(img.height*scale);
      c.getContext('2d').drawImage(img,0,0,c.width,c.height);
      resolve(c.toDataURL('image/jpeg',JPEG_Q).split(',')[1]);
    };
    img.onerror=()=>reject(new Error('image decode failed'));
    img.src=URL.createObjectURL(file);
  });
}

// Send a batch of page-images for extraction: proxy first, direct fallback.
async function callExtractor(parts){
  // On the deployed site this goes through the Netlify function, which holds the key.
  let proxyErr=null;
  try{
    // Send BOTH shapes so any deployed version of the function works:
    //  - new function reads `parts`
    //  - older function reads `file` (we mirror the first page into it)
    const first=parts&&parts[0];
    const payload={parts,prompt:EXTRACTION_PROMPT};
    if(first) payload.file={kind:'image',media_type:first.media_type||'image/jpeg',data:first.data};
    const r=await postProxy(payload);
    if(r.ok){
      const d=await r.json();
      if(d&&typeof d.text==='string') return d.text;
      proxyErr='the server returned no text';
    }else if(r.status===404){
      proxyErr=null;                       // no function deployed -> try a direct call
    }else if(r.status===502||r.status===504){
      proxyErr='the analysis timed out on the server';
    }else{
      let msg=''; try{ const e=await r.json(); msg=(e&&e.error)||''; }catch(_){}
      proxyErr=msg||('server error '+r.status);
    }
  }catch(e){ proxyErr=(e&&e.message)?('network error: '+e.message):null; }
  if(proxyErr) throw new Error(proxyErr);

  const content=parts.map(p=>({type:'image',source:{type:'base64',media_type:p.media_type,data:p.data}}));
  content.push({type:'text',text:EXTRACTION_PROMPT});
  const r2=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1000,messages:[{role:'user',content}]})});
  if(!r2.ok){
    let m=''; try{ const e=await r2.json(); m=(e&&e.error&&e.error.message)||''; }catch(_){}
    throw new Error(m||('API '+r2.status+' - no backend function found. Deploy to Netlify with ANTHROPIC_API_KEY set.'));
  }
  const d2=await r2.json();
  return (d2.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
}

// Convert a file to downscaled images, batch under the size budget, extract each.
// Returns an array of parsed objects (merged later across all files).
async function extractFromImages(imgs,onProg){
  const parsed=[]; const errs=[];
  for(let i=0;i<imgs.length;i++){
    if(onProg) onProg(i+1,imgs.length);
    let t=null;
    for(let attempt=0;attempt<2 && t===null;attempt++){
      try{ t=await callExtractor([{media_type:'image/jpeg',data:imgs[i]}]); }  // one page per request
      catch(e){
        const m=(e&&e.message)||String(e);
        if(attempt===0 && /too long|timed out|502|504/i.test(m)) continue; // one retry on timeout
        errs.push(m); break;
      }
    }
    if(t!==null){ const j=parseJSON(t); if(j) parsed.push(j); }
  }
  if(!parsed.length && errs.length) throw new Error(errs[0]);
  return parsed;
}


async function analyzePlans(){
  show('analyzing'); hide('step-1');
  clearMetrics(); // never let a previous project's / example values carry into a new upload
  const msg=document.getElementById('analyze-msg');
  const sub=document.getElementById('analyze-sub');
  const results=[]; let lastErr='';
  try{
    // Files were already compressed to page-images on upload; analyze each,
    // then merge. Schedule sheets, cover sheets and floor plans often live in
    // different files, so per-file extraction + merge is the most reliable.
    let done=0;
    for(let i=0;i<files.length;i++){
      const entry=files[i];
      if(entry.status!=='done' || !entry.images || !entry.images.length) continue;
      done++;
      if(msg) msg.textContent=`Reading file ${i+1} of ${files.length}…`;
      if(sub) sub.textContent=entry.name+' — scanning every page & schedule';
      try{
        const arr=await extractFromImages(entry.images,function(pg,n){
          if(sub) sub.textContent=entry.name+' - reading page '+pg+' of '+n;
        });
        arr.forEach(x=>results.push(x));
      }catch(e){ lastErr=(e&&e.message)||String(e); }
    }
    if(!results.length) throw new Error(lastErr || 'no pages could be read');
    const {merged,missing}=mergeExtractions(results);
    fillMetrics(merged);
    showExtractNote(results.length, files.length, missing);
    hide('analyzing'); show('step-2'); setChip(2);
  }catch(err){
    hide('analyzing'); show('step-1');
    showBanner('Could not read the plans - ' + err.message);
    alert('Could not read the plans.\n\nReason: ' + err.message);
    manualEntry();
  }
}

/* Merge per-file extractions: counts take the MAX seen on any sheet (a schedule
   usually appears once), identifiers take the first non-empty, flags OR together.
   Anything still null after merging is reported to the user as "not found". */
function mergeExtractions(list){
  const numMax=['gfa','nsf','footprint','floors','units','perimeter','windows',
    'doorsEntry','doorsStair','doorsInterior','hvacCondensers','hvacIndoor','exhaustFans','elevators'];
  const firstStr=['projectName','dobJob','borough','worktype','constructionType','occupancy'];
  const flags=['cellar','court'];
  const m={};
  numMax.forEach(k=>{ let v=null; list.forEach(o=>{ const x=o&&o[k];
    if(typeof x==='number'&&!Number.isNaN(x)) v=(v==null)?x:Math.max(v,x); }); m[k]=v; });
  firstStr.forEach(k=>{ let v=''; list.forEach(o=>{ if(!v&&o&&typeof o[k]==='string'&&o[k].trim()) v=o[k].trim(); }); m[k]=v||null; });
  flags.forEach(k=>{ let v=null; list.forEach(o=>{ const x=o&&o[k]; if(x===0||x===1) v=(v==null)?x:Math.max(v,x); }); m[k]=v; });
  let f2f=null; list.forEach(o=>{ if(f2f==null&&typeof (o&&o.f2f)==='number') f2f=o.f2f; }); m.f2f=f2f;
  const LBL={gfa:'Total GFA',nsf:'Net SF',footprint:'Footprint/floor',floors:'# Floors',
    units:'# Units',perimeter:'Perimeter',f2f:'Floor-to-floor',windows:'Windows',
    doorsEntry:'Entry doors',doorsStair:'Stair/fire doors',doorsInterior:'Interior doors',
    hvacCondensers:'HVAC condensers',hvacIndoor:'HVAC indoor units',exhaustFans:'Exhaust fans',elevators:'Elevators'};
  const missing=Object.keys(LBL).filter(k=>m[k]==null).map(k=>LBL[k]);
  return {merged:m, missing};
}

function showExtractNote(ok,total,missing){
  const el=document.getElementById('extract-note');
  if(!el) return;
  let h=`<span class="ai-badge">AI-extracted</span> &nbsp;Read <strong>${ok} of ${total}</strong> file(s), scanning every page and schedule. Review the values and correct anything off — purple fields were auto-filled; all are editable.`;
  if(missing&&missing.length){
    h+=`<br><br><strong style="color:#b5340b">Not found on the sheets provided:</strong> ${missing.join(', ')}.<br>Enter these manually below, or go back and also upload the specific schedule sheet that lists them (e.g. window/door schedule, MEP equipment schedule).`;
  }
  el.innerHTML=h;
}

const EXTRACTION_PROMPT = `You are a senior construction estimator reading approved NYC DOB building plans. Examine EVERY page of this file, including title-block text and especially any SCHEDULE TABLES — window schedule, door & hardware schedule, mechanical/HVAC equipment schedule, plumbing fixture schedule, and unit/occupancy matrix. When a schedule lists quantities, COUNT every row and SUM the quantity column (often "QTY", "NO.", or "#") to get the totals. Read carefully and do NOT guess: if a value genuinely does not appear anywhere in this file, return null for it — never invent a number.
Return a SINGLE compact JSON object with NO markdown, code fences, or prose. Use null for anything not found. Keys:
{"projectName":string|null,"dobJob":string|null,"borough":"Manhattan"|"Brooklyn"|"Queens"|"Bronx"|"Staten Island"|null,"gfa":number|null (total gross SF),"nsf":number|null (net residential/usable SF),"footprint":number|null (typical floor plate SF),"floors":number|null (stories above grade),"cellar":0|1|null,"units":number|null (dwelling units),"f2f":number|null (floor-to-floor ft),"perimeter":number|null (building perimeter LF),"worktype":"new"|"conversion"|"gut"|"partial"|null,"constructionType":"I-A"|"I-B"|"II-A"|"II-B"|"III-A"|"III-B"|"V"|null,"occupancy":"R-2"|"R-3"|"B"|"A"|"M"|"I"|null,"court":0|1|null (inner court / curtain wall present),"windows":number|null (total from window schedule),"doorsEntry":number|null (apartment/entry doors),"doorsStair":number|null (stair + fire-rated doors),"doorsInterior":number|null (interior doors),"hvacCondensers":number|null (outdoor/roof condensing units),"hvacIndoor":number|null (indoor air handlers/cassettes),"exhaustFans":number|null (kitchen + bath exhaust fans),"elevators":number|null}
JSON only.`;

function parseJSON(text){
  if(!text) return null;
  let t=text.replace(/```json/gi,'').replace(/```/g,'').trim();
  const a=t.indexOf('{'), b=t.lastIndexOf('}');
  if(a<0||b<0) return null;
  try{ return JSON.parse(t.slice(a,b+1)); }catch{ return null; }
}

const CTYPE_MAP={'I-A':1.15,'I-B':1.10,'II-A':1.0,'II-B':0.96,'III-A':0.93,'III-B':0.90,'V':0.85};
const OCC_MAP={'R-2':1.0,'R-3':0.88,'B':1.0,'A':1.25,'M':0.92,'I':1.42};
const BORO_MAP={'Manhattan':'1.0','Brooklyn':'0.92','Queens':'0.90','Bronx':'0.86','Staten Island':'0.84'};

function fillMetrics(p){
  const nb=v=>(typeof v==='number'&&!Number.isNaN(v))?v:''; // number, else blank
  setV('m-name',p.projectName||''); setV('m-job',p.dobJob||'');
  if(p.borough&&BORO_MAP[p.borough]) setSel('m-borough',BORO_MAP[p.borough]);
  setV('m-gfa',nb(p.gfa)); setV('m-nsf',nb(p.nsf!=null?p.nsf:p.gfa)); setV('m-footprint',nb(p.footprint));
  setV('m-floors',nb(p.floors)); setV('m-units',nb(p.units));
  setV('m-f2f',nb(p.f2f)); setV('m-perim',nb(p.perimeter));
  if(p.cellar===0||p.cellar===1) document.getElementById('m-cellar').value=String(p.cellar);
  if(p.worktype) document.getElementById('m-worktype').value=p.worktype;
  if(p.constructionType&&CTYPE_MAP[p.constructionType]) setSel('m-ctype',CTYPE_MAP[p.constructionType]);
  if(p.occupancy&&OCC_MAP[p.occupancy]) setSel('m-occ',OCC_MAP[p.occupancy]);
  if(p.court===0||p.court===1) document.getElementById('m-court').value=String(p.court);
  setV('m-windows',nb(p.windows)); setV('m-doors-entry',nb(p.doorsEntry));
  setV('m-doors-stair',nb(p.doorsStair)); setV('m-doors-int',nb(p.doorsInterior));
  setV('m-hvac-cu',nb(p.hvacCondensers)); setV('m-hvac-ah',nb(p.hvacIndoor));
  setV('m-exhaust',nb(p.exhaustFans)); setV('m-elev',nb(p.elevators));
  // reflect cross-derived areas into blank fields so they're visible & editable
  const gv=id=>+getV(id)||0;
  if(gv('m-gfa')<=0 && gv('m-footprint')>0 && gv('m-floors')>0) setV('m-gfa',Math.round(gv('m-footprint')*gv('m-floors')));
  if(gv('m-footprint')<=0 && gv('m-gfa')>0 && gv('m-floors')>0) setV('m-footprint',Math.round(gv('m-gfa')/gv('m-floors')));
  if(gv('m-nsf')<=0 && gv('m-gfa')>0) setV('m-nsf',Math.round(gv('m-gfa')*0.78));
}

function clearMetrics(){
  ['m-name','m-job','m-gfa','m-nsf','m-footprint','m-floors','m-units','m-f2f','m-perim',
   'm-windows','m-doors-entry','m-doors-stair','m-doors-int','m-hvac-cu','m-hvac-ah','m-exhaust','m-elev']
   .forEach(id=>setV(id,''));
}

function manualEntry(){
  clearMetrics(); // blank fields for the user's own building (not a prior/example project)
  const el=document.getElementById('extract-note');
  if(el) el.innerHTML='<span class="ai-badge">Manual</span> &nbsp;Enter your building\u2019s values below, then run the takeoff. Tip: use \u201cLoad 124 Washington example\u201d on the upload screen if you just want a sample.';
  document.querySelectorAll('#step-2 .field.ai').forEach(f=>f.classList.remove('ai'));
  hide('step-1'); hide('analyzing'); show('step-2'); setChip(2);
}

/* One-click load of the known, verified 124 Washington Avenue values, so the
   verify page is fully populated even when plan-reading can't run (e.g. large
   PDFs in a sandboxed preview). Replace by uploading and analyzing real plans. */
function loadExample(){
  const ex={projectName:'124 Washington Ave, Brooklyn',dobJob:'B01108308',borough:'Brooklyn',
    gfa:24088,nsf:18596,footprint:4649,floors:4,cellar:1,units:15,f2f:11.5,perimeter:260,
    worktype:'conversion',constructionType:'III-A',occupancy:'R-2',court:1,
    windows:50,doorsEntry:17,doorsStair:26,doorsInterior:45,
    hvacCondensers:18,hvacIndoor:57,exhaustFans:41,elevators:1};
  fillMetrics(ex);
  const el=document.getElementById('extract-note');
  if(el) el.innerHTML='<span class="ai-badge">Example</span> &nbsp;Loaded the known <strong>124 Washington Avenue</strong> values. Every field is editable — adjust anything, then run the takeoff. To use your own building, go back and upload &amp; analyze its plans.';
  hide('step-1'); hide('analyzing'); show('step-2'); setChip(2);
}

/* ============ LABOR / SCHEDULE REFERENCE DATA ============ */
/* Loaded NYC labor rates ($/hr, incl. burden) by trade — representative 2025-26.
   Editable in the UI (Trade wage table) and scaled by the labor-rate multiplier. */
const TRADE_RATE={
  laborer:75, operator:130, concrete:90, ironworker:115, carpenter:95, mason:98,
  roofer:85, glazier:100, insulation:80, drywall:88, tile:92, flooring:82,
  painter:78, millwork:95, plumber:122, sprinkler:115, hvac:115, electrician:120,
  elevator:145, abatement:95
};
const TRADE_DEFAULTS=Object.assign({},TRADE_RATE);
const TRADE_LABEL={laborer:'Laborer',operator:'Equip. operator',concrete:'Concrete',ironworker:'Ironworker',
  carpenter:'Carpenter',mason:'Mason',roofer:'Roofer',glazier:'Glazier',insulation:'Insulation',
  drywall:'Drywall/taper',tile:'Tile setter',flooring:'Flooring',painter:'Painter',millwork:'Millwork',
  plumber:'Plumber',sprinkler:'Sprinkler fitter',hvac:'HVAC/sheet metal',electrician:'Electrician',
  elevator:'Elevator mechanic',abatement:'Abatement'};

function setWage(trade,val){
  const v=parseFloat(val);
  if(!Number.isNaN(v) && v>=0) TRADE_RATE[trade]=v;
  recalc();
}
function resetWages(){
  Object.keys(TRADE_DEFAULTS).forEach(k=>TRADE_RATE[k]=TRADE_DEFAULTS[k]);
  renderWages(); recalc();
}
function renderWages(){
  const el=document.getElementById('wage-body'); if(!el) return;
  el.innerHTML=Object.keys(TRADE_RATE).map(k=>
    `<tr><td>${TRADE_LABEL[k]||k}</td><td class="num">
      <input class="cell" type="number" step="any" value="${TRADE_RATE[k]}" oninput="setWage('${k}',this.value)">
    </td><td class="basis">$/hr loaded (incl. burden)</td></tr>`).join('');
}

/* Per-division crew size & construction phase for scheduling.
   Key = division code (text before the "·"). */
const DIV_SCHED={
  '00':{crew:6,phase:1}, '00b':{crew:10,phase:2}, '00c':{crew:8,phase:3},
  '02':{crew:7,phase:1}, '04':{crew:5,phase:2}, '06':{crew:6,phase:2},
  '05':{crew:4,phase:3}, '07':{crew:4,phase:3}, '08':{crew:5,phase:3},
  '21/22':{crew:7,phase:4}, '23':{crew:7,phase:4}, '26':{crew:7,phase:4},
  '09':{crew:18,phase:5}, '11':{crew:6,phase:6}, '14':{crew:3,phase:6}
};
const PHASE_NAMES={
  1:'Site, Demolition & Foundations', 2:'Structure',
  3:'Envelope, Roof & Openings', 4:'MEP Rough-in',
  5:'Interior Finishes', 6:'Fixtures, Equipment & Commissioning'
};
/* Fraction of the PREVIOUS phase that must be complete before this phase starts.
   Lower = more overlap. Reflects how NYC jobs actually run: structure chases the
   foundation, MEP chases the structure floor-by-floor, finishes chase MEP. */
const PHASE_LAG={1:0, 2:0.75, 3:0.55, 4:0.40, 5:0.45, 6:0.80};
const HRS_PER_DAY=8;

/* ============ TAKEOFF ENGINE ============ */
function metrics(){
  const g={
    gfa:+getV('m-gfa')||0, nsf:+getV('m-nsf')||0, footprint:+getV('m-footprint')||0,
    floors:+getV('m-floors')||1, units:+getV('m-units')||0, f2f:+getV('m-f2f')||11,
    perim:+getV('m-perim')||0, cellar:+document.getElementById('m-cellar').value||0,
    worktype:document.getElementById('m-worktype').value,
    court:+document.getElementById('m-court').value||0,
    windows:+getV('m-windows')||0, doorsEntry:+getV('m-doors-entry')||0,
    doorsStair:+getV('m-doors-stair')||0, doorsInt:+getV('m-doors-int')||0,
    cu:+getV('m-hvac-cu')||0, ah:+getV('m-hvac-ah')||0, exh:+getV('m-exhaust')||0,
    elev:+getV('m-elev')||0,
    boro:+document.getElementById('m-borough').value||1,
    ctype:+document.getElementById('m-ctype').value||1,
    occ:+document.getElementById('m-occ').value||1,
  };
  // Cross-derive area metrics so area-based lines (e.g. $45/SF superstructure)
  // never read $0 just because one field was left blank.
  if(g.gfa<=0 && g.footprint>0 && g.floors>0) g.gfa=g.footprint*g.floors;
  if(g.footprint<=0 && g.gfa>0 && g.floors>0) g.footprint=g.gfa/g.floors;
  if(g.nsf<=0 && g.gfa>0) g.nsf=Math.round(g.gfa*0.78); // ~78% net-to-gross
  return g;
}

// PARTFACTOR (LF partition per SF floor) and wall height factor
const PARTFACTOR=0.95, WALLHT_RATIO=0.83; // clear wall ht ≈ 0.83 × f2f

// Each item now carries: mh (man-hours per unit) and trade (for labor rate).
function buildTakeoff(m){
  const wallht=m.f2f*WALLHT_RATIO;
  const isNew=m.worktype==='new';
  const divs=[];

  if(isNew){
    divs.push({div:'00 · Sitework, Excavation & Foundations', items:[
      {n:'Excavation & earthwork', basis:'Footprint × ~8 ft depth ÷ 27', qty:m.footprint*8/27, u:'CY', p:55, mh:0.12, trade:'operator', src:'New foundation'},
      {n:'Foundation (footings, mat, walls)', basis:'Footprint SF · mandatory $45/SF', qty:m.footprint, u:'SF', p:45, fixed:true, mh:0.30, trade:'concrete', src:'Mandatory $45/SF (fixed)'},
      {n:'Below-grade waterproofing', basis:'Footprint SF', qty:m.footprint, u:'SF', p:14, mh:0.05, trade:'laborer', src:'Foundation walls+slab'},
      {n:'Utility connections', basis:'Lump', qty:1, u:'LS', p:185000, mh:350, trade:'laborer', src:'ConEd/DEP taps'},
    ]});
    divs.push({div:'00b · Superstructure', items:[
      {n:'Concrete superstructure — frame, slabs & roof deck', basis:'GFA SF · mandatory $45/SF', qty:m.gfa, u:'SF', p:45, fixed:true, mh:0.30, trade:'concrete', src:'Mandatory $45/SF (fixed)'},
    ]});
    divs.push({div:'00c · Exterior Envelope', items:[
      {n:'Exterior facade (new skin)', basis:'≈0.85 × GFA', qty:m.gfa*0.85, u:'SF', p:55, mh:0.30, trade:'glazier', src:'Curtain wall/masonry/panel'},
      {n:'Air/vapor barrier & insulation', basis:'≈0.85 × GFA', qty:m.gfa*0.85, u:'SF', p:16, mh:0.05, trade:'insulation', src:'Continuous insulation'},
    ]});
  }else{
    divs.push({div:'02 · Demolition', items:[
      {n:'Selective interior demolition', basis:'Net area × 40%', qty:m.nsf*0.40, u:'SF', p:9, mh:0.07, trade:'laborer', src:'Partial demo, factored'},
      {n:'Debris removal & disposal', basis:'1 CY / 35 SF demo', qty:(m.nsf*0.40)/35, u:'CY', p:95, mh:0.45, trade:'laborer', src:'NYC C&D disposal'},
      {n:'Asbestos / hazmat abatement', basis:'Net area (if pre-1980)', qty:m.nsf, u:'SF', p:16, mh:0.10, trade:'abatement', src:'Confirm w/ survey'},
    ]});
    divs.push({div:'04 · Masonry', items:[
      {n:'Brick repointing — facade', basis:'Perim × ht × floors × 30%', qty:m.perim*m.f2f*m.floors*0.30, u:'SF', p:28, mh:0.22, trade:'mason', src:'Existing brick retained'},
      {n:'New CMU bearing/shaft walls', basis:'Shaft 4 sides × ht × floors', qty:4*m.f2f*m.floors, u:'SF', p:38, mh:0.16, trade:'mason', src:'Rated CMU'},
    ]});
    divs.push({div:'06 · Wood & Timber', items:[
      {n:'Existing floor structure mod / reinf', basis:'Net resi area', qty:m.nsf, u:'SF', p:12, mh:0.07, trade:'carpenter', src:'Modify/fire-treat existing'},
      {n:'Blocking, backing, rough carpentry', basis:'Net area × 0.5', qty:m.nsf*0.5, u:'SF', p:3.5, mh:0.03, trade:'carpenter', src:'Backing for fixtures'},
    ]});
  }

  // common divisions
  divs.push({div:'05 · Metals', items:[
    {n:'Egress stairs (steel pan + concrete)', basis:'2 stairs', qty:2, u:'EA', p:95000, mh:280, trade:'ironworker', src:'Full-height egress stairs'},
    {n:'Misc metals — railings, guards', basis:'2 stairs × floors × 14 LF', qty:2*m.floors*14, u:'LF', p:185, mh:0.35, trade:'ironworker', src:'Stair guards per code'},
  ]});

  divs.push({div:'07 · Thermal & Moisture', items:[
    {n:'Roofing membrane', basis:'Footprint + bulkhead', qty:m.footprint+800, u:'SF', p:22, mh:0.04, trade:'roofer', src:'EPDM/mod-bit'},
    {n:'Roof insulation', basis:'Footprint + bulkhead', qty:m.footprint+800, u:'SF', p:6.5, mh:0.02, trade:'roofer', src:'R-30 polyiso'},
    !isNew && {n:'Exterior wall insulation (int. face)', basis:'Perim × ht × floors × 85%', qty:m.perim*m.f2f*m.floors*0.85, u:'SF', p:12, mh:0.05, trade:'insulation', src:'Rigid + mineral wool'},
    {n:'Caulking & sealants', basis:'Lump', qty:1, u:'LS', p:45000, mh:250, trade:'laborer', src:'Perimeters, joints'},
  ].filter(Boolean)});

  const courtItem = m.court ? [{n:'Inner court / curtain wall system', basis:'Lump', qty:1, u:'LS', p:185000, mh:550, trade:'glazier', src:'Light-well glazing'}] : [];
  divs.push({div:'08 · Openings (Doors & Windows)', items:[
    !isNew && {n:'Windows (replacement)', basis:'Count from schedule', qty:m.windows, u:'EA', p:2750, mh:3, trade:'glazier', src:'Window schedule'},
    {n:'Apartment / entry doors (rated)', basis:'Count from schedule', qty:m.doorsEntry, u:'EA', p:2800, mh:3.5, trade:'carpenter', src:'2HR HM doors'},
    {n:'Stair / fire-rated doors', basis:'Count from schedule', qty:m.doorsStair, u:'EA', p:3200, mh:3.5, trade:'carpenter', src:'Rated HM'},
    {n:'Interior doors', basis:'Count from schedule', qty:m.doorsInt, u:'EA', p:850, mh:1.3, trade:'carpenter', src:'WD doors'},
    ...courtItem,
  ].filter(Boolean)});

  divs.push({div:'09 · Finishes', items:[
    {n:'Metal stud partition framing', basis:'Net area × 0.95 LF/SF', qty:m.nsf*PARTFACTOR, u:'LF', p:9.8, mh:0.11, trade:'drywall', src:'3-5/8" steel stud · mkt-adj −30%'},
    {n:'Gypsum board (5/8" Type X)', basis:'Partition LF × ht × 2 + ceilings', qty:(m.nsf*PARTFACTOR*wallht*2)+m.nsf, u:'SF', p:2.28, mh:0.016, trade:'drywall', src:'Both faces + ceiling · mkt-adj −30%'},
    {n:'Porcelain tile — bath & kitchen', basis:'Units × 120 SF', qty:m.units*120, u:'SF', p:19.6, mh:0.14, trade:'tile', src:'Bath/kitchen tile · mkt-adj −30%'},
    {n:'Resilient flooring (LVT)', basis:'Net area − tile area', qty:Math.max(m.nsf-m.units*120,0), u:'SF', p:9.8, mh:0.025, trade:'flooring', src:'Living/bedroom · mkt-adj −30%'},
    {n:'Painting — walls & ceilings', basis:'GWB area', qty:(m.nsf*PARTFACTOR*wallht*2)+m.nsf, u:'SF', p:1.30, mh:0.011, trade:'painter', src:'2 coats · mkt-adj −30%'},
    {n:'Specialty ceilings / soffits', basis:'≈40 LF per unit', qty:m.units*40, u:'LF', p:129.5, mh:0.28, trade:'drywall', src:'HVAC soffits · mkt-adj −30%'},
  ]});

  divs.push({div:'11 · Kitchens, Baths & Appliances', items:[
    {n:'Kitchen casework & countertops', basis:'Per unit', qty:m.units, u:'EA', p:12000, mh:15, trade:'millwork', src:'Mid-grade'},
    {n:'Bathroom vanities & accessories', basis:'≈1.6 baths/unit', qty:m.units*1.6, u:'EA', p:3200, mh:5, trade:'millwork', src:'incl ADA reinf'},
    {n:'Appliance packages', basis:'Per unit', qty:m.units, u:'EA', p:4500, mh:3.5, trade:'laborer', src:'Range, fridge, DW'},
  ]});

  if(m.elev>0) divs.push({div:'14 · Conveying', items:[
    {n:'Passenger elevator', basis:'Count', qty:m.elev, u:'EA', p:185000, mh:380, trade:'elevator', src:'Multi-stop'},
  ]});

  divs.push({div:'21/22 · Plumbing & Fire Protection', items:[
    {n:'Plumbing systems (units, risers, common, DHW)', basis:'GFA SF · $13/SF (set)', qty:m.gfa, u:'SF', p:13, fixed:true, mh:0.05, trade:'plumber', src:'$13/SF flat'},
    {n:'Fire sprinkler (NFPA 13R)', basis:'GFA SF · $6/SF (set)', qty:m.gfa, u:'SF', p:6, fixed:true, mh:0.02, trade:'sprinkler', src:'$6/SF flat'},
  ]});

  divs.push({div:'23 · HVAC / Mechanical', items:[
    {n:'Outdoor condensing units', basis:'Count from schedule', qty:m.cu, u:'EA', p:5500, mh:15, trade:'hvac', src:'Roof condensers (avg)'},
    {n:'Indoor air handlers / cassettes', basis:'Count from schedule', qty:m.ah, u:'EA', p:1700, mh:9, trade:'hvac', src:'Per unit zones (avg)'},
    {n:'Exhaust fans (kitchen + bath)', basis:'Count from schedule', qty:m.exh, u:'EA', p:320, mh:4, trade:'hvac', src:'Vented to roof'},
    {n:'Refrigerant piping & insulation', basis:'Per indoor unit', qty:m.ah, u:'EA', p:1200, mh:11, trade:'hvac', src:'R-410A insulated'},
    {n:'Exhaust ductwork & goosenecks', basis:'Per exhaust fan', qty:m.exh, u:'EA', p:2200, mh:9, trade:'hvac', src:'Roof terminations'},
    {n:'Install, controls, balancing (TAB)', basis:'Lump', qty:1, u:'LS', p:95000, mh:380, trade:'hvac', src:'Commissioning'},
  ]});

  divs.push({div:'26 · Electrical', items:[
    {n:'Electrical (service, distribution, units, fixtures, fire alarm)', basis:'GFA SF · $12/SF (set)', qty:m.gfa, u:'SF', p:12, fixed:true, mh:0.05, trade:'electrician', src:'$12/SF flat'},
  ]});

  return divs;
}

/* ============ LABOR & SCHEDULE COMPUTATION ============ */
function computeLabor(divs){
  const laborMult=+getV('labor-mult')||1;
  const rows=[];
  const phaseMap={};
  let totHrs=0, totCost=0;

  divs.forEach(d=>{
    const code=d.div.split('\u00b7')[0].trim();
    const sched=DIV_SCHED[code]||{crew:4,phase:5};
    let hrs=0, cost=0;
    d.items.forEach(it=>{
      const h=(it.qty||0)*(it.mh||0);
      const rate=(TRADE_RATE[it.trade]||90)*laborMult;
      hrs+=h; cost+=h*rate;
    });
    const days=sched.crew>0 ? hrs/(sched.crew*HRS_PER_DAY) : 0;
    const row={code, name:d.div.split('\u00b7').slice(1).join('\u00b7').trim(), hrs, crew:sched.crew, days, cost, phase:sched.phase};
    rows.push(row);
    totHrs+=hrs; totCost+=cost;
    const ph=phaseMap[sched.phase]||(phaseMap[sched.phase]={hrs:0,cost:0,maxDays:0,divs:[]});
    ph.hrs+=hrs; ph.cost+=cost; ph.maxDays=Math.max(ph.maxDays,days); ph.divs.push(row);
  });

  // ---- OVERLAPPING SCHEDULE ----
  // Trades don't wait for the previous phase to fully finish. PHASE_LAG is the
  // fraction of the PREVIOUS phase that must be complete before this one starts
  // (e.g. MEP rough-in begins when the structure is ~40% up and chases it floor
  // by floor). Within a phase, trades already run concurrently (duration = the
  // longest trade). Project duration = the finish of the last phase, not a sum.
  const nums=Object.keys(phaseMap).map(Number).sort((a,b)=>a-b);
  const phases=[]; let prevStart=0, prevDur=0, finish=0;
  nums.forEach((p,idx)=>{
    const dur=Math.ceil(phaseMap[p].maxDays);
    const lag=(idx===0)?0:(PHASE_LAG[p]!==undefined?PHASE_LAG[p]:0.6);
    const start=(idx===0)?0:Math.round(prevStart + prevDur*lag);
    const end=start+dur;
    finish=Math.max(finish,end);
    phases.push({phase:p, name:PHASE_NAMES[p]||('Phase '+p),
      hrs:phaseMap[p].hrs, cost:phaseMap[p].cost, days:dur,
      start, end, divs:phaseMap[p].divs});
    prevStart=start; prevDur=dur;
  });
  const projWorkDays=finish;
  const sumDays=phases.reduce((s,p)=>s+p.days,0);   // what it would be with no overlap

  return {rows, phases, totHrs, totLaborCost:totCost, projWorkDays, sumDays, laborMult};
}

/* ============ ESTIMATE STATE (editable, like a real estimating system) ============ */
const overrides = {};   // id -> {qty, p, excl}
let customRows = [];    // user-added line items {div,n,u,qty,p,mh,trade}
function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

function setOv(id,field,val){
  const o=overrides[id]||(overrides[id]={});
  if(field==='excl') o.excl=!o.excl; else o[field]=(val===''?undefined:+val);
  recalc();
}
function addCustomRow(){
  const div=getV('cr-div')||'99 · Other / Custom';
  const n=(getV('cr-name')||'').trim(); if(!n){ alert('Give the line item a name.'); return; }
  customRows.push({div, n, u:getV('cr-unit')||'LS', qty:+getV('cr-qty')||0, p:+getV('cr-price')||0,
                   mh:+getV('cr-mh')||0, trade:getV('cr-trade')||'laborer', custom:true, basis:'User-added'});
  setV('cr-name',''); setV('cr-qty',''); setV('cr-price',''); setV('cr-mh','');
  recalc();
}
function removeCustomRow(i){ customRows.splice(i,1); recalc(); }
function resetEstimate(){
  if(!confirm('Reset all quantity/rate edits and custom line items?')) return;
  Object.keys(overrides).forEach(k=>delete overrides[k]);
  customRows=[]; recalc();
}

function recalc(){
  const m=metrics();
  const locMult=m.boro*m.ctype*m.occ;
  const laborMult=+getV('labor-mult')||1;
  const divs=buildTakeoff(m);

  // fold user-added rows into their divisions
  customRows.forEach((c,i)=>{
    let d=divs.find(x=>x.div===c.div);
    if(!d){ d={div:c.div, items:[]}; divs.push(d); }
    d.items.push(Object.assign({}, c, {_ci:i}));
  });

  const tbody=document.getElementById('takeoff-body');
  let direct=0, matTot=0, labTot=0, lineCount=0;
  const exportRows=[]; let html='';

  divs.forEach(d=>{
    html+=`<tr class="divhdr"><td colspan="8">${esc(d.div)}</td></tr>`;
    let dtotal=0;
    d.items.forEach(it=>{
      const id=slug(d.div.split('·')[0])+'-'+slug(it.n);
      const o=overrides[id]||{};
      const qty=(o.qty!==undefined?o.qty:it.qty);
      const price=(o.p!==undefined?o.p:it.p);
      const excl=!!o.excl;
      const ext=excl?0:(it.fixed ? qty*price : qty*price*locMult);
      // material / labor split: labor = hours × loaded wage; material = remainder
      const hrs=excl?0:qty*(it.mh||0);
      let lab=hrs*((TRADE_RATE[it.trade]||90)*laborMult);
      if(lab>ext) lab=ext;                    // labor can't exceed the installed price
      const mat=Math.max(ext-lab,0);
      dtotal+=ext; direct+=ext; matTot+=mat; labTot+=lab; if(!excl) lineCount++;

      const rm = it.custom
        ? `<button class="rm" title="Delete" onclick="removeCustomRow(${it._ci})">×</button>`
        : `<button class="rm" title="${excl?'Include':'Exclude'}" onclick="setOv('${id}','excl')">${excl?'+':'–'}</button>`;
      html+=`<tr${excl?' style="opacity:.4"':''}>
        <td>${esc(it.n)}${it.custom?' <span class="ai-badge">added</span>':''}</td>
        <td class="basis">${esc(it.basis||'')}</td>
        <td class="num"><input class="cell" type="number" step="any" value="${qty}" oninput="setOv('${id}','qty',this.value)"></td>
        <td>${esc(it.u)}</td>
        <td class="num"><input class="cell" type="number" step="any" value="${price}" oninput="setOv('${id}','p',this.value)"></td>
        <td class="num">${fmtM(mat)}</td>
        <td class="num">${fmtM(lab)}</td>
        <td class="num"><strong>${fmtM(ext)}</strong>${rm}</td>
      </tr>`;
      exportRows.push({div:d.div, name:it.n, basis:it.basis||'', qty, unit:it.u, price,
        loc:(it.fixed?1:locMult), mat, lab, ext, src:it.src||'', mh:it.mh, trade:it.trade, excl});
    });
    html+=`<tr class="subtot"><td colspan="7">${esc(d.div.split('·')[0].trim())} subtotal</td><td class="num">${fmtM(dtotal)}</td></tr>`;
  });
  tbody.innerHTML=html;

  const gcPct=+getV('gc-pct')||0, opPct=+getV('op-pct')||0, contPct=+getV('cont-pct')||0;
  const marginPct=+getV('margin-pct')||0;
  const gc=direct*gcPct/100, op=(direct+gc)*opPct/100, pre=direct+gc+op, cont=pre*contPct/100, grand=pre+cont;
  const sell = marginPct>0 && marginPct<100 ? grand/(1-marginPct/100) : grand;
  const psf=m.gfa>0?grand/m.gfa:0;

  setT('t-direct',fmtM(direct)); setT('t-gc',fmtM(gc)); setT('t-op',fmtM(op));
  setT('t-cont',fmtM(cont)); setT('t-grand',fmtM(grand));
  setT('t-mat',fmtM(matTot)); setT('t-lab',fmtM(labTot));
  setT('t-sell',fmtM(sell)); setT('margin-l',marginPct);
  setT('gc-l',gcPct); setT('op-l',opPct);
  setT('s-total','$'+(grand/1e6).toFixed(2)+'M'); setT('s-psf','$'+Math.round(psf));
  setT('s-unit',m.units>0?'$'+Math.round(grand/m.units/1000)+'K':'—'); setT('s-units',m.units+' units');
  setT('s-lines',lineCount);
  const bench=document.getElementById('s-bench');
  if(bench){
    if(m.worktype==='new') bench.textContent = psf<300?'below NYC ground-up':psf<=800?'within $300-800/SF':'above typical';
    else bench.textContent = psf<250?'below NYC reno':psf<=600?'within $250-600/SF':'above typical';
  }

  /* ----- Scope of Work: labor & schedule ----- */
  const lab=computeLabor(divs);
  lastLabor=lab;
  renderLabor(lab);

  lastRows=exportRows;
  lastTotals={direct,gc,op,cont,grand,psf,gcPct,opPct,contPct,m,matTot,labTot,marginPct,sell};
}

/* ============ TEMPLATES: save / load an estimate as JSON ============ */
function saveTemplate(){
  const data={v:2, metrics:{}, overrides, customRows, wages:Object.assign({},TRADE_RATE),
    markups:{gc:getV('gc-pct'),op:getV('op-pct'),cont:getV('cont-pct'),margin:getV('margin-pct'),labor:getV('labor-mult')}};
  ['m-name','m-job','m-borough','m-gfa','m-nsf','m-footprint','m-floors','m-units','m-f2f','m-perim',
   'm-cellar','m-worktype','m-ctype','m-occ','m-court','m-windows','m-doors-entry','m-doors-stair',
   'm-doors-int','m-hvac-cu','m-hvac-ah','m-exhaust','m-elev'].forEach(id=>data.metrics[id]=getV(id));
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=(getV('m-name')||'estimate').replace(/[^a-z0-9]+/gi,'_').toLowerCase()+'_template.json';
  a.click();
}
function loadTemplate(input){
  const f=input.files&&input.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=()=>{
    try{
      const d=JSON.parse(r.result);
      Object.entries(d.metrics||{}).forEach(([k,v])=>setV(k,v));
      Object.keys(overrides).forEach(k=>delete overrides[k]);
      Object.assign(overrides, d.overrides||{});
      customRows=(d.customRows||[]).slice();
      if(d.wages) Object.keys(d.wages).forEach(k=>{ if(TRADE_RATE[k]!==undefined) TRADE_RATE[k]=d.wages[k]; });
      renderWages();
      if(d.markups){ setV('gc-pct',d.markups.gc); setV('op-pct',d.markups.op);
        setV('cont-pct',d.markups.cont); setV('margin-pct',d.markups.margin||0); setV('labor-mult',d.markups.labor||1); }
      hide('step-1'); hide('analyzing'); show('step-3'); setChip(3); recalc();
    }catch(e){ alert('That file is not a valid estimate template.'); }
  };
  r.readAsText(f);
  input.value='';
}

/* ============ PROMPT-TO-ESTIMATE (describe the project instead of uploading) ============ */
async function estimateFromPrompt(){
  const desc=(getV('prompt-text')||'').trim();
  if(!desc){ alert('Describe the project first — e.g. "5-story new multifamily in Queens, 30,000 SF, 24 units, 2 elevators".'); return; }
  show('analyzing'); hide('step-1'); clearMetrics();
  const msg=document.getElementById('analyze-msg'); const sub=document.getElementById('analyze-sub');
  if(msg) msg.textContent='Generating estimate from your description…';
  if(sub) sub.textContent='Inferring building metrics and schedule counts';
  try{
    const text=await callExtractorText(
      'A contractor describes a project below. Infer the building metrics and schedule counts as a NYC estimator would, '+
      'using typical values where not stated (e.g. windows per unit, doors per unit, HVAC units per unit). Return null only if you cannot reasonably infer.\n\n'+
      'PROJECT: '+desc+'\n\n'+EXTRACTION_PROMPT);
    const parsed=parseJSON(text);
    if(!parsed) throw new Error('could not parse');
    fillMetrics(parsed);
    const el=document.getElementById('extract-note');
    if(el) el.innerHTML='<span class="ai-badge">From description</span> &nbsp;Values were inferred from your project description. <strong>Review every field</strong> — inferred numbers are assumptions, not measured takeoff. Edit anything, then run the takeoff.';
    hide('analyzing'); show('step-2'); setChip(2);
  }catch(e){
    hide('analyzing'); show('step-1');
    alert('Could not generate from the description ('+e.message+'). Enter the metrics manually instead.');
  }
}
async function callExtractorText(prompt){
  try{
    const r=await fetch(PROXY_URL,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({parts:[{media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='}],prompt,file:{kind:'image',media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='}})});
    if(r.ok){ const d=await r.json(); if(d&&typeof d.text==='string') return d.text; }
  }catch(e){}
  const r2=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:1000,messages:[{role:'user',content:[{type:'text',text:prompt}]}]})});
  if(!r2.ok) throw new Error('API '+r2.status);
  const d2=await r2.json();
  return (d2.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
}


function renderLabor(lab){
  const body=document.getElementById('labor-body');
  const total=Math.max(lab.projWorkDays,1);
  if(body){
    let html='';
    lab.phases.forEach(ph=>{
      const left=(ph.start/total*100).toFixed(1);
      const width=Math.max(ph.days/total*100,1.5).toFixed(1);
      html+=`<tr class="divhdr"><td colspan="6">Phase ${ph.phase} \u00b7 ${ph.name} \u2014 day ${ph.start} to ${ph.end}</td></tr>`;
      ph.divs.forEach(r=>{
        html+=`<tr><td>${r.code} \u00b7 ${r.name}</td><td class="num">${fmtN(r.hrs)}</td><td class="num">${r.crew}</td><td class="num">${fmtN(r.days)}</td><td class="num">${fmtM(r.cost)}</td>
          <td><div class="gantt"><div class="bar" style="left:${left}%;width:${width}%"></div></div></td></tr>`;
      });
      html+=`<tr class="subtot"><td>Phase ${ph.phase} \u2014 ${ph.days} work-days (runs day ${ph.start}\u2013${ph.end})</td>
        <td class="num">${fmtN(ph.hrs)}</td><td></td><td class="num">${ph.days}</td><td class="num">${fmtM(ph.cost)}</td>
        <td><div class="gantt"><div class="bar bar-ph" style="left:${left}%;width:${width}%"></div></div></td></tr>`;
    });
    body.innerHTML=html;
  }
  const wkCal=lab.projWorkDays/5;
  const saved=(lab.sumDays||0)-lab.projWorkDays;
  setT('l-hours', Math.round(lab.totHrs).toLocaleString()+' hrs');
  setT('l-cost', fmtM(lab.totLaborCost));
  setT('l-days', lab.projWorkDays+' work-days');
  setT('l-cal', '\u2248 '+wkCal.toFixed(1)+' wks ('+(lab.projWorkDays/21).toFixed(1)+' mo)'+(saved>0?' \u00b7 '+saved+'d saved by overlap':''));
}

/* ============ EXCEL EXPORT (SheetJS) ============ */
// Load the Excel library only when needed (keeps the page free of load-time
// external dependencies, so it renders reliably even in sandboxed previews).
function ensureXLSX(){
  return (async()=>{
    if(typeof XLSX!=='undefined' && XLSX.utils) return;
    try{ await loadScript('vendor/xlsx.full.min.js'); }
    catch(e){ await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'); }
    if(typeof XLSX==='undefined') throw new Error('Could not load the Excel library.');
  })();
}
async function exportExcel(){
  try{ await ensureXLSX(); }
  catch(e){ alert(e.message+'\n\nThe on-screen takeoff is unaffected — try the download again with an internet connection.'); return; }
  const {direct,gc,op,cont,grand,psf,gcPct,opPct,contPct,m}=lastTotals;
  const wb=XLSX.utils.book_new();

  // Sheet 1: Inputs
  const inAOA=[
    ['MATERIAL TAKEOFF — INPUTS & ASSUMPTIONS'],
    [getV('m-name')||'Project', '', '', 'DOB Job# '+(getV('m-job')||'')],
    [],
    ['Building metric','Value','Unit'],
    ['Total GFA',m.gfa,'SF'],['Net residential SF',m.nsf,'SF'],['Footprint / floor',m.footprint,'SF'],
    ['Floors',m.floors,'ea'],['Cellar',m.cellar?'Yes':'No',''],['Dwelling units',m.units,'ea'],
    ['Floor-to-floor',m.f2f,'ft'],['Perimeter',m.perim,'LF'],
    [],
    ['Schedule counts','Value'],
    ['Windows',m.windows],['Entry doors',m.doorsEntry],['Stair/fire doors',m.doorsStair],
    ['Interior doors',m.doorsInt],['HVAC condensers',m.cu],['HVAC indoor units',m.ah],
    ['Exhaust fans',m.exh],['Elevators',m.elev],
    [],
    ['Pricing & markups','Value'],
    ['Borough factor',m.boro],['Construction type factor',m.ctype],['Occupancy factor',m.occ],
    ['Location multiplier (combined)',+(m.boro*m.ctype*m.occ).toFixed(3)],
    ['General conditions %',gcPct/100],['GC overhead & profit %',opPct/100],['Contingency %',contPct/100],
    ['Labor rate adjustment',lastLabor.laborMult||1],
    [],
    ['Quantities are estimate-grade derivations from plan data + standard takeoff factors. Verify vs dimensioned drawings.'],
  ];
  const ws1=XLSX.utils.aoa_to_sheet(inAOA);
  ws1['!cols']=[{wch:34},{wch:14},{wch:10},{wch:24}];
  XLSX.utils.book_append_sheet(wb,ws1,'Inputs');

  // Sheet 2: Material Takeoff
  const toAOA=[['MATERIAL QUANTITY TAKEOFF'],[],
    ['Division','Material / work item','Quantity basis','Qty','Unit','Unit $','Loc adj','Material $','Labor $','Extended $','Source']];
  let curDiv='';
  lastRows.forEach(r=>{
    if(r.div!==curDiv){ toAOA.push([r.div]); curDiv=r.div; }
    toAOA.push(['', r.name+(r.excl?' (EXCLUDED)':''), r.basis, +(+r.qty).toFixed(1), r.unit, r.price, +r.loc.toFixed(3), Math.round(r.mat), Math.round(r.lab), Math.round(r.ext), r.src]);
  });
  toAOA.push([]);
  toAOA.push(['','DIRECT WORK SUBTOTAL','','','','','',Math.round(lastTotals.matTot),Math.round(lastTotals.labTot),Math.round(direct)]);
  const ws2=XLSX.utils.aoa_to_sheet(toAOA);
  ws2['!cols']=[{wch:32},{wch:34},{wch:30},{wch:10},{wch:6},{wch:11},{wch:9},{wch:13},{wch:13},{wch:14},{wch:30}];
  XLSX.utils.book_append_sheet(wb,ws2,'Material Takeoff');

  // Sheet 3: Cost Summary
  const byDiv={};
  lastRows.forEach(r=>{ byDiv[r.div]=(byDiv[r.div]||0)+r.ext; });
  const sumAOA=[['COST SUMMARY'],[getV('m-name')||'Project'],[],['Division','Amount','% of direct']];
  Object.entries(byDiv).forEach(([k,v])=>sumAOA.push([k,Math.round(v),direct>0?+(v/direct).toFixed(3):0]));
  sumAOA.push([]);
  sumAOA.push(['Direct work subtotal',Math.round(direct)]);
  sumAOA.push(['General conditions ('+gcPct+'%)',Math.round(gc)]);
  sumAOA.push(['GC overhead & profit ('+opPct+'%)',Math.round(op)]);
  sumAOA.push(['Contingency ('+contPct+'%)',Math.round(cont)]);
  sumAOA.push(['TOTAL ESTIMATED HARD COST',Math.round(grand)]);
  sumAOA.push([]);
  sumAOA.push(['Material (of direct)',Math.round(lastTotals.matTot)]);
  sumAOA.push(['Labor, loaded (of direct)',Math.round(lastTotals.labTot)]);
  if(lastTotals.marginPct>0){
    sumAOA.push(['Target margin %',lastTotals.marginPct/100]);
    sumAOA.push(['SELL PRICE at target margin',Math.round(lastTotals.sell)]);
  }
  sumAOA.push([]);
  sumAOA.push(['Cost per SF (GFA)',+psf.toFixed(2)]);
  sumAOA.push(['Cost per unit',m.units>0?Math.round(grand/m.units):0]);
  sumAOA.push([]);
  sumAOA.push(['Accuracy ±20-30%, pre-bid. Excludes soft costs (design, filing fees, financing, insurance, FF&E).']);
  const ws3=XLSX.utils.aoa_to_sheet(sumAOA);
  ws3['!cols']=[{wch:42},{wch:16},{wch:12}];
  XLSX.utils.book_append_sheet(wb,ws3,'Cost Summary');

  // Sheet 4: Scope of Work — Labor & Schedule
  const lab=lastLabor;
  const labAOA=[['SCOPE OF WORK — LABOR & SCHEDULE'],[getV('m-name')||'Project'],[],
    ['Phase','Division','Labor hrs','Crew','Work-days','Labor $ (loaded)']];
  lab.phases.forEach(ph=>{
    labAOA.push(['Phase '+ph.phase+' · '+ph.name]);
    ph.divs.forEach(r=>{
      labAOA.push(['', r.code+' · '+r.name, Math.round(r.hrs), r.crew, +r.days.toFixed(1), Math.round(r.cost)]);
    });
    labAOA.push(['', 'Phase critical duration', Math.round(ph.hrs), '', ph.days, Math.round(ph.cost)]);
    labAOA.push([]);
  });
  labAOA.push(['TOTALS','', Math.round(lab.totHrs),'', lab.projWorkDays, Math.round(lab.totLaborCost)]);
  labAOA.push([]);
  labAOA.push(['Estimated project duration (phased)', lab.projWorkDays+' work-days']);
  labAOA.push(['Approx. calendar', (lab.projWorkDays/5).toFixed(1)+' weeks  /  '+(lab.projWorkDays/21).toFixed(1)+' months']);
  labAOA.push(['Labor rate adjustment applied', lab.laborMult]);
  labAOA.push([]);
  labAOA.push(['Man-hours are estimate-grade productivity factors × takeoff quantities. Crews and phase durations are']);
  labAOA.push(['planning-level; trades within a phase run concurrently (phase duration = longest trade). Labor cost shown']);
  labAOA.push(['is the loaded crew cost embedded WITHIN the installed unit prices on the Cost Summary — it is NOT added on top.']);
  const ws4=XLSX.utils.aoa_to_sheet(labAOA);
  ws4['!cols']=[{wch:26},{wch:34},{wch:12},{wch:8},{wch:11},{wch:16}];
  XLSX.utils.book_append_sheet(wb,ws4,'Labor & Schedule');

  const pname=(getV('m-name')||'project').replace(/[^a-z0-9]+/gi,'_').toLowerCase();
  XLSX.writeFile(wb, pname+'_material_takeoff.xlsx');
}

/* ============ BACKEND SELF-TEST ============ */
async function testBackend(){
  const b=document.getElementById('err-banner');
  const say=(t,ok)=>{ if(b){ b.textContent=t; b.className='note '+(ok?'warn':'err'); b.classList.remove('hidden'); } };
  say('Checking the backend…', true);
  try{
    // health check first — proves which function version is live
    try{
      const g=await fetch(PROXY_URL,{method:'GET'});
      if(g.ok){ const gi=await g.json();
        if(gi&&gi.version&&gi.version!=='2026-07-17b'){
          say('\u2717 An OLD function is deployed (version '+gi.version+'). Redeploy the latest netlify/functions/analyze.js, then Trigger deploy.', false); return;
        }
        if(gi&&gi.keySet===false){
          say('\u2717 Function is live (v'+gi.version+') but ANTHROPIC_API_KEY is NOT set. Add it in Netlify \u2192 Environment variables, then Trigger deploy.', false); return;
        }
      }
    }catch(_){}
    const r=await fetch(PROXY_URL,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({parts:[{media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='}],prompt:'Reply with the single word OK.',file:{kind:'image',media_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='}})});
    if(r.status===404){
      say('✗ Backend NOT deployed. The site is missing /.netlify/functions/analyze. Re-upload the site INCLUDING the "netlify" folder (netlify/functions/analyze.js) and netlify.toml, then redeploy.', false);
      return;
    }
    let d=null; try{ d=await r.json(); }catch(_){}
    if(r.ok && d && typeof d.text==='string'){
      say('✓ Backend is working and the API key is valid. Plan reading should work — upload your plans and click Analyze.', true);
    }else if(d && d.error){
      say('✗ Backend is deployed but returned: "'+d.error+'"  → If it mentions ANTHROPIC_API_KEY, add it in Netlify (Site configuration → Environment variables) and then Deploys → Trigger deploy.', false);
    }else{
      say('✗ Backend responded with status '+r.status+'. Check the function log in Netlify (Deploys → Functions → analyze).', false);
    }
  }catch(e){
    say('✗ Could not reach the backend at all ('+((e&&e.message)||e)+'). The function is probably not deployed with the site.', false);
  }
}

/* ============ CLIENT-READY PROPOSAL ============ */
function buildProposal(){
  const t=lastTotals, lab=lastLabor;
  if(!t||!t.m){ alert('Run the takeoff first.'); return; }
  const m=t.m;
  const price = (t.marginPct>0 ? t.sell : t.grand);   // what the client sees
  const byDiv={};
  lastRows.forEach(r=>{ if(!r.excl) byDiv[r.div]=(byDiv[r.div]||0)+r.ext; });
  const scale = t.direct>0 ? price/t.direct : 1;      // spread markups across divisions
  const rows=Object.entries(byDiv).map(([k,v])=>
    `<tr><td>${esc(k)}</td><td class="num">${fmtM(v*scale)}</td></tr>`).join('');
  const phases=(lab.phases||[]).map(p=>
    `<tr><td>Phase ${p.phase} · ${esc(p.name)}</td><td class="num">${p.days} work-days</td></tr>`).join('');
  const wks=(lab.projWorkDays/5).toFixed(0), mos=(lab.projWorkDays/21).toFixed(1);
  const today=new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
  const wt={new:'New construction',conversion:'Adaptive reuse / conversion',gut:'Full gut renovation',partial:'Partial renovation'}[m.worktype]||m.worktype;

  document.getElementById('proposal').innerHTML=`
    <div class="prop-head">
      <div class="prop-brand">
        <svg width="42" height="42" viewBox="0 0 58 58" fill="none" aria-hidden="true">
          <rect width="58" height="58" rx="13" fill="#0B2239"/>
          <path d="M18 45V14h11.5a9.5 9.5 0 0 1 0 19H24" stroke="#fff" stroke-width="3.4" stroke-linecap="square"/>
          <path d="M24 21.5h5.5a4 4 0 0 1 0 8H24z" fill="#0B2239"/>
          <path d="M33 40h14" stroke="#F2A900" stroke-width="3.6" stroke-linecap="round"/>
          <path d="M36 44.5v-9M44 44.5v-9" stroke="#F2A900" stroke-width="2.4" stroke-linecap="round"/>
        </svg>
        <div><div class="pb-name">P National Group</div><div class="pb-tag">Construction &amp; Development</div></div>
      </div>
      <h2>Construction Proposal</h2>
      <div class="prop-sub">${esc(getV('m-name')||'Project')}${getV('m-job')?' · DOB Job #'+esc(getV('m-job')):''}</div>
      <div class="prop-sub">${today}</div>
    </div>
    <div class="prop-hero">
      <div><div class="metric-label">Total contract price</div><div class="prop-price">${fmtM(price)}</div></div>
      <div><div class="metric-label">Estimated duration</div><div class="prop-price">${mos} months</div>
        <div class="metric-sub">${lab.projWorkDays} work-days · ≈${wks} weeks</div></div>
    </div>
    <h3>Project summary</h3>
    <p>${m.gfa.toLocaleString()} SF gross · ${m.floors} floors${m.cellar?' + cellar':''} · ${m.units} dwelling units · ${esc(wt)}.
       ${m.units>0?'Approximately '+fmtM(price/m.units)+' per dwelling unit, '+fmtM(price/(m.gfa||1))+' per SF.':''}</p>
    <h3>Scope of work &amp; price by division</h3>
    <table class="prop-table"><thead><tr><th>Division</th><th class="num">Price</th></tr></thead>
      <tbody>${rows}<tr class="subtot"><td><strong>Total</strong></td><td class="num"><strong>${fmtM(price)}</strong></td></tr></tbody></table>
    <h3>Construction schedule</h3>
    <table class="prop-table"><thead><tr><th>Phase</th><th class="num">Duration</th></tr></thead>
      <tbody>${phases}<tr class="subtot"><td><strong>Total</strong></td><td class="num"><strong>${lab.projWorkDays} work-days</strong></td></tr></tbody></table>
    <h3>Clarifications &amp; exclusions</h3>
    <ul class="prop-list">
      <li>Price includes general conditions, overhead &amp; profit, and a ${t.contPct}% construction contingency.</li>
      <li><strong>Excludes</strong> soft costs: design/engineering fees, DOB filing &amp; inspection fees, expediting, financing, insurance beyond standard GL, and FF&amp;E.</li>
      <li>Excludes hazardous-material abatement beyond what is shown, unforeseen conditions, and owner-directed changes.</li>
      <li>Quantities from plan schedules are counted; area and length quantities are derived using standard takeoff factors. Estimate accuracy ±20–30% pre-bid.</li>
      <li>Pricing based on current New York market rates and is valid for 30 days.</li>
    </ul>
    <div class="prop-sign">
      <div><div class="sig-line"></div>Contractor</div>
      <div><div class="sig-line"></div>Owner / Client</div>
    </div>`;
  hide('step-3'); show('step-4');
}
function backFromProposal(){ hide('step-4'); show('step-3'); }

/* ============ NAV / HELPERS ============ */
function goToResults(){ hide('step-2'); show('step-3'); setChip(3); renderWages(); recalc(); }
function backToVerify(){ hide('step-3'); show('step-2'); setChip(2); }
function backToUpload(){ hide('step-2'); show('step-1'); setChip(1); }
function setChip(n){
  for(let i=1;i<=3;i++){
    const c=document.getElementById('chip-'+i);
    c.classList.toggle('active',i===n);
    c.classList.toggle('done',i<n);
  }
}
function show(id){document.getElementById(id).classList.remove('hidden');}
function hide(id){document.getElementById(id).classList.add('hidden');}
function getV(id){return document.getElementById(id).value;}
function setV(id,v){const e=document.getElementById(id); if(e)e.value=v;}
function setSel(id,val){
  const e=document.getElementById(id); if(!e) return;
  e.value=String(val);
  if(e.value!==String(val) && e.options){ // numeric mismatch (e.g. 1 vs 1.0): match by float
    for(const o of e.options){ if(parseFloat(o.value)===parseFloat(val)){ e.value=o.value; break; } }
  }
}
function setT(id,v){const e=document.getElementById(id); if(e)e.textContent=v;}
function fmtM(n){return '$'+Math.round(n).toLocaleString();}
function fmtN(n){return (Math.round(n*10)/10).toLocaleString();}
