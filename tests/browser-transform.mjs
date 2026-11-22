// Disposable browser/storage only. Never connects to the user's notes or sync server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = await mkdtemp(join(tmpdir(), 'opplinotes-transform-'));
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
    localStorage.setItem('goodnotes.auto','off');
    const d=await new Promise(r=>{const q=indexedDB.open('margin');q.onsuccess=()=>r(q.result)});
    window.readPage=id=>new Promise(r=>{const q=d.transaction('pages').objectStore('pages').get(id);q.onsuccess=()=>r(q.result)});
    const t=d.transaction(['notebooks','pages'],'readwrite'),els=[];
    for(let i=0;i<2200;i++){
      const selected=i<2000,n=selected?256:128;
      const x=70+(i%20)*19,y=(selected?100:400)+Math.floor((selected?i:i-2000)/20)*1.3;
      const p=new Float32Array(n*3);
      for(let j=0;j<n;j++){p[j*3]=x+j*8/n;p[j*3+1]=y+Math.sin(j*.12)*.5;p[j*3+2]=.5;}
      els.push({t:'s',id:'stroke-'+i,k:'pen',c:'#123456',s:.6,p,bb:[x-.6,y-1.1,x+8.6,y+1.1]});
    }
    window.originals=structuredClone(els);
    t.objectStore('notebooks').put({id:'perf',title:'Transform performance demo',folder:'',fav:false,created:1,updated:1,pages:['perf-1','perf-2'],margin:0,marginTpl:'blank',tpl:'blank',paper:'#fff'});
    for(let i=1;i<=2;i++)t.objectStore('pages').put({id:'perf-'+i,nb:'perf',w:595,h:842,bg:{k:'paper',tpl:'blank',color:'#fff'},els:i===1?els:[]});
    await new Promise((r,j)=>{t.oncomplete=r;t.onerror=()=>j(t.error)});location.hash='#/n/perf';
  })()`);
  await until("document.querySelector('[aria-label=\"Notebook title\"]')?.value==='Transform performance demo'");
  await until("document.querySelector('.page canvas.ink').width>0");
  const key=(key,extra={})=>evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,...${JSON.stringify(extra)}}))`);
  const point=async(x,y,index=0)=>evaluate(`(()=>{const r=document.querySelectorAll('.page')[${index}].getBoundingClientRect(),z=Number(document.querySelector('.pages').style.getPropertyValue('--z'));return {x:r.left+${x}*z,y:r.top+${y}*z}})()`);
  const pointer=(type,p,extra={})=>send('Input.dispatchMouseEvent',{type,...p,button:'left',pointerType:'pen',force:type==='mouseReleased'?0:.5,...extra});
  const selectInk=async()=>{
    await key('l');
    const points=[];
    for(const [x,y]of [[50,80],[470,80],[470,250],[50,250],[50,80]])points.push(await point(x,y));
    await pointer('mousePressed',points[0],{clickCount:1});
    for(const p of points.slice(1))await pointer('mouseMoved',p,{buttons:1});
    await pointer('mouseReleased',points.at(-1));
    await until("!!document.querySelector('.selbox')");
  };
  await selectInk();
  const baseline=process.env.OPPLINOTES_BENCHMARK_ONLY==='1';
  await evaluate(`(()=>{
    window.pageDraws=0;
    document.addEventListener('pointerdown',e=>window.testPointerId=e.pointerId,true);
    for(const method of ['stroke','clearRect','drawImage']){
      const original=CanvasRenderingContext2D.prototype[method];
      CanvasRenderingContext2D.prototype[method]=function(...args){
        if(this.canvas.matches('.page > canvas:not(.selection-preview)'))pageDraws++;
        return original.apply(this,args);
      };
    }
  })()`);
  const start=await point(240,170);
  await pointer('mousePressed',start,{clickCount:1});
  if(!baseline) assert.equal(await evaluate("document.querySelectorAll('.selection-preview').length"),1);
  const timing=await evaluate(`(async()=>{
    window.pageDraws=0;const v=document.querySelector('.viewport'),times=[];let last=performance.now();const intervals=[];
    for(let i=1;i<=30;i++){
      await new Promise(requestAnimationFrame);
      const now=performance.now();if(i>1)intervals.push(now-last);last=now;
      const start=performance.now();
      for(let j=0;j<4;j++)v.dispatchEvent(new PointerEvent('pointermove',{pointerId:window.testPointerId,pointerType:'pen',clientX:${start.x}+i+j/4,clientY:${start.y}+i/2,buttons:1,pressure:.5,bubbles:true}));
      document.querySelector('.selbox').getBoundingClientRect();
      times.push(performance.now()-start);
    }
    await new Promise(requestAnimationFrame);
    times.sort((a,b)=>a-b);intervals.sort((a,b)=>a-b);
    return {strokes:2000,points:512000,updates:120,pageDraws,meanMs:times.reduce((a,b)=>a+b,0)/times.length,p95Ms:times[Math.floor(times.length*.95)],frameP95Ms:intervals[Math.floor(intervals.length*.95)]};
  })()`);
  console.log('BENCHMARK '+JSON.stringify(timing));
  await pointer('mouseReleased',{x:start.x+30.75,y:start.y+15});
  if(!baseline){
    assert.equal(timing.pageDraws,0,'Dragging ink must not redraw page canvases on any animation frame');
    assert.equal(await evaluate("document.querySelectorAll('.selection-preview').length"),0);
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    const dx=30.75/1.7,dy=15/1.7;
    assert.equal(await evaluate(`(async()=>{
      const els=(await readPage('perf-1')).els;
      return els.length===2200&&els.every((e,i)=>{
        const p=originals[i].p;
        return e.p.every((v,j)=>v===(i<2000&&j%3!==2?Math.fround(p[j]+(j%3===0?${dx}:${dy})):p[j]));
      });
    })()`),true,'Every selected sample is transformed once, and untouched ink stays exact');
    await key('z',{ctrlKey:true});
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    assert.equal(await evaluate("readPage('perf-1').then(p=>p.els.every((e,i)=>e.p.every((v,j)=>v===originals[i].p[j])))"),true,'Undo restores all 512,000 selected samples exactly');
    await selectInk();
    const handle=await evaluate("(()=>{const r=document.querySelector('.selhandle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await pointer('mousePressed',handle,{clickCount:1});
    await evaluate('window.pageDraws=0');
    for(let i=1;i<=20;i++)await pointer('mouseMoved',{x:handle.x+i*3,y:handle.y+i},{buttons:1});
    assert.equal(await evaluate('window.pageDraws'),0,'Scaling ink must not redraw page canvases');
    assert.equal(await evaluate("document.querySelectorAll('.selection-preview').length"),1);
    await pointer('mouseReleased',{x:handle.x+60,y:handle.y+20});
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    assert.equal(await evaluate("readPage('perf-1').then(p=>p.els[0].s>originals[0].s)"),true,'Scaling updates the actual stroke widths on release');
    await key('z',{ctrlKey:true});
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    assert.equal(await evaluate("readPage('perf-1').then(p=>p.els.every((e,i)=>e.p.every((v,j)=>v===originals[i].p[j])))"),true);
    await selectInk();
    const cancelStart=await point(240,170);
    await pointer('mousePressed',cancelStart,{clickCount:1});
    await pointer('mouseMoved',{x:cancelStart.x+50,y:cancelStart.y+20},{buttons:1});
    await evaluate(`document.querySelector('.viewport').dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.testPointerId,pointerType:'pen',bubbles:true}))`);
    assert.equal(await evaluate("document.querySelectorAll('.selection-preview').length"),0,'Canceled gestures must remove the cached layer');
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    assert.equal(await evaluate("readPage('perf-1').then(p=>p.els.every((e,i)=>e.p.every((v,j)=>v===originals[i].p[j])))"),true,'Cancel preserves every original sample');
    const rotationHandle=await evaluate("(()=>{const r=document.querySelector('.selrot').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await pointer('mousePressed',rotationHandle,{clickCount:1});
    await evaluate('window.pageDraws=0');
    await pointer('mouseMoved',{x:rotationHandle.x+60,y:rotationHandle.y+30},{buttons:1});
    assert.equal(await evaluate('window.pageDraws'),0,'Rotating ink must also use the cached layer');
    await pointer('mouseReleased',{x:rotationHandle.x+60,y:rotationHandle.y+30});
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    assert.equal(await evaluate("readPage('perf-1').then(p=>p.els[0].p[0]!==originals[0].p[0])"),true);
    await key('z',{ctrlKey:true});
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    assert.equal(await evaluate("readPage('perf-1').then(p=>p.els.every((e,i)=>e.p.every((v,j)=>v===originals[i].p[j])))"),true,'Rotation remains exactly undoable');
    await selectInk();
    // Fit two pages on screen to exercise moving ink across a page boundary.
    for(let i=0;i<6;i++)await key('-',{ctrlKey:true});
    await delay(250);
    await evaluate("document.querySelector('.viewport').scrollTop=0");
    const crossStart=await point(240,170),crossEnd=await point(240,100,1);
    await pointer('mousePressed',crossStart,{clickCount:1});
    await pointer('mouseMoved',crossEnd,{buttons:1});
    await pointer('mouseReleased',crossEnd);
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    assert.equal(await evaluate("readPage('perf-2').then(p=>p.els.length)"),2000,'Cached selections still move onto another page');
    assert.equal(await evaluate("readPage('perf-1').then(p=>p.els.length)"),200);
    await send('Page.reload');
    await until("!!document.querySelector('.editor')");
    // The helper connection to IndexedDB is intentionally recreated after reload.
    await evaluate(`window.readPage=id=>new Promise(r=>{const o=indexedDB.open('margin');o.onsuccess=()=>{const d=o.result,q=d.transaction('pages').objectStore('pages').get(id);q.onsuccess=()=>{d.close();r(q.result)}}})`);
    await key('z',{ctrlKey:true});
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    assert.equal(await evaluate("readPage('perf-1').then(p=>p.els.length)"),2200,'Undo restores the source page after reloading');
    assert.equal(await evaluate("readPage('perf-2').then(p=>p.els.length)"),0,'Undo also clears the destination after reloading');
    assert.equal(await evaluate("readPage('perf-1').then(p=>{const e=p.els.find(e=>e.id==='stroke-0');return e.p[0]===70&&e.p[1]===100})"),true,'Cross-page undo must restore the original coordinates as well as the page');
    await key('y',{ctrlKey:true});
    await evaluate("window.dispatchEvent(new Event('pagehide'))");
    assert.equal(await evaluate("readPage('perf-2').then(p=>p.els.length)"),2000);
    console.log('PASS: dense ink moves and scales without page redraws; precise commits, undo, cancellation and cross-page moves survive reload.');
  }
  assert.deepEqual(exceptions,[],'No uncaught exceptions during dense selection transforms');
} finally {
  ws?.close();browser.kill('SIGTERM');
  await new Promise(resolve=>server.close(resolve));
  await delay(300);await rm(temp,{recursive:true,force:true});
}
