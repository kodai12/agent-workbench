import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contracts} from '../../src/contracts/loader.js';
import {reduceTask,taskGuards,taskTransitions} from '../../src/domain/task.js';
import {object,array} from '../../src/domain/review.js';
test('T05 全state×eventを許可表と照合し、全必須ガードを個別に落とす',()=>{
 const state=contracts.get('state-machine.json');assert.ok(state&&typeof state!=='string');
 const states=array(object(state).taskStates);const events=[...new Set(taskTransitions.map(t=>t.event)),'HERDR_STATUS_OBSERVED','APPROVAL_GRANTED','CANCEL_REQUESTED','UNKNOWN'];let pairs=0;
 for(const current of states)for(const event of events){assert.equal(typeof current,'string');const row=taskTransitions.find(t=>t.from===current&&t.event===event);const guards=taskGuards[event]??[];const facts=Object.fromEntries(guards.map(k=>[k,true]));const result=reduceTask(String(current),event,facts);assert.equal(result.ok,Boolean(row),String(current)+event);pairs++;if(row){assert.ok(result.ok);assert.equal(result.value,row.to);for(const key of guards)assert.equal(reduceTask(String(current),event,{...facts,[key]:false}).ok,false,key);}}
 assert.ok(pairs>400);
});
test('R0既知fixtureのsandbox例外はhost事実3条件の全一致だけを許す',()=>{
 const base={checkoutMatches:true,leaseMatches:true,workerMatches:true,sandboxVerified:false};
 for(const fixtureMode of [false,true])for(const knownFixture of [false,true])for(const simulated of [false,true]) {
  assert.equal(reduceTask('allocating','WORKER_READY',{...base,fixtureMode,knownFixture,simulated}).ok,fixtureMode&&knownFixture&&simulated);
 }
 for(const missing of ['fixtureMode','knownFixture','simulated']) {
  const flags:Record<string,boolean>={fixtureMode:true,knownFixture:true,simulated:true};delete flags[missing];
  assert.equal(reduceTask('allocating','WORKER_READY',{...base,...flags}).ok,false);
 }
 assert.equal(reduceTask('allocating','WORKER_READY',{...base,fixtureMode:true,knownFixture:true,simulated:true,workerMatches:false}).ok,false);
});
