import {cpSync,mkdirSync,existsSync} from 'node:fs';
for(const name of ['contracts','src/generated']){const source=new URL('../'+name+'/',import.meta.url);if(existsSync(source)){mkdirSync(new URL('../dist/'+name+'/',import.meta.url),{recursive:true});cpSync(source,new URL('../dist/'+name+'/',import.meta.url),{recursive:true});}}
for(const group of ['unit','integration','contract','chaos'])mkdirSync(new URL('../dist/test/'+group+'/',import.meta.url),{recursive:true});
if(existsSync(new URL('../protocol-lock.json',import.meta.url)))cpSync(new URL('../protocol-lock.json',import.meta.url),new URL('../dist/protocol-lock.json',import.meta.url));
