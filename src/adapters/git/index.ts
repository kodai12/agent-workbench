import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, mkdir, readFile, writeFile, readdir, open, unlink, readlink, link } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GitPort, Result, WorkspaceRecord } from '../../../contracts/ports.js';
import { asError, ok } from '../../domain/errors.js';
import { digest as canonicalDigest } from '../../domain/canonical.js';
import {matchPattern} from '../../domain/paths.js';
export {matchPattern} from '../../domain/paths.js';
import { createGitRunner, GitFailure } from './runner.js';
import {syncDirectory} from '../filesystem/artifacts.js';

export interface ImportedRepository { repoId:string; sourcePath:string; commonDir:string; managedPath:string; objectFormat:'sha1'|'sha256'; baseSha:string; integrationRef:string; baseRef:string }
export interface SnapshotOptions { writerStopped:boolean; scope:{allow:string[];deny:string[]}; secretPaths?:string[]; candidateRef?:string; specDigest?:string; driver?:string; timestampSeconds?:number }
export interface ManifestFile {path:string;change:'added'|'modified'|'deleted';mode:string;blobOid:string;contentSha256:string;sizeBytes:number}
export interface Snapshot {commit:string;tree:string;manifest:{schemaVersion:1;baseSha:string;candidateSha:string;treeSha:string;files:ManifestFile[]};manifestDigest:string;candidateRef:string;binaryPaths:string[];lfsPaths:string[]}
function raise(code:string,message:string):never {throw new GitFailure(code,message);}
const checkedId=(id:string)=>{if(!/^[a-z]+_[0-9a-f]{32}$/.test(id))raise('INVALID_ARGUMENT','host生成IDが必要です');return id;};
const checkedOid=(oid:string)=>{if(!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))raise('INVALID_ARGUMENT','完全なGit OIDが必要です');return oid;};
const digest=(value:Uint8Array|string)=>'sha256:'+createHash('sha256').update(value).digest('hex');
async function result<T>(fn:()=>Promise<T>):Promise<Result<T>> {try{return ok(await fn());}catch(error){return {ok:false,error:asError(error)};}}
function safePath(path:string){if(!path||isAbsolute(path)||/[\\\0\r\n]/.test(path)||path.split('/').some(s=>!s||s==='.'||s==='..'))raise('PATH_OUTSIDE_SCOPE','安全な相対パスではありません');}

export function createGitService(home:string, repositoryId?:string, executable='/usr/bin/git') {
  home=resolve(home);
  const git=createGitRunner(home,executable);
  const managed=(id:string)=>join(home,'repos',checkedId(id)+'.git');
  const load=async(id:string):Promise<ImportedRepository>=>JSON.parse(await readFile(join(home,'repos',checkedId(id)+'.json'),'utf8')) as ImportedRepository;
  const sourceState=async(path:string,ref:string)=>{
    const head=(await git(['-C',path,'rev-parse','--verify','HEAD'])).trim();
    const base=(await git(['-C',path,'rev-parse','--verify',ref+'^{commit}'])).trim();
    // status/diffはsource側のclean filterを起動するため、indexと生bytesだけを観測する。
    const index=await git(['-C',path,'ls-files','--stage','-z']);
    const tracked=index.split('\0').filter(Boolean).map(entry=>entry.slice(entry.indexOf('\t')+1));
    const untracked=(await git(['-C',path,'ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
    const ignored=await git(['-C',path,'ls-files','--others','--ignored','--exclude-standard','-z']);
    const files=[];
    for(const name of [...new Set([...tracked,...untracked])].sort()){
      safePath(name);const absolute=join(path,name);
      const stat=await lstat(absolute).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(!stat){files.push({path:name,kind:'missing'});continue;}
      await assertInside(path,dirname(absolute));
      const kind=stat.isFile()?'file':stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':'special';
      const hash=kind==='file'?digest(await readNoFollow(absolute,path)):kind==='symlink'?digest(await readlink(absolute)):null;
      files.push({path:name,kind,mode:stat.mode,size:stat.size,hash});
    }
    return {head,base,index,ignored,files};
  };
  const refCheck=async(ref:string)=>{if(!ref.startsWith('refs/')||/[\0\r\n]/.test(ref))raise('INVALID_ARGUMENT','完全なref名が必要です');await git(['check-ref-format',ref]);};
  const forRepository=(id:string)=>{
    const path=managed(id); const cmd=(args:string[],opts:Parameters<typeof git>[1]={})=>git(['--git-dir',path,...args],opts);
    const verifyWorkspace=async(record:WorkspaceRecord)=>{
      const root=join(home,'workspaces');const rel=relative(root,record.path);
      if(!rel||rel.startsWith('..'+sep)||isAbsolute(rel)||/[\0\r\n]/.test(record.path))raise('PATH_OUTSIDE_SCOPE','workspace root外のパスです');
      if(await lstat(record.path).then(s=>s.isSymbolicLink(),e=>{if(e.code==='ENOENT')return false;throw e;}))raise('PATH_OUTSIDE_SCOPE','workspace自体がsymlinkです');
      let ancestor=dirname(record.path);while(ancestor!==home&&ancestor!==dirname(ancestor)){if(await lstat(ancestor).then(s=>s.isSymbolicLink(),e=>{if(e.code==='ENOENT')return false;throw e;}))raise('PATH_OUTSIDE_SCOPE','symlink経由のworkspaceです');ancestor=dirname(ancestor);}
    };
    const readRef=(ref:string)=>result(async()=>{await refCheck(ref);return checkedOid((await cmd(['rev-parse','--verify',ref+'^{commit}'])).trim());});
    const service={
      async createWorkspace(record:WorkspaceRecord):Promise<Result<void>> {return result(async()=>{
        await verifyWorkspace(record);checkedId(record.id);checkedId(record.taskId);checkedOid(record.baseSha);
        await mkdir(dirname(record.path),{recursive:true,mode:0o700});
        const exists=await lstat(record.path).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
        if(exists)raise('WORKSPACE_EXISTS','既存workspaceは自動再利用しません');
        if(record.role==='writer'){if(!record.branchRef?.startsWith('refs/heads/aw/tasks/'))raise('INVALID_ARGUMENT','writer branchが不正です');await refCheck(record.branchRef);await cmd(['worktree','add','-b',record.branchRef.slice(11),record.path,record.baseSha]);}
        else {if(record.branchRef!==null)raise('INVALID_ARGUMENT','検証workspaceはdetachedが必要です');await cmd(['worktree','add','--detach',record.path,record.baseSha]);}
        const common=await realpath((await git(['-C',record.path,'rev-parse','--path-format=absolute','--git-common-dir'])).trim());
        if(common!==await realpath(path)||(await git(['-C',record.path,'rev-parse','HEAD'])).trim()!==record.baseSha||(await git(['-C',record.path,'status','--porcelain=v1','-z'])))raise('WORKSPACE_MISMATCH','作成workspaceが予約内容と一致しません');
      });},
      readRef,
      async planSourceSync():Promise<Result<{kind:'unchanged'|'fast-forward'|'manual';currentSha:string;sourceSha:string}>>{return api.planSourceSync(id);},
      async compareAndSwapRef(ref:string,oldSha:string,newSha:string):Promise<Result<void>> {return result(async()=>{
        if(ref!==`refs/heads/aw/integration/${id}`)raise('INVALID_ARGUMENT','統合先refではありません');await refCheck(ref);checkedOid(oldSha);checkedOid(newSha);
        const parent=(await cmd(['rev-list','--parents','-n','1',newSha])).trim().split(' ');if(parent.length!==2||parent[1]!==oldSha)raise('BASE_MOVED','candidateの唯一parentが基点と一致しません');
        const worktrees=await cmd(['worktree','list','--porcelain','-z']);if(worktrees.split('\0').includes('branch '+ref))raise('REF_CHECKED_OUT','統合refがcheckoutされています');
        try{await cmd(['update-ref','-m','aw:integration',ref,newSha,oldSha]);}catch(error){if((await cmd(['rev-parse','--verify',ref])).trim()!==oldSha)raise('BASE_MOVED','統合refが移動しました');throw error;}
      });},
      async reconcileIntegration(ref:string,oldSha:string,newSha:string):Promise<Result<'applied'|'prepared'|'uncertain'>>{return result(async()=>{const current=await readRef(ref);if(!current.ok)throw current.error;return current.value===newSha?'applied':current.value===oldSha?'prepared':'uncertain';});},
      async freezeSnapshot(record:WorkspaceRecord,expectedBase:string,options?:SnapshotOptions):Promise<Result<Snapshot>> {return result(async()=>{
        if(!options?.writerStopped)raise('WRITER_NOT_STOPPED','writer停止確認が必要です');
        await verifyWorkspace(record);checkedOid(expectedBase);if(record.baseSha!==expectedBase)raise('BASE_MOVED','workspace予約基点が一致しません');
        const common=await realpath((await git(['-C',record.path,'rev-parse','--path-format=absolute','--git-common-dir'])).trim());if(common!==await realpath(path))raise('WORKSPACE_MISMATCH','workspaceがmanaged repoに属しません');
        const source=await load(id);const sourceBefore=await sourceState(source.sourcePath,source.baseRef);
        const before=await inspectFilesystem(record.path);
        const index=join(home,'git-runtime','index-'+randomUUID());const env={GIT_INDEX_FILE:index};
        try {
          await cmd(['--work-tree',record.path,'read-tree',expectedBase],{env});
          const tracked=new Set((await cmd(['ls-tree','-r','--name-only','-z',expectedBase])).split('\0').filter(Boolean));
          const ignored=new Set((await git(['-C',record.path,'ls-files','--others','--ignored','--exclude-standard','-z'])).split('\0').filter(Boolean));
          const baseFiles=new Map<string,{mode:string;hash:string}>();
          for(const entry of (await cmd(['ls-tree','-r','-z',expectedBase])).split('\0').filter(Boolean)){
            const tab=entry.indexOf('\t');const [mode,type,oid]=entry.slice(0,tab).split(' ');const name=entry.slice(tab+1);safePath(name);
            baseFiles.set(name,{mode:mode!,hash:type==='blob'?digest(Buffer.from(await cmd(['cat-file','blob',oid!],{encoding:'latin1'}),'latin1')):''});
          }
          const changedPaths=new Set<string>();
          for(const [name,file] of before){if(ignored.has(name)&&!tracked.has(name))continue;const old=baseFiles.get(name);const mode=file.mode&0o111?'100755':'100644';if(!old||old.hash!==file.hash||old.mode!==mode)changedPaths.add(name);}
          for(const name of tracked)if(!before.has(name))changedPaths.add(name);
          for(const name of changedPaths){if(baseFiles.get(name)?.mode==='160000')raise('UNSUPPORTED_GITLINK_CHANGE','submodule変更は未対応です');if(!options.scope.allow.some(p=>matchPattern(name,p))||options.scope.deny.some(p=>matchPattern(name,p)))raise('PATH_OUTSIDE_SCOPE','scope外の変更です: '+name);}
          const headEntries=(await git(['-C',record.path,'ls-tree','-r','-z','HEAD'])).split('\0').filter(Boolean);
          for(const entry of headEntries){const tab=entry.indexOf('\t');if(entry.startsWith('160000 ')&&baseFiles.get(entry.slice(tab+1))?.mode!=='160000')raise('UNSUPPORTED_GITLINK_CHANGE','writerが導入したgitlinkは未対応です');}
          const patterns=['**/.env','**/.env.*','**/*.pem','**/*.key',...(options.secretPaths??[])];
          const filesystemCase=new Set<string>();for(const name of before.keys()){const fold=name.toLowerCase();if(filesystemCase.has(fold))raise('PATH_OUTSIDE_SCOPE','case衝突があります');filesystemCase.add(fold);}
          for(const [name,file] of before){
            if(patterns.some(p=>matchPattern(name,p)))raise('SECRET_DETECTED','秘密情報名のファイルがあります: '+name);
            if(ignored.has(name)&&!tracked.has(name))continue;
            if(file.kind==='symlink')raise('PATH_OUTSIDE_SCOPE','symlinkは初版では候補に含められません: '+name);
            if(file.kind!=='file')raise('PATH_OUTSIDE_SCOPE','特殊ファイルは候補に含められません: '+name);
            if(file.size>10*1024*1024)raise('RESOURCE_LIMIT','単一ファイルが10MiBを超えています');
            const content=await readNoFollow(join(record.path,name),record.path);if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/.test(content.toString('utf8')))raise('SECRET_DETECTED','秘密情報パターンを検出しました: '+name);
          }
          // 製品内部のprivate indexだけを更新し、writerのindexを変更しない。
          await cmd(['--work-tree',record.path,'add','-A','--','.'],{env});
          const tree=checkedOid((await cmd(['write-tree'],{env})).trim());
          const changed=(await cmd(['diff-tree','--no-commit-id','--raw','--no-renames','-r','-z',expectedBase,tree])).split('\0');
          const files:ManifestFile[]=[];const binaryPaths:string[]=[];const lfsPaths:string[]=[];const folded=new Set<string>();
          for(let n=0;n<changed.length-1;n+=2){const header=changed[n]!;const name=changed[n+1]!;safePath(name);const fold=name.toLowerCase();if(folded.has(fold))raise('PATH_OUTSIDE_SCOPE','case衝突があります');folded.add(fold);
            if(!options.scope.allow.some(p=>matchPattern(name,p))||options.scope.deny.some(p=>matchPattern(name,p)))raise('PATH_OUTSIDE_SCOPE','scope外の変更です: '+name);
            const [oldMode,newMode,oldOid,newOid,status]=header.slice(1).split(' ');if(oldMode==='160000'||newMode==='160000')raise('UNSUPPORTED_GITLINK_CHANGE','submodule変更は未対応です');
            const deleted=status==='D';const oid=checkedOid((deleted?oldOid:newOid)!);const content=Buffer.from(await cmd(['cat-file','blob',oid],{encoding:'latin1'}),'latin1');
            if(content.includes(0))binaryPaths.push(name);if(content.toString().startsWith('version https://git-lfs.github.com/spec/v1'))lfsPaths.push(name);
            files.push({path:name,change:deleted?'deleted':status==='A'?'added':'modified',mode:(deleted?oldMode:newMode)!,blobOid:oid,contentSha256:digest(content),sizeBytes:content.length});
          }
          if(files.length>5000)raise('RESOURCE_LIMIT','変更ファイル数が5000を超えています');
          const stamp=options.timestampSeconds??Math.floor(Date.now()/1000);if(!Number.isSafeInteger(stamp)||stamp<0)raise('INVALID_ARGUMENT','commit日時が不正です');
          const commit=checkedOid((await cmd(['commit-tree',tree,'-p',expectedBase],{input:`aw snapshot ${record.taskId}\nspec: ${options.specDigest??'unspecified'}\ndriver: ${options.driver??'host'}\n`,env:{GIT_AUTHOR_DATE:`@${stamp} +0000`,GIT_COMMITTER_DATE:`@${stamp} +0000`}})).trim());
          const after=await inspectFilesystem(record.path);if(JSON.stringify([...before])!==JSON.stringify([...after]))raise('WORKSPACE_CHANGED','凍結中にworkspaceが変わりました');
          if(JSON.stringify(sourceBefore)!==JSON.stringify(await sourceState(source.sourcePath,source.baseRef)))raise('SOURCE_CHANGED','凍結中にsourceが変わりました');
          const candidateRef=options.candidateRef??`refs/aw/candidates/${record.taskId}/${randomUUID().replaceAll('-','')}`;if(!candidateRef.startsWith(`refs/aw/candidates/${record.taskId}/`))raise('INVALID_ARGUMENT','candidate refが不正です');await refCheck(candidateRef);
          await cmd(['update-ref',candidateRef,commit,'0'.repeat(commit.length)]);
          const manifest={schemaVersion:1 as const,baseSha:expectedBase,candidateSha:commit,treeSha:tree,files};
          return {commit,tree,manifest,manifestDigest:canonicalDigest(manifest),candidateRef,binaryPaths,lfsPaths};
        } finally {await unlink(index).catch(error=>{if(error.code!=='ENOENT')throw error;});}
      });},
      async exportBundle(candidateRef:string,base:string,bundlePath:string,expectedCandidateSha?:string):Promise<Result<{path:string;candidateRef:string;candidateSha:string;baseSha:string;sourceBaseRef:string}>> {return result(async()=>{
        await refCheck(candidateRef);if(!candidateRef.startsWith('refs/aw/candidates/'))raise('INVALID_ARGUMENT','candidate refではありません');checkedOid(base);if(!isAbsolute(bundlePath))raise('INVALID_ARGUMENT','bundleは絶対パスが必要です');
        const current=checkedOid((await cmd(['rev-parse','--verify',candidateRef+'^{commit}'])).trim());const expected=checkedOid(expectedCandidateSha??current);if(current!==expected)raise('CANDIDATE_IDENTITY_MISMATCH','export refが固定candidate SHAと一致しません');
        const repo=await load(id);const operation=randomUUID();const exporter=join(home,'git-runtime','bundle-export-'+operation+'.git');const temporaryBundle=join(home,'git-runtime','bundle-'+operation+'.tmp');
        await git(['init','--bare','--object-format='+repo.objectFormat,exporter]);
        // 可変refを再解決せず、固定OIDを独立repositoryへ取り込んでからbundle化する。
        await git(['-c','protocol.file.allow=always','--git-dir',exporter,'fetch','--no-tags','--no-write-fetch-head',path,expected+':'+candidateRef]);
        const bytes=Buffer.from(await git(['--git-dir',exporter,'bundle','create','-',candidateRef,'^'+base],{encoding:'latin1'}),'latin1');
        const temporary=await open(temporaryBundle,'wx',0o600);try{await temporary.writeFile(bytes);await temporary.sync();}finally{await temporary.close();}
        await git(['--git-dir',exporter,'bundle','verify',temporaryBundle]);
        const heads=(await git(['--git-dir',exporter,'bundle','list-heads',temporaryBundle])).trim().split('\n');if(heads.length!==1||heads[0]!==expected+' '+candidateRef)raise('CANDIDATE_IDENTITY_MISMATCH','bundleの公開refとcandidate SHAが一致しません');
        const verifier=join(home,'git-runtime','bundle-verify-'+operation+'.git');await git(['init','--bare','--object-format='+repo.objectFormat,verifier]);
        await git(['-c','protocol.file.allow=always','--git-dir',verifier,'fetch','--no-tags',path,base]);
        await git(['-c','protocol.file.allow=always','--git-dir',verifier,'fetch','--no-tags',temporaryBundle,candidateRef+':refs/aw/verified']);await git(['--git-dir',verifier,'fsck','--full','--no-reflogs']);
        if((await git(['--git-dir',verifier,'rev-parse','--verify','refs/aw/verified^{commit}'])).trim()!==expected)raise('CANDIDATE_IDENTITY_MISMATCH','検証用repositoryのcandidate SHAが一致しません');
        const staging=join(dirname(bundlePath),'.aw-bundle-'+operation+'.tmp');let staged=false;
        try{const handle=await open(staging,'wx',0o600);staged=true;try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}await link(staging,bundlePath);await syncDirectory(dirname(bundlePath));}
        finally{if(staged)await unlink(staging);}
        return {path:bundlePath,candidateRef,candidateSha:expected,baseSha:base,sourceBaseRef:repo.baseRef};
      });},
    } satisfies GitPort & Record<string,unknown>;
    return service;
  };
  const api={forRepository,
    async importRepository(sourcePath:string,repoId:string,baseRef:string):Promise<Result<ImportedRepository>> {return result(async()=>{
      checkedId(repoId);await refCheck(baseRef);sourcePath=await realpath(sourcePath);if(/[\0\r\n]/.test(sourcePath))raise('INVALID_ARGUMENT','source pathが不正です');
      const st=await lstat(sourcePath);if(!st.isDirectory()||st.uid!==process.getuid?.())raise('SOURCE_OWNERSHIP','source所有者が実行UIDと異なります');
      const commonDir=await realpath((await git(['-C',sourcePath,'rev-parse','--path-format=absolute','--git-common-dir'])).trim());if((await lstat(commonDir)).uid!==process.getuid?.())raise('SOURCE_OWNERSHIP','common dir所有者が異なります');
      const objectFormat=(await git(['-C',sourcePath,'rev-parse','--show-object-format'])).trim();if(objectFormat!=='sha1'&&objectFormat!=='sha256')raise('UNSUPPORTED_OBJECT_FORMAT','未対応object formatです');
      const before=await sourceState(sourcePath,baseRef);checkedOid(before.base);const managedPath=managed(repoId);await mkdir(dirname(managedPath),{recursive:true,mode:0o700});
      if(await lstat(managedPath).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))raise('REPOSITORY_EXISTS','既存managed repoは上書きしません');
      await git(['init','--bare','--object-format='+objectFormat,managedPath]);
      // source側のupload-pack設定を読ませない中立repositoryから、固定OIDだけをfetchする。
      const transfer=join(home,'git-runtime','transfer-'+randomUUID()+'.git');await git(['init','--bare','--object-format='+objectFormat,transfer]);await writeFile(join(transfer,'objects','info','alternates'),join(commonDir,'objects')+'\n');await git(['--git-dir',transfer,'update-ref','refs/heads/base',before.base]);
      await git(['-c','protocol.file.allow=always','--git-dir',managedPath,'fetch','--no-tags','--no-write-fetch-head',transfer,'refs/heads/base:refs/aw/source/base']);
      if((await git(['--git-dir',managedPath,'rev-parse','refs/aw/source/base'])).trim()!==before.base)raise('SOURCE_CHANGED','取得OIDがsource基点と異なります');
      const integrationRef=`refs/heads/aw/integration/${repoId}`;await git(['--git-dir',managedPath,'update-ref',integrationRef,before.base]);
      const after=await sourceState(sourcePath,baseRef);if(JSON.stringify(before)!==JSON.stringify(after))raise('SOURCE_CHANGED','import中にsource状態が変化しました');
      const record:ImportedRepository={repoId,sourcePath,commonDir,managedPath,objectFormat,baseSha:before.base,integrationRef,baseRef};await writeFile(join(home,'repos',repoId+'.json'),JSON.stringify(record),{flag:'wx',mode:0o600});return record;
    });},
    async planSourceSync(repoId:string):Promise<Result<{kind:'unchanged'|'fast-forward'|'manual';currentSha:string;sourceSha:string}>> {return result(async()=>{
      const repo=await load(repoId);const sourceSha=(await sourceState(repo.sourcePath,repo.baseRef)).base;const current=await forRepository(repoId).readRef(repo.integrationRef);if(!current.ok)throw current.error;if(current.value===sourceSha)return {kind:'unchanged',currentSha:current.value,sourceSha};
      // 未取得のsource objectをmanaged側へ暗黙導入しない。source側で祖先関係を読取確認する。
      let kind:'fast-forward'|'manual'='manual';try{await git(['-C',repo.sourcePath,'merge-base','--is-ancestor',current.value,sourceSha]);kind='fast-forward';}catch(error){if(!(error instanceof GitFailure))throw error;}
      return {kind,currentSha:current.value,sourceSha};
    });},
  };
  return repositoryId?Object.assign(api,forRepository(repositoryId)):api;
}

async function assertInside(root:string,path:string):Promise<void>{const actualRoot=await realpath(root);const actualPath=await realpath(path);const rel=relative(actualRoot,actualPath);if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))raise('PATH_OUTSIDE_SCOPE','open直前の親directoryがworkspace外です');}
async function readNoFollow(path:string,root:string):Promise<Buffer>{await assertInside(root,dirname(path));const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{return await handle.readFile();}finally{await handle.close();}}
async function inspectFilesystem(root:string):Promise<Map<string,{kind:string;size:number;hash:string;mode:number}>> {
  const files=new Map<string,{kind:string;size:number;hash:string;mode:number}>();
  async function walk(dir:string,prefix:string){await assertInside(root,dir);for(const entry of (await readdir(dir)).sort()){if(!prefix&&entry==='.git')continue;const name=prefix?prefix+'/'+entry:entry;safePath(name);const absolute=join(dir,entry);const st=await lstat(absolute);if(st.isDirectory()){if(await lstat(join(absolute,'.git')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))raise('UNSUPPORTED_GITLINK_CHANGE','入れ子repositoryは未対応です');await walk(absolute,name);}else {const kind=st.isSymbolicLink()?'symlink':st.isFile()?'file':'special';files.set(name,{kind,size:st.size,hash:kind==='file'?digest(await readNoFollow(absolute,root)):'',mode:st.mode});}}}
  await walk(root,'');return files;
}
