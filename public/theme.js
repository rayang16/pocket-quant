/* Light (gemini.com) is the default. Dark follows gemini.com/predictions. The choice is kept per browser. */
const KEY='pq-theme';
const root=document.documentElement;
function stored() {try {return localStorage.getItem(KEY);} catch {return null;}}
function apply(theme) {
  const dark=theme==='dark';
  if(dark)root.dataset.theme='dark';else delete root.dataset.theme;
  for(const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.setAttribute('aria-pressed',String(dark));
    button.setAttribute('aria-label',dark?'Switch to light theme':'Switch to dark theme');
    button.title=button.getAttribute('aria-label');
  }
  document.querySelector('meta[name=theme-color]')?.setAttribute('content',dark?'#010304':'#ffffff');
  dispatchEvent(new CustomEvent('themechange',{detail:{theme:dark?'dark':'light'}}));
}
apply(stored());
addEventListener('click',event=>{
  const button=event.target.closest('[data-theme-toggle]');if(!button)return;
  const next=root.dataset.theme==='dark'?'light':'dark';
  try {localStorage.setItem(KEY,next);} catch {/* The theme still applies for this page view. */}
  apply(next);
});
