import { access } from 'node:fs/promises';
import path from 'node:path';
import { runManagedCommand } from '../core/managed-process.js';

let lane:Promise<unknown>=Promise.resolve();
/** A single short-lived CPU recognizer bounds memory; no resident model or cloud upload. */
export function transcribeAudio(root:string,file:string):Promise<string> {
  const job=lane.then(async()=>{
    let binary=process.env.MIMI_WHISPER_BIN;
    if(!binary)for(const candidate of ['/opt/homebrew/bin/whisper-cli','/usr/local/bin/whisper-cli','/usr/bin/whisper-cli'])try{await access(candidate);binary=candidate;break;}catch{/* Next installation. */}
    const model=process.env.MIMI_WHISPER_MODEL||path.join(root,'models','ggml-base.bin');
    if(!binary)throw new Error('请安装 whisper.cpp 以启用本机语音识别');
    try{await access(model);}catch{throw new Error('缺少语音识别模型，请配置 MIMI_WHISPER_MODEL');}
    const result=await runManagedCommand(binary,['-m',model,'-f',file,'-l','auto','-t','2','-ng','-nt','-np'],{timeoutMs:120_000});
    const text=result.stdout.trim();
    if(!text)throw new Error('没有识别到清晰语音，请重录或重试');
    return text.slice(0,20000);
  });lane=job.catch(()=>{});return job;
}
