(() => {
"use strict";
const $ = id => document.getElementById(id);
const SYMBOL_MS = 10;                 // 100 symbols/second
const TONES = Array.from({length:16}, (_,i) => 900 + i*210);
const SAMPLE_RATE = 48000;
const PREAMBLE = [0,15,3,12,5,10,6,9,1,14,2,13,4,11,7,8,0,15,3,12,5,10,6,9,1,14,2,13,4,11,7,8];
const MAGIC = [86,70,88,50];          // "VFX2"
const MAX_BYTES = 2 * 1024 * 1024;
let prepared = null, sendStop = false, receiveStream = null, receiveContext = null, recorder = null, chunks = [];
let receiveStop = false;

function setStatus(id, message){ $(id).textContent = message; }
function crc32(bytes){
  let c = 0xffffffff;
  for(const b of bytes){ c ^= b; for(let k=0;k<8;k++) c = (c>>>1) ^ (0xedb88320 & -(c&1)); }
  return (c ^ 0xffffffff) >>> 0;
}
function concat(arrays){ const n=arrays.reduce((s,a)=>s+a.length,0), out=new Uint8Array(n); let p=0; for(const a of arrays){out.set(a,p);p+=a.length;} return out; }
function u32(n){return Uint8Array.of((n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255);}
function read32(a,p){return (((a[p]*0x1000000)+(a[p+1]<<16)+(a[p+2]<<8)+a[p+3])>>>0);}
function bytesToSymbols(bytes){
  const out=[];
  for(const b of bytes){out.push((b>>>4)&15,b&15);}
  return out;
}
function symbolsToBytes(syms){
  const out=new Uint8Array(Math.floor(syms.length/2));
  for(let i=0;i<out.length;i++) out[i]=(syms[i*2]<<4)|syms[i*2+1];
  return out;
}
function makePacket(data, name, type){
  const nameBytes = new TextEncoder().encode(name.slice(0,180));
  const typeBytes = new TextEncoder().encode(type.slice(0,100));
  const body = concat([Uint8Array.of(nameBytes.length),nameBytes,Uint8Array.of(typeBytes.length),typeBytes,u32(data.length),u32(crc32(data)),data]);
  return concat([Uint8Array.from(MAGIC),body]);
}
function toneSamples(symbol, durationMs=SYMBOL_MS, amplitude=.22){
  const n=Math.round(SAMPLE_RATE*durationMs/1000), f=TONES[symbol], a=new Float32Array(n);
  for(let i=0;i<n;i++){ const edge=Math.min(1,i/60,(n-1-i)/60); a[i]=amplitude*Math.max(0,edge)*Math.sin(2*Math.PI*f*i/SAMPLE_RATE); }
  return a;
}
function makeAudioBuffer(ctx, symbols){
  const lead = Math.round(SAMPLE_RATE*.55), tail=Math.round(SAMPLE_RATE*.35);
  const total=lead+symbols.length*Math.round(SAMPLE_RATE*SYMBOL_MS/1000)+tail;
  const b=ctx.createBuffer(1,total,SAMPLE_RATE), ch=b.getChannelData(0); let p=lead;
  for(const s of symbols){ const a=toneSamples(s); ch.set(a,p); p+=a.length; }
  return b;
}
async function prepareFile(file){
  if(file.type.startsWith("image/")){
    const bmp=await createImageBitmap(file);
    const scale=Math.min(1,1600/Math.max(bmp.width,bmp.height));
    const canvas=document.createElement("canvas"); canvas.width=Math.max(1,Math.round(bmp.width*scale)); canvas.height=Math.max(1,Math.round(bmp.height*scale));
    const c=canvas.getContext("2d"); c.drawImage(bmp,0,0,canvas.width,canvas.height); bmp.close();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",.78));
    return {blob,name:file.name.replace(/\.[^.]+$/,"")+".jpg",type:"image/jpeg"};
  }
  if(file.type==="application/pdf" || file.name.toLowerCase().endsWith(".pdf")) return {blob:file,name:file.name,type:"application/pdf"};
  throw new Error("Please choose a photo or PDF.");
}
function estimate(seconds){ if(!Number.isFinite(seconds))return "calculating…"; return seconds<60?`${Math.ceil(seconds)} seconds`:`${Math.ceil(seconds/60)} minutes`; }

$("fileInput").addEventListener("change",e=>{
  const f=e.target.files[0]; prepared=null; $("transmitBtn").disabled=true;
  $("fileInfo").textContent=f?`${f.name} · ${(f.size/1024).toFixed(1)} KB`:"No file selected";
  $("sendDetails").textContent="";
  setStatus("sendStatus","Ready to prepare.");
});
$("prepareBtn").addEventListener("click",async()=>{
  const f=$("fileInput").files[0]; if(!f){setStatus("sendStatus","Choose a file first.");return;}
  $("prepareBtn").disabled=true; setStatus("sendStatus","Preparing…");
  try{
    const p=await prepareFile(f); if(p.blob.size>MAX_BYTES) throw new Error("File is over the 2 MB limit. Choose a smaller file.");
    prepared={blob:p.blob,name:p.name,type:p.type};
    const symbols=PREAMBLE.length+bytesToSymbols(makePacket(new Uint8Array(p.blob.size),p.name,p.type)).length;
    const secs=symbols*SYMBOL_MS/1000;
    $("sendDetails").textContent=`Prepared: ${p.name} · ${(p.blob.size/1024).toFixed(1)} KB · estimated audio time: ${estimate(secs)} (plus a little setup time).`;
    $("transmitBtn").disabled=false; setStatus("sendStatus","Ready to transmit.");
  }catch(err){setStatus("sendStatus",err.message||"Could not prepare file.");}
  finally{$("prepareBtn").disabled=false;}
});
$("transmitBtn").addEventListener("click",async()=>{
  if(!prepared)return;
  $("transmitBtn").disabled=true; $("stopSendBtn").disabled=false; sendStop=false;
  let ctx;
  try{
    ctx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:SAMPLE_RATE});
    await ctx.resume();
    const data=new Uint8Array(await prepared.blob.arrayBuffer());
    const packet=makePacket(data,prepared.name,prepared.type);
    const symbols=PREAMBLE.concat(bytesToSymbols(packet));
    const buffer=makeAudioBuffer(ctx,symbols), source=ctx.createBufferSource();
    source.buffer=buffer; source.connect(ctx.destination);
    const started=performance.now(); source.start();
    setStatus("sendStatus",`Transmitting ${prepared.name}…`);
    await new Promise(resolve=>{
      source.onended=resolve;
      const timer=setInterval(()=>{
        if(sendStop){try{source.stop();}catch{} clearInterval(timer);resolve();return;}
        const pct=Math.min(99,((performance.now()-started)/(buffer.duration*1000))*100);
        $("sendProgress").style.width=pct+"%";
      },100);
    });
    $("sendProgress").style.width=sendStop?"0%":"100%";
    setStatus("sendStatus",sendStop?"Transmission stopped.":"Transmission finished. Check the receiving device.");
  }catch(err){setStatus("sendStatus","Audio error: "+(err.message||err));}
  finally{if(ctx)await ctx.close().catch(()=>{});$("transmitBtn").disabled=false;$("stopSendBtn").disabled=true;}
});
$("stopSendBtn").addEventListener("click",()=>{sendStop=true;});

function goertzelPower(samples, start, size, freq, sampleRate){
  const omega=2*Math.PI*freq/sampleRate, coeff=2*Math.cos(omega); let q0=0,q1=0,q2=0;
  for(let i=0;i<size;i++){const w=.5-.5*Math.cos(2*Math.PI*i/(size-1)); q0=samples[start+i]*w+coeff*q1-q2;q2=q1;q1=q0;}
  return q1*q1+q2*q2-coeff*q1*q2;
}
function detectSymbol(samples,start,size,sampleRate){
  let best=0,bestPower=-1;
  for(let i=0;i<TONES.length;i++){const p=goertzelPower(samples,start,size,TONES[i],sampleRate);if(p>bestPower){bestPower=p;best=i;}}
  return best;
}
function findPreamble(samples,sampleRate){
  const size=Math.round(sampleRate*SYMBOL_MS/1000), hop=Math.max(1,Math.floor(size/5));
  const maxStart=Math.min(samples.length-size*PREAMBLE.length,Math.round(sampleRate*12));
  for(let start=0;start<maxStart;start+=hop){
    let score=0;
    for(let j=0;j<PREAMBLE.length;j++) if(detectSymbol(samples,start+j*size,size,sampleRate)===PREAMBLE[j]) score++;
    if(score>=PREAMBLE.length-2) return start+PREAMBLE.length*size;
  }
  return -1;
}
async function decodeRecording(blob){
  const ctx=new (window.AudioContext||window.webkitAudioContext)();
  try{
    const ab=await blob.arrayBuffer(), decoded=await ctx.decodeAudioData(ab);
    const sampleRate=decoded.sampleRate, channels=[];
    for(let c=0;c<decoded.numberOfChannels;c++) channels.push(decoded.getChannelData(c));
    const mono=new Float32Array(decoded.length);
    for(const ch of channels) for(let i=0;i<mono.length;i++) mono[i]+=ch[i]/channels.length;
    setStatus("receiveStatus","Searching for VoiceFax signal…");
    const start=findPreamble(mono,sampleRate); if(start<0) throw new Error("No signal found. Keep the devices closer and try again.");
    const size=Math.round(sampleRate*SYMBOL_MS/1000);
    let pos=start, symbols=[];
    const readBytes=n=>{const need=n*2;while(symbols.length<need){if(pos+size>mono.length)throw new Error("Recording ended before the file was complete.");symbols.push(detectSymbol(mono,pos,size,sampleRate));pos+=size;}return symbolsToBytes(symbols.splice(0,need));};
    const magic=readBytes(4); if(!MAGIC.every((v,i)=>magic[i]===v)) throw new Error("Signal header not recognized.");
    const nl=readBytes(1)[0], name=new TextDecoder().decode(readBytes(nl));
    const tl=readBytes(1)[0], type=new TextDecoder().decode(readBytes(tl));
    const len=read32(readBytes(4),0), crc=read32(readBytes(4),0);
    if(len>MAX_BYTES)throw new Error("Incoming file exceeds the 2 MB limit.");
    const data=readBytes(len);
    if(crc32(data)!==crc)throw new Error("File check failed. Audio was too noisy; try again closer together.");
    return {data,name,type};
  }finally{await ctx.close().catch(()=>{});}
}
$("listenBtn").addEventListener("click",async()=>{
  $("listenBtn").disabled=true;$("stopListenBtn").disabled=false;$("downloadLink").classList.add("hidden");$("receiveProgress").style.width="0%";receiveStop=false;chunks=[];
  try{
    receiveStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    const mime=["audio/webm;codecs=opus","audio/webm","audio/mp4"].find(t=>MediaRecorder.isTypeSupported(t));
    recorder=new MediaRecorder(receiveStream,mime?{mimeType:mime}:undefined);
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    recorder.start(250);setStatus("receiveStatus","Listening. Start transmitting from the other device now.");
    recorder.onstop=async()=>{
      receiveStream.getTracks().forEach(t=>t.stop());receiveStream=null;
      if(receiveStop){setStatus("receiveStatus","Listening stopped.");return;}
      try{
        setStatus("receiveStatus","Decoding recording…");
        const result=await decodeRecording(new Blob(chunks,{type:recorder.mimeType}));
        const blob=new Blob([result.data],{type:result.type||"application/octet-stream"});
        const url=URL.createObjectURL(blob);$("downloadLink").href=url;$("downloadLink").download=result.name||"received-file";$("downloadLink").textContent="Download "+(result.name||"received file");$("downloadLink").classList.remove("hidden");
        $("receiveProgress").style.width="100%";setStatus("receiveStatus","File received and verified.");
      }catch(err){setStatus("receiveStatus",err.message||"Could not decode audio.");}
    };
  }catch(err){setStatus("receiveStatus","Microphone error: "+(err.message||err));$("listenBtn").disabled=false;$("stopListenBtn").disabled=true;}
});
$("stopListenBtn").addEventListener("click",()=>{
  receiveStop=true;
  if(recorder&&recorder.state!=="inactive")recorder.stop();
  else if(receiveStream)receiveStream.getTracks().forEach(t=>t.stop());
  $("listenBtn").disabled=false;$("stopListenBtn").disabled=true;
});
document.querySelectorAll(".tab").forEach(btn=>btn.addEventListener("click",()=>{
  document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b===btn));
  $("send").classList.toggle("hidden",btn.dataset.tab!=="send");$("receive").classList.toggle("hidden",btn.dataset.tab!=="receive");
}));
})();