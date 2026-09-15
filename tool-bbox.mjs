import { execFileSync } from 'node:child_process';
const FF='node_modules/ffmpeg-static/ffmpeg';
const FP='node_modules/ffprobe-static/bin/'+process.platform+'/'+process.arch+'/ffprobe';
for (const f of process.argv.slice(2)) {
  const [w,h]=execFileSync(FP,['-v','error','-show_entries','stream=width,height','-of','csv=p=0:s=x',f],{encoding:'utf8'}).trim().split('x').map(Number);
  const b=execFileSync(FF,['-v','error','-i',f,'-f','rawvideo','-pix_fmt','rgba','-'],{maxBuffer:w*h*4+9000});
  let x0=1e9,y0=1e9,x1=-1,y1=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){if(b[(y*w+x)*4+3]>32){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}}
  console.log(`${f.split('/').pop().padEnd(26)} ${w}x${h}  bbox x${x0}-${x1} (${x1-x0+1})  y${y0}-${y1} (${y1-y0+1})`);
}
