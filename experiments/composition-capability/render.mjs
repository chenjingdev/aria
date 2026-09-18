// Offline, fixed conversion. The tested model never sees or invokes Aria tools.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderRange } from '../../src/sampler-renderer.js';
import { wavBuffer } from '../../src/renderer.js';
import { midiBuffer } from '../../src/midi.js';
import { lufs } from '../../src/master.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=process.env.COMPOSITION_BENCH_OUT??path.join(root,'output/gpt-oss-20b-composition-2026-09-06');
const evaluations=JSON.parse(fs.readFileSync(path.join(out,'evaluation.json')));
for(const kind of ['shuffled','loop']){
  const folder=path.join(out,'controls',kind),file=path.join(folder,'evaluation.json');
  if(fs.existsSync(file)){
    const row=JSON.parse(fs.readFileSync(file));
    evaluations.push({...row,kind:'diagnostic_control',folder,renderBars:16});
  }
}
const normalized=path.join(out,'normalizations');
if(fs.existsSync(normalized))for(const name of fs.readdirSync(normalized)){
  const file=path.join(normalized,name,'evaluation.json');
  if(fs.existsSync(file))evaluations.push(JSON.parse(fs.readFileSync(file)));
}
const results=[];
for(const row of evaluations){
  if(!row.parsed || row.kind==='understanding' || !row.notes)continue;
  const folder=row.folder??path.join(out,'runs',row.id), songFile=path.join(folder,'render-song.json');
  const source=fs.readFileSync(songFile), hash=crypto.createHash('sha256').update(source).digest('hex');
  const metadataFile=path.join(folder,'audio.json');
  if(fs.existsSync(metadataFile)){
    const old=JSON.parse(fs.readFileSync(metadataFile));
    if(old.scoreSha256===hash && fs.existsSync(path.join(folder,'audio.mp3'))){results.push(old);continue;}
  }
  const song=JSON.parse(source);
  const lastBeat=Math.max(...song.tracks.flatMap(t=>t.notes.map(n=>(n.bar-1)*4+n.beat+n.dur)));
  const bars=Math.max(row.renderBars,Math.ceil(lastBeat/4));
  try{
    const pcm=renderRange(song,1,bars,{sampleRate:44100,tail:2.2,master:{comp:false,softClip:false,limiter:true}});
    const level=lufs(pcm.left,pcm.right,pcm.sr).integrated;
    if(!Number.isFinite(level))throw new Error('Silent output');
    let peak=0;for(let i=0;i<pcm.left.length;i++)peak=Math.max(peak,Math.abs(pcm.left[i]),Math.abs(pcm.right[i]));
    const desired=10**((-21-level)/20),gain=Math.min(desired,10**(-1/20)/peak);
    for(let i=0;i<pcm.left.length;i++){pcm.left[i]*=gain;pcm.right[i]*=gain;}
    fs.writeFileSync(path.join(folder,'audio.wav'),wavBuffer(pcm.left,pcm.right,pcm.sr));
    const wav=fs.readFileSync(path.join(folder,'audio.wav'));
    const {writeMp3}=await import('../../src/mp3.js');
    writeMp3(wav,path.join(folder,'audio.mp3'));
    fs.writeFileSync(path.join(folder,'score.mid'),midiBuffer(song));
    const result={id:row.id,kind:row.kind,scoreSha256:hash,preset:'sf-piano-gm',velocity:80,renderedBars:bars,duration:pcm.duration,
      lufs:lufs(pcm.left,pcm.right,pcm.sr).integrated,peakDb:20*Math.log10(peak*gain),
      modelScoreEdited:false,audioPath:path.join(folder,'audio.mp3')};
    fs.writeFileSync(metadataFile,JSON.stringify(result,null,2));results.push(result);
    console.log(`${row.id}: ${pcm.duration.toFixed(1)}s, ${result.lufs.toFixed(1)} LUFS`);
  }catch(error){results.push({id:row.id,error:error.message});console.log(`${row.id}: ${error.message}`);}
}
fs.writeFileSync(path.join(out,'audio-index.json'),JSON.stringify(results,null,2));
