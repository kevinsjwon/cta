import { execFileSync } from 'node:child_process';
const FF='node_modules/ffmpeg-static/ffmpeg';
const FP='node_modules/ffprobe-static/bin/'+process.platform+'/'+process.arch+'/ffprobe';
const f=process.argv[2];
const [w,h]=execFileSync(FP,['-v','error','-show_entries','stream=width,height','-of','csv=p=0:s=x',f],{encoding:'utf8'}).trim().split('x').map(Number);
const b=execFileSync(FF,['-v','error','-i',f,'-f','rawvideo','-pix_fmt','rgba','-'],{maxBuffer:w*h*4+9000});
console.log(f,`${w}x${h}`);
for(const y of [0,2,5,10,20,30,50,80,120,160,200,260]){
  if(y>=h) break;
  const runs=[]; let s=-1;
  for(let x=0;x<w;x++){const a=b[(y*w+x)*4+3]>32;
    if(a&&s<0)s=x; if(!a&&s>=0){if(x-s>6)runs.push([s,x-1]); s=-1;}}
  if(s>=0)runs.push([s,w-1]);
  console.log(` y=${String(y).padStart(3)}  ${runs.map(r=>`${r[0]}-${r[1]}`).join('  ')}`);
}
