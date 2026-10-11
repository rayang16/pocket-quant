import { prepareContractQuotes } from './workspace-chart-data.js';
const instances = new Map();
const observers = new Map();
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function chartAt(host) {
  if (!window.echarts || !host || !host.isConnected) return null;
  let chart = instances.get(host);
  if (!chart || chart.isDisposed()) {
    host.replaceChildren();
    chart = window.echarts.init(host, null, { renderer: 'svg' });
    instances.set(host, chart);
    const observer = new ResizeObserver(() => { if (!chart.isDisposed() && host.clientWidth) chart.resize(); });
    observer.observe(host); observers.set(host, observer);
  }
  return chart;
}
export function disposeChart(host) {
  observers.get(host)?.disconnect(); observers.delete(host);
  instances.get(host)?.dispose(); instances.delete(host);
}
export function renderContractChart(host, event, selectedContract, onSelect) {
  if (!host) return;
  const prepared = prepareContractQuotes(event?.contracts);
  const { points, quoted } = prepared;
  const priceLadder = prepared.priceLadder && event?.category === 'Crypto';
  if (!event || !quoted) {
    disposeChart(host); host.replaceChildren();
    host.setAttribute('aria-label', event ? `No usable quotes for ${event.title}.` : 'No market selected for quote comparison.');
    const message = document.createElement('div'); message.className = 'quote-chart-empty';
    message.textContent = event ? 'No usable quotes for this event yet.' : 'Select a market to compare its contracts.';
    host.append(message); return;
  }
  const chart = chartAt(host);
  if (!chart) { host.textContent = 'The chart could not load. Quotes remain available in Markets and the evidence panel.'; return; }
  chart.clear(); chart.off('click');
  const selectedIndex = event.contracts.indexOf(selectedContract);
  const formatStrike = value => new Intl.NumberFormat(undefined, {style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2}).format(value);
  const label = point => point.label;
  const pale = 'rgba(255,255,255,.72)', blue = '#2cbcfc';
  const shared = {
    animation: !reduced(), animationDuration: 650, animationDurationUpdate: reduced() ? 0 : 220,
    textStyle: { fontFamily: 'Geist, Arial, sans-serif', color: 'rgba(255,255,255,.62)' },
    aria: {enabled:true,label:{description:`Observed YES probabilities for ${event.title}. These are quotes across contracts, not a price history. ${quoted} of ${points.length} contracts have quotes.`}},
    tooltip: {trigger:'item',renderMode:'richText',backgroundColor:'#ffffff',borderWidth:0,padding:[8,10],textStyle:{color:'#010304',fontSize:12},formatter: params => {
      const point = points[params.dataIndex];
      return `${point.label}\n${point.probability === null ? 'No usable quote' : `YES ${point.probability.toFixed(1)}%`}\n${point.source}`;
    }},
    grid: priceLadder ? {top:35,right:24,bottom:36,left:40} : {top:18,right:65,bottom:30,left:10,containLabel:true},
  };
  if (priceLadder) {
    chart.setOption({...shared,
      xAxis:{type:'value',min:'dataMin',max:'dataMax',splitNumber:4,splitLine:{show:false},axisLine:{lineStyle:{color:'rgba(255,255,255,.2)'}},axisTick:{show:false},axisLabel:{formatter:formatStrike,color:'rgba(255,255,255,.62)',fontSize:11,hideOverlap:true}},
      yAxis:{type:'value',min:0,max:100,interval:25,axisLabel:{formatter:'{value}%',color:'rgba(255,255,255,.5)',fontSize:11},splitLine:{lineStyle:{color:'rgba(255,255,255,.12)',type:'dashed'}},axisLine:{show:false}},
      series:[{type:'line',smooth:false,connectNulls:false,symbol:'circle',symbolSize:7,lineStyle:{width:2,color:pale},areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'rgba(44,188,252,.22)'},{offset:1,color:'rgba(44,188,252,0)'}]}},emphasis:{scale:1.5},data:points.map(point=>({value:[point.strike,point.probability],itemStyle:{color:point.index===selectedIndex?blue:pale,borderWidth:point.index===selectedIndex?3:0,borderColor:'rgba(44,188,252,.35)'}}))}],
    });
  } else {
    chart.setOption({...shared,
      xAxis:{type:'value',min:0,max:100,interval:25,axisLabel:{formatter:'{value}%',color:'rgba(255,255,255,.5)',fontSize:11},splitLine:{lineStyle:{color:'rgba(255,255,255,.12)',type:'dashed'}}},
      yAxis:{type:'category',inverse:true,data:points.map(label),axisTick:{show:false},axisLine:{show:false},axisLabel:{color:'rgba(255,255,255,.8)',fontSize:12,width:host.clientWidth<400?105:175,overflow:'truncate'}},
      ...(points.length>6?{dataZoom:[{type:'slider',yAxisIndex:0,startValue:0,endValue:5,right:0,width:4,showDetail:false,borderColor:'transparent',fillerColor:'rgba(44,188,252,.45)',backgroundColor:'rgba(255,255,255,.1)',handleSize:0}]}:{}),
      series:[{type:'bar',barMaxWidth:14,itemStyle:{borderRadius:[0,7,7,0]},showBackground:true,backgroundStyle:{color:'rgba(255,255,255,.05)',borderRadius:[0,7,7,0]},label:{show:true,position:'right',fontSize:12,fontWeight:600,color:'#ffffff',formatter:params=>params.value===null?'':`${params.value.toFixed(1)}%`},data:points.map(point=>({value:point.probability,itemStyle:{color:point.index===selectedIndex?blue:pale}}))}],
    });
  }
  chart.on('click', params => { if (params.componentType==='series' && points[params.dataIndex]) onSelect(event.contracts[points[params.dataIndex].index]); });
  chart.resize();
}
export function renderQuoteGauge(host, value, side) {
  const chart = chartAt(host);
  if (!chart) return false;
  const styles = getComputedStyle(document.documentElement);
  const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  const track = token('--gauge-track', '#e6e6e6'), fill = token('--gauge-fill', '#010304'), ink = token('--ink', '#010304');
  chart.setOption({animation:!reduced(),animationDuration:650,aria:{enabled:true,label:{description:`Indicative ${side} probability ${value.toFixed(1)} percent.`}},series:[{type:'gauge',startAngle:210,endAngle:-30,min:0,max:100,radius:'96%',center:['50%','65%'],progress:{show:true,width:10,roundCap:true,itemStyle:{color:fill}},axisLine:{roundCap:true,lineStyle:{width:10,color:[[1,track]]}},axisTick:{show:false},splitLine:{show:false},axisLabel:{show:false},pointer:{show:false},anchor:{show:false},title:{show:false},detail:{valueAnimation:!reduced(),offsetCenter:[0,'-5%'],fontFamily:'Geist, Arial, sans-serif',fontWeight:500,fontSize:34,color:ink,formatter:v=>`${v.toFixed(1)}%`},data:[{value}]}]});
  return true;
}
addEventListener('pagehide', event => { if (!event.persisted) for (const host of [...instances.keys()]) disposeChart(host); });
