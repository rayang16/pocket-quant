import {readFile} from 'node:fs/promises';
const required=['index.html','app.js','ui.js','card.js','styles.css','icon.svg','share.html','shared-reel.js','Check with Pocket Quant.shortcut'];
for(const name of required) await readFile(new URL('../public/'+name,import.meta.url));
console.log('Web app and iPhone sharing assets are ready.');
