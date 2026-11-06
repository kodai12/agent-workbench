import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Json} from '../../contracts/ports.js';
import {validateWorkerEventData} from '../../src/domain/worker-event.js';
import {digest} from '../../src/domain/canonical.js';
const d=digest('evidence');
const fixtures:Record<string,Record<string,Json>>={
 'worker.ready':{protocolVersion:1,workerSocket:'/worker.sock',pid:123,startIdentity:'host-process-identity',capabilities:['fixture-only']},
 'run.started':{threadId:null,turnId:null,profileDigest:d},
 'message.delta':{messageId:'m',channel:'public_text',text:'公開本文'},
 'message.completed':{messageId:'m',artifactDigest:d},
 'tool.started':{callId:'c',name:'tool',redactedArgsDigest:d},
 'tool.completed':{callId:'c',outcome:'success',resultDigest:d},
 'input.requested':{requestKey:'request1',kind:'business_question',promptDigest:d,allowedResponses:['yes','no']},
 'usage.updated':{inputTokens:null,outputTokens:10,cachedInputTokens:0,costMicros:null,cumulative:true},
 'run.completed':{outputDigest:d,finishReason:'completed',processQuiescent:false},
 'run.failed':{code:'FAILED',message:'失敗しました',partialOutputDigest:null,retryability:'never'},
 'run.cancelled':{reason:'人間の中断要求',processQuiescent:false},
 heartbeat:{processIdentityDigest:d,monotonicCounter:0},
 'protocol.warning':{code:'UNKNOWN_NOTIFICATION',detailsDigest:null}
};
for(const [type,value] of Object.entries(fixtures))test('15.6 '+type+'の必須data、型、追加keyを検証する',()=>{
 assert.equal(validateWorkerEventData(type,value).ok,true);
 assert.equal(validateWorkerEventData(type,{...value,untrustedExtra:true}).ok,false);
 for(const key of Object.keys(value)){const missing={...value};delete missing[key];assert.equal(validateWorkerEventData(type,missing).ok,false,type+':'+key);assert.equal(validateWorkerEventData(type,{...value,[key]:{invalid:true}}).ok,false,type+':'+key);}
});
test('worker.readyのidentity、protocol、PID不正ではrunningへ進めない',()=>{const ready=fixtures['worker.ready'];assert.ok(ready);for(const patch of [{startIdentity:null},{startIdentity:''},{protocolVersion:2},{pid:0},{pid:1.5},{workerSocket:'bad\npath'},{capabilities:['',1]}])assert.equal(validateWorkerEventData('worker.ready',{...ready,...patch}).ok,false);});
test('nullable数値の未知値はnull、負数/float/unsafe数とcumulative=falseを拒否する',()=>{const usage=fixtures['usage.updated'];assert.ok(usage);for(const number of [-1,1.5,Number.MAX_SAFE_INTEGER+1,Infinity,NaN])assert.equal(validateWorkerEventData('usage.updated',{...usage,inputTokens:number}).ok,false);assert.equal(validateWorkerEventData('usage.updated',{...usage,cumulative:false}).ok,false);assert.equal(validateWorkerEventData('usage.updated',{...usage,inputTokens:0}).ok,true);});
test('channel/outcome/finishReasonの未知値と不正digestを拒否する',()=>{assert.equal(validateWorkerEventData('message.delta',{...fixtures['message.delta'],channel:'private_reasoning'}).ok,false);assert.equal(validateWorkerEventData('tool.completed',{...fixtures['tool.completed'],outcome:'unknown'}).ok,false);assert.equal(validateWorkerEventData('run.completed',{...fixtures['run.completed'],finishReason:'MAX_TOKENS'}).ok,false);assert.equal(validateWorkerEventData('run.completed',{...fixtures['run.completed'],outputDigest:'not-a-digest'}).ok,false);assert.equal(validateWorkerEventData('unknown.event',{}).ok,false);});
