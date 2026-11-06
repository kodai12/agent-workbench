import type {AgentDriver,AgentEvent,AgentRequest,ArtifactRef,CapabilityReport,Digest,Json,PublicHistoryPage,Result,SessionHandle} from '../../../contracts/ports.js';
import type {ThreadStartParams} from '../../generated/codex/v2/ThreadStartParams.js';
import type {ThreadStartResponse} from '../../generated/codex/v2/ThreadStartResponse.js';
import type {TurnStartParams} from '../../generated/codex/v2/TurnStartParams.js';
import type {TurnStartResponse} from '../../generated/codex/v2/TurnStartResponse.js';
import type {TurnSteerParams} from '../../generated/codex/v2/TurnSteerParams.js';
import type {TurnInterruptParams} from '../../generated/codex/v2/TurnInterruptParams.js';
import type {ThreadItemsListParams} from '../../generated/codex/v2/ThreadItemsListParams.js';
import type {ThreadItemsListResponse} from '../../generated/codex/v2/ThreadItemsListResponse.js';
import type {ServerNotification} from '../../generated/codex/ServerNotification.js';
import type {ReasoningEffort} from '../../generated/codex/ReasoningEffort.js';
import type {SandboxPolicy} from '../../generated/codex/v2/SandboxPolicy.js';
import {parseJson,validateContract} from '../../contracts/loader.js';
import {digest} from '../../domain/canonical.js';
import {fail,ok} from '../../domain/errors.js';
import {CodexTransport} from './transport.js';
import {validateWire} from './wire.js';
export type CodexOptions={transport:CodexTransport;readArtifact:(digest:Digest)=>Promise<Result<Uint8Array>>;storeArtifact:(bytes:Uint8Array,mediaType:string)=>Promise<Result<ArtifactRef>>;version?:string;schemaDigest?:Digest;cooperativeConsent:boolean;neutralCwd:string};
type Session={request:AgentRequest;handle:SessionHandle;events:AgentEvent[];wake:Set<()=>void>;terminal:boolean;finalText:string|null;finalTurnId:string|null;bytes:number;deadline:ReturnType<typeof setTimeout>|null};
export class CodexDriver implements AgentDriver {
 private sessions=new Map<string,Session>();
 constructor(private options:CodexOptions){options.transport.notifications.add((method,params)=>{void this.notification(method,params).catch(()=>{for(const s of this.sessions.values())this.emit(s,'run.failed',{code:'PROTOCOL_VIOLATION',message:'notification処理を確定できません'});});});options.transport.serverRequests.add(()=>{for(const s of this.sessions.values())if(!s.terminal){void this.interrupt(s.handle,new AbortController().signal);this.emit(s,'run.failed',{code:'UNKNOWN_SERVER_REQUEST',message:'未知の権限要求を拒否してturnを中断しました'});}});}
 async probe(_signal:AbortSignal):Promise<Result<CapabilityReport>> {return ok({driver:'codex-app-server',version:this.options.version??'captured-0.164.0',schemaDigest:this.options.schemaDigest??null,freshSession:true,structuredOutput:true,interrupt:true,steer:true,publicHistory:true,sandboxedCommands:true,verifiedIsolation:false,issues:['SANDBOX_UNVERIFIED: 捕捉したSandboxPolicyにrestricted readがありません']});}
 private emit(s:Session,type:string,data:Record<string,Json>):void {if(s.terminal)return;if(type==='run.failed')data={code:data.code??'PROVIDER_FAILED',message:data.message??'実行が失敗しました',partialOutputDigest:null,retryability:data.code==='EXECUTION_UNCERTAIN'?'unknown':'never'};if(type==='protocol.warning')data={code:data.code??'PROTOCOL_WARNING',detailsDigest:data.detailsDigest??null};const bytes=Buffer.byteLength(JSON.stringify(data));if(s.bytes+bytes>8*1024*1024){if(s.deadline!==null)clearTimeout(s.deadline);s.events.push({attemptId:s.request.attemptId,workerInstanceId:s.request.workerInstanceId,sourceSeq:s.events.length+1,occurredAtMs:Date.now(),type:'run.failed',data:{code:'LOG_CAPACITY_EXCEEDED',message:'ログ上限に達したため成功を確定できません',partialOutputDigest:null,retryability:'never'}});s.terminal=true;void this.interrupt(s.handle,new AbortController().signal);for(const wake of s.wake)wake();return;}s.bytes+=bytes;s.events.push({attemptId:s.request.attemptId,workerInstanceId:s.request.workerInstanceId,sourceSeq:s.events.length+1,occurredAtMs:Date.now(),type,data});if(['run.completed','run.failed','run.cancelled'].includes(type)){s.terminal=true;if(s.deadline!==null)clearTimeout(s.deadline);}for(const wake of s.wake)wake();}
 async startFresh(request:AgentRequest,signal:AbortSignal):Promise<Result<SessionHandle>> {
  if(signal.aborted)return fail('CANCELLED','開始を中断しました');
  if(request.deadlineAtMs<=Date.now())return fail('DEADLINE_EXCEEDED','開始期限を超えています');
  if(request.isolation==='sandbox-verified')return fail('SANDBOX_UNVERIFIED','restricted readとcanaryが成立していません');
  if(!this.options.cooperativeConsent)return fail('CONSENT_REQUIRED','cooperative-localの明示選択が必要です');
  if(request.permissions.network!=='deny')return fail('CAPABILITY_UNSUPPORTED','このbridgeはnetwork allowlistを強制できません');
  if(this.sessions.has(request.attemptId))return fail('ACTIVE_ATTEMPT','attemptは再利用できません');
  const effort=reasoningEffort(request.model.reasoningEffort);if(!effort.ok)return effort;
  const content=await this.options.readArtifact(request.context.digest);if(!content.ok)return content;
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(content.value);}catch{return fail('INVALID_UTF8','入力artifactのUTF-8が不正です');}
  const cwd=request.role==='implement'?request.cwd:this.options.neutralCwd;
  const params={cwd,model:request.model.modelId,approvalPolicy:'never',sandbox:request.role==='implement'?'workspace-write':'read-only',ephemeral:true} satisfies ThreadStartParams;
  const started=await this.options.transport.request('thread/start',params,signal);if(!started.ok)return started;
  const thread=validateWire<ThreadStartResponse>('v2/ThreadStartResponse',started.value);if(!thread.ok)return thread;
  if(thread.value.model!==request.model.modelId || thread.value.cwd!==cwd || thread.value.thread.forkedFromId!==null || thread.value.thread.parentThreadId!==null || thread.value.thread.turns.length!==0 || thread.value.sandbox.type!==(request.role==='implement'?'workspaceWrite':'readOnly'))return fail('PROTOCOL_VIOLATION','新規threadのモデル、cwd、履歴またはsandbox設定が一致しません');
  const sandboxPolicy=request.role==='implement'?{type:'workspaceWrite',writableRoots:request.permissions.writableRoots,networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true} satisfies SandboxPolicy:{type:'readOnly',networkAccess:false} satisfies SandboxPolicy;
  const handle:SessionHandle={attemptId:request.attemptId,driver:'codex-app-server',threadId:thread.value.thread.id,turnId:null,processIdentityDigest:digest({attemptId:request.attemptId,threadId:thread.value.thread.id})};
  const session:Session={request,handle,events:[],wake:new Set(),terminal:false,finalText:null,finalTurnId:null,bytes:0,deadline:null};this.sessions.set(request.attemptId,session);
  session.deadline=setTimeout(()=>{void this.interrupt(handle,new AbortController().signal);this.emit(session,'run.failed',{code:'DEADLINE_EXCEEDED',message:'turnの期限を超え、停止確認が必要です'});},Math.max(1,request.deadlineAtMs-Date.now()));
  const turnParams={threadId:thread.value.thread.id,input:[{type:'text',text,text_elements:[]}],cwd,model:request.model.modelId,approvalPolicy:'never',sandboxPolicy,effort:effort.value,outputSchema:request.outputSchema} satisfies TurnStartParams;
  const turn=await this.options.transport.request('turn/start',turnParams,signal);if(!turn.ok){this.emit(session,'run.failed',{code:turn.error.code,message:turn.error.message});return turn;}
  const validTurn=validateWire<TurnStartResponse>('v2/TurnStartResponse',turn.value);if(!validTurn.ok){this.emit(session,'run.failed',{code:validTurn.error.code,message:validTurn.error.message});return validTurn;}
  handle.turnId=validTurn.value.turn.id;if(session.terminal){await this.interrupt(handle,signal);return fail('EXECUTION_UNCERTAIN','turn開始中に拒否対象の要求または接続障害がありました');}this.emit(session,'run.started',{threadId:handle.threadId,turnId:handle.turnId,profileDigest:request.model.profileDigest});
  return ok({...handle});
 }
 private async notification(method:string,params:Json):Promise<void> {
  if(method==='transport/closed'){for(const s of this.sessions.values())this.emit(s,'run.failed',{code:'EXECUTION_UNCERTAIN',message:'App Server接続が終了しました'});return;}
  const known=['turn/completed','item/completed','item/agentMessage/delta'];
  if(!known.includes(method)){const stored=await this.options.storeArtifact(Buffer.from(JSON.stringify({method,params})),'application/json');for(const s of this.sessions.values())if(!s.terminal){if(stored.ok)this.emit(s,'protocol.warning',{code:'UNKNOWN_NOTIFICATION',detailsDigest:stored.value.digest});else this.emit(s,'run.failed',{code:stored.error.code,message:'未知notificationの記録に失敗しました'});}return;}
  const checked=validateWire<ServerNotification>('ServerNotification',{method,params});
  if(!checked.ok){for(const s of this.sessions.values())this.emit(s,'run.failed',{code:'PROTOCOL_VIOLATION',message:'notification契約が不正です'});return;}
  const notification=checked.value;
  if(notification.method==='item/agentMessage/delta') {
   const p=notification.params;for(const s of this.sessions.values())if(s.handle.threadId===p.threadId)this.emit(s,'message.delta',{messageId:p.itemId,channel:'public_text',text:p.delta});
  } else if(notification.method==='item/completed') {
   const p=notification.params;for(const s of this.sessions.values())if(s.handle.threadId===p.threadId&&p.item.type==='agentMessage'&&p.item.phase==='final_answer'){s.finalText=p.item.text;s.finalTurnId=p.turnId;}
  } else if(notification.method==='turn/completed') {
   const p=notification.params;for(const s of this.sessions.values())if(s.handle.threadId===p.threadId) {
    if(s.handle.turnId!==null&&s.handle.turnId!==p.turn.id){this.emit(s,'protocol.warning',{code:'STALE_TURN',turnId:p.turn.id});continue;}
    if(p.turn.status!=='completed'){this.emit(s,'run.failed',{code:'PROVIDER_TURN_FAILED',message:'turnが正常終了していません'});continue;}
    const finalItems=p.turn.items.filter(i=>i.type==='agentMessage'&&i.phase==='final_answer');const last=finalItems.at(-1);const text=last?.type==='agentMessage'?last.text:s.finalTurnId===p.turn.id?s.finalText:null;
    if(text===null){this.emit(s,'run.failed',{code:'OUTPUT_MISSING',message:'確定した最終出力がありません'});continue;}
    const parsed=parseJson(text);const schema=s.request.role==='implement'?'implementation-output':s.request.role==='review'?'review-output':s.request.role==='board'?'board-post':'handoff';
    const valid=parsed.ok?validateContract(schema,parsed.value):parsed;
    if(!valid.ok){this.emit(s,'run.failed',{code:valid.error.code,message:'最終出力の契約検証に失敗しました'});continue;}
    const stored=await this.options.storeArtifact(Buffer.from(text),'application/json');if(!stored.ok){this.emit(s,'run.failed',{code:stored.error.code,message:stored.error.message});continue;}
    this.emit(s,'run.completed',{outputDigest:stored.value.digest,finishReason:'completed',processQuiescent:false});
   }
  }
 }
 async *events(handle:SessionHandle,afterSourceSeq:number,signal:AbortSignal):AsyncIterable<AgentEvent> {
  const session=this.sessions.get(handle.attemptId);if(!session)return;
  let index=afterSourceSeq;
  while(!signal.aborted){const event=session.events[index];if(event){index++;yield event;continue;}if(session.terminal)return;await new Promise<void>(resolve=>{const wake=()=>{session.wake.delete(wake);signal.removeEventListener('abort',wake);resolve();};session.wake.add(wake);signal.addEventListener('abort',wake,{once:true});});}
 }
 async steer(handle:SessionHandle,expectedTurnId:string,text:string,signal:AbortSignal):Promise<Result<void>> {
  const s=this.sessions.get(handle.attemptId);if(!s||s.terminal||s.handle.turnId!==expectedTurnId||!s.handle.threadId)return fail('STALE_TURN','現在のturnと一致しません');
  const params={threadId:s.handle.threadId,expectedTurnId,input:[{type:'text',text,text_elements:[]}]} satisfies TurnSteerParams;
  const response=await this.options.transport.request('turn/steer',params,signal);return response.ok?ok(undefined):response;
 }
 async interrupt(handle:SessionHandle,signal:AbortSignal):Promise<Result<void>> {
  const s=this.sessions.get(handle.attemptId);if(!s?.handle.threadId||!s.handle.turnId)return fail('SESSION_NOT_FOUND','稼働中turnがありません');
  const params={threadId:s.handle.threadId,turnId:s.handle.turnId} satisfies TurnInterruptParams;
  const result=await this.options.transport.request('turn/interrupt',params,signal);return result.ok?ok(undefined):result;
 }
 async readPublicHistory(handle:SessionHandle,cursor:string|null,signal:AbortSignal):Promise<Result<PublicHistoryPage>> {
  if(!handle.threadId)return fail('SESSION_NOT_FOUND','threadがありません');
  const params={threadId:handle.threadId,cursor,limit:100,sortDirection:'asc'} satisfies ThreadItemsListParams;
  const result=await this.options.transport.request('thread/items/list',params,signal);if(!result.ok)return result;
  const valid=validateWire<ThreadItemsListResponse>('v2/ThreadItemsListResponse',result.value);if(!valid.ok)return valid;
  return ok({items:valid.value.data.flatMap(entry=>entry.item.type==='agentMessage'?[{itemId:entry.item.id,publicText:entry.item.text,artifact:null}]:[]),nextCursor:valid.value.nextCursor});
 }
 async close(handle:SessionHandle,signal:AbortSignal):Promise<Result<void>> {if(this.sessions.get(handle.attemptId)?.terminal===false)return fail('SESSION_ACTIVE','中断結果の確定前に履歴購読を閉じることはできません');if(!handle.threadId)return fail('SESSION_NOT_FOUND','threadがありません');const result=await this.options.transport.request('thread/unsubscribe',{threadId:handle.threadId},signal);return result.ok?ok(undefined):result;}
}

function reasoningEffort(value:string|null):Result<ReasoningEffort|null>{switch(value){case null:case "none":case "minimal":case "low":case "medium":case "high":case "xhigh":return ok(value);default:return fail("CAPABILITY_UNSUPPORTED","捕捉したreasoning effortに対応していません");}}
