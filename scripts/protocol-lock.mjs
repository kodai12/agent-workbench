import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const directory=path=>readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1).flatMap(e=>e.isDirectory()?directory(join(path,e.name)):[{path:relative(root,join(path,e.name)),digest:hash(readFileSync(join(path,e.name)))}]);
const lockPath=join(root,'protocol-lock.json');
const captures=directory(join(root,'src/generated'));
if(process.argv.includes('--record')){
 if(!['--codex','--herdr'].every(flag=>process.argv.includes(flag)&&process.argv[process.argv.indexOf(flag)+1]?.startsWith('/')))throw Error('両binaryの絶対pathを指定してください');
 const codex=resolve(process.argv[process.argv.indexOf('--codex')+1]??'');
 const herdr=resolve(process.argv[process.argv.indexOf('--herdr')+1]??'');
 const binary=path=>{const result=spawnSync(path,['--version'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME}});if(result.status!==0)throw Error('version取得失敗');return {version:result.stdout.trim(),binaryDigest:hash(readFileSync(path))};};
 writeFileSync(lockPath,JSON.stringify({schemaVersion:1,codex:binary(codex),herdr:binary(herdr),commands:['codex app-server generate-ts','codex app-server generate-json-schema','herdr api schema'],normalization:'scripts/normalize-generated.mjs',captures,liveVerified:false},null,2)+'\n');
}else{
 const lock=JSON.parse(readFileSync(lockPath,'utf8'));
 if(JSON.stringify(lock.captures)!==JSON.stringify(captures))throw Error('captureがlockと一致しません');
 console.log(JSON.stringify({ok:true,files:captures.length,liveVerified:false}));
}
