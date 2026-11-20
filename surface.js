// Height is a display surface coupled to the horizontal incompressible flow.
// Its local slope selects the direction reflected into the viewer's eye.
class Surface {
  constructor(flow) {
    this.flow = flow;
    const size = flow.u.length;
    this.height = new Float32Array(size);
    this.speed = new Float32Array(size);
    this.nextHeight = new Float32Array(size);
    this.nextSpeed = new Float32Array(size);
    this.time = 0;
    this.carriedHeight = new Float32Array(size);
    this.carriedSpeed = new Float32Array(size);
  }

  stroke(x0, y0, x1, y1) {
    const f = this.flow;
    const dx = x1 - x0, dy = y1 - y0, length = Math.hypot(dx,dy);
    if (length < .001) return;
    const r = Math.max(2.1, f.radius * 1.4);
    const reach = 3*r;
    const pressure = Math.min(length,1.8)*.23;
    for(let j=Math.max(1,Math.floor(Math.min(y0,y1)-reach)); j<=Math.min(f.ny,Math.ceil(Math.max(y0,y1)+reach)); j++) {
      for(let i=Math.max(1,Math.floor(Math.min(x0,x1)-reach)); i<=Math.min(f.nx,Math.ceil(Math.max(x0,x1)+reach)); i++) {
        const rx=i+.5-x0, ry=j+.5-y0;
        const t=clamp((rx*dx+ry*dy)/(length*length),0,1);
        const ex=rx-dx*t, ey=ry-dy*t;
        // Depress the swept area. The open surface rises on each side of it.
        const d=(ex*ex+ey*ey)/(r*r);
        const k=i+j*f.stride;
        this.speed[k]=clamp(this.speed[k]+pressure*(d-1)*Math.exp(-d),-1.3,1.3);
      }
    }
  }

  step(dt) {
    const f=this.flow, s=f.stride, h=this.height, v=this.speed;
    let peak=0;
    this.time+=dt;
    const damping=Math.exp(-.12*dt);
    // Transport both fields first. The wave stencil must use neighbours
    // from this same transported state, including during fast sweeps.
    const ch=this.carriedHeight, cv=this.carriedSpeed;
    for(let j=1;j<=f.ny;j++) {
      for(let i=1;i<=f.nx;i++) {
        const k=i+j*s;
        const sx=clamp(i-.5*(f.u[k]+f.u[k+1])*dt,1,f.nx);
        const sy=clamp(j-.5*(f.v[k]+f.v[k+s])*dt,1,f.ny);
        ch[k]=f.sample(h,sx,sy);
        cv[k]=f.sample(v,sx,sy);
      }
    }
    for(let j=1;j<=f.ny;j++) {
      for(let i=1;i<=f.nx;i++) {
        const k=i+j*s;
        const left=i===1?k:k-1, right=i===f.nx?k:k+1;
        const top=j===1?k:k-s, bottom=j===f.ny?k:k+s;
        const carried=ch[k];
        const curvature=ch[left]+ch[right]+ch[top]+ch[bottom]-4*carried;
        const lapV=cv[left]+cv[right]+cv[top]+cv[bottom]-4*cv[k];
        let force=.35*curvature+.11*lapV-.024*carried;
        if(f.mode==="inflow" && i<=3) {
          force+=.014*Math.sin(.09*this.time+.12*j)*Math.sin(Math.PI*j/f.ny);
        }
        const speed=damping*(cv[k]+dt*force);
        this.nextSpeed[k]=speed;
        this.nextHeight[k]=clamp(carried+dt*speed,-3,3);
        peak=Math.max(peak,Math.abs(speed),Math.abs(this.nextHeight[k]));
      }
    }
    this.height=this.nextHeight; this.nextHeight=h;
    this.speed=this.nextSpeed; this.nextSpeed=v;
    return peak;
  }
}

// A grayscale studio environment sampled by reflection. A large softbox, a
// dark panel and a side light produce continuous specular reflections on metal.
class Mercury {
  constructor(canvas, flow, width, height) {
    this.ctx=canvas.getContext("2d",{alpha:false});
    const density=Math.min(1.5,window.devicePixelRatio||1);
    this.w=canvas.width=Math.round(width*density);
    this.h=canvas.height=Math.round(height*density);
    this.image=this.ctx.createImageData(this.w,this.h);
    this.pixels=new Uint32Array(this.image.data.buffer);
    this.lightMap=new Uint8Array(256*256);
    for(let j=0;j<256;j++) {
      for(let i=0;i<256;i++) {
        const x=(i-127.5)/85, y=(j-127.5)/85;
        const horizon=y-.14*x+.08*x*x;
        const sky=1/(1+Math.exp(-9*(horizon+.14)));
        const softbox=Math.exp(-(((horizon-.45)/.19)**2));
        const side=Math.exp(-(((x+.82)/.28)**2+((y+.02)/.87)**2));
        const strip=Math.exp(-(((horizon+.68)/.075)**2));
        this.lightMap[i+256*j]=Math.min(255,29+125*sky+92*softbox+126*side+78*strip);
      }
    }
    const count=this.w*this.h;
    this.baseX=new Float32Array(count);
    this.baseY=new Float32Array(count);
    this.cell=new Uint16Array(count);
    this.fx=new Float32Array(this.w);
    this.fy=new Float32Array(this.h);
    // Static meniscus around the shallow tray, including its rounded corners.
    for(let j=0;j<this.h;j++) {
      for(let i=0;i<this.w;i++) {
        const k=i+j*this.w, x=(i+.5)/this.w, y=(j+.5)/this.h;
        const gx=clamp(.5+x*flow.nx,1,flow.nx-.001), gy=clamp(.5+y*flow.ny,1,flow.ny-.001);
        this.cell[k]=Math.floor(gx)+Math.floor(gy)*flow.stride;
        this.fx[i]=gx-Math.floor(gx); this.fy[j]=gy-Math.floor(gy);
        const a=2*x-1, b=2*y-1;
        const rimX=Math.sign(a)*Math.pow(Math.abs(a),16)*.78;
        const rimY=Math.sign(b)*Math.pow(Math.abs(b),10)*.75;
        this.baseX[k]=127.5+85*(.55*a+rimX+.16*b);
        this.baseY[k]=127.5+85*(.70*b+.24*a*a-.20*a+rimY);
      }
    }
    this.normalX=new Float32Array(flow.u.length);
    this.normalY=new Float32Array(flow.u.length);
  }

  draw(flow,surface) {
    const s=flow.stride, h=surface.height, sx=this.normalX, sy=this.normalY;
    for(let j=1;j<=flow.ny;j++) {
      for(let i=1;i<=flow.nx;i++) {
        const k=i+j*s;
        sx[k]=83*(h[i===1?k:k-1]-h[i===flow.nx?k:k+1]);
        sy[k]=83*(h[j===1?k:k-s]-h[j===flow.ny?k:k+s]);
      }
    }
    for(let j=0;j<this.h;j++) {
      const b=this.fy[j];
      for(let i=0;i<this.w;i++) {
        const k=i+j*this.w, p=this.cell[k], q=p+s, a=this.fx[i];
        const w0=(1-a)*(1-b), w1=a*(1-b), w2=(1-a)*b, w3=a*b;
        const ex=clamp(this.baseX[k]+sx[p]*w0+sx[p+1]*w1+sx[q]*w2+sx[q+1]*w3,0,255)|0;
        const ey=clamp(this.baseY[k]+sy[p]*w0+sy[p+1]*w1+sy[q]*w2+sy[q+1]*w3,0,255)|0;
        const value=this.lightMap[ex+256*ey];
        this.pixels[k]=0xff000000 | value*0x010101;
      }
    }
    this.ctx.putImageData(this.image,0,0);
  }
}
