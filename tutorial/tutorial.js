// Tutorial controls are local-only; they never call trading or workspace APIs.
const steps=[...document.querySelectorAll('.step')];
const tabs=[...document.querySelectorAll('[data-step]')];
let current=0;
function selectStep(index){
  current=Math.max(0,Math.min(steps.length-1,index));
  steps.forEach((step,i)=>{step.hidden=i!==current;});
  tabs.forEach((tab,i)=>tab.setAttribute('aria-pressed',String(i===current)));
  document.querySelector('#previous-step').disabled=current===0;
  document.querySelector('#next-step').disabled=current===steps.length-1;
  document.querySelector('#step-status').textContent=`第${current+1}步 / 共${steps.length}步`;
}
tabs.forEach((tab,i)=>tab.addEventListener('click',()=>selectStep(i)));
document.querySelector('#previous-step').addEventListener('click',()=>{selectStep(current-1);document.querySelector('.step-tabs').scrollIntoView({block:'start'});});
document.querySelector('#next-step').addEventListener('click',()=>{selectStep(current+1);document.querySelector('.step-tabs').scrollIntoView({block:'start'});});
document.querySelector('.step-controls').hidden=false;
function hashStep(){const match=location.hash.match(/^#step-([1-5])$/);if(match)selectStep(Number(match[1])-1);}
selectStep(0);hashStep();window.addEventListener('hashchange',hashStep);
let statusTimer;
document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',async()=>{
  const source=document.getElementById(button.dataset.copy),text=source.textContent.trim(),status=document.querySelector('#copy-status');
  try{await navigator.clipboard.writeText(text);status.textContent='提问已复制，可粘贴到系统的 AI 助手。';}
  catch{const range=document.createRange();range.selectNodeContents(source);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);status.textContent='请复制已选中的提问文字，再粘贴到 AI 助手。';}
  clearTimeout(statusTimer);statusTimer=setTimeout(()=>{status.textContent='';},5000);
}));
if('IntersectionObserver' in window){
  const links=[...document.querySelectorAll('.contents>a')];
  const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){links.forEach(link=>link.classList.toggle('active',link.hash==='#'+entry.target.id));}},{rootMargin:'-12% 0px -65% 0px'});
  links.forEach(link=>{const section=document.querySelector(link.hash);if(section)observer.observe(section);});
}
