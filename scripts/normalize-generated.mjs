import {readdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../src/generated/codex/',import.meta.url));
function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else if(path.endsWith('.ts')){const text=readFileSync(path,'utf8');const imports=[...text.matchAll(/\bfrom "(\.[^"]+)"/g)];let next=text;for(const match of imports.reverse()){const raw=match[1].endsWith('.js')?match[1].slice(0,-3):match[1];const replacement=existsSync(resolve(dirname(path),raw,'index.ts'))?raw+'/index.js':raw+'.js';if(replacement!==match[1]){const offset=match.index+match[0].indexOf(match[1]);next=next.slice(0,offset)+replacement+next.slice(offset+match[1].length);}}if(next!==text)writeFileSync(path,next);}}}
walk(root);
