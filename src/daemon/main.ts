import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {defaultHome} from '../adapters/os/paths.js';
import {createWorkbench} from '../application/workbench.js';
import {asError} from '../domain/errors.js';
import {startServer} from './server.js';
try {
  const {values}=parseArgs({options:{home:{type:'string'}},strict:true});
  const home=resolve(values.home??defaultHome()),server=await startServer(home,()=>createWorkbench(home));
  let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;void server.close().catch(error=>{console.error(JSON.stringify(asError(error)));process.exitCode=1;});};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}catch(error){console.error(JSON.stringify(asError(error)));process.exitCode=1;}
