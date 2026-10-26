import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { runManagedCommand } from '../core/managed-process.js';

/** Inspect decoded 16-bit PCM, not container size: Opus encodes silence into valid files. */
export function assertAudioSignal(wav:Buffer):void {
  if(wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')throw new Error('语音音频格式无效');
  let rate=0,channels=0,format=0,bits=0,pcm:Buffer|undefined;
  for(let at=12;at+8<=wav.length;) {
    const name=wav.toString('ascii',at,at+4),size=wav.readUInt32LE(at+4),start=at+8;
    if(start+size>wav.length)throw new Error('语音音频不完整');
    if(name==='fmt '&&size>=16){format=wav.readUInt16LE(start);channels=wav.readUInt16LE(start+2);rate=wav.readUInt32LE(start+4);bits=wav.readUInt16LE(start+14);}
    if(name==='data')pcm=wav.subarray(start,start+size);
    at=start+size+(size%2);
  }
  if(format!==1||bits!==16||channels!==1||rate!==16000||!pcm)throw new Error('语音需要转换为 16kHz 单声道 PCM');
  // A conservative -80 dB floor catches digital silence, not ordinary quiet speech.
  const frame=320;let audible=0;
  for(let at=0;at+frame*2<=pcm.length;at+=frame*2){
    let energy=0;for(let i=0;i<frame;i++){const sample=pcm.readInt16LE(at+i*2)/32768;energy+=sample*sample;}
    if(Math.sqrt(energy/frame)>=0.0001)audible+=frame;
  }
  if(audible/rate<0.08)throw new Error('没有录到有效声音，请检查麦克风是否静音，或切换输入设备后重录');
}

let lane:Promise<unknown>=Promise.resolve();
/** A single short-lived CPU recognizer bounds memory; no resident model or cloud upload. */
export function transcribeAudio(root:string,file:string):Promise<string> {
  const job=lane.then(async()=>{
    assertAudioSignal(await readFile(file));
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
