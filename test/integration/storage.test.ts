import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, unlink, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../src/adapters/sqlite/store.js';
import { backupStore, restoreStore, planWorkspaceGc, planObjectGc } from '../../src/adapters/sqlite/operations.js';
import { createArtifactStore, artifactPath } from '../../src/adapters/filesystem/artifacts.js';
import { appendSpool, recoverSpool } from '../../src/adapters/filesystem/spool.js';
import { unwrap } from '../../src/domain/errors.js';
import type { AgentEvent } from '../../contracts/ports.js';

export async function fixture():Promise<Store> {
  const store=unwrap(openStore(await mkdtemp(join(tmpdir(),'aw-storage-')))),db=store.db;
  db.prepare("INSERT INTO config_versions VALUES('policy','policy','{}',1,1)").run();
  db.prepare("INSERT INTO repositories VALUES('repo','repo','/source','/managed','refs/heads/main','base','refs/heads/main','base','sha1','policy',1,1)").run();
  db.prepare("INSERT INTO tasks(id,repo_id,title,state,spec_json,spec_digest,policy_digest,created_at_ms,updated_at_ms) VALUES('task','repo','仕事','running','{}','spec','policy',1,1)").run();
  db.prepare("INSERT INTO workspaces(id,repo_id,task_id,role,path,base_sha,state,created_at_ms) VALUES('workspace','repo','task','writer','/workspace','base','ready',1)").run();
  db.prepare("INSERT INTO attempts(id,task_id,workspace_id,role,generation,driver,profile_json,state,writes_workspace,worker_instance_id,deadline_at_ms) VALUES('attempt','task','workspace','implement',1,'fake','{}','running',1,'worker',1000)").run();
  return store;
}
const event=(sourceSeq:number):AgentEvent=>({attemptId:'attempt',workerInstanceId:'worker',sourceSeq,occurredAtMs:1,type:'MESSAGE_APPENDED',data:{text:'記録'}});

test('SQLiteの実設定、制約、migration checksumを確認する',async()=>{
  const store=await fixture();
  try {
    assert.equal(store.db.pragma('journal_mode',{simple:true}),'wal');
    assert.equal(store.db.pragma('synchronous',{simple:true}),2);
    assert.equal(store.db.pragma('foreign_keys',{simple:true}),1);
    assert.equal(store.db.pragma('busy_timeout',{simple:true}),5000);
    assert.throws(()=>store.db.prepare("INSERT INTO task_dependencies VALUES('task','missing',NULL)").run(),/FOREIGN KEY/);
    assert.throws(()=>store.db.prepare("INSERT INTO task_dependencies VALUES('task','task',NULL)").run(),/CHECK/);
    const writer=store.db.prepare("INSERT INTO attempts(id,task_id,workspace_id,role,generation,driver,profile_json,state,writes_workspace,deadline_at_ms) VALUES(?,'task','workspace','implement',1,'fake','{}','created',1,1000)");
    assert.throws(()=>writer.run('second'),/UNIQUE/);
    store.db.prepare("UPDATE attempts SET state='unknown' WHERE id='attempt'").run();
    assert.throws(()=>writer.run('unknown-conflict'),/UNIQUE/);
    store.db.prepare("UPDATE attempts SET state='completed' WHERE id='attempt'").run();writer.run('after-terminal');
    store.db.prepare("UPDATE schema_migrations SET checksum='changed'").run();
  }finally{store.close();}
  assert.equal(openStore(store.home).ok,false);
});
test('command再送、version競合、event原子性、同期transactionを確認する',async()=>{
  const store=await fixture();let effects=0;
  const input={requestId:'request',actor:{kind:'human' as const,id:'owner',connectionId:'first-connection'},method:'transition',params:{},aggregateId:'task',expectedVersion:1};
  try {
    const mutate=()=>{effects++;unwrap(store.appendEvent('task',1,'MESSAGE_APPENDED',{},input.actor));return {done:true};};
    const first=unwrap(store.executeCommand(input,mutate));
    assert.deepEqual(unwrap(store.executeCommand(input,mutate)),first);assert.equal(effects,1);
    assert.deepEqual(unwrap(store.executeCommand({...input,actor:{...input.actor,connectionId:'reconnected'}},mutate)),first);assert.equal(effects,1);
    assert.equal(store.executeCommand({...input,params:{different:true}},mutate).ok,false);
    const conflict=store.appendEvent('task',1,'MESSAGE_APPENDED',{},input.actor);assert.equal(conflict.ok,false);if(!conflict.ok)assert.equal(conflict.error.code,'VERSION_CONFLICT');
    assert.throws(()=>store.db.prepare('DELETE FROM events').run(),/append-only/);
    assert.throws(()=>store.db.prepare("UPDATE events SET type='changed'").run(),/append-only/);
    assert.throws(()=>store.transact(()=>{store.db.prepare("UPDATE tasks SET title='rollback' WHERE id='task'").run();return Promise.resolve(1);}),{code:'ASYNC_TRANSACTION'});
    assert.equal((store.db.prepare("SELECT title FROM tasks WHERE id='task'").get() as {title:string}).title,'仕事');
    assert.throws(()=>store.transact(async()=>1),{code:'ASYNC_TRANSACTION'});
    assert.equal(store.db.inTransaction,false);
  }finally{store.close();}
});
test('worker duplicate/gap/identity/late eventでreducerの適用を制限する',async()=>{
  const store=await fixture();let applied=0;const apply=()=>{applied++;};
  try {
    assert.equal(unwrap(store.acceptWorkerEvent(event(2),apply)).status,'gap');assert.equal(applied,0);
    assert.equal(unwrap(store.acceptWorkerEvent(event(1),apply)).status,'accepted');
    assert.equal(unwrap(store.acceptWorkerEvent(event(1),apply)).status,'duplicate');assert.equal(applied,1);
    assert.equal(store.acceptWorkerEvent({...event(1),data:{text:'改変'}},apply).ok,false);
    assert.equal(store.acceptWorkerEvent({...event(2),workerInstanceId:'old-worker'},apply).ok,false);
    assert.equal(unwrap(store.acceptWorkerEvent(event(2),apply)).status,'accepted');
    store.db.prepare("UPDATE attempts SET state='completed' WHERE id='attempt'").run();
    assert.equal(unwrap(store.acceptWorkerEvent(event(3),apply)).status,'late');assert.equal(applied,2);
    assert.equal((store.db.prepare('SELECT count(*) AS count FROM events').get() as {count:number}).count,3);
  }finally{store.close();}
});
test('artifactの内容アドレス保存と改変、欠落、上限を確認する',async()=>{
  const home=await mkdtemp(join(tmpdir(),'aw-artifact-')),artifacts=createArtifactStore(home),bytes=Buffer.from('証拠');
  const ref=unwrap(await artifacts.put(bytes,'text/plain',100));
  assert.deepEqual(Buffer.from(unwrap(await artifacts.readVerified(ref.digest))),bytes);
  assert.deepEqual(unwrap(await artifacts.put(bytes,'text/plain',100)),ref);
  assert.equal((await artifacts.put(bytes,'text/plain',1)).ok,false);
  await writeFile(artifactPath(home,ref.digest),'改変');assert.equal((await artifacts.readVerified(ref.digest)).ok,false);
  await unlink(artifactPath(home,ref.digest));assert.equal((await artifacts.readVerified(ref.digest)).ok,false);
});
test('spoolのfsync保存とpartial trailing lineの隔離を確認する',async()=>{
  const home=await mkdtemp(join(tmpdir(),'aw-spool-')),path=join(home,'events.jsonl');
  unwrap(await appendSpool(path,event(1)));await writeFile(path,'{"sourceSeq":2',{flag:'a'});
  const unconfirmed=await recoverSpool(path);assert.equal(unconfirmed.ok,false);if(!unconfirmed.ok)assert.equal(unconfirmed.error.code,'SPOOL_WRITER_QUIESCENCE_REQUIRED');
  const recovered=unwrap(await recoverSpool(path,100*1024*1024,true));assert.deepEqual(recovered.events,[event(1)]);assert.notEqual(recovered.quarantinePath,null);
  assert.equal(await readFile(recovered.quarantinePath!,'utf8'),'{"sourceSeq":2');assert.equal(await readFile(path,'utf8'),JSON.stringify(event(1))+'\n');
  assert.equal((await appendSpool(path,event(2),1)).ok,false);
});
test('整合backup、restoreによるwriter失効、dirty GC保護を確認する',async()=>{
  const store=await fixture();const parent=await mkdtemp(join(tmpdir(),'aw-backup-'));
  try {
    unwrap(store.appendEvent('task',1,'MESSAGE_APPENDED',{}, {kind:'system',id:'host'}));
    const ref=unwrap(await createArtifactStore(store.home).put(Buffer.from('証拠'),'text/plain',100));
    store.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?)').run(ref.digest,`objects/sha256/${ref.digest.slice(7,9)}/${ref.digest.slice(9)}`,ref.mediaType,ref.sizeBytes,'internal',1);
    store.db.prepare("INSERT INTO candidates(id,task_id,generation,identity_json,identity_digest,base_sha,candidate_sha,tree_sha,check_plan_digest,manifest_digest,state,created_at_ms) VALUES('candidate','task',1,'{}','identity','base','candidate-sha','tree','policy',?,'frozen',1)").run(ref.digest);
    assert.throws(()=>store.db.prepare("UPDATE candidates SET candidate_sha='changed' WHERE id='candidate'").run(),/immutable/);
    assert.throws(()=>store.db.prepare("UPDATE artifacts SET size_bytes=0").run(),/immutable/);
    store.db.prepare("INSERT INTO approval_requests VALUES('request','task','candidate','integrate','{}','binding','evidence','nonce',9999999999999,'granted',1)").run();
    store.db.prepare("INSERT INTO approvals VALUES('approval','request','human','binding',1,NULL,NULL)").run();
    const backup=unwrap(await backupStore(store,join(parent,'backup')));assert.equal(backup.cutoffEventSeq,1);
    unwrap(await restoreStore(join(parent,'backup'),join(parent,'restored')));
    const restored=unwrap(openStore(join(parent,'restored')));
    try{
      assert.equal((restored.db.prepare("SELECT state FROM attempts WHERE id='attempt'").get() as {state:string}).state,'unknown');
      assert.equal((restored.db.prepare("SELECT state FROM tasks WHERE id='task'").get() as {state:string}).state,'recovery_required');
      assert.equal((restored.db.prepare("SELECT state FROM approval_requests WHERE id='request'").get() as {state:string}).state,'revoked');
      assert.equal(typeof(restored.db.prepare("SELECT revoked_at_ms FROM approvals WHERE id='approval'").get() as {revoked_at_ms:number}).revoked_at_ms,'number');
    }finally{restored.close();}
    const plan=planWorkspaceGc(store,[{id:'workspace',stopped:true,dirty:true,retentionExpired:true,artifactsSaved:true,merged:true}]);assert.equal(plan[0]?.eligible,false);assert.ok(plan[0]?.reasons.includes('DIRTY_OR_UNKNOWN'));
  }finally{store.close();}
});
test('storageの親directory symlinkでhome外へ書き込まない',async()=>{
  const home=await mkdtemp(join(tmpdir(),'aw-path-')),outside=await mkdtemp(join(tmpdir(),'aw-outside-'));
  await symlink(outside,join(home,'objects'),'dir');
  assert.equal((await createArtifactStore(home).put(Buffer.from('証拠'),'text/plain',100)).ok,false);
  await symlink(outside,join(home,'db'),'dir');assert.equal(openStore(home).ok,false);
  assert.deepEqual(await readdir(outside),[]);
});
test('object GCは孤立objectを列挙し、backupと未完了commandの参照を保全する',async()=>{
  const store=await fixture();
  try {
    const object=unwrap(await createArtifactStore(store.home).put(Buffer.from('未登録object'),'text/plain',100));
    assert.deepEqual(unwrap(await planObjectGc(store,[])),[{digest:object.digest,eligible:true,reason:'ORPHAN_OBJECT'}]);
    assert.deepEqual(unwrap(await planObjectGc(store,[object.digest])),[{digest:object.digest,eligible:false,reason:'BACKUP_REFERENCED'}]);
    store.db.prepare("INSERT INTO commands(id,request_id,actor_kind,actor_id,method,params_json,params_digest,aggregate_id,state,created_at_ms,updated_at_ms) VALUES('pending','pending','system','host','check','{}','digest','task','uncertain',1,1)").run();
    assert.deepEqual(unwrap(await planObjectGc(store,[])),[{digest:object.digest,eligible:false,reason:'PENDING_COMMANDS'}]);
  }finally{store.close();}
});
test('workerの追記中backupでもcutoffとsnapshot DBが一致し、credentialを含めない',async()=>{
  const store=await fixture(),parent=await mkdtemp(join(tmpdir(),'aw-backup-live-'));
  try {
    await writeFile(join(store.home,'config.json'),'{"schemaVersion":1}');
    await mkdir(join(store.home,'credentials'));await writeFile(join(store.home,'credentials','secret'),'秘密');
    await writeFile(join(store.home,'control-token'),'秘密');
    const backup=backupStore(store,join(parent,'backup'));
    unwrap(await appendSpool(join(store.home,'workers','attempt','events.jsonl'),event(1)));
    unwrap(store.appendEvent('task',1,'MESSAGE_APPENDED',{}, {kind:'system',id:'host'}));
    const manifest=unwrap(await backup);
    assert.equal(manifest.spoolPolicy,'excluded-replay-from-worker-after-cutoff');
    assert.equal(manifest.files.some(file=>/credentials|control-token|workers/.test(file.path)),false);
    assert.equal(manifest.files.some(file=>file.path==='config.json'),true);
    unwrap(await restoreStore(join(parent,'backup'),join(parent,'restored')));
    const restored=unwrap(openStore(join(parent,'restored')));
    try{assert.equal((restored.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events').get() as {seq:number}).seq,manifest.cutoffEventSeq);}finally{restored.close();}
  }finally{store.close();}
});
