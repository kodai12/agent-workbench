import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rename,lstat,readdir} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {initialize} from '../../src/application/config.js';
import {createWorkbench} from '../../src/application/workbench.js';
import {createGitRunner} from '../../src/adapters/git/runner.js';
import {createGitService} from '../../src/adapters/git/index.js';
import {openStore} from '../../src/adapters/sqlite/store.js';
import {backupStore,restoreStore} from '../../src/adapters/sqlite/operations.js';
import {createArtifactStore} from '../../src/adapters/filesystem/artifacts.js';
import {unwrap} from '../../src/domain/errors.js';
import type {WorkspaceRecord} from '../../contracts/ports.js';

async function treeIdentity(root:string):Promise<unknown[]> {
  const result:unknown[]=[];
  async function visit(path:string):Promise<void>{
    const stat=await lstat(path,{bigint:true});
    result.push({path:relative(root,path),mtime:stat.mtimeNs.toString(),mode:stat.mode.toString(),hash:stat.isFile()?createHash('sha256').update(await readFile(path)).digest('hex'):null});
    if(stat.isDirectory())for(const name of (await readdir(path)).sort())await visit(join(path,name));
  }
  await visit(root);return result;
}
test('別home復旧後は旧bare/worktreeへ書かず、参照読取・bundle export・新workspace作成が成立する',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'aw-relocate-'))),home=join(root,'old-home'),source=join(root,'external-source'),destination=join(root,'restored-home'),backup=join(root,'backup');
  initialize(home,false);await mkdir(source);
  const git=createGitRunner(home);await git(['init','-b','main',source]);await writeFile(join(source,'file.txt'),'base\n');await git(['-C',source,'add','--','file.txt']);await git(['-C',source,'commit','-m','復旧テスト基点']);
  const repoId='rep_'+'1'.repeat(32),taskId='tsk_'+'2'.repeat(32),workspaceId='ws_'+'3'.repeat(32),attemptId='att_'+'4'.repeat(32);
  const imported=unwrap(await createGitService(home).importRepository(source,repoId,'refs/heads/main'));
  const workspace:WorkspaceRecord={id:workspaceId,taskId,path:join(home,'workspaces',workspaceId),branchRef:`refs/heads/aw/tasks/${taskId}/1`,baseSha:imported.baseSha,role:'writer'};
  const port=createGitService(home).forRepository(repoId);unwrap(await port.createWorkspace(workspace));await writeFile(join(workspace.path,'file.txt'),'candidate\n');
  const snapshot=unwrap(await port.freezeSnapshot(workspace,imported.baseSha,{writerStopped:true,scope:{allow:['**'],deny:[]},candidateRef:`refs/aw/candidates/${taskId}/1`}));
  const store=unwrap(openStore(home));
  try{
    store.db.prepare("INSERT INTO config_versions VALUES('policy','policy','{}',1,1)").run();
    store.db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(repoId,'repo',source,imported.managedPath,imported.baseRef,imported.baseSha,imported.integrationRef,imported.baseSha,'sha1','policy',1,1);
    store.db.prepare("INSERT INTO tasks(id,repo_id,title,state,spec_json,spec_digest,policy_digest,created_at_ms,updated_at_ms) VALUES(?,?,?,'awaiting_approval','{}','spec','policy',1,1)").run(taskId,repoId,'復旧対象');
    store.db.prepare("INSERT INTO workspaces(id,repo_id,task_id,role,path,branch_ref,base_sha,state,created_at_ms) VALUES(?,?,?,'writer',?,?,?,'ready',1)").run(workspaceId,repoId,taskId,workspace.path,workspace.branchRef,imported.baseSha);
    store.db.prepare("INSERT INTO attempts(id,task_id,workspace_id,role,generation,driver,profile_json,state,writes_workspace,worker_instance_id,worker_socket,presentation_json,process_identity_json,deadline_at_ms) VALUES(?,?,?,'implement',1,'fake','{}','running',1,'old-worker',?,'{}','{}',1000)").run(attemptId,taskId,workspaceId,join(home,'workers',attemptId,'worker.sock'));
    const manifest=unwrap(await createArtifactStore(home).put(Buffer.from(JSON.stringify(snapshot.manifest)),'application/json',10000));
    store.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?)').run(manifest.digest,`objects/sha256/${manifest.digest.slice(7,9)}/${manifest.digest.slice(9)}`,manifest.mediaType,manifest.sizeBytes,'internal',1);
    store.db.prepare("INSERT INTO candidates(id,task_id,generation,identity_json,identity_digest,base_sha,candidate_sha,tree_sha,check_plan_digest,manifest_digest,state,created_at_ms) VALUES('candidate',?,1,'{}','identity',?,?,?,'policy',?,'frozen',1)").run(taskId,imported.baseSha,snapshot.commit,snapshot.tree,manifest.digest);
    store.db.prepare("UPDATE tasks SET active_candidate_id='candidate' WHERE id=?").run(taskId);
    store.db.prepare("INSERT INTO commands(id,request_id,actor_kind,actor_id,method,params_json,params_digest,aggregate_id,state,created_at_ms,updated_at_ms) VALUES('command','request','human','test','task.integrate','{}','params',?,'executing',1,1)").run(taskId);
    store.db.prepare("INSERT INTO approval_requests VALUES('request',?,'candidate','integrate','{}','binding','evidence','nonce',9999999999999,'granted',1)").run(taskId);
    store.db.prepare("INSERT INTO approvals VALUES('approval','request','test','binding',1,'command',NULL)").run();
    store.db.prepare("INSERT INTO integrations VALUES('integration',?,'candidate','approval','command',?,?,?,'prepared',1,NULL)").run(taskId,imported.integrationRef,imported.baseSha,snapshot.commit);
    unwrap(await backupStore(store,backup));
  }finally{store.close();}
  const archived=home+'-archived';await rename(home,archived);
  const untouchedHome=await treeIdentity(archived),untouchedSource=await treeIdentity(source);
  unwrap(await restoreStore(backup,destination));
  const app=createWorkbench(destination);
  try{
    const row=app.store.db.prepare('SELECT managed_git_dir,source_path FROM repositories WHERE id=?').get(repoId) as {managed_git_dir:string;source_path:string};
    assert.equal(row.managed_git_dir,join(destination,'repos',repoId+'.git'));assert.equal(row.source_path,source);
    const metadata=JSON.parse(await readFile(join(destination,'repos',repoId+'.json'),'utf8')) as {managedPath:string;sourcePath:string;commonDir:string};
    assert.equal(metadata.managedPath,row.managed_git_dir);assert.equal(metadata.sourcePath,source);assert.equal(metadata.commonDir,imported.commonDir);
    const oldWorkspace=app.store.db.prepare('SELECT path,state FROM workspaces WHERE id=?').get(workspaceId) as {path:string;state:string};
    assert.equal(oldWorkspace.state,'quarantined');assert.equal(oldWorkspace.path,join(destination,'workspaces',repoId,workspaceId));await assert.rejects(lstat(oldWorkspace.path),{code:'ENOENT'});
    assert.deepEqual(app.store.db.prepare('SELECT worker_socket,process_identity_json,presentation_json,state FROM attempts WHERE id=?').get(attemptId),{worker_socket:null,process_identity_json:null,presentation_json:null,state:'unknown'});
    await assert.rejects(lstat(join(row.managed_git_dir,'worktrees')),{code:'ENOENT'});assert.equal((await lstat(join(destination,'recovery','git-worktrees',repoId))).isDirectory(),true);
    assert.equal((app.store.db.prepare("SELECT state FROM integrations WHERE id='integration'").get() as {state:string}).state,'uncertain');await app.reconcile();
    const actor={kind:'system' as const,id:'restore-test'};
    const loaded=await app.dispatch({schemaVersion:1,requestId:'req_'+'a'.repeat(32),method:'repo.get',expectedVersion:null,params:{repoId}},actor);assert.equal((loaded as {managed_git_dir:string}).managed_git_dir,row.managed_git_dir);
    assert.equal(unwrap(await createGitService(destination).forRepository(repoId).readRef(imported.integrationRef)),imported.baseSha);
    const version=(app.store.db.prepare('SELECT version FROM tasks WHERE id=?').get(taskId) as {version:number}).version;
    const out=join(destination,'candidate.bundle');await app.dispatch({schemaVersion:1,requestId:'req_'+'b'.repeat(32),method:'task.export',expectedVersion:version,params:{taskId,format:'git-bundle',out}},actor);assert.ok((await lstat(out)).size>0);
    const next:WorkspaceRecord={...workspace,id:'ws_'+'5'.repeat(32),path:join(destination,'workspaces','ws_'+'5'.repeat(32)),role:'check',branchRef:null};unwrap(await createGitService(destination).forRepository(repoId).createWorkspace(next));assert.equal(await readFile(join(next.path,'file.txt'),'utf8'),'base\n');
  }finally{app.close();}
  await assert.rejects(lstat(home),{code:'ENOENT'});assert.deepEqual(await treeIdentity(archived),untouchedHome);assert.deepEqual(await treeIdentity(source),untouchedSource);
});
