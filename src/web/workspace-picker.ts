import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
const execute=promisify(execFile);
let pending:Promise<{path:string|null}>|undefined;
export async function validateWorkspace(value:string) {
  if(!path.isAbsolute(value))throw new Error('工作区必须是绝对路径');
  const resolved=await realpath(value);
  if(!(await stat(resolved)).isDirectory())throw new Error('工作区必须是目录');
  return resolved;
}
export function chooseWorkspace():Promise<{path:string|null}> {
  if(process.platform!=='darwin')return Promise.reject(new Error('系统目录选择器目前支持 macOS'));
  pending??=execute('/usr/bin/osascript',['-e','tell application "Finder"\nactivate\nset selectedFolder to choose folder with prompt "选择 MimiAgent 工作区"\nreturn POSIX path of selectedFolder\nend tell'],{timeout:120_000,maxBuffer:8192}).then(async result=>({path:await validateWorkspace(result.stdout.trim())})).catch(error=>{if(String(error.stderr).includes('(-128)'))return {path:null};throw new Error('目录选择未完成，请重试');}).finally(()=>{pending=undefined;});
  return pending;
}
