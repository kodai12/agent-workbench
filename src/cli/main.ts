#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {readFile,open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import type {Json} from '../../contracts/ports.js';
import type {CommandRequest} from '../application/types.js';
import {initialize,readConfig} from '../application/config.js';
import {inspectProtocolLock} from '../application/protocol.js';
import {defaultHome,sanitize} from '../adapters/os/paths.js';
import {parseJson,contracts} from '../contracts/loader.js';
import {asError,unwrap} from '../domain/errors.js';
import {request,subscribe} from '../daemon/client.js';
import {daemonError,recoverDaemonLock} from '../daemon/lifecycle.js';
import {restoreStore} from '../adapters/sqlite/operations.js';
import {ensureDirectory} from '../adapters/filesystem/paths.js';
import {syncDirectory} from '../adapters/filesystem/artifacts.js';

const stringOptions=['home','timeout-ms','request-id','expected-version','name','base-ref','repo','task','board','candidate','finding','approval','request','file','spec','policy','charter','profiles','source','source-path','expect-digest','interaction','presentation','message','reason','goal','question','scope','action','format','out','destination','plan-digest','disposition','evidence-digest','after-seq','params'];
const booleanOptions=['json','dev-fixtures','offline','version','help','rerun','follow','plan'];
type Options=Record<string,string|boolean|undefined>;
const object=(value:Json):{[key:string]:Json}=>{if(!value||typeof value!=='object'||Array.isArray(value))throw daemonError('INVALID_INPUT','objectが必要です。');return value;};
const required=(value:unknown,name:string):string=>{if(typeof value!=='string'||!value)throw daemonError('INVALID_INPUT',`${name}を指定してください。`);return value;};
const integer=(value:unknown,name:string,minimum=0):number=>{if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<minimum)throw daemonError('INVALID_INPUT',`${name}は${minimum}以上の整数に限ります。`);return Number(value);};
const requestId=()=>`req_${randomUUID().replaceAll('-','')}`;
const readJson=async(path:string)=>unwrap(parseJson(await readFile(resolve(path),'utf8')));
export function parseCli(args:string[]):{values:Options;positionals:string[]} {
  const options=Object.fromEntries([...stringOptions.map(name=>[name,{type:'string' as const}]),...booleanOptions.map(name=>[name,{type:'boolean' as const}])]);
  const parsed=(()=>{try{return parseArgs({args,options,allowPositionals:true,strict:true,tokens:true});}catch(error){throw daemonError('INVALID_INPUT',error instanceof Error?error.message:'command optionが不正です。');}})();
  const values:Options={};for(const [key,value] of Object.entries(parsed.values)){if(Array.isArray(value))throw daemonError('INVALID_INPUT','複数値のoptionは使用できません。');values[key]=value;}
  const seen=new Set<string>();for(const token of parsed.tokens){if(token.kind==='option'){if(seen.has(token.name))throw daemonError('INVALID_INPUT',`--${token.name}を重複指定できません。`);seen.add(token.name);}}
  if(values['timeout-ms']!==undefined)integer(values['timeout-ms'],'--timeout-ms',1);
  if(typeof values['timeout-ms']==='string'&&Number(values['timeout-ms'])>2147483647)throw daemonError('INVALID_INPUT','--timeout-msがtimer上限を超えています。');
  if(typeof values.home==='string'&&(!values.home||/[\0\r\n]/.test(values.home)))throw daemonError('INVALID_INPUT','--homeが不正です。');
  if(values['expected-version']!==undefined&&values['expected-version']!=='null')integer(values['expected-version'],'--expected-version',1);
  if(values['request-id']!==undefined&&!/^req_[a-f0-9]{32}$/.test(String(values['request-id'])))throw daemonError('INVALID_INPUT','--request-idはreq_と32桁の16進数に限ります。');
  return {values,positionals:parsed.positionals};
}
async function humanConfirm(display:Json,digest:string):Promise<void> {
  if(!process.stdin.isTTY||!process.stderr.isTTY)throw daemonError('HUMAN_CONFIRMATION_REQUIRED','人間のTTYで内容を確認しdigestを入力してください。');
  if(!/^sha256:[a-f0-9]{64}$/.test(digest))throw daemonError('INVALID_INPUT','確認digestがSHA-256形式ではありません。');
  process.stderr.write(sanitize(JSON.stringify(display,null,2))+'\n');process.stderr.write(`確認対象digest: ${digest}\n`);
  const terminal=createInterface({input:process.stdin,output:process.stderr});
  try{const answer=await terminal.question('許可する場合は上記digestをそのまま入力: ');if(answer.trim()!==digest)throw daemonError('CONFIRMATION_MISMATCH','digestが一致しないため実行しません。');}finally{terminal.close();}
}
async function startDaemon(home:string,timeoutMs:number):Promise<Json> {
  try{return {alreadyRunning:true,status:await request(home,{schemaVersion:1,requestId:requestId(),method:'daemon.status',expectedVersion:null,params:{}},Math.min(timeoutMs,1000))};}catch(error){const code=asError(error).code;if(!['ENOENT','ECONNREFUSED','DAEMON_UNAVAILABLE'].includes(code))throw error;}
  const log=await open(join(home,'daemon.log'),constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
  const stat=await log.stat();if(stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0){await log.close();throw daemonError('UNSAFE_CONTROL_PATH','daemon logの所有者とpermissionが不正です。');}
  const child=spawn(process.execPath,[fileURLToPath(new URL('../daemon/main.js',import.meta.url)),'--home',home],{cwd:home,detached:true,stdio:['ignore',log.fd,log.fd]});
  let exit:{code:number|null;signal:string|null}|undefined,spawnError:Error|undefined;
  child.on('exit',(code,signal)=>{exit={code,signal};});child.on('error',error=>{spawnError=error;});
  try{await new Promise<void>((done,reject)=>{child.once('spawn',done);child.once('error',reject);});}finally{await log.close();}child.unref();
  const deadline=performance.now()+timeoutMs;
  while(performance.now()<deadline){
    if(spawnError)throw spawnError;if(exit)throw daemonError('DAEMON_START_FAILED','daemonがreadyになる前に終了しました。',{exitCode:exit.code??-1,log:join(home,'daemon.log')});
    try{return {started:true,status:await request(home,{schemaVersion:1,requestId:requestId(),method:'daemon.status',expectedVersion:null,params:{}},500)};}catch{}
    await new Promise<void>(done=>setTimeout(done,100));
  }
  if(!exit)child.kill('SIGTERM');throw daemonError('DAEMON_START_TIMEOUT','daemonのreadyを期限内に確認できません。',{log:join(home,'daemon.log')});
}
export async function runCli(args:string[]):Promise<Json> {
  const {values:v,positionals:pos}=parseCli(args),home=resolve(typeof v.home==='string'?v.home:defaultHome()),timeout=typeof v['timeout-ms']==='string'?integer(v['timeout-ms'],'--timeout-ms',1):30_000;
  const [group,verb,first,second]=pos;
  if(v.version)return {name:'agent-workbench',version:'0.1.0'};
  if(v.help||!group)return {usage:'aw init | daemon start/status/stop/recover-lock | doctor --offline | repo/policy/task/approval/board/history/backup/gc',options:'--home PATH --json --timeout-ms N --request-id req_HEX --expected-version N'};
  if(group==='init')return initialize(home,v['dev-fixtures']===true);
  if(group==='backup'&&verb==='restore'){
    const source=resolve(required(v.source,'--source')),destination=resolve(required(v.destination,'--destination'));
    try{await lstat(join(home,'daemon.lock'));throw daemonError('DAEMON_RUNNING','restoreはdaemon停止後に新規homeへ実行してください。');}catch(error){if(asError(error).code!=='ENOENT')throw error;}
    try{await lstat(destination);throw daemonError('RESTORE_DESTINATION_EXISTS','restore先は存在しない新規directoryに限ります。');}catch(error){if(asError(error).code!=='ENOENT')throw error;}
    // オフライン復旧だけは新規DBを作って閉じる。稼働中daemonのDBへは書かない。
    const restored=unwrap(await restoreStore(source,destination));
    for(const segments of [['objects'],['repos'],['workspaces'],['workers'],['backups'],['exports'],['protocol-captures'],['credentials','codex'],['session-cwd']])ensureDirectory(destination,segments);
    const token=await open(join(destination,'control-token'),'wx',0o600);try{await token.writeFile(randomBytes(32).toString('hex'));await token.sync();}finally{await token.close();}await syncDirectory(destination);
    return {home:destination,...restored,unconsumedApprovals:'revoked',activeAttempts:'unknown',reauthenticationRequired:true};
  }
  if(group==='doctor'&&v.offline){const config=readConfig(home);return {offline:true,node:process.version,nodeSupported:Number(process.versions.node.split('.')[0])>=24,contracts:contracts.size,fixtureHome:config.devFixtures,protocol:inspectProtocolLock(),liveProviderChecks:'未実施',sandboxChecks:'未実施'};}
  if(group==='daemon'){
    if(verb==='start')return startDaemon(home,timeout);
    if(verb==='recover-lock'){await recoverDaemonLock(home);return {recovered:true};}
    if(!['status','stop'].includes(verb??''))throw daemonError('INVALID_INPUT','daemon操作を指定してください。');
    try{
      const result=await request(home,{schemaVersion:1,requestId:requestId(),method:`daemon.${verb}`,expectedVersion:null,params:{}},timeout);
      if(verb==='stop'){
        const deadline=performance.now()+timeout;
        while(performance.now()<deadline){try{await lstat(join(home,'daemon.lock'));}catch(error){if(asError(error).code==='ENOENT')return {stopped:true};throw error;}await new Promise<void>(done=>setTimeout(done,50));}
        throw daemonError('DAEMON_STOP_TIMEOUT','停止要求後にdaemon lockの解放を確認できません。');
      }
      return result;
    }catch(error){if(verb==='status'&&['ENOENT','ECONNREFUSED','DAEMON_UNAVAILABLE'].includes(asError(error).code))return {running:false};throw error;}
  }
  const rpc=(method:string,params:{[key:string]:Json},expectedVersion:number|null=null,id=requestId())=>request(home,{schemaVersion:1,requestId:id,method,expectedVersion,params},timeout);
  let method='',params:{[key:string]:Json}={},create=false,read=false;
  const field=(name:string,fallback?:string)=>required(v[name]??fallback,`--${name}`);
  if(group==='doctor'){method='system.doctor';read=true;}
  else if(group==='setup'&&verb==='profiles'){method='profiles.configure';params={profiles:await readJson(field('file',typeof v.profiles==='string'?v.profiles:undefined))};create=true;}
  else if(group==='repo'){
    if(verb==='add'){method='repo.add';const source=field('source-path',typeof v.source==='string'?v.source:first);params={sourcePath:resolve(source),name:field('name'),baseRef:typeof v['base-ref']==='string'?v['base-ref']:'refs/heads/main'};create=true;}
    else{method=verb==='list'?'repo.list':verb==='sync'?'repo.syncPlan':verb==='show'?'repo.get':'';read=true;if(verb!=='list')params={repoId:field('repo',first)};}
  }else if(group==='policy'){
    params={repoId:field('repo',first)};
    if(verb==='import'){method='policy.import';params.policy=await readJson(field('file',typeof v.policy==='string'?v.policy:second));create=true;}
    if(verb==='trust'){method='policy.trust';const repo=object(await rpc('repo.get',{repoId:params.repoId!}));params.expectDigest=required(v['expect-digest']??repo.policy_digest,'policy digest');}
  }else if(group==='task'){
    if(verb==='list'){method='task.list';read=true;}
    else if(verb==='create'){method='task.create';create=true;params={repoId:field('repo',first),spec:await readJson(field('file',typeof v.spec==='string'?v.spec:second))};}
    else {params={taskId:field('task',first)};method=`task.${verb==='status'||verb==='show'?'get':verb}`;
      if(['status','show','diff'].includes(verb??''))read=true;
      if(verb==='logs'){method=v.follow?'events.subscribe':'task.logs';read=true;params.afterSeq=typeof v['after-seq']==='string'?integer(v['after-seq'],'--after-seq'):0;}
      if(verb==='start'){params.interaction=typeof v.interaction==='string'?v.interaction:'managed';params.presentation=typeof v.presentation==='string'?v.presentation:'none';}
      if(['verify','review'].includes(verb??'')&&v.rerun)params.rerun=true;
      if(verb==='send')params.message=field('message',second);
      if(verb==='cancel')params.reason=typeof v.reason==='string'?v.reason:'人間による中断';
      if(verb==='revise'&&(v.file||v.spec))params.spec=await readJson(field('file',typeof v.spec==='string'?v.spec:undefined));
      if(verb==='recover'&&v['plan-digest'])params.planDigest=field('plan-digest');
      if(verb==='export'){params.format=typeof v.format==='string'?v.format:'git-bundle';params.out=resolve(field('out'));}
      if(verb==='integrate')params.approvalId=field('approval',second);
    }
  }else if(group==='approval'){
    method=`approval.${verb==='inspect'?'get':verb}`;
    if(verb==='request'){params={taskId:field('task',first),action:typeof v.action==='string'?v.action:'integrate'};}
    else{params={requestId:field('request',first)};if(verb==='inspect')read=true;}
  }else if(group==='board'){
    if(verb==='create'){method='board.create';create=true;params={charter:await readJson(field('file',typeof v.charter==='string'?v.charter:first))};if(v.repo)params.repoId=field('repo');}
    else{method=`board.${verb==='status'?'get':verb}`;params={boardId:field('board',first)};read=['status','memo'].includes(verb??'');if(verb==='cancel')params.reason=typeof v.reason==='string'?v.reason:'人間による中断';}
  }else if(group==='handoff'&&verb==='create'){method='handoff.create';create=true;params={taskId:field('task',first),goal:field('goal',second)};}
  else if(group==='history'&&verb==='query'){method='history.query';read=true;params={taskId:field('task',first),question:field('question',second),scope:typeof v.scope==='string'?v.scope:'same-task'};}
  else if(group==='findings') {method=`findings.${verb==='show'?'get':verb}`;read=true;params=verb==='list'?{candidateId:field('candidate',first)}:{findingId:field('finding',first)};}
  else if(group==='finding'&&verb==='disposition'){method='finding.disposition';params={findingId:field('finding',first),disposition:field('disposition',second),reason:field('reason')};if(v['evidence-digest'])params.evidenceDigest=field('evidence-digest');}
  else if(group==='backup'){method='backup.create';create=true;params={destination:resolve(field('destination',verb))};}
  else if(group==='gc'){if(!v.plan)throw daemonError('INVALID_INPUT','GCは--planだけを実行できます。');method='gc.plan';read=true;}
  if(!method)throw daemonError('INVALID_INPUT','未対応のcommandです。');
  if(v.params){const extra=object(unwrap(parseJson(required(v.params,'--params'))));params={...params,...extra};}
  let version:number|null=null;
  if(v['expected-version']!==undefined)version=v['expected-version']==='null'?null:integer(v['expected-version'],'--expected-version',1);
  else if(!read&&!create){
    if(typeof params.taskId==='string')version=Number(object(await rpc('task.get',{taskId:params.taskId})).version);
    else if(typeof params.repoId==='string')version=Number(object(await rpc('repo.get',{repoId:params.repoId})).version);
    else if(typeof params.boardId==='string')version=Number(object(await rpc('board.get',{boardId:params.boardId})).version);
    else if(typeof params.requestId==='string'){const approval=object(await rpc('approval.get',{requestId:params.requestId}));version=Number(object(await rpc('task.get',{taskId:required(approval.task_id,'task id')})).version);}
    else throw daemonError('EXPECTED_VERSION_REQUIRED','--expected-versionを指定してください。');
  }
  if(create&&version!==null)throw daemonError('INVALID_INPUT','createの--expected-versionはnullに限ります。');
  if(!read&&!create&&(!Number.isSafeInteger(version)||version===null||version<1))throw daemonError('EXPECTED_VERSION_REQUIRED','対象のversionを確認できません。');
  if(method==='policy.trust'){const repo=object(await rpc('repo.get',{repoId:params.repoId!}));if(!repo.policy)throw daemonError('HUMAN_CONFIRMATION_REQUIRED','policy本文を取得できないためtrustを停止します。');await humanConfirm(repo,required(params.expectDigest,'policy digest'));}
  if(method==='approval.grant'||method==='approval.deny'){const approval=object(await rpc('approval.get',{requestId:params.requestId!}));if(!approval.binding)throw daemonError('HUMAN_CONFIRMATION_REQUIRED','承認binding本文を取得できません。');params.expectDigest=required(v['expect-digest']??approval.binding_digest,'approval digest');await humanConfirm(approval,required(params.expectDigest,'approval digest'));}
  if(method==='task.integrate'){const approval=object(await rpc('approval.get',{approvalId:params.approvalId!}));if(!approval.binding)throw daemonError('HUMAN_CONFIRMATION_REQUIRED','承認binding本文を取得できません。');await humanConfirm(approval,required(approval.binding_digest,'approval digest'));}
  const id=typeof v['request-id']==='string'?v['request-id']:requestId();
  if(method==='events.subscribe'){
    const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try{return await subscribe(home,{schemaVersion:1,requestId:id,method,expectedVersion:null,params},event=>process.stdout.write(JSON.stringify(event)+'\n'),controller.signal,timeout);}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
  }
  return rpc(method,params,version,id);
}
function exitCode(code:string):number {if(['INVALID_INPUT','INVALID_TRANSITION','EXPECTED_VERSION_REQUIRED'].includes(code))return 2;if(['VERSION_CONFLICT','IDEMPOTENCY_CONFLICT'].includes(code))return 3;if(/POLICY|EGRESS|SANDBOX|APPROVAL|PERMISSION|HUMAN_CONFIRMATION|CONFIRMATION/.test(code))return 4;if(/BUSY|BASE_MOVED|QUIESCENT/.test(code))return 5;if(/PROVIDER|RATE|PROTOCOL|OUTPUT/.test(code))return 6;if(/ARTIFACT|RECOVERY|IDENTITY/.test(code))return 7;if(/BUDGET|CAPACITY/.test(code))return 8;return 1;}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const json=process.argv.includes('--json');
  try{const result=await runCli(process.argv.slice(2));const output=JSON.stringify(json?{ok:true,data:result}:result,null,json?undefined:2);process.stdout.write((json?output:sanitize(output))+'\n');}
  catch(error){const normalized=asError(error);if(json)process.stdout.write(JSON.stringify({ok:false,error:normalized})+'\n');else process.stderr.write(`${normalized.code}: ${sanitize(normalized.message)}\n`);process.exitCode=exitCode(normalized.code);}
}
