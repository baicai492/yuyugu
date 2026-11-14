// 大肥鱼修仙记 · 弹幕斗法（东方式纵版）。鼠标：角色跟随指针移动，按住左键 = 低速（显示判定点），右键/双击 = 符卡。
// 手机：拖动移动（手指和角色保持相对位置），左下「慢」按住低速，右下「符」放符卡。键盘方向键 / Shift / X 也可以。
// 只在前端判定；服务端只认「起止时间 ≥ 关卡下限」和符卡收取数上限，结算见 rules.js win/lose。
import {h} from './ui.js?v=20b20a0e';
const W=384,H=512,TAU=Math.PI*2;
// ---------------- 子弹贴图（预渲染） ----------------
const PAL={red:['#ff4040','#ffd0d0'],orange:['#ff9a30','#ffe6c0'],yellow:['#ffe040','#fffbd0'],green:['#50e070','#d8ffe0'],cyan:['#40e0ff','#d8faff'],blue:['#4070ff','#d8e2ff'],purple:['#b050ff','#f0dcff'],pink:['#ff60c0','#ffe0f2'],white:['#e0e0e0','#ffffff']};
const SIZE={rice:[12,6,3],orb:[10,10,4],big:[28,28,11],star:[14,14,4.5],knife:[20,7,3],talis:[14,9,3.5],fly:[16,14,4],heart:[16,16,5],ice:[18,6,2.5],small:[7,7,2.5]};
const cache=new Map();
function bulletImg(type,color){const k=type+'|'+color;if(cache.has(k))return cache.get(k);const[w,hh]=SIZE[type],c=document.createElement('canvas'),S=2;c.width=(w+6)*S;c.height=(hh+6)*S;const g=c.getContext('2d');g.scale(S,S);g.translate((w+6)/2,(hh+6)/2);const[col,core]=PAL[color]||PAL.white;
 g.shadowColor=col;g.shadowBlur=4;g.fillStyle=col;g.strokeStyle=col;
 const ell=(rx,ry,f)=>{g.beginPath();g.ellipse(0,0,rx,ry,0,0,TAU);g.fillStyle=f;g.fill()};
 if(type==='rice'){ell(w/2,hh/2,col);g.shadowBlur=0;ell(w/2-2,hh/2-1.6,core)}
 else if(type==='orb'||type==='small'){ell(w/2,hh/2,col);g.shadowBlur=0;ell(w/2-2,hh/2-2,core)}
 else if(type==='big'){const gr=g.createRadialGradient(0,0,2,0,0,w/2);gr.addColorStop(0,'#fff');gr.addColorStop(.45,core);gr.addColorStop(.8,col);gr.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=gr;g.beginPath();g.arc(0,0,w/2,0,TAU);g.fill()}
 else if(type==='star'){g.beginPath();for(let i=0;i<10;i++){const r=i%2?w/4.5:w/2,a=i*Math.PI/5-Math.PI/2;g.lineTo(Math.cos(a)*r,Math.sin(a)*r)}g.closePath();g.fill();g.shadowBlur=0;g.fillStyle=core;g.beginPath();g.arc(0,0,w/6,0,TAU);g.fill()}
 else if(type==='knife'){g.beginPath();g.moveTo(w/2,0);g.lineTo(-w/4,-hh/2);g.lineTo(-w/2,0);g.lineTo(-w/4,hh/2);g.closePath();g.fill();g.shadowBlur=0;g.fillStyle=core;g.fillRect(-w/4,-1,w*.6,2)}
 else if(type==='talis'){g.fillRect(-w/2,-hh/2,w,hh);g.shadowBlur=0;g.fillStyle=core;g.fillRect(-w/2+2,-hh/2+2,w-4,hh-4);g.fillStyle=col;g.fillRect(-w/6,-hh/2+2,w/3,hh-4)}
 else if(type==='fly'){g.shadowBlur=0;for(const s of[-1,1]){g.beginPath();g.ellipse(-1,s*hh/4,w/2.4,hh/3.2,s*.5,0,TAU);g.fillStyle=col;g.fill()}ell(w/3,2,core)}
 else if(type==='heart'){g.beginPath();g.moveTo(0,hh/2.5);g.bezierCurveTo(-w/2,0,-w/3,-hh/2,0,-hh/5);g.bezierCurveTo(w/3,-hh/2,w/2,0,0,hh/2.5);g.fill();g.shadowBlur=0;g.fillStyle=core;g.beginPath();g.arc(-w/8,-hh/8,2.5,0,TAU);g.fill()}
 else if(type==='ice'){g.beginPath();g.moveTo(w/2,0);g.lineTo(0,-hh/2);g.lineTo(-w/2,0);g.lineTo(0,hh/2);g.closePath();g.fill();g.shadowBlur=0;g.fillStyle=core;g.fillRect(-w/3,-.8,w*.6,1.6)}
 cache.set(k,c);return c}
const wrapText=(t,n)=>{const out=[];for(let i=0;i<t.length;i+=n)out.push(t.slice(i,i+n));return out.slice(0,4)};
const itemCache={};function itemImg(k){if(itemCache[k])return itemCache[k];const c=document.createElement('canvas');c.width=c.height=20;const g=c.getContext('2d');g.fillStyle=k==='p'?'#ff4050':'#4080ff';g.fillRect(2,2,16,16);g.fillStyle='#fff';g.font='bold 13px system-ui';g.textAlign='center';g.textBaseline='middle';g.fillText(k==='p'?'P':'点',10,11);return itemCache[k]=c}
// ---------------- 功法（自机射击 + 符卡） ----------------
const SHOT={
 fire:{n:5,spread:.5,fs:.18,sp:560,dmg:1,rate:.07,c:'orange',t:'rice'},water:{n:2,spread:.25,fs:.1,sp:460,dmg:1.15,rate:.08,c:'cyan',t:'orb',home:1},
 wood:{n:7,spread:.9,fs:.3,sp:480,dmg:.7,rate:.08,c:'green',t:'rice'},metal:{n:2,spread:.06,fs:.02,sp:720,dmg:1.9,rate:.06,c:'yellow',t:'knife'},
 earth:{n:3,spread:.35,fs:.12,sp:400,dmg:2.4,rate:.13,c:'orange',t:'big'},ice:{n:4,spread:.3,fs:.08,sp:640,dmg:1.25,rate:.07,c:'cyan',t:'ice'},
 thunder:{n:3,spread:.2,fs:.05,sp:820,dmg:1.5,rate:.07,c:'purple',t:'knife'},wind:{n:9,spread:1.1,fs:.4,sp:620,dmg:.6,rate:.06,c:'green',t:'small'},
 lava:{n:5,spread:.45,fs:.15,sp:520,dmg:1.35,rate:.08,c:'red',t:'orb'},poison:{n:3,spread:.5,fs:.2,sp:380,dmg:1.1,rate:.08,c:'green',t:'fly',home:1},
};
const BOMB_COLOR={fire:'#ff8030',water:'#40c0ff',wood:'#60e070',metal:'#ffe060',earth:'#c08040',ice:'#a0f0ff',thunder:'#c070ff',wind:'#90ffc0',lava:'#ff5020',poison:'#80ff40'};
// ---------------- 关卡 ----------------
// 敌人路径：p(t) → [x,y]；shoot(e,dt,api)；用 api.every(e,'k',间隔,fn) 控制节奏
const L=(x0,y0,x1,y1,dur)=>t=>{const k=Math.min(1,t/dur);return[x0+(x1-x0)*k,y0+(y1-y0)*k]};
const ENTER=(x,y,stay,exit)=>t=>t<1?[x,-30+(y+30)*easeOut(t)]:t<1+stay?[x+Math.sin((t-1)*1.5)*10,y]:[x+(exit||0)*(t-1-stay)*120,y-(t-1-stay)*90];
const easeOut=k=>1-(1-k)*(1-k);
const CURVE=(side,y,amp)=>t=>[side<0?-30+t*150:W+30-t*150,y+Math.sin(t*2)*amp];
function stageDefs(api){const{ring,fan,aim,P,every,rain,spiral,laser,flower}=api;
 return{
 secret:{bg:'secret',boss:{sheet:'en-fox',size:110,name:'三尾妖狐'},particles:'leaf',talk:{start:'哪来的胖鱼，也敢闯本狐的竹林？',phases:[null,'看好了——九盏狐火，一盏一条命！',null,'真真假假，你分得清哪个是我吗？','尾巴都烧起来了……陪你玩到底！'],down:'呜……下次、下次一定吃掉你！'},waves:[
  [1.5,()=>{for(let i=0;i<6;i++)api.enemy({sheet:'en-bat',hp:6,delay:i*.35,path:CURVE(-1,80+i*8,20),shoot:(e)=>every(e,'a',1.2,()=>fan(e.x,e.y,aim(e),3,.25,150,'rice','red'))})}],
  [6,()=>{for(let i=0;i<6;i++)api.enemy({sheet:'en-bat',hp:6,delay:i*.35,path:CURVE(1,110+i*8,20),shoot:(e)=>every(e,'a',1.2,()=>fan(e.x,e.y,aim(e),3,.25,150,'rice','pink'))})}],
  [11,()=>{for(const x of[96,192,288])api.enemy({sheet:'en-spider',hp:40,path:ENTER(x,110,5,x<192?-1:1),shoot:(e)=>every(e,'a',.9,()=>ring(e.x,e.y,14,110,'orb','green',e.t))})}],
  [19,()=>{for(let i=0;i<10;i++)api.enemy({sheet:'en-bat',hp:5,delay:i*.3,path:t=>[40+((i*67)%300)+Math.sin(t*3)*30,-30+t*110],shoot:(e)=>every(e,'a',1.5,()=>fan(e.x,e.y,aim(e),1,0,180,'rice','red'))})}],
  [26,()=>{for(const x of[130,254])api.enemy({sheet:'en-spider',hp:70,path:ENTER(x,120,7,x<192?-1:1),shoot:(e)=>{every(e,'a',.12,()=>spiral(e,2,1.9,120,'rice','yellow'));every(e,'b',1.6,()=>fan(e.x,e.y,aim(e),5,.5,170,'orb','red'))}})}],
  [36,()=>api.startBoss()]],
  phases:[
   {name:null,hp:420,time:30,f:(b)=>{every(b,'a',1,()=>{fan(b.x,b.y,aim(b),7,.9,160,'orb','red');ring(b.x,b.y,24,95,'rice','orange',b.t)})}},
   {name:'狐火「九尾灯笼」',hp:520,time:40,f:(b)=>{every(b,'a',.5,()=>{for(let i=0;i<9;i++){const a=b.t*.9+i*TAU/9;api.bullet({x:b.x,y:b.y,a,sp:140,acc:-110,min:0,t:0,type:'big',c:'orange',re:1.1,reSp:120})}});every(b,'m',3,()=>b.goto(W/2+(Math.random()-.5)*160,90+Math.random()*40))}},
   {name:null,hp:420,time:30,f:(b)=>{every(b,'a',.12,()=>spiral(b,3,2.3,130,'rice','pink'));every(b,'b',1.4,()=>fan(b.x,b.y,aim(b),5,.35,200,'orb','red'));every(b,'c',.5,()=>api.bullet({x:b.x,y:b.y,a:Math.PI/2+(Math.random()-.5)*2,sp:170,type:'big',c:'orange',bounce:3}))}},
   {name:'幻术「千面狐」',hp:560,time:45,f:(b)=>{every(b,'a',1.1,()=>flower(b.x,b.y,16,120,'fly','purple',1.2));every(b,'c',2.3,()=>{for(let i=0;i<3;i++)api.enemy({sheet:'en-fox',size:48,hp:12,alpha:.55,reflect:1,path:L(b.x,b.y,40+Math.random()*300,60+Math.random()*120,1),shoot:(e)=>every(e,'a',.9,()=>fan(e.x,e.y,aim(e),3,.3,150,'heart','pink'))})});every(b,'m',4,()=>b.goto(80+Math.random()*224,80+Math.random()*50))}},
   {name:'妖狐「天狐烈焰」',hp:700,time:55,f:(b)=>{every(b,'a',.05,()=>spiral(b,5,1.3,110,'rice','orange'));every(b,'r',.18,()=>rain('orb','red',90+Math.random()*60));every(b,'b',2.5,()=>ring(b.x,b.y,36,80,'big','yellow',Math.random()))}}]},
 demon:{bg:'demon',boss:{sheet:'boss-demonlord',size:130,cols:6,name:'魔修长老'},particles:'ash',dark:[3,4],talk:{start:'正道小辈，送上门来给老夫炼魂幡？',phases:[null,'血河倒卷，看你往哪儿躲！','有点意思……再接我一招。','万魂幡下，皆是亡魂！','不惜此身——天魔解体！'],down:'正道……竟出了这等人物……'},waves:[
  [1.5,()=>{for(let i=0;i<8;i++)api.enemy({sheet:'en-bat',hp:9,delay:i*.3,path:CURVE(i%2?1:-1,70+i*14,30),shoot:(e)=>every(e,'a',1,()=>fan(e.x,e.y,aim(e),3,.3,170,'rice','purple'))})}],
  [8,()=>{for(const x of[80,192,304])api.enemy({sheet:'en-cultist',hp:80,path:ENTER(x,110,6,x<192?-1:1),shoot:(e)=>{every(e,'a',.15,()=>spiral(e,2,-2.2,120,'talis','red'));every(e,'b',1.3,()=>ring(e.x,e.y,18,90,'orb','purple',Math.random()))}})}],
  [17,()=>{for(let i=0;i<14;i++)api.enemy({sheet:'en-bat',hp:8,delay:i*.22,path:t=>[(i%2?W-30:30)+(i%2?-1:1)*t*90,40+t*80],shoot:(e)=>every(e,'a',.8,()=>fan(e.x,e.y,aim(e),1,0,200,'knife','red'))})}],
  [25,()=>{api.enemy({sheet:'en-cultist',size:80,hp:260,path:ENTER(192,120,10,0),shoot:(e)=>{every(e,'a',.6,()=>flower(e.x,e.y,20,110,'talis','red',.9));every(e,'b',2,()=>laser(e.x,e.y,aim(e),.7,1))}})}],
  [37,()=>api.startBoss()]],
  phases:[
   {name:null,hp:700,time:30,f:(b)=>{every(b,'a',.9,()=>{for(let k=-2;k<=2;k++)fan(b.x,b.y,aim(b)+k*.5,3,.08,150+Math.abs(k)*20,'talis','red')})}},
   {name:'魔符「血河倒卷」',hp:850,time:45,f:(b)=>{every(b,'a',.06,()=>{const a=Math.sin(b.t*1.1)*1.4+Math.PI/2;api.bullet({x:b.x,y:b.y,a,sp:170,type:'rice',c:'red',w:Math.sin(b.t)*.5});api.bullet({x:b.x,y:b.y,a:Math.PI-a,sp:170,type:'rice',c:'red',w:-Math.sin(b.t)*.5})});every(b,'b',1.8,()=>fan(b.x,b.y,aim(b),9,1.2,130,'big','purple'))}},
   {name:null,hp:700,time:30,f:(b)=>{every(b,'a',1.6,()=>{for(let i=0;i<5;i++)laser(40+i*76,30,Math.PI/2+(Math.random()-.5)*.25,.9,.9)});every(b,'b',.14,()=>spiral(b,4,1.7,120,'orb','purple'));every(b,'c',1.1,()=>api.bullet({x:b.x,y:b.y,a:aim(b)+(Math.random()-.5)*.6,sp:120,type:'big',c:'red',split:{t:1.1,n:12,sp:150,type:'rice',c:'red'}}))}},
   {name:'魔功「万魂幡」',hp:900,time:50,f:(b)=>{every(b,'L',.7,()=>api.bullet({x:Math.random()*W,y:-10,a:Math.PI/2,sp:70,type:'big',c:'yellow',lamp:1}));every(b,'a',.45,()=>{const n=24;for(let i=0;i<n;i++){const a=i*TAU/n+b.t*.3;api.bullet({x:b.x+Math.cos(a)*60,y:b.y+Math.sin(a)*60,a:a+Math.PI/2,sp:0,acc:60,max:150,t:0,type:'talis',c:i%2?'purple':'red',w:.4})}});every(b,'m',3.5,()=>b.goto(90+Math.random()*204,80+Math.random()*60))}},
   {name:'魔尊「天魔解体大法」',hp:1100,time:60,f:(b)=>{every(b,'L',.6,()=>api.bullet({x:Math.random()*W,y:-10,a:Math.PI/2,sp:80,type:'big',c:'yellow',lamp:1}));every(b,'a',.04,()=>spiral(b,6,1.05,130,'rice','red'));every(b,'r',.12,()=>rain('star','purple',110));every(b,'b',2.2,()=>{ring(b.x,b.y,40,70,'big','red',Math.random());laser(b.x,b.y,aim(b),.6,1.2)})}}]},
 sword:{bg:'sword',boss:{sheet:'boss-swordtomb',size:130,cols:6,name:'葬剑山剑魔'},particles:'petal',talk:{start:'葬剑山埋了三千把剑，也埋了三千个不自量力的人。',phases:[null,'剑冢里的剑，都在等新主人。','你的心乱了。','一剑霜寒——十四州！','万剑朝宗，汝可当否？'],down:'好剑意……这座山，归你了。'},waves:[
  [1.5,()=>{for(let i=0;i<8;i++)api.enemy({sheet:'en-swordghost',hp:12,delay:i*.4,path:CURVE(i%2?1:-1,70+i*12,25),shoot:(e)=>every(e,'a',1.1,()=>fan(e.x,e.y,aim(e),5,.5,190,'knife','cyan'))})}],
  [9,()=>{for(const x of[110,274])api.enemy({sheet:'en-puppet',hp:110,path:ENTER(x,120,7,x<192?-1:1),shoot:(e)=>{every(e,'a',1.4,()=>{for(let k=0;k<4;k++)laser(e.x,e.y,aim(e)+(k-1.5)*.35,.8,.7)});every(e,'b',.5,()=>ring(e.x,e.y,12,120,'knife','white',e.t))}})}],
  [19,()=>{for(let i=0;i<12;i++)api.enemy({sheet:'en-swordghost',hp:10,delay:i*.25,path:t=>[30+((i*53)%324),-30+t*140],shoot:(e)=>every(e,'a',.9,()=>fan(e.x,e.y,aim(e),3,.15,240,'knife','blue'))})}],
  [27,()=>{api.enemy({sheet:'en-puppet',size:84,hp:320,path:ENTER(192,110,10,0),shoot:(e)=>{every(e,'a',.07,()=>spiral(e,3,2.6,150,'knife','cyan'));every(e,'b',1.8,()=>laser(e.x,e.y,aim(e),.6,1))}})}],
  [39,()=>api.startBoss()]],
  phases:[
   {name:null,hp:850,time:30,f:(b)=>{every(b,'a',.7,()=>{const a=aim(b);for(let k=0;k<12;k++)api.bullet({x:b.x+Math.cos(k*TAU/12)*40,y:b.y+Math.sin(k*TAU/12)*40,a,sp:60,acc:200,max:330,type:'knife',c:'white'})})}},
   {name:'剑符「葬剑冢」',hp:1000,time:45,f:(b)=>{every(b,'a',.12,()=>{const x=20+Math.random()*344;api.bullet({x,y:-10,a:Math.PI/2,sp:40,acc:260,max:380,type:'knife',c:'cyan',stickY:180+Math.random()*260,stickT:.8,reSp:320})});every(b,'b',1.5,()=>fan(b.x,b.y,aim(b),7,.6,140,'big','blue'))}},
   {name:null,hp:850,time:30,f:(b)=>{every(b,'a',1.2,()=>{for(let i=0;i<7;i++)laser(b.x,b.y,Math.PI/2+(i-3)*.28+Math.sin(b.t)*.2,.8,.8)});every(b,'b',.12,()=>spiral(b,2,-2.8,140,'rice','white'));every(b,'g',.09,()=>api.bullet({x:b.x,y:b.y,a:-Math.PI/2+(Math.random()-.5)*1.6,sp:260,type:'knife',c:'cyan',g:260}))}},
   {name:'剑意「一剑霜寒十四州」',hp:1150,time:50,f:(b)=>{every(b,'a',.9,()=>{const n=14,a0=Math.random()*TAU;for(let i=0;i<n;i++){api.bullet({x:b.x,y:b.y,a:a0+i*TAU/n,sp:220,acc:-200,min:0,type:'ice',c:'cyan',re:.9,reSp:260})}});every(b,'r',.2,()=>rain('ice','white',140))}},
   {name:'剑魔「万剑朝宗」',hp:1300,time:60,f:(b)=>{every(b,'a',.05,()=>spiral(b,4,1.4,150,'knife','blue'));every(b,'b',1.1,()=>{const a=aim(b);for(let i=-4;i<=4;i++)laser(b.x+i*30,b.y,a,.55,.6)});every(b,'m',4,()=>b.goto(80+Math.random()*224,70+Math.random()*60))}}]},
 }}
// ---------------- 切磋（和 NPC 单挑，3 阶段，按对手属性出弹幕） ----------------
const EL_COLOR={fire:'red',water:'blue',wood:'green',metal:'yellow',earth:'orange',wind:'green',thunder:'purple',ice:'cyan'};
const EL_SPELL={fire:['火符「燎原」','火符「流火扇」'],water:['水符「潮汐」','水符「千重浪」'],wood:['木符「藤蔓」','木符「万木春」'],metal:['金符「千刃」','剑符「一线天」'],earth:['土符「落石」','土符「山岳镇」'],wind:['风符「回风」','风符「青岚」'],thunder:['雷符「雷网」','雷符「九天落雷」'],ice:['冰符「霜华」','冰符「千里冰封」']};
function duelDef(api,d){const{ring,fan,aim,every,rain,spiral,laser,flower}=api,c=EL_COLOR[d.el]||'pink',sp=EL_SPELL[d.el]||EL_SPELL.fire,k=1+Math.min(1.5,(d.lv||5)/12),hp=v=>Math.round(v*k);
 const spell1={fire:b=>every(b,'a',.06,()=>spiral(b,4,1.6,120,'rice',c)),water:b=>every(b,'a',.9,()=>flower(b.x,b.y,18,110,'orb',c,.8)),wood:b=>{every(b,'a',.5,()=>{for(let i=0;i<10;i++){const a=b.t*.6+i*Math.PI/5;api.bullet({x:b.x,y:b.y,a,sp:120,acc:-90,min:0,type:'rice',c,re:1,reSp:140})}})},metal:b=>every(b,'a',.7,()=>{for(let i=-3;i<=3;i++)fan(b.x,b.y,aim(b)+i*.12,1,0,240,'knife',c)}),earth:b=>every(b,'a',.6,()=>ring(b.x,b.y,16,80,'big',c,Math.random())),wind:b=>every(b,'a',.05,()=>spiral(b,6,-2.4,150,'small',c)),thunder:b=>every(b,'a',1,()=>{for(let i=0;i<4;i++)laser(40+Math.random()*304,0,Math.PI/2,.7,.6)}),ice:b=>every(b,'a',.8,()=>{for(let i=0;i<14;i++)api.bullet({x:b.x,y:b.y,a:i*Math.PI/7,sp:200,acc:-180,min:0,type:'ice',c,re:.8,reSp:230})})};
 const f1=spell1[d.el]||spell1.fire;
 // 第三阶段按属性加专属机制：火分裂、水反弹、木插地生根、金飞剑、土落石重力、风回旋、雷暗场闪电、冰减速再起
 const spell2={fire:b=>every(b,'x',1.2,()=>api.bullet({x:b.x,y:b.y,a:aim(b),sp:110,type:'big',c,split:{t:1,n:10,sp:150,type:'rice',c}})),
  water:b=>every(b,'x',.45,()=>api.bullet({x:b.x,y:b.y,a:Math.PI/2+(Math.random()-.5)*2.4,sp:160,type:'orb',c,bounce:3})),
  wood:b=>every(b,'x',.25,()=>api.bullet({x:20+Math.random()*344,y:-10,a:Math.PI/2,sp:60,acc:220,max:320,type:'rice',c,stickY:160+Math.random()*280,stickT:1,reSp:200})),
  metal:b=>every(b,'x',.18,()=>api.bullet({x:20+Math.random()*344,y:-10,a:Math.PI/2,sp:50,acc:260,max:360,type:'knife',c,stickY:200+Math.random()*240,stickT:.7,reSp:300})),
  earth:b=>every(b,'x',.12,()=>api.bullet({x:b.x,y:b.y,a:-Math.PI/2+(Math.random()-.5)*1.8,sp:240,type:'big',c,g:240})),
  wind:b=>every(b,'x',.6,()=>{for(let i=0;i<8;i++)api.bullet({x:b.x,y:b.y,a:i*TAU/8+b.t,sp:150,type:'small',c,w:1.6,bounce:1})}),
  thunder:b=>every(b,'x',.7,()=>api.bullet({x:Math.random()*W,y:-10,a:Math.PI/2,sp:90,type:'big',c:'yellow',lamp:1})),
  ice:b=>every(b,'x',.9,()=>api.bullet({x:b.x,y:b.y,a:aim(b),sp:90,type:'big',c,split:{t:1.2,n:8,sp:120,type:'ice',c}}))};
 const f2=spell2[d.el]||spell2.fire;
 const L=(d.lines||[]).filter(l=>l!=='{echo}');
 return {bg:'secret',particles:'petal',dark:d.el==='thunder'?[2]:null,talk:{start:L[0]||'点到为止，请！',phases:[null,L[1]||'看招！',L[2]||'最后一招了！'],down:'……是我输了，佩服。'},boss:{sheet:'npc-'+d.id,cols:4,rows:4,size:96,name:d.name},waves:[[1,()=>api.startBoss()]],
  phases:[{name:null,hp:hp(320),time:25,f:b=>{every(b,'a',.9,()=>{fan(b.x,b.y,aim(b),5,.5,160,'rice',c);ring(b.x,b.y,16,100,'orb',c,b.t)});every(b,'m',3,()=>b.goto(90+Math.random()*204,80+Math.random()*50))}},
   {name:d.name+'·'+sp[0],hp:hp(420),time:35,f:b=>{f1(b);every(b,'m',3.5,()=>b.goto(90+Math.random()*204,80+Math.random()*50))}},
   {name:d.name+'·'+sp[1],hp:hp(520),time:40,f:b=>{f1(b);f2(b);every(b,'b',.3,()=>rain('orb',c,110));every(b,'c',1.6,()=>fan(b.x,b.y,aim(b),7,.7,170,'star',c))}}]}}
// ---------------- 主体 ----------------
export async function playDanmaku(host,{art,stage:stageId,tech='fire',power=1,loadImage,spellNames=[],minTime=0,onLeave,duel=null,lives=3,bombs=2}){
 const imgs={};const need=new Set(['whale-farm','fx-danmaku','en-bat','en-spider','en-fox','en-cultist','en-swordghost','en-puppet','boss-demonlord','boss-swordtomb']);
 const root=h('div','xs-dm'),cv=h('canvas','xs-dm-cv'),g=cv.getContext('2d');root.append(cv);host.append(root);
 const btnSlow=h('button','xs-dm-btn slow','慢'),btnBomb=h('button','xs-dm-btn bomb','符'),btnQuit=h('button','xs-dm-quit','撤退');for(const b of[btnSlow,btnBomb,btnQuit])b.type='button';root.append(btnSlow,btnBomb,btnQuit);
 const stg0={secret:'secret',demon:'demon',sword:'sword'}[stageId]||'secret';if(duel)need.add('npc-'+duel.id);
 await Promise.all([...[...need].map(async n=>{imgs[n]=await loadImage(art+n+'.webp?v=20b20a0e')}),...['far','mid','near'].map(async l=>{imgs['bg-'+l]=await loadImage(art+'bg-'+stg0+'-'+l+'.webp?v=20b20a0e')})]);
 let dpr=1,scale=1,ox=0,oy=0,vw=0,vh=0;
 function resize(){const r=root.getBoundingClientRect();vw=r.width;vh=r.height;dpr=Math.min(1.5,devicePixelRatio||1);cv.width=Math.round(vw*dpr);cv.height=Math.round(vh*dpr);scale=Math.min(vw/W,vh/H);ox=(vw-W*scale)/2;oy=(vh-H*scale)/2}
 const ro=new ResizeObserver(resize);ro.observe(root);resize();
 // 状态
 const P={x:W/2,y:H-60,lives,bombs,inv:2,power:1,graze:0,score:0,slow:false,dead:0,anim:0};
 let finishRef=()=>{},speech=null,darkC=null;
 let bullets=[],shots=[],enemies=[],items=[],lasers=[],fx=[],t=0,boss=null,bomb=null,banner=null,ended=null,captures=0,phaseHitOrBomb=false,paused=false;
 const S=SHOT[tech]||SHOT.fire,dmgMul=power;
 // —— API 给关卡用 ——
 const fan=(...a)=>api.fan(...a);
 const api={
  P,bullet(o){bullets.push({t:0,acc:0,w:0,min:0,max:600,r:SIZE[o.type][2],...o})},
  aim:e=>Math.atan2(P.y-e.y,P.x-e.x),
  ring(x,y,n,sp,type,c,off=0){for(let i=0;i<n;i++)api.bullet({x,y,a:off+i*TAU/n,sp,type,c})},
  fan(x,y,a,n,spread,sp,type,c){for(let i=0;i<n;i++)api.bullet({x,y,a:a+(n>1?(i/(n-1)-.5)*spread*2:0),sp,type,c})},
  spiral(e,arms,rot,sp,type,c){for(let i=0;i<arms;i++)api.bullet({x:e.x,y:e.y,a:e.t*rot+i*TAU/arms,sp,type,c})},
  flower(x,y,n,sp,type,c,w){for(let i=0;i<n;i++){api.bullet({x,y,a:i*TAU/n,sp,type,c,w});api.bullet({x,y,a:i*TAU/n,sp,type,c:c==='purple'?'pink':c,w:-w})}},
  rain(type,c,sp){api.bullet({x:Math.random()*W,y:-8,a:Math.PI/2+(Math.random()-.5)*.3,sp,type,c})},
  laser(x,y,a,warn,on){lasers.push({x,y,a,warn,on,t:0,len:700,w:7})},
  every(e,k,iv,fn){e.cd||={};e.cd[k]=(e.cd[k]??iv*.5)-DT;if(e.cd[k]<=0){e.cd[k]+=iv;fn()}},
  enemy(o){enemies.push({t:-(o.delay||0),size:56,x:-99,y:-99,flash:0,...o,hp0:o.hp})},
  startBoss(){const d=stageDef.boss;boss={...d,x:W/2,y:-60,tx:W/2,ty:100,t:0,phase:-1,hp:1,hp0:1,flash:0,goto(x,y){this.tx=x;this.ty=y}};nextPhase()},
 };let DT=0;
 const stageDef=duel?duelDef(api,duel):stageDefs(api)[stg0];
 const waves=[...stageDef.waves];
 function nextPhase(){boss.phase++;const ph=stageDef.phases[boss.phase];if(!ph){bossDown();return}const T=stageDef.talk;if(T){const line=boss.phase===0?T.start:T.phases?.[boss.phase];if(line)speech={text:line,t:0}}boss.hp=boss.hp0=ph.hp;boss.ptime=ph.time;boss.cd={};phaseHitOrBomb=false;clearBullets(true);if(ph.name)banner={text:ph.name,t:0,who:boss.name}}
 function bossDown(){if(stageDef.talk?.down)speech={text:stageDef.talk.down,t:0,x:boss.x,y:boss.y};fxBurst(boss.x,boss.y,'#fff',60);clearBullets(true);boss=null;setTimeout(()=>finishRef(true),1200)}
 function clearBullets(toItems){for(const b of bullets)if(toItems&&Math.random()<.3)items.push({x:b.x,y:b.y,vy:-60,k:'s',auto:1});bullets=[];lasers=[]}
 function fxBurst(x,y,c,n=14){for(let i=0;i<n;i++){const a=Math.random()*TAU,v=40+Math.random()*160;fx.push({x,y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,l:.5+Math.random()*.4,c})}}
 // —— 输入 ——
 let pointer=null,touchStart=null,keys=new Set(),lastTap=0;
 const toField=(cx,cy)=>{const r=cv.getBoundingClientRect();return[(cx-r.left-ox)/scale,(cy-r.top-oy)/scale]},clampF=([x,y])=>[Math.max(8,Math.min(W-8,x)),Math.max(16,Math.min(H-10,y))];
 cv.addEventListener('contextmenu',e=>e.preventDefault());
 cv.addEventListener('pointerdown',e=>{e.preventDefault();if(ended)return;if(e.pointerType==='mouse'){if(e.button===2){doBomb();return}P.slow=true;pointer=clampF(toField(e.clientX,e.clientY));const n=performance.now();if(n-lastTap<280)doBomb();lastTap=n}else{const[fx_,fy]=toField(e.clientX,e.clientY);touchStart={fx:fx_,fy,px:P.x,py:P.y,id:e.pointerId}}cv.setPointerCapture?.(e.pointerId)});
 cv.addEventListener('pointermove',e=>{if(e.pointerType==='mouse')pointer=clampF(toField(e.clientX,e.clientY));else if(touchStart&&e.pointerId===touchStart.id){const[fx_,fy]=toField(e.clientX,e.clientY);P.tx=touchStart.px+(fx_-touchStart.fx)*1.25;P.ty=touchStart.py+(fy-touchStart.fy)*1.25}});
 const up=e=>{if(e.pointerType==='mouse')P.slow=false;else if(touchStart?.id===e.pointerId)touchStart=null};cv.addEventListener('pointerup',up);cv.addEventListener('pointercancel',up);
 cv.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse')P.slow=false});
 btnSlow.addEventListener('pointerdown',e=>{e.preventDefault();P.slowBtn=true});for(const ev of['pointerup','pointerleave','pointercancel'])btnSlow.addEventListener(ev,()=>P.slowBtn=false);
 btnBomb.addEventListener('pointerdown',e=>{e.preventDefault();doBomb()});
 btnQuit.onclick=()=>{if(!ended)finishRef(false,true)};
 const kd=e=>{const k=e.key.toLowerCase();keys.add(k);if(k==='x'){doBomb();e.preventDefault()}if(k==='escape'||k==='p'){paused=!paused}if(['arrowup','arrowdown','arrowleft','arrowright',' ','shift'].includes(k))e.preventDefault()},ku=e=>keys.delete(e.key.toLowerCase());
 addEventListener('keydown',kd);addEventListener('keyup',ku);const vis=()=>{if(document.hidden)paused=true};document.addEventListener('visibilitychange',vis);
 function doBomb(){if(ended||bomb||P.dead||P.bombs<=0)return;P.bombs--;phaseHitOrBomb=true;const name=spellNames[0]||'符卡';bomb={t:0,dur:3,c:BOMB_COLOR[tech]||'#fff'};P.inv=Math.max(P.inv,3.4);banner={text:name,t:0,who:'大肥鱼',mine:true}}
 // —— 主循环 ——
 let last=performance.now(),raf=0,shotCd=0;
 return new Promise(resolveGame=>{
 function finish(win,quit){if(ended)return;ended={win,quit,t:0};const elapsed=t;const wait=win?Math.max(0,minTime-elapsed):0;setTimeout(()=>{cleanup();resolveGame({win,captures,time:elapsed,score:Math.floor(P.score),graze:P.graze})},1600+wait*1000);ended.wait=wait}
 finishRef=finish;
 function cleanup(){cancelAnimationFrame(raf);ro.disconnect();removeEventListener('keydown',kd);removeEventListener('keyup',ku);document.removeEventListener('visibilitychange',vis);root.remove()}
 function step(dt){DT=dt;t+=dt;
  // 关卡时间线
  while(waves.length&&t>=waves[0][0])waves.shift()[1]();
  // 自机移动
  const slow=P.slow||P.slowBtn||keys.has('shift');const spd=slow?130:300;let mx=0,my=0;
  if(keys.has('arrowleft')||keys.has('a'))mx--;if(keys.has('arrowright')||keys.has('d'))mx++;if(keys.has('arrowup')||keys.has('w'))my--;if(keys.has('arrowdown')||keys.has('s'))my++;
  if(mx||my){const l=Math.hypot(mx,my);P.x+=mx/l*spd*dt;P.y+=my/l*spd*dt;pointer=null;P.tx=null}
  else{const tgt=pointer||(P.tx!=null?[P.tx,P.ty]:null);if(tgt){const dx=tgt[0]-P.x,dy=tgt[1]-P.y,d=Math.hypot(dx,dy),k=Math.min(d,spd*dt);if(d>.5){P.x+=dx/d*k;P.y+=dy/d*k}}}
  P.x=Math.max(8,Math.min(W-8,P.x));P.y=Math.max(16,Math.min(H-10,P.y));P.slowNow=slow;P.anim+=dt;
  if(P.dead>0){P.dead-=dt;if(P.dead<=0){P.dead=0;P.x=W/2;P.y=H-50;P.inv=2.5}}
  P.inv=Math.max(0,P.inv-dt);
  // 自机射击
  shotCd-=dt;if(shotCd<=0&&!P.dead&&!ended){shotCd=S.rate;const lv=Math.min(4,Math.floor(P.power)),n=S.n+(lv-1),sp=slow?S.fs:S.spread;
   for(let i=0;i<n;i++){const k=n>1?i/(n-1)-.5:0;shots.push({x:P.x+k*8,y:P.y-12,a:-Math.PI/2+k*sp*2,sp:S.sp,dmg:S.dmg*dmgMul*(slow?1.15:1),t:S.t,c:S.c,home:S.home})}}
  for(const s of shots){if(s.home){const tg=nearest(s);if(tg){const want=Math.atan2(tg.y-s.y,tg.x-s.x);let d=want-s.a;d=Math.atan2(Math.sin(d),Math.cos(d));s.a+=Math.max(-6*dt,Math.min(6*dt,d))}}s.x+=Math.cos(s.a)*s.sp*dt;s.y+=Math.sin(s.a)*s.sp*dt}
  shots=shots.filter(s=>s.y>-20&&s.x>-20&&s.x<W+20&&!s.hit);
  // 敌人
  for(const e of enemies){e.t+=dt;if(e.t<0)continue;const pos=e.path(e.t);e.vx=pos[0]-e.x;e.x=pos[0];e.y=pos[1];e.flash=Math.max(0,e.flash-dt);if(e.y>-10&&e.y<H*.8&&!ended)e.shoot?.(e,dt);
   for(const s of shots)if(!s.hit&&Math.abs(s.x-e.x)<e.size*.35&&Math.abs(s.y-e.y)<e.size*.35){s.hit=1;e.hp-=s.dmg;e.flash=.06;P.score+=10;if(e.reflect&&(e.rcd=(e.rcd||0))<=t){e.rcd=t+.35;fan(e.x,e.y,Math.atan2(P.y-e.y,P.x-e.x),3,.2,190,'heart','pink')}}
   if(e.hp<=0&&!e.dead){e.dead=1;fxBurst(e.x,e.y,'#ffd',10);P.score+=100*e.hp0;for(let i=0;i<Math.min(6,1+e.hp0/15);i++)items.push({x:e.x+(Math.random()-.5)*20,y:e.y,vy:-90-Math.random()*40,k:Math.random()<.5?'p':'s'})}
   if(!P.dead&&!P.inv&&Math.hypot(e.x-P.x,e.y-P.y)<e.size*.25)hit()}
  enemies=enemies.filter(e=>!e.dead&&(e.t<0||(e.y<H+60&&e.x>-80&&e.x<W+80)||e.t<3));
  // Boss
  if(boss){boss.t+=dt;boss.x+=(boss.tx-boss.x)*Math.min(1,dt*2);boss.y+=(boss.ty-boss.y)*Math.min(1,dt*2);boss.flash=Math.max(0,boss.flash-dt);
   const ph=stageDef.phases[boss.phase];if(boss.y>40&&!ended)ph.f(boss,dt);boss.ptime-=dt;
   for(const s of shots)if(!s.hit&&Math.abs(s.x-boss.x)<boss.size*.3&&Math.abs(s.y-boss.y)<boss.size*.35){s.hit=1;boss.hp-=s.dmg*(boss.y>40?1:0);boss.flash=.05;P.score+=12}
   if(bomb)boss.hp-=dt*45*dmgMul;
   if(boss.hp<=0||boss.ptime<=0){if(ph.name&&boss.hp<=0&&!phaseHitOrBomb){captures++;banner={text:'收取符卡！',t:0,bonus:1};P.score+=20000}for(let i=0;i<8;i++)items.push({x:boss.x+(Math.random()-.5)*60,y:boss.y,vy:-120,k:i%2?'p':'s'});nextPhase()}}
  // 子弹
  for(const b of bullets){b.t+=dt;if(b.re&&!b.reDone&&b.t>=b.re){b.reDone=1;b.a=Math.atan2(P.y-b.y,P.x-b.x);b.sp=b.reSp||150;b.acc=0}
   b.sp=Math.max(b.min,Math.min(b.max,b.sp+b.acc*dt));b.a+=b.w*dt;
   if(b.g){const vx=Math.cos(b.a)*b.sp,vy=Math.sin(b.a)*b.sp+b.g*dt;b.a=Math.atan2(vy,vx);b.sp=Math.hypot(vx,vy)}
   b.x+=Math.cos(b.a)*b.sp*dt;b.y+=Math.sin(b.a)*b.sp*dt;
   if(b.bounce>0&&(b.x<4||b.x>W-4)){b.a=Math.PI-b.a;b.x=Math.max(4,Math.min(W-4,b.x));b.bounce--}
   if(b.bounce>0&&b.y<4&&Math.sin(b.a)<0){b.a=-b.a;b.bounce--}
   if(b.stickY&&!b.stuck&&b.y>=b.stickY){b.stuck=1;b.sp=0;b.acc=0;b.re=b.t+(b.stickT||.9);b.reDone=0;b.reSp=b.reSp||300}
   if(b.split&&b.t>=b.split.t){b.dead=1;for(let i=0;i<b.split.n;i++)api.bullet({x:b.x,y:b.y,a:i*TAU/b.split.n+(b.split.off||0),sp:b.split.sp,type:b.split.type,c:b.split.c})}
   if(!P.dead&&!ended){const d=Math.hypot(b.x-P.x,b.y-P.y);if(d<b.r+2.2){if(!P.inv)hit()}else if(d<b.r+16&&!b.grazed){b.grazed=1;P.graze++;P.score+=50;fx.push({x:P.x,y:P.y,vx:(Math.random()-.5)*80,vy:(Math.random()-.5)*80,l:.25,c:'#fff'})}}}
  bullets=bullets.filter(b=>!b.dead&&b.x>-40&&b.x<W+40&&b.y>-60&&b.y<H+40&&b.t<20);
  // 激光：预警细线 → 实体
  for(const l of lasers){l.t+=dt;if(l.t>l.warn&&l.t<l.warn+l.on&&!P.dead&&!P.inv){const dx=P.x-l.x,dy=P.y-l.y,along=dx*Math.cos(l.a)+dy*Math.sin(l.a),perp=Math.abs(-dx*Math.sin(l.a)+dy*Math.cos(l.a));if(along>0&&along<l.len&&perp<l.w*.5)hit()}}
  lasers=lasers.filter(l=>l.t<l.warn+l.on+.2);
  // 符卡（Bomb）
  if(bomb){bomb.t+=dt;bullets=bullets.filter(b=>{if(Math.random()<.5)items.push({x:b.x,y:b.y,vy:-40,k:'s',auto:1});return false});lasers=[];for(const e of enemies){e.hp-=dt*60*dmgMul;e.flash=.05}
   bombSpawn(dt);
   if(bomb.t>bomb.dur)bomb=null}
  // 道具
  const vac=P.y<H*.3||bomb||boss&&boss.hp<=0;for(const it of items){if(it.auto||vac||Math.hypot(it.x-P.x,it.y-P.y)<(P.slowNow?60:36)){it.auto=1;const a=Math.atan2(P.y-it.y,P.x-it.x);it.x+=Math.cos(a)*420*dt;it.y+=Math.sin(a)*420*dt}else{it.vy=Math.min(110,it.vy+160*dt);it.y+=it.vy*dt}
   if(Math.hypot(it.x-P.x,it.y-P.y)<14&&!P.dead){it.got=1;if(it.k==='p')P.power=Math.min(4,P.power+.05);P.score+=it.k==='s'?(P.y<H*.3?500:200):50}}
  items=items.filter(i=>!i.got&&i.y<H+20);if(items.length>220)items.splice(0,items.length-220);
  for(const f of fx){f.l-=dt;f.x+=f.vx*dt;f.y+=f.vy*dt}fx=fx.filter(f=>f.l>0);if(fx.length>320)fx.splice(0,fx.length-320);
  if(speech){speech.t+=dt;if(speech.t>3.2)speech=null}
  if(banner){banner.t+=dt;if(banner.t>2.4)banner=null}
  if(ended)ended.t+=dt;
 }
 // 各属性符卡的表现（fx-danmaku 行：0 飞剑 1 符箓 2 火球 3 冰锥 4 雷击 5 紫弹 6 水泡 7 火花）
 function bombSpawn(dt){const k=tech,b=bomb;b.acc=(b.acc||0)+dt;const every=iv=>{if(b.acc>=iv){b.acc-=iv;return true}return false};
  const part=o=>b.parts.push({t:0,l:1.2,size:34,rot:0,...o});b.parts||=[];
  if(k==='metal'){if(every(.03))part({row:0,x:Math.random()*W,y:-20,vx:0,vy:620,rot:Math.PI/2,size:40})}
  else if(k==='fire'||k==='lava'){if(every(.04)){const a=Math.random()*TAU;part({row:2,x:P.x,y:P.y,vx:Math.cos(a)*260,vy:Math.sin(a)*260,rot:a,size:k==='lava'?44:36})}}
  else if(k==='ice'){if(every(.05))part({row:3,x:Math.random()*W,y:H+10,vx:(Math.random()-.5)*40,vy:-420,rot:-Math.PI/2,size:34})}
  else if(k==='thunder'){if(every(.12)){const x=Math.random()*W;for(let y=0;y<H;y+=48)part({row:4,x:x+(Math.random()-.5)*20,y,vx:0,vy:0,rot:Math.PI/2,size:56,l:.35})}}
  else if(k==='water'){if(every(.06))for(let i=0;i<3;i++)part({row:6,x:Math.random()*W,y:H+20,vx:0,vy:-300-Math.random()*120,size:30+Math.random()*24})}
  else if(k==='earth'){if(every(.15))part({row:2,x:Math.random()*W,y:-30,vx:(Math.random()-.5)*80,vy:380,rot:Math.PI/2,size:64,tint:'sepia(1) saturate(.4) brightness(.8)'})}
  else if(k==='wind'||k==='wood'||k==='poison'){if(every(.02)){const a=b.t*6+Math.random()*.4;part({row:k==='poison'?5:1,x:P.x+Math.cos(a)*30,y:P.y+Math.sin(a)*30,vx:Math.cos(a+1.2)*260,vy:Math.sin(a+1.2)*260,rot:a,size:28})}}
  else if(every(.04)){const a=Math.random()*TAU;part({row:7,x:P.x,y:P.y,vx:Math.cos(a)*240,vy:Math.sin(a)*240,size:30})}
  for(const q of b.parts){q.t+=dt;q.x+=q.vx*dt;q.y+=q.vy*dt}b.parts=b.parts.filter(q=>q.t<q.l)}
 function nearest(s){let best=null,bd=1e9;for(const e of enemies)if(e.t>=0&&!e.dead){const d=Math.hypot(e.x-s.x,e.y-s.y);if(d<bd){bd=d;best=e}}if(boss&&boss.y>40){const d=Math.hypot(boss.x-s.x,boss.y-s.y);if(d<bd)best=boss}return best}
 function hit(){if(bomb||P.inv||P.dead)return;fxBurst(P.x,P.y,'#9ef',30);P.lives--;phaseHitOrBomb=true;P.power=Math.max(1,P.power-.5);clearBullets(false);if(P.lives<0){P.lives=0;finish(false)}else{P.dead=.8;P.bombs=Math.max(P.bombs,2)}}
 // —— 绘制 ——
 function sheetDraw(img,cols,rows,f,x,y,size,flip,alpha=1,flash=0){const cw=img.naturalWidth/cols,ch=img.naturalHeight/rows,sx=(f%cols)*cw,sy=Math.floor(f/cols)*ch;g.save();g.globalAlpha=alpha;g.translate(x,y);if(flip)g.scale(-1,1);g.drawImage(img,sx,sy,cw,ch,-size/2,-size/2,size,size);if(flash){g.globalCompositeOperation='lighter';g.globalAlpha=.6;g.drawImage(img,sx,sy,cw,ch,-size/2,-size/2,size,size)}g.restore()}
 function draw(){g.setTransform(dpr,0,0,dpr,0,0);g.fillStyle='#05070c';g.fillRect(0,0,vw,vh);g.setTransform(dpr*scale,0,0,dpr*scale,dpr*ox,dpr*oy);g.save();g.beginPath();g.rect(0,0,W,H);g.clip();
  // 背景视差
  const far=imgs['bg-far'],fh=H,fw=far.naturalWidth*fh/far.naturalHeight,fxp=-((Math.sin(t*.05)+1)/2)*(fw-W);g.drawImage(far,fxp,0,fw,fh);
  g.fillStyle='rgba(0,0,0,.25)';g.fillRect(0,0,W,H);
  for(const[l,sp,yy,hh]of[['mid',14,0,H],['near',30,0,H]]){const im=imgs['bg-'+l],w2=im.naturalWidth*hh/im.naturalHeight,off=-((t*sp)%w2);for(let x=off;x<W;x+=w2)g.drawImage(im,x,yy,w2,hh)}
  g.fillStyle='rgba(8,10,24,.28)';g.fillRect(0,0,W,H);
  // 飘落（竹叶 / 灰烬 / 花瓣）
  const pc={leaf:'rgba(120,220,120,.6)',ash:'rgba(255,120,80,.55)',petal:'rgba(255,190,220,.65)'}[stageDef.particles];g.fillStyle=pc;for(let i=0;i<26;i++){const px=(i*97+Math.sin(t*.7+i)*30+t*12)%W,py=(i*53+t*(40+i%5*12))%H;g.fillRect(px,py,3,2)}
  // 激光
  for(const l of lasers){const on=l.t>l.warn;g.save();g.translate(l.x,l.y);g.rotate(l.a);if(!on){g.fillStyle='rgba(255,255,255,'+(.25+.25*Math.sin(l.t*30))+')';g.fillRect(0,-.8,l.len,1.6)}else{const k=Math.min(1,(l.t-l.warn)/.08)*(l.t>l.warn+l.on?Math.max(0,1-(l.t-l.warn-l.on)/.2):1);g.fillStyle='rgba(255,80,160,'+.55*k+')';g.fillRect(0,-l.w*k,l.len,l.w*2*k);g.fillStyle='rgba(255,255,255,'+.9*k+')';g.fillRect(0,-l.w*.35*k,l.len,l.w*.7*k)}g.restore()}
  // 敌人
  for(const e of enemies)if(e.t>=0){const img=imgs[e.sheet];sheetDraw(img,6,4,Math.floor(e.t*8)%6,e.x,e.y,e.size,e.vx>0,e.alpha||1,e.flash)}
  if(boss){const img=imgs[boss.sheet],cols=boss.cols||6,rows=boss.rows||(boss.cols?6:4),row=boss.rows===4&&boss.cols===4?0:boss.phase>=0&&stageDef.phases[boss.phase]?.name?Math.min(rows-2,1+boss.phase%3):0;
   g.save();g.globalAlpha=.35;g.strokeStyle='#f6a';g.lineWidth=2;g.beginPath();g.arc(boss.x,boss.y,boss.size*.55+Math.sin(t*3)*4,0,TAU);g.stroke();g.restore();
   sheetDraw(img,cols,rows,row*cols+Math.floor(boss.t*7)%cols,boss.x,boss.y,boss.size,boss.tx>boss.x+2,1,boss.flash)}
  // 自机
  if(!P.dead){const blink=P.inv>0&&Math.floor(t*20)%2;if(!blink)sheetDraw(imgs['whale-farm'],4,6,8+Math.floor(P.anim*8)%4,P.x,P.y-6,56,false);
   if(P.slowNow){g.save();g.strokeStyle='rgba(255,255,255,.8)';g.lineWidth=1;g.beginPath();g.arc(P.x,P.y,16,t*2,t*2+TAU*.8);g.stroke();g.fillStyle='#fff';g.beginPath();g.arc(P.x,P.y,3,0,TAU);g.fill();g.strokeStyle='#f44';g.lineWidth=1.2;g.stroke();g.restore()}}
  // 自机子弹
  for(const s of shots){const im=bulletImg(s.t,s.c);g.save();g.globalAlpha=.75;g.translate(s.x,s.y);g.rotate(s.a);g.drawImage(im,-im.width/4,-im.height/4,im.width/2,im.height/2);g.restore()}
  // 道具
  for(const it of items)g.drawImage(itemImg(it.k),it.x-5,it.y-5,10,10);
  // 敌弹
  for(const b of bullets){const im=bulletImg(b.type,b.c);g.save();g.translate(b.x,b.y);if(b.type!=='orb'&&b.type!=='big'&&b.type!=='small')g.rotate(b.type==='star'?b.t*4:b.a);g.drawImage(im,-im.width/4,-im.height/4,im.width/2,im.height/2);g.restore()}
  // 特效
  for(const f of fx){g.globalAlpha=Math.max(0,f.l*1.6);g.fillStyle=f.c;const s=f.big?6:3;g.fillRect(f.x-s/2,f.y-s/2,s,s)}g.globalAlpha=1;
  if(stageDef.dark&&boss&&stageDef.dark.includes(boss.phase)){darkC||(darkC=Object.assign(document.createElement('canvas'),{width:W,height:H}));const d=darkC.getContext('2d');d.globalCompositeOperation='source-over';d.clearRect(0,0,W,H);d.fillStyle='rgba(5,0,10,.9)';d.fillRect(0,0,W,H);d.globalCompositeOperation='destination-out';
   const hole=(x,y,r)=>{const gr=d.createRadialGradient(x,y,r*.3,x,y,r);gr.addColorStop(0,'rgba(0,0,0,1)');gr.addColorStop(1,'rgba(0,0,0,0)');d.fillStyle=gr;d.beginPath();d.arc(x,y,r,0,TAU);d.fill()};
   hole(P.x,P.y,90);hole(boss.x,boss.y,70);for(const b of bullets)if(b.lamp)hole(b.x,b.y,60);g.drawImage(darkC,0,0)}
  if(bomb?.parts){const im=imgs['fx-danmaku'],cw=im.naturalWidth/8;for(const q of bomb.parts){g.save();g.translate(q.x,q.y);g.rotate(q.rot||0);g.globalAlpha=Math.min(1,(q.l-q.t)*3);if(q.tint)g.filter=q.tint;g.globalCompositeOperation='lighter';g.drawImage(im,(Math.floor(q.t*14)%8)*cw,q.row*cw,cw,cw,-q.size/2,-q.size/2,q.size,q.size);g.restore()}}
  if(bomb){g.fillStyle=bomb.c;g.globalAlpha=.18*(1-bomb.t/bomb.dur);g.fillRect(0,0,W,H);g.globalAlpha=1;g.strokeStyle=bomb.c;g.lineWidth=4;for(let i=0;i<3;i++){const r=((bomb.t*260)+i*90)%420;g.globalAlpha=Math.max(0,1-r/420);g.beginPath();g.arc(P.x,P.y,r,0,TAU);g.stroke()}g.globalAlpha=1}
  // Boss 血条 / 符卡名 / 计时
  if(boss&&boss.phase>=0){const ph=stageDef.phases[boss.phase];g.fillStyle='rgba(0,0,0,.5)';g.fillRect(8,6,W-16,6);g.fillStyle=ph.name?'#ff5080':'#ffd060';g.fillRect(8,6,(W-16)*Math.max(0,boss.hp/boss.hp0),6);
   g.font='bold 11px system-ui';g.textAlign='left';g.fillStyle='#fff';g.fillText(boss.name+'  '+'★'.repeat(stageDef.phases.length-boss.phase-1),8,24);g.textAlign='right';g.fillText(Math.max(0,boss.ptime).toFixed(1),W-8,24);
   if(ph.name){g.textAlign='right';g.font='bold 12px system-ui';g.fillStyle='rgba(0,0,0,.55)';const tw=g.measureText(ph.name).width+14;g.fillRect(W-8-tw,30,tw,18);g.fillStyle='#ffe0f0';g.fillText(ph.name,W-15,43)}}
  if(speech){const sx=Math.max(70,Math.min(W-70,speech.x??boss?.x??W/2)),sy=(speech.y??boss?.y??90)+(boss?boss.size*.55:40);g.save();g.globalAlpha=Math.min(1,speech.t*4,(3.2-speech.t)*3);g.font='bold 12px system-ui';const lines=wrapText(speech.text,11),w=Math.min(W-20,Math.max(...lines.map(l=>g.measureText(l).width))+20),hh=lines.length*16+10;g.fillStyle='rgba(255,252,240,.95)';g.strokeStyle='#5b3214';g.lineWidth=1.5;g.beginPath();g.roundRect(sx-w/2,sy,w,hh,8);g.fill();g.stroke();g.beginPath();g.moveTo(sx-6,sy);g.lineTo(sx,sy-8);g.lineTo(sx+6,sy);g.fill();g.fillStyle='#3b2412';g.textAlign='center';g.textBaseline='top';lines.forEach((l,i)=>g.fillText(l,sx,sy+6+i*16));g.restore()}
  if(banner){const k=Math.min(1,banner.t*3)*(banner.t>2?Math.max(0,(2.4-banner.t)/.4):1);g.globalAlpha=k;g.fillStyle=banner.mine?'rgba(40,120,200,.75)':banner.bonus?'rgba(200,160,40,.8)':'rgba(160,30,80,.75)';g.fillRect(0,H*.42,W,40);g.fillStyle='#fff';g.font='bold 18px system-ui';g.textAlign='center';g.fillText(banner.text,W/2+(1-k)*80,H*.42+26);if(banner.who){g.font='11px system-ui';g.fillText(banner.who,W/2,H*.42-6)}g.globalAlpha=1}
  // HUD
  g.textAlign='left';g.font='bold 11px system-ui';g.fillStyle='#fff';const hy=boss?66:16;
  g.fillText('命 '+'♥'.repeat(Math.max(0,P.lives))+'  符 '+'✦'.repeat(P.bombs),8,hy);g.fillText('灵力 '+P.power.toFixed(2)+'  擦弹 '+P.graze+'  分 '+Math.floor(P.score).toLocaleString(),8,hy+15);
  if(paused){g.fillStyle='rgba(0,0,0,.6)';g.fillRect(0,0,W,H);g.fillStyle='#fff';g.font='bold 20px system-ui';g.textAlign='center';g.fillText('暂停 · 点一下继续',W/2,H/2)}
  if(ended){g.fillStyle='rgba(0,0,0,'+Math.min(.7,ended.t)+')';g.fillRect(0,0,W,H);g.fillStyle='#fff';g.font='bold 26px system-ui';g.textAlign='center';g.fillText(ended.win?'斗法胜利':ended.quit?'撤退':'力竭败北',W/2,H/2-10);g.font='13px system-ui';
   g.fillText(ended.win?'收取符卡 '+captures+' 张 · 擦弹 '+P.graze+(ended.wait>0.5&&ended.t<ended.wait+1?' · 灵气归元中…':''):'下次再来',W/2,H/2+16)}
  g.restore();
  // 场地边框
  g.strokeStyle='#b77732';g.lineWidth=2/scale;g.strokeRect(0,0,W,H);
 }
 cv.addEventListener('pointerdown',()=>{if(paused)paused=false},true);
 const frame=n=>{const dt=Math.min(1/30,(n-last)/1000);last=n;if(!paused&&!(ended&&ended.t>3))step(dt);else if(ended)ended.t+=dt;draw();raf=requestAnimationFrame(frame)};raf=requestAnimationFrame(frame);
 if(/xsdebug/.test(location.search))window.__dm={P,get boss(){return boss},get bullets(){return bullets},get t(){return t},get enemies(){return enemies},api,finish:w=>finish(w)};
 });
}
