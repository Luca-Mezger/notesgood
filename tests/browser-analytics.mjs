// Disposable browser/storage only. Never connects to the user's notes or sync server.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { analyticsData, mergeAnalytics } from '../server/analytics.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await mkdtemp(join(tmpdir(), 'opplinotes-analytics-'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const remote = new Map(); let revision = 0;
const helper = (await build({stdin:{contents:"export * from './src/sync'; export * from './src/activity-store';",resolveDir:process.cwd()},bundle:true,format:'esm',write:false})).outputFiles[0].text;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), path = url.pathname;
    if(path==='/test-sync.mjs'){res.writeHead(200,{'Content-Type':'text/javascript'}).end(helper);return}
    if(path==='/test-sync'){
      if(req.headers['x-sync-key']!=='test-only-key'){res.writeHead(401).end('{}');return}
      if(url.searchParams.get('a')==='push'){
        const chunks=[];for await(const c of req)chunks.push(c);
        for(const item of JSON.parse(Buffer.concat(chunks)).items){
          const old=remote.get(item.id);
          if(item.k==='a')item.data=mergeAnalytics(old?.data,analyticsData(item.data,item.id));
          remote.set(item.id,{...item,rev:++revision});
        }
        res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({rev:revision,skipped:[]}));return;
      }
      const since=Number(url.searchParams.get('since')||0);
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({rev:revision,items:[...remote.values()].filter(i=>i.rev>since)}));return;
    }
    const file = join(process.env.OPPLINOTES_TEST_DIST || join(process.cwd(), 'dist'), path === '/' ? 'index.html' : path);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const profile = join(temp, 'profile');
const browser = spawn(process.env.CHROMIUM_BIN || 'chromium', ['--headless=new', '--no-first-run', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await delay(100); } }
  assert(port, 'Headless Chromium did not start');
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0;
  const pending = new Map(), exceptions = [];
  let nativeDrag;
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data), entry = pending.get(message.id);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
    if (message.method === 'Input.dragIntercepted') nativeDrag = message.params.data;
    if (entry) { pending.delete(message.id); message.error ? entry.reject(Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(50); } throw Error('Timed out: ' + expression); };
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('goodnotes.auto','off')"});
  await send('Page.navigate',{url:base});
  await until("!!document.querySelector('.library')");
  // Simulate the analytics database from the previous local-only release.
  await evaluate(`(async()=>{const d=await new Promise(r=>{const q=indexedDB.open('opplinotes-analytics',1);q.onupgradeneeded=()=>q.result.createObjectStore('buckets',{keyPath:'id'});q.onsuccess=()=>r(q.result)});const kinds=['writing','highlighting','erasing','editing','navigation','reading','idle','away'],keys=['opens','pageViews','pageSwitches','awaySwitches','returns','focusStarts','strokes','highlights','erasures','selections','transforms','undos','redos','zooms','scrolls','characters'];const t=d.transaction('buckets','readwrite');const at=Date.now();t.objectStore('buckets').put({id:'legacy-session:page-1',session:'legacy-session',day:new Date().toLocaleDateString('sv-SE'),notebook:'math',page:'math-1',pageNumber:1,title:'Linear algebra',folder:'ETH / Linalg',minute:Math.floor(at/60000)*60000,start:at,end:at,ms:Object.fromEntries(kinds.map(k=>[k,0])),counts:Object.fromEntries(keys.map(k=>[k,0]))});await new Promise(r=>t.oncomplete=r);d.close()})()`);
  await evaluate(`(async()=>{
    const d=await new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>r(q.result)});
    const t=d.transaction(['notebooks','pages'],'readwrite');
    for(const [id,title,folder] of [['math','Linear algebra','ETH / Linalg'],['code','Programming','ETH / Eprog']]){
      t.objectStore('notebooks').put({id,title,folder,fav:false,created:1,updated:1,pages:[id+'-1',id+'-2'],margin:0,marginTpl:'dots',tpl:'dots',paper:'#fff'});
      for(let i=1;i<=2;i++)t.objectStore('pages').put({id:id+'-'+i,nb:id,w:595,h:842,bg:{k:'paper',tpl:'dots',color:'#fff'},els:[]});
    }
    await new Promise(r=>t.oncomplete=r);localStorage.setItem('opplinotes.analytics.idle','15');location.hash='#/n/math';
  })()`);
  await until("!!document.querySelector('.editor')");
  await send('Page.bringToFront');
  await evaluate("window.dispatchEvent(new Event('focus'))");
  assert.equal(await evaluate('document.hasFocus()'),true);
  const point=()=>evaluate(`(()=>{const r=document.querySelector('.page').getBoundingClientRect();return {x:r.left+150,y:r.top+200}})()`);
  let p=await point();
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',buttons:1,pointerType:'pen',force:.5,clickCount:1});
  await delay(350);
  for(let i=1;i<=5;i++){await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+i*10,y:p.y+i*3,buttons:1,pointerType:'pen',force:.5});await delay(70)}
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x+50,y:p.y+15,button:'left',buttons:0,pointerType:'pen',force:0});
  // Hover is not writing and cannot postpone the idle timeout.
  for(let i=0;i<3;i++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+i*2,y:p.y+80,pointerType:'pen',buttons:0,force:0});
  await delay(500);
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:p.x,y:p.y,deltaY:100,deltaX:0});
  await delay(700);
  await click('[aria-label="Undo (Ctrl+Z)"]');
  // One physical switch produces blur + visibility events; only one interruption is counted.
  await evaluate("window.testFocus=false;Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>window.testFocus});window.dispatchEvent(new Event('blur'));document.dispatchEvent(new Event('visibilitychange'))");
  await delay(1100);
  await evaluate("window.testFocus=true;window.dispatchEvent(new Event('focus'))");
  await delay(17000);
  await evaluate("location.hash='#/analytics'");
  await until("!!document.querySelector('.analytics')");
  const readRows=()=>evaluate(`(async()=>{const d=await new Promise(r=>{const q=indexedDB.open('opplinotes-analytics');q.onsuccess=()=>r(q.result)});return await new Promise(r=>{const q=d.transaction('buckets').objectStore('buckets').getAll();q.onsuccess=()=>r(q.result)})})()`);
  const rows=await readRows();
  const totals=rows.reduce((s,b)=>{for(const k in b.ms)s[k]=(s[k]||0)+b.ms[k];for(const k in b.counts)s[k]=(s[k]||0)+b.counts[k];return s},{});
  assert.equal(totals.strokes,1);assert(totals.writing>500&&totals.writing<1500,JSON.stringify(totals));
  assert(totals.navigation>200);assert(totals.away>900);assert(totals.idle>1000);assert.equal(totals.awaySwitches,1);assert.equal(totals.undos,1);
  assert(rows.every(b=>b.notebook==='math'&&b.folder==='ETH / Linalg'&&b.page==='math-1'));
  assert(rows.every(b=>!('points'in b)&&!('text'in b)&&!('coordinates'in b)));
  assert.equal(await evaluate("document.querySelectorAll('.analytics-heat-cell').length"),168);
  assert.equal(await evaluate("document.querySelector('.analytics-breakdown tbody')?.textContent.includes('ETH / Linalg')"),true);
  await click('.analytics-drill');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Analytics folder\"]').value"),'ETH / Linalg');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Group statistics by\"]').value"),'notebook');
  await click('.analytics-drill');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Analytics notebook\"]').value"),'math');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Group statistics by\"]').value"),'page');
  await click('.analytics-drill');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Analytics page\"]').value"),'math-1');
  await evaluate(`window.exports=[];window.oldURL=URL.createObjectURL;window.oldClick=HTMLAnchorElement.prototype.click;URL.createObjectURL=b=>{window.exports.push(b);return 'blob:test'};HTMLAnchorElement.prototype.click=function(){}`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Export CSV').click()`);
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Export JSON').click()`);
  assert.equal(await evaluate(`exports[0].text().then(t=>t.includes('writing_seconds')&&t.includes('ETH / Linalg'))`),true);
  assert.equal(await evaluate(`exports[1].text().then(t=>JSON.parse(t).buckets.every(b=>b.page==='math-1'))`),true);
  await evaluate(`URL.createObjectURL=window.oldURL;HTMLAnchorElement.prototype.click=window.oldClick`);
  // Save screenshots of synthetic test data only, desktop and narrow mobile.
  await writeFile(join(temp,'analytics-desktop.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  await writeFile('/tmp/opplinotes-analytics-mobile.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
  await writeFile('/tmp/opplinotes-analytics-desktop.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  // Offline reload retains the records, and analytics views themselves generate no time.
  const before=await readRows();
  await send('Network.enable');await send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  assert.equal(await evaluate('navigator.onLine'),false);
  await evaluate("location.hash='#/n/code'");await until("!!document.querySelector('.editor')");
  await delay(500);await evaluate("location.hash='#/analytics'");await until("!!document.querySelector('.analytics')");
  const after=await readRows();assert(after.length>=before.length);assert(after.some(b=>b.notebook==='code'));
  await send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await evaluate(`localStorage.setItem('opplinotes.analytics.pending.old-journal',JSON.stringify(${JSON.stringify(after.slice(0,1).map(b=>({...b,ms:Object.fromEntries(Object.keys(b.ms).map(k=>[k,0])),counts:Object.fromEntries(Object.keys(b.counts).map(k=>[k,0]))})))}))`);
  await send('Page.reload');await until("!!document.querySelector('.analytics')");
  const reloaded=await readRows();assert.deepEqual(reloaded,after);
  // Pausing stops future sessions; records already collected remain available.
  await evaluate("document.querySelector('.analytics-method').open=true");
  await click('.analytics-method input[type=checkbox]');
  await evaluate("location.hash='#/n/code'");await until("!!document.querySelector('.editor')");await delay(500);
  await evaluate("location.hash='#/analytics'");await until("!!document.querySelector('.analytics')");
  assert.deepEqual(await readRows(),after);
  // A failed telemetry worker cannot break the editor or eat pen events.
  await evaluate(`localStorage.setItem('opplinotes.analytics.enabled','on');window.RealWorker=Worker;window.Worker=class extends RealWorker{constructor(...args){super(...args);window.testWorker=this}};location.hash='#/n/code'`);
  await until("!!document.querySelector('.editor') && !!window.testWorker?.onerror");
  await evaluate(`window.testWorker.onerror(new ErrorEvent('error',{cancelable:true,message:'Deliberate analytics failure'}))`);
  p=await point();
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',buttons:1,pointerType:'pen',force:.5,clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+40,y:p.y+10,buttons:1,pointerType:'pen',force:.5});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x+40,y:p.y+10,button:'left',buttons:0,pointerType:'pen',force:0});
  await evaluate("location.hash='#/analytics'");await until("!!document.querySelector('.analytics')");
  assert.equal(await evaluate(`(async()=>{const d=await new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>r(q.result)});return new Promise(r=>{const q=d.transaction('pages').objectStore('pages').get('code-1');q.onsuccess=()=>r(q.result.els.filter(e=>e.t==='s').length)})})()`),1,'Pen input must still save after the analytics worker fails');
  assert.deepEqual(await readRows(),after,'Failed analytics must not mutate stored statistics or block note saving');
  await evaluate(`(async()=>{window.syncTest=await import('/test-sync.mjs');syncTest.saveSyncConfig({url:location.origin+'/test-sync',key:'test-only-key',rev:0,last:0})})()`);
  assert.equal(await evaluate(`syncTest.pendingActivity().then(r=>r.length>0)`),true,'Existing local-only history must be queued');
  await evaluate(`syncTest.sync()`);
  assert.equal(await evaluate(`syncTest.pendingActivity().then(r=>r.length)`),0);
  const uploaded=[...remote.values()].filter(i=>i.k==='a');assert.equal(uploaded.length,after.length);
  const expected=uploaded.reduce((n,i)=>n+i.data.ms.writing,0);
  // Acknowledging an older upload must not clear newer changes made during the request.
  assert.equal(await evaluate(`(async()=>{const old=await syncTest.activityRows();const b=structuredClone(old[0]);b.end+=100;b.counts.strokes++;await syncTest.writeActivity([b]);const sent=await syncTest.pendingActivity();b.end+=100;b.counts.strokes++;await syncTest.writeActivity([b]);await syncTest.acknowledgeActivity(sent);return(await syncTest.pendingActivity()).length>0})()`),true);
  await evaluate(`syncTest.sync()`);
  const finalA=[...remote.values()].filter(i=>i.k==='a').map(i=>i.data);
  // Clear only the disposable analytics stores to simulate a second device with no local history.
  await evaluate(`(async()=>{const d=await new Promise(r=>{const q=indexedDB.open('opplinotes-analytics');q.onsuccess=()=>r(q.result)});await new Promise(r=>{const t=d.transaction(['buckets','dirty'],'readwrite');t.objectStore('buckets').clear();t.objectStore('dirty').clear();t.oncomplete=r});syncTest.saveSyncConfig({...syncTest.syncConfig(),rev:0});await syncTest.sync()})()`);
  assert.deepEqual((await readRows()).sort((a,b)=>a.id.localeCompare(b.id)),finalA.sort((a,b)=>a.id.localeCompare(b.id)),'A fresh device must download all sessions');
  assert.equal(await evaluate(`syncTest.pendingActivity().then(r=>r.length)`),0,'Pulled data must not echo back');
  await evaluate(`(async()=>{const b=structuredClone((await syncTest.activityRows())[0]);b.session='device-b-session';b.id=b.session+':'+b.minute+':'+b.page;await syncTest.writeActivity([b]);await syncTest.sync();await syncTest.sync()})()`);
  assert.equal([...remote.values()].filter(i=>i.k==='a').length,after.length+1,'Repeated sync must not duplicate sessions');
  assert.equal([...remote.values()].filter(i=>i.k==='a').reduce((n,i)=>n+i.data.ms.writing,0)>=expected,true);
  await evaluate(`syncTest.saveSyncConfig({url:'',key:'',rev:0,last:0})`);
  console.log('PASS: local history upload, private cross-device pull, in-flight edit protection, no echo loops and no duplicate session time.');
  assert.deepEqual(exceptions,[]);
  console.log('PASS: actual pen writing, navigation, undo, AFK exclusion, deduplicated window switches, folder/notebook/page drilldown, local persistence, offline collection, pause control mobile layout, and pen input after a deliberate worker failure.');
} finally {
  ws?.close();browser.kill('SIGTERM');await new Promise(resolve=>server.close(resolve));await delay(300);await rm(temp,{recursive:true,force:true});
}
