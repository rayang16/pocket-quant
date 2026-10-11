import {copyFile,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const name of ['styles.css','ui.js','card.js']) await copyFile(root+'public/'+name,root+'extension/'+name);
const base=process.env.PUBLIC_API_BASE||(process.env.VERCEL_PROJECT_PRODUCTION_URL?'https://'+process.env.VERCEL_PROJECT_PRODUCTION_URL:process.env.VERCEL_URL?'https://'+process.env.VERCEL_URL:'http://localhost:3000');
await writeFile(root+'extension/config.js',`export const DEFAULT_API_BASE=${JSON.stringify(base)};\n`);
const manifest=JSON.parse(await readFile(root+'extension/manifest.json','utf8'));
for(const name of [manifest.background.service_worker,manifest.side_panel.default_path,...manifest.content_scripts.flatMap(s=>s.js)])await readFile(root+'extension/'+name);
try{execFileSync('zip',['-q','-r',root+'public/pocket-quant-extension.zip','.','-x','*.DS_Store'],{cwd:root+'extension'});}catch{console.warn('zip is unavailable; the unpacked extension folder is still ready.');}
console.log('Built shared extension assets. API base: '+base);
