import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { analyticsData, mergeAnalytics } from '../server/analytics.mjs';
const { outputFiles } = await build({entryPoints:['src/activity-wire.ts'],bundle:true,platform:'node',format:'esm',write:false});
const { activityBucket, activityWireId } = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const ms=Object.fromEntries(['writing','highlighting','erasing','editing','navigation','reading','idle','away'].map(k=>[k,0]));
const counts=Object.fromEntries(['opens','pageViews','pageSwitches','awaySwitches','returns','focusStarts','strokes','highlights','erasures','selections','transforms','undos','redos','zooms','scrolls','characters'].map(k=>[k,0]));
const row=(session='session-a')=>({id:session+':1795773600000:page-a',session,day:'2026-11-27',notebook:'notebook-a',page:'page-a',title:'Math',folder:'ETH / Math',minute:1795773600000,start:1795773600000,end:1795773601000,pageNumber:1,ms:{...ms,writing:1000},counts:{...counts,strokes:2}});

test('client and server validate the same content-free analytics envelope and safe hash ids',async()=>{
 const r=row(), id=await activityWireId(r.id);
 assert.match(id,/^a_[a-f0-9]{64}$/);assert.equal(id,'a_'+createHash('sha256').update('opplinotes.analytics.v1:'+r.id).digest('hex'));
 assert.deepEqual(analyticsData(r,id),activityBucket(r));
 assert.equal(activityBucket({...r,ms:{...r.ms,writing:-1}}),null);
 assert.throws(()=>analyticsData({...r,ms:{...r.ms,writing:-1}},id));
 assert.throws(()=>analyticsData(r,'../outside'));
 assert.deepEqual(activityBucket({...r,rawHandwriting:'discard this'}),r);
 assert.deepEqual(analyticsData({...r,rawHandwriting:'discard this'},id),r);
});

test('cumulative merge is idempotent, order independent for counters and preserves newer category totals',()=>{
 const a=row(),b=row();b.end+=500;b.ms.writing+=300;b.ms.reading=200;b.counts.strokes=3;
 assert.deepEqual(mergeAnalytics(a,b),b);assert.deepEqual(mergeAnalytics(b,a),b);assert.deepEqual(mergeAnalytics(b,b),b);
});

for (const runtime of ['node', ...(process.env.PHP_BIN ? ['php'] : [])]) test(`private ${runtime} sync round-trips independent device sessions, stale replays and existing notes`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'opplinotes-sync-'));
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const key=randomUUID()+randomUUID(), url=`http://127.0.0.1:${port}/${runtime === 'php' ? 'sync.php' : 'sync'}`;
 if(runtime==='php'){await copyFile('server/sync.php',join(dir,'sync.php'));await writeFile(join(dir,'sync-key.txt'),key,{mode:0o600})}
 const child=runtime==='php'?spawn(process.env.PHP_BIN,['-S',`127.0.0.1:${port}`,'-t',dir],{stdio:'ignore'}):spawn(process.execPath,['server/sync.mjs'],{env:{...process.env,PORT:String(port),DATA_DIR:dir,SYNC_KEY:key},stdio:'ignore'});
 const headers={'X-Sync-Key':key,'Content-Type':'application/json'};
 try {
  let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(url+'?a=pull',{headers});if(r.status===200){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,30))}assert(ready);
  assert.equal((await fetch(url+'?a=pull')).status,401);
  const push=items=>fetch(url+'?a=push',{method:'POST',headers,body:JSON.stringify({items})});
  const a=row(),b=row('session-b');const idA=await activityWireId(a.id),idB=await activityWireId(b.id);
  assert.equal((await push([{k:'n',id:'notebook-a',updated:1,data:{title:'Original notes'}}])).status,200);
  for(const data of [a,a,{...a,end:a.end-200,ms:{...a.ms,writing:500},counts:{...a.counts,strokes:1}}])assert.equal((await push([{k:'a',id:idA,updated:data.end,data}])).status,200);
  assert.equal((await push([{k:'a',id:idB,updated:b.end,data:b}])).status,200);
  const pulled=await(await fetch(url+'?a=pull&since=0',{headers})).json();
  const analytics=pulled.items.filter(i=>i.k==='a');assert.equal(analytics.length,2);
  assert.equal(analytics.reduce((s,i)=>s+i.data.ms.writing,0),2000);assert.equal(analytics.reduce((s,i)=>s+i.data.counts.strokes,0),4);
  assert.deepEqual(pulled.items.find(i=>i.k==='n').data,{title:'Original notes'});
  assert.equal((await push([{k:'a',id:idA,updated:a.end,data:{...a,ms:{...a.ms,writing:-5}}}])).status,400);
  assert.equal((await push([{k:'a',id:'notebook-a',updated:a.end,data:a}])).status,400);
  const delta=await(await fetch(url+'?a=pull&since='+pulled.rev,{headers})).json();assert.deepEqual(delta.items,[]);
 } finally {child.kill();await new Promise(r=>child.once('exit',r));await rm(dir,{recursive:true,force:true})}
});
