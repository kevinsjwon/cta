import { execFileSync } from 'node:child_process';
const FF='node_modules/ffmpeg-static/ffmpeg';
const FP='node_modules/ffprobe-static/bin/'+process.platform+'/'+process.arch+'/ffprobe';
const [A,B]=process.argv.slice(2);
const [w,h]=execFileSync(FP,['-v','error','-show_entries','stream=width,height','-of','csv=p=0:s=x',A],{encoding:'utf8'}).trim().split('x').map(Number);
const rd=f=>execFileSync(FF,['-v','error','-i',f,'-f','rawvideo','-pix_fmt','rgba','-'],{maxBuffer:w*h*4+9000});
const a=rd(A), b=rd(B);
// 차이 픽셀을 라벨링해 덩어리별 bbox 를 낸다
const TH=40, seen=new Uint8Array(w*h), boxes=[];
const d=(i)=>Math.max(Math.abs(a[i*4]-b[i*4]),Math.abs(a[i*4+1]-b[i*4+1]),Math.abs(a[i*4+2]-b[i*4+2]),Math.abs(a[i*4+3]-b[i*4+3]));
for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const i=y*w+x; if(seen[i]||d(i)<=TH)continue;
  let x0=x,x1=x,y0=y,y1=y,n=0; const st=[i]; seen[i]=1;
  while(st.length){const p=st.pop(),px=p%w,py=(p-px)/w;n++;
    if(px<x0)x0=px; if(px>x1)x1=px; if(py<y0)y0=py; if(py>y1)y1=py;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
      const nx=px+dx,ny=py+dy; if(nx<0||ny<0||nx>=w||ny>=h)continue;
      const q=ny*w+nx; if(seen[q]||d(q)<=TH)continue; seen[q]=1; st.push(q);}}
  if(n>150) boxes.push({x0,y0,x1,y1,n});
}
boxes.sort((p,q)=>q.n-p.n);
console.log(`${A.split('/').pop()} vs ${B.split('/').pop()}  (${w}x${h})`);
for(const x of boxes.slice(0,8)) console.log(`   덩어리 ${String(x.n).padStart(7)}px  x${x.x0}-${x.x1}  y${x.y0}-${x.y1}`);
