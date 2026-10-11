import {readFile} from 'node:fs/promises';
const required=['index.html','app.js','ui.js','card.js','styles.css','icon.svg','share.html','shared-reel.js','reel-transcript.js','evidence-report.js','Check with Pocket Quant.shortcut','trade.html','trade.js','trade.css','live.html','live.js','live.css'];
for(const name of required) await readFile(new URL('../public/'+name,import.meta.url));
console.log('Web app and iPhone sharing assets are ready.');
