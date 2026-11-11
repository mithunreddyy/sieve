/** The dashboard page: one self-contained HTML document, no external scripts or fonts. */
export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sieve dashboard</title>
<style>
:root{--bg:#fafaf7;--fg:#1c1c1a;--mut:#6b6b64;--line:#dcdcd3;--card:#fff;--acc:#1f6f5c;--bad:#a3332b}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#e8e8e2;--mut:#9a9a90;--line:#33332f;--card:#1e1e1b;--acc:#58b59d;--bad:#e0786f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
h1{font-size:17px;margin:0}main{padding:16px;max-width:1100px;margin:0 auto;display:grid;gap:16px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.card,section{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px}
.card b{display:block;font-size:22px}.card span,.mut{color:var(--mut)}
h2{font-size:14px;margin:0 0 8px}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:4px 8px 4px 0;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mut);font-weight:500}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.wrap{overflow-x:auto}
button{font:inherit;background:none;border:1px solid var(--line);color:var(--fg);border-radius:4px;padding:1px 8px;cursor:pointer}
button:focus-visible{outline:2px solid var(--acc)}pre{white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto;background:var(--bg);padding:8px;border-radius:4px;margin:6px 0 0}
.bar{height:6px;background:var(--line);border-radius:3px;min-width:60px}.bar i{display:block;height:100%;background:var(--acc);border-radius:3px}
.bad{color:var(--bad)}.tag{border:1px solid var(--line);border-radius:3px;padding:0 5px;font-size:12px;color:var(--mut)}
</style></head><body>
<header><h1>Sieve</h1><span class="mut" id="when">loading…</span><button id="reload">Refresh</button></header>
<main id="app"><p>Loading…</p></main>
<script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const n=x=>Number(x).toLocaleString("en-US");
const ago=t=>{const s=Math.max(0,(Date.now()-t)/1000);return s<90?Math.round(s)+"s ago":s<5400?Math.round(s/60)+"m ago":s<129600?Math.round(s/3600)+"h ago":Math.round(s/86400)+"d ago"};
function table(head,rows,numCols=[]){return '<div class="wrap"><table><thead><tr>'+head.map((h,i)=>'<th class="'+(numCols.includes(i)?'n':'')+'">'+esc(h)+'</th>').join("")+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+r.map((c,i)=>'<td class="'+(numCols.includes(i)?'n':'')+'">'+c+'</td>').join("")+'</tr>').join("")+'</tbody></table></div>'}
function buckets(title,b){const max=Math.max(1,...b.map(x=>x.tokensIn-x.tokensOut));return '<section><h2>'+esc(title)+'</h2>'+(b.length?table(["","Outputs","In","Out","Saved"],b.map(x=>[esc(x.key)+'<div class="bar"><i style="width:'+Math.round(100*(x.tokensIn-x.tokensOut)/max)+'%"></i></div>',n(x.count),n(x.tokensIn),n(x.tokensOut),n(x.tokensIn-x.tokensOut)]),[1,2,3,4]):'<p class="mut">Nothing yet.</p>')+'</section>'}
async function load(){
  const r=await fetch("/api/snapshot");if(!r.ok){document.getElementById("app").textContent="Could not load ("+r.status+").";return}
  const d=await r.json();document.getElementById("when").textContent="updated "+new Date(d.generatedAt).toLocaleTimeString();
  const t=d.totals;
  let h='<div class="cards">'
   +'<div class="card"><b>'+n(t.tokensIn)+'</b><span>tokens in (shortened outputs)</span></div>'
   +'<div class="card"><b>'+n(t.tokensOut)+'</b><span>tokens returned</span></div>'
   +'<div class="card"><b>'+t.savedPct+'%</b><span>fewer ('+n(t.saved)+' tokens)</span></div>'
   +'<div class="card"><b>$'+d.dollars.saved.toFixed(2)+'</b><span>estimate at $'+d.dollars.perMillionInput+' per M input tokens (a list price you set, not a measurement)</span></div>'
   +'<div class="card"><b>'+(d.cacheHitRate==null?"not measured":Math.round(d.cacheHitRate*100)+"%")+'</b><span>cache hits'+(d.cacheHitRate==null?" (only the proxy can measure this)":"")+'</span></div></div>';
  h+='<div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">'+buckets("By agent",d.byAgent)+buckets("By tool",d.byTool)+buckets("By extractor",d.byExtractor)+buckets("By session",d.bySession)+'</div>';
  h+='<section><h2>Receipts <span class="mut">('+d.receipts.length+' most recent'+(d.canaries?', '+d.canaries+' flagged for audit':'')+')</span></h2>'+table(["When","Agent","Tool","What","In","Out","Why / original"],d.receipts.map((x,i)=>[ago(x.at),esc(x.agent),esc(x.tool),esc((x.source||"").slice(0,70))+' <span class="tag">'+esc(x.kind)+(x.extractor?" · "+esc(x.extractor):"")+'</span>'+(x.canary?' <span class="tag">audit</span>':''),n(x.tokensIn),n(x.tokensOut),'<button data-i="'+i+'">Why cut / view original</button><div id="r'+i+'"></div>']),[4,5])+'</section>';
  h+='<section><h2>Memory facts <span class="mut">('+d.facts.length+')</span></h2>'+(d.facts.length?table(["Fact","Scope","Trust","Source"],d.facts.map(f=>[esc(f.subject+" "+f.predicate.replace(/_/g," ")+": "+f.object),esc(f.scope),esc(f.trust),esc(f.source)])):'<p class="mut">No facts stored.</p>')+'<p class="mut">Recall pointers are shown to the model but not stored, so they are not listed.</p></section>';
  h+='<section><h2>Guard decisions</h2>'+(d.guard.length?table(["When","Decision","Rule","Tool","Mode"],d.guard.map(g=>[ago(g.at),'<span class="'+(/deny/.test(g.decision)?"bad":"")+'">'+esc(g.decision)+'</span>',esc(g.rule||""),esc(g.tool+(g.program?" · "+g.program:"")),esc(g.mode)])):'<p class="mut">No decisions logged.</p>')+'</section>';
  h+='<section><h2>Hook health</h2>'+(d.hooks.length?table(["Agent","Event","Last fired","Count"],d.hooks.map(x=>[esc(x.agent),esc(x.event),ago(x.lastAt),n(x.count)]),[3]):'<p class="mut">No agent has called Sieve yet.</p>')+'</section>';
  h+='<section><h2>Projects</h2>'+table(["Project","Archived items","Archived tokens"],d.projects.map(p=>[esc(p.name)+' <span class="mut">'+esc(p.root)+'</span>',n(p.archivedItems),n(p.archivedTokens)]),[1,2])+'</section>';
  document.getElementById("app").innerHTML=h;
  document.querySelectorAll("button[data-i]").forEach(b=>b.onclick=async()=>{
    const x=d.receipts[b.dataset.i],box=document.getElementById("r"+b.dataset.i);
    if(box.textContent){box.textContent="";return}
    box.innerHTML='<p>'+esc(x.why)+'</p>';
    if(x.archiveId){const o=await fetch("/api/original?p="+encodeURIComponent(x.project)+"&id="+encodeURIComponent(x.archiveId));
      const pre=document.createElement("pre");pre.textContent=o.ok?await o.text():"The original is no longer archived.";box.appendChild(pre)}
  });
}
document.getElementById("reload").onclick=load;load();setInterval(load,15000);
</script></body></html>`;
