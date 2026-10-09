import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Browser presentation module.
import { observeMessageMotion } from '../src/web/assets/message-view.js';

test('bubble motion runs on entrance/re-entry, ignores token mutations and respects reduced motion', () => {
  const names=['IntersectionObserver','MutationObserver','matchMedia','document','performance'];
  const saved=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));
  let onVisibility!: (entries:unknown[])=>void, onMutation!: (records:unknown[])=>void, onReduced!:()=>void;
  let now=0, observing=0, cancelled=0;
  const durations:number[]=[];
  const reduced={matches:false,addEventListener:(_name:string,fn:()=>void)=>{onReduced=fn;}};
  const bubble={nodeType:1,matches:()=>true,querySelectorAll:()=>[],animate:(_frames:unknown,options:{duration:number})=>{
    durations.push(options.duration);return {cancel:()=>cancelled++};
  }};
  let contained=true;
  const root={nodeType:1,matches:()=>false,querySelectorAll:()=>[bubble],contains:()=>contained};
  const values=[class {constructor(callback:typeof onVisibility){onVisibility=callback;} observe(){observing++;} unobserve(){observing--;}},
    class {constructor(callback:typeof onMutation){onMutation=callback;} observe(){}},()=>reduced,{hidden:false},{now:()=>now}];
  try {
    names.forEach((name,i)=>Object.defineProperty(globalThis,name,{value:values[i],configurable:true}));
    observeMessageMotion(root,{});
    const visible=(value:boolean)=>onVisibility([{target:bubble,isIntersecting:value}]);
    visible(true);visible(true);assert.deepEqual(durations,[300]);
    onMutation([{target:{nodeType:1,closest:()=>true},addedNodes:[bubble],removedNodes:[]}]);
    assert.equal(observing,1);assert.deepEqual(durations,[300]);
    visible(false);now=100;visible(true);assert.deepEqual(durations,[300]);
    visible(false);now=500;visible(true);assert.deepEqual(durations,[300,180]);
    reduced.matches=true;onReduced();visible(false);now=1000;visible(true);
    assert.deepEqual(durations,[300,180]);assert.ok(cancelled>0);
    contained=false;onMutation([{target:{nodeType:1,closest:()=>false},removedNodes:[bubble],addedNodes:[]}]);
    assert.equal(observing,0);
  } finally {
    names.forEach((name,i)=>saved[i]?Object.defineProperty(globalThis,name,saved[i]!):Reflect.deleteProperty(globalThis,name));
  }
});
