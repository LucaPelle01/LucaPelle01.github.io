// Passive pigment on a finer grid. A limited predictor/corrector retains thin
// layers as the MAC velocity field folds and stretches them around the disk.
class Ink {
  constructor(flow, scale) {
    this.scale = scale;
    this.w = flow.nx * scale;
    this.h = flow.ny * scale;
    this.time = 0;
    const size = this.w * this.h;
    for (const field of ["dye", "predicted", "dx", "dy", "low", "high"]) {
      this[field] = new Float32Array(size);
    }
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        this.dye[x + y*this.w] = this.source((y+.5)/this.h, -x/(flow.inlet*scale));
      }
    }
  }

  reduceResolution(flow) {
    const next = new Ink(flow, 2);
    next.time = this.time;
    for (let y=0; y<next.h; y++) {
      for (let x=0; x<next.w; x++) {
        const k=2*x+2*y*this.w;
        next.dye[x+y*next.w]=.25*(this.dye[k]+this.dye[k+1]+this.dye[k+this.w]+this.dye[k+this.w+1]);
      }
    }
    return next;
  }

  extendInsideSolid(flow) {
    // Fill hidden samples from the nearest exposed pigment, so the retreating
    // disk uncovers liquid without leaving a circular stamp in the dye.
    const {w,h,scale,dye}=this;
    const cx=(flow.x-1)*scale-.5, cy=(flow.y-1)*scale-.5, r=flow.radius*scale;
    const left=Math.max(0,Math.floor(cx-r)), right=Math.min(w-1,Math.ceil(cx+r));
    const top=Math.max(0,Math.floor(cy-r)), bottom=Math.min(h-1,Math.ceil(cy+r));
    for (let y=top; y<=bottom; y++) {
      for (let x=left; x<=right; x++) {
        const vx=x-cx, vy=y-cy, d=Math.hypot(vx,vy);
        if(d>=r) continue;
        const sx=clamp(Math.round(cx+(d ? vx/d : 1)*(r+1.5)),0,w-1);
        const sy=clamp(Math.round(cy+(d ? vy/d : 0)*(r+1.5)),0,h-1);
        dye[x+y*w]=dye[sx+sy*w];
      }
    }
  }

  source(y, time) {
    // Slowly shifting ribbons of pigment at the inlet. All features downstream
    // are transported by the fluid; this function never drives its velocity.
    const z = y + .035*Math.sin(8*y + time*.011) + .019*Math.sin(17*y - time*.016);
    const ribbon = Math.exp(-((z-.47)**2)/.035);
    const broad = .5 + .5*Math.sin(32*z + 2.2*Math.sin(14*z) + .35*Math.sin(.021*time));
    const fine = .5 + .5*Math.sin(123*z + 4*Math.sin(28*z));
    const hair = .5 + .5*Math.sin(287*z + 6*Math.sin(33*z));
    return .04 + ribbon*(.12 + .48*broad*broad + .19*fine*fine + .09*hair);
  }

  step(flow, dt) {
    const {w,h,scale,dye,predicted,dx,dy,low,high} = this;
    this.time += dt;
    // Interpolate face velocities only at the ends of each grid-cell span.
    // Within a span, the two components are linear in x (separate half-cell offsets).
    for (let y=0; y<h; y++) {
      const fy=1+(y+.5)/scale;
      const sampleSpan=scale/2;
      for (let x=0; x<w; x+=sampleSpan) {
        const fx=1+(x+.5)/scale;
        let vx=flow.sample(flow.u,fx,fy-.5)*dt*scale;
        let vy=flow.sample(flow.v,fx-.5,fy)*dt*scale;
        const du=(flow.sample(flow.u,fx+.5,fy-.5)*dt*scale-vx)/sampleSpan;
        const dv=(flow.sample(flow.v,fx,fy)*dt*scale-vy)/sampleSpan;
        for (let n=0; n<sampleSpan; n++,vx+=du,vy+=dv) {
          const k=y*w+x+n;
          dx[k]=vx; dy[k]=vy;
          const sx=clamp(x+n-vx,0,w-1.001), sy=clamp(y-vy,0,h-1.001);
          const i=Math.floor(sx), j=Math.floor(sy), a=sx-i, b=sy-j;
          const p=i+j*w;
          const q0=dye[p], q1=dye[p+1], q2=dye[p+w], q3=dye[p+w+1];
          predicted[k]=(1-b)*(q0+a*(q1-q0))+b*(q2+a*(q3-q2));
          low[k]=Math.min(q0,q1,q2,q3);
          high[k]=Math.max(q0,q1,q2,q3);
        }
      }
    }
    for (let y=0; y<h; y++) {
      const source = flow.mode==="inflow" ? this.source((y+.5)/h,this.time) : 0;
      for (let x=0; x<w; x++) {
        const k=x+y*w;
        const sx=clamp(x+dx[k],0,w-1.001), sy=clamp(y+dy[k],0,h-1.001);
        const i=Math.floor(sx), j=Math.floor(sy), a=sx-i, b=sy-j, p=i+j*w;
        const reverse=(1-b)*(predicted[p]+a*(predicted[p+1]-predicted[p]))+
          b*(predicted[p+w]+a*(predicted[p+w+1]-predicted[p+w]));
        dye[k]=clamp(predicted[k]+.5*(dye[k]-reverse),low[k],high[k]);
        if(flow.mode==="inflow" && x < Math.max(1,dx[k])) dye[k]=source;
      }
    }
    this.extendInsideSolid(flow);
  }
}
