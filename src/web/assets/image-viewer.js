/** A fitted image is the 1× baseline; zoom never changes its aspect ratio. */
export function bindImageViewer(dialog) {
  const image=dialog.querySelector('img'),stage=dialog.querySelector('.image-stage'),label=dialog.querySelector('[data-zoom-label]');
  let zoom=1,x=0,y=0,drag;
  function draw(){const w=stage.clientWidth,h=stage.clientHeight;const ratio=Math.min(w/(image.naturalWidth||w),h/(image.naturalHeight||h),1);const iw=image.naturalWidth*ratio,ih=image.naturalHeight*ratio;
    image.style.width=`${iw}px`;image.style.height=`${ih}px`;
    x=Math.max(-Math.max(0,(iw*zoom-w)/2),Math.min(Math.max(0,(iw*zoom-w)/2),x));y=Math.max(-Math.max(0,(ih*zoom-h)/2),Math.min(Math.max(0,(ih*zoom-h)/2),y));
    image.style.transform=`translate(${x}px,${y}px) scale(${zoom})`;label.textContent=`${Math.round(zoom*100)}%`;stage.classList.toggle('is-zoomed',zoom>1);
  }
  const reset=()=>{zoom=1;x=y=0;draw();};
  image.onload=reset;image.onerror=()=>{label.textContent='图片加载失败';};
  stage.addEventListener('wheel',event=>{event.preventDefault();const next=Math.max(1,Math.min(8,zoom*Math.exp(-event.deltaY*.002)));const box=stage.getBoundingClientRect(),px=event.clientX-box.left-box.width/2,py=event.clientY-box.top-box.height/2;x=px-(px-x)*next/zoom;y=py-(py-y)*next/zoom;zoom=next;draw();},{passive:false});
  stage.onpointerdown=event=>{if(event.button!==0)return;drag={x:event.clientX,y:event.clientY};stage.setPointerCapture(event.pointerId);};
  stage.onpointermove=event=>{if(!drag)return;x+=event.clientX-drag.x;y+=event.clientY-drag.y;drag={x:event.clientX,y:event.clientY};draw();};
  stage.onpointerup=stage.onpointercancel=()=>{drag=null;};stage.ondblclick=reset;
  dialog.querySelector('[data-image-close]').onclick=()=>dialog.close();dialog.querySelector('[data-image-fit]').onclick=reset;
  dialog.onclick=event=>{if(event.target===dialog)dialog.close();};
  new ResizeObserver(()=>{if(dialog.open)draw();}).observe(stage);
  return src=>{zoom=1;x=y=0;image.src=src;dialog.showModal();if(image.complete)draw();};
}
