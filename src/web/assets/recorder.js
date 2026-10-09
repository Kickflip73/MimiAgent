/** One user-initiated recording; owns and releases every microphone track. */
export function createRecorder({mediaDevices=navigator.mediaDevices, Recorder=globalThis.MediaRecorder, changed, complete, error, maxMs=300_000}) {
  let stream, recorder, chunks=[], timer, started=0, session, requesting=false, generation=0, discard=false;
  const release=()=>{clearInterval(timer);stream?.getTracks().forEach(track=>track.stop());stream=null;};
  const notify=()=>changed({active:!!recorder,requesting,elapsed:started?Date.now()-started:0});
  return {
    get active(){return !!recorder||requesting;},
    async start(owner) {
      if(recorder||requesting)return;
      if(!mediaDevices?.getUserMedia||!Recorder){error(new Error('此浏览器不支持录音，请使用 Chrome、Edge 或 Safari'));return;}
      const current=++generation;requesting=true;notify();
      try {
        const acquired=await mediaDevices.getUserMedia({audio:true});
        if(current!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
        stream=acquired;session=owner;chunks=[];discard=false;
        const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type=>Recorder.isTypeSupported(type));
        recorder=new Recorder(stream,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:64000});
        const recording=recorder;
        recording.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
        recording.onerror=()=>{discard=true;release();recorder=null;notify();error(new Error('录音中断，请重试'));};
        recording.onstop=()=>{
          const owner=session,bytes=chunks,type=recording.mimeType.split(';')[0];
          release();recorder=null;started=0;notify();
          if(!discard&&bytes.length)complete(owner,new File(bytes,`语音.${type.includes('mp4')?'m4a':type.includes('ogg')?'oga':'weba'}`,{type}));
        };
        recording.start(500);started=Date.now();timer=setInterval(()=>{notify();if(Date.now()-started>=maxMs)this.stop();},250);
      }catch(e){release();recorder=null;started=0;error(new Error(e.name==='NotAllowedError'?'麦克风未获授权，请允许当前网站使用麦克风后重试':e.name==='NotFoundError'?'未找到麦克风设备':'无法开始录音，请检查麦克风'));}
      finally{requesting=false;notify();}
    },
    stop(){if(requesting&&!recorder){this.cancel();return;}if(recorder?.state==='recording')recorder.stop();},
    cancel(){generation++;requesting=false;discard=true;if(recorder?.state==='recording')recorder.stop();else release();notify();},
  };
}
