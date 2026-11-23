// Disposable browser/storage only. Never connects to the user's notes or sync server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await mkdtemp(join(tmpdir(), 'opplinotes-images-'));
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
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('goodnotes.auto','off')"});
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
    for(let i=0;i<2000;i++){
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
  await selectPicture();
  await evaluate(`(()=>{
    window.pageDraws=0;document.addEventListener('pointerdown',e=>window.testPointerId=e.pointerId,true);
    for(const method of ['stroke','clearRect','drawImage']){
      const original=CanvasRenderingContext2D.prototype[method];
      CanvasRenderingContext2D.prototype[method]=function(...args){if(this.canvas.matches('.page > canvas:not(.selection-preview)'))pageDraws++;return original.apply(this,args)};
    }
  })()`);
  const baseline=process.env.OPPLINOTES_BENCHMARK_ONLY==='1';
  const start=await point(240,350);
  await pointer('mousePressed',start,{clickCount:1});
  if(!baseline){
    assert.equal(await evaluate("document.querySelectorAll('.selection-preview.pics').length"),2,'Cache pictures in their original stacking order');
    assert.equal(await evaluate(`(()=>{const p=[...document.querySelectorAll('.selection-preview.pics')];return p[0].dataset.selected==='true'&&p[1].dataset.selected==='false'&&!!(p[1].compareDocumentPosition(document.querySelector('.page > canvas.ink'))&Node.DOCUMENT_POSITION_FOLLOWING)})()`),true,'The locked picture stays above the selected picture; handwriting stays above both');
    await evaluate("document.documentElement.dataset.theme='dark'");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.selection-preview.pics')).filter"),'none','Dark mode must not invert picture colours');
    await evaluate("document.documentElement.dataset.theme='light'");
  }
  const timing=await evaluate(`(async()=>{
    pageDraws=0;const v=document.querySelector('.viewport'),times=[],intervals=[];let last=performance.now();
    for(let i=1;i<=30;i++){
      await new Promise(requestAnimationFrame);const now=performance.now();if(i>1)intervals.push(now-last);last=now;const t=performance.now();
      for(let j=0;j<4;j++)v.dispatchEvent(new PointerEvent('pointermove',{pointerId:testPointerId,pointerType:'mouse',clientX:${start.x}+i+j/4,clientY:${start.y}+i/2,buttons:1,bubbles:true}));
      document.querySelector('.selbox').getBoundingClientRect();times.push(performance.now()-t);
    }
    await new Promise(requestAnimationFrame);times.sort((a,b)=>a-b);intervals.sort((a,b)=>a-b);
    return {image:'2400x1600',backgroundPoints:512000,updates:120,pageDraws,meanMs:times.reduce((a,b)=>a+b,0)/times.length,p95Ms:times[Math.floor(times.length*.95)],frameP95Ms:intervals[Math.floor(intervals.length*.95)]};
  })()`);
  console.log('IMAGE BENCHMARK '+JSON.stringify(timing));
  await pointer('mouseReleased',{x:start.x+30.75,y:start.y+15});
  if(!baseline){
    assert.equal(timing.pageDraws,0,'Moving a picture must not redraw dense background ink or pictures');
    assert.equal(await evaluate("document.querySelectorAll('.selection-preview').length"),0);
    await flush();
    assert.equal(await evaluate(`readPage('image-1').then(p=>{const e=p.els.find(e=>e.id==='picture');return Math.abs(e.x-120-30.75/1.7)<1e-6&&Math.abs(e.y-280-15/1.7)<1e-6&&e.blob==='red-image'})`),true);
    assert.equal(await evaluate("readPage('image-1').then(p=>matchesOriginal(p.els.map(e=>e.id==='picture'?originals.find(o=>o.id===e.id):e)))"),true,'Moving an image preserves all background ink and locked images');
    await key('z',{ctrlKey:true});await flush();
    assert.equal(await evaluate("readPage('image-1').then(p=>matchesOriginal(p.els))"),true,'Image moves remain exactly undoable');
    await selectPicture();
    const handle=await evaluate("(()=>{const r=document.querySelector('.selhandle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await pointer('mousePressed',handle,{clickCount:1});await evaluate('pageDraws=0');
    for(let i=1;i<=20;i++)await pointer('mouseMoved',{x:handle.x+i*2,y:handle.y+i},{buttons:1});
    assert.equal(await evaluate('pageDraws'),0,'Scaling an image must not repaint the page');
    await pointer('mouseReleased',{x:handle.x+40,y:handle.y+20});await flush();
    assert.equal(await evaluate("readPage('image-1').then(p=>{const e=p.els.find(e=>e.id==='picture');return e.w>240&&e.h>140&&e.blob==='red-image'})"),true);
    await key('z',{ctrlKey:true});await flush();
    assert.equal(await evaluate("readPage('image-1').then(p=>matchesOriginal(p.els))"),true);
    await selectPicture();const cancelStart=await point(240,350);
    await pointer('mousePressed',cancelStart,{clickCount:1});await pointer('mouseMoved',{x:cancelStart.x+40,y:cancelStart.y+20},{buttons:1});
    await evaluate("document.querySelector('.viewport').dispatchEvent(new PointerEvent('pointercancel',{pointerId:testPointerId,pointerType:'mouse',bubbles:true}))");await flush();
    assert.equal(await evaluate("document.querySelectorAll('.selection-preview').length"),0);
    assert.equal(await evaluate("readPage('image-1').then(p=>matchesOriginal(p.els))"),true,'Cancel restores picture metadata and colours');
    // Select a picture and foreground ink together using a real lasso gesture.
    await key('Escape');await key('l');const loop=[];
    for(const [x,y]of [[110,270],[380,270],[380,430],[110,430],[110,270]])loop.push(await point(x,y));
    await pointer('mousePressed',loop[0],{clickCount:1});for(const p of loop.slice(1))await pointer('mouseMoved',p,{buttons:1});await pointer('mouseReleased',loop.at(-1));
    await until("!!document.querySelector('.selbox')");
    const mixedStart=await point(240,350);await pointer('mousePressed',mixedStart,{clickCount:1});await evaluate('pageDraws=0');
    assert.equal(await evaluate("document.querySelectorAll('.selection-preview.ink').length"),1,'Mixed image and ink selections have separate cached layers');
    await pointer('mouseMoved',{x:mixedStart.x+20,y:mixedStart.y+10},{buttons:1});
    assert.equal(await evaluate('pageDraws'),0);
    await pointer('mouseReleased',{x:mixedStart.x+20,y:mixedStart.y+10});await flush();
    assert.equal(await evaluate("readPage('image-1').then(p=>p.els.find(e=>e.id==='picture').x>120&&p.els.find(e=>e.id==='foreground').x1>180&&p.els.find(e=>e.id==='locked').x===300)"),true,'Move image and ink together while keeping locked pictures fixed');
    await key('z',{ctrlKey:true});await flush();
    assert.equal(await evaluate("readPage('image-1').then(p=>matchesOriginal(p.els))"),true);
    await selectPicture();for(let i=0;i<6;i++)await key('-',{ctrlKey:true});await delay(250);
    await evaluate("document.querySelector('.viewport').scrollTop=0");
    const crossStart=await point(240,350),crossEnd=await point(240,150,1);
    await pointer('mousePressed',crossStart,{clickCount:1});await pointer('mouseMoved',crossEnd,{buttons:1});await pointer('mouseReleased',crossEnd);await flush();
    assert.equal(await evaluate("readPage('image-2').then(p=>p.els.length===1&&p.els[0].blob==='red-image')"),true,'Image identity survives moving onto another page');
    await key('z',{ctrlKey:true});await flush();
    assert.equal(await evaluate("readPage('image-1').then(p=>matchesOriginal(p.els))"),true);
    assert.equal(await evaluate("readPage('image-2').then(p=>p.els.length)"),0);
    // A picture may finish decoding after the user has already started dragging it.
    await evaluate(`(async()=>{
      const d=await new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>r(q.result)});
      const source=await new Promise(r=>{const q=d.transaction('blobs').objectStore('blobs').get('red-image');q.onsuccess=()=>r(q.result)});
      const original=createImageBitmap,gate=new Promise(r=>window.releaseDecode=r);
      window.restoreDecoder=()=>{window.createImageBitmap=original};
      window.createImageBitmap=async(...args)=>{await gate;return original(...args)};
      const t=d.transaction(['blobs','notebooks','pages'],'readwrite');
      t.objectStore('blobs').put(source,'late-image');
      t.objectStore('notebooks').put({id:'late',title:'Delayed image demo',folder:'',fav:false,created:1,updated:1,pages:['late-1'],margin:0,marginTpl:'blank',tpl:'blank',paper:'#fff'});
      t.objectStore('pages').put({id:'late-1',nb:'late',w:595,h:842,bg:{k:'paper',tpl:'blank',color:'#fff'},els:[{t:'i',id:'late-picture',x:100,y:100,w:160,h:100,blob:'late-image'}]});
      await new Promise((r,j)=>{t.oncomplete=r;t.onerror=()=>j(t.error)});d.close();location.hash='#/n/late';
    })()`);
    await until("document.querySelector('[aria-label=\"Notebook title\"]')?.value==='Delayed image demo'");
    await until("document.querySelector('.page canvas.pics')?.width>0");
    await key('l');const latePoint=await point(180,150);
    await pointer('mousePressed',latePoint,{clickCount:1});await pointer('mouseReleased',latePoint);
    await pointer('mousePressed',latePoint,{clickCount:1});await pointer('mouseMoved',{x:latePoint.x+20,y:latePoint.y+10},{buttons:1});
    await until("!!document.querySelector('.selection-preview.pics')");
    await evaluate('releaseDecode()');
    await until(`(()=>{const c=document.querySelector('.selection-preview.pics');if(!c)return false;const p=c.getContext('2d').getImageData(c.width>>1,c.height>>1,1,1).data;return p[0]>240&&p[1]<10&&p[2]<10})()`);
    await pointer('mouseReleased',{x:latePoint.x+20,y:latePoint.y+10});await flush();
    await evaluate('restoreDecoder()');
    assert.equal(await evaluate("readPage('late-1').then(p=>p.els[0].blob==='late-image'&&p.els[0].x>100)"),true,'Late-decoded images must appear in the active preview and commit normally');
    console.log('PASS: large images and mixed image/ink selections move and scale without page redraws; stacking, colours, precise metadata, undo, cancellation and cross-page moves are preserved.');
  }
  assert.deepEqual(exceptions,[]);
} finally {
  ws?.close();browser.kill('SIGTERM');await new Promise(resolve=>server.close(resolve));await delay(300);await rm(temp,{recursive:true,force:true});
}
