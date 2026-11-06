import { mkdirSync, lstatSync, realpathSync, openSync, fsyncSync, closeSync, constants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

export function ensureDirectory(root:string,segments:string[]=[]):string {
  if(/[\0\n\r]/.test(root))throw new Error('INVALID_HOME_PATH');
  const absolute=resolve(root);
  mkdirSync(absolute,{recursive:true,mode:0o700});
  if(lstatSync(absolute).isSymbolicLink())throw new Error('HOME_SYMLINK_REJECTED');
  let current=realpathSync(absolute);
  for(const segment of segments) {
    if(!segment||segment==='.'||segment==='..'||/[\\/\0\n\r]/.test(segment))throw new Error('INVALID_PATH_SEGMENT');
    current=join(current,segment);
    let created=false;
    try{mkdirSync(current,{mode:0o700});created=true;}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='EEXIST'))throw error;}
    const stat=lstatSync(current);
    if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(current)!==current)throw new Error('DIRECTORY_SYMLINK_REJECTED');
    if(created){const fd=openSync(dirname(current),constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
  }
  return current;
}
