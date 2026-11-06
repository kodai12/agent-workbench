import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,chmod,realpath,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createGitService} from '../../src/adapters/git/index.js';
import {createGitRunner} from '../../src/adapters/git/runner.js';
import {unwrap} from '../../src/domain/errors.js';
import type {WorkspaceRecord} from '../../contracts/ports.js';

const repoId='repo_'+'1'.repeat(32), taskId='tsk_'+'2'.repeat(32);
async function fixture(format:'sha1'|'sha256'='sha1'){
  const root=await mkdtemp(join(tmpdir(),'aw-git-'));const home=join(root,'home');const source=join(root,'- 元 source');await mkdir(source);
  const git=createGitRunner(home);await git(['init','--object-format='+format,'-b','main',source]);
  await writeFile(join(source,'file.txt'),'base\n');await writeFile(join(source,'delete.txt'),'削除前\n');await writeFile(join(source,'.gitignore'),'ignored.txt\n.env\n');await git(['-C',source,'add','--','file.txt','delete.txt','.gitignore']);await git(['-C',source,'commit','-m','基点']);
  const service=createGitService(home);return {root,home,source,git,service};
}
function workspace(home:string,baseSha:string,suffix='3'):WorkspaceRecord{return {id:'ws_'+suffix.repeat(32),taskId,path:join(home,'workspaces','ws_'+suffix.repeat(32)),branchRef:`refs/heads/aw/tasks/${taskId}/${suffix}`,baseSha,role:'writer'};}
const options={writerStopped:true,scope:{allow:['**'],deny:[]},timestampSeconds:1_700_000_000};

for(const format of ['sha1','sha256'] as const)test(`T22/T24/T25/T28/T30/T34/T56/T57/T58/T80: ${format}の実Git候補とCAS`,async()=>{
  const {home,source,git,service,root}=await fixture(format);
  await writeFile(join(source,'file.txt'),'source dirty\n');await writeFile(join(source,'untracked.txt'),'元に残す');
  const before=await git(['-C',source,'status','--porcelain=v1','-z']);
  const repo=unwrap(await service.importRepository(source,repoId,'refs/heads/main'));assert.equal(repo.baseSha.length,format==='sha1'?40:64);
  const port=service.forRepository(repoId);const ws=workspace(home,repo.baseSha);unwrap(await port.createWorkspace(ws));assert.equal(await readFile(join(ws.path,'file.txt'),'utf8'),'base\n');
  await writeFile(join(ws.path,'file.txt'),'candidate\n');await writeFile(join(ws.path,'ignored.txt'),'無視');await writeFile(join(ws.path,'追加.txt'),'追加');await unlink(join(ws.path,'delete.txt'));
  const bytes=Buffer.from([0,255,128,10]);await writeFile(join(ws.path,'binary.bin'),bytes);await chmod(join(ws.path,'file.txt'),0o755);
  const snapshot=unwrap(await port.freezeSnapshot(ws,repo.baseSha,options));assert.equal(snapshot.manifest.files.length,4);assert.deepEqual(snapshot.binaryPaths,['binary.bin']);assert.equal(snapshot.manifest.files.find(f=>f.path==='delete.txt')?.change,'deleted');assert.equal(snapshot.manifest.files.find(f=>f.path==='delete.txt')?.sizeBytes,Buffer.byteLength('削除前\n'));
  assert.equal(snapshot.manifest.files.find(f=>f.path==='binary.bin')?.contentSha256,'sha256:'+createHash('sha256').update(bytes).digest('hex'));
  assert.equal(snapshot.manifest.files.find(f=>f.path==='file.txt')?.mode,'100755');
  assert.equal((await git(['--git-dir',repo.managedPath,'rev-list','--parents','-n','1',snapshot.commit])).trim(),snapshot.commit+' '+repo.baseSha);
  const check={...workspace(home,snapshot.commit,'4'),branchRef:null,role:'check' as const};unwrap(await port.createWorkspace(check));await writeFile(join(ws.path,'file.txt'),'writer再開');assert.equal(await readFile(join(check.path,'file.txt'),'utf8'),'candidate\n');
  assert.equal(unwrap(await port.reconcileIntegration(repo.integrationRef,repo.baseSha,snapshot.commit)),'prepared');unwrap(await port.compareAndSwapRef(repo.integrationRef,repo.baseSha,snapshot.commit));
  assert.equal(unwrap(await port.reconcileIntegration(repo.integrationRef,repo.baseSha,snapshot.commit)),'applied');
  const ws2=workspace(home,repo.baseSha,'5');unwrap(await port.createWorkspace(ws2));await writeFile(join(ws2.path,'file.txt'),'別candidate');const second=unwrap(await port.freezeSnapshot(ws2,repo.baseSha,options));
  assert.equal((await port.compareAndSwapRef(repo.integrationRef,repo.baseSha,second.commit)).ok,false);assert.equal(unwrap(await port.reconcileIntegration(repo.integrationRef,repo.baseSha,second.commit)),'uncertain');
  const exported=unwrap(await port.exportBundle(snapshot.candidateRef,repo.baseSha,join(root,'成果.bundle')));assert.equal(exported.candidateRef,snapshot.candidateRef);await git(['-C',source,'bundle','verify',exported.path]);
  assert.equal(await git(['-C',source,'status','--porcelain=v1','-z']),before);assert.equal(await readFile(join(source,'file.txt'),'utf8'),'source dirty\n');
});

test('T23/T27: linked sourceと悪意あるfsmonitor/hook/uploadpack設定を実行しない',async()=>{
  const {home,source,git,service,root}=await fixture();const linked=join(root,'linked');await git(['-C',source,'worktree','add','-b','linked',linked]);
  const marker=join(root,'実行された');const script=join(root,'hook');await writeFile(script,`#!/bin/sh\n/usr/bin/touch '${marker}'\n`);await chmod(script,0o755);
  await git(['-C',source,'config','core.fsmonitor',script]);await git(['-C',source,'config','uploadpack.packObjectsHook',script]);await git(['-C',source,'config','core.hooksPath',root]);
  const repo=unwrap(await service.importRepository(linked,repoId,'refs/heads/main'));assert.equal(repo.commonDir,await realpath(join(source,'.git')));await assert.rejects(readFile(marker),{code:'ENOENT'});
  unwrap(await service.forRepository(repoId).createWorkspace(workspace(home,repo.baseSha)));
});

test('T26/T29/T31/T32: scope、秘密情報、symlink、submodule、writer稼働を拒否する',async()=>{
  const {home,source,service}=await fixture();const repo=unwrap(await service.importRepository(source,repoId,'refs/heads/main'));const port=service.forRepository(repoId);const ws=workspace(home,repo.baseSha);unwrap(await port.createWorkspace(ws));
  const active=await port.freezeSnapshot(ws,repo.baseSha);assert.equal(active.ok,false);if(!active.ok)assert.equal(active.error.code,'WRITER_NOT_STOPPED');
  await writeFile(join(ws.path,'.env'),'秘密');const secret=await port.freezeSnapshot(ws,repo.baseSha,options);assert.equal(secret.ok,false);if(!secret.ok)assert.equal(secret.error.code,'SECRET_DETECTED');
  const ws2=workspace(home,repo.baseSha,'6');unwrap(await port.createWorkspace(ws2));await symlink('/etc/passwd',join(ws2.path,'link'));const escaped=await port.freezeSnapshot(ws2,repo.baseSha,options);assert.equal(escaped.ok,false);if(!escaped.ok)assert.equal(escaped.error.code,'PATH_OUTSIDE_SCOPE');
  const ws3=workspace(home,repo.baseSha,'7');unwrap(await port.createWorkspace(ws3));await writeFile(join(ws3.path,'file.txt'),'外');const scope=await port.freezeSnapshot(ws3,repo.baseSha,{...options,scope:{allow:['src/**'],deny:[]}});assert.equal(scope.ok,false);if(!scope.ok)assert.equal(scope.error.code,'PATH_OUTSIDE_SCOPE');
});

test('runnerは環境のGit設定を継承せず出力上限を適用する',async()=>{
  const {git}=await fixture();await assert.rejects(git(['--version'],{maxOutputBytes:1}),{code:'GIT_OUTPUT_LIMIT'});
});

test('T28: writer独自commitをparentに採用せずhost基点から再構成する',async()=>{
  const {home,source,git,service}=await fixture();const repo=unwrap(await service.importRepository(source,repoId,'refs/heads/main'));const port=service.forRepository(repoId);const ws=workspace(home,repo.baseSha);unwrap(await port.createWorkspace(ws));
  await writeFile(join(ws.path,'file.txt'),'worker独自commit');await git(['-C',ws.path,'add','--','file.txt']);await git(['-C',ws.path,'commit','-m','worker履歴']);
  const agentHead=(await git(['-C',ws.path,'rev-parse','HEAD'])).trim();const snapshot=unwrap(await port.freezeSnapshot(ws,repo.baseSha,options));
  assert.equal((await git(['--git-dir',repo.managedPath,'rev-list','--parents','-n','1',snapshot.commit])).trim(),snapshot.commit+' '+repo.baseSha);assert.notEqual(agentHead,snapshot.commit);
});

test('T31: 実gitlinkの導入を拒否する',async()=>{
  const {home,source,git,service}=await fixture();const repo=unwrap(await service.importRepository(source,repoId,'refs/heads/main'));const port=service.forRepository(repoId);const ws=workspace(home,repo.baseSha);unwrap(await port.createWorkspace(ws));
  await git(['-C',ws.path,'update-index','--add','--cacheinfo',`160000,${repo.baseSha},sub`]);await git(['-C',ws.path,'commit','-m','gitlink導入']);
  await mkdir(join(ws.path,'sub'));await writeFile(join(ws.path,'sub','.git'),'gitdir: ../../outside\n');const frozen=await port.freezeSnapshot(ws,repo.baseSha,options);assert.equal(frozen.ok,false);if(!frozen.ok)assert.equal(frozen.error.code,'UNSUPPORTED_GITLINK_CHANGE');
});

test('T33: dirty sourceの同size変更も拒否しcandidate refを公開しない',async()=>{
  const {home,source,git,service,root}=await fixture();await writeFile(join(source,'file.txt'),'aaaaa');const repo=unwrap(await service.importRepository(source,repoId,'refs/heads/main'));const ws=workspace(home,repo.baseSha);unwrap(await service.forRepository(repoId).createWorkspace(ws));await writeFile(join(ws.path,'file.txt'),'candidate');
  const wrapper=join(root,'trusted-test-git');const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
  await writeFile(wrapper,`#!/bin/sh\nfor arg do\nif [ "$arg" = commit-tree ]; then /usr/bin/printf bbbbb > ${quote(join(source,'file.txt'))}; fi\ndone\nexec /usr/bin/git "$@"\n`);await chmod(wrapper,0o755);
  const port=createGitService(home,undefined,wrapper).forRepository(repoId);const frozen=await port.freezeSnapshot(ws,repo.baseSha,options);assert.equal(frozen.ok,false);if(!frozen.ok)assert.equal(frozen.error.code,'SOURCE_CHANGED');assert.equal(await git(['--git-dir',repo.managedPath,'for-each-ref','--format=%(refname)','refs/aw/candidates/']),'');
});

test('T80: 壊れたbundleと存在しないbaseはexport成功にしない',async()=>{
  const {home,source,service,root}=await fixture();const repo=unwrap(await service.importRepository(source,repoId,'refs/heads/main'));const ws=workspace(home,repo.baseSha);const port=service.forRepository(repoId);unwrap(await port.createWorkspace(ws));await writeFile(join(ws.path,'file.txt'),'candidate');const candidate=unwrap(await port.freezeSnapshot(ws,repo.baseSha,options));
  const missing=await port.exportBundle(candidate.candidateRef,'f'.repeat(40),join(root,'missing.bundle'));assert.equal(missing.ok,false);await assert.rejects(readFile(join(root,'missing.bundle')),{code:'ENOENT'});
  const wrapper=join(root,'broken-bundle-git');await writeFile(wrapper,'#!/bin/sh\nprevious=\nfor arg do\nif [ "$previous" = bundle ] && [ "$arg" = create ]; then /usr/bin/printf broken-bundle; exit 0; fi\nprevious="$arg"\ndone\nexec /usr/bin/git "$@"\n');await chmod(wrapper,0o755);
  const corrupt=await createGitService(home,undefined,wrapper).forRepository(repoId).exportBundle(candidate.candidateRef,repo.baseSha,join(root,'broken.bundle'));assert.equal(corrupt.ok,false);if(!corrupt.ok)assert.equal(corrupt.error.code,'GIT_FAILED');await assert.rejects(readFile(join(root,'broken.bundle')),{code:'ENOENT'});
});

test('exportはDB候補OIDとrefの不一致を拒否し途中ref移動でも固定OIDだけを出力する',async()=>{
  const {home,source,git,service,root}=await fixture();const repo=unwrap(await service.importRepository(source,repoId,'refs/heads/main'));const port=service.forRepository(repoId);const ws=workspace(home,repo.baseSha);unwrap(await port.createWorkspace(ws));await writeFile(join(ws.path,'file.txt'),'candidate-one');const first=unwrap(await port.freezeSnapshot(ws,repo.baseSha,options));await writeFile(join(ws.path,'file.txt'),'candidate-two');const second=unwrap(await port.freezeSnapshot(ws,repo.baseSha,options));
  await git(['--git-dir',repo.managedPath,'update-ref',first.candidateRef,second.commit,first.commit]);const mismatchPath=join(root,'mismatch.bundle');const mismatch=await port.exportBundle(first.candidateRef,repo.baseSha,mismatchPath,first.commit);assert.equal(mismatch.ok,false);if(!mismatch.ok)assert.equal(mismatch.error.code,'CANDIDATE_IDENTITY_MISMATCH');await assert.rejects(readFile(mismatchPath),{code:'ENOENT'});
  await git(['--git-dir',repo.managedPath,'update-ref',first.candidateRef,first.commit,second.commit]);
  const wrapper=join(root,'moving-ref-git');const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
  await writeFile(wrapper,`#!/bin/sh\nfor arg do\nif [ "$arg" = fetch ]; then /usr/bin/git --git-dir ${quote(repo.managedPath)} update-ref ${quote(first.candidateRef)} ${quote(second.commit)}; break; fi\ndone\nexec /usr/bin/git "$@"\n`);await chmod(wrapper,0o755);
  const bundlePath=join(root,'pinned.bundle');const exported=unwrap(await createGitService(home,undefined,wrapper).forRepository(repoId).exportBundle(first.candidateRef,repo.baseSha,bundlePath,first.commit));assert.equal(exported.candidateSha,first.commit);assert.equal((await git(['--git-dir',repo.managedPath,'rev-parse',first.candidateRef])).trim(),second.commit);assert.equal((await git(['--git-dir',repo.managedPath,'bundle','list-heads',bundlePath])).trim(),first.commit+' '+first.candidateRef);
  const existing=Buffer.from('既存の利用者ファイル');const existingPath=join(root,'existing.bundle');await writeFile(existingPath,existing);const overwrite=await port.exportBundle(second.candidateRef,repo.baseSha,existingPath,second.commit);assert.equal(overwrite.ok,false);assert.deepEqual(await readFile(existingPath),existing);
});

for(const filter of ['clean','smudge','process'] as const)test(`sourceの${filter}/外部diff/textconvをimport・freeze・syncで実行しない`,async()=>{
  const {home,source,git,service,root}=await fixture();
  await writeFile(join(source,'.gitattributes'),'*.txt filter=evil diff=evil\n');await git(['-C',source,'add','--','.gitattributes']);await git(['-C',source,'commit','-m','外部変換を参照するfixture']);
  const marker=join(root,'external-command-ran');const command=join(root,'evil-command');await writeFile(command,`#!/bin/sh\n/usr/bin/touch '${marker}'\n/bin/cat\n`);await chmod(command,0o755);
  await git(['-C',source,'config',`filter.evil.${filter}`,command]);await git(['-C',source,'config','diff.evil.command',command]);await git(['-C',source,'config','diff.evil.textconv',command]);await git(['-C',source,'config','diff.external',command]);
  const originalIndex=await readFile(join(source,'.git','index'));const originalConfig=await readFile(join(source,'.git','config'));const originalHead=(await git(['-C',source,'rev-parse','HEAD'])).trim();
  // sizeが同じdirty変更でもGitの変換処理へ渡さない。
  await writeFile(join(source,'file.txt'),'evil\n');
  const repo=unwrap(await service.importRepository(source,repoId,'refs/heads/main'));await assert.rejects(readFile(marker),{code:'ENOENT'});const port=service.forRepository(repoId);const ws=workspace(home,repo.baseSha);unwrap(await port.createWorkspace(ws));await writeFile(join(ws.path,'file.txt'),'candidate\n');unwrap(await port.freezeSnapshot(ws,repo.baseSha,options));assert.equal(unwrap(await service.planSourceSync(repoId)).kind,'unchanged');
  await assert.rejects(readFile(marker),{code:'ENOENT'});assert.equal(await readFile(join(source,'file.txt'),'utf8'),'evil\n');assert.equal((await git(['-C',source,'rev-parse','HEAD'])).trim(),originalHead);assert.deepEqual(await readFile(join(source,'.git','index')),originalIndex);assert.deepEqual(await readFile(join(source,'.git','config')),originalConfig);
});
