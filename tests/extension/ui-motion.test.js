'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const motion = require('../../js/ui-motion.js');
const foundation = require('../../js/workspace-foundation.js');
function fixture() {
 const events = () => { const listeners = new Map(); return {listeners,addEventListener(k,f){if(!listeners.has(k))listeners.set(k,new Set());listeners.get(k).add(f)},removeEventListener(k,f){listeners.get(k)?.delete(f)},emit(k){for(const f of [...(listeners.get(k)||[])])f()},count(){return [...listeners.values()].reduce((n,s)=>n+s.size,0)}} };
 const observers = new Set(); const media = {...events(),matches:false};
 const win = {...events(),matchMedia:()=>media,IntersectionObserver:class {constructor(fn){this.fn=fn;observers.add(this)}observe(node){this.node=node}disconnect(){observers.delete(this)}}};
 const doc = {...events(),hidden:false,defaultView:win};
 doc.createElement = () => ({ownerDocument:doc,dataset:{},children:[],attrs:{},appendChild(n){this.children.push(n);n.parent=this},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]},remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this)}});
 return {doc,win,media,observers,host:doc.createElement()};
}
test('loading replaces immediately and releases observers/listeners across 100 cycles',()=>{
 const {host,doc,win,observers}=fixture();
 for(let i=0;i<100;i++){
  motion.showLoading(host,'Loading notes…','notes');assert.equal(host.attrs['aria-busy'],'true');assert.equal(observers.size,1);
  motion.showLoading(host,'Loading grades…','grades');assert.equal(host.children.length,1);assert.equal(observers.size,1);
  motion.clearLoading(host);assert.equal(host.children.length,0);assert.equal(observers.size,0);assert.equal(doc.count()+win.count(),0);
 }
});
test('hidden and offscreen loading stays static and late observer deliveries are ignored',()=>{
 const {host,doc,win,observers}=fixture();motion.showLoading(host,'Loading…');const box=host.children[0];const observer=[...observers][0];
 assert.equal(box.attrs['data-motion-visible'],'false');observer.fn([{isIntersecting:true}]);assert.equal(box.attrs['data-motion-visible'],'true');
 doc.hidden=true;doc.emit('visibilitychange');assert.equal(box.attrs['data-motion-visible'],'false');
 doc.hidden=false;doc.emit('visibilitychange');observer.fn([{isIntersecting:false}]);assert.equal(box.attrs['data-motion-visible'],'false');
 win.emit('pagehide');observer.fn([{isIntersecting:true}]);assert.equal(box.attrs['data-motion-visible'],'false');assert.equal(observers.size,0);assert.equal(doc.count()+win.count(),0);
});
test('replacing a reveal cannot let an old completion cancel the new effect',async()=>{
 const {host,doc,win,media}=fixture();const effects=[];
 host.animate=()=>{let finish;const e={cancelled:0,finished:new Promise(r=>finish=r),cancel(){this.cancelled++},finish:()=>finish()};effects.push(e);return e};
 motion.reveal(host);motion.reveal(host);effects[0].finish();await Promise.resolve();
 assert.equal(effects[0].cancelled,1);assert.equal(effects[1].cancelled,0);
 media.matches=true;media.emit('change');assert.equal(effects[1].cancelled,1);assert.equal(doc.count()+win.count()+media.count(),0);
 motion.reveal(host);assert.equal(effects.length,2);
});
test('host disposal during asynchronous mount disposes the late module without revealing it',async()=>{
 let finish,disposed=0,revealed=0;
 const host=foundation.createModuleHost({modules:{notes:{mount:()=>new Promise(r=>finish=r)}},afterRoute:()=>revealed++});
 const pending=host.navigate('notes');for(let i=0;i<5&&!finish;i++)await Promise.resolve();
 assert.equal(typeof finish,'function');await host.dispose();finish({dispose(){disposed++}});
 assert.equal((await pending).code,'WORKSPACE_HOST_DISPOSED');assert.equal(disposed,1);assert.equal(revealed,0);assert.equal(host.route,null);
});
