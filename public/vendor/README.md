# Local UI dependencies

These packages are pinned, served locally, and do not call a public CDN at runtime.

| Package | Version | Source | Used for |
| --- | --- | --- | --- |
| Apache ECharts | 6.1.0 | https://github.com/apache/echarts | SVG contract probability charts and current quote gauge |
| Lucide Static | 1.55.0 | https://github.com/lucide-icons/lucide | Selected navigation and instrument icons |

ECharts was obtained from the official `echarts` npm package (`dist/echarts.min.js`, full build). Its Apache license, NOTICE, and d3 notice are retained beside the bundle. Selected Lucide SVG files were obtained from the official `lucide-static` npm package; its license is retained in `lucide/LICENSE.txt`. Icon markup in `markets.html` comes from those SVGs.

Charts display observed contract quotes, never invented price histories. Missing values remain gaps. Only cryptocurrency strike ladders use a numeric USD strike axis; other outcomes use categorical bars. Keyboard users can select the same events and contracts through native controls. Reduced-motion preferences disable chart animations.
