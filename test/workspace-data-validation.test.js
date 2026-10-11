import test from 'node:test';
import assert from 'node:assert/strict';
import {WORKSPACE_KEY, readChecks} from '../public/workspace-data.js';

test('workspace ignores malformed nested report and claim containers without losing valid results', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const entry = {id:'valid',text:'A claim',reelUrl:'',addedAt:'2026-10-11T22:00:00Z',result:{claim:{summary:'A claim'},verdict:'Checked'}};
  const entries = [entry, ...[{}, null, [], {claim:{}}, {claim:{text:42}}].map((report,index)=>({...entry,id:`bad-report-${index}`,result:{report}})),{...entry,id:'bad-claim',result:{claim:[]}}];
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem(key){assert.equal(key,WORKSPACE_KEY);return JSON.stringify(entries);}}});
  try {assert.deepEqual(readChecks().map(item=>item.id),['valid']);}
  finally {if(descriptor)Object.defineProperty(globalThis,'sessionStorage',descriptor);else delete globalThis.sessionStorage;}
});
