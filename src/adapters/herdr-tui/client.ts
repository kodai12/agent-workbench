import {Ajv2020} from 'ajv/dist/2020.js';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import type {ArtifactRef,CapabilityReport,Digest,Json,ManagedPresentationRequest,NativePresentationRequest,PresentationDriver,PresentationHandle,Result} from '../../../contracts/ports.js';
import {fail,ok} from '../../domain/errors.js';
import {object,array} from '../../domain/review.js';
import {parseJson} from '../../contracts/loader.js';
function capturedSchema():object {let dir=dirname(fileURLToPath(import.meta.url));for(let i=0;i<7;i++){const path=join(dir,'src/generated/herdr/schema.json');if(existsSync(path)){const value:unknown=JSON.parse(readFileSync(path,'utf8'));if(value&&typeof value==='object'&&!Array.isArray(value))return value;}dir=dirname(dir);}throw new Error('HERDR_SCHEMA_MISSING');}
const ajv=new Ajv2020({strict:false,allErrors:true,validateFormats:false});ajv.addSchema(capturedSchema(),'herdr-captured');
const validateRequest=ajv.compile<Json>({$ref:'herdr-captured#/schemas/request'});
const validateResponse=ajv.compile<Json>({$ref:'herdr-captured#/schemas/success_response'});
export function quotePath(path:string):string {if(!isAbsolute(path)||/[\0\r\n]/.test(path))throw new Error('INVALID_LAUNCHER_PATH');return "'"+path.replaceAll("'","'\\''")+"'";}
export function managedLauncher(nodeExecutable:string,workerScript:string,ticketPath:string):string {return `exec ${quotePath(nodeExecutable)} ${quotePath(workerScript)} --ticket ${quotePath(ticketPath)}`;}
export type HerdrExecutor=(argv:readonly string[],signal:AbortSignal)=>Promise<Result<Json>>;
export type HerdrOptions={execute:HerdrExecutor;nodeExecutable:string;readArtifact:(digest:Digest)=>Promise<Result<Uint8Array>>;version?:string;nativeConsent?:boolean};
type Occupant={terminalId:string;cwd:string;workspaceId:string;paneId:string;revision:number;name:string|null};
export class HerdrClient implements PresentationDriver {
 private occupants=new Map<string,Occupant>();
 constructor(private options:HerdrOptions){}
 async probe(_signal:AbortSignal):Promise<Result<CapabilityReport>> {return ok({driver:'herdr-tui',version:this.options.version??'captured-0.8.0',schemaDigest:null,freshSession:false,structuredOutput:false,interrupt:false,steer:false,publicHistory:false,sandboxedCommands:false,verifiedIsolation:false,issues:['表示状態はtask成功の証拠ではありません']});}
 private async call(method:string,params:Json,argv:string[],signal:AbortSignal):Promise<Result<Json>> {
  if(signal.aborted)return fail('CANCELLED','表示操作は中断されました');
  const id=randomUUID();if(!validateRequest({id,method,params}))return fail('PROTOCOL_VIOLATION','Herdr要求がcapture契約に適合しません');
  const result=await this.options.execute(argv,signal);if(!result.ok)return result;
  if(!validateResponse(result.value))return fail('PROTOCOL_VIOLATION','Herdr応答がcapture契約に適合しません');
  return ok(object(result.value).result??null);
 }
 private async create(cwd:string,label:string,signal:AbortSignal,environment:Record<string,string>={}):Promise<Result<{handle:PresentationHandle;occupant:Occupant}>> {
  if(!isAbsolute(cwd)||/[\0\r\n]/.test(cwd)||/[\0\r\n]/.test(label))return fail('INVALID_PATH','表示用pathまたはlabelが不正です');
  const argv=['workspace','create','--cwd',cwd,'--label',label,'--no-focus'];for(const [key,value] of Object.entries(environment))argv.push('--env',key+'='+value);
  const created=await this.call('workspace.create',{cwd,label,focus:false,env:environment},argv,signal);if(!created.ok)return created;
  const result=object(created.value);if(result.type!=='workspace_created')return fail('PROTOCOL_VIOLATION','workspace作成応答ではありません');
  const pane=object(result.root_pane);if(typeof pane.pane_id!=='string'||typeof pane.terminal_id!=='string'||typeof pane.workspace_id!=='string'||typeof pane.revision!=='number')return fail('PROTOCOL_VIOLATION','pane identityがありません');
  const occupant:Occupant={terminalId:pane.terminal_id,cwd,workspaceId:pane.workspace_id,paneId:pane.pane_id,revision:pane.revision,name:null};this.occupants.set(pane.pane_id,occupant);
  return ok({handle:{variant:'herdr-tui',workspaceId:pane.workspace_id,paneId:pane.pane_id,agentName:null,revision:pane.revision},occupant});
 }
 async startManaged(request:ManagedPresentationRequest,signal:AbortSignal):Promise<Result<PresentationHandle>> {
  let launcher:string;try{launcher=managedLauncher(this.options.nodeExecutable,request.workerExecutable,request.ticketPath);}catch{return fail('INVALID_LAUNCHER_PATH','固定launcherのpathが不正です');}
  const created=await this.create(request.cwd,request.label,signal);if(!created.ok)return created;
  const paneId=created.value.occupant.paneId;
  const confirmed=await this.confirmOccupant(created.value.handle,signal);if(!confirmed.ok)return confirmed;
  const idle=await this.verifyIdle(paneId,signal);if(!idle.ok)return idle;
  const sent=await this.call('pane.send_input',{pane_id:paneId,text:launcher,keys:['Enter']},['pane','run',paneId,launcher],signal);return sent.ok?ok(created.value.handle):sent;
 }
 async startNative(request:NativePresentationRequest,signal:AbortSignal):Promise<Result<PresentationHandle>> {
  if(!this.options.nativeConsent)return fail('CONSENT_REQUIRED','nativeのcooperative-localを明示選択してください');
  if(!isAbsolute(request.codexHome)||/[\0\r\n]/.test(request.codexHome))return fail('INVALID_PATH','専用CODEX_HOMEが不正です');
  const source=await this.options.readArtifact(request.initialPrompt.digest);if(!source.ok)return source;
  let prompt:string;try{prompt=new TextDecoder('utf-8',{fatal:true}).decode(source.value);}catch{return fail('INVALID_UTF8','開始packetのUTF-8が不正です');}
  const created=await this.create(request.cwd,request.label,signal,{CODEX_HOME:request.codexHome});if(!created.ok)return created;
  const handle=created.value.handle,paneId=created.value.occupant.paneId,name='aw-'+randomUUID().replaceAll('-','').slice(0,24);
  const args=['--model',request.model.modelId,'--sandbox','workspace-write','--ask-for-approval','on-request'];
  if(request.model.reasoningEffort!==null)args.push('--config','model_reasoning_effort='+JSON.stringify(request.model.reasoningEffort));
  const confirmed=await this.confirmOccupant(handle,signal);if(!confirmed.ok)return confirmed;
  const idle=await this.verifyIdle(paneId,signal);if(!idle.ok)return idle;
  const started=await this.call('agent.start',{name,kind:'codex',pane_id:paneId,args,timeout_ms:30000},['agent','start',name,'--kind','codex','--pane',paneId,'--timeout','30000','--',...args],signal);if(!started.ok)return started;
  const info=object(object(started.value).agent);if(info.pane_id!==paneId||info.terminal_id!==created.value.occupant.terminalId||info.name!==name)return fail('OCCUPANT_MISMATCH','起動したnative agentが一致しません');
  handle.agentName=name;created.value.occupant.name=name;
  const prompted=await this.call('agent.prompt',{target:name,text:prompt},['agent','prompt',name,prompt],signal);if(!prompted.ok)return prompted;
  return ok(handle);
 }
 private async verifyIdle(paneId:string,signal:AbortSignal):Promise<Result<void>> {
  const result=await this.call('pane.process_info',{pane_id:paneId},['pane','process-info','--pane',paneId],signal);if(!result.ok)return result;
  const info=object(object(result.value).process_info);
  if(!Array.isArray(info.foreground_processes)||typeof info.shell_pid!=='number')return fail('OCCUPANT_UNKNOWN','foreground processを確定できません');
  if(info.foreground_processes.some(p=>object(p).pid!==info.shell_pid))return fail('PANE_OCCUPIED','別のforeground processがあります');
  return ok(undefined);
 }
 private async confirmOccupant(handle:PresentationHandle,signal:AbortSignal):Promise<Result<Record<string,Json>>> {
  if(handle.variant!=='herdr-tui'||!handle.paneId)return fail('PRESENTATION_VARIANT_UNSUPPORTED','Herdr TUIのpaneが必要です');
  const expected=this.occupants.get(handle.paneId);if(!expected)return fail('OCCUPANT_UNKNOWN','記録されたpane identityがありません');
  const response=await this.call('pane.get',{pane_id:handle.paneId},['pane','get',handle.paneId],signal);if(!response.ok)return response;
  const pane=object(object(response.value).pane);
  if(pane.terminal_id!==expected.terminalId||pane.workspace_id!==expected.workspaceId||pane.pane_id!==expected.paneId||pane.cwd!==expected.cwd||(typeof pane.revision==='number'&&pane.revision<expected.revision))return fail('OCCUPANT_MISMATCH','paneのterminal、cwdまたはrevisionが一致しません');
  if(expected.name!==null) {
   const agentResult=await this.call('agent.get',{target:expected.name},['agent','get',expected.name],signal);if(!agentResult.ok)return agentResult;
   const agent=object(object(agentResult.value).agent);if(agent.name!==expected.name||agent.pane_id!==expected.paneId||agent.terminal_id!==expected.terminalId)return fail('OCCUPANT_MISMATCH','native agentのoccupantが一致しません');
  }
  if(typeof pane.revision==='number')expected.revision=pane.revision;
  return ok(pane);
 }
 async getStatus(handle:PresentationHandle,signal:AbortSignal):Promise<Result<Record<string,Json>>> {return this.confirmOccupant(handle,signal);}
 async attach(handle:PresentationHandle,signal:AbortSignal):Promise<Result<void>> {const confirmed=await this.confirmOccupant(handle,signal);if(!confirmed.ok)return confirmed;if(!handle.workspaceId)return fail('PRESENTATION_MISSING','workspaceがありません');const focused=await this.call('workspace.focus',{workspace_id:handle.workspaceId},['workspace','focus',handle.workspaceId],signal);return focused.ok?ok(undefined):focused;}
 async closePresentation(handle:PresentationHandle,signal:AbortSignal):Promise<Result<void>> {const confirmed=await this.confirmOccupant(handle,signal);if(!confirmed.ok)return confirmed;if(!handle.paneId)return fail('OCCUPANT_UNKNOWN','管理paneではありません');const idle=await this.verifyIdle(handle.paneId,signal);if(!idle.ok)return idle;const closed=await this.call('pane.close',{pane_id:handle.paneId},['pane','close',handle.paneId],signal);if(!closed.ok)return closed;this.occupants.delete(handle.paneId);return ok(undefined);}
 async reconcileSnapshot(handle:PresentationHandle,signal:AbortSignal):Promise<Result<Record<string,Json>>> {
  const snapshot=await this.call('session.snapshot',{},['api','snapshot'],signal);if(!snapshot.ok)return snapshot;
  const data=object(object(snapshot.value).snapshot);
  if(!array(data.panes).some(p=>object(p).pane_id===handle.paneId))return fail('PRESENTATION_MISSING','表示paneがありません。writerは再作成しません');
  return this.confirmOccupant(handle,signal);
 }
}
