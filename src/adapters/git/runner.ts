import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface GitRunOptions { cwd?: string; env?: Record<string,string>; input?: string; timeoutMs?: number; maxOutputBytes?: number; encoding?:BufferEncoding }
export class GitFailure extends Error {
  constructor(public code:string, message:string, public stderr='') { super(message); }
}
export function createGitRunner(home:string, executable='/usr/bin/git') {
  if (!executable.startsWith('/') || /[\0\r\n]/.test(executable)) throw new GitFailure('INVALID_ARGUMENT','Git実行ファイルは信頼済み絶対パスが必要です');
  const neutral=join(home,'git-runtime');
  let ready:Promise<void>|undefined;
  return async (argv:string[], options:GitRunOptions={}):Promise<string> => {
    ready ??= (async()=>{ await mkdir(join(neutral,'hooks'),{recursive:true,mode:0o700}); await writeFile(join(neutral,'config'),'',{mode:0o600}); })();
    await ready;
    const fixed=['core.hooksPath='+join(neutral,'hooks'),'core.fsmonitor=false','core.pager=cat','core.sshCommand=false','credential.helper=','diff.external=','core.attributesFile=/dev/null','core.excludesFile=/dev/null','commit.gpgSign=false','tag.gpgSign=false','protocol.allow=never','maintenance.auto=false','gc.auto=0'];
    const env:NodeJS.ProcessEnv={PATH:'/usr/bin:/bin',HOME:neutral,LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(neutral,'config'),GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_ATTR_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Agent Workbench',GIT_AUTHOR_EMAIL:'local@agent-workbench.invalid',GIT_COMMITTER_NAME:'Agent Workbench',GIT_COMMITTER_EMAIL:'local@agent-workbench.invalid',...options.env};
    return new Promise((resolve,reject)=>{
      const child=spawn(executable,[...fixed.flatMap(v=>['-c',v]),...argv],{shell:false,detached:process.platform!=='win32',env,...(options.cwd?{cwd:options.cwd}:{}),stdio:['pipe','pipe','pipe']});
      const out:Buffer[]=[]; const err:Buffer[]=[]; let bytes=0; let failure:GitFailure|undefined;
      const terminate=()=>{if(process.platform!=='win32'&&child.pid){try{process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')child.kill('SIGKILL');}}else child.kill('SIGKILL');};
      const timer=setTimeout(()=>{failure=new GitFailure('GIT_TIMEOUT','Git処理が制限時間を超えました');terminate();},options.timeoutMs??30_000);
      const collect=(target:Buffer[]) => (chunk:Buffer)=>{ bytes+=chunk.length; if(bytes>(options.maxOutputBytes??16*1024*1024)){failure??=new GitFailure('GIT_OUTPUT_LIMIT','Git出力が上限を超えました');terminate();} else target.push(chunk); };
      child.stdout.on('data',collect(out));child.stderr.on('data',collect(err));
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{clearTimeout(timer);const stderr=Buffer.concat(err).toString('utf8');if(failure)reject(failure);else if(code!==0)reject(new GitFailure('GIT_FAILED','Git処理に失敗しました',stderr));else resolve(Buffer.concat(out).toString(options.encoding??'utf8'));});
      child.stdin.on('error',()=>{});child.stdin.end(options.input);
    });
  };
}
