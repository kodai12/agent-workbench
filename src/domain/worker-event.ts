import {Ajv2020} from 'ajv/dist/2020.js';
import type {ValidateFunction} from 'ajv';
import type {Json,Result} from '../../contracts/ports.js';
import {isJson} from '../contracts/loader.js';
import {fail,ok} from './errors.js';
const text={type:'string',minLength:1,maxLength:65536};
const identifier={type:'string',minLength:1,maxLength:1024};
const digest={type:'string',pattern:'^sha256:[0-9a-f]{64}$'};
const counter={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const nullable=(schema:object)=>({anyOf:[schema,{type:'null'}]});
const strings={type:'array',items:identifier,maxItems:1000};
const contracts:Readonly<Record<string,Record<string,object>>>={
 'worker.ready':{protocolVersion:{const:1},workerSocket:{type:'string',minLength:1,maxLength:4096,pattern:'^[^\\u0000\\r\\n]+$'},pid:{type:'integer',minimum:1,maximum:4294967295},startIdentity:identifier,capabilities:strings},
 'run.started':{threadId:nullable(identifier),turnId:nullable(identifier),profileDigest:digest},
 'message.delta':{messageId:identifier,channel:{const:'public_text'},text:{type:'string',maxLength:8*1024*1024}},
 'message.completed':{messageId:identifier,artifactDigest:digest},
 'tool.started':{callId:identifier,name:identifier,redactedArgsDigest:digest},
 'tool.completed':{callId:identifier,outcome:{enum:['success','error','cancelled']},resultDigest:digest},
 'input.requested':{requestKey:identifier,kind:identifier,promptDigest:digest,allowedResponses:strings},
 'usage.updated':{inputTokens:nullable(counter),outputTokens:nullable(counter),cachedInputTokens:nullable(counter),costMicros:nullable(counter),cumulative:{const:true}},
 'run.completed':{outputDigest:digest,finishReason:{const:'completed'},processQuiescent:{type:'boolean'}},
 'run.failed':{code:identifier,message:text,partialOutputDigest:nullable(digest),retryability:identifier},
 'run.cancelled':{reason:text,processQuiescent:{type:'boolean'}},
 heartbeat:{processIdentityDigest:digest,monotonicCounter:counter},
 'protocol.warning':{code:identifier,detailsDigest:nullable(digest)}
};
const ajv=new Ajv2020({strict:true,allErrors:true});
const validators=new Map<string,ValidateFunction<Json>>();
for(const [name,properties] of Object.entries(contracts))validators.set(name,ajv.compile<Json>({type:'object',properties,required:Object.keys(properties),additionalProperties:false}));
export function validateWorkerEventData(type:string,data:unknown):Result<Json> {
 const validate=validators.get(type);if(!validate)return fail('UNKNOWN_WORKER_EVENT','未知のworker eventです',{type});
 if(!isJson(data)||!validate(data))return fail('INVALID_WORKER_EVENT_DATA','worker eventの必須dataまたは型が不正です',{type,violations:(validate.errors??[]).map(e=>({pointer:e.instancePath,keyword:e.keyword,message:e.message??''}))});
 return ok(data);
}
