import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../dist/test/',import.meta.url));
function collect(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?collect(join(dir,e.name)):e.name.endsWith('.test.js')?[join(dir,e.name)]:[]);}
const files=process.argv.slice(2).flatMap(group=>collect(join(root,group))).sort();
if(files.length===0){console.error('対象テストが0件です。');process.exit(2);}
console.log(`対象テストファイル: ${files.length}`);
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit'});
process.exitCode=result.status??1;
