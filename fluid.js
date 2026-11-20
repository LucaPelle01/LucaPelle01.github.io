// Staggered MAC grid. Distances are in cells and velocities in cells per step.
// Fluid cells have centres (i + 1/2, j + 1/2); u and v live on their faces.
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));

class Fluid {
  constructor(nx, ny, mode) {
    this.nx = nx;
    this.ny = ny;
    this.stride = nx + 3;
    this.mode = mode;
    const size = this.stride * (ny + 3);
    for (const name of ["u", "v", "nextU", "nextV", "tmpU", "tmpV", "weight"]) this[name] = new Float32Array(size);
    this.open = new Uint8Array(size);
    this.radius = ny * .058;
    this.x = 1 + nx * .28;
    this.y = 1 + ny * .50;
    this.targetX = this.x;
    this.targetY = this.y;
    this.inlet = .72 * ny / 64;
    this.viscosity = .018 * (ny / 64) ** 2;
    if (mode === "inflow") this.u.fill(this.inlet);
    this.boundaries(0, 0);
  }
  sample(a, x, y) {
    x = clamp(x, 1, this.nx + .999);
    y = clamp(y, 1, this.ny + .999);
    const i = Math.floor(x), j = Math.floor(y);
    const sx = x - i, sy = y - j;
    const k = i + this.stride * j;
    const bottom = k + this.stride;
    return (1-sy) * (a[k] + sx*(a[k+1]-a[k])) +
      sy * (a[bottom] + sx*(a[bottom+1]-a[bottom]));
  }
  boundaries(bodyU, bodyV) {
    const {nx, ny, stride:s, open, u, v, weight, radius} = this;
    for (let j=1; j<=ny; j++) {
      for (let i=1; i<=nx; i++) {
        const dx=i+.5-this.x, dy=j+.5-this.y;
        open[i+j*s] = dx*dx+dy*dy >= radius*radius;
      }
      // Open outflow, prescribed inflow. The still tank is sealed on all sides.
      open[nx+1+j*s] = this.mode === "inflow";
      u[1+j*s] = this.mode === "inflow" ? this.inlet : 0;
      u[nx+1+j*s] = this.mode === "inflow" ? u[nx+j*s] : 0;
      v[nx+1+j*s] = v[nx+j*s];
    }
    for (let i=1; i<=nx+1; i++) {
      v[i+s] = 0;
      v[i+(ny+1)*s] = 0;
      u[i+(ny+1)*s] = u[i+ny*s];
    }
    for (let j=1; j<=ny; j++) {
      for (let i=1; i<=nx; i++) {
        const k=i+j*s;
        const free=open[k];
        if (i>1 && !(free && open[k-1])) u[k]=bodyU;
        if (j>1 && !(free && open[k-s])) v[k]=bodyV;
        const faces=open[k-1]+open[k+1]+open[k-s]+open[k+s];
        weight[k]=free && faces ? 1.72/faces : 0;
      }
    }
  }
  // Limit the corrected velocity to its source neighbourhood, then apply
  // the discrete Laplacian. Keep the old arrays intact until both components finish.
  correct(old,predicted,k,forwardX,forwardY,dt) {
    const s=this.stride;
    const reverse=this.sample(predicted,forwardX,forwardY);
    const left=old[k-1], right=old[k+1], up=old[k-s], down=old[k+s], center=old[k];
    const limited=clamp(predicted[k]+.5*(center-reverse),
      Math.min(left,right,up,down,center),Math.max(left,right,up,down,center));
    return limited+dt*this.viscosity*(left+right+up+down-4*center);
  }
  moveObstacle(dt) {
    const dx = this.targetX - this.x, dy = this.targetY - this.y;
    const length = Math.hypot(dx,dy);
    // Bound the impulse, never the pointer position. Long strokes affect the
    // entire swept disk even if the device delivered only two pointer samples.
    const scale = Math.min(1/dt, 2.7/Math.max(length,1e-6));
    const vx = dx*scale, vy = dy*scale;
    if (length > .5*this.radius) {
      const r = this.radius;
      const left = Math.max(1,Math.floor(Math.min(this.x,this.targetX)-r));
      const right = Math.min(this.nx,Math.ceil(Math.max(this.x,this.targetX)+r));
      const top = Math.max(1,Math.floor(Math.min(this.y,this.targetY)-r));
      const bottom = Math.min(this.ny,Math.ceil(Math.max(this.y,this.targetY)+r));
      for (let j=top; j<=bottom; j++) {
        for (let i=left; i<=right; i++) {
          const rx=i+.5-this.x, ry=j+.5-this.y;
          const t=clamp((rx*dx+ry*dy)/(length*length),0,1);
          const distance2=(rx-t*dx)**2+(ry-t*dy)**2;
          const mix=.82*Math.max(0,1-distance2/(r*r));
          const k=i+j*this.stride;
          this.u[k]+=(vx-this.u[k])*mix;
          this.v[k]+=(vy-this.v[k])*mix;
        }
      }
    }
    this.x=this.targetX;
    this.y=this.targetY;
    this.boundaries(vx,vy);
  }
  step(dt=1) {
    const {nx,ny,stride:s,u,v,nextU,nextV,open,weight} = this;
    // Explicit viscosity, semi-Lagrangian transport and a bounded
    // MacCormack correction to reduce numerical smearing of the wake.
    for (let j=1; j<=ny; j++) {
      for (let i=1; i<=nx; i++) {
        const k=i+j*s;
        const crossV=.25*(v[k]+v[k-1]+v[k+s]+v[k+s-1]);
        const crossU=.25*(u[k]+u[k+1]+u[k-s]+u[k-s+1]);
        nextU[k]=this.sample(u,i-dt*u[k],j-dt*crossV);
        nextV[k]=this.sample(v,i-dt*crossU,j-dt*v[k]);
      }
    }
    for (let j=1; j<=ny; j++) {
      let k=1+j*s;
      for (let i=1; i<=nx; i++,k++) {
        const cu=u[k], cv=v[k];
        const crossV=.25*(v[k]+v[k-1]+v[k+s]+v[k+s-1]);
        const crossU=.25*(u[k]+u[k+1]+u[k-s]+u[k-s+1]);
        this.tmpU[k]=this.correct(u,nextU,k,i+dt*cu,j+dt*crossV,dt);
        this.tmpV[k]=this.correct(v,nextV,k,i+dt*crossU,j+dt*cv,dt);
      }
    }
    this.u=this.tmpU; this.v=this.tmpV; this.tmpU=u; this.tmpV=v;

    this.moveObstacle(dt);

    // In-place SOR pressure projection. Each local pressure increment cancels
    // divergence by correcting only faces shared with another fluid cell.
    const U=this.u, V=this.v;
    for (let iteration=0; iteration<20; iteration++) {
      for (let j=1; j<=ny; j++) {
        for (let k=1+j*s, end=k+nx; k<end; k++) {
          const p=weight[k]*(U[k+1]-U[k]+V[k+s]-V[k]);
          U[k]+=p*open[k-1]; U[k+1]-=p*open[k+1];
          V[k]+=p*open[k-s]; V[k+s]-=p*open[k+s];
        }
      }
    }
  }
}

