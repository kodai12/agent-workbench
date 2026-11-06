import Database from 'better-sqlite3';
import { lstatSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Actor, AgentEvent, Json, Result } from '../../../contracts/ports.js';
import { asError, fail, ok, unwrap } from '../../domain/errors.js';
import { canonical, digest } from '../../domain/canonical.js';
import { ensureDirectory } from '../filesystem/paths.js';

export interface CommandInput {
  requestId:string; actor:Actor; method:string; params:Json;
  aggregateId:string; expectedVersion?:number;
}
export interface CommandRecord { id:string; state:string; result:Json|null; error:Json|null }
export class Store {
  constructor(readonly db:Database.Database, readonly home:string) {}
  close():void { this.db.close(); }
  transact<T>(fn:()=>T):T {
    if(fn.constructor.name==='AsyncFunction') throw unwrap(fail('ASYNC_TRANSACTION','transactionは同期処理だけを受け付けます。'));
    return this.db.transaction(()=>{
      const value=fn();
      if(value && (typeof value==='object'||typeof value==='function') && 'then' in value) throw unwrap(fail('ASYNC_TRANSACTION','transaction内のPromiseは禁止です。'));
      return value;
    }).immediate();
  }
  transaction<T>(fn:()=>T):T { return this.transact(fn); }
  appendEvent(aggregateId:string,expectedVersion:number,type:string,payload:Json,actor:Actor):Result<number> {
    try { return ok(this.transact(()=>{
      const update=this.db.prepare('UPDATE tasks SET version=version+1,updated_at_ms=? WHERE id=? AND version=?').run(Date.now(),aggregateId,expectedVersion);
      if(update.changes!==1) throw unwrap(fail('VERSION_CONFLICT','taskのversionが一致しません。'));
      this.db.prepare('INSERT INTO events(event_id,aggregate_id,aggregate_version,type,actor_kind,actor_id,payload_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),aggregateId,expectedVersion+1,type,actor.kind,actor.id,JSON.stringify(payload),Date.now());
      return expectedVersion+1;
    })); } catch(error) { return {ok:false,error:asError(error)}; }
  }
  executeCommand(input:CommandInput,mutate:()=>Json):Result<CommandRecord> {
    try { return ok(this.transact(()=>{
      const actor=input.actor.kind==='human'?{kind:input.actor.kind,id:input.actor.id}:input.actor;
      const paramsDigest=digest({actor,method:input.method,params:input.params,aggregateId:input.aggregateId,expectedVersion:input.expectedVersion??null});
      const existing=this.db.prepare('SELECT * FROM commands WHERE request_id=?').get(input.requestId) as {id:string;params_digest:string;state:string;result_json:string|null;error_json:string|null}|undefined;
      if(existing) {
        if(existing.params_digest!==paramsDigest) throw unwrap(fail('IDEMPOTENCY_CONFLICT','requestIdが異なる内容に再利用されています。'));
        return {id:existing.id,state:existing.state,result:existing.result_json?JSON.parse(existing.result_json) as Json:null,error:existing.error_json?JSON.parse(existing.error_json) as Json:null};
      }
      if(input.expectedVersion!==undefined) {
        const task=this.db.prepare('SELECT version FROM tasks WHERE id=?').get(input.aggregateId) as {version:number}|undefined;
        if(task?.version!==input.expectedVersion) throw unwrap(fail('VERSION_CONFLICT','taskのversionが一致しません。'));
      }
      const id=randomUUID(),now=Date.now();
      this.db.prepare('INSERT INTO commands(id,request_id,actor_kind,actor_id,method,params_json,params_digest,aggregate_id,expected_version,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,input.requestId,input.actor.kind,input.actor.id,input.method,canonical(input.params),paramsDigest,input.aggregateId,input.expectedVersion??null,'pending',now,now);
      const result=mutate();
      if(result && typeof result==='object' && 'then' in result) throw unwrap(fail('ASYNC_TRANSACTION','commandの変更処理は同期処理に限ります。'));
      this.db.prepare("UPDATE commands SET state='completed',result_json=?,updated_at_ms=? WHERE id=?").run(JSON.stringify(result),Date.now(),id);
      return {id,state:'completed',result,error:null};
    })); } catch(error) { return {ok:false,error:asError(error)}; }
  }
  acceptWorkerEvent(event:AgentEvent,apply:(event:AgentEvent)=>void):Result<{status:'accepted'|'duplicate'|'gap'|'late';nextSourceSeq:number}> {
    try { return ok(this.transact(()=>{
      if(!Number.isSafeInteger(event.sourceSeq)||event.sourceSeq<1) throw unwrap(fail('INVALID_SOURCE_SEQ','sourceSeqは正の整数に限ります。'));
      const attempt=this.db.prepare('SELECT worker_instance_id,task_id,state FROM attempts WHERE id=?').get(event.attemptId) as {worker_instance_id:string|null;task_id:string|null;state:string}|undefined;
      if(!attempt || attempt.worker_instance_id!==event.workerInstanceId) throw unwrap(fail('WORKER_IDENTITY_MISMATCH','worker identityが一致しません。'));
      const offset=this.db.prepare('SELECT accepted_source_seq,worker_instance_id FROM worker_offsets WHERE attempt_id=?').get(event.attemptId) as {accepted_source_seq:number;worker_instance_id:string}|undefined;
      if(offset && offset.worker_instance_id!==event.workerInstanceId) throw unwrap(fail('WORKER_IDENTITY_MISMATCH','保存済みworker identityが一致しません。'));
      const next=(offset?.accepted_source_seq??0)+1;
      const payload=canonical(event);
      if(event.sourceSeq<next) {
        const previous=this.db.prepare('SELECT payload_json FROM events WHERE attempt_id=? AND source_seq=?').get(event.attemptId,event.sourceSeq) as {payload_json:string}|undefined;
        if(previous?.payload_json!==payload) throw unwrap(fail('WORKER_EVENT_CONFLICT','保存済みeventとpayloadが一致しません。'));
        return {status:'duplicate' as const,nextSourceSeq:next};
      }
      if(event.sourceSeq>next) return {status:'gap' as const,nextSourceSeq:next};
      const late=['completed','failed','cancelled'].includes(attempt.state);
      if(!late) apply(event);
      const version=attempt.task_id?(this.db.prepare('SELECT version FROM tasks WHERE id=?').get(attempt.task_id) as {version:number}).version:0;
      this.db.prepare('INSERT INTO events(event_id,aggregate_id,aggregate_version,type,actor_kind,actor_id,attempt_id,source_seq,payload_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),attempt.task_id??event.attemptId,version,event.type,'worker',event.workerInstanceId,event.attemptId,event.sourceSeq,payload,Date.now());
      this.db.prepare('INSERT INTO worker_offsets(attempt_id,accepted_source_seq,worker_instance_id,updated_at_ms) VALUES(?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET accepted_source_seq=excluded.accepted_source_seq,updated_at_ms=excluded.updated_at_ms').run(event.attemptId,event.sourceSeq,event.workerInstanceId,Date.now());
      return {status:late?'late' as const:'accepted' as const,nextSourceSeq:next+1};
    })); } catch(error) { return {ok:false,error:asError(error)}; }
  }
}
export function openStore(home:string):Result<Store> {
  let db:Database.Database|undefined;
  try {
    ensureDirectory(home,['db']);
    try {if(lstatSync(join(home,'db','state.sqlite')).isSymbolicLink())return fail('DB_SYMLINK_REJECTED','DBへのsymlinkは使用できません。');}
    catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
    db=new Database(join(home,'db','state.sqlite'));
    const version=db.prepare('SELECT sqlite_version() AS version').get() as {version:string};
    const parts=version.version.split('.').map(Number);
    if((parts[0]??0)<3 || (parts[0]===3 && ((parts[1]??0)<51 || (parts[1]===51 && (parts[2]??0)<3)))) { db.close(); return fail('SQLITE_TOO_OLD','SQLite 3.51.3以上が必要です。',{version:version.version}); }
    db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON'); db.pragma('busy_timeout=5000');
    const sql=readFileSync(new URL('../../../contracts/001_initial.sql',import.meta.url),'utf8');
    const checksum=createHash('sha256').update(sql).digest('hex');
    const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if(exists) {
      const rows=db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all() as {version:number;checksum:string}[];
      if(rows.some(row=>row.version>1)) {db.close();return fail('SCHEMA_TOO_NEW','このバイナリより新しいDB schemaです。');}
      if(rows.length!==1||rows[0]?.version!==1||rows[0].checksum!==checksum) {db.close();return fail('MIGRATION_CHECKSUM_MISMATCH','migration checksumが一致しません。');}
    } else {
      const connection=db;
      // PRAGMAは接続時に設定済み。DDL全体とchecksum記録を同時に確定する。
      db.transaction(()=>{connection.exec(sql.slice(sql.indexOf('CREATE TABLE')));connection.prepare('INSERT INTO schema_migrations VALUES(1,?,?)').run(checksum,Date.now());}).immediate();
    }
    if(db.pragma('integrity_check',{simple:true})!=='ok'||(db.pragma('foreign_key_check') as unknown[]).length>0) {db.close();return fail('DB_INTEGRITY_FAILED','DBの整合検査に失敗しました。');}
    return ok(new Store(db,home));
  } catch(error) {db?.close();return {ok:false,error:asError(error)};}
}
