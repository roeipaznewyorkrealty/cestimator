/* ============ ANALYTICS ============ */
function track(name,params){try{if(typeof gtag==='function')gtag('event',name,params||{});}catch(e){}}

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
const MAX_DIM=2400;        // px — raised for readable schedule table text
const JPEG_Q=0.92;         // raised so small schedule text is legible
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
  const MAXPAGES=40; const N=Math.min(pdf.numPages,MAXPAGES); const out=[];
  for(let p=1;p<=N;p++){
    const page=await pdf.getPage(p);
    const base=page.getViewport({scale:1});
    const scale=Math.min(MAX_DIM/Math.max(base.width,base.height),2)||1;
    const vp=page.getViewport({scale});
    const canvas=document.createElement('canvas');
    canvas.width=Math.ceil(vp.width); canvas.height=Math.ceil(vp.height);
    await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
    const img=canvas.toDataURL('image/jpeg',JPEG_Q).split(',')[1];
    let pageText='';
    try{
      const tc=await page.getTextContent({normalizeWhitespace:false,disableCombineTextItems:false});
      const lines={};
      tc.items.forEach(function(it){ const y=Math.round(it.transform[5]); if(!lines[y])lines[y]=[]; lines[y].push({x:it.transform[4],str:it.str}); });
      pageText=Object.keys(lines).sort(function(a,b){return b-a;}).map(function(y){ return lines[y].sort(function(a,b){return a.x-b.x;}).map(function(i){return i.str;}).join(' '); }).join('\n');
    }catch(e){}
    out.push({img:img,text:pageText});
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
async function callExtractor(parts,pageText,prompt){
  prompt=prompt||EXTRACTION_PROMPT;
  // On the deployed site this goes through the Netlify function, which holds the key.
  let proxyErr=null;
  try{
    // Send BOTH shapes so any deployed version of the function works:
    //  - new function reads `parts`
    //  - older function reads `file` (we mirror the first page into it)
    const first=parts&&parts[0];
    const payload={parts,prompt,pageText:pageText||''};
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
  if(pageText&&pageText.length>20) content.push({type:'text',text:'EXTRACTED PAGE TEXT:\n'+pageText.slice(0,8000)});
  content.push({type:'text',text:prompt});
  const r2=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1000,messages:[{role:'user',content}]})});
  if(!r2.ok){
    let m=''; try{ const e=await r2.json(); m=(e&&e.error&&e.error.message)||''; }catch(_){}
    throw new Error(m||('API '+r2.status+' - no backend function found. Deploy to Netlify with ANTHROPIC_API_KEY set.'));
  }
  const d2=await r2.json();
  return (d2.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
}

// Run async fn over items with at most `n` in flight (keeps results in input order).
async function pool(items,n,fn){
  const out=new Array(items.length); let next=0;
  const worker=async()=>{ while(next<items.length){ const i=next++; out[i]=await fn(items[i],i); } };
  await Promise.all(Array.from({length:Math.min(n,items.length)},worker));
  return out;
}

// Convert a file to downscaled images, batch under the size budget, extract each.
// Returns an array of parsed objects (merged later across all files).
// Skip only sheets that clearly carry no quantities we need (elevations, sections, details,
// ceiling plans, demolition, roof, structural/MEP drawings). Anything mentioning a schedule,
// door/window/HVAC, zoning or area is ALWAYS read; so are the first 3 pages and unreadable pages.
function pageRelevant(page,i){
  const txt=((page&&typeof page==='object'&&page.text)||'').toUpperCase().replace(/\s+/g,' ');
  if(i<3||txt.length<60) return true;
  if(/SCHEDULE|DOOR|WINDOW|HVAC|MECHANICAL|CONDENS|EXHAUST|FLOOR AREA|ZONING|LOT AREA|SOE|UNDERPIN|PILE|UNIT|APARTMENT|GENERAL NOTES|ENERGY|FENESTRATION|LEGEND/.test(txt)&&!/ELEVATION|REFLECTED CEILING|DEMOLITION/.test(txt.slice(0,3000)+txt.slice(-600))) return true;
  if(/(ELEVATIONS?|SECTIONS?|DETAILS?|REFLECTED CEILING|DEMOLITION|ROOF PLAN|FOUNDATION PLAN|FRAMING PLAN|STRUCTURAL|PLUMBING|SPRINKLER|ELECTRICAL|SITE PLAN|FIRE ALARM)/.test(txt)) return false;
  return true;
}
async function extractFromImages(pages,onProg){
  const parsed=[]; const errs=[]; let done=0;
  let keep=pages.map(pageRelevant);
  if(keep.filter(Boolean).length<1) keep=pages.map(()=>true);
  const total=keep.filter(Boolean).length;
  const res=await pool(pages,4,async(page,i)=>{
    if(!keep[i]) return null;
    const imgB64=(typeof page==='string')?page:(page&&page.img)||page;
    const rawText=(page&&typeof page==='object'&&page.text)||'';
    let t=null;
    for(let attempt=0;attempt<3&&t===null;attempt++){
      try{ t=await callExtractor([{media_type:'image/jpeg',data:imgB64}],rawText); }
      catch(e){ const m=(e&&e.message)||String(e); if(attempt<2&&/too long|timed out|502|504|429|rate|overload/i.test(m)){ await new Promise(r=>setTimeout(r,1500*(attempt+1))); continue; } errs.push(m); break; }
    }
    done++; if(onProg) onProg(done,total);
    if(t!==null){ const j=parseJSON(t); if(j){ j._page=i; return j; } }
    return null;
  });
  // second, gentle pass (one at a time) for relevant pages that failed under load
  for(let i=0;i<pages.length;i++){
    if(!keep[i]||res[i]) continue;
    const page=pages[i]; const imgB64=(typeof page==='string')?page:(page&&page.img)||page;
    const rawText=(page&&typeof page==='object'&&page.text)||'';
    try{ const t=await callExtractor([{media_type:'image/jpeg',data:imgB64}],rawText); const j=parseJSON(t); if(j){ j._page=i; res[i]=j; } }catch(e){ errs.push((e&&e.message)||String(e)); }
  }
  res.forEach(j=>{ if(j) parsed.push(j); });
  const failed=pages.filter((p,i)=>keep[i]&&!res[i]).length;
  window._scanInfo={total:pages.length,scanned:total,failed};
  if(failed) console.warn('pages that could not be read:',failed);
  if(!parsed.length&&errs.length) throw new Error(errs[0]);
  return parsed;
}



// Focused pass for the per-floor area table: the general extraction often returns only some rows.
const FLOOR_TABLE_PROMPT=`This sheet contains a FLOOR AREA table or diagram (rows per level: cellar, each numbered floor, bulkhead/penthouse, etc.; columns such as GROSS, DEDUCTIONS, ZFA, NET).
List EVERY row for EVERY level, top to bottom, including the cellar and bulkhead. Do not skip or merge rows. If a note says several floors are identical (e.g. "1,2,3,4TH FLOORS"), still return one row per floor.
gross = the GROSS column (or gross area stated for that level) in SF; net = a column explicitly labeled NET (or net floor area) in SF, otherwise null. Ignore total rows.
Return JSON only: {"floorAreas":[{"name":string,"gross":number|null,"net":number|null}]}`;
async function refineFloorAreas(merged){
  const cand=[];
  files.forEach(entry=>{
    if(!entry||!entry.images) return;
    entry.images.forEach((pg,i)=>{
      const t=((pg&&typeof pg==='object'&&pg.text)||'').toUpperCase().replace(/\s+/g,' ');
      if(i<8&&/FLOOR AREA|AREA DIAGRAM|ZFA/.test(t)) cand.push({entry,i});
    });
  });
  let best=merged.floorAreas&&Array.isArray(merged.floorAreas)?merged.floorAreas:[];
  const outs=await pool(cand.slice(0,3),3,async({entry,i})=>{
    for(let a=0;a<2;a++){
      try{
        const c=await renderPageCanvas(entry,i,3200);
        const j=parseJSON(await callExtractor([{media_type:'image/jpeg',data:c.toDataURL('image/jpeg',0.92).split(',')[1]}],'',FLOOR_TABLE_PROMPT));
        if(j&&Array.isArray(j.floorAreas)) return j.floorAreas;
      }catch(e){ if(a===1) console.warn('floor table pass failed',e); }
    }
    return null;
  });
  outs.forEach(o=>{ if(o&&o.length>best.length) best=o; });
  return best.length?best:null;
}

// Focused elevator count from the proposed floor plans (the general pass often leaves it blank).
const ELEV_PROMPT=`This is an architectural floor plan. How many passenger/stretcher ELEVATOR CARS (elevator shafts) does this building have, as shown on this plan? Count each shaft labeled or drawn as an elevator. Do NOT count legend entries, "elevator sign" notes, stair or shaft labels, or dumbwaiters. If none are shown return 0.
Return JSON only: {"elevators":number}`;
async function countElevators(results){
  const seen=new Set(), cand=[];
  results.forEach(r=>{
    if(!r||r.sheetKind!=='floor_plan'||!r._entry||typeof r._page!=='number') return;
    const k=r._entry.name+'#'+r._page; if(seen.has(k)) return; seen.add(k); cand.push(r);
  });
  cand.sort((a,b)=>(/1ST|FIRST|CELLAR/i.test(b.floorLabel||'')?1:0)-(/1ST|FIRST|CELLAR/i.test(a.floorLabel||'')?1:0));
  const outs=await pool(cand.slice(0,2),2,async r=>{
    for(let a=0;a<2;a++){
      try{
        const c=await renderPageCanvas(r._entry,r._page,2800);
        const j=parseJSON(await callExtractor([{media_type:'image/jpeg',data:c.toDataURL('image/jpeg',0.9).split(',')[1]}],'',ELEV_PROMPT));
        const v=j&&+j.elevators; if(v>=0&&v<12) return Math.round(v);
      }catch(e){}
    }
    return null;
  });
  const vals=outs.filter(v=>v!=null); return vals.length?Math.max.apply(null,vals):null;
}

async function analyzePlans(){
  track('plans_uploaded',{file_count:files.length});
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
        arr.forEach(x=>{ x._entry=entry; results.push(x); });
      }catch(e){ lastErr=(e&&e.message)||String(e); }
    }
    if(!results.length) throw new Error(lastErr || 'no pages could be read');
    const {merged,missing}=mergeExtractions(results);
    if(msg) msg.textContent='Reading the floor-area table…';
    try{ const fa=await refineFloorAreas(merged); if(fa) merged.floorAreas=fa; }catch(e){ console.warn('floor area refine failed',e); }
    const blank=k=>merged[k]==null||merged[k]===-1;
    const need={doors:['doorsEntry','doorsStair','doorsInterior'].every(blank), windows:blank('windows'), ac:blank('hvacIndoor')};
    planInfo={doors:need.doors?'none':'schedule',windows:need.windows?'none':'schedule',ac:need.ac?'none':'schedule',sheets:[]};
    if(need.doors||need.windows||need.ac){
      try{
        const pc=await countFromPlans(results,msg,sub);
        if(pc.sheets.length){
          planInfo.sheets=pc.sheets;
          const drop=l=>{ const i=missing.indexOf(l); if(i>=0) missing.splice(i,1); };
          if(need.doors){ merged.doorsEntry=pc.entry; merged.doorsStair=pc.stair; merged.doorsInterior=pc.interior;
            planInfo.doors='plans'; ['Entry doors','Stair/fire doors','Interior doors'].forEach(drop); }
          if(need.windows){ merged.windows=pc.windows; planInfo.windows='plans'; drop('Windows'); }
          if(need.ac){ merged.hvacIndoor=pc.acRooms; planInfo.ac='plans'; drop('HVAC indoor units'); }
          track('plans_counted',{sheets:pc.sheets.length,doors:pc.entry+pc.stair+pc.interior,windows:pc.windows,ac:pc.acRooms});
        }
      }catch(e){ console.warn('plan count failed',e); }
    }
    if(!(typeof merged.elevators==='number'&&merged.elevators>0)){
      if(msg) msg.textContent='Counting elevators…';
      try{ const ev=await countElevators(results); if(ev!=null){ merged.elevators=ev; const i=missing.indexOf('Elevators'); if(i>=0) missing.splice(i,1); } }catch(e){ console.warn('elevator count failed',e); }
    }
    // Sanity rule: every apartment has exactly one entry door. If the count read from the plans/schedule
    // is missing or far from the unit count, trust the unit count (and say so in the console).
    if(typeof merged.units==='number'&&merged.units>0){
      const de=merged.doorsEntry;
      if(typeof de!=='number'||de<=0||de<merged.units*0.8||de>merged.units*1.5){
        console.warn('entry doors',de,'does not match',merged.units,'units - using unit count');
        merged.doorsEntry=merged.units; if(planInfo.doors==='none') planInfo.doors='none';
      }
    }
    // Anything the plans didn't give (net SF, perimeter, counts) gets an NYC
    // rule-of-thumb value so no line prices at $0 — flagged on the review screen.
    const keep=[];
    if(planInfo.doors!=='none') keep.push('doorsEntry','doorsStair','doorsInterior');
    if(planInfo.windows!=='none') keep.push('windows');
    if(planInfo.ac!=='none') keep.push('hvacIndoor');
    const assumed=fillDescriptionDefaults(merged,keep);
    const KEYLBL={nsf:'Net SF',perimeter:'Perimeter',f2f:'Floor-to-floor',windows:'Windows',doorsEntry:'Entry doors',
      doorsStair:'Stair/fire doors',doorsInterior:'Interior doors',hvacCondensers:'HVAC condensers',hvacIndoor:'HVAC indoor units',
      exhaustFans:'Exhaust fans',footprint:'Footprint/floor',floors:'# Floors',gfa:'Total GFA'};
    Object.keys(KEYLBL).forEach(k=>{ if(typeof merged[k]==='number'&&merged[k]>0){ const i=missing.indexOf(KEYLBL[k]); if(i>=0) missing.splice(i,1); } });
    fillMetrics(merged);
    try{ if(window.autoWalls) setTimeout(function(){ window.autoWalls(); },300); }catch(e){}
    showExtractNote(results.length, files.length, missing, assumed);
    track('analysis_success',{pages_read:results.length});
    hide('analyzing'); show('step-2'); setChip(2);
  }catch(err){
    track('analysis_failed',{error:String(err&&err.message).slice(0,100)});
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
  // Values that should come from ONE authoritative source (the cover/zoning
  // sheet) — take the first real value found, in page order, instead of the
  // max across batches. Max was the bug: a later batch scanning unrelated
  // floor-plan pages could guess a bigger (wrong) number — e.g. miscounting
  // apartment doors as "units" — and that wrong-but-bigger number would win
  // over the correct cover-sheet total.
  const singleFirst=['gfa','nsf','footprint','floors','units','perimeter'];
  // Schedule quantities can legitimately be split across sheets/batches, so
  // these still take the max (each batch's own sum should already be complete
  // for what it saw; max tolerates partial visibility better than averaging).
  const scheduleMax=['windows','doorsEntry','doorsStair','doorsInterior',
    'hvacCondensers','hvacIndoor','exhaustFans','elevators'];
  const firstStr=['projectName','dobJob','borough','worktype','constructionType','occupancy'];
  const flags=['cellar','court'];
  const fs={}; ['excavationDepth','soeLF','underpinningLF','pileCount'].forEach(k=>{ let v=null; list.forEach(o=>{ const x=o&&o[k]; if(typeof x==='number'&&x>0&&x<100000) v=(v==null)?x:Math.max(v,x); }); fs[k]=v; });
  const m={};
  singleFirst.forEach(k=>{ let v=null; list.forEach(o=>{ const x=o&&o[k];
    if(typeof x==='number'&&!Number.isNaN(x)){
      if(x===-1){ if(v==null) v=-1; }
      else if(v==null||v===-1) v=x; // first real value wins — don't let a later, possibly-wrong batch override it
    }
  }); m[k]=v; });
  const zeroIsMissing=k=>k!=='elevators';   // "0 doors" on a sheet with no schedule = not found
  scheduleMax.forEach(k=>{ let v=null; list.forEach(o=>{ const x=o&&o[k];
    if(typeof x==='number'&&!Number.isNaN(x)&&!(x===0&&zeroIsMissing(k))){
      if(x===-1){ if(v==null) v=-1; }
      else v=(v==null||v===-1)?x:Math.max(v,x);
    }
  }); m[k]=v; });
  firstStr.forEach(k=>{ let v=''; list.forEach(o=>{ if(!v&&o&&typeof o[k]==='string'&&o[k].trim()) v=o[k].trim(); }); m[k]=v||null; });
  flags.forEach(k=>{ let v=null; list.forEach(o=>{ const x=o&&o[k]; if(x===0||x===1) v=(v==null)?x:Math.max(v,x); }); m[k]=v; });
  let f2f=null; list.forEach(o=>{ if(f2f==null&&typeof (o&&o.f2f)==='number') f2f=o.f2f; }); m.f2f=f2f;
  let fa=null; list.forEach(o=>{ const x=o&&o.floorAreas; if(Array.isArray(x)&&x.length&&(!fa||x.length>fa.length)) fa=x; }); m.floorAreas=fa;
  const LBL={gfa:'Total GFA',nsf:'Net SF',footprint:'Footprint/floor',floors:'# Floors',
    units:'# Units',perimeter:'Perimeter',f2f:'Floor-to-floor',windows:'Windows',
    doorsEntry:'Entry doors',doorsStair:'Stair/fire doors',doorsInterior:'Interior doors',
    hvacCondensers:'HVAC condensers',hvacIndoor:'HVAC indoor units',exhaustFans:'Exhaust fans',elevators:'Elevators'};
  const missing=Object.keys(LBL).filter(k=>m[k]==null).map(k=>LBL[k]);
  Object.assign(m,fs);
  return {merged:m, missing};
}

function showExtractNote(ok,total,missing,assumed){
  const el=document.getElementById('extract-note');
  if(!el) return;
  let h=`<span class="ai-badge">AI-extracted</span> &nbsp;Read <strong>${ok} of ${total}</strong> file(s), scanning every page and schedule. Review the values and correct anything off — purple fields were auto-filled; all are editable.`;
  if(planInfo&&planInfo.sheets.length&&(planInfo.doors==='plans'||planInfo.windows==='plans'||planInfo.ac==='plans')){
    const sum=f=>planInfo.sheets.reduce((a,x)=>a+f(x)*x.mult,0);
    const parts=[];
    if(planInfo.doors==='plans') parts.push(`<strong>${sum(x=>x.entry+x.stair+x.interior)} doors</strong>`);
    if(planInfo.windows==='plans') parts.push(`<strong>${sum(x=>x.windows)} windows</strong>`);
    if(planInfo.ac==='plans') parts.push(`<strong>${sum(x=>x.acRooms)} AC units</strong> (1 per room ≥ 8'×8' with a window)`);
    h+=`<br><br>Counted from the floor plans (no schedule found): ${parts.join(', ')}.<br>`+
      planInfo.sheets.map(x=>{ const b=[];
        if(planInfo.doors==='plans') b.push((x.entry+x.stair+x.interior)+' doors');
        if(planInfo.windows==='plans') b.push(x.windows+' windows');
        if(planInfo.ac==='plans') b.push(x.acRooms+' AC');
        return `${esc2(x.sheet)}${x.mult>1?' (× '+x.mult+' floors)':''}: ${b.join(', ')}`; }).join(' · ')+
      `. Verify before bid.`;
  }
  if(assumed&&assumed.length){
    h+=`<br><br><strong style="color:#b5340b">Not on the plans — filled with NYC rules of thumb, please check:</strong> ${assumed.map(esc2).join(' · ')}.`;
  }
  if(missing&&missing.length){
    h+=`<br><br><strong style="color:#b5340b">Not found on the sheets provided:</strong> ${missing.join(', ')}.<br>Enter these manually below, or go back and also upload the specific schedule sheet that lists them (e.g. window/door schedule, MEP equipment schedule).`;
  }
  el.innerHTML=h;
}

const EXTRACTION_PROMPT = `You are a senior NYC construction estimator. Read EVERY piece of printed text — title block, zoning table, and ALL schedule tables.

AREA DEFINITIONS — CRITICAL (wrong values here corrupt ALL cost calculations):
- gfa = TOTAL Gross Floor Area of the ENTIRE BUILDING. ANY text saying "GFA", "Gross Floor Area", "Total Area", or "Zoning Floor Area" with a number → that number is gfa. NEVER leave gfa null if any total building area is shown.
- footprint = gross area of ONE SINGLE FLOOR (floor plate only). Only use for per-floor area.
- nsf = TOTAL Net SF of the ENTIRE BUILDING (all floors). floors = above-grade story count.
- CRITICAL: "GFA: 71,000 SF" + "Floor: 8,000 SF" → gfa=71000, footprint=8000. NEVER put a large total in footprint.
- If only ONE area number visible and unsure if total or per-floor → put it in gfa (safer).
- Per-floor table: SUM all rows → gfa. One row value → footprint.

UNIT COUNT — HIGHEST PRIORITY:
- Find any table with unit types (Studio/1BR/2BR/3BR/Apt/Unit/DU), read QTY/COUNT columns.
- Check Zoning Analysis Table for total DU, check title block and general notes.
- Sum all types: "2BR:20 + 1BR:34 + 3BR:11" → units=65. Never return null if any count found.
- NYC filed plans often state a total like "TOTAL SEVENTY FIVE (75) CLASS \"A\" DWELLING UNITS" — the number is spelled out with the numeral in parentheses; use the numeral. If per-floor lines each state their own count (e.g. "9TH FLOOR: TEN (10) DWELLING UNITS"), sum them as a cross-check but report the explicit total when both are present.
- Do NOT infer units by counting doors, rooms, or symbols on an individual floor-plan drawing — that consistently overcounts and should never be used as the source for this field.

SCHEDULES: read every row, no skipping. Windows: sum QTY all rows of a WINDOW SCHEDULE table only (never count window symbols on a plan; null if no window schedule). Doors: 3 separate counts (entry/stair/interior) — ONLY from a DOOR SCHEDULE table; never count door symbols on a plan for these fields (leave null if there is no door schedule). HVAC: CU outdoor + AH indoor separate, ONLY from an HVAC/mechanical equipment schedule (null if none). Unreadable table → -1. Not present → null.

Return ONE JSON object, no markdown:
{"projectName":string|null,"dobJob":string|null,"borough":"Manhattan"|"Brooklyn"|"Queens"|"Bronx"|"Staten Island"|null,"address":string|null,"gfa":number|null,"nsf":number|null,"footprint":number|null,"floors":number|null,"cellar":0|1|null,"units":number|null,"f2f":number|null,"perimeter":number|null,"worktype":"new"|"conversion"|"gut"|"partial"|null,"constructionType":"I-A"|"I-B"|"II-A"|"II-B"|"III-A"|"III-B"|"V"|null,"occupancy":"R-2"|"R-3"|"B"|"A"|"M"|"I"|null,"court":0|1|null,"windows":number|null,"doorsEntry":number|null,"doorsStair":number|null,"doorsInterior":number|null,"hvacCondensers":number|null,"hvacIndoor":number|null,"exhaustFans":number|null,"elevators":number|null,"floorAreas":[{"name":string,"gross":number|null,"net":number|null}]|null,"sheetNumber":string|null,"sheetKind":"floor_plan"|"other","floorLabel":string|null,"typicalFloors":number|null,"excavationDepth":number|null,"soeLF":number|null,"underpinningLF":number|null,"pileCount":number|null}
SHEET: sheetNumber = drawing number in the title block (e.g. "A-101.00"). sheetKind="floor_plan" ONLY for a full architectural PROPOSED/NEW floor plan of one building level (cellar, 1st, 2nd, typical, penthouse). Everything else is "other": reflected ceiling plans, demolition/existing plans, enlarged or partial plans, roof/bulkhead plans, site/zoning, sections, elevations, details, schedules, structural and MEP sheets. floorLabel = the level shown (e.g. "1ST FLOOR"). typicalFloors = how many levels this one plan represents (e.g. "TYPICAL 2ND-4TH FLOOR PLAN" → 3; otherwise 1).
FOUNDATION SUPPORT (structural FO-/S-/SOE- sheets, sections, foundation & pile plans, notes): excavationDepth = feet from grade to the bottom of excavation / cellar slab (e.g. cellar slab at -11'-6" → 11.5). soeLF = total length in LF of sheeting/shoring/soldier piles/SOE shown. underpinningLF = total LF of adjacent building walls to be underpinned. pileCount = number of piles on the pile/foundation plan (count every pile symbol or read the pile schedule). null if the sheet doesn't show it.
JSON only. No extra text.`;

/* ============ DOOR COUNT FROM FLOOR PLANS ============ */
// Used when the set has no door schedule. Each floor-plan sheet is re-rendered
// at high resolution and split into tiles, because door tags and swing arcs are
// too small to read on a whole-sheet image. Tiles don't overlap; each door is
// counted only in the tile that contains its hinge.
let planInfo=null;
const PLAN_TILE_PROMPT=`You are counting items on ONE TILE cut from an architectural floor plan. Tiles do not overlap, so count only what belongs to THIS tile as defined below.

1) DOORS — an opening in a wall with a thin straight leaf line and a quarter-circle swing arc. Double doors = ONE door. Sliding/pocket/bifold doors (thin rectangles or zigzags in an opening) count too. Door tags are small circles with letter+number (C1, B2) — use them to confirm, but also count untagged doors. Count a door only if its opening is inside this tile. Do NOT count cabinet/appliance doors, elevator doors or access panels. Classify:
 - stair: door into a stair enclosure, or a fire-rated door at a stair/elevator lobby or rated corridor.
 - entry: building street entrance/exit, or the door from a public corridor/lobby/foyer INTO a dwelling unit.
 - interior: every other door.
2) WINDOWS — window openings in exterior walls or court walls (parallel thin lines across the wall thickness, often with a hexagon window tag or "SP" note). Count each separate window opening once; a mulled pair counts as its units. Count a window only if its opening is inside this tile. Do NOT count openings noted to be closed up/infilled/removed, doors, louvers or skylights.
3) acRooms — rooms INSIDE DWELLING UNITS that are at least 8'-0" x 8'-0" (at least 64 SF, neither side under 8') AND have at least one window. Typical: bedrooms, living/dining rooms, studies; a kitchen or other room also counts if it meets both rules. Rooms with "LIGHT PROP." / "VENT PROP." notes have windows. Use the printed SF and dimensions. Do NOT count bathrooms, closets, foyers, halls, corridors, stairs, lobbies, or any room without a window. Count a room only if its NAME LABEL (e.g. "BEDROOM 92 SF") is inside this tile.

Return JSON only: {"entry":number,"stair":number,"interior":number,"windows":number,"acRooms":number}`;
const PLAN_KEYS=['entry','stair','interior','windows','acRooms'];

async function renderPageCanvas(entry,pageIdx,longSide){
  if(entry.file&&entry.file.type==='application/pdf'){
    const pdfjs=await ensurePdfJs();
    if(!entry._pdf) entry._pdf=await pdfjs.getDocument({data:await entry.file.arrayBuffer()}).promise;
    const page=await entry._pdf.getPage(pageIdx+1);
    const base=page.getViewport({scale:1});
    const vp=page.getViewport({scale:longSide/Math.max(base.width,base.height)});
    const c=document.createElement('canvas'); c.width=Math.ceil(vp.width); c.height=Math.ceil(vp.height);
    const ctx=c.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
    await page.render({canvasContext:ctx,viewport:vp}).promise;
    return c;
  }
  // uploaded image: use the stored page image as-is
  const pg=entry.images&&entry.images[pageIdx]; const b64=(typeof pg==='string')?pg:(pg&&pg.img);
  const img=await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error('image decode failed')); i.src='data:image/jpeg;base64,'+b64; });
  const c=document.createElement('canvas'); c.width=img.width; c.height=img.height; c.getContext('2d').drawImage(img,0,0);
  return c;
}

async function countOnSheet(entry,pageIdx,onTile){
  const c=await renderPageCanvas(entry,pageIdx,3600);
  const cols=c.width>=c.height?3:2, rows=c.width>=c.height?2:3;
  const tw=Math.ceil(c.width/cols), th=Math.ceil(c.height/rows);
  const tiles=[];
  for(let r=0;r<rows;r++) for(let q=0;q<cols;q++){
    const t=document.createElement('canvas'); t.width=Math.min(tw,c.width-q*tw); t.height=Math.min(th,c.height-r*th);
    t.getContext('2d').drawImage(c,q*tw,r*th,t.width,t.height,0,0,t.width,t.height);
    tiles.push(t.toDataURL('image/jpeg',0.9).split(',')[1]);
  }
  const tot={entry:0,stair:0,interior:0,windows:0,acRooms:0}; let ok=0, done=0;
  const run=async b64=>{
    for(let attempt=0;attempt<2;attempt++){
      try{
        const j=parseJSON(await callExtractor([{media_type:'image/jpeg',data:b64}],'',PLAN_TILE_PROMPT));
        if(j){ PLAN_KEYS.forEach(k=>{ const v=+j[k]; if(v>0&&v<200) tot[k]+=Math.round(v); }); ok++; }
        break;
      }catch(e){ if(attempt===1) console.warn('plan tile failed',e); }
    }
    done++; if(onTile) onTile(done,tiles.length);
  };
  for(let i=0;i<tiles.length;i+=3) await Promise.all(tiles.slice(i,i+3).map(run));  // 3 at a time
  return ok?tot:null;
}

async function countFromPlans(results,msg,sub){
  const seen=new Set(); const plans=[];
  results.forEach(r=>{
    if(!r||r.sheetKind!=='floor_plan'||!r._entry||typeof r._page!=='number') return;
    const key=(r.sheetNumber||'').replace(/\s/g,'').toUpperCase()||(r._entry.name+'#'+r._page);
    if(seen.has(key)) return; seen.add(key); plans.push(r);
  });
  const out={entry:0,stair:0,interior:0,windows:0,acRooms:0,sheets:[]};
  let fin=0;
  const res=await pool(plans,2,async(r)=>{
    const label=r.sheetNumber||r.floorLabel||('page '+(r._page+1));
    const t=await countOnSheet(r._entry,r._page,(d,n)=>{ if(sub) sub.textContent=label+' — section '+d+' of '+n; });
    fin++; if(msg) msg.textContent=`Counting doors, windows & rooms — ${fin} of ${plans.length} floor plans done…`;
    return {r,label,t};
  });
  res.forEach(({r,label,t})=>{
    if(!t) return;
    const mult=(typeof r.typicalFloors==='number'&&r.typicalFloors>1&&r.typicalFloors<60)?Math.round(r.typicalFloors):1;
    PLAN_KEYS.forEach(k=>{ out[k]+=t[k]*mult; });
    out.sheets.push({sheet:label,mult,...t});
  });
  return out;
}
function planBasis(k){ return (planInfo&&planInfo[k]==='plans')?(k==='ac'?'Rooms ≥8×8 with window (plans)':'Counted from floor plans'):'Count from schedule'; }
function esc2(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

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
  setV('m-gfa',nb(p.gfa)); setV('m-nsf',nb(p.nsf)); setV('m-footprint',nb(p.footprint));
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
  setV('m-exc-depth',nb(p.excavationDepth)); setV('m-soe-lf',nb(p.soeLF));
  setV('m-underpin-lf',nb(p.underpinningLF)); setV('m-piles',nb(p.pileCount));
  // reflect cross-derived areas into blank fields so they're visible & editable
  const gv=id=>+getV(id)||0;
  if(gv('m-gfa')<=0 && gv('m-footprint')>0 && gv('m-floors')>0) setV('m-gfa',Math.round(gv('m-footprint')*gv('m-floors')));
  if(gv('m-footprint')<=0 && gv('m-gfa')>0 && gv('m-floors')>0) setV('m-footprint',Math.round(gv('m-gfa')/gv('m-floors')));
  // NSF is never assumed: if the plans do not state it, it stays blank for per-floor entry.
  if(Array.isArray(p.floorAreas)) applyExtractedFloors(p.floorAreas);
  const unreadable=[];
  const FIELD_LABELS={gfa:'Total GFA',nsf:'Net SF',footprint:'Floor plate',floors:'Floors',
    units:'Unit count',windows:'Window schedule',doorsEntry:'Entry doors',doorsStair:'Stair/fire doors',
    doorsInterior:'Interior doors',hvacCondensers:'HVAC condensers',hvacIndoor:'HVAC indoor units',
    exhaustFans:'Exhaust fans',elevators:'Elevators'};
  const ID_MAP={gfa:'m-gfa',nsf:'m-nsf',footprint:'m-footprint',floors:'m-floors',units:'m-units',
    windows:'m-windows',doorsEntry:'m-doors-entry',doorsStair:'m-doors-stair',
    doorsInterior:'m-doors-int',hvacCondensers:'m-hvac-cu',hvacIndoor:'m-hvac-ah',
    exhaustFans:'m-exhaust',elevators:'m-elev'};
  Object.keys(FIELD_LABELS).forEach(k=>{
    if(p[k]===-1){ setV(ID_MAP[k],''); unreadable.push(FIELD_LABELS[k]); }
  });
  const w=document.getElementById('unreadable-warn');
  if(w){ if(unreadable.length){ w.innerHTML='<strong>\u26a0 AI saw these schedules but could not read them clearly \u2014 enter manually:</strong> '+unreadable.join(', '); w.classList.remove('hidden'); }
         else { w.classList.add('hidden'); } }
}

function clearMetrics(){
  planInfo=null;
  ['m-name','m-job','m-gfa','m-nsf','m-footprint','m-floors','m-units','m-f2f','m-perim',
   'm-windows','m-doors-entry','m-doors-stair','m-doors-int','m-hvac-cu','m-hvac-ah','m-exhaust','m-elev','m-exc-depth','m-soe-lf','m-underpin-lf','m-piles']
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
/* OPEN-SHOP loaded labor rates ($/hr, wage + burden) — Brooklyn residential,
   representative 2025-26. Editable per trade in the wage table. For union work
   set the labor-rate multiplier to ~1.4, or edit trades individually. */
const TRADE_RATE={
  laborer:52, operator:95, concrete:68, ironworker:82, carpenter:68, mason:72,
  roofer:62, glazier:75, insulation:58, drywall:60, tile:68, flooring:60,
  painter:55, millwork:70, plumber:88, sprinkler:85, hvac:82, electrician:85,
  elevator:115, abatement:70
};
const TRADE_DEFAULTS=Object.assign({},TRADE_RATE);   // open-shop NYC (default)
const UNION_RATE={
  laborer:75, operator:130, concrete:90, ironworker:115, carpenter:95, mason:98,
  roofer:85, glazier:100, insulation:80, drywall:88, tile:92, flooring:82,
  painter:78, millwork:95, plumber:122, sprinkler:115, hvac:115, electrician:120,
  elevator:145, abatement:95
};
function setRateMode(mode){
  const src=(mode==='union')?UNION_RATE:TRADE_DEFAULTS;
  Object.keys(src).forEach(k=>TRADE_RATE[k]=src[k]);
  renderWages(); recalc();
}
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
  '00':{crew:6,phase:1}, '00b':{crew:10,phase:2,daysPerFloor:7}, '00c':{crew:8,phase:3},
  '02':{crew:7,phase:1}, '04':{crew:5,phase:2}, '06':{crew:6,phase:2},
  '05':{crew:4,phase:3}, '07':{crew:4,phase:3}, '08':{crew:5,phase:3},
  '21/22':{crew:7,phase:4}, '23':{crew:7,phase:4}, '26':{crew:7,phase:4},
  '09':{crew:18,phase:5}, '12':{crew:5,phase:6}, '11':{crew:6,phase:6}, '14':{crew:3,phase:6}
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
  // Only cross-derive GFA if result is plausible — footprint>20k SF means Claude
  // likely misread the total building area as footprint; skip the multiply.
  if(g.gfa<=0 && g.footprint>0 && g.floors>0 && g.footprint<=20000){
    var derived=g.footprint*g.floors;
    if(derived<=150000) g.gfa=derived;
  }
  if(g.footprint<=0 && g.gfa>0 && g.floors>0) g.footprint=Math.round(g.gfa/g.floors);
  // Excavation & foundation support. Blank = auto default; an entered 0 means "none".
  const raw=id=>{ const v=String(getV(id)==null?'':getV(id)).trim(); return v===''?null:Math.max(0,+v||0); };
  const P=g.perim>0?g.perim:Math.round(Math.sqrt(Math.max(g.footprint,0))*4);
  g.excDepthSet=raw('m-exc-depth')!==null; g.soeSet=raw('m-soe-lf')!==null; g.underpinSet=raw('m-underpin-lf')!==null;
  g.excDepth=g.excDepthSet?raw('m-exc-depth'):(g.cellar?12:4);
  g.soeLF=g.soeSet?raw('m-soe-lf'):(g.cellar?P:0);
  g.underpinLF=g.underpinSet?raw('m-underpin-lf'):(g.cellar?Math.round(P*0.5):0);
  g.piles=raw('m-piles')||0;
  // NSF is never assumed. If missing, net-based lines price at 0 and a warning shows.
  return g;
}

// PARTFACTOR (LF partition per SF floor) and wall height factor
const PARTFACTOR=0.30, WALLHT_RATIO=0.83; // residential 0.30 LF partition/SF net; clear wall ht ≈ 0.83 × f2f

/* Framing / sheetrock / paint quantities.
   If walls were measured on the plans (walls.js → window.wallPlan) those LF are used;
   floors not yet measured keep the factor so the estimate is never short. */
function wallQuantities(m,wallht){
  const factorLF=m.nsf*PARTFACTOR;
  const est={measured:false, framingLF:factorLF, gwbSF:(factorLF*wallht*2)+m.nsf,
    basisFrame:'Net area × '+PARTFACTOR.toFixed(2)+' LF/SF (factor estimate — not measured)',
    basisGwb:'Factor LF × ht × 2 + ceilings (estimate — not measured)'};
  try{
    if(window.WallsCore && window.wallPlan){
      let ft=0; try{ ft=floorRows.length; }catch(e){}
      if(!ft) ft=(m.floors||1)+(m.cellar?1:0);
      const q=window.WallsCore.quantities(window.wallPlan,m,wallht,PARTFACTOR,ft);
      if(q) return q;
    }
  }catch(e){ console.warn('wall measurements ignored:',e); }
  return est;
}

/* Excavation, SOE, underpinning and piles. New construction always gets
   excavation + auto-defaulted SOE/underpinning; existing buildings (cellar
   lowering, additions) only get the lines the user or the plans set. */
function excavationItems(m,explicitOnly){
  const it=[]; const d=m.excDepth;
  if(!explicitOnly||m.excDepthSet) if(d>0) it.push({n:'Excavation & soil export', basis:`Footprint × ${d} ft depth ÷ 27`, qty:m.footprint*d/27, u:'CY', p:55, mh:0.12, trade:'operator', src:'Dig, load & truck off-site'});
  if(!explicitOnly||m.soeSet) if(m.soeLF>0&&d>0) it.push({n:'Support of excavation (SOE) — soldier piles & lagging', basis:`${Math.round(m.soeLF)} LF × ${d} ft deep`, qty:m.soeLF*d, u:'SF', p:95, mh:0.25, trade:'operator', src:'Sheeting & shoring, face SF'});
  if(!explicitOnly||m.underpinSet) if(m.underpinLF>0) it.push({n:'Underpinning of adjacent buildings', basis:'LF of neighbor foundation walls', qty:m.underpinLF, u:'LF', p:1800, mh:10, trade:'concrete', src:'Hand-dug pits, sequenced'});
  if(m.piles>0) it.push({n:'Piles (steel pipe / helical, installed)', basis:'Count from foundation plan', qty:m.piles, u:'EA', p:6500, mh:12, trade:'operator', src:'Incl. load test allowance'});
  return it;
}


/* Lines taken from the owner's 14-month cost schedule (≈49,000 SF project). Each is the schedule
   dollar amount spread over that project's GFA, so it scales with size. All editable in the table. */
const SCHED_SF=49000;
function schedItem(n,total,trade,laborShare,extra){
  const p=Math.round(total/SCHED_SF*100)/100;
  return Object.assign({n, basis:'GFA SF · $'+p.toFixed(2)+'/SF (from your schedule: $'+Math.round(total/1000)+'k ÷ '+SCHED_SF.toLocaleString('en-US')+' SF)',
    qty:null, u:'SF', p, fixed:true, mh:Math.round(p*laborShare/(TRADE_RATE[trade]||60)*10000)/10000, trade, src:'Your cost schedule'},extra||{});
}
function scheduleDivs(m,isNew){
  const L=(it)=>{ it.qty=m.gfa; return it; };
  const out=[];
  out.push({div:'00 · Site Logistics, Protection & Utilities', items:[
    L(schedItem('Fences & gates',20000,'laborer',0.5)),
    L(schedItem('Sidewalk shed',75000,'carpenter',0.45)),
    L(schedItem('Scaffolding',90000,'laborer',0.55)),
    !isNew && L(schedItem('Water & sewer connections',55000,'plumber',0.5)),
    isNew && L(schedItem('Debris removal (construction)',175000,'laborer',0.35)),
  ].filter(Boolean)});
  out.push({div:'07 · Stucco & Rooftop', items:[
    L(schedItem('Stucco',150000,'mason',0.6)),
    L(schedItem('Rooftop (finish, pavers, rails)',100000,'roofer',0.5)),
  ]});
  out.push({div:'09 · Millwork & Closets', items:[
    L(schedItem('Moldings',75000,'carpenter',0.55)),
    L(schedItem('Closets & shelves',55000,'millwork',0.45)),
  ]});
  out.push({div:'23 · Refuse & Ventilation', items:[
    L(schedItem('Refuse system & ventilation',90000,'hvac',0.45)),
  ]});
  out.push({div:'26 · Low-Voltage', items:[
    L(schedItem('Camera & intercom system',55000,'electrician',0.45)),
  ]});
  out.push({div:'12 · Site Completion', items:[
    L(schedItem('New sidewalk',45000,'concrete',0.5)),
    L(schedItem('Landscaping',10000,'laborer',0.5)),
  ]});
  return out;
}

// Each item now carries: mh (man-hours per unit) and trade (for labor rate).
function buildTakeoff(m){
  const wallht=m.f2f*WALLHT_RATIO;
  const isNew=m.worktype==='new';
  const divs=[];

  if(isNew){
    divs.push({div:'00 · Sitework, Excavation & Foundations', items:[
      ...excavationItems(m),
      {n:'Foundation (footings, mat, walls)', basis:'Footprint SF · mandatory $45/SF', qty:m.footprint, u:'SF', p:45, fixed:true, mh:0.30, trade:'concrete', src:'Mandatory $45/SF (fixed)'},
      {n:'Below-grade waterproofing', basis:'Footprint SF', qty:m.footprint, u:'SF', p:14, mh:0.05, trade:'laborer', src:'Foundation walls+slab'},
      {n:'Utility connections', basis:'Lump', qty:1, u:'LS', p:185000, mh:350, trade:'laborer', src:'ConEd/DEP taps'},
    ]});
    divs.push({div:'00b · Superstructure', items:[
      {n:'Concrete superstructure — frame, slabs & roof deck', basis:'GFA SF · mandatory $45/SF', qty:m.gfa, u:'SF', p:45, fixed:true, mh:0.30, trade:'concrete', src:'Mandatory $45/SF (fixed)'},
    ]});
    divs.push({div:'00c · Exterior Envelope', items:[
      {n:'Exterior facade (new skin)', basis:'Perim × ht × floors × 90%', qty:(m.perim>0?m.perim:Math.sqrt(m.footprint)*4)*m.f2f*m.floors*0.90, u:'SF', p:55, mh:0.30, trade:'glazier', src:'Curtain wall/masonry/panel'},
      {n:'Air/vapor barrier & insulation', basis:'Perim × ht × floors × 90%', qty:(m.perim>0?m.perim:Math.sqrt(m.footprint)*4)*m.f2f*m.floors*0.90, u:'SF', p:16, mh:0.05, trade:'insulation', src:'Continuous insulation'},
    ]});
  }else{
    const exc=excavationItems(m,true);
    if(exc.length) divs.push({div:'00 · Excavation & Foundation Support', items:exc});
    divs.push({div:'02 · Demolition', items:[
      {n:'Selective interior demolition', basis:'Net area × 40%', qty:m.nsf*0.40, u:'SF', p:9, mh:0.07, trade:'laborer', src:'Partial demo, factored'},
      {n:'Debris removal & disposal', basis:'1 CY / 35 SF demo', qty:(m.nsf*0.40)/35, u:'CY', p:95, mh:0.45, trade:'laborer', src:'NYC C&D disposal'},
      {n:'Asbestos / hazmat abatement', basis:'Net area (if pre-1980)', qty:m.nsf, u:'SF', p:16, mh:0.10, trade:'abatement', src:'Confirm w/ survey'},
    ]});
    divs.push({div:'04 · Masonry', items:[
      {n:'Brick repointing — facade', basis:'Perim × ht × floors × 30%', qty:m.perim*m.f2f*m.floors*0.30, u:'SF', p:28, mh:0.17, trade:'mason', src:'Existing brick retained'},
      {n:'New CMU bearing/shaft walls', basis:'Shaft 4 sides × ht × floors', qty:4*m.f2f*m.floors, u:'SF', p:38, mh:0.16, trade:'mason', src:'Rated CMU'},
    ]});
    divs.push({div:'06 · Wood & Timber', items:[
      {n:'Existing floor structure mod / reinf', basis:'Net resi area', qty:m.nsf, u:'SF', p:12, mh:0.07, trade:'carpenter', src:'Modify/fire-treat existing'},
      {n:'Blocking, backing, rough carpentry', basis:'Net area × 0.5', qty:m.nsf*0.5, u:'SF', p:3.5, mh:0.022, trade:'carpenter', src:'Backing for fixtures'},
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
    !isNew && {n:'Windows (replacement)', basis:planBasis('windows'), qty:m.windows, u:'EA', p:2750, mh:3, trade:'glazier', src:'Window schedule'},
    {n:'Apartment / entry doors (metal)', basis:planBasis('doors'), qty:m.doorsEntry, u:'EA', p:400, mh:3.5, trade:'carpenter', src:'Metal door'},
    {n:'Stair / fire-rated doors (metal)', basis:planBasis('doors'), qty:m.doorsStair, u:'EA', p:400, mh:3.5, trade:'carpenter', src:'Metal door'},
    {n:'Interior doors (solid wood)', basis:planBasis('doors'), qty:m.doorsInt, u:'EA', p:300, mh:1.3, trade:'carpenter', src:'Solid wood door'},
    ...courtItem,
  ].filter(Boolean)});

  const wq=wallQuantities(m,wallht);
  divs.push({div:'09 · Finishes', items:[
    {n:'Metal stud partition framing', basis:wq.basisFrame, qty:wq.framingLF, u:'LF', p:9.8, mh:0.075, trade:'drywall', src:'3-5/8" steel stud · mkt-adj −30%'},
    {n:'Gypsum board (5/8" Type X)', basis:wq.basisGwb, qty:wq.gwbSF, u:'SF', p:2.28, mh:0.016, trade:'drywall', src:'Both faces + ceiling · mkt-adj −30%'},
    {n:'Porcelain tile — bath & kitchen', basis:'Units × 120 SF', qty:m.units*120, u:'SF', p:19.6, mh:0.14, trade:'tile', src:'Bath/kitchen tile · mkt-adj −30%'},
    {n:'Engineered wood flooring', basis:'Net area − tile area', qty:Math.max(m.nsf-m.units*120,0), u:'SF', p:10.5, mh:0.03, trade:'flooring', src:'Living/bedroom · mkt-adj −30%'},
    {n:'Painting — walls & ceilings', basis:'GWB area', qty:wq.gwbSF, u:'SF', p:1.30, mh:0.011, trade:'painter', src:'2 coats · mkt-adj −30%'},
    {n:'Specialty ceilings / soffits', basis:'≈40 LF per unit', qty:m.units*40, u:'LF', p:129.5, mh:0.28, trade:'drywall', src:'HVAC soffits · mkt-adj −30%'},
  ]});

  divs.push({div:'11 · Kitchens, Baths & Appliances', items:[
    {n:'Kitchen casework & countertops', basis:'Per unit', qty:m.units, u:'EA', p:5000, mh:15, trade:'millwork', src:'Mid-grade'},
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
    {n:'Indoor AC units (1 per room)', basis:planBasis('ac'), qty:m.ah, u:'EA', p:1700, mh:9, trade:'hvac', src:'Per unit zones (avg)'},
    {n:'Exhaust fans (kitchen + bath)', basis:'Count from schedule', qty:m.exh, u:'EA', p:320, mh:1.7, trade:'hvac', src:'Vented to roof'},
    {n:'Refrigerant piping & insulation', basis:'Per indoor unit', qty:m.ah, u:'EA', p:1200, mh:7, trade:'hvac', src:'R-410A insulated'},
    {n:'Exhaust ductwork & goosenecks', basis:'Per exhaust fan', qty:m.exh, u:'EA', p:2200, mh:9, trade:'hvac', src:'Roof terminations'},
    {n:'Install, controls, balancing (TAB)', basis:'Lump', qty:1, u:'LS', p:95000, mh:380, trade:'hvac', src:'Commissioning'},
  ]});

  divs.push({div:'26 · Electrical', items:[
    {n:'Electrical (service, distribution, units, fixtures, fire alarm)', basis:'GFA SF · $12/SF (set)', qty:m.gfa, u:'SF', p:12, fixed:true, mh:0.05, trade:'electrician', src:'$12/SF flat'},
  ]});

  scheduleDivs(m,isNew).forEach(d=>divs.push(d));
  return divs;
}

/* ============ LABOR & SCHEDULE COMPUTATION ============ */
function computeLabor(divs,m){
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
    let days=sched.crew>0 ? hrs/(sched.crew*HRS_PER_DAY) : 0;
    if(sched.daysPerFloor && m && m.floors>0) days=Math.max(days, sched.daysPerFloor*m.floors);
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
  if(field==='excl'){
    o.excl=!o.excl;
  } else if(val===''){
    o[field]=null; // user cleared — keep blank, don't fall back to computed
  } else {
    o[field]=+val;
  }
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
  const nw=document.getElementById('nsf-warn');
  if(nw) nw.classList.toggle('hidden', m.nsf>0);
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
      const qty=(o.qty!=null?o.qty:(o.qty===null?0:it.qty));
      const price=(o.p!=null?o.p:(o.p===null?0:it.p));
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
        <td class="num"><input class="cell" type="text" inputmode="decimal" value="${o.qty===null?'':qty}" onchange="setOv('${id}','qty',this.value)" onkeydown="if(event.key==='Enter'){setOv('${id}','qty',this.value);this.blur();}" onfocus="this.select()" onclick="this.select()"></td>
        <td>${esc(it.u)}</td>
        <td class="num"><input class="cell" type="number" step="any" value="${o.p===null?'':price}" oninput="setOv('${id}','p',this.value)"></td>
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
  const lab=computeLabor(divs,m);
  lastLabor=lab;
  renderLabor(lab);

  lastRows=exportRows;
  lastTotals={direct,gc,op,cont,grand,psf,gcPct,opPct,contPct,m,matTot,labTot,marginPct,sell};
  try{ renderMarketCompare(); }catch(e){ console.warn(e); }
}

/* ============ MARKET REPORT (no company pricing rules) ============ */
// Current NYC market installed prices for the lines where our own rules apply.
// Lines tagged "mkt-adj −30%" are restored to full market (÷0.7). Everything
// else is already priced at market. Location factor applies to every line.
const MARKET_PRICE={
  'Foundation (footings, mat, walls)':70,
  'Concrete superstructure — frame, slabs & roof deck':65,
  'Plumbing systems (units, risers, common, DHW)':35,
  'Fire sprinkler (NFPA 13R)':9,
  'Electrical (service, distribution, units, fixtures, fire alarm)':32,
  'Apartment / entry doors (metal)':2800,
  'Stair / fire-rated doors (metal)':3200,
  'Interior doors (solid wood)':1100,
  'Kitchen casework & countertops':12000,
};
function marketPrice(it){
  if(it.custom) return it.p;
  if(MARKET_PRICE[it.n]!=null) return MARKET_PRICE[it.n];
  if(/mkt-adj/.test(it.src||'')) return Math.round(it.p/0.7*100)/100;
  return it.p;
}
function computeMarket(){
  const m=metrics(); const locMult=m.boro*m.ctype*m.occ;
  const divs=buildTakeoff(m);
  customRows.forEach((c,i)=>{ let d=divs.find(x=>x.div===c.div); if(!d){ d={div:c.div,items:[]}; divs.push(d); } d.items.push(Object.assign({},c,{_ci:i})); });
  const rows=[]; let direct=0,matTot=0,labTot=0;
  divs.forEach(d=>d.items.forEach(it=>{
    const id=slug(d.div.split('·')[0])+'-'+slug(it.n); const o=overrides[id]||{};
    const qty=(o.qty!=null?o.qty:(o.qty===null?0:it.qty));       // your quantity edits still apply
    const price=marketPrice(it);                                   // your price edits do not
    const excl=!!o.excl;
    const ext=excl?0:qty*price*locMult;
    let lab=excl?0:qty*(it.mh||0)*(TRADE_DEFAULTS[it.trade]||90);   // open-shop market wages, no adjustment
    if(lab>ext) lab=ext; const mat=Math.max(ext-lab,0);
    direct+=ext; matTot+=mat; labTot+=lab;
    rows.push({div:d.div,name:it.n,basis:it.basis||'',qty,unit:it.u,price,loc:locMult,mat,lab,ext,src:it.src||'',mh:it.mh,trade:it.trade,excl});
  }));
  const gcPct=+getV('gc-pct')||0, opPct=+getV('op-pct')||0, contPct=+getV('cont-pct')||0, marginPct=+getV('margin-pct')||0;
  const gc=direct*gcPct/100, op=(direct+gc)*opPct/100, pre=direct+gc+op, cont=pre*contPct/100, grand=pre+cont;
  const sell=marginPct>0&&marginPct<100?grand/(1-marginPct/100):grand;
  return {rows,totals:{direct,gc,op,cont,grand,psf:m.gfa>0?grand/m.gfa:0,gcPct,opPct,contPct,m,matTot,labTot,marginPct,sell}};
}
function renderMarketCompare(){
  const el=document.getElementById('mkt-compare'); if(!el||!lastTotals||!lastTotals.grand) return;
  const mk=computeMarket().totals; const ours=lastTotals.grand, diff=mk.grand-ours;
  el.innerHTML=`<div class="r"><span class="l">Current market estimate (no company rules)</span><span class="v">${fmtM(mk.grand)}</span></div>
    <div class="r"><span class="l">${diff>=0?'Our estimate is below market by':'Our estimate is above market by'}</span><span class="v">${fmtM(Math.abs(diff))} (${(Math.abs(diff)/mk.grand*100).toFixed(1)}%)</span></div>`;
}

/* ============ SEND TO DEAL BUILDER ============ */
function sendToDealBuilder(){
  if(!lastTotals||!lastTotals.grand){
    alert('Run the takeoff first — click "Run takeoff →" to compute costs before sending to Deal Builder.');
    return;
  }
  const m=lastTotals.m;
  const byDiv={};
  lastRows.filter(r=>!r.excl).forEach(r=>{
    const code=r.div.split('·')[0].trim();
    if(!byDiv[code]) byDiv[code]={div:r.div,items:[],total:0};
    byDiv[code].items.push({name:r.name,qty:+(+r.qty).toFixed(1),unit:r.unit,price:r.price,mat:Math.round(r.mat),lab:Math.round(r.lab),ext:Math.round(r.ext)});
    byDiv[code].total+=r.ext;
  });
  const payload={
    _source:'cestimator',_version:1,
    projectName:getV('m-name')||'',address:getV('m-name')||'',
    gba:m.gfa||0,nba:m.nsf||0,units:m.units||0,
    avgUnitSF:(m.units&&m.nsf)?Math.round(m.nsf/m.units):0,stories:m.floors||0,
    hardCostTotal:Math.round(lastTotals.grand),hardCostDirect:Math.round(lastTotals.direct),
    hardCostSF:m.gfa>0?Math.round(lastTotals.grand/m.gfa):0,
    gcPct:lastTotals.gcPct||0,opPct:lastTotals.opPct||0,contPct:lastTotals.contPct||0,
    totalLaborHrs:Math.round(lastLabor.totHrs||0),projWorkDays:Math.round(lastLabor.projWorkDays||0),
    totalLaborCost:Math.round(lastLabor.totLaborCost||0),
    divisions:Object.values(byDiv).map(d=>({code:d.div,total:Math.round(d.total),pct:lastTotals.direct>0?+(d.total/lastTotals.direct).toFixed(3):0,items:d.items})),
    windows:m.windows||0,doorsEntry:m.doorsEntry||0,doorsStair:m.doorsStair||0,
    doorsInt:m.doorsInt||0,hvacCU:m.cu||0,hvacAH:m.ah||0,exhaust:m.exh||0,elevators:m.elev||0,
    exportedAt:new Date().toISOString()
  };
  // Encode payload in URL hash — works cross-origin, no server needed
  // Compress: btoa(encodeURIComponent(JSON)) stays under 2KB for typical payloads
  var encoded = btoa(encodeURIComponent(JSON.stringify(payload)));
  window.open('https://roeipaz.com#cestimator=' + encoded, '_blank');
}

/* ============ TEMPLATES: save / load an estimate as JSON ============ */
function saveTemplate(){
  const data={v:3, metrics:{}, overrides, customRows, floors:floorRows.slice(), walls:window.wallPlan||null, wages:Object.assign({},TRADE_RATE),
    markups:{gc:getV('gc-pct'),op:getV('op-pct'),cont:getV('cont-pct'),margin:getV('margin-pct'),labor:getV('labor-mult')}};
  ['m-name','m-job','m-borough','m-gfa','m-nsf','m-footprint','m-floors','m-units','m-f2f','m-perim',
   'm-cellar','m-worktype','m-ctype','m-occ','m-court','m-windows','m-doors-entry','m-doors-stair',
   'm-doors-int','m-hvac-cu','m-hvac-ah','m-exhaust','m-elev','m-exc-depth','m-soe-lf','m-underpin-lf','m-piles'].forEach(id=>data.metrics[id]=getV(id));
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
      floorRows=(d.floors||[]).slice(); renderFloors();
      window.wallPlan = d.walls && Array.isArray(d.walls.records) ? d.walls : {records:[],faces:{}};
      if(window.refreshWallSummary) window.refreshWallSummary();
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
      'using typical values where not stated (e.g. windows per unit, doors per unit, HVAC units per unit). Return null only if you cannot reasonably infer.\n'+
      'IMPORTANT: there are no drawings or schedules here, so IGNORE every rule below that says to read counts only from a schedule — estimate windows, doors, HVAC units, exhaust fans, net SF and perimeter from typical NYC multifamily ratios.\n\n'+
      'PROJECT: '+desc+'\n\n'+EXTRACTION_PROMPT);
    const parsed=parseJSON(text);
    if(!parsed) throw new Error('could not parse');
    const assumed=fillDescriptionDefaults(parsed);
    fillMetrics(parsed);
    const el=document.getElementById('extract-note');
    if(el) el.innerHTML='<span class="ai-badge">From description</span> &nbsp;Values were inferred from your project description. <strong>Review every field</strong> — inferred numbers are assumptions, not measured takeoff. Edit anything, then run the takeoff.'+
      (assumed.length?'<br><br><strong>Filled with NYC rules of thumb</strong> (not stated in your description): '+assumed.join(' · ')+'.':'');
    hide('analyzing'); show('step-2'); setChip(2);
  }catch(e){
    hide('analyzing'); show('step-1');
    alert('Could not generate from the description ('+e.message+'). Enter the metrics manually instead.');
  }
}
// A written description has no drawings, so anything the AI left blank is
// filled with standard NYC multifamily ratios. Returns the list of what was assumed.
function fillDescriptionDefaults(p,keep){
  const a=[]; const ok=v=>typeof v==='number'&&v>0; keep=keep||[];
  const set=(k,v,label)=>{ if(!keep.includes(k)&&!ok(p[k])&&v>0){ p[k]=Math.round(v); a.push(label+' '+Math.round(v).toLocaleString()); } };
  if(!ok(p.floors)) set('floors',ok(p.gfa)&&ok(p.footprint)?p.gfa/p.footprint:0,'floors');
  if(!ok(p.gfa)&&ok(p.footprint)&&ok(p.floors)) set('gfa',p.footprint*p.floors,'GFA (SF)');
  if(!ok(p.footprint)&&ok(p.gfa)&&ok(p.floors)) set('footprint',p.gfa/p.floors,'footprint (SF)');
  const U=ok(p.units)?p.units:0, F=ok(p.floors)?p.floors:0;
  set('nsf',ok(p.gfa)?p.gfa*0.80:0,'net SF (80% of GFA)');
  set('perimeter',ok(p.footprint)?Math.sqrt(p.footprint)*4:0,'perimeter (LF)');
  if(!ok(p.f2f)){ p.f2f=10.5; a.push("floor-to-floor 10.5'"); }
  set('windows',U*5,'windows (5/unit)');
  set('doorsEntry',U?U+2:0,'entry doors (1/unit + 2)');
  set('doorsStair',F?F*2+(p.cellar===1?2:0):0,'stair doors (2/floor)');
  set('doorsInterior',U*6,'interior doors (6/unit)');
  set('hvacCondensers',U,'AC condensers (1/unit)');
  set('hvacIndoor',U*2.5,'AC indoor units (2.5 rooms/unit)');
  set('exhaustFans',U*2.5,'exhaust fans (2.5/unit)');
  return a;
}

async function callExtractorText(prompt){
  // Text-only call through the Netlify function (which holds the API key).
  const r=await postProxy({parts:[],prompt});
  let d=null; try{ d=await r.json(); }catch(_){}
  if(r.ok&&d&&typeof d.text==='string') return d.text;
  const why=(d&&d.error)||('server error '+r.status);
  throw new Error(r.status===504||r.status===502?'the AI took too long to answer — try a shorter description':why);
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
async function exportExcel(mode){
  if(mode==='market'){
    const mk=computeMarket(); const keep=[lastRows,lastTotals];
    lastRows=mk.rows; lastTotals=mk.totals; exportMode='market';
    try{ await exportExcelCore(keep[0]); } finally { lastRows=keep[0]; lastTotals=keep[1]; exportMode='rules'; }
    return;
  }
  exportMode='rules'; return exportExcelCore(null);
}
let exportMode='rules';
async function exportExcelCore(ruleRows){
  track('excel_export',{mode:exportMode});
  try{ await ensureXLSX(); }
  catch(e){ alert(e.message+'\n\nThe on-screen takeoff is unaffected — try the download again with an internet connection.'); return; }
  const {direct,gc,op,cont,grand,psf,gcPct,opPct,contPct,m}=lastTotals;
  const wb=XLSX.utils.book_new();

  // Sheet 1: Inputs
  const inAOA=[
    ['MATERIAL TAKEOFF — INPUTS & ASSUMPTIONS'],
    [exportMode==='market'?'REPORT BASIS: Current NYC market pricing & open-shop market labor — company pricing rules NOT applied':'REPORT BASIS: P National Group estimate — company pricing rules applied'],
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
  const specAOA=[['MATERIALS & SPECIFICATIONS'],[],['Division','Item','Material / type','Description','Qty','Unit']];
  specRows().forEach(r=>{ const sp=specFor(r.name); specAOA.push([r.div,r.name,sp.mat,sp.desc,Math.round((+r.qty||0)*10)/10,r.unit]); });
  const wsS=XLSX.utils.aoa_to_sheet(specAOA); wsS['!cols']=[{wch:30},{wch:42},{wch:60},{wch:60},{wch:10},{wch:6}];
  XLSX.utils.book_append_sheet(wb,wsS,'Materials & Specs');
  try{
    const e=electricalBreakdown();
    const ea=[['ELECTRICAL BREAKDOWN (NEC rules adopted by NYC Electrical Code)'],[],
      ['Totals','Qty'],['Receptacles (outlets)',e.totals.recs],['GFCI protected',e.totals.gfci],['Breakers (circuits)',e.totals.breakers],['Panels / switchboards',e.totals.panels],[],
      ['OUTLETS PER ROOM — typical unit','Rooms','Outlets each','Total','Type','Rule']];
    e.rooms.forEach(r=>ea.push([r.room+(r.sf?' (≈'+Math.round(r.sf)+' SF)':''),r.n,r.recs,r.n*r.recs,r.type,r.note]));
    ea.push(['Per unit','','',e.recsPerUnit,'× '+e.U+' units',''],[],['CIRCUITS — per unit panel','Breaker (A)','Poles','Qty','Protection']);
    e.circuits.forEach(x=>ea.push([x.c,x.amp,x.poles,x.qty,x.prot]));
    ea.push(['Per unit breakers','','',e.brkUnit,e.panelSpaces+'-space '+e.unitAmps+'A panel'],[],['COMMON AREAS — house panel','Breaker (A)','Poles','Qty']);
    e.house.forEach(x=>ea.push([x.c,x.amp,x.poles,x.qty]));
    ea.push([],['PANELS','Qty','Spec']); e.panels.forEach(p=>ea.push([p.p,p.qty,p.spec]));
    const wsE=XLSX.utils.aoa_to_sheet(ea); wsE['!cols']=[{wch:44},{wch:12},{wch:12},{wch:10},{wch:34},{wch:30}];
    XLSX.utils.book_append_sheet(wb,wsE,'Electrical Breakdown');
  }catch(err){ console.warn('electrical sheet',err); }
  try{
    const p=plumbingBreakdown();
    const pa=[['PLUMBING BREAKDOWN (NYC Plumbing Code)'],[],['Totals','Qty'],['Fixtures & connections',p.totals.fixtures],['Valves (in units)',p.totals.valves],
      ['Waste stacks',p.totals.stacks],['Drainage fixture units (DFU)',p.totals.dfu],[],['FIXTURES','Where','Per unit','Building']];
    p.fixtures.forEach(x=>pa.push([x.f,x.where,x.qty,x.qty*p.U]));
    pa.push([],['VALVES','Per unit','Building']); p.valves.forEach(x=>pa.push([x.v,x.qty,x.qty*p.U]));
    pa.push([],['RISERS & STACKS','Qty','Size','DFU each']); p.stacks.forEach(x=>pa.push([x.s,x.qty,x.size,x.dfu==null?'':x.dfu]));
    pa.push([],['BUILDING SERVICES','Qty','Spec']); p.common.forEach(x=>pa.push([x.c,x.qty,x.spec]));
    const wsP=XLSX.utils.aoa_to_sheet(pa); wsP['!cols']=[{wch:44},{wch:22},{wch:12},{wch:12}];
    XLSX.utils.book_append_sheet(wb,wsP,'Plumbing Breakdown');
  }catch(err){ console.warn('plumbing sheet',err); }
  if(exportMode==='market'&&ruleRows){
    const byName={}; ruleRows.forEach(r=>{ byName[r.div+'|'+r.name]=r; });
    const cmp=[['OUR ESTIMATE vs CURRENT MARKET'],[],['Division','Item','Our unit price','Market unit price','Our total','Market total','Difference']];
    let a=0,b=0;
    lastRows.filter(r=>!r.excl).forEach(r=>{ const o=byName[r.div+'|'+r.name]||{price:0,ext:0}; a+=o.ext; b+=r.ext;
      cmp.push([r.div,r.name,+(+o.price).toFixed(2),+(+r.price).toFixed(2),Math.round(o.ext),Math.round(r.ext),Math.round(r.ext-o.ext)]); });
    cmp.push([],['','DIRECT COST TOTAL','','',Math.round(a),Math.round(b),Math.round(b-a)]);
    const wsC=XLSX.utils.aoa_to_sheet(cmp); wsC['!cols']=[{wch:30},{wch:44},{wch:14},{wch:16},{wch:14},{wch:14},{wch:14}];
    XLSX.utils.book_append_sheet(wb,wsC,'Ours vs Market');
  }
  XLSX.writeFile(wb, pname+(exportMode==='market'?'_MARKET_takeoff.xlsx':'_material_takeoff.xlsx'));
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


/* ============ PER-FLOOR NET AREA (measured values only) ============ */
/* Gross and net per floor come from the plan floor-area / zoning analysis
   table, the AI extraction of that table, or the user’s own measurements.
   NOTHING here is estimated: efficiency is computed FROM the numbers, and the
   totals write back to m-gfa / m-nsf only when EVERY floor has a value. */
let floorRows = [];   // {name, gross, net}

function createFloorRows(){
  const floors=Math.max(1, Math.round(+getV('m-floors')||0)), cellar=(+getV('m-cellar')||0)>=1;
  floorRows=[];
  if(cellar) floorRows.push({name:'Cellar', gross:0, net:0});
  for(let i=1;i<=floors;i++) floorRows.push({name:'Floor '+i, gross:0, net:0});
  renderFloors();
}
function addFloorRow(){ floorRows.push({name:'Level '+(floorRows.length+1), gross:0, net:0}); renderFloors(); }
function rmFloorRow(i){ floorRows.splice(i,1); renderFloors(); }
function setFloor(i,f,v){
  if(!floorRows[i]) return;
  floorRows[i][f] = (f==='name') ? v : (parseFloat(v)||0);
  updateFloorTotals();
}
function applyExtractedFloors(arr){
  const rows=(arr||[]).filter(function(f){return f&&(f.name||f.gross!=null||f.net!=null);})
    .map(function(f){return {name:String(f.name||'Level'),
      gross:(typeof f.gross==='number'&&f.gross>0)?f.gross:0,
      net:(typeof f.net==='number'&&f.net>0)?f.net:0};});
  if(rows.length){ floorRows=rows; renderFloors(); }
}
function renderFloors(){
  const tb=document.getElementById('floor-body'); if(!tb) return;
  tb.innerHTML=floorRows.map((r,i)=>
    '<tr>'+
    '<td><input class="cell" style="width:120px;text-align:left" value="'+esc(r.name)+'" oninput="setFloor('+i+',\'name\',this.value)"></td>'+
    '<td class="num"><input class="cell" type="number" step="any" value="'+(r.gross||'')+'" placeholder="from plans" oninput="setFloor('+i+',\'gross\',this.value)"></td>'+
    '<td class="num"><input class="cell" type="number" step="any" value="'+(r.net||'')+'" placeholder="from plans" oninput="setFloor('+i+',\'net\',this.value)"></td>'+
    '<td class="num" id="fl-effr-'+i+'">\u2014</td>'+
    '<td><button class="rm" title="Remove floor" onclick="rmFloorRow('+i+')">\u00d7</button></td>'+
    '</tr>').join('');
  updateFloorTotals();
}
function updateFloorTotals(){
  let g=0, nn=0, allG=floorRows.length>0, allN=floorRows.length>0;
  floorRows.forEach(function(r,i){
    g+=(r.gross||0); nn+=(r.net||0);
    if(!(r.gross>0)) allG=false;
    if(!(r.net>0)) allN=false;
    const el=document.getElementById('fl-effr-'+i);
    if(el) el.textContent=(r.gross>0&&r.net>0)?Math.round(r.net/r.gross*100)+'%':'\u2014';
  });
  setT('fl-tot-gross', g>0?fmtN(g)+' SF':'\u2014');
  setT('fl-tot-net', nn>0?fmtN(nn)+' SF':'\u2014');
  setT('fl-eff', (g>0&&nn>0)?Math.round(nn/g*100)+'%':'\u2014');
  // write back ONLY complete, measured totals; partial entry never overwrites.
  // "Complete" = every row filled AND the table covers every declared level
  // (floors + cellar), so a partially-read plan table can never replace totals.
  const declared = Math.round(+getV('m-floors')||0) + (((+getV('m-cellar')||0)>=1)?1:0);
  const covers = floorRows.length>0 && (declared<=0 || floorRows.length>=declared);
  // Don't overwrite extracted GFA/NSF with floor-table sum if top-level value already set
  const existingGFA = +getV('m-gfa')||0;
  const existingNSF = +getV('m-nsf')||0;
  if(allG && covers && (existingGFA<=0 || g<=existingGFA)) setV('m-gfa', Math.round(g));
  if(allN && covers && (existingNSF<=0 || nn<=existingNSF)) setV('m-nsf', Math.round(nn));
}

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


/* ============ 3D RENDERING MODAL ============ */
let _renderAnimId=null,_renderRenderer=null;

function openRendering(){
  if(!lastTotals||!lastTotals.m){ alert('Run the takeoff first.'); return; }
  const m=lastTotals.m;
  document.getElementById('rendering-modal').style.display='block';
  document.body.style.overflow='hidden';
  document.getElementById('render-title').textContent=(getV('m-name')||'Building')+' — 3D Rendering';
  document.getElementById('render-metrics-badge').textContent=m.floors+'F · '+fmtN(m.gfa)+' SF';
  buildSummaryPanel(m);
  init3DScene(m);
  generateAIImage();
}

function closeRendering(){
  document.getElementById('rendering-modal').style.display='none';
  document.body.style.overflow='';
  if(_renderAnimId){ cancelAnimationFrame(_renderAnimId); _renderAnimId=null; }
  if(_renderRenderer){ _renderRenderer.dispose(); _renderRenderer=null; }
}

function buildSummaryPanel(m){
  const items=[['GFA',fmtN(m.gfa)+' SF'],['Net SF',fmtN(m.nsf)+' SF'],['Floors',m.floors+' stories'],['Units',m.units+' DU'],['Hard cost',fmtM(lastTotals.grand)]];
  document.getElementById('render-summary').innerHTML=items.map(([k,v])=>
    '<div style="text-align:center"><div style="color:#556;font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">'+k+'</div><div style="color:#fff;font-size:15px;font-weight:600">'+v+'</div></div>'
  ).join('');
}

function init3DScene(m){
  if(typeof THREE==='undefined'){
    const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
    s.onload=function(){_build3D(m);};
    document.head.appendChild(s);
  } else { _build3D(m); }
}

function _build3D(m){
  if(_renderAnimId){ cancelAnimationFrame(_renderAnimId); _renderAnimId=null; }
  if(_renderRenderer){ _renderRenderer.dispose(); _renderRenderer=null; }
  const canvas=document.getElementById('render-canvas-3d');
  const W=Math.floor(canvas.getBoundingClientRect().width)||440;
  const H=340;
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
  renderer.setSize(W,H); renderer.setClearColor(0x0a1520,1);
  renderer.shadowMap.enabled=true; _renderRenderer=renderer;
  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(45,W/H,.1,1000);
  camera.position.set(18,12,22); camera.lookAt(0,0,0);
  scene.add(new THREE.AmbientLight(0x223355,1.2));
  const sun=new THREE.DirectionalLight(0xffeebb,2.5); sun.position.set(20,30,15); sun.castShadow=true; scene.add(sun);
  scene.add(new THREE.GridHelper(60,30,0x1a3050,0x1a3050));
  const gnd=new THREE.Mesh(new THREE.PlaneGeometry(80,80),new THREE.MeshLambertMaterial({color:0x0f2030}));
  gnd.rotation.x=-Math.PI/2; gnd.position.y=-.05; scene.add(gnd);
  const fp=m.footprint||4000, side=Math.sqrt(fp);
  const perim=m.perim||side*4, floors=m.floors||4, f2f=m.f2f||11;
  const aspect=Math.max(.5,Math.min(2,perim/(4*side)));
  const bW=side*aspect*.055, bD=side/aspect*.055, bH=floors*f2f*.028;
  const body=new THREE.Mesh(new THREE.BoxGeometry(bW,bH,bD),new THREE.MeshLambertMaterial({color:0x1a3a5c}));
  body.position.y=bH/2; body.castShadow=true; scene.add(body);
  for(let i=1;i<floors;i++){
    const lm=new THREE.Mesh(new THREE.BoxGeometry(bW+.05,.08,bD+.05),new THREE.MeshLambertMaterial({color:0x2d5f8a}));
    lm.position.y=i*(bH/floors); scene.add(lm);
  }
  const wMat=new THREE.MeshLambertMaterial({color:0x7bbfff,emissive:0x224466,emissiveIntensity:.5});
  const wPF=Math.max(2,Math.round((m.windows||20)/floors)), wSp=bW/(wPF+1);
  for(let f=0;f<floors;f++) for(let w=0;w<wPF;w++){
    const wn=new THREE.Mesh(new THREE.BoxGeometry(.18,.28,.05),wMat);
    wn.position.set(-bW/2+wSp*(w+1),f*(bH/floors)+(bH/floors*.6),bD/2+.01); scene.add(wn);
    const wb=wn.clone(); wb.position.z=-bD/2-.01; scene.add(wb);
  }
  const par=new THREE.Mesh(new THREE.BoxGeometry(bW+.2,.3,bD+.2),new THREE.MeshLambertMaterial({color:0x2a4a6a}));
  par.position.y=bH+.15; scene.add(par);
  const sw=new THREE.Mesh(new THREE.BoxGeometry(bW+8,.05,4),new THREE.MeshLambertMaterial({color:0x162535}));
  sw.position.set(0,0,bD/2+2); scene.add(sw);
  let isDrag=false,px=0,py=0,rotX=.3,rotY=.5,dist=28;
  canvas.onmousedown=e=>{isDrag=true;px=e.clientX;py=e.clientY;};
  window.onmouseup=()=>{isDrag=false;};
  window.onmousemove=e=>{if(!isDrag)return;rotY+=(e.clientX-px)*.008;rotX+=(e.clientY-py)*.006;rotX=Math.max(-.1,Math.min(1.1,rotX));px=e.clientX;py=e.clientY;};
  canvas.onwheel=e=>{dist=Math.max(8,Math.min(60,dist+e.deltaY*.05));};
  function animate(){ _renderAnimId=requestAnimationFrame(animate);
    camera.position.x=dist*Math.sin(rotY)*Math.cos(rotX);
    camera.position.y=dist*Math.sin(rotX)+3;
    camera.position.z=dist*Math.cos(rotY)*Math.cos(rotX);
    camera.lookAt(0,bH/2,0); renderer.render(scene,camera); }
  animate();
}

async function generateAIImage(){
  const m=lastTotals&&lastTotals.m; if(!m)return;
  const loading=document.getElementById('ai-render-loading');
  const err=document.getElementById('ai-render-error');
  const cap=document.getElementById('ai-render-caption');
  const btn=document.getElementById('regen-btn');
  const container=document.getElementById('ai-render-container');
  const oldSvg=document.getElementById('ai-render-svg'); if(oldSvg)oldSvg.remove();
  loading.style.display='flex'; loading.style.flexDirection='column';
  loading.style.alignItems='center'; loading.style.justifyContent='center';
  err.style.display='none'; btn.disabled=true;
  cap.textContent='Reading your plans and generating rendering…';

  // Sample pages spread across the WHOLE set, not just the first few — on a
  // real DOB filing the elevation sheets are usually well past the floor
  // plans (e.g. an A-3xx series partway through a 48-sheet set), so only
  // looking at the first 4 pages reliably misses them.
  const allImgs=[];
  for(const entry of files){
    if(entry.status==='done' && entry.images && entry.images.length){
      entry.images.forEach(img=>allImgs.push(img));
    }
  }
  const SAMPLE_N=10;
  let sampled=allImgs;
  if(allImgs.length>SAMPLE_N){
    sampled=[];
    for(let i=0;i<SAMPLE_N;i++) sampled.push(allImgs[Math.round(i*(allImgs.length-1)/(SAMPLE_N-1))]);
  }
  const planPages=sampled.map(img=>({type:'image',source:{type:'base64',media_type:'image/jpeg',data:img}}));

  const boro={1:'Manhattan',0.92:'Brooklyn',0.90:'Queens',0.86:'Bronx',0.84:'Staten Island'}[m.boro]||'Brooklyn';
  const wt={new:'new ground-up',conversion:'adaptive reuse / conversion',gut:'gut renovation',partial:'partial renovation'}[m.worktype]||'construction';

  let renderDesc=''; let elevationImg=null;
  if(planPages.length>0){
    // Ask Claude to both FIND the actual elevation sheet among the sampled
    // pages (by 1-based position) and describe it — so we can use that exact
    // page as a real image reference for generation, not just a text summary.
    const prompt='These are '+planPages.length+' sample pages (numbered 1 to '+planPages.length+' in the order given) from architectural plans for a '+m.floors+'-story, '+(m.units||0)+'-unit '+wt+' multifamily building in '+boro+', NYC ('+Math.round(m.gfa||0).toLocaleString()+' SF GFA). '+
      'Find the page that shows an exterior building ELEVATION — a front/street-facing view of the full facade (not a floor plan, not a section, not a site plan), usually labeled "ELEVATION". '+
      'Respond with ONLY compact JSON, no markdown: {"elevationPageNumber": <1-based number of that page, or null if none of these sampled pages show one>, "description": "3-4 sentences describing the facade exactly as drawn — material, window size/pattern, cornice/parapet, entrance, whether balconies are shown and where, setbacks. Base this only on what is visible, and explicitly say \'no balconies shown\' if none appear."}';
    try{
      const resp=await postProxy({parts:planPages,prompt});
      if(resp.ok){
        const d=await resp.json();
        const raw=((d&&d.text)||'').replace(/```json|```/g,'').trim();
        const parsed=JSON.parse(raw);
        renderDesc=parsed.description||'';
        if(parsed.elevationPageNumber && sampled[parsed.elevationPageNumber-1]){
          elevationImg=sampled[parsed.elevationPageNumber-1];
        }
      }
    }catch(e){ /* fall back to text-only, no reference image */ }
  }

  // Generate the real photorealistic rendering. If we identified the actual
  // elevation sheet above, pass it as a reference image so generation copies
  // the real facade (window pattern, balconies, massing) instead of
  // inventing a generic building from text alone. Falls back to the old
  // schematic SVG only if image generation is unavailable entirely.
  const oldPhoto=document.getElementById('ai-render-photo'); if(oldPhoto) oldPhoto.remove();
  cap.textContent='Rendering photorealistic exterior…';
  const facadePrompt = renderDesc
    ? (elevationImg
        ? `Using the attached architectural elevation drawing as the exact reference for massing, floor count, window pattern, and balconies, produce a photorealistic exterior rendering of the actual building it depicts — not a redesign or a different building. A ${m.floors}-story ${wt} building in ${boro}, New York City, approximately ${m.units||0} units. ${renderDesc} Render exactly what is shown in the elevation, including any balconies exactly where they appear, set in a real NYC streetscape with sidewalk and adjacent buildings, daytime, clear sky, sharp photorealistic detail, no people, no text or watermarks.`
        : `Photorealistic architectural exterior rendering, eye-level street view, daytime, clear sky, NYC streetscape context with sidewalk and adjacent buildings. A ${m.floors}-story ${wt} building in ${boro}, New York City. ${renderDesc} Clean modern architectural visualization style, sharp detail, natural lighting, no people, no text or watermarks.`)
    : `Photorealistic architectural exterior rendering, eye-level street view, daytime, clear sky. A ${m.floors}-story ${wt} building in ${boro}, New York City, approximately ${m.units||0} units, ${Math.round(m.gfa||0).toLocaleString()} SF gross floor area. NYC streetscape context with sidewalk, street trees, and adjacent buildings. Clean modern architectural visualization style, sharp detail, natural lighting, no people, no text or watermarks.`;

  let photoOk=false;
  try{
    const r=await fetch('/.netlify/functions/render-facade',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:facadePrompt, referenceImage: elevationImg?('data:image/jpeg;base64,'+elevationImg):null})});
    const d=await r.json().catch(()=>({}));
    if(r.ok && d && d.image){
      const img=document.createElement('img');
      img.id='ai-render-photo';
      img.src='data:image/png;base64,'+d.image;
      img.style.cssText='width:100%;height:100%;object-fit:cover;display:block;';
      loading.style.display='none';
      container.appendChild(img);
      photoOk=true;
    }
  }catch(e){ /* fall through to SVG fallback below */ }

  if(!photoOk){
    loading.style.display='none';
    container.appendChild(buildArchSVG(m,parseRenderFeatures(renderDesc,m)));
  }

  if(photoOk){
    cap.textContent=(elevationImg?'Rendered from the actual elevation sheet. ':'')+(renderDesc?renderDesc.slice(0,220):('AI-generated exterior — '+m.floors+' floors, '+boro));
  } else if(renderDesc){
    cap.textContent=renderDesc.slice(0,260)+' (schematic view — photorealistic rendering unavailable)';
  } else if(planPages.length===0){
    cap.textContent='No plans uploaded — showing generic massing based on metrics. Upload plans for an elevation-based rendering.';
  } else {
    cap.textContent='AI architectural visualization — '+m.floors+' floors, '+boro;
  }
  btn.disabled=false;
}

function parseRenderFeatures(desc,m){
  // Extract visual cues from AI description to adjust the SVG
  const d=desc.toLowerCase();
  return {
    hasBrick: d.includes('brick'),
    hasGlass: d.includes('glass')||d.includes('curtain wall')||d.includes('glazing'),
    hasMetal: d.includes('metal panel')||d.includes('corrugated')||d.includes('corten'),
    hasPrecast: d.includes('precast')||d.includes('concrete'),
    hasBalconies: d.includes('balcon'),
    hasCornice: d.includes('cornice')||d.includes('parapet'),
    hasSetback: d.includes('setback')||d.includes('stepback'),
    isModern: d.includes('modern')||d.includes('contemporary')||d.includes('industrial'),
    facadeColor: d.includes('red brick')||d.includes('red-brick')?'#8B4513':
                 d.includes('buff')||d.includes('tan brick')?'#C4A265':
                 d.includes('white')||d.includes('light brick')?'#D4C5A9':
                 d.includes('dark brick')?'#5C3317':
                 d.includes('gray')||d.includes('concrete')?'#6B7280':
                 d.includes('black')||d.includes('dark metal')?'#1f2937':'#2d5580'
  };
}


function buildArchSVG(m, features){
  features=features||{};
  const floors=m.floors||4, units=m.units||10;
  const facadeColor=features.facadeColor||'#2d5580';
  const facadeDark=features.hasBrick?shadeColor(facadeColor,-20):'#1a2f4a';
  const hasBalc=features.hasBalconies;
  const isGlass=features.hasGlass;
  const winColor=isGlass?'#a8d8f0':'#7bbfff';
  const winLit=isGlass?'#cce8ff':'#cce8ff';

  const ns='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(ns,'svg');
  svg.id='ai-render-svg';
  svg.setAttribute('viewBox','0 0 440 340');
  svg.style.cssText='width:100%;height:100%;position:absolute;top:0;left:0;';
  function el(tag,attrs,parent){ const e=document.createElementNS(ns,tag); Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v)); if(parent)parent.appendChild(e); return e; }

  const defs=el('defs',{},svg);
  // Sky
  const sky=el('linearGradient',{id:'rsky',x1:'0',y1:'0',x2:'0',y2:'1'},defs);
  el('stop',{'offset':'0%','stop-color':'#08122a'},sky);
  el('stop',{'offset':'65%','stop-color':'#1a3060'},sky);
  el('stop',{'offset':'100%','stop-color':'#f2a90025'},sky);
  // Building gradient using actual facade color
  const bldG=el('linearGradient',{id:'rbld',x1:'0',y1:'0',x2:'1',y2:'0'},defs);
  el('stop',{'offset':'0%','stop-color':facadeDark},bldG);
  el('stop',{'offset':'60%','stop-color':facadeColor},bldG);
  el('stop',{'offset':'100%','stop-color':facadeDark},bldG);

  // Background
  el('rect',{x:0,y:0,width:440,height:340,fill:'url(#rsky)'},svg);
  // Moon
  el('circle',{cx:385,cy:48,r:16,fill:'#f2a900',opacity:.55},svg);
  // Stars
  [[42,28],[88,52],[132,18],[308,36],[358,22],[418,50]].forEach(([x,y])=>
    el('circle',{cx:x,cy:y,r:1.5,fill:'#fff',opacity:.6},svg));

  // Adjacent buildings
  [[22,195,52,145],[350,205,62,135],[390,218,48,122],[5,215,36,125]].forEach(([x,y,w,h])=>
    el('rect',{x,y,width:w,height:h,fill:'#0d1e33',opacity:.75},svg));

  // Main building
  const bX=108, bW=224;
  const flH=Math.min(34,Math.max(15,185/floors));
  const bH=floors*flH, bY=240-bH;
  const hasSetback=features.hasSetback&&floors>4;
  const setW=hasSetback?Math.round(bW*0.8):bW;
  const setH=hasSetback?Math.round(bH*0.3):0;

  // Shadow
  el('ellipse',{cx:bX+bW/2,cy:243,rx:bW*.55,ry:7,fill:'#000',opacity:.25},svg);

  // Setback upper portion if applicable
  if(hasSetback){
    el('rect',{x:bX+(bW-setW)/2,y:bY,width:setW,height:setH,fill:'url(#rbld)'},svg);
  }

  // Main body
  const mainTop=hasSetback?bY+setH:bY;
  const mainH=hasSetback?bH-setH:bH;
  el('rect',{x:bX,y:mainTop,width:bW,height:mainH,fill:'url(#rbld)'},svg);

  // 3D side panel
  el('polygon',{
    points:(bX+bW)+','+mainTop+' '+(bX+bW+16)+','+(mainTop+12)+' '+(bX+bW+16)+',242 '+(bX+bW)+',240,',
    fill:facadeDark,opacity:.8},svg);

  // Brick texture lines (if brick facade)
  if(features.hasBrick){
    for(let r=0;r<Math.ceil(mainH/6);r++){
      const ry=mainTop+r*6;
      el('line',{x1:bX,y1:ry,x2:bX+bW,y2:ry,stroke:'rgba(0,0,0,.1)',strokeWidth:.5},svg);
      // Stagger vertical joints
      const offset=r%2===0?0:20;
      for(let c=offset;c<bW;c+=40)
        el('line',{x1:bX+c,y1:ry,x2:bX+c,y2:ry+6,stroke:'rgba(0,0,0,.1)',strokeWidth:.4},svg);
    }
  }

  // Metal panel texture (horizontal panels)
  if(features.hasMetal){
    for(let r=0;r<Math.ceil(mainH/4);r++){
      el('line',{x1:bX,y1:mainTop+r*4,x2:bX+bW,y2:mainTop+r*4,stroke:'rgba(255,255,255,.06)',strokeWidth:.6},svg);
    }
  }

  // Floor lines
  for(let f=1;f<floors;f++){
    const fy=mainTop+f*flH;
    el('line',{x1:bX,y1:fy,x2:bX+bW,y2:fy,stroke:'rgba(0,0,0,.25)',strokeWidth:.8},svg);
  }

  // Windows — glass curtain wall = large bands, brick = punched openings
  const wCols=Math.min(isGlass?10:7, Math.max(3,Math.round(bW/28)));
  const wSp=bW/(wCols+1);
  const wH=isGlass?Math.min(flH*.8,26):Math.min(flH*.5,16);
  const wW=isGlass?Math.min(wSp*.8,22):Math.min(wSp*.55,16);
  for(let f=0;f<floors;f++){
    const fy=mainTop+f*flH;
    for(let w=0;w<wCols;w++){
      const wx=bX+wSp*(w+1)-wW/2;
      const wy=fy+flH*(isGlass?.1:.2);
      const lit=Math.random()>.3;
      const wg=el('linearGradient',{id:'rw'+f+'_'+w,x1:'0',y1:'0',x2:'0',y2:'1'},defs);
      el('stop',{'offset':'0%','stop-color':lit?winLit:winColor},wg);
      el('stop',{'offset':'100%','stop-color':lit?winColor:'#0d2035'},wg);
      el('rect',{x:wx,y:wy,width:wW,height:wH,fill:'url(#rw'+f+'_'+w+')',rx:isGlass?0:1,opacity:.92},svg);
      // Balconies
      if(hasBalc&&f>0&&w%2===0){
        el('rect',{x:wx-3,y:wy+wH,width:wW+6,height:4,fill:facadeDark,opacity:.6},svg);
        el('line',{x1:wx-3,y1:wy+wH,x2:wx-3,y2:wy+wH+4,stroke:'rgba(255,255,255,.3)',strokeWidth:1},svg);
        el('line',{x1:wx+wW+3,y1:wy+wH,x2:wx+wW+3,y2:wy+wH+4,stroke:'rgba(255,255,255,.3)',strokeWidth:1},svg);
      }
    }
  }

  // Parapet / cornice
  const corH=features.hasCornice?12:6;
  el('rect',{x:bX-2,y:bY-corH,width:bW+2,height:corH,fill:features.hasCornice?shadeColor(facadeColor,10):facadeDark},svg);
  if(features.hasCornice){
    el('rect',{x:bX-4,y:bY-corH-3,width:bW+6,height:4,fill:shadeColor(facadeColor,20)},svg);
  }

  // Rooftop
  el('rect',{x:bX+25,y:bY-corH-18,width:38,height:14,fill:'#2a4a6a',rx:2},svg); // HVAC
  el('rect',{x:bX+135,y:bY-corH-20,width:32,height:16,fill:'#2a4a6a',rx:2},svg); // HVAC 2
  // Water tower (NYC)
  el('rect',{x:bX+bW-50,y:bY-corH-33,width:15,height:26,fill:'#5a3a1a',rx:2},svg);
  el('ellipse',{cx:bX+bW-42,cy:bY-corH-34,rx:11,ry:5,fill:'#7a5a2a'},svg);
  // Bulkhead
  el('rect',{x:bX+70,y:bY-corH-28,width:28,height:20,fill:facadeDark,rx:1},svg);

  // Entrance
  const entW=22, entH=Math.min(flH*.85,28);
  const entX=bX+bW/2-entW/2;
  el('rect',{x:entX,y:240-entH,width:entW,height:entH,fill:'#0d2035',rx:2},svg);
  el('rect',{x:entX+4,y:240-entH+4,width:entW-8,height:entH-8,fill:'#1a4060',rx:1,opacity:.8},svg);
  // Entrance canopy
  el('rect',{x:entX-8,y:240-entH-3,width:entW+16,height:4,fill:shadeColor(facadeColor,15),rx:1},svg);

  // Ground / sidewalk
  el('rect',{x:0,y:240,width:440,height:100,fill:'#0d1f2e'},svg);
  el('rect',{x:0,y:240,width:440,height:8,fill:'#162535'},svg);

  // Street reflections
  el('rect',{x:bX+10,y:248,width:bW-20,height:30,fill:'url(#rbld)',opacity:.08},svg);

  // Lamppost
  el('line',{x1:92,y1:240,x2:92,y2:194,stroke:'#2a4060',strokeWidth:2},svg);
  el('circle',{cx:92,cy:192,r:5,fill:'#f2a900',opacity:.8},svg);
  el('circle',{cx:92,cy:192,r:14,fill:'#f2a900',opacity:.07},svg);

  // Label
  const lbl=el('text',{x:220,y:330,fill:'#4a7090','text-anchor':'middle',
    'font-size':10,'font-family':'IBM Plex Mono,monospace','letter-spacing':'.04em'},svg);
  lbl.textContent=floors+'F \u00b7 '+Math.round(m.gfa||0).toLocaleString()+' SF GFA \u00b7 '+units+' units';
  return svg;
}

function shadeColor(hex,pct){
  const num=parseInt(hex.replace('#',''),16);
  const r=Math.min(255,Math.max(0,((num>>16)&255)+pct));
  const g=Math.min(255,Math.max(0,((num>>8)&255)+pct));
  const b=Math.min(255,Math.max(0,(num&255)+pct));
  return '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
}

/* ============ MATERIALS & SPECS PAGE ============ */
/* One entry per takeoff line: what it is, what it's made of, and how to
   picture it. kind 'product' = studio product shot, 'work' = job-site photo. */
const SPEC_CATALOG={
  'Excavation & soil export':{mat:'Excavated soil, trucked to licensed disposal/fill site',desc:'Machine excavation of the building footprint to cellar depth, loaded and hauled off-site.',kind:'work',photo:'an excavator digging a rectangular cellar pit on a narrow Brooklyn lot, dump truck being loaded'},
  'Support of excavation (SOE) — soldier piles & lagging':{mat:'Steel H-pile soldier beams with timber lagging boards',desc:'Temporary earth retention around the excavation so soil and neighboring lots stay in place.',kind:'work',photo:'steel soldier piles with horizontal timber lagging retaining the side of a deep urban excavation'},
  'Underpinning of adjacent buildings':{mat:'Cast-in-place concrete underpinning pits, dry-packed',desc:'Extends neighboring building foundations below the new excavation, dug and poured in short sequenced sections.',kind:'work',photo:'concrete underpinning pits beneath an old brick party wall next to an excavation'},
  'Piles (steel pipe / helical, installed)':{mat:'Steel pipe or helical piles, galvanized, with pile caps',desc:'Deep foundation elements that carry building loads down to competent soil or rock.',kind:'work',photo:'a drill rig installing steel pipe piles on a small urban construction site'},
  'Foundation (footings, mat, walls)':{mat:'Reinforced concrete, 4,000–5,000 psi, rebar',desc:'Footings, mat slab and cellar walls that carry the building to the ground.',kind:'work',photo:'reinforced concrete foundation walls and footing with rebar and formwork'},
  'Below-grade waterproofing':{mat:'Sheet or fluid-applied membrane with drainage board',desc:'Keeps groundwater out of the cellar walls and slab.',kind:'work',photo:'black waterproofing membrane and dimpled drainage board on a concrete foundation wall'},
  'Utility connections':{mat:'Water, sewer, gas and electric service taps',desc:'New service connections from the street mains (DEP water/sewer, Con Ed gas/electric).',kind:'work',photo:'utility trench from a Brooklyn street to a building with new water and sewer pipes'},
  'Concrete superstructure — frame, slabs & roof deck':{mat:'Reinforced concrete flat-plate slabs and columns',desc:'The building frame: columns, floor slabs and roof deck.',kind:'work',photo:'mid-rise reinforced concrete frame under construction with flat slabs and columns'},
  'Exterior facade (new skin)':{mat:'Brick veneer / fiber-cement panel on metal stud backup',desc:'Finished exterior walls of the building.',kind:'product',photo:'a modern Brooklyn apartment building facade with dark brick and large windows'},
  'Air/vapor barrier & insulation':{mat:'Fluid-applied air barrier + 2–3" mineral wool continuous insulation',desc:'Continuous insulation and air seal behind the facade for energy code.',kind:'work',photo:'mineral wool insulation boards fastened over an air barrier on an exterior wall'},
  'Selective interior demolition':{mat:'Removal of existing partitions, finishes and fixtures',desc:'Strip-out of the existing interior to prepare for the new layout.',kind:'work',photo:'interior demolition inside an old loft building, exposed brick and debris'},
  'Debris removal & disposal':{mat:'Construction & demolition debris, dumpsters/containers',desc:'Hauling and legal disposal of demolition debris.',kind:'work',photo:'a construction dumpster full of demolition debris outside a brick building'},
  'Asbestos / hazmat abatement':{mat:'Licensed removal of asbestos/lead materials',desc:'Removal of hazardous materials found in the pre-demolition survey.',kind:'work',photo:'abatement workers in white protective suits inside a sealed plastic containment area'},
  'Brick repointing — facade':{mat:'Type N/O lime mortar matched to existing',desc:'Grinding out and re-mortaring deteriorated brick joints.',kind:'work',photo:'close-up of a mason repointing old red brick joints with fresh mortar'},
  'New CMU bearing/shaft walls':{mat:'8" concrete masonry units, reinforced and grouted, 2-hr rated',desc:'Block walls for stairs, elevator shaft and fire separations.',kind:'product',photo:'a wall of grey 8 inch concrete masonry blocks with mortar joints'},
  'Existing floor structure mod / reinf':{mat:'Steel beams / sistered joists at existing floors',desc:'Reinforcing existing floors for new loads and openings.',kind:'work',photo:'new steel beam installed under an existing timber floor in an old building'},
  'Blocking, backing, rough carpentry':{mat:'Fire-retardant treated lumber and plywood',desc:'Wood blocking inside walls for cabinets, grab bars, TVs and trim.',kind:'product',photo:'fire retardant treated 2x lumber blocking between metal studs'},
  'Egress stairs (steel pan + concrete)':{mat:'Steel stringers, steel pan treads filled with concrete, steel rails',desc:'Fire exit stairs between all floors.',kind:'product',photo:'a steel pan egress stair with concrete-filled treads and a painted steel railing'},
  'Misc metals — railings, guards':{mat:'Painted steel railings and guards, 42" high',desc:'Guards, handrails and miscellaneous steel items.',kind:'product',photo:'a black painted steel guardrail and handrail on a stair landing'},
  'Roofing membrane':{mat:'Modified bitumen or TPO roofing membrane',desc:'New watertight roof system.',kind:'work',photo:'a flat roof with a new white TPO roofing membrane on a city building'},
  'Roof insulation':{mat:'Tapered polyiso insulation boards',desc:'Insulation under the roof membrane, sloped to drains.',kind:'product',photo:'stacked tapered polyisocyanurate roof insulation boards'},
  'Exterior wall insulation (int. face)':{mat:'Closed-cell spray foam or mineral wool at inside face of exterior walls',desc:'Insulating existing masonry walls from the inside.',kind:'work',photo:'closed cell spray foam insulation on the inside of an old brick wall between studs'},
  'Caulking & sealants':{mat:'Silicone and polyurethane sealants',desc:'Sealing joints at windows, doors and facade.',kind:'product',photo:'a caulk gun applying a bead of grey sealant around a window frame'},
  'Inner court / curtain wall system':{mat:'Aluminum curtain wall with insulated glass',desc:'Glazed walls enclosing the inner light court.',kind:'product',photo:'an aluminum curtain wall with large insulated glass panels facing an inner courtyard'},
  'Windows (replacement)':{mat:'Aluminum windows, thermally broken, insulated low-E glass',desc:'New energy-efficient windows in the openings.',kind:'product',photo:'a black thermally broken aluminum window with insulated low-e glass, isolated'},
  'Apartment / entry doors (metal)':{mat:'Hollow metal door & frame, 3\'-0" × 7\'-0", 20-min rated, lever lockset, closer, peephole',desc:'Front door of each apartment, off the public corridor.',kind:'product',photo:'a painted dark grey hollow metal apartment entry door with lever handle and peephole'},
  'Stair / fire-rated doors (metal)':{mat:'Hollow metal door & frame, 1½-hr rated, closer, panic hardware, rated label',desc:'Self-closing fire doors into stairs and rated corridors.',kind:'product',photo:'a red painted hollow metal fire rated stair door with push bar and door closer'},
  'Interior doors (solid wood)':{mat:'Solid wood door, 8\'-0" high, with a horizontal design line (routed groove) across the door',desc:'Bedroom, bathroom and closet doors inside each unit.',kind:'product',photo:'a tall 8 foot solid wood interior door painted white with a single horizontal routed design line across it, modern lever handle'},
  'Metal stud partition framing':{mat:'Light-gauge galvanized steel studs & track, 3-5/8" typical',desc:'Framing for all new interior walls.',kind:'product',photo:'galvanized steel metal stud wall framing with top and bottom track'},
  'Gypsum board (5/8" Type X)':{mat:'5/8" Type X fire-rated gypsum board, taped & finished',desc:'Wall and ceiling board over framing, fire rated.',kind:'product',photo:'stacked 5/8 inch type X fire rated gypsum drywall boards'},
  'Porcelain tile — bath & kitchen':{mat:'Porcelain tile, 12×24 floor / 3×12 wall, on waterproofing',desc:'Tile floors and walls in bathrooms and kitchen backsplashes.',kind:'product',photo:'a modern bathroom with large format grey porcelain floor tile and white wall tile'},
  'Engineered wood flooring':{mat:'Engineered white oak plank, 5" wide, 3/4" thick, factory-finished matte',desc:'Wood floors in living rooms, bedrooms and halls.',kind:'product',photo:'wide white oak engineered wood plank flooring with a matte natural finish in a bright apartment living room'},
  'Painting — walls & ceilings':{mat:'Low-VOC latex, primer + 2 coats (eggshell walls, flat ceilings)',desc:'Paint on all new walls and ceilings.',kind:'work',photo:'freshly painted white apartment walls and ceiling with a paint roller'},
  'Specialty ceilings / soffits':{mat:'Gypsum board soffits and drop ceilings on metal framing',desc:'Dropped ceilings to hide ducts and pipes.',kind:'work',photo:'a gypsum board drop soffit in an apartment hallway hiding ductwork'},
  'Kitchen casework & countertops':{mat:'Flat-panel cabinets with Caesarstone quartz countertop',desc:'Full kitchen cabinets and countertops per unit.',kind:'product',photo:'a compact modern apartment kitchen with flat panel cabinets and a white Caesarstone quartz countertop'},
  'Bathroom vanities & accessories':{mat:'Wall-hung vanity, porcelain sink, mirror, towel bars, grab-bar blocking',desc:'Vanity and accessories in each bathroom.',kind:'product',photo:'a wall-hung bathroom vanity with integrated white sink and mirror'},
  'Appliance packages':{mat:'Stainless range, refrigerator, dishwasher, microwave/hood',desc:'Kitchen appliances for each unit.',kind:'product',photo:'a set of stainless steel kitchen appliances: range, refrigerator and dishwasher'},
  'Passenger elevator':{mat:'Machine-room-less traction elevator, stainless cab',desc:'Passenger elevator serving all floors.',kind:'product',photo:'a modern passenger elevator with brushed stainless steel doors in a lobby'},
  'Plumbing systems (units, risers, common, DHW)':{mat:'PEX/copper water, cast-iron/PVC waste, fixtures, water heaters',desc:'All water, waste, vent and hot-water piping and fixtures.',kind:'work',photo:'new copper and PEX plumbing pipes and cast iron drain risers in an open wall'},
  'Fire sprinkler (NFPA 13R)':{mat:'Black steel / CPVC sprinkler piping with concealed heads',desc:'Automatic fire sprinkler system throughout.',kind:'product',photo:'a concealed white fire sprinkler head in a ceiling'},
  'Outdoor condensing units':{mat:'Inverter heat-pump condensers, roof-mounted',desc:'Outdoor units for the heating/cooling system.',kind:'product',photo:'a row of inverter heat pump condensing units on a flat roof'},
  'Indoor AC units (1 per room)':{mat:'Ductless wall-mounted heat pump head (mini-split)',desc:'One heating/cooling unit in each room ≥ 8×8 ft with a window.',kind:'product',photo:'a white ductless mini split wall mounted air conditioner unit, isolated'},
  'Exhaust fans (kitchen + bath)':{mat:'Quiet ceiling exhaust fans, ducted to exterior',desc:'Bathroom and kitchen ventilation.',kind:'product',photo:'a white ceiling bathroom exhaust fan grille'},
  'Refrigerant piping & insulation':{mat:'Insulated copper refrigerant line sets',desc:'Piping between the outdoor and indoor AC units.',kind:'product',photo:'coiled insulated copper refrigerant line set for a mini split'},
  'Exhaust ductwork & goosenecks':{mat:'Galvanized sheet-metal ductwork and roof goosenecks',desc:'Ducts from exhaust fans to the roof.',kind:'product',photo:'galvanized sheet metal exhaust ductwork'},
  'Install, controls, balancing (TAB)':{mat:'Thermostats, controls, testing & balancing',desc:'Controls and commissioning of the HVAC system.',kind:'product',photo:'a modern wall thermostat in an apartment'},
  'Electrical (service, distribution, units, fixtures, fire alarm)':{mat:'Copper wiring, panels, devices, LED fixtures, fire alarm',desc:'Electrical service, apartment panels, outlets, lighting and fire alarm.',kind:'work',photo:'an open electrical panel with neatly organized copper wiring and breakers'},
};
function specFor(name){
  if(SPEC_CATALOG[name]) return SPEC_CATALOG[name];
  const k=Object.keys(SPEC_CATALOG).find(x=>x.split(' ')[0]===String(name).split(' ')[0]&&String(name).includes(x.split(' — ')[0]));
  return k?SPEC_CATALOG[k]:{mat:'—',desc:'Custom line item',kind:'product',photo:String(name)};
}
const PHOTO_KEY='cest-photo-v2:';
const photoMem={};
function getPhoto(name){ if(photoMem[name]) return photoMem[name]; try{ const v=localStorage.getItem(PHOTO_KEY+name); if(v){ photoMem[name]=v; return v; } }catch(e){} return null; }
function putPhoto(name,url){ photoMem[name]=url; try{ localStorage.setItem(PHOTO_KEY+name,url); }catch(e){} }

function openSpecs(){ renderSpecs(); hide('step-3'); show('step-5'); window.scrollTo(0,0); track('specs_opened'); }
function backFromSpecs(){ hide('step-5'); show('step-3'); }

function specRows(){
  return (lastRows||[]).filter(r=>!r.excl&&(+r.qty||0)>0);
}
function renderSpecs(){
  const el=document.getElementById('specs'); if(!el) return;
  const rows=specRows(); let html=''; let cur='';
  rows.forEach((r,i)=>{
    if(r.div!==cur){ if(cur) html+='</div>'; cur=r.div; html+=`<h3 class="spec-div">${esc2(r.div)}</h3><div class="spec-grid">`; }
    const s=specFor(r.name); const ph=getPhoto(r.name);
    const q=(+r.qty>=100?Math.round(r.qty).toLocaleString():(+r.qty).toFixed(+r.qty%1?1:0))+' '+esc2(r.unit||'');
    html+=`<div class="spec-card">
      <div class="spec-img" id="spec-img-${i}">${ph?`<img src="${ph}" alt="${esc2(r.name)}">`:`<button class="btn no-print" onclick="genSpecPhoto(${i})">📷 Generate photo</button>`}</div>
      <div class="spec-body"><div class="spec-name">${esc2(r.name)}</div>
      <div class="spec-mat">${esc2(s.mat)}</div>
      <div class="spec-desc">${esc2(s.desc)}</div>
      <div class="spec-qty">Qty: <strong>${q}</strong></div></div></div>`;
  });
  if(cur) html+='</div>';
  el.innerHTML=html||'<p>No items in the estimate yet.</p>';
  const miss=rows.filter(r=>!getPhoto(r.name)).length;
  const b=document.getElementById('spec-genall'); if(b) b.textContent=miss?`📷 Generate all photos (${miss})`:'✓ All photos ready';
}
async function genSpecPhoto(i){
  const r=specRows()[i]; if(!r) return;
  const box=document.getElementById('spec-img-'+i); if(box) box.innerHTML='<div class="spec-wait">Generating photo…</div>';
  const s=specFor(r.name);
  const prompt=(s.kind==='work'
    ?`Realistic construction site photograph: ${s.photo}. New York City. Natural daylight, documentary style.`
    :`Realistic product photograph for a construction materials catalog: ${s.photo}. Plain light grey studio background, soft even lighting.`)
    +' Material: '+s.mat+'. No text, no logos, no watermarks, no people\'s faces.';
  try{
    const resp=await fetch('/.netlify/functions/render-facade',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prompt,size:'1024x1024',quality:'low'})});
    const d=await resp.json().catch(()=>({}));
    if(!resp.ok||!d.image) throw new Error(d.error||('error '+resp.status));
    const url=await shrinkImage('data:image/png;base64,'+d.image,480);
    putPhoto(r.name,url);
    if(box) box.innerHTML=`<img src="${url}" alt="${esc2(r.name)}">`;
    track('spec_photo');
  }catch(e){
    if(box) box.innerHTML=`<div class="spec-wait err">Photo unavailable: ${esc2(e.message)}<br><button class="btn no-print" onclick="genSpecPhoto(${i})">Retry</button></div>`;
  }
  const miss=specRows().filter(x=>!getPhoto(x.name)).length;
  const b=document.getElementById('spec-genall'); if(b) b.textContent=miss?`📷 Generate all photos (${miss})`:'✓ All photos ready';
}
async function genAllSpecPhotos(){
  const idx=specRows().map((r,i)=>getPhoto(r.name)?-1:i).filter(i=>i>=0);
  for(let k=0;k<idx.length;k+=3) await Promise.all(idx.slice(k,k+3).map(genSpecPhoto));
}
function shrinkImage(src,max){
  return new Promise(res=>{ const img=new Image(); img.onload=()=>{ const sc=Math.min(1,max/Math.max(img.width,img.height));
    const c=document.createElement('canvas'); c.width=Math.round(img.width*sc); c.height=Math.round(img.height*sc);
    c.getContext('2d').drawImage(img,0,0,c.width,c.height); res(c.toDataURL('image/jpeg',0.82)); };
    img.onerror=()=>res(src); img.src=src; });
}

/* ============ ELECTRICAL BREAKDOWN (NEC-based rules adopted by the NYC Electrical Code) ============ */
// Sizes the electrical job from building metrics: receptacles per room, circuits
// and breakers per dwelling unit, common/house circuits, and panel count.
// Rules used (NEC Art. 210/220 as adopted in NYC):
//  • 210.52(A): no point along a usable wall > 6 ft from a receptacle → ~1 per 12 ft of wall
//  • 210.52(C): countertops — no point > 24" from a receptacle → 1 per 4 ft of counter
//  • 210.11(C): 2 × 20A kitchen small-appliance circuits, 1 × 20A bathroom circuit, 20A laundry circuit
//  • 210.8 GFCI: kitchen countertop, bath, laundry · 210.12 AFCI: dwelling-unit living/bed rooms
//  • 220.12: general lighting 3 VA/SF
// New NYC buildings ≤ 7 stories are all-electric (Local Law 154) → electric range & heat pumps.
let elecWD=true;
function electricalBreakdown(){
  const m=(lastTotals&&lastTotals.m)||metrics();
  const tu=typicalUnit(m); const U=tu.U, unitSF=tu.unitSF, bedsPerUnit=tu.beds, baths=tu.baths;
  const bedSF=Math.min(160,Math.max(100,unitSF*0.14)), livSF=Math.max(160,unitSF*0.30);
  const wallRecs=sf=>Math.max(2,Math.ceil(4*Math.sqrt(sf)*0.8/12)+1);   // 80% usable wall, 6-ft rule
  const counterLF=Math.round(Math.max(8,Math.min(16,unitSF/70)));
  const rooms=[
    {room:'Living / dining',n:1,sf:livSF,recs:wallRecs(livSF),type:'Duplex 15A, AFCI',note:'6-ft rule on every usable wall'},
    ...(bedsPerUnit?[{room:'Bedroom',n:bedsPerUnit,sf:bedSF,recs:wallRecs(bedSF),type:'Duplex 15A, AFCI',note:'6-ft rule'}]:[]),
    {room:'Kitchen — countertop',n:1,sf:null,recs:Math.ceil(counterLF/4),type:'Duplex 20A, GFCI',note:`≈${counterLF} LF counter, 1 per 4 ft`},
    {room:'Kitchen — appliances',n:1,sf:null,recs:3,type:'Dedicated: fridge, dishwasher, microwave/hood',note:'Range hard-wired/50A receptacle'},
    {room:'Bathroom',n:baths,sf:null,recs:1,type:'Duplex 20A, GFCI',note:'Within 3 ft of basin'},
    {room:'Foyer / hall',n:1,sf:null,recs:1,type:'Duplex 15A, AFCI',note:'Halls ≥ 10 ft need one'},
    ...(elecWD?[{room:'Laundry (in-unit W/D)',n:1,sf:null,recs:2,type:'Washer 20A GFCI + dryer 30A',note:'Dedicated circuits'}]:[]),
  ];
  const recsPerUnit=rooms.reduce((a,r)=>a+r.n*r.recs,0);
  const gfciPerUnit=rooms.filter(r=>/GFCI/.test(r.type)).reduce((a,r)=>a+r.n*(/Laundry/.test(r.room)?1:r.recs),0);
  const condPerUnit=Math.max(1,Math.round((m.cu>0?m.cu:U)/U));
  const circuits=[
    {c:'General lighting (3 VA/SF)',amp:15,poles:1,qty:Math.max(1,Math.ceil(unitSF*3/1440)),prot:'AFCI'},
    {c:'Living/dining receptacles',amp:20,poles:1,qty:1,prot:'AFCI'},
    ...(bedsPerUnit?[{c:'Bedroom receptacles',amp:20,poles:1,qty:bedsPerUnit,prot:'AFCI'}]:[]),
    {c:'Kitchen small-appliance',amp:20,poles:1,qty:2,prot:'GFCI/AFCI'},
    {c:'Refrigerator',amp:20,poles:1,qty:1,prot:'—'},
    {c:'Dishwasher',amp:20,poles:1,qty:1,prot:'GFCI'},
    {c:'Microwave / range hood',amp:20,poles:1,qty:1,prot:'AFCI'},
    {c:'Electric range / induction',amp:50,poles:2,qty:1,prot:'—'},
    {c:'Bathroom receptacles',amp:20,poles:1,qty:baths,prot:'GFCI'},
    ...(elecWD?[{c:'Washer',amp:20,poles:1,qty:1,prot:'GFCI'},{c:'Dryer (heat-pump/electric)',amp:30,poles:2,qty:1,prot:'—'}]:[]),
    {c:'Heat-pump condenser (mini-split)',amp:30,poles:2,qty:condPerUnit,prot:'—'},
    {c:'Smoke/CO detectors (interconnected)',amp:15,poles:1,qty:0,prot:'On lighting circuit'},
  ];
  const brkUnit=circuits.reduce((a,c)=>a+c.qty,0), spacesUnit=circuits.reduce((a,c)=>a+c.qty*c.poles,0);
  const panelSpaces=[20,24,30,40,42].find(s=>s>=Math.ceil(spacesUnit*1.2))||42;
  const unitAmps=(elecWD||condPerUnit>1)?125:100;
  const F=Math.max(1,Math.round(m.floors||1)), cellar=!!m.cellar, elev=Math.round(m.elev||0);
  const house=[
    {c:'Corridor & stair lighting',amp:20,poles:1,qty:F*2+(cellar?2:0)},
    {c:'Corridor receptacles (cleaning)',amp:20,poles:1,qty:F},
    {c:'Cellar / mechanical rooms',amp:20,poles:1,qty:cellar?3:1},
    {c:'Roof service receptacle (near HVAC)',amp:20,poles:1,qty:1},
    {c:'Exterior & entrance lighting',amp:20,poles:1,qty:1},
    {c:'Fire alarm control panel',amp:20,poles:1,qty:1},
    {c:'Intercom / entry / low-voltage',amp:20,poles:1,qty:1},
    {c:'Central DHW heat pump',amp:40,poles:2,qty:1},
    ...(cellar?[{c:'Sump / sewage ejector pump',amp:20,poles:2,qty:1}]:[]),
    ...(elev?[{c:'Elevator machine (3-phase)',amp:60,poles:3,qty:elev},{c:'Elevator cab lighting',amp:20,poles:1,qty:elev}]:[]),
  ];
  const brkHouse=house.reduce((a,c)=>a+c.qty,0), spacesHouse=house.reduce((a,c)=>a+c.qty*c.poles,0);
  const housePanels=Math.max(1,Math.ceil(spacesHouse*1.2/42));
  const houseRecs=F+(cellar?2:1)+1;
  const panels=[
    {p:'Dwelling-unit load centers',qty:U,spec:`${unitAmps}A, ${panelSpaces}-space, 120/240V (or 120/208V)`},
    {p:'House (common-area) panels',qty:housePanels,spec:'225A, 42-space'},
    {p:'Meter bank / main switchboard',qty:1,spec:`${U+1} meters (1 per unit + house)`},
    ...(elev?[{p:'Elevator disconnect',qty:elev,spec:'Fused, 3-phase, per elevator'}]:[]),
  ];
  return {m,U,unitSF,bedsPerUnit,baths,rooms,recsPerUnit,gfciPerUnit,circuits,brkUnit,spacesUnit,panelSpaces,unitAmps,house,brkHouse,spacesHouse,houseRecs,panels,
    totals:{recs:recsPerUnit*U+houseRecs,gfci:gfciPerUnit*U,breakers:brkUnit*U+brkHouse,panels:panels.reduce((a,p)=>a+p.qty,0),
      afciBrk:circuits.filter(c=>/AFCI/.test(c.prot)).reduce((a,c)=>a+c.qty,0)*U}};
}
function openElectrical(){ renderElectrical(); hide('step-3'); show('step-6'); window.scrollTo(0,0); track('electrical_opened'); }
function backFromElectrical(){ hide('step-6'); show('step-3'); }
function renderElectrical(){
  const e=electricalBreakdown(), n=v=>Math.round(v).toLocaleString(); const el=document.getElementById('elec'); if(!el) return;
  const tot=e.totals;
  el.innerHTML=`
  <div class="elec-kpis">
    <div><div class="k">${n(tot.recs)}</div><div class="l">Receptacles (outlets)</div></div>
    <div><div class="k">${n(tot.gfci)}</div><div class="l">GFCI protected</div></div>
    <div><div class="k">${n(tot.breakers)}</div><div class="l">Breakers (circuits)</div></div>
    <div><div class="k">${n(tot.panels)}</div><div class="l">Panels / switchboards</div></div>
  </div>
  <p class="hint">Based on ${e.U} units · typical unit ≈ ${n(e.unitSF)} SF net · ${e.bedsPerUnit} bedroom(s) · ${e.baths} bath(s). Room sizes are typical for that unit size — plan-specific layouts will vary.</p>
  <label class="hint" style="display:inline-flex;gap:6px;align-items:center;margin:.3rem 0 .2rem"><input type="checkbox" ${elecWD?'checked':''} onchange="elecWD=this.checked;renderElectrical()"> In-unit washer/dryer</label>

  <h3>Outlets per room — typical unit</h3>
  <table><thead><tr><th>Room</th><th class="num">Rooms</th><th class="num">Outlets each</th><th class="num">Total</th><th>Type</th><th>Rule</th></tr></thead><tbody>
  ${e.rooms.map(r=>`<tr><td>${esc2(r.room)}${r.sf?` <span class="basis">≈${n(r.sf)} SF</span>`:''}</td><td class="num">${r.n}</td><td class="num">${r.recs}</td><td class="num"><strong>${r.n*r.recs}</strong></td><td>${esc2(r.type)}</td><td class="basis">${esc2(r.note)}</td></tr>`).join('')}
  <tr class="subtot"><td colspan="3">Per unit</td><td class="num">${e.recsPerUnit}</td><td colspan="2">× ${e.U} units = ${n(e.recsPerUnit*e.U)} · + ${e.houseRecs} common-area</td></tr></tbody></table>

  <h3>Circuits & breakers — per unit panel</h3>
  <table><thead><tr><th>Circuit</th><th class="num">Breaker</th><th class="num">Poles</th><th class="num">Qty</th><th>Protection</th></tr></thead><tbody>
  ${e.circuits.map(c=>`<tr><td>${esc2(c.c)}</td><td class="num">${c.amp}A</td><td class="num">${c.poles}</td><td class="num"><strong>${c.qty}</strong></td><td>${esc2(c.prot)}</td></tr>`).join('')}
  <tr class="subtot"><td colspan="3">Per unit: ${e.brkUnit} breakers · ${e.spacesUnit} spaces → ${e.panelSpaces}-space, ${e.unitAmps}A panel</td><td class="num">${e.brkUnit}</td><td>× ${e.U} = ${n(e.brkUnit*e.U)}</td></tr></tbody></table>

  <h3>Common areas — house panel</h3>
  <table><thead><tr><th>Circuit</th><th class="num">Breaker</th><th class="num">Poles</th><th class="num">Qty</th></tr></thead><tbody>
  ${e.house.map(c=>`<tr><td>${esc2(c.c)}</td><td class="num">${c.amp}A</td><td class="num">${c.poles}</td><td class="num"><strong>${c.qty}</strong></td></tr>`).join('')}
  <tr class="subtot"><td colspan="3">House: ${e.brkHouse} breakers · ${e.spacesHouse} spaces</td><td class="num">${e.brkHouse}</td></tr></tbody></table>

  <h3>Panels & distribution</h3>
  <table><thead><tr><th>Equipment</th><th class="num">Qty</th><th>Spec</th></tr></thead><tbody>
  ${e.panels.map(p=>`<tr><td>${esc2(p.p)}</td><td class="num"><strong>${p.qty}</strong></td><td>${esc2(p.spec)}</td></tr>`).join('')}</tbody></table>

  <p class="hint" style="margin-top:1rem">Receptacle and circuit rules follow the NEC articles adopted by the NYC Electrical Code (210.52 spacing, 210.11 required circuits, 210.8 GFCI, 210.12 AFCI, 220.12 lighting load). This is an estimating breakdown, not a stamped electrical design — the engineer of record's load calculation and panel schedules govern. Pricing stays on the Electrical line of the estimate.</p>`;
}

/* ============ PLUMBING BREAKDOWN (NYC Plumbing Code — IPC-based with NYC amendments) ============ */
// Rules used:
//  • Table 403.1: each dwelling unit — water closet, lavatory, bathtub/shower, kitchen sink
//  • Table 709.1 drainage fixture units (DFU): bathroom group (1.6 gpf) 5, kitchen sink 2, dishwasher 2, clothes washer 3
//  • Table 710.1(1)/(2): building drain & stack sizing by DFU (min 3" where water closets connect)
//  • Appendix E water-supply fixture units (WSFU, flush tank): bath group 3.6, kitchen sink 1.4, dishwasher 1.4, washer 1.4
//  • NYC-specific: house (building) trap with fresh-air inlet; RPZ backflow at the service
function typicalUnit(m){
  const U=Math.max(1,Math.round(m.units||0)), nsf=m.nsf>0?m.nsf:(m.gfa||0)*0.8, unitSF=nsf/U;
  const acRooms=m.ah>0?m.ah:Math.round(U*2.5);
  const beds=Math.max(0,Math.round((acRooms-U)/U));
  return {U,unitSF,beds,baths:beds>=2?2:1};
}
function plumbingBreakdown(){
  const m=(lastTotals&&lastTotals.m)||metrics(); const t=typicalUnit(m); const U=t.U, B=t.baths, wd=elecWD;
  const fixtures=[
    {f:'Water closet (1.28 gpf, tank)',qty:B,dfu:0,wsfu:0,where:'Each bathroom'},
    {f:'Lavatory',qty:B,dfu:0,wsfu:0,where:'Each bathroom'},
    {f:'Bathtub / shower (pressure-balance valve)',qty:B,dfu:0,wsfu:0,where:'Each bathroom'},
    {f:'Kitchen sink',qty:1,dfu:2,wsfu:1.4,where:'Kitchen'},
    {f:'Dishwasher connection',qty:1,dfu:2,wsfu:1.4,where:'Kitchen'},
    {f:'Refrigerator ice-maker box',qty:1,dfu:0,wsfu:0,where:'Kitchen'},
    ...(wd?[{f:'Clothes-washer box',qty:1,dfu:3,wsfu:1.4,where:'Laundry'}]:[]),
  ];
  const dfuUnit=B*5+2+2+(wd?3:0), wsfuUnit=B*3.6+1.4+1.4+(wd?1.4:0);
  const fixUnit=fixtures.reduce((a,x)=>a+x.qty,0);
  const valves=[
    {v:'Angle stops — lavatories (H+C)',qty:B*2},
    {v:'Angle stops — water closets',qty:B},
    {v:'Angle stops — kitchen sink (H+C)',qty:2},
    {v:'Dishwasher & ice-maker supply valves',qty:2},
    ...(wd?[{v:'Washer-box valves (H+C)',qty:2}]:[]),
    {v:'Tub/shower pressure-balance valves',qty:B},
    {v:'Unit isolation ball valves (H+C)',qty:2},
    {v:'Water-hammer arrestors',qty:wd?2:1},
  ];
  const valvesUnit=valves.reduce((a,x)=>a+x.qty,0);
  const F=Math.max(1,Math.round(m.floors||1)), upf=Math.ceil(U/F), cellar=!!m.cellar;
  const size=(d,tbl)=>{ for(const [lim,s] of tbl) if(d<=lim) return s; return tbl[tbl.length-1][1]+'+'; };
  const STACK=[[48,'3"'],[240,'4"'],[540,'5"'],[960,'6"']], DRAIN=[[216,'4"'],[480,'5"'],[840,'6"'],[1920,'8"']];
  const bathStackDFU=F*5, kitStackDFU=F*(4+(wd?3:0));
  const stacks=[
    {s:'Bathroom waste & vent stacks',qty:upf*B,size:size(bathStackDFU,STACK),dfu:bathStackDFU},
    {s:'Kitchen / laundry waste stacks',qty:upf,size:size(kitStackDFU,STACK),dfu:kitStackDFU},
    {s:'Cold & hot water risers (+ recirc)',qty:upf*3,size:'¾"–1¼"',dfu:null},
  ];
  const ventsThruRoof=upf*B+upf;
  const totDFU=dfuUnit*U+(cellar?6:3), totWSFU=wsfuUnit*U+5;
  // Hunter's curve (flush tank) — approximate peak demand
  const H=[[0,0],[10,8],[20,14],[50,29],[100,43],[200,65],[400,105],[800,170],[1500,270],[3000,450]];
  let gpm=0; for(let i=1;i<H.length;i++){ if(totWSFU<=H[i][0]){ const [a,ga]=H[i-1],[b,gb]=H[i]; gpm=ga+(gb-ga)*(totWSFU-a)/(b-a); break; } gpm=H[H.length-1][1]; }
  const svc=gpm<=20?'1"':gpm<=35?'1¼"':gpm<=45?'1½"':gpm<=80?'2"':gpm<=120?'2½"':gpm<=180?'3"':'4"';
  const roofDrains=Math.max(2,Math.ceil((m.footprint||2000)/2000));
  const common=[
    {c:'Building drain',qty:1,spec:`${size(totDFU,DRAIN)} at ¼"/ft — ${Math.round(totDFU)} DFU`},
    {c:'House trap + fresh-air inlet (NYC)',qty:1,spec:'Full-size of building drain'},
    {c:'Domestic water service & meter',qty:1,spec:`≈${Math.round(gpm)} gpm peak (${Math.round(totWSFU)} WSFU) → ~${svc} service`},
    {c:'RPZ backflow preventer',qty:1,spec:`${svc}, DEP-approved`},
    {c:'Central DHW heat-pump system',qty:1,spec:`≈${Math.round(U*25/10)*10} gal storage (≈25 gal/unit) + recirculation`},
    ...(F>5?[{c:'Domestic water booster pump',qty:1,spec:'Duplex, VFD — street pressure serves ≈5–6 stories'}]:[]),
    ...(cellar?[{c:'Sewage ejector pit & duplex pumps',qty:1,spec:'For cellar fixtures below the sewer'}]:[]),
    {c:'Roof drains',qty:roofDrains,spec:'≈1 per 2,000 SF of roof + overflow/scuppers'},
    {c:'Floor drains (cellar, trash, mech)',qty:cellar?3:1,spec:'With trap primers'},
    {c:'Mop / service sink',qty:1,spec:'Cellar or ground-floor janitor closet'},
    {c:'Hose bibbs (roof, exterior, cellar)',qty:cellar?3:2,spec:'Frost-proof, vacuum breaker'},
    {c:'Vents through roof',qty:ventsThruRoof,spec:'1 per stack, 3"–4"'},
  ];
  return {m,U,t,fixtures,fixUnit,dfuUnit,wsfuUnit,valves,valvesUnit,upf,F,stacks,common,totDFU,totWSFU,gpm,svc,
    totals:{fixtures:fixUnit*U+(1+(cellar?3:2)),valves:valvesUnit*U,stacks:upf*B+upf,dfu:Math.round(totDFU)}};
}
function openPlumbing(){ renderPlumbing(); hide('step-3'); show('step-7'); window.scrollTo(0,0); track('plumbing_opened'); }
function backFromPlumbing(){ hide('step-7'); show('step-3'); }
function renderPlumbing(){
  const p=plumbingBreakdown(), n=v=>Math.round(v).toLocaleString(); const el=document.getElementById('plumb'); if(!el) return;
  el.innerHTML=`
  <div class="elec-kpis">
    <div><div class="k">${n(p.totals.fixtures)}</div><div class="l">Fixtures & connections</div></div>
    <div><div class="k">${n(p.totals.valves)}</div><div class="l">Valves (in units)</div></div>
    <div><div class="k">${n(p.totals.stacks)}</div><div class="l">Waste stacks</div></div>
    <div><div class="k">${n(p.totals.dfu)}</div><div class="l">Drainage fixture units</div></div>
  </div>
  <p class="hint">Based on ${p.U} units on ${p.F} floor(s) (≈${p.upf} per floor) · typical unit ${p.t.beds} bedroom(s), ${p.t.baths} bath(s). Stacks assume bathrooms and kitchens line up floor to floor.</p>
  <label class="hint" style="display:inline-flex;gap:6px;align-items:center;margin:.3rem 0 .2rem"><input type="checkbox" ${elecWD?'checked':''} onchange="elecWD=this.checked;renderPlumbing()"> In-unit washer/dryer</label>

  <h3>Fixtures per unit</h3>
  <table><thead><tr><th>Fixture</th><th>Where</th><th class="num">Per unit</th><th class="num">Building</th></tr></thead><tbody>
  ${p.fixtures.map(x=>`<tr><td>${esc2(x.f)}</td><td class="basis">${esc2(x.where)}</td><td class="num"><strong>${x.qty}</strong></td><td class="num">${n(x.qty*p.U)}</td></tr>`).join('')}
  <tr class="subtot"><td colspan="2">Per unit: ${p.fixUnit} fixtures · ${p.dfuUnit} DFU · ${p.wsfuUnit.toFixed(1)} WSFU</td><td class="num">${p.fixUnit}</td><td class="num">${n(p.fixUnit*p.U)}</td></tr></tbody></table>

  <h3>Valves & shut-offs per unit</h3>
  <table><thead><tr><th>Valve</th><th class="num">Per unit</th><th class="num">Building</th></tr></thead><tbody>
  ${p.valves.map(x=>`<tr><td>${esc2(x.v)}</td><td class="num"><strong>${x.qty}</strong></td><td class="num">${n(x.qty*p.U)}</td></tr>`).join('')}
  <tr class="subtot"><td>Per unit</td><td class="num">${p.valvesUnit}</td><td class="num">${n(p.valvesUnit*p.U)}</td></tr></tbody></table>

  <h3>Risers & stacks</h3>
  <table><thead><tr><th>Riser / stack</th><th class="num">Qty</th><th class="num">Size</th><th class="num">DFU each</th></tr></thead><tbody>
  ${p.stacks.map(x=>`<tr><td>${esc2(x.s)}</td><td class="num"><strong>${x.qty}</strong></td><td class="num">${x.size}</td><td class="num">${x.dfu==null?'—':x.dfu}</td></tr>`).join('')}</tbody></table>

  <h3>Building services & common fixtures</h3>
  <table><thead><tr><th>Item</th><th class="num">Qty</th><th>Spec</th></tr></thead><tbody>
  ${p.common.map(x=>`<tr><td>${esc2(x.c)}</td><td class="num"><strong>${x.qty}</strong></td><td>${esc2(x.spec)}</td></tr>`).join('')}</tbody></table>

  <p class="hint" style="margin-top:1rem">Fixture counts, fixture units and pipe sizes follow the NYC Plumbing Code (IPC-based: Table 403.1 fixtures, 709.1 DFU, 710.1 drain & stack sizing, Appendix E water sizing) plus NYC-specific items like the house trap. Water-service size and heater storage are approximate. This is an estimating breakdown, not a stamped plumbing design — the engineer of record's riser diagrams govern. Pricing stays on the Plumbing line of the estimate.</p>`;
}

/* Wall-measuring tool (walls.js). Optional: if the file is missing the app falls back to the factor. */
loadScript('dxf.js').catch(function(e){ console.warn('dxf.js not loaded', e); });
loadScript('walls.js').catch(function(e){ console.warn('walls.js not loaded — wall measuring unavailable', e); });
