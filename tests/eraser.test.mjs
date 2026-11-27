import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const {outputFiles}=await build({stdin:{contents:"export * from './src/eraser'; export * from './src/render';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {EraserSession,makeStroke,hitEl,eraseFromStroke,shapeToStroke}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const line=(x,y,w=100)=>makeStroke('pen','#123',2,[x,y,.5,x+w,y,.5]);
const canonical=els=>els.map(e=>{const {id,...rest}=e;return rest});
function reference(els,x,y,r,partial){
 const out=[];for(const e of els){if((e.t!=='s'&&e.t!=='h')||!hitEl(e,x,y,r)){out.push(e);continue}if(partial){const pieces=eraseFromStroke(e.t==='h'?shapeToStroke(e):e,x,y,r);out.push(...(pieces??[e]));}}
 return out;
}
test('spatial erasing matches the original full scan across repeated cuts and keeps non-ink intact',()=>{
 let seed=123456;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32};
 const original=Array.from({length:300},()=>line(random()*700-100,random()*1000-100,10+random()*130));
 original.splice(20,0,{t:'i',id:'pic',x:0,y:0,w:100,h:100,blob:'private-image'}, {t:'x',id:'formula',x:30,y:30,fs:12,c:'#000',src:'x^2'});
 for(const partial of [false,true]){
  const session=new EraserSession(original);let expected=original.slice();
  for(let i=0;i<300;i++){const x=random()*650-50,y=random()*950-50,r=2+random()*20;session.erase(x,y,r,partial);expected=reference(expected,x,y,r,partial);}
  assert.deepEqual(canonical(session.elements()),canonical(expected));
  const op=session.operation(),saved=session.elements();let applied=original.slice();
  for(const [,e]of op.removed)applied=applied.filter(x=>x.id!==e.id);
  for(const [i,e]of op.added)applied.splice(i,0,e);
  assert.deepEqual(applied,saved,'Redo indices preserve the exact original stacking order');
  for(const [,e]of op.added)applied=applied.filter(x=>x.id!==e.id);
  for(const [i,e]of op.removed.sort((a,b)=>a[0]-b[0]))applied.splice(i,0,e);
  assert.deepEqual(applied,original,'Undo restores all originals exactly');
 }
});
test('partial cuts preserve shape, highlighter, colour and pressure geometry',()=>{
 const original=[line(0,20),makeStroke('hl','#ff0',12,[0,40,.5,100,40,.5]),{t:'h',id:'shape',k:'rect',c:'#00f',s:3,x1:20,y1:60,x2:100,y2:100}];
 const session=new EraserSession(original);let expected=original;
 for(const [x,y]of [[50,20],[50,40],[20,80],[50,20]]){session.erase(x,y,5,true);expected=reference(expected,x,y,5,true);}
 assert.deepEqual(canonical(session.elements()),canonical(expected));
 assert.deepEqual(original[0].p,new Float32Array([0,20,.5,100,20,.5]));
});
test('large and negative-coordinate bounds cannot escape the spatial index',()=>{
 const original=[line(-10000,-1000,20000),line(0,100,10)];const session=new EraserSession(original);
 session.erase(0,-1000,5,false);assert.deepEqual(session.elements(),[original[1]]);
 session.erase(99999,99999,3,false);assert.deepEqual(session.elements(),[original[1]]);
});
test('missing every stroke does not create an undo operation',()=>{
 const original=[line(0,0)];const session=new EraserSession(original);session.erase(100,100,5,true);
 assert.equal(session.changed,false);assert.deepEqual(session.operation(),{removed:[],added:[]});assert.deepEqual(session.elements(),original);
});

test('dotted and dashed styles survive partial erasing and shape rotation conversion',()=>{
 for(const style of ['dotted','dashed']){
  const stroke=makeStroke('pen','#123',2,[0,20,.5,100,20,.5],style);
  const pieces=eraseFromStroke(stroke,50,20,5);
  assert.equal(pieces.length,2);
  assert(pieces.every(s=>s.style===style));
  const shape={t:'h',id:'styled',k:'rect',c:'#123',s:2,x1:0,y1:0,x2:100,y2:100,style};
  assert.equal(shapeToStroke(shape).style,style);
 }
});
