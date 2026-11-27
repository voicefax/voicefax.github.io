(() => {
"use strict";
const $ = id => document.getElementById(id);
const fileInput=$("sendFile"), prepareBtn=$("prepare"), sendBtn=$("send");
const listenBtn=$("listen"), stopBtn=$("stop");
let sourceBytes=null, sourceName="received.bin", sourceType="application/octet-stream";
let preparedAudio=null, mediaStream=null, recorder=null, chunks=[], recording=false;
let audioContext=null;

const SAMPLE_RATE=48000;
const SYMBOL_MS=20;
const SYMBOL_SAMPLES=SAMPLE_RATE*SYMBOL_MS/1000; // 960 samples
const CARRIERS=128;
const BASE_HZ=650;
const SPACING_HZ=50;
const DATA_RATE=CARRIERS/(SYMBOL_MS/1000)/8; // theoretical raw bytes/sec
const MAGIC=[0x56,0x46,0x58,0x31]; // VFX1

function status(id,msg,kind="") { const el=$(id); el.textContent=msg; el.className="status "+kind; }
function crc32(bytes) {
 let c=0xffffffff;
 for (const b of bytes) { c^=b; for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0); }
 return (c^0xffffffff)>>>0;
}
function concat(arrays) {
 let n=arrays.reduce((s,a)=>s+a.length,0), out=new Uint8Array(n), p=0;
 for(const a of arrays){out.set(a,p);p+=a.length;} return out;
}
function u32(n){return new Uint8Array([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]);}
function read32(a,p){return (((a[p]<<24)|(a[p+1]<<16)|(a[p+2]<<8)|a[p+3])>>>0);}
function bytesToBits(bytes) {
 const bits=[];
 for(const b of bytes) for(let i=7;i>=0;i--) bits.push((b>>>i)&1);
 return bits;
}
function bitsToBytes(bits) {
 const out=new Uint8Array(Math.floor(bits.length/8));
 for(let i=0;i<out.length;i++){let v=0;for(let j=0;j<8;j++)v=(v<<1)|bits[i*8+j];out[i]=v;}
 return out;
}
function makeFrame(payload) {
 // Header: magic, filename length, MIME length, payload length, CRC, filename, MIME, payload
 const enc=new TextEncoder(), name=enc.encode(sourceName.slice(0,120)), type=enc.encode(sourceType.slice(0,120));
 const head=concat([new Uint8Array(MAGIC),new Uint8Array([name.length,type.length]),u32(payload.length),u32(crc32(payload)),name,type,payload]);
 return head;
}
function toneSymbol(bits, phaseSeed=0) {
 const out=new Float32Array(SYMBOL_SAMPLES);
 // BPSK on 128 simultaneous carriers. Per-carrier phase is fixed for this packet.
 for(let n=0;n<SYMBOL_SAMPLES;n++){
   const t=n/SAMPLE_RATE; let s=0;
   for(let k=0;k<CARRIERS;k++){
     const bit=bits[k]||0, phase=(bit?Math.PI:0)+(phaseSeed?((k%7)*0.001):0);
     s+=Math.cos(2*Math.PI*(BASE_HZ+k*SPACING_HZ)*t+phase);
   }
   out[n]=s/CARRIERS*0.82;
 }
 return out;
}
function buildAudio(frame) {
 const bits=bytesToBits(frame);
 const symbols=[];
 // Preamble: 6 known all-zero symbols, then one all-one calibration symbol.
 for(let i=0;i<6;i++) symbols.push(toneSymbol(new Array(CARRIERS).fill(0)));
 symbols.push(toneSymbol(new Array(CARRIERS).fill(1)));
 // Differentially encode each carrier by XOR with previous bit (BPSK phase flips).
 let prev=new Array(CARRIERS).fill(1);
 for(let p=0;p<bits.length;p+=CARRIERS){
   const group=bits.slice(p,p+CARRIERS); while(group.length<CARRIERS)group.push(0);
   const encoded=group.map((b,k)=>{const v=prev[k]^b;prev[k]=v;return v;});
   symbols.push(toneSymbol(encoded));
 }
 // End marker
 for(let i=0;i<4;i++) symbols.push(toneSymbol(new Array(CARRIERS).fill(i%2)));
 const total=symbols.length*SYMBOL_SAMPLES;
 const audio=new Float32Array(total);
 let pos=0;
 for(const s of symbols){audio.set(s,pos);pos+=s.length;}
 return audio;
}
function makeBlobAudio(samples) {
 const ctx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:SAMPLE_RATE});
 const buffer=ctx.createBuffer(1,samples.length,SAMPLE_RATE);
 buffer.copyToChannel(samples,0);
 return {ctx,buffer};
}
fileInput.addEventListener("change",()=>{
 const f=fileInput.files && fileInput.files[0];
 sourceBytes=null;preparedAudio=null;sendBtn.disabled=true;prepareBtn.disabled=!f;
 if(!f){status("fileInfo","No file selected.");return;}
 sourceName=f.name;sourceType=f.type||"application/octet-stream";
 $("fileInfo").textContent=`${f.name} · ${f.size.toLocaleString()} bytes`;
 $("sizeStat").textContent=`Size: ${f.size.toLocaleString()} bytes`;
 $("timeStat").textContent="Estimated audio: prepare first";
 status("sendStatus","File selected. Tap Prepare file.");
});
prepareBtn.addEventListener("click",async()=>{
 const f=fileInput.files&&fileInput.files[0]; if(!f)return;
 try{
   status("sendStatus","Reading and encoding file…");
   sourceBytes=new Uint8Array(await f.arrayBuffer());
   const frame=makeFrame(sourceBytes);
   const samples=buildAudio(frame);
   preparedAudio=makeBlobAudio(samples);
   const seconds=samples.length/SAMPLE_RATE;
   $("timeStat").textContent=`Estimated audio: ${seconds.toFixed(1)} sec`;
   sendBtn.disabled=false;
   status("sendStatus",`Prepared ${sourceBytes.length.toLocaleString()} bytes. Audio duration: ${seconds.toFixed(1)} seconds.`,"good");
 }catch(e){status("sendStatus",`Prepare failed: ${e.message}`,"bad");}
});
sendBtn.addEventListener("click",async()=>{
 if(!preparedAudio)return;
 try{
   sendBtn.disabled=true;
   await preparedAudio.ctx.resume();
   const src=preparedAudio.ctx.createBufferSource();src.buffer=preparedAudio.buffer;src.connect(preparedAudio.ctx.destination);
   src.onended=()=>{sendBtn.disabled=false;status("sendStatus","Playback finished. Check the receiving device.");};
   status("sendStatus","Transmitting audio…");
   src.start();
 }catch(e){sendBtn.disabled=false;status("sendStatus",`Playback failed: ${e.message}`,"bad");}
});
listenBtn.addEventListener("click",async()=>{
 try{
   chunks=[];
   mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
   recorder=new MediaRecorder(mediaStream);
   recorder.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data);};
   recorder.onstop=()=>{recording=false;mediaStream.getTracks().forEach(t=>t.stop());decodeRecording();};
   recorder.start(250);recording=true;
   listenBtn.disabled=true;stopBtn.disabled=false;
   status("receiveStatus","Listening. Start the sender now; stop after playback finishes.","good");
 }catch(e){status("receiveStatus",`Microphone unavailable: ${e.message}`,"bad");}
});
stopBtn.addEventListener("click",()=>{
 if(recorder&&recording){stopBtn.disabled=true;status("receiveStatus","Finishing recording…");recorder.stop();}
});
function goertzel(samples,offset,freq,rate) {
 const w=2*Math.PI*freq/rate, coeff=2*Math.cos(w);
 let q0=0,q1=0,q2=0;
 for(let i=0;i<SYMBOL_SAMPLES;i++){q0=coeff*q1-q2+samples[offset+i];q2=q1;q1=q0;}
 return q1*q1+q2*q2-coeff*q1*q2;
}
function decodeRecording(){
 (async()=>{
 try{
   const blob=new Blob(chunks,{type:recorder.mimeType||"audio/webm"});
   const ab=await blob.arrayBuffer();
   const ctx=new (window.AudioContext||window.webkitAudioContext)();
   const decoded=await ctx.decodeAudioData(ab);
   const rate=decoded.sampleRate, ch=decoded.numberOfChannels;
   const mono=new Float32Array(decoded.length);
   for(let c=0;c<ch;c++){const d=decoded.getChannelData(c);for(let i=0;i<d.length;i++)mono[i]+=d[i]/ch;}
   const sym=Math.round(rate*SYMBOL_MS/1000);
   const maxOffset=Math.min(sym,Math.max(0,mono.length-sym*12));
   // Find first high-energy region, then align to a 20ms boundary from onset.
   let onset=-1, window=Math.max(1,Math.floor(rate*0.004));
   for(let i=0;i<mono.length-window;i+=Math.floor(rate*0.002)){
     let e=0;for(let j=0;j<window;j++)e+=mono[i+j]*mono[i+j];
     if(e/window>0.00003){onset=i;break;}
   }
   if(onset<0)throw new Error("No audio signal detected. Check speaker volume and microphone.");
   // Find symbol alignment by maximizing the combined carrier correlation
   // in the known calibration symbol (symbol 6).
   let bestOffset=onset,bestScore=-Infinity;
   const step=Math.max(1,Math.floor(rate/6000));
   for(let off=0;off<maxOffset;off+=step){
     const start=onset+off+sym*6;
     if(start+sym>=mono.length)continue;
     let score=0;
     for(let k=0;k<CARRIERS;k+=2){
       let corr=0;const freq=BASE_HZ+k*SPACING_HZ;
       for(let n=0;n<sym;n++)corr+=mono[start+n]*Math.cos(2*Math.PI*freq*n/rate);
       score+=Math.abs(corr);
     }
     if(score>bestScore){bestScore=score;bestOffset=onset+off;}
   }
   // The calibration symbol measures the phase polarity introduced by the
   // speaker/microphone path separately for each carrier.
   const reference=[];
   for(let k=0;k<CARRIERS;k++){
     let corr=0;const freq=BASE_HZ+k*SPACING_HZ, start=bestOffset+sym*6;
     for(let n=0;n<sym;n++)corr+=mono[start+n]*Math.cos(2*Math.PI*freq*n/rate);
     reference[k]=corr<0?-1:1;
   }
   const bits=[], prev=new Array(CARRIERS).fill(1);
   let pos=bestOffset+sym*7;
   while(pos+sym<=mono.length){
     const current=[];
     for(let k=0;k<CARRIERS;k++){
       let corr=0;const freq=BASE_HZ+k*SPACING_HZ;
       for(let n=0;n<sym;n++)corr+=mono[pos+n]*Math.cos(2*Math.PI*freq*n/rate);
       current[k]=(corr*reference[k])<0?1:0;
     }
     for(let k=0;k<CARRIERS;k++){bits.push(prev[k]^current[k]);prev[k]=current[k];}
     pos+=sym;
   }
   const raw=bitsToBytes(bits);
   let found=-1;
   for(let i=0;i<Math.min(raw.length-14,200);i++){
     if(raw[i]===MAGIC[0]&&raw[i+1]===MAGIC[1]&&raw[i+2]===MAGIC[2]&&raw[i+3]===MAGIC[3]){found=i;break;}
   }
   if(found<0)throw new Error("Could not synchronize or find the VoiceFax header. Try again closer to the speaker.");
   let p=found+4;const nameLen=raw[p++],typeLen=raw[p++],len=read32(raw,p);p+=4;const crc=read32(raw,p);p+=4;
   const dec=new TextDecoder();const name=dec.decode(raw.slice(p,p+nameLen));p+=nameLen;
   const type=dec.decode(raw.slice(p,p+typeLen));p+=typeLen;
   if(len>raw.length-p)throw new Error("Recording ended before the complete file arrived.");
   const file=raw.slice(p,p+len);
   if(crc32(file)!==crc)throw new Error("File data arrived but its checksum does not match. This recording was corrupted.");
   const out=new Blob([file],{type:type||"application/octet-stream"});
   const url=URL.createObjectURL(out);const a=$("download");a.href=url;a.download=name||"voicefax-received.bin";a.textContent=`Download received file: ${name||"received file"} (${len.toLocaleString()} bytes)`;a.hidden=false;
   status("receiveStatus",`SUCCESS — reconstructed ${len.toLocaleString()} bytes. Checksum verified.`,"good");
   $("receiveMeter").style.width="100%";
   await ctx.close();
 }catch(e){status("receiveStatus",`Decode failed: ${e.message}`,"bad");}
 })();
}
$("sizeStat").textContent="Size: —";
})();