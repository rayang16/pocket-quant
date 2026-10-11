import {readFile} from 'node:fs/promises';
const required=['index.html','app.js','ui.js','card.js','styles.css','icon.svg','share.html','shared-reel.js','reel-transcript.js','evidence-report.js','Check with Pocket Quant.shortcut','Check with Gem Finder.shortcut','trade.html','trade.js','trade.css','live.html','live.js','live.css','trade-draft.js'];
for(const name of required) await readFile(new URL('../public/'+name,import.meta.url));
const workspace=['markets.html','analysis-history.js','workspace.css','workspace.js','workspace-data.js','workspace-charts.js','workspace-chart-data.js','report-workspace.js','app-shell.css','theme.js','fonts/geist-latin.woff2','fonts/OFL.txt','vendor/lucide/LICENSE.txt','vendor/echarts-6.1.0.min.js','vendor/echarts-LICENSE.txt','vendor/echarts-NOTICE.txt','vendor/echarts-LICENSE-d3.txt'];
for(const name of workspace) await readFile(new URL('../public/'+name,import.meta.url));
console.log('Web app and iPhone sharing assets are ready.');
