// Disposable browser/storage only. Never connects to the user's notes or sync server.
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await mkdtemp(join(tmpdir(), 'opplinotes-options-'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = join(process.env.OPPLINOTES_TEST_DIST || join(process.cwd(), 'dist'), path === '/' ? 'index.html' : path);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body);
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
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('goodnotes.auto','off');window.readPage=id=>new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>{const d=q.result,g=d.transaction('pages').objectStore('pages').get(id);g.onsuccess=()=>{d.close();r(g.result)}}})"});
  await send('Page.navigate',{url:base});
  await until("!!document.querySelector('.library')");
  await evaluate(`(async()=>{
    const d=await new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>r(q.result)});
    window.readPage=id=>new Promise(r=>{const q=d.transaction('pages').objectStore('pages').get(id);q.onsuccess=()=>r(q.result)});
    const c=document.createElement('canvas');c.width=2400;c.height=1600;
    c.getContext('2d').fillStyle='#ff0000';c.getContext('2d').fillRect(0,0,c.width,c.height);
    const red=await new Promise(r=>c.toBlob(r));
    c.getContext('2d').fillStyle='#0000ff';c.getContext('2d').fillRect(0,0,c.width,c.height);
    const blue=await new Promise(r=>c.toBlob(r));
    const els=[];
    for(let i=0;i<5;i++){
      const x=70+(i%20)*19,y=80+Math.floor(i/20),p=new Float32Array(256*3);
      for(let j=0;j<256;j++){p[j*3]=x+j*8/256;p[j*3+1]=y+Math.sin(j*.12)*.5;p[j*3+2]=.5}
      els.push({t:'s',id:'ink-'+i,k:'pen',c:'#123456',s:.6,p,bb:[x-.6,y-1.1,x+8.6,y+1.1]});
    }
    els.push({t:'i',id:'picture',x:120,y:280,w:240,h:140,blob:'red-image'},
      {t:'i',id:'locked',x:300,y:290,w:90,h:80,blob:'blue-image',lock:true},
      {t:'h',id:'foreground',k:'line',c:'#00ff00',s:4,x1:180,y1:330,x2:260,y2:330});
    window.originals=structuredClone(els);
    window.matchesOriginal=els=>els.length===originals.length&&els.every((e,i)=>e.t==='s'?e.id===originals[i].id&&e.s===originals[i].s&&e.p.every((v,j)=>v===originals[i].p[j]):JSON.stringify(e)===JSON.stringify(originals[i]));
    const t=d.transaction(['notebooks','pages','blobs'],'readwrite');
    t.objectStore('blobs').put(red,'red-image');t.objectStore('blobs').put(blue,'blue-image');
    t.objectStore('notebooks').put({id:'image-perf',title:'Image performance demo',folder:'',fav:false,created:1,updated:1,pages:['image-1','image-2'],margin:0,marginTpl:'blank',tpl:'blank',paper:'#fff'});
    for(let i=1;i<=2;i++)t.objectStore('pages').put({id:'image-'+i,nb:'image-perf',w:595,h:842,bg:{k:'paper',tpl:'blank',color:'#fff'},els:i===1?els:[]});
    await new Promise((r,j)=>{t.oncomplete=r;t.onerror=()=>j(t.error)});location.hash='#/n/image-perf';
  })()`);
  await until("document.querySelector('[aria-label=\"Notebook title\"]')?.value==='Image performance demo'");
  await until(`(()=>{const c=document.querySelector('.page canvas.pics'),s=c.width/595;if(!s)return false;const p=c.getContext('2d').getImageData(Math.round(240*s),Math.round(350*s),1,1).data;return p[0]>240&&p[1]<10&&p[2]<10})()`);
  const key=(key,extra={})=>evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,...${JSON.stringify(extra)}}))`);
  const point=(x,y,index=0)=>evaluate(`(()=>{const r=document.querySelectorAll('.page')[${index}].getBoundingClientRect(),z=Number(document.querySelector('.pages').style.getPropertyValue('--z'));return {x:r.left+${x}*z,y:r.top+${y}*z}})()`);
  const pointer=(type,p,extra={})=>send('Input.dispatchMouseEvent',{type,...p,button:'left',pointerType:'mouse',...extra});
  const flush=()=>evaluate("window.dispatchEvent(new Event('pagehide'))");
  const selectPicture=async()=>{
    await key('l');const p=await point(240,350);
    await pointer('mousePressed',p,{clickCount:1});await pointer('mouseReleased',p);
    await until("!!document.querySelector('.selbox')");
  };
  const change = (selector,value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const picturePoint=await point(340,320);
  await pointer('mousePressed',picturePoint,{clickCount:1});await pointer('mouseReleased',picturePoint);
  await until("!!document.querySelector('.selbox.locked')");
  assert.equal(await evaluate("!!document.querySelector('[aria-label=\"Unlock picture\"]')"),true);
  await pointer('mousePressed',picturePoint,{clickCount:1});
  await pointer('mouseMoved',{x:picturePoint.x+30,y:picturePoint.y+20},{buttons:1});
  await pointer('mouseReleased',{x:picturePoint.x+30,y:picturePoint.y+20});await flush();
  assert.equal(await evaluate("readPage('image-1').then(p=>p.els.find(e=>e.id==='locked').x)"),300,'Selecting a locked picture never moves it');
  await click('[aria-label="Unlock picture"]');await flush();
  assert.equal(await evaluate("readPage('image-1').then(p=>p.els.find(e=>e.id==='locked').lock)"),false);
  await key('z',{ctrlKey:true});await flush();
  await key('Escape');
  const touch=(type,points)=>send('Input.dispatchTouchEvent',{type,touchPoints:points.map(p=>({...p,id:1,radiusX:5,radiusY:5,force:.5}))});
  await touch('touchStart',[picturePoint]);await touch('touchEnd',[]);
  await until("!!document.querySelector('.selbox.locked')");
  await click('[aria-label="Unlock picture"]');await flush();
  assert.equal(await evaluate("readPage('image-1').then(p=>p.els.find(e=>e.id==='locked').lock)"),false,'Finger tap opens the individual unlock action');
  await key('z',{ctrlKey:true});await key('Escape');
  const panPoint=await point(340,320);
  await touch('touchStart',[panPoint]);await touch('touchMove',[{x:panPoint.x,y:panPoint.y-40}]);await touch('touchEnd',[]);
  assert.equal(await evaluate("!!document.querySelector('.selbox.locked')"),false,'A finger drag remains a pan, not a tap');
  await evaluate("document.querySelector('.viewport').scrollTop=0");await delay(200);
  await key('p');await click('[aria-label="Dotted line"]');
  const pen=async(x,y,style)=>{
    const start=await point(x,y),end=await point(x+120,y);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,pointerType:'pen',force:.5});
    for(let i=1;i<=12;i++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+(end.x-start.x)*i/12,y:start.y,button:'left',buttons:1,pointerType:'pen',force:.5});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...end,button:'left',buttons:0,pointerType:'pen'});await flush();
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.optbar')).display"),'flex','Tool settings stay visible after writing');
    assert.equal(await evaluate("readPage('image-1').then(p=>p.els.at(-1).style)"),style);
  };
  await pen(80,180,'dotted');
  await key('s');await click('[aria-label="Dashed line"]');await pen(80,220,'dashed');
  await key('p');await click('[aria-label="Pen (P)"]');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.optbar')).display"),'flex','Tapping the current tool keeps settings open');
  await send('Page.reload');await until("!!document.querySelector('.page canvas.ink')");
  assert.deepEqual(await evaluate("readPage('image-1').then(p=>p.els.slice(-2).map(e=>e.style))"),['dotted','dashed'],'Styles persist after reload');
  // Existing paper pages can also be customised and inherited by newly appended pages.
  await click('[aria-label="Settings"]');
  await evaluate("[...document.querySelectorAll('.popover button')].find(b=>b.textContent==='Paper for this page').click()");
  await change('[aria-label="Page paper pattern"]','dots');
  await change('[aria-label="Pattern spacing (mm)"]',5);
  await change('[aria-label="Line or dot size (mm)"]',.5);
  await key('Escape');await flush();
  assert.equal(await evaluate("readPage('image-1').then(p=>Math.abs(p.bg.ruling.spacing-72/25.4*5)<.001)"),true);
  const screenshot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/opplinotes-options-desktop.png',Buffer.from(screenshot.data,'base64'));
  await evaluate("window.exported=null;const create=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{if(b.type==='application/pdf')window.exported=b;return create(b)}");
  await click('[aria-label="Export"]');await evaluate("[...document.querySelectorAll('.popover button')].find(b=>b.textContent==='Export as PDF').click()");
  await until('!!window.exported');
  const bytes=await evaluate("exported.arrayBuffer().then(b=>{let s='';for(const v of new Uint8Array(b))s+=String.fromCharCode(v);return btoa(s)})");
  const exported=await PDFDocument.load(Buffer.from(bytes,'base64'));
  const contents=exported.getPage(0).node.Contents();
  let commands='';for(let i=0;i<contents.size();i++){const stream=exported.context.lookup(contents.get(i));commands+=inflateSync(stream.contents).toString();}
  assert.match(commands.match(/\[[^\]]*\] 0 d/g).join('\n'),/\[\s*0 5\s*\] 0 d/,'PDF export retains dotted ink');
  assert.match(commands.match(/\[[^\]]*\] 0 d/g).join('\n'),/\[\s*8 6\s*\] 0 d/,'PDF export retains dashed shapes');
  assert.equal(/1\.417[0-9]* w/.test(commands),true,'PDF export retains the selected dot size');
  await click('[aria-label="Back to library"]');await until("!!document.querySelector('.library')");
  const pdf=await PDFDocument.create();pdf.addPage([595,842]);const encoded=Buffer.from(await pdf.save()).toString('base64');
  await evaluate(`(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0))],'Ruling import.pdf',{type:'application/pdf'}));document.querySelector('.library').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d}))})()`);
  await until("document.querySelector('.modal h2')?.textContent==='Import PDF'");
  await evaluate("[...document.querySelectorAll('.modal .seg button')].find(b=>b.textContent.includes('Dotted')).click()");
  await change('[aria-label="Pattern spacing (mm)"]',4);
  await change('[aria-label="Line or dot size (mm)"]',.3);
  await click('.modal-actions .primary');await until("!!document.querySelector('.editor')");
  const importedId=await evaluate('decodeURIComponent(location.hash.slice(4))');
  const ruling=await evaluate(`new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>{const g=q.result.transaction('notebooks').objectStore('notebooks').get(${JSON.stringify(importedId)});g.onsuccess=()=>r(g.result.marginRuling)}})`);
  assert(Math.abs(ruling.spacing-4*72/25.4)<.001);assert(Math.abs(ruling.weight-.3*72/25.4)<.001);
  await click('[aria-label="Writing space beside PDF pages"]');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Pattern spacing (mm)\"]').value"),'4');
  await change('[aria-label="Pattern spacing (mm)"]',6);await key('Escape');await flush();
  await send('Page.reload');await until("!!document.querySelector('.editor')");
  await click('[aria-label="Writing space beside PDF pages"]');
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Pattern spacing (mm)\"]').value"),'6','PDF ruling settings persist and can be edited later');
  await key('Escape');
  await click('[aria-label="Add page or writing space"]');
  await evaluate("[...document.querySelectorAll('.popover button')].find(b=>b.textContent==='New page after').click()");
  await until("document.querySelector('.modal h2')?.textContent==='New page'");
  await click('.modal-actions .primary');
  await until("document.querySelectorAll('.page').length===2");
  await flush();
  assert.equal(await evaluate(`new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>{const g=q.result.transaction('pages').objectStore('pages').getAll();g.onsuccess=()=>r(g.result.some(p=>p.nb===${JSON.stringify(importedId)}&&p.bg.k==='paper'&&p.bg.tpl==='dots'&&Math.abs(p.bg.ruling.spacing-6*72/25.4)<.001))}})`),true,'Appended paper inherits the custom ruling dimensions');
  await click('[aria-label="Back to library"]');await until("!!document.querySelector('.library')");
  await click('[aria-label="New notebook"]');
  await evaluate("[...document.querySelectorAll('.modal .seg button')].find(b=>b.textContent.includes('Grid')).click()");
  await change('[aria-label="Pattern spacing (mm)"]',3);
  await click('.modal-actions .primary');await until("!!document.querySelector('.editor')");
  const freshId=await evaluate('decodeURIComponent(location.hash.slice(4))');
  assert.equal(await evaluate(`new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>{const g=q.result.transaction('pages').objectStore('pages').getAll();g.onsuccess=()=>r(g.result.some(p=>p.nb===${JSON.stringify(freshId)}&&p.bg.tpl==='grid'&&Math.abs(p.bg.ruling.spacing-3*72/25.4)<.001))}})`),true,'New notebook creation saves the selected ruling dimensions');
  assert.deepEqual(exceptions,[]);
  console.log('PASS: mouse/finger unlock individual pictures without moving them; panning is retained, settings stay open, dotted/dashed ink and paper dimensions persist and export, PDF imports accept editable dimensions.');
} finally {
  ws?.close();browser.kill('SIGTERM');await new Promise(resolve=>server.close(resolve));await delay(300);await rm(temp,{recursive:true,force:true});
}
