/** Each take owns its tracks, meter and callbacks, including late permission grants. */
export function createRecorder({mediaDevices=navigator.mediaDevices, Recorder=globalThis.MediaRecorder, AudioContext=globalThis.AudioContext, changed, complete, error, maxMs=300_000}) {
  let current=null, preferred='', devices=[];
  const notify=()=>{
    const take=current,elapsed=take?.started?Date.now()-take.started:0;
    changed({active:!!take?.recorder,requesting:!!take?.requesting,elapsed,devices,
      deviceId:take?.track?.getSettings?.().deviceId||preferred,deviceLabel:take?.track?.label||'',
      level:take?.level||0,noSignal:!!take?.started&&elapsed>1500&&(take.track?.muted||take.meterSamples>0&&!take.hasSignal)});
  };
  const release=take=>{
    if(take.released)return;take.released=true;
    if(current===take){current=null;notify();}
    clearInterval(take.timer);take.source?.disconnect();take.analyser?.disconnect();
    void take.context?.close().catch(()=>{});
    take.stream?.getTracks().forEach(track=>track.stop());
  };
  return {
    get active(){return !!current;},
    async start(owner,deviceId=preferred) {
      if(current)return;
      if(!mediaDevices?.getUserMedia||!Recorder){error(new Error('此浏览器不支持录音，请使用 Chrome、Edge 或 Safari'));return;}
      preferred=deviceId;
      const take={owner,requesting:true,chunks:[],discard:false,level:0,hasSignal:false,meterSamples:0};current=take;notify();
      try {
        // Start the audio context in the click gesture, before awaiting permission.
        if(AudioContext){take.context=new AudioContext();void take.context.resume().catch(()=>{});}
        const stream=await mediaDevices.getUserMedia({audio:{...(deviceId?{deviceId:{exact:deviceId}}:{}),echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
        if(current!==take){stream.getTracks().forEach(track=>track.stop());return;}
        take.stream=stream;take.track=stream.getAudioTracks?.()[0]||stream.getTracks()[0];
        if(take.track?.readyState==='ended')throw new Error('麦克风已断开');
        if(take.context){take.source=take.context.createMediaStreamSource(stream);take.analyser=take.context.createAnalyser();take.analyser.fftSize=2048;take.source.connect(take.analyser);take.samples=new Float32Array(take.analyser.fftSize);}
        const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type=>Recorder.isTypeSupported(type));
        const recording=new Recorder(stream,{...(mime?{mimeType:mime}:{}),audioBitsPerSecond:64000});take.recorder=recording;
        recording.ondataavailable=e=>{if(e.data.size)take.chunks.push(e.data);};
        recording.onerror=()=>{take.discard=true;release(take);error(new Error('录音中断，请重试'));};
        recording.onstop=()=>{
          const noSignal=take.meterSamples>0&&!take.hasSignal;
          release(take);
          if(take.discard)return;
          if(noSignal||!take.chunks.length){error(new Error('没有录到声音，请检查麦克风是否静音，或切换输入设备后重录'));return;}
          const type=recording.mimeType.split(';')[0];
          complete(take.owner,new File(take.chunks,`语音.${type.includes('mp4')?'m4a':type.includes('ogg')?'oga':'weba'}`,{type}));
        };
        take.track?.addEventListener?.('ended',()=>{if(current!==take)return;take.discard=true;if(recording.state==='recording')recording.stop();else release(take);error(new Error('麦克风已断开，请重新选择输入设备'));},{once:true});
        recording.start(500);take.started=Date.now();take.requesting=false;
        take.timer=setInterval(()=>{
          if(take.context?.state==='running'){
            take.analyser.getFloatTimeDomainData(take.samples);
            const rms=Math.sqrt(take.samples.reduce((sum,value)=>sum+value*value,0)/take.samples.length);
            take.level=rms;take.meterSamples++;if(rms>=0.0001)take.hasSignal=true;
          }
          notify();if(Date.now()-take.started>=maxMs)this.stop();
        },100);
        notify();
        try{devices=(await mediaDevices.enumerateDevices?.()||[]).filter(device=>device.kind==='audioinput');if(current===take)notify();}catch{/* Recording still works when device enumeration is unavailable. */}
      }catch(e){
        if(current!==take)return;
        take.discard=true;release(take);
        error(new Error(e.name==='NotAllowedError'?'麦克风未获授权，请在 Chrome 网站设置中允许麦克风后重试':e.name==='NotFoundError'||e.name==='OverconstrainedError'?'未找到所选麦克风，请选择其他输入设备':'无法开始录音，请检查麦克风'));
      }
    },
    stop(){const take=current;if(!take)return;if(!take.recorder){this.cancel();return;}if(take.recorder.state==='recording')take.recorder.stop();},
    cancel(){const take=current;if(!take)return;take.discard=true;if(take.recorder?.state==='recording')take.recorder.stop();release(take);},
    async selectDevice(deviceId){const owner=current?.owner;preferred=deviceId;if(owner){this.cancel();await this.start(owner,deviceId);}},
  };
}
