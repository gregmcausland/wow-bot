export interface EvaluationResult {
  id: string;
  category: string;
  prompt: string;
  history?: { role: "user" | "assistant"; content: string }[];
  expectation: string;
  output: string;
  milliseconds: number;
  checks: { name: string; passed: boolean }[];
  error?: string;
  review: "unreviewed" | "good" | "adjust";
  reviewNotes: string;
}
export interface EvaluationReport {
  startedAt: string;
  finishedAt?: string;
  model: string;
  reasoning: string;
  promptHash: string;
  suiteHash: string;
  expectedCases: number;
  results: EvaluationResult[];
}

export function renderReport(report: EvaluationReport): string {
  const data = JSON.stringify(report).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.55 var(--font-sans,system-ui);color:var(--foreground,CanvasText)}
.tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}select,button,textarea{font:inherit;color:var(--foreground,CanvasText);background:var(--card,Canvas);border:1px solid var(--border,GrayText);border-radius:6px;padding:7px 10px}button{cursor:pointer}small,.meta{color:var(--muted-foreground,GrayText)}.intro{margin:0 0 14px}details{margin:9px 0;background:var(--card,Canvas);border:1px solid var(--border,GrayText);border-radius:var(--radius,8px);overflow:hidden}summary{padding:12px 16px;cursor:pointer;font-weight:600}article{padding:0 16px 16px}.tag{font-size:11px;font-weight:400;margin-left:10px;color:var(--muted-foreground,GrayText)}.block{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 16px;padding:12px;border-radius:6px;background:var(--secondary,ButtonFace)}.answer{border-left:3px solid var(--primary,Highlight)}label{display:block;font-weight:600;margin-top:12px}textarea{display:block;width:100%;min-height:58px;margin-top:8px;resize:vertical}.review{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.flag{color:var(--destructive,MarkText)}.meta{font-size:12px;margin-bottom:12px}h3{font-size:14px;margin:14px 0 4px}
</style><body>
<p class="intro">Holmes prompt evaluations · <span id="model"></span><br><small>Mechanical checks are automated. Scope, usefulness, and tone need human review. Ratings stay in this page until you export the reviewed JSON.</small></p>
<div class="tools"><select id="filter" aria-label="Filter category"><option value="all">All categories</option></select><button id="expand">Expand all</button><button id="export">Export reviewed JSON</button><span id="counts" class="meta"></span></div>
<div id="cases"></div>
<script type="application/json" id="report-data">${data}</script>
<script>
const report=JSON.parse(document.getElementById('report-data').textContent),host=document.getElementById('cases'),filter=document.getElementById('filter');
document.getElementById('model').textContent=report.model+' / '+report.reasoning;
for(const category of [...new Set(report.results.map(r=>r.category))]){const option=document.createElement('option');option.value=category;option.textContent=category;filter.append(option);}
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function counts(){const flagged=report.results.filter(r=>r.error||r.checks.some(c=>!c.passed)).length,reviewed=report.results.filter(r=>r.review!=='unreviewed').length;document.getElementById('counts').textContent=report.results.length+'/'+report.expectedCases+' cases · '+flagged+' mechanical flags · '+reviewed+' reviewed';}
function render(){host.replaceChildren();for(const result of report.results){if(filter.value!=='all'&&filter.value!==result.category)continue;const card=element('details'),summary=element('summary',result.id);summary.append(element('span',result.category,'tag'));if(result.error||result.checks.some(c=>!c.passed))summary.append(element('span','Needs inspection','tag flag'));const article=element('article');article.append(element('div',result.milliseconds+' ms · '+result.checks.map(c=>(c.passed?'✓ ':'✗ ')+c.name).join(' · '),'meta'));
if(result.history?.length){article.append(element('h3','Synthetic prior conversation'),element('div',result.history.map(m=>m.role+': '+m.content).join('\\n\\n'),'block'));}
article.append(element('h3','Prompt'),element('div',result.prompt,'block'),element('h3','Expected behavior'),element('p',result.expectation),element('h3','Actual reply'),element('div',result.output||result.error||'No output','block answer'));
const review=element('div',undefined,'review'),select=element('select');select.setAttribute('aria-label','Review '+result.id);for(const [value,label] of [['unreviewed','Not reviewed'],['good','Looks good'],['adjust','Needs adjustment']]){const option=element('option',label);option.value=value;select.append(option);}select.value=result.review;select.onchange=()=>{result.review=select.value;counts();};review.append(element('span','Your assessment'),select);const notes=element('textarea');notes.setAttribute('aria-label','Review notes for '+result.id);notes.placeholder='What would you change?';notes.value=result.reviewNotes;notes.oninput=()=>result.reviewNotes=notes.value;article.append(review,notes);card.append(summary,article);host.append(card);}counts();}
filter.onchange=render;document.getElementById('expand').onclick=()=>host.querySelectorAll('details').forEach(card=>card.open=true);
document.getElementById('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const link=element('a');link.href=url;link.download='holmes-evaluation-reviewed.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};render();
</script></body></html>`;
}
