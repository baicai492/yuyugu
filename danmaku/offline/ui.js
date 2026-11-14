// 大肥鱼修仙记 · 界面：星露谷式对话框、HUD（时辰/灵力/灵石）、快捷栏、背包格子、浮字。全部是游戏内 UI，无浏览器弹窗。
const h=(tag,cls,...kids)=>{const n=document.createElement(tag);if(cls)n.className=cls;for(const k of kids.flat())if(k!=null&&k!==false)n.append(k instanceof Node?k:document.createTextNode(String(k)));return n};
export {h};
export class Dialog{
 constructor(root,{faceUrl}){this.root=root;this.faceUrl=faceUrl;this.el=h('div','xs-ui xs-dlg');this.el.hidden=true;root.append(this.el);this.open=false}
 // lines: [{who,name,face,text}]；options: [{label,fn}]；返回 Promise（选中的选项索引或 -1）
 say(lines,options=[]){return new Promise(done=>{
  this.open=true;let i=0,shown=0,full='',timer=0,ready=false;const box=h('div','xs-dlg-box'),main=h('div','xs-dlg-main'),text=h('p','xs-dlg-text'),opts=h('div','xs-dlg-opts'),more=h('i','xs-dlg-more','▼'),nameTag=h('b','xs-dlg-name'),face=h('div','xs-dlg-face'),faceImg=h('span'),faceName=h('b');face.append(faceImg,faceName);
  main.append(nameTag,text,opts,more);box.append(main,face);this.el.replaceChildren(box);this.el.hidden=false;
  const show=()=>{const L=lines[i];full=L.text;shown=0;ready=false;opts.replaceChildren();more.hidden=true;
   const hasFace=!!L.who;face.hidden=!hasFace;nameTag.hidden=hasFace;nameTag.textContent=L.name||'';
   if(hasFace){{const u=this.faceUrl(L.who);if(u&&typeof u.then==='function'){faceImg.style.backgroundImage='';u.then(v=>{faceImg.style.backgroundImage=`url(${v})`}).catch(()=>{})}else faceImg.style.backgroundImage=`url(${u})`}faceImg.style.backgroundPosition=(L.face||0)*50+'% 0';faceName.textContent=L.name||''}
   clearInterval(timer);timer=setInterval(()=>{shown+=1;text.textContent=full.slice(0,shown);if(shown>=full.length){clearInterval(timer);end()}},26)};
  const end=()=>{ready=true;text.textContent=full;if(i<lines.length-1){more.hidden=false;return}if(!options.length){more.hidden=false;return}
   opts.replaceChildren(...options.map((o,k)=>{const b=h('button','xs-dlg-opt',(k+1)+'. '+o.label);b.type='button';b.onclick=e=>{e.stopPropagation();finish(k)};return b}));opts.firstChild?.focus()};
  const next=()=>{if(!ready){clearInterval(timer);end();return}if(i<lines.length-1){i++;show()}else if(!options.length)finish(-1)};
  const finish=k=>{clearInterval(timer);this.next=null;document.removeEventListener('keydown',key,true);this.el.hidden=true;this.open=false;options[k]?.fn?.();done(k)};
  const key=e=>{const k=e.key.toLowerCase();if(k==='escape'){e.preventDefault();finish(-1)}else if(k===' '||k==='enter'||k==='e'){if(!ready||!opts.children.length){e.preventDefault();next()}}else if(/^[1-9]$/.test(k)&&opts.children[+k-1]){e.preventDefault();opts.children[+k-1].click()}};
  document.addEventListener('keydown',key,true);this.next=()=>{if(!opts.children.length||!ready)next()};main.onclick=this.next;show();
 })}
}
export class Hud{
 constructor(root){this.el=h('div','xs-ui xs-hud');root.append(this.el);this.place=h('b','xs-hud-place');this.clock=h('span','xs-hud-clock');this.energy=h('div','xs-hud-energy',h('i'),h('small'));this.stone=h('span','xs-hud-chip');this.coins=h('span','xs-hud-chip');this.help=h('button','xs-hud-help','📖 玩法说明');this.help.type='button';this.help.onclick=()=>this.onHelp?.();this.el.append(this.place,this.clock,this.energy,this.stone,this.coins,this.help)}
 set({place,clock,energy,energyMax,stone,coins}){const key=[place,clock,Math.floor(energy),energyMax,stone,coins].join('|');if(key===this.key)return;this.key=key;this.place.textContent=place??'';this.clock.textContent=clock??'';const p=Math.max(0,Math.min(1,energy/energyMax));this.energy.firstChild.style.height=p*100+'%';this.energy.classList.toggle('low',p<.2);this.energy.lastChild.textContent='灵力 '+Math.floor(energy)+'/'+energyMax;this.stone.textContent='灵石 '+(stone??0).toLocaleString('zh-CN');this.coins.textContent='D币 '+(coins??0).toLocaleString('zh-CN')}
}
// 快捷栏：10 格，数字键/滚轮切换；slot={icon:(size)=>Node,count,label}
export class Hotbar{
 constructor(root,onSelect){this.el=h('div','xs-ui xs-hotbar xs-hotbar-foldable');root.append(this.el);
  this.slotsEl=h('div','xs-hotbar-slots');this.slotsEl.id='xs-farm-tools';
  const toggle=h('button','xs-btn xs-hotbar-toggle','▾');toggle.type='button';
  toggle.setAttribute('aria-controls',this.slotsEl.id);
  toggle.addEventListener('keydown',e=>{if(e.key===' ')e.stopPropagation()});
  const setExpanded=expanded=>{
   this.slotsEl.hidden=!expanded;
   toggle.textContent=expanded?'▾':'▴ 工具';
   toggle.title=expanded?'收起工具栏':'展开工具栏';
   toggle.setAttribute('aria-label',toggle.title);
   toggle.setAttribute('aria-expanded',String(expanded));
  };
  setExpanded(true);toggle.onclick=()=>setExpanded(this.slotsEl.hidden);
  this.el.append(this.slotsEl,toggle);this.sel=0;this.slots=[];this.onSelect=onSelect;this.wheel=e=>{if(this.el.hidden||this.slotsEl.hidden||e.target.closest('.xs-sheet'))return;this.select((this.sel+(e.deltaY>0?1:9))%10)};root.addEventListener('wheel',this.wheel,{passive:true})}
 set(slots){this.slots=slots;this.render()}
 select(i){this.sel=i;this.render();this.onSelect?.(this.slots[i],i)}
 get current(){return this.slots[this.sel]}
 render(){this.slotsEl.replaceChildren(...Array.from({length:Math.max(3,this.slots.length)},(_,i)=>{const s=this.slots[i],b=h('button','xs-slot'+(i===this.sel?' on':''));b.type='button';b.title=s?.label||'';b.append(h('i','xs-slot-key',String((i+1)%10)));if(s){b.append(s.icon(34));if(s.count!=null)b.append(h('small','xs-slot-n',String(s.count)))}b.onclick=()=>this.select(i);return b}))}
}
export function floatText(layer,text,x,y,cls=''){const n=h('span','xs-float '+cls,text);n.style.left=x+'px';n.style.top=y+'px';layer.append(n);setTimeout(()=>n.remove(),1200)}
export function toast(root,text,kind=''){let t=root.querySelector('.xs-toast');if(!t){t=h('div','xs-ui xs-toast');root.append(t)}const n=h('p',kind,text);t.append(n);setTimeout(()=>n.remove(),2600)}
// 格子面板（柜台买卖、背包）：游戏内木框，点格子操作；Esc / 关闭按钮收起。
export class Panel{
 constructor(root){this.root=root;this.el=h('div','xs-ui xs-sheet');this.el.hidden=true;root.append(this.el);this.open=false;this.key=e=>{if(e.key==='Escape'&&this.open){e.preventDefault();this.close()}}}
 // tabs: [{title, cells:[{icon:(size)=>Node,label,sub,count,disabled,on:()=>void}] , note}]
 show(title,tabs,{onClose}={}){this.onClose=onClose;this.tabs=tabs;this.title=title;this.cur=Math.min(this.cur||0,tabs.length-1);this.open=true;this.el.hidden=false;document.addEventListener('keydown',this.key,true);this.render()}
 update(tabs){if(!this.open)return;this.tabs=tabs;this.render()}
 render(){const t=this.tabs[this.cur]||this.tabs[0],close=h('button','xs-sheet-x','✕');close.type='button';close.onclick=()=>this.close();
  const head=h('div','xs-sheet-head',h('b',null,this.title),...(this.tabs.length>1?this.tabs.map((x,i)=>{const b=h('button','xs-tab'+(i===this.cur?' on':''),x.title);b.type='button';b.onclick=()=>{this.cur=i;this.render()};return b}):[]),close);
  const grid=t.text?h('div','xs-guide',...t.text.map(([hd,...ps])=>h('section',null,h('b',null,hd),...ps.map(p=>h('p',null,p))))):h('div','xs-grid',...t.cells.map(c=>{const b=h('button','xs-cell'+(c.disabled?' off':''));b.type='button';b.title=c.label+(c.sub?' · '+c.sub:'');if(c.icon)b.append(c.icon(44));b.append(h('span','xs-cell-name',c.label));if(c.sub)b.append(h('small','xs-cell-sub',c.sub));if(c.count!=null)b.append(h('i','xs-cell-n',String(c.count)));b.onclick=()=>{if(!c.disabled)c.on?.()};return b}),...Array.from({length:Math.max(0,12-t.cells.length)},()=>h('div','xs-cell empty')));
  this.el.replaceChildren(h('div','xs-sheet-box',head,grid,t.note?h('p','xs-sheet-note',t.note):null))}
 close(){if(!this.open)return;this.open=false;this.el.hidden=true;document.removeEventListener('keydown',this.key,true);this.onClose?.()}
}
