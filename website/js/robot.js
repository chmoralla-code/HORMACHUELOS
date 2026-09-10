/* HORMACHUELOS robotic skin — ambient particle field + HUD status, no interference with app.js */
(function(){
  // background neural field
  var cv=document.getElementById('rbg');if(!cv||!cv.getContext)return;
  var css='#rbg{position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;opacity:.55}';
  var st=document.createElement('style');st.textContent=css;document.head.appendChild(st);
  var ctx=cv.getContext('2d'),W=0,H=0,pts=[],over=false;
  function size(){W=cv.width=cv.offsetWidth;H=cv.height=cv.offsetHeight;}
  size();addEventListener('resize',size);
  for(var i=0;i<70;i++)pts.push({x:Math.random(),y:Math.random(),vx:(Math.random()-.5)*.002,vy:(Math.random()-.5)*.002,r:Math.random()*1.6+.5});
  (function field(){
    ctx.clearRect(0,0,W,H);
    for(var k=0;k<pts.length;k++){var p=pts[k];p.x+=p.vx;p.y+=p.vy;
      if(p.x<0||p.x>1)p.vx*=-1;if(p.y<0||p.y>1)p.vy*=-1;}
    var m=W*.10;
    for(var i=0;i<pts.length;i++)for(var j=i+1;j<pts.length;j++){
      var dx=(pts[i].x-pts[j].x)*W,dy=(pts[i].y-pts[j].y)*H,d=Math.sqrt(dx*dx+dy*dy);
      if(d<m){ctx.strokeStyle='rgba(200,255,46,'+((1-d/m)*.28)+')';ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(pts[i].x*W,pts[i].y*H);ctx.lineTo(pts[j].x*W,pts[j].y*H);ctx.stroke();}}
    ctx.fillStyle='#C8FF2E';
    pts.forEach(function(p){ctx.beginPath();ctx.arc(p.x*W,p.y*H,p.r,0,7);ctx.fill();});
    requestAnimationFrame(field);
  })();
  // HUD clock + ping in eyebrow area: append a small live chip to header actions once
  var n=0,timer=setInterval(function(){
    n++;var ha=document.getElementById('header-actions');
    if(ha&&!document.getElementById('rhud')){
      var s=document.createElement('span');
      s.id='rhud';s.className='mono small';
      s.style.cssText='color:#C8FF2E;border:1px solid #26302B;padding:6px 10px;border-radius:2px;letter-spacing:1px;font-size:.7rem';
      ha.prepend(s);
    }
    var hud=document.getElementById('rhud');
    if(hud){var d=new Date();hud.textContent='● CORE '+d.toLocaleTimeString('en-GB')+' · '+(8+Math.floor(Math.random()*14))+'MS';}
    if(n>3&&hud)clearInterval(timer);
  },800);
})();
