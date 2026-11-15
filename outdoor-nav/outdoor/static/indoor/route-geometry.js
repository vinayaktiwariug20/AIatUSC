// M1 geometry only: rigid arrows on the supplied M3 polyline; never change its path.
export function sampleRoute(route,distance) {
  const d=Math.max(0,Math.min(distance,route.length));
  let low=0,high=route.cum.length-1;
  while(low+1<high){const middle=(low+high)>>1;if(route.cum[middle]<d)low=middle;else high=middle;}
  const span=route.cum[high]-route.cum[low],fraction=span>0?(d-route.cum[low])/span:0;
  return {point:route.pts[low].map((v,c)=>v+(route.pts[high][c]-v)*fraction),index:low};
}

export function buildRouteGeometry(route,{halfWidth=.045,arrowHalfWidth=.06,arrowLength=.48,spacing=1.2,lift=.07,isWalkable=()=>true}={}) {
  const ribbon={positions:[],indices:[]},arrows={positions:[],indices:[]},placements=[];
  const clearance=index=>Math.max(0,route.clearances?.[Math.min(index,route.clearances.length-1)]??.15);
  function valid(points,extraLift=0) {
    const floor=points.map(p=>[p[0],p[1]-lift-extraLift,p[2]]);
    if(!isWalkable([...floor,floor[0]]))return false;
    for(const [a,b,c] of [[floor[0],floor[1],floor[2]],[floor[0],floor[2],floor[3]]]) {
      const n=Math.max(1,Math.ceil(Math.max(Math.hypot(...a.map((v,i)=>b[i]-v)),Math.hypot(...a.map((v,i)=>c[i]-v)))/.075));
      for(let i=0;i<=n;i++)for(let j=0;j<=n-i;j++) {
        const p=a.map((v,k)=>v+(b[k]-v)*i/n+(c[k]-v)*j/n);
        if(!isWalkable([p,p]))return false;
      }
    }
    return true;
  }
  function quad(output,points){const base=output.positions.length/3;points.forEach(p=>output.positions.push(...p));output.indices.push(base,base+1,base+2,base,base+2,base+3);}
  for(let i=0;i<route.pts.length-1;i++) {
    const a=route.pts[i],b=route.pts[i+1],dx=b[0]-a[0],dz=b[2]-a[2],horizontal=Math.hypot(dx,dz);
    if(horizontal<1e-9)continue;
    const width=Math.min(halfWidth,clearance(i)*.3,clearance(i+1)*.3),sx=dz/horizontal*width,sz=-dx/horizontal*width;
    const points=[[a[0]-sx,a[1]+lift,a[2]-sz],[b[0]-sx,b[1]+lift,b[2]-sz],[b[0]+sx,b[1]+lift,b[2]+sz],[a[0]+sx,a[1]+lift,a[2]+sz]];
    if(valid(points))quad(ribbon,points);
  }
  for(let distance=arrowLength;distance+arrowLength/2<route.length;distance+=spacing) {
    const start=sampleRoute(route,distance-arrowLength/2),end=sampleRoute(route,distance+arrowLength/2),center=sampleRoute(route,distance);
    const axis=end.point.map((v,c)=>v-start.point[c]),length=Math.hypot(...axis),horizontal=Math.hypot(axis[0],axis[2]);
    if(length<arrowLength*.97||horizontal<1e-6)continue;
    const tangent=axis.map(v=>v/length),side=[axis[2]/horizontal,0,-axis[0]/horizontal];
    // Skip bends rather than stretching or rotating one arrow across a corner.
    let straight=true,minClearance=Infinity;
    for(let i=start.index;i<=Math.min(end.index+1,route.pts.length-2);i++) {
      const a=route.pts[i],b=route.pts[i+1],delta=b.map((v,c)=>v-a[c]),n=Math.hypot(...delta);
      if(n&&delta.reduce((sum,v,c)=>sum+v*tangent[c],0)/n<.94)straight=false;
      minClearance=Math.min(minClearance,clearance(i),clearance(i+1));
    }
    if(!straight)continue;
    const width=Math.min(arrowHalfWidth,minClearance*.35),stroke=width*.38;
    const local=(x,z)=>center.point.map((v,c)=>v+side[c]*x+tangent[c]*z+(c===1?lift+.006:0));
    const tip=local(0,arrowLength/2),inner=local(0,arrowLength/2-stroke*2);
    const left=[local(-width,-arrowLength/2),tip,inner,local(-width+stroke,-arrowLength/2)];
    const right=[tip,local(width,-arrowLength/2),local(width-stroke,-arrowLength/2),inner];
    if(!valid(left,.006)||!valid(right,.006))continue;
    quad(arrows,left);quad(arrows,right);
    placements.push({distance,point:center.point,tangent,halfWidth:width,length:arrowLength,clearance:minClearance});
  }
  return {ribbon,arrows,placements};
}
