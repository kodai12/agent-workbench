import {cpSync,mkdirSync} from 'node:fs';
for(const path of ['contracts','src/generated']){mkdirSync(new URL('../dist/'+path+'/',import.meta.url),{recursive:true});cpSync(new URL('../'+path+'/',import.meta.url),new URL('../dist/'+path+'/',import.meta.url),{recursive:true});}
cpSync(new URL('../protocol-lock.json',import.meta.url),new URL('../dist/protocol-lock.json',import.meta.url));
