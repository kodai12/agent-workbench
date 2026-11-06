import {randomUUID} from 'node:crypto';
import {realpathSync,readFileSync} from 'node:fs';
import {relative,sep} from 'node:path';
import type {ArtifactStore,Digest,Json,Result} from '../../contracts/ports.js';
import type {Store} from '../adapters/sqlite/store.js';
import type {Config} from './config.js';
import type {TaskRow,CandidateRow} from './types.js';
import {canonical} from '../domain/canonical.js';
import {asError,ok,unwrap} from '../domain/errors.js';
import {validateCitations,type HandoffContext} from '../domain/handoff.js';
import type {SourceEvidence} from '../domain/review.js';
import {object,record,text,list,number} from './data.js';

type EventRow={seq:number;type:string;payload_json:string;created_at_ms:number;size_bytes?:number};
type Attempt={id:string;state:string;driver:string;profile_json:string};
const id=(prefix:string)=>prefix+'_'+randomUUID().replaceAll('-','');
function stop(code:string,message:string):never{throw {code,message};}
async function boundary<T>(fn:()=>Promise<T>):Promise<Result<T>>{try{return ok(await fn());}catch(error){return {ok:false,error:asError(error)};}}

export function createHandoffService(store:Store,artifacts:ArtifactStore,config:Config){
 const db=store.db;
 const task=(taskId:string)=>{const value=db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as TaskRow|undefined;if(!value)stop('NOT_FOUND','taskがありません');return value;};
 const put=async(value:Json)=>unwrap(await artifacts.put(Buffer.from(canonical(value)),'application/json',524288));
 async function sourceContext(taskId:string):Promise<{context:HandoffContext;source:Json;sourceDigest:Digest;candidate:CandidateRow|null;attempt:Attempt}>{
   const row=task(taskId);const active=db.prepare("SELECT 1 FROM attempts WHERE task_id=? AND writes_workspace=1 AND state IN ('created','starting','running','waiting_input','stopping','unknown')").get(taskId);if(active)stop('SOURCE_NOT_QUIESCENT','元writerの終了確認が必要です');
   const attempt=db.prepare("SELECT * FROM attempts WHERE task_id=? AND role='implement' ORDER BY coalesce(ended_at_ms,started_at_ms,0) DESC,id DESC LIMIT 1").get(taskId) as Attempt|undefined;if(!attempt||!['completed','failed','cancelled'].includes(attempt.state))stop('SOURCE_NOT_QUIESCENT','停止済みの元attemptが必要です');
   const cutoff=(db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events WHERE aggregate_id=?').get(taskId) as {seq:number}).seq;
   const candidate=row.active_candidate_id?db.prepare('SELECT * FROM candidates WHERE id=? AND task_id=?').get(row.active_candidate_id,taskId) as CandidateRow|undefined:undefined;
   if(row.active_candidate_id&&!candidate)stop('CANDIDATE_NOT_FOUND','candidateの根拠が欠落しています');
   const events=db.prepare('SELECT seq,type,created_at_ms FROM events WHERE aggregate_id=? AND seq<=? ORDER BY seq LIMIT 1001').all(taskId,cutoff) as Omit<EventRow,'payload_json'>[];if(events.length>1000)stop('RESOURCE_LIMIT','handoff対象eventが1000件を超えています。目的別の絞り込みが必要です');
   const checks=db.prepare('SELECT c.id,c.check_key,c.state,c.exit_code,c.output_digest FROM checks c JOIN candidates x ON x.id=c.candidate_id WHERE x.task_id=? ORDER BY c.id LIMIT 1001').all(taskId) as {id:string;check_key:string;state:string;exit_code:number|null;output_digest:Digest|null}[];if(checks.length>1000)stop('RESOURCE_LIMIT','check履歴が1000件を超えています');
   const source:Json={taskId,title:row.title,state:row.state,specDigest:row.spec_digest,taskSpec:record(row.spec_json),sourceAttemptId:attempt.id,sourceEventCutoff:cutoff,candidate:candidate?{id:candidate.id,identityDigest:candidate.identity_digest,baseSha:candidate.base_sha,candidateSha:candidate.candidate_sha,treeSha:candidate.tree_sha,manifestDigest:candidate.manifest_digest}:null,events:events.map(e=>({seq:e.seq,type:e.type,createdAtMs:e.created_at_ms})),checks:checks.map(c=>({checkId:c.id,checkKey:c.check_key,state:c.state,exitCode:c.exit_code,outputDigest:c.output_digest})),nativeHistoryAvailable:false};
   const sourceRef=await put(source);const candidateDigest=candidate?.identity_digest??null;const sources:Record<string,SourceEvidence>={[sourceRef.digest]:{digest:sourceRef.digest,lineCount:1,candidateIdentityDigest:candidateDigest,kind:'artifact'}};
   const linked=db.prepare("SELECT DISTINCT a.digest,a.media_type,a.size_bytes FROM artifact_links l JOIN artifacts a ON a.digest=l.digest WHERE (l.owner_type='task' AND l.owner_id=?) OR (l.owner_type='candidate' AND l.owner_id=?) ORDER BY a.digest LIMIT 101").all(taskId,candidate?.id??'') as {digest:Digest;media_type:string;size_bytes:number}[];
   if(candidate&&!linked.some(a=>a.digest===candidate.manifest_digest)){const metadata=db.prepare('SELECT digest,media_type,size_bytes FROM artifacts WHERE digest=?').get(candidate.manifest_digest) as {digest:Digest;media_type:string;size_bytes:number}|undefined;if(!metadata)stop('ARTIFACT_NOT_FOUND','candidate manifestがありません');linked.push(metadata);}
   if(linked.length>100)stop('RESOURCE_LIMIT','handoff参照artifactが100件を超えています');let total=sourceRef.sizeBytes;
   for(const ref of linked){total+=ref.size_bytes;if(total>524288)stop('RESOURCE_LIMIT','handoff入力上限512KiBを超えています');const bytes=unwrap(await artifacts.readVerified(ref.digest));sources[ref.digest]={digest:ref.digest,lineCount:ref.media_type.startsWith('text/')||ref.media_type==='application/json'?Buffer.from(bytes).toString('utf8').split('\n').length:null,candidateIdentityDigest:candidateDigest,kind:'artifact'};}
   return {context:{taskId,sourceAttemptId:attempt.id,sourceEventCutoff:cutoff,sourceQuiescent:true,candidateIdentityDigest:candidateDigest,nativeHistoryAvailable:false,sources},source,sourceDigest:sourceRef.digest,candidate:candidate??null,attempt};
 }
 const service={
   async create(taskId:string,goal:string):Promise<Result<Json>>{return boundary(async()=>{
     if(!goal.trim()||goal.length>12000)stop('INVALID_INPUT','handoffの目的は1〜12000文字で指定してください');const row=task(taskId);
     const selected=config.profiles['handoff']??config.profiles['fake-coding'];if(!config.devFixtures||!selected||object(selected).driver!=='fake')stop('EGRESS_DENIED','handoff要約の実provider送信は許可と対応driverが必要です');
     const repo=db.prepare('SELECT source_path,source_base_sha FROM repositories WHERE id=?').get(row.repo_id) as {source_path:string;source_base_sha:string};const root=realpathSync(store.home),source=realpathSync(repo.source_path),rel=relative(root,source);const identity=record(readFileSync(root+'/fixtures/identity.json','utf8'));if(!rel.startsWith('fixtures'+sep)||rel.includes('..'+sep)||realpathSync(text(identity.sourcePath))!==source||identity.baseSha!==repo.source_base_sha)stop('FAKE_PRODUCTION_DENIED','fake要約はdevFixtures配下の既知repositoryだけで実行できます');
     const captured=await sourceContext(taskId);const evidence={kind:'artifact',reference:captured.sourceDigest,digest:captured.sourceDigest,startLine:null,endLine:null,explanation:'固定cutoff時点のhost管理レコード'};
     const output:Json={schemaVersion:1,goal,taskId,candidateIdentityDigest:captured.context.candidateIdentityDigest,sourceAttemptId:captured.context.sourceAttemptId,sourceEventCutoff:captured.context.sourceEventCutoff,facts:[{statement:`host管理のtask「${row.title}」の状態は${row.state}`,evidence:[evidence]},...(captured.candidate?[{statement:`candidate SHAは${captured.candidate.candidate_sha}`,evidence:[evidence]}]:[])],decisions:[],openQuestions:['目的に必要な追加の判断と実環境での検証結果は未確認'],nextActions:[`目的「${goal}」に必要な根拠をsourceRefsから確認する`],nonGoals:['native会話未取込。非公開履歴と認証情報は読まない','simulated=true。fakeによるhost記録の要約であり、実providerの解釈ではない'],sourceRefs:Object.keys(captured.context.sources)};
     const validated=unwrap(validateCitations(output,captured.context));const ref=await put(validated);const handoffId=id('handoff');
     store.transact(()=>{const current=task(taskId);const cutoff=(db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events WHERE aggregate_id=?').get(taskId) as {seq:number}).seq;if(current.version!==row.version||cutoff!==captured.context.sourceEventCutoff||current.active_candidate_id!==row.active_candidate_id)stop('HANDOFF_SOURCE_MISMATCH','要約中に元taskが更新されました');if(db.prepare("SELECT 1 FROM attempts WHERE task_id=? AND writes_workspace=1 AND state IN ('created','starting','running','waiting_input','stopping','unknown')").get(taskId))stop('SOURCE_NOT_QUIESCENT','要約中にwriterが開始されました');
       db.prepare('INSERT INTO handoffs(id,task_id,source_attempt_id,cutoff_event_seq,output_digest,created_at_ms) VALUES(?,?,?,?,?,?)').run(handoffId,taskId,captured.context.sourceAttemptId,captured.context.sourceEventCutoff,ref.digest,Date.now());db.prepare('INSERT INTO artifact_links VALUES(?,?,?,?)').run('handoff',handoffId,'source',captured.sourceDigest);db.prepare('INSERT INTO artifact_links VALUES(?,?,?,?)').run('task',taskId,'handoff',ref.digest);unwrap(store.appendEvent(taskId,current.version,'handoff.created',{handoffId,outputDigest:ref.digest,sourceEventCutoff:captured.context.sourceEventCutoff,simulated:true},{kind:'system',id:'aw'}));
     });return {handoffId,outputDigest:ref.digest,output:validated,simulated:true,cost:null};
   });},
   async validate(taskId:string,output:Json):Promise<Result<Json>>{return boundary(async()=>{
     task(taskId);const value=object(output);const cutoff=number(value.sourceEventCutoff);const attemptId=text(value.sourceAttemptId);const attempt=db.prepare('SELECT state FROM attempts WHERE id=? AND task_id=?').get(attemptId,taskId) as {state:string}|undefined;if(!attempt||!['completed','failed','cancelled'].includes(attempt.state))stop('HANDOFF_SOURCE_MISMATCH','停止済みsource attemptがありません');
     const currentCutoff=(db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events WHERE aggregate_id=?').get(taskId) as {seq:number}).seq;if(cutoff<0||cutoff>currentCutoff)stop('HANDOFF_SOURCE_MISMATCH','source cutoffが実在範囲外です');
     const candidateDigest=value.candidateIdentityDigest===null?null:text(value.candidateIdentityDigest) as Digest;const sources:Record<string,SourceEvidence>={};let matchingSource=false;
     for(const ref of list(value.sourceRefs).map(text)){
       const allowed=db.prepare("SELECT 1 FROM artifact_links l WHERE l.digest=? AND ((l.owner_type='task' AND l.owner_id=?) OR (l.owner_type='candidate' AND l.owner_id IN (SELECT id FROM candidates WHERE task_id=?)) OR (l.owner_type='handoff' AND l.owner_id IN (SELECT id FROM handoffs WHERE task_id=?))) UNION SELECT 1 FROM candidates WHERE task_id=? AND manifest_digest=?").get(ref,taskId,taskId,taskId,taskId,ref);if(!allowed)stop('INVALID_EVIDENCE','task外のartifactを参照しています');
       const bytes=unwrap(await artifacts.readVerified(ref as Digest));const content=Buffer.from(bytes).toString('utf8');sources[ref]={digest:ref as Digest,lineCount:content.split('\n').length,candidateIdentityDigest:candidateDigest,kind:'artifact'};
       try{const source=record(content);const candidate=source.candidate===null?null:source.candidate&&object(source.candidate).identityDigest;if(source.taskId===taskId&&source.sourceAttemptId===attemptId&&source.sourceEventCutoff===cutoff&&candidate===candidateDigest)matchingSource=true;}catch{/* JSON以外の根拠はsource snapshotとして扱わない。 */}
     }
     if(!matchingSource)stop('HANDOFF_SOURCE_MISMATCH','cutoffとcandidateを固定したsource artifactがありません');return unwrap(validateCitations(output,{taskId,sourceAttemptId:attemptId,sourceEventCutoff:cutoff,sourceQuiescent:true,candidateIdentityDigest:candidateDigest,nativeHistoryAvailable:false,sources}));
   });},
   async query(taskId:string,question:string,scope='same-task'):Promise<Result<Json>>{return boundary(async()=>{
     const row=task(taskId);if(!question.trim()||question.length>12000)stop('INVALID_INPUT','検索質問は1〜12000文字で指定してください');if(!['same-task','same-repo'].includes(scope))stop('ACCESS_DENIED','cross-repo検索は別承認が必要です');
     const taskRows=scope==='same-task'?[row]:(db.prepare('SELECT * FROM tasks WHERE repo_id=? ORDER BY id LIMIT 101').all(row.repo_id) as TaskRow[]);if(taskRows.length>100)stop('RESOURCE_LIMIT','same-repo対象taskが100件を超えています');const tokens=question.toLowerCase().split(/\s+/).filter(Boolean);const events:Json[]=[];const matches:Json[]=[];let scannedEvents=0,scannedArtifacts=0,bytesScanned=0;let truncated=false;
     for(const target of taskRows){const rows=db.prepare("SELECT seq,type,CASE WHEN length(payload_json)<=8192 THEN payload_json ELSE '{}' END AS payload_json,length(CAST(payload_json AS BLOB)) AS size_bytes,created_at_ms FROM events WHERE aggregate_id=? ORDER BY seq DESC LIMIT 1001").all(target.id) as EventRow[];if(rows.length>1000)truncated=true;for(const e of rows.slice(0,1000)){if((e.size_bytes??0)>8192||bytesScanned+(e.size_bytes??0)>524288){truncated=true;continue;}scannedEvents++;bytesScanned+=e.size_bytes??0;const corpus=e.type+' '+e.payload_json;if(tokens.some(t=>corpus.toLowerCase().includes(t)))events.push({taskId:target.id,eventSeq:e.seq,type:e.type,payload:record(e.payload_json),createdAtMs:e.created_at_ms});if(events.length>=100){truncated=true;break;}}
       const refs=db.prepare("SELECT DISTINCT a.digest,a.media_type,a.size_bytes FROM artifact_links l JOIN artifacts a ON a.digest=l.digest WHERE l.owner_type='task' AND l.owner_id=? ORDER BY a.digest LIMIT 101").all(target.id) as {digest:Digest;media_type:string;size_bytes:number}[];if(refs.length>100)truncated=true;
       for(const ref of refs.slice(0,100)){if(!ref.media_type.startsWith('text/')&&ref.media_type!=='application/json')continue;if(bytesScanned+ref.size_bytes>524288){truncated=true;break;}const bytes=unwrap(await artifacts.readVerified(ref.digest));bytesScanned+=bytes.length;scannedArtifacts++;const content=Buffer.from(bytes).toString('utf8');if(tokens.some(t=>content.toLowerCase().includes(t)))matches.push({taskId:target.id,artifactDigest:ref.digest,mediaType:ref.media_type,excerpt:content.slice(0,2000)});}
     }
     return {taskId,question,scope,method:'bounded-metadata-and-text',status:events.length||matches.length?'found':truncated?'ambiguous':'not_found',events,artifacts:matches,limits:{eventsPerTask:1000,artifactsPerTask:100,textBytes:524288},scanned:{tasks:taskRows.length,events:scannedEvents,artifacts:scannedArtifacts,bytes:bytesScanned},truncated,limitations:['native会話未取込。awのeventと登録artifactだけを検索','LLMによる意味検索は未実施']};
   });},
 };
 return service;
}
