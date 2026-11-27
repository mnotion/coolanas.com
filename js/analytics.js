// From Uiverse.io by ashif_6672 - https://uiverse.io/ashif_6672/nice-warthog-84
// MIT License, Copyright (c) ashif_6672 (Ashif)
// Sign-in check and analytics page setup.
const SUPABASE_URL = "https://nacwftrsdpglzrhasmit.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
const {createClient} = await import("https://esm.sh/@supabase/supabase-js@2.119.0");
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    experimental: {passkey: true}
  }
});

const $ = id => document.getElementById(id);
function applyTheme(mode = window.CoolanasTheme?.get() || "light") {
  window.CoolanasTheme?.apply(mode);
  document.documentElement.classList.toggle("dark-mode", mode === "dark");
  document.documentElement.dataset.theme = mode;
}
applyTheme();
const {data: {session}, error: sessionError} = await supabase.auth.getSession();
if (sessionError || !session?.user) {
  location.replace("/index.html");
  throw new Error("Sign in required.");
}

function startCoolanasPresence(session){
  if(!session?.user)return;
  const send=async()=>{
    if(document.visibilityState!=="visible")return;
    const {error}=await supabase.rpc("coolanas_set_user_presence");
    if(error)console.warn("Could not update Coolanas presence:",error.message);
  };
  send().catch(console.warn);
  setInterval(()=>send().catch(console.warn),30000);
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")send().catch(console.warn);});
}

startCoolanasPresence(session);
await window.CoolanasTheme?.loadForSession(session);
const accountKey = key => key + ":" + session.user.id;
supabase.auth.onAuthStateChange((_event, nextSession) => {
  if ((nextSession?.user?.id || null) !== session.user.id) location.reload();
});
// Legacy unscoped pending records have no verifiable owner; never sync them.
localStorage.removeItem("coolanas-study-pending-analytics-v1");

for (const button of document.querySelectorAll(".topic"))
  button.addEventListener("click", () => {
    for (const item of document.querySelectorAll(".topic")) {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    }
    for (const section of document.querySelectorAll(".section"))
      section.classList.toggle("active", section.id === "section-" + button.dataset.section);
  });
// Study-time totals and the monthly chart.
function formatDuration(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000), h = Math.floor(total / 3600),
        m = Math.floor(total % 3600 / 60), s = total % 60;
  return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
}
function formatTotalDuration(ms) {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60000), hours = Math.floor(totalMinutes / 60),
        minutes = totalMinutes % 60;
  return [hours, minutes].map(value => String(value).padStart(2, "0")).join(":");
}
function readTimerState() {
  try {
    const saved = JSON.parse(localStorage.getItem(accountKey("coolanas-study-stopwatch-v1")) || "null");
    if (saved && typeof saved.elapsed === "number")
      return {
        elapsed: Math.max(0, saved.elapsed),
        startedAt: Number.isFinite(saved.startedAt) ? saved.startedAt : null
      };
  } catch {
  }
  return {elapsed: 0, startedAt: null};
}
let cloudAnalyticsLoaded = false;
function currentMonthKey(date = new Date()) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
}
function readDailyTotals() {
  try {
    const value = JSON.parse(localStorage.getItem(accountKey("coolanas-study-daily-time-v1")) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function readDailySubjects() {
  try {
    const value = JSON.parse(localStorage.getItem(accountKey("coolanas-study-daily-subjects-v1")) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function getCurrentMonthTotal() {
  const month = currentMonthKey(), totals = readMonthlyTotals();
  let total = Math.max(0, Number(totals[month]) || 0);
  const state = readTimerState();
  if (state.startedAt) {
    const now = Date.now();
    let cursor = state.startedAt;
    while (cursor < now) {
      const date = new Date(cursor),
            next = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime(),
            end = Math.min(now, next);
      if (currentMonthKey(date) === month) total += end - cursor;
      cursor = end;
    }
  }
  return total;
}
function renderTimer() {
}
let cloudAnalyticsLoadPromise = null;
function readLocalAnalyticsSnapshot() {
  const readObject = key => {
    try {
      const value = JSON.parse(localStorage.getItem(accountKey(key)) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  return {
    daily:readDailyTotals(),
    dailySubjects:readDailySubjects(),
    dailyHours:readObject("coolanas-study-daily-hours-v1")
  };
}
function readPendingAnalytics() {
  try {
    const value = JSON.parse(localStorage.getItem(accountKey("coolanas-study-pending-analytics-v1")) || "[]");
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function setAnalyticsSyncStatus(message, state = "idle", title = "") {
  const status = $("analytics-sync-status");
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
  status.title = title || message;
}
async function loadCloudAnalytics() {
  if (cloudAnalyticsLoadPromise) return cloudAnalyticsLoadPromise;
  cloudAnalyticsLoadPromise = (async () => {
    const pendingKey = accountKey("coolanas-study-pending-analytics-v1");
    const migrationKey = accountKey("coolanas-analytics-cloud-reconciled-v1");
    let pending = readPendingAnalytics();
    let snapshotPending = localStorage.getItem(migrationKey) !== "1";
    try {
      while (pending.length || snapshotPending) {
        const batch = pending.slice(0,100);
        const payload = {action:"analytics_sync",records:batch};
        if (snapshotPending) payload.snapshot = readLocalAnalyticsSnapshot();
        const {data,error} = await supabase.functions.invoke("coolanas-files-b2",{body:payload});
        if (error || data?.error)
          throw new Error(data?.error || error?.message || "Could not sync pending analytics.");
        const sentIds = new Set(batch.map(record => record.eventId));
        const latestPending = readPendingAnalytics();
        localStorage.setItem(pendingKey,JSON.stringify(latestPending.filter(record => !sentIds.has(record.eventId))));
        if (snapshotPending) {
          localStorage.setItem(migrationKey,"1");
          snapshotPending = false;
        }
        pending = readPendingAnalytics();
      }

      const {data,error} = await supabase.functions.invoke("coolanas-files-b2", {
        body:{action:"analytics_get"}
      });
      if (error || data?.error)
        throw new Error(data?.error || error?.message || "Could not fetch cloud analytics.");
      // The account JSON document on the server is authoritative for live reads.
      // Backblaze stats/analytics.json is the durable JSON-file mirror; browser
      // storage is only a retry queue and a cache of the last server response.
      const daily = data.daily && typeof data.daily === "object" && !Array.isArray(data.daily) ? data.daily : {};
      const dailySubjects = data.dailySubjects && typeof data.dailySubjects === "object" &&
        !Array.isArray(data.dailySubjects) ? data.dailySubjects : {};
      const dailyHours = data.dailyHours && typeof data.dailyHours === "object" &&
        !Array.isArray(data.dailyHours) ? data.dailyHours : {};
      localStorage.setItem(accountKey("coolanas-study-daily-time-v1"),JSON.stringify(daily));
      localStorage.setItem(accountKey("coolanas-study-daily-subjects-v1"),JSON.stringify(dailySubjects));
      localStorage.setItem(accountKey("coolanas-study-daily-hours-v1"),JSON.stringify(dailyHours));
      const monthly = {};
      for (const [date,duration] of Object.entries(daily)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          const key = date.slice(0,7);
          monthly[key] = (Number(monthly[key]) || 0) + Math.max(0,Number(duration) || 0);
        }
      }
      localStorage.setItem(accountKey("coolanas-study-monthly-time-v1"),JSON.stringify(monthly));
      cloudAnalyticsLoaded = true;
      if (data.legacyImportPending === true) {
        setAnalyticsSyncStatus(
          "Cloud sync active · restoring JSON archive",
          "success",
          "Live analytics are syncing to your account. The legacy Backblaze JSON archive will be imported when its download cap allows."
        );
      } else if (data.mirrorPending === true) {
        setAnalyticsSyncStatus(
          "Cloud sync active · JSON mirror retrying",
          "success",
          "Analytics are safely synced to your account. The Backblaze JSON mirror will retry automatically."
        );
      } else {
        setAnalyticsSyncStatus("Cloud sync active","success","Last successful account sync: " + new Date().toLocaleString());
      }
      renderTimer();
      renderMonthlyChart();
      if (selectedCalendarDate) renderCalendarDetails();
    } catch (error) {
      setAnalyticsSyncStatus("Cloud sync unavailable · showing last saved data","error",error?.message || "Cloud analytics sync failed.");
      console.warn("Could not load/sync saved account analytics:",error);
    }
  })().finally(() => { cloudAnalyticsLoadPromise = null; });
  return cloudAnalyticsLoadPromise;
}
function readMonthlyTotals() {
  try {
    const value = JSON.parse(localStorage.getItem(accountKey("coolanas-study-monthly-time-v1")) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? {...value} : {};
  } catch {
    return {};
  }
}
function addIntervalToTotals(totals, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  let cursor = start;
  while (cursor < end) {
    const date = new Date(cursor),
          next = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime(),
          segmentEnd = Math.min(end, next),
          key = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");

    totals[key] = (Number(totals[key]) || 0) + (segmentEnd - cursor);
    cursor = segmentEnd;
  }
}
function renderStudyHeatmap(totals, now) {
  const grid = $("study-heatmap-grid"), months = $("study-heatmap-months"),
        scroller = $("study-heatmap-scroll");
  if (!grid || !months || !scroller) return;
  grid.replaceChildren();
  months.replaceChildren();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1),
        start = new Date(today.getFullYear(), 0, 1),
        firstWeekdayOffset = (start.getDay() + 6) % 7;
  const dates = [];
  for (let cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + 1)) dates.push(new Date(cursor));
  const maxDay = Math.max(1, ...dates.map(date => {
    const key = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") +
        "-" + String(date.getDate()).padStart(2, "0");
    return Math.max(0, Number(totals[key]) || 0);
  }));
  const weekCount = Math.ceil((dates.length + firstWeekdayOffset) / 7);
  grid.style.gridTemplateColumns = "repeat(" + weekCount + ", 14px)";
  months.style.gridTemplateColumns = "repeat(" + weekCount + ", 14px)";
  const monthSeen = new Set();
  dates.forEach((date, index) => {
    const week = Math.floor((index + firstWeekdayOffset) / 7), weekday = (date.getDay() + 6) % 7,
          key = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") +
        "-" + String(date.getDate()).padStart(2, "0");
    const monthKey = date.getFullYear() + "-" + date.getMonth();
    if ((date.getDate() === 1 || index === 0) && !monthSeen.has(monthKey)) {
      monthSeen.add(monthKey);
      const label = document.createElement("span");
      label.className = "study-heatmap-month";
      label.style.gridColumn = String(week + 1);
      label.textContent = date.toLocaleDateString(undefined, {month:"short"});
      months.append(label);
    }
    const amount = Math.max(0, Number(totals[key]) || 0);
    let level = 0;
    if (amount > 0) level = amount <= maxDay * 0.25 ? 1 : amount <= maxDay * 0.5 ? 2 : amount <= maxDay * 0.75 ? 3 : 4;
    const cell = document.createElement("span");
    cell.className = "study-heatmap-cell";
    cell.dataset.level = String(level);
    cell.tabIndex = 0;
    cell.setAttribute("role", "img");
    const readable = date.toLocaleDateString(undefined, {weekday:"long",day:"numeric",month:"long",year:"numeric"});
    const minutes = Math.floor(amount / 60000);
    const time = minutes >= 60 ? Math.floor(minutes / 60) + "h " + minutes % 60 + "m" : minutes + "m";
    cell.setAttribute("aria-label", readable + ": " + time + " studied");
    cell.title = readable + " · " + time;
    cell.style.gridColumn = String(week + 1);
    cell.style.gridRow = String(weekday + 1);
    grid.append(cell);
  });
  if (!scroller.dataset.initialized) {
    scroller.dataset.initialized = "true";
    requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth; });
  }
}
function formatDistributionDuration(ms) {
  const minutes=Math.ceil(Math.max(0,Number(ms)||0)/60000);
  const hours=Math.floor(minutes/60), remainder=minutes%60;
  return hours ? hours+"h "+remainder+"min" : minutes+"min";
}
function distributionShade(hex, amount) {
  const value=String(hex||"").trim();
  if(!/^#[0-9a-f]{6}$/i.test(value))return value;
  const channels=[1,3,5].map(i=>parseInt(value.slice(i,i+2),16));
  return "#"+channels.map(channel=>{
    const target=amount<0?0:255, factor=Math.abs(amount);
    return Math.round(channel+(target-channel)*factor).toString(16).padStart(2,"0");
  }).join("");
}
function showDistributionTooltip(event, subject, duration) {
  let tooltip=$("subject-distribution-tooltip");
  if(!tooltip){
    tooltip=document.createElement("div");
    tooltip.id="subject-distribution-tooltip";
    tooltip.className="subject-distribution-tooltip";
    tooltip.setAttribute("role","tooltip");
    document.body.append(tooltip);
  }
  tooltip.textContent=subject+"\n"+formatDistributionDuration(duration);
  tooltip.hidden=false;
  const width=tooltip.offsetWidth,height=tooltip.offsetHeight;
  tooltip.style.left=Math.max(8,Math.min(window.innerWidth-width-8,event.clientX-width/2))+"px";
  tooltip.style.top=Math.max(8,event.clientY-height-12)+"px";
}
function hideDistributionTooltip() {
  const tooltip=$("subject-distribution-tooltip");
  if(tooltip)tooltip.hidden=true;
}
function renderSubjectDistribution(subjectsByDay, monthPrefix, year, month, options = {}) {
  const svg=$(options.svgId || "subject-distribution-chart"),
        legend=$(options.legendId || "subject-distribution-legend"),
        monthLabel=$(options.labelId || "subject-distribution-month");
  if(!svg||!legend||!monthLabel)return;
  svg.replaceChildren(); legend.replaceChildren();
  monthLabel.textContent=options.label || new Date(year,month,1).toLocaleDateString(undefined,{month:"long",year:"numeric"});
  const totals=new Map();
  for(const [date,entries] of Object.entries(subjectsByDay||{})){
    if((options.exactDate ? date!==monthPrefix : !date.startsWith(monthPrefix))||!entries||typeof entries!=="object")continue;
    for(const [subject,duration] of Object.entries(entries)){
      const amount=Math.max(0,Number(duration)||0);
      if(amount)totals.set(subject,(totals.get(subject)||0)+amount);
    }
  }
  const entries=[...totals.entries()].sort((a,b)=>b[1]-a[1]);
  const total=entries.reduce((sum,entry)=>sum+entry[1],0), ns="http://www.w3.org/2000/svg";
  const make=(tag,attrs,parent=svg)=>{const node=document.createElementNS(ns,tag);for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));parent.append(node);return node;};
  const palette=["#8fc36a","#39a99a","#e28d83","#e9a443","#8580c9","#54a5d8","#e76b50","#b37be0","#6b9d91","#c5a05c"];
  if(!options.svgId){
    svg.setAttribute("viewBox","0 0 220 220");
    svg.setAttribute("preserveAspectRatio","xMidYMid meet");
    svg.append(make("circle",{cx:110,cy:110,r:72,fill:"none",stroke:"var(--subject-donut-track,#eceff1)","stroke-width":22}));
    if(!total){
      const empty=make("text",{x:110,y:106,"text-anchor":"middle","class":"subject-donut-empty"});empty.textContent="No study data";
      const sub=make("text",{x:110,y:122,"text-anchor":"middle","class":"subject-donut-empty"});sub.textContent=options.emptyLabel || "this month";
      return;
    }
    const circumference=2*Math.PI*72,gap=2,usedColours=new Map();
    let offset=0;
    entries.forEach(([subject,duration],index)=>{
      const fraction=duration/total,baseColour=calendarSubjectColours[subject]||palette[index%palette.length];
      const key=baseColour.toLowerCase(),shadeIndex=usedColours.get(key)||0;
      usedColours.set(key,shadeIndex+1);
      const colour=shadeIndex===0?baseColour:distributionShade(baseColour,shadeIndex%2===1?-0.24:0.22);
      const segmentLength=Math.max(0,fraction*circumference-gap);
      const ring=make("circle",{cx:110,cy:110,r:72,fill:"none",stroke:colour,"stroke-width":22,
        "stroke-dasharray":segmentLength+" "+(circumference-segmentLength),"stroke-dashoffset":-offset,
        transform:"rotate(-90 110 110)","stroke-linecap":"butt",
        "aria-label":subject+": "+(fraction*100).toFixed(1)+" percent"});
      ring.addEventListener("pointerenter",event=>showDistributionTooltip(event,subject,duration));
      ring.addEventListener("pointermove",event=>showDistributionTooltip(event,subject,duration));
      ring.addEventListener("pointerleave",hideDistributionTooltip);
      offset+=fraction*circumference;
      const item=document.createElement("div");item.className="subject-distribution-item";
      const swatch=document.createElement("span");swatch.className="subject-distribution-swatch";swatch.style.backgroundColor=colour;
      const name=document.createElement("span");name.className="subject-distribution-name";name.textContent=subject;
      const time=document.createElement("strong");time.textContent=formatDistributionDuration(duration);
      const share=document.createElement("small");share.textContent=(fraction*100).toFixed(1)+"%";
      item.append(swatch,name,time,share);
      item.addEventListener("pointerenter",event=>showDistributionTooltip(event,subject,duration));
      item.addEventListener("pointermove",event=>showDistributionTooltip(event,subject,duration));
      item.addEventListener("pointerleave",hideDistributionTooltip);
      legend.append(item);
    });
    return;
  }
  svg.setAttribute("viewBox","0 0 560 390");
  svg.setAttribute("preserveAspectRatio","xMidYMid meet");
  svg.append(make("circle",{cx:280,cy:195,r:78,fill:"none",stroke:"var(--subject-donut-track,#eceff1)","stroke-width":24}));
  if(!total){
    const empty=make("text",{x:280,y:190,"text-anchor":"middle","class":"subject-donut-empty"});empty.textContent="No study data";
    const sub=make("text",{x:280,y:210,"text-anchor":"middle","class":"subject-donut-empty"});sub.textContent=options.emptyLabel || "this month";
    return;
  }
  const circumference=2*Math.PI*78,gap=4;
  const usedColours=new Map(), callouts=[];
  let offset=0;
  entries.forEach(([subject,duration],index)=>{
    const fraction=duration/total,baseColour=calendarSubjectColours[subject]||palette[index%palette.length];
    const key=baseColour.toLowerCase(),shadeIndex=usedColours.get(key)||0;
    usedColours.set(key,shadeIndex+1);
    const colour=shadeIndex===0?baseColour:distributionShade(baseColour,shadeIndex%2===1?-0.24:0.22);
    const segmentLength=Math.max(0,fraction*circumference-gap),midAngle=(-90+(offset+fraction*circumference/2)/circumference*360)*Math.PI/180;
    const ring=make("circle",{cx:280,cy:195,r:78,fill:"none",stroke:colour,"stroke-width":24,
      "stroke-dasharray":segmentLength+" "+(circumference-segmentLength),"stroke-dashoffset":-offset,
      transform:"rotate(-90 280 195)","stroke-linecap":"butt","aria-label":subject+": "+(fraction*100).toFixed(1)+" percent"});
    ring.addEventListener("pointerenter",event=>showDistributionTooltip(event,subject,duration));
    ring.addEventListener("pointermove",event=>showDistributionTooltip(event,subject,duration));
    ring.addEventListener("pointerleave",hideDistributionTooltip);
    const x1=280+Math.cos(midAngle)*92,y1=195+Math.sin(midAngle)*92,
          x2=280+Math.cos(midAngle)*132,y2=195+Math.sin(midAngle)*132,
          topSlice=Math.sin(midAngle)<-0.72;
    callouts.push({subject,duration,colour,x1,y1,x2,y2,x3:x2,rightSide:Math.cos(midAngle)>=0,topSlice});
    offset+=fraction*circumference;
  });
  // Tiny slices near 12 o'clock cluster together; alternate their callouts left/right.
  const topItems=callouts.filter(item=>item.topSlice).sort((a,b)=>a.x1-b.x1);
  topItems.forEach((item,index)=>{
    item.rightSide=index%2===1;
    item.x3=item.x2+(item.rightSide?62:-62);
  });
  // Keep the remaining labels on their natural side and spread labels vertically.
  for(const side of [false,true]){
    const sideItems=callouts.filter(item=>item.rightSide===side).sort((a,b)=>a.y2-b.y2);
    const minY=35,maxY=355,separation=48;
    sideItems.forEach((item,index)=>{item.labelY=Math.max(minY,Math.min(maxY,item.y2));if(index)item.labelY=Math.max(item.labelY,sideItems[index-1].labelY+separation);});
    if(sideItems.length&&sideItems[sideItems.length-1].labelY>maxY){
      const shift=sideItems[sideItems.length-1].labelY-maxY;
      sideItems.forEach(item=>item.labelY-=shift);
    }
  }
  callouts.forEach(item=>{
    const {x1,y1,x2,y2,x3,rightSide,labelY,subject,duration,colour}=item;
    make("path",{d:"M "+x1+" "+y1+" L "+x2+" "+y2+" L "+x3+" "+labelY,fill:"none",stroke:colour,"stroke-width":1.5,"stroke-linecap":"round","stroke-linejoin":"round"});
    const labelX=x3+(rightSide?5:-5),anchor=rightSide?"start":"end";
    const group=make("g",{"class":"subject-donut-callout"});
    const name=make("text",{x:labelX,y:labelY-3,"text-anchor":anchor,"class":"subject-donut-callout-name"},group);
    name.textContent=subject;
    const time=make("text",{x:labelX,y:labelY+13,"text-anchor":anchor,"class":"subject-donut-callout-time"},group);
    time.textContent=formatDistributionDuration(duration);
    group.addEventListener("pointerenter",event=>showDistributionTooltip(event,subject,duration));
    group.addEventListener("pointermove",event=>showDistributionTooltip(event,subject,duration));
    group.addEventListener("pointerleave",hideDistributionTooltip);
  });
}
function renderMonthlyChart() {
  const dailyKey = accountKey("coolanas-study-daily-time-v1");
  let totals = {}, subjectsByDay = {};
  try {
    totals = JSON.parse(localStorage.getItem(dailyKey) || "{}") || {};
  } catch {
  }
  try {
    subjectsByDay =
        JSON.parse(localStorage.getItem(accountKey("coolanas-study-daily-subjects-v1")) || "{}") || {};
  } catch {
  }
  const tooltip = $("chart-tooltip"), state = readTimerState(), now = new Date(),
        year = now.getFullYear(), month = now.getMonth(),
        days = new Date(year, month + 1, 0).getDate(),
        monthPrefix = year + "-" + String(month + 1).padStart(2, "0") + "-";
  if (state.startedAt) {
    let cursor = state.startedAt;
    const end = Date.now();
    while (cursor < end) {
      const date = new Date(cursor),
            next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(),
            segmentEnd = Math.min(end, next),
            key = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" +
          String(date.getDate()).padStart(2, "0");

      totals[key] = (Number(totals[key]) || 0) + (segmentEnd - cursor);
      cursor = segmentEnd;
    }
  }
  const values = Array.from(
      {length: days},
      (_, index) =>
          Math.max(0, Number(totals[monthPrefix + String(index + 1).padStart(2, "0")]) || 0));
  renderStudyHeatmap(totals, now);
  const monthlyTotal=values.reduce((sum,value)=>sum+value,0);
  const studiedDays=values.filter(value=>value>0).length;
  const dailyAverage=monthlyTotal/days;
  const bestValue=Math.max(0,...values);
  const bestIndex=values.indexOf(bestValue);
  const overviewTotal=$("monthly-overview-total");
  const overviewDays=$("monthly-overview-days");
  const overviewAverage=$("monthly-overview-average");
  const overviewBest=$("monthly-overview-best");
  if(overviewTotal)overviewTotal.textContent=formatCalendarTime(monthlyTotal);
  if(overviewDays)overviewDays.textContent=studiedDays+" / "+days;
  if(overviewAverage)overviewAverage.textContent=formatCalendarTime(dailyAverage);
  if(overviewBest){
    overviewBest.textContent=bestValue>0 ? formatCalendarTime(bestValue) : "—";
  }
  const svg = $("monthly-time-chart");
  svg.replaceChildren();
  const ns = "http://www.w3.org/2000/svg", width = 760, height = 280, left = 48, right = 16,
        top = 16, bottom = 38, plotHeight = height - top - bottom, plotWidth = width - left - right,
        maxHours = Math.max(0, ...values) / 3600000,
        scaleHours = Math.max(1, Math.floor(maxHours) + 1), scale = scaleHours * 3600000;
  const make = (tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    return el;
  };
  for (let step = 0; step <= scaleHours; step++) {
    const y = top + plotHeight - (step / scaleHours) * plotHeight,
          label = make(
              "text", {x: left - 10, y: y + 4, "text-anchor": "end", "class": "chart-axis-label"});
    label.textContent = step + "h";
    svg.append(label);
  }
  svg.append(
      make("line", {x1: left, y1: top, x2: left, y2: top + plotHeight, "class": "chart-axis-line"}),
      make("line", {
        x1: left,
        y1: top + plotHeight,
        x2: width - right,
        y2: top + plotHeight,
        "class": "chart-axis-line"
      }));
  const points = values.map((value, index) => ({
                              x: left + (days === 1 ? 0 : index / (days - 1) * plotWidth),
                              y: top + plotHeight - value / scale * plotHeight,
                              value
                            }));
  const pathData =
            points.map((point, index) => (index ? "L" : "M") + point.x + " " + point.y).join(" "),
        areaData = pathData + " L " + points[points.length - 1].x + " " + (top + plotHeight) +
      " L " + points[0].x + " " + (top + plotHeight) + " Z";
  svg.append(
      make("path", {d: areaData, "class": "chart-area"}),
      make("path", {d: pathData, "class": "chart-line"}));
  const labelStep = days > 24 ? 2 : 1;
  for (let index = 0; index < days; index++) {
    const point = points[index];
    if ((index + 1) % labelStep === 0 || index === 0 || index === days - 1) {
      const label = make(
          "text",
          {x: point.x, y: height - 10, "text-anchor": "middle", "class": "chart-axis-label"});
      label.textContent = String(index + 1);
      svg.append(label);
    }
    const dateKey = monthPrefix + String(index + 1).padStart(2, "0"),
          daySubjects = subjectsByDay[dateKey] && typeof subjectsByDay[dateKey] === "object" ?
        subjectsByDay[dateKey] :
        {},
          dot = make("circle", {
            cx: point.x,
            cy: point.y,
            r: 4.5,
            "class": "chart-point",
            "data-day": String(index + 1),
            "tabindex": "0",
            "role": "img",
            "aria-label": dateKey + ", " + formatDuration(point.value)
          }),
          title = make("title", {});
    title.textContent = (index + 1) + ": " + formatDuration(point.value);
    dot.append(title);
    const showTooltip = (clientX, clientY) => {
      tooltip.replaceChildren();
      const heading = document.createElement("div");
      heading.className = "chart-tooltip-date";
      heading.textContent =
          new Date(year, month, index + 1)
              .toLocaleDateString(
                  undefined, {weekday: "short", day: "numeric", month: "long", year: "numeric"});
      tooltip.append(heading);
      const total = document.createElement("div");
      total.className = "chart-tooltip-total";
      total.textContent = "Total studied: " + formatDuration(point.value);
      tooltip.append(total);
      const entries = Object.entries(daySubjects)
                          .filter(([, duration]) => Number(duration) > 0)
                          .sort((left, right) => Number(right[1]) - Number(left[1]));
      if (entries.length) {
        for (const [subject, duration] of entries) {
          const row = document.createElement("div");
          row.className = "chart-tooltip-subject";
          const name = document.createElement("span"), time = document.createElement("span");
          name.textContent = subject;
          time.textContent = formatDuration(Number(duration));
          row.append(name, time);
          tooltip.append(row);
        }
      } else {
        const empty = document.createElement("div");
        empty.className = "chart-tooltip-empty";
        empty.textContent = "No subject breakdown recorded";
        tooltip.append(empty);
      }
      tooltip.classList.add("visible");
      const offset = 14, box = tooltip.getBoundingClientRect();
      tooltip.style.left = Math.min(clientX + offset, window.innerWidth - box.width - 8) + "px";
      tooltip.style.top =
          Math.max(8, Math.min(clientY + offset, window.innerHeight - box.height - 8)) + "px";
    };
    dot.addEventListener("pointerenter", event => showTooltip(event.clientX, event.clientY));
    dot.addEventListener("pointermove", event => showTooltip(event.clientX, event.clientY));
    dot.addEventListener("pointerleave", () => tooltip.classList.remove("visible"));
    dot.addEventListener("focus", () => {
      const rect = dot.getBoundingClientRect();
      showTooltip(rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    dot.addEventListener("blur", () => tooltip.classList.remove("visible"));
    svg.append(dot);
    if (index < days - 1) {
      const halfX = (point.x + points[index + 1].x) / 2;
      svg.append(
          make("circle", {cx: halfX, cy: top + plotHeight, r: 1.8, "class": "chart-axis-dot"}));
    }
  }
}
// Calendar view.
let calendarDate = new Date();
calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1);
let selectedCalendarDate = null;
function calendarDateKey(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") +
      "-" + String(date.getDate()).padStart(2, "0");
}
function formatCalendarTime(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  return String(Math.floor(minutes / 60)).padStart(2, "0") + ":" +
      String(minutes % 60).padStart(2, "0");
}
function formatSubjectTime(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return hours ? hours + "h " + remainder + "m" : minutes + "m";
}
let calendarTasks = [];
let calendarTaskDays = [];
let calendarTaskEditingDate = null;
let calendarTaskEditBuffer = [];
let calendarTasksLoaded = false;
let calendarTaskSyncTimer = null;
let calendarTaskSyncInFlight = false;
const calendarTasksCacheKey = accountKey("coolanas-calendar-tasks-v1");
const calendarTasksPendingKey = accountKey("coolanas-calendar-tasks-pending-v1");
function saveCalendarTasksLocally() {
  localStorage.setItem(calendarTasksCacheKey, JSON.stringify(calendarTasks));
  localStorage.setItem(calendarTasksPendingKey, "1");
}
function queueCalendarTasksSync() {
  saveCalendarTasksLocally();
  if (calendarTaskSyncTimer) clearTimeout(calendarTaskSyncTimer);
  calendarTaskSyncTimer = setTimeout(() => {
    calendarTaskSyncTimer = null;
    void flushCalendarTasks();
  }, 5000);
}
async function flushCalendarTasks({keepalive = false} = {}) {
  if (calendarTaskSyncTimer) {
    clearTimeout(calendarTaskSyncTimer);
    calendarTaskSyncTimer = null;
  }
  if (localStorage.getItem(calendarTasksPendingKey) !== "1" || calendarTaskSyncInFlight) return;
  calendarTaskSyncInFlight = true;
  const payload = JSON.stringify({action:"tasks_save", tasks:calendarTasks});
  try {
    if (keepalive) {
      const response = await fetch(SUPABASE_URL + "/functions/v1/coolanas-files-b2", {
        method:"POST", keepalive:true,
        headers:{
          "Content-Type":"application/json",
          apikey:SUPABASE_PUBLISHABLE_KEY,
          Authorization:"Bearer " + session.access_token
        },
        body:payload
      });
      if (!response.ok) throw new Error("Task sync failed.");
      const result = await response.json();
      if (result?.error) throw new Error(result.error);
    } else {
      const {data,error} = await supabase.functions.invoke("coolanas-files-b2", {
        body:{action:"tasks_save",tasks:calendarTasks}
      });
      if (error || data?.error) throw new Error(data?.error || error.message);
    }
    localStorage.removeItem(calendarTasksPendingKey);
  } catch (error) {
    console.warn("Could not sync calendar tasks:", error);
  } finally {
    calendarTaskSyncInFlight = false;
  }
}
window.addEventListener("pagehide", () => { void flushCalendarTasks({keepalive:true}); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) void flushCalendarTasks({keepalive:true});
});
let calendarSubjectColours = {};
const subjectPalette = ["#e7e7e7", "#f6caca", "#f6dfaa", "#d9edbd", "#c9e7ef", "#d7d0f2", "#f0cce8"];
async function loadCalendarSubjectColours() {
  try {
    const {data, error} = await supabase.functions.invoke("coolanas-files-b2", {body:{action:"subjects_get"}});
    if (error || data?.error) throw new Error(data?.error || error.message);
    calendarSubjectColours = Object.fromEntries((Array.isArray(data?.subjects) ? data.subjects : []).filter(s => s && typeof s.name === "string").map(s => [s.name, subjectPalette[Math.max(0, Math.min(6, Number(s.color) || 0))]]));
  } catch (error) { console.warn("Could not load subject colours:", error); }
}
async function loadCalendarTasks() {
  if (localStorage.getItem(calendarTasksPendingKey) === "1") {
    try {
      const cached = JSON.parse(localStorage.getItem(calendarTasksCacheKey) || "[]");
      if (Array.isArray(cached)) {
        calendarTasks = cached;
        calendarTasksLoaded = true;
      }
    } catch {}
  }
  try {
    const {data, error} = await supabase.functions.invoke("coolanas-files-b2", {body:{action:"tasks_get"}});
    if (error || data?.error) throw new Error(data?.error || error.message);
    if (localStorage.getItem(calendarTasksPendingKey) !== "1")
      calendarTasks = Array.isArray(data?.tasks) ? data.tasks : [];
    calendarTaskDays = Array.isArray(data?.taskDays) ? data.taskDays : [];
    calendarTasksLoaded = true;
    localStorage.setItem(calendarTasksCacheKey, JSON.stringify(calendarTasks));
  } catch (error) {
    console.warn("Could not load calendar tasks:", error);
    calendarTasksLoaded = calendarTasksLoaded || false;
  }
}
async function saveCalendarDaySnapshot(date, tasks, locked = false) {
  const cleanTasks = tasks.map(task => ({
    id:task.id || crypto.randomUUID(),
    text:String(task.text || "").trim(),
    completed:task.completed === true
  })).filter(task => task.text);
  const {data,error} = await supabase.functions.invoke("coolanas-files-b2", {
    body:{action:"tasks_day_save",date,tasks:cleanTasks,locked}
  });
  if (error || data?.error) throw new Error(data?.error || error.message || "Could not save this day's tasks.");
  const index = calendarTaskDays.findIndex(day => day?.date === date);
  if (index >= 0) calendarTaskDays[index] = data.snapshot;
  else calendarTaskDays.push(data.snapshot);
  calendarTaskDays.sort((a,b) => String(a.date).localeCompare(String(b.date)));
  return data.snapshot;
}
function renderCalendarHourlyGraph(panel, dateKey) {
  const chart = document.createElement("section");
  chart.className = "calendar-hourly-chart";
  const title = document.createElement("h3");
  title.textContent = "Study throughout the day";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 720 270");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Study time, including minutes, in each hour from midnight to midnight");
  let allHours = {};
  try {
    const saved = JSON.parse(localStorage.getItem(accountKey("coolanas-study-daily-hours-v1")) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) allHours = saved;
  } catch {
  }
  const dayHours = allHours[dateKey] && typeof allHours[dateKey] === "object" ?
      allHours[dateKey] : {};
  const values = [];
  for (let hour = 0; hour < 24; hour++)
    values.push(Math.max(0, Number(dayHours[hour]) || 0));
  const halfHour = 30 * 60 * 1000,
        max = Math.max(halfHour, Math.ceil(Math.max(...values) / halfHour) * halfHour);
  const left = 48, right = 700, top = 18, bottom = 218;
  function formatHourlyDuration(ms) {
    const minutes = Math.round(ms / 60000), hours = Math.floor(minutes / 60),
          remainder = minutes % 60;
    if (!minutes) return "0m";
    if (!hours) return minutes + "m";
    return remainder ? hours + "h " + remainder + "m" : hours + "h";
  }
  function add(tag, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach(name => node.setAttribute(name, String(attrs[name])));
    svg.append(node);
    return node;
  }
  for (let tick = 0; tick <= max / halfHour; tick++) {
    const duration = tick * halfHour,
          y = bottom - duration / max * (bottom - top);
    add("line", {x1:left,y1:y,x2:right,y2:y,stroke:"#e5e7eb","stroke-width":1});
    const label = add("text", {x:left-10,y:y+4,"text-anchor":"end",fill:"#858b96","font-size":11});
    label.textContent = formatHourlyDuration(duration);
  }
  const coords = [];
  for (let hour = 0; hour < 24; hour++) {
    coords.push([left + hour / 23 * (right-left), bottom - values[hour] / max * (bottom-top)]);
  }
  add("polyline", {points:coords.map(point => point.join(",")).join(" "),fill:"none",stroke:"#397fe0","stroke-width":3,"stroke-linecap":"round","stroke-linejoin":"round"});
  coords.forEach((point, hour) => {
    const dot = add("circle", {
      cx:point[0],cy:point[1],r:values[hour] > 0 ? 5 : 2.5,
      fill:values[hour] > 0 ? "#397fe0" : "#aab4c2",stroke:"#fff","stroke-width":1.5,
      "aria-label":hour + ":00 — " + formatHourlyDuration(values[hour])
    });
    const dotTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
    dotTitle.textContent = hour + ":00–" + String((hour + 1) % 24).padStart(2, "0") +
        ":00 · " + formatHourlyDuration(values[hour]);
    dot.append(dotTitle);
    if (hour % 2 === 0) {
      const label = add("text", {x:point[0],y:bottom+22,"text-anchor":"middle",fill:"#858b96","font-size":10});
      label.textContent = String(hour);
    }
  });
  const xLabel = add("text", {x:374,y:260,"text-anchor":"middle",fill:"#858b96","font-size":11});
  xLabel.textContent = "Time of day";
  chart.append(title, svg);
  panel.append(chart);
}
function renderCalendarDetails() {
  const panel = $("calendar-details");
  // This element is only a layout wrapper, never a visible card.
  for (const property of ["border","border-radius","background","box-shadow","padding"]) {
    panel.style.setProperty(property, property === "border" ? "0" : property === "padding" ? "0" : "transparent", "important");
  }
  panel.querySelector(".calendar-hourly-chart")?.remove();
  panel.querySelector(".calendar-daily-distribution")?.remove();
  if (!selectedCalendarDate) {
    panel.hidden = true;
    return;
  }
  const key = calendarDateKey(selectedCalendarDate), dailyTotals = readDailyTotals(),
        dailySubjects = readDailySubjects(), total = Math.max(0, Number(dailyTotals[key]) || 0),
        subjects = Object.entries(dailySubjects[key] || {})
            .filter(([, duration]) => Number(duration) > 0)
            .sort((a, b) => Number(b[1]) - Number(a[1]));
  const today = new Date(), todayKey = calendarDateKey(today),
        yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1),
        yesterdayKey = calendarDateKey(yesterday),
        heading = $("calendar-details-date"),
        headingWrap = heading.closest(".calendar-details-heading"),
        isFutureDate = key > todayKey;
  panel.classList.toggle("future-date", isFutureDate);
  if (isFutureDate) {
    heading.textContent = "I can't predict the future...";
    panel.prepend(headingWrap);
  } else {
    if (headingWrap.parentElement !== panel.parentElement)
      panel.parentElement.insertBefore(headingWrap, panel);
    if (key === todayKey) heading.textContent = "Today's work: " + formatCalendarTime(total);
    else if (key === yesterdayKey) heading.textContent = "Yesterday you worked for " + formatCalendarTime(total);
    else heading.textContent = "On that day, you worked " + formatCalendarTime(total);
  }
  $("calendar-details-total").textContent = "";
  const content = $("calendar-details-content");
  content.replaceChildren();
  const subjectsSection = document.createElement("section");
  subjectsSection.className = "calendar-detail-section calendar-subjects-section";
  const subjectCards = document.createElement("div");
  subjectCards.className = "calendar-subject-cards";
  if (subjects.length) {
    for (const [subject, duration] of subjects) {
      const card = document.createElement("div");
      card.className = "calendar-subject-card";
      card.style.background = calendarSubjectColours[subject] || "#e7e7e7";
      const name = document.createElement("span"), time = document.createElement("strong");
      name.textContent = subject;
      time.textContent = formatSubjectTime(Number(duration));
      card.append(name, time);
      subjectCards.append(card);
    }
  } else {
    const empty = document.createElement("p");
    empty.className = "calendar-details-empty";
    empty.textContent = "No subjects recorded.";
    subjectCards.append(empty);
  }
  subjectsSection.append(subjectCards);
  const tasksSection = document.createElement("section");
  tasksSection.className = "calendar-tasks-section";
  const daySnapshot = calendarTaskDays.find(day => day?.date === key) || null;
  const isPastDate = key < todayKey;
  const isEditingPastDate = isPastDate && calendarTaskEditingDate === key;

  if (isPastDate) {
    tasksSection.classList.add("past-day-tasks");
    const headingRow = document.createElement("div");
    headingRow.className = "calendar-past-tasks-heading";
    const tasksTitle = document.createElement("h3");
    tasksTitle.textContent = "Tasks";
    headingRow.append(tasksTitle);
    const taskList = document.createElement("div");
    taskList.className = "calendar-task-list-box calendar-past-task-list";
    const dateLabel = key === yesterdayKey ? "yesterday" :
      selectedCalendarDate.toLocaleDateString(undefined,{month:"long",day:"numeric"});
    const sourceTasks = daySnapshot?.tasks || calendarTasks
      .filter(task => task.completedAt === key)
      .map(task => ({id:task.id,text:task.text,completed:true}));

    const modifyButton = document.createElement("button");
    modifyButton.type = "button";
    modifyButton.className = "calendar-task-modify";
    modifyButton.textContent = isEditingPastDate ? "Editing" : "Modify";
    modifyButton.disabled = isEditingPastDate;
    modifyButton.addEventListener("click", () => {
      calendarTaskEditingDate = key;
      calendarTaskEditBuffer = sourceTasks.map(task => ({
        id:task.id || crypto.randomUUID(),text:task.text,completed:task.completed === true
      }));
      renderCalendarDetails();
    });
    headingRow.append(modifyButton);
    tasksSection.append(headingRow);

    if (isEditingPastDate) {
      const editForm = document.createElement("form");
      editForm.className = "calendar-task-add";
      const editInput = document.createElement("input");
      editInput.type = "text";
      editInput.maxLength = 180;
      editInput.placeholder = "Add a task for this day…";
      editInput.setAttribute("aria-label","New task for this day");
      const addTask = document.createElement("button");
      addTask.type = "submit";
      addTask.textContent = "Add";
      editForm.append(editInput,addTask);
      editForm.addEventListener("submit",event => {
        event.preventDefault();
        const value = editInput.value.trim();
        if (!value) return;
        if (calendarTaskEditBuffer.length >= 100) {
          editInput.setCustomValidity("You can have up to 100 tasks.");
          editInput.reportValidity();
          return;
        }
        calendarTaskEditBuffer.push({id:crypto.randomUUID(),text:value,completed:false});
        renderCalendarDetails();
      });
      taskList.append(editForm);
      if (calendarTaskEditBuffer.length) {
        for (const task of calendarTaskEditBuffer) {
          const row = document.createElement("div");
          row.className = "calendar-task-row" + (task.completed ? " completed" : "");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = task.completed === true;
          checkbox.setAttribute("aria-label","Mark " + task.text + " as completed");
          checkbox.addEventListener("change",() => {
            task.completed = checkbox.checked;
            renderCalendarDetails();
          });
          const label = document.createElement("span");
          label.className = "calendar-task-label";
          label.textContent = task.text;
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "calendar-task-remove";
          remove.textContent = "×";
          remove.title = "Remove task";
          remove.setAttribute("aria-label","Remove task: " + task.text);
          remove.addEventListener("click",() => {
            calendarTaskEditBuffer = calendarTaskEditBuffer.filter(item => item.id !== task.id);
            renderCalendarDetails();
          });
          row.append(checkbox,label,remove);
          taskList.append(row);
        }
      } else {
        const empty = document.createElement("p");
        empty.className = "calendar-details-empty";
        empty.textContent = "No tasks added for this day.";
        taskList.append(empty);
      }
      const actions = document.createElement("div");
      actions.className = "calendar-task-edit-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "calendar-task-cancel";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click",() => {
        calendarTaskEditingDate = null;
        calendarTaskEditBuffer = [];
        renderCalendarDetails();
      });
      const save = document.createElement("button");
      save.type = "button";
      save.className = "calendar-task-save";
      save.textContent = "Save changes";
      save.addEventListener("click",async () => {
        save.disabled = true;
        try {
          await saveCalendarDaySnapshot(key,calendarTaskEditBuffer,false);
          calendarTaskEditingDate = null;
          calendarTaskEditBuffer = [];
          renderCalendarDetails();
        } catch (error) {
          save.disabled = false;
          taskList.querySelector(".calendar-task-save-error")?.remove();
          const message = document.createElement("p");
          message.className = "calendar-task-save-error";
          message.textContent = error.message;
          actions.before(message);
        }
      });
      const lock = document.createElement("button");
      lock.type = "button";
      lock.className = "calendar-task-lock";
      lock.textContent = "Lock day";
      lock.addEventListener("click",async () => {
        lock.disabled = true;
        try {
          await saveCalendarDaySnapshot(key,calendarTaskEditBuffer,true);
          calendarTaskEditingDate = null;
          calendarTaskEditBuffer = [];
          renderCalendarDetails();
        } catch (error) {
          lock.disabled = false;
          const message = document.createElement("p");
          message.className = "calendar-task-save-error";
          message.textContent = error.message;
          actions.before(message);
        }
      });
      actions.append(cancel,save,lock);
      taskList.append(actions);
    } else {
      const completedTasks = sourceTasks.filter(task => task.completed === true);
      if (completedTasks.length) {
        for (const task of completedTasks) {
          const row = document.createElement("div");
          row.className = "calendar-task-row completed";
          const mark = document.createElement("span");
          mark.className = "calendar-task-completed-mark";
          mark.textContent = "✓";
          const label = document.createElement("span");
          label.className = "calendar-task-label";
          label.textContent = task.text;
          row.append(mark,label);
          taskList.append(row);
        }
      } else {
        const empty = document.createElement("p");
        empty.className = "calendar-details-empty";
        empty.textContent = "No tasks completed " + dateLabel + ".";
        taskList.append(empty);
      }
      if (daySnapshot?.locked) {
        const status = document.createElement("span");
        status.className = "calendar-task-locked-status";
        status.textContent = "Day locked";
        taskList.append(status);
      }
    }
    tasksSection.append(taskList);
  } else {
    const tasksMain = document.createElement("div");
    tasksMain.className = "calendar-tasks-main";
    const tasksTitle = document.createElement("h3");
    tasksTitle.textContent = "Tasks";
    tasksMain.append(tasksTitle);
    const tasksEmpty = document.createElement("div");
    tasksEmpty.className = "calendar-tasks-empty-slot calendar-task-list-box";
    const dayTasks = calendarTasks.filter(task =>
      task.dueDate ? task.dueDate === key : key === todayKey
    );
    if (key >= todayKey) {
      const form = document.createElement("form");
      form.className = "calendar-task-add";
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 180;
      input.placeholder = key === todayKey ? "Add a task for today…" : "Plan a task for this day…";
      input.setAttribute("aria-label", "New task for " + key);
      const add = document.createElement("button");
      add.type = "submit";
      add.textContent = "Add";
      form.append(input, add);
      const isTodayLocked = key === todayKey && daySnapshot?.locked === true;
      input.disabled = isTodayLocked;
      add.disabled = isTodayLocked;
      form.addEventListener("submit", event => {
        event.preventDefault();
        if (key === todayKey && daySnapshot?.locked) return;
        const value = input.value.trim();
        if (!value) return;
        if (calendarTasks.length >= 100) {
          input.setCustomValidity("You can have up to 100 tasks.");
          input.reportValidity();
          return;
        }
        calendarTasks.push({id:crypto.randomUUID(),text:value,completed:false,dueDate:key});
        input.value = "";
        input.setCustomValidity("");
        queueCalendarTasksSync();
        if (key === todayKey) {
          void saveCalendarDaySnapshot(todayKey,calendarTasks.filter(item => !item.dueDate || item.dueDate <= todayKey).map(item => ({
            id:item.id,text:item.text,completed:item.completedAt === todayKey
          })),false);
        }
        renderCalendarDetails();
      });
      tasksMain.append(form);
    }
    if (dayTasks.length) {
      for (const task of dayTasks) {
        const row = document.createElement("div");
        row.className = "calendar-task-row" + (task.completedAt === key ? " completed" : "");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = task.completedAt === key;
        checkbox.disabled = key > todayKey || (key === todayKey && daySnapshot?.locked === true);
        checkbox.setAttribute("aria-label", "Mark " + task.text + " as completed");
        checkbox.addEventListener("change", () => updateCalendarTask(task, checkbox.checked));
        const label = document.createElement("span");
        label.className = "calendar-task-label";
        label.textContent = task.text;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "calendar-task-remove";
        remove.textContent = "×";
        remove.title = "Remove task";
        remove.disabled = key === todayKey && daySnapshot?.locked === true;
        remove.setAttribute("aria-label", "Remove task: " + task.text);
        remove.addEventListener("click", () => removeCalendarTask(task));
        row.append(checkbox, label, remove);
        tasksEmpty.append(row);
      }
    } else {
      const empty = document.createElement("p");
      empty.className = "calendar-details-empty";
      empty.textContent = !calendarTasksLoaded ? "Tasks could not be loaded." : (key > todayKey ? "No tasks planned for this day yet." : "No tasks for this day yet.");
      tasksEmpty.append(empty);
    }
    if (daySnapshot?.locked) {
      const status = document.createElement("span");
      status.className = "calendar-task-locked-status";
      status.textContent = "Day locked";
      tasksEmpty.append(status);
    }
    tasksSection.append(tasksMain, tasksEmpty);
  }
  content.append(tasksSection);
  if (key <= todayKey) {
    renderCalendarHourlyGraph(panel, key);
    const dailyDistribution=document.createElement("section");
    dailyDistribution.className="calendar-daily-distribution subject-distribution";
    dailyDistribution.setAttribute("aria-labelledby","calendar-subject-distribution-title");
    const distributionHeading=document.createElement("div");
    distributionHeading.className="subject-distribution-heading";
    const distributionTitle=document.createElement("strong");
    distributionTitle.id="calendar-subject-distribution-title";
    distributionTitle.textContent="Distribution";
    const distributionDate=document.createElement("span");
    distributionDate.id="calendar-subject-distribution-date";
    distributionHeading.append(distributionTitle,distributionDate);
    const distributionContent=document.createElement("div");
    distributionContent.className="subject-distribution-content";
    const distributionSvg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    distributionSvg.id="calendar-subject-distribution-chart";
    distributionSvg.setAttribute("viewBox","0 0 220 220");
    distributionSvg.setAttribute("role","img");
    distributionSvg.setAttribute("aria-label","Subject study time distribution for this day");
    const distributionLegend=document.createElement("div");
    distributionLegend.id="calendar-subject-distribution-legend";
    distributionLegend.className="subject-distribution-legend";
    distributionContent.append(distributionSvg,distributionLegend);
    dailyDistribution.append(distributionHeading,distributionContent);
    panel.append(dailyDistribution);
    renderSubjectDistribution(dailySubjects,key,selectedCalendarDate.getFullYear(),selectedCalendarDate.getMonth(),{
      exactDate:true,
      label:selectedCalendarDate.toLocaleDateString(undefined,{month:"long",day:"numeric",year:"numeric"}),
      emptyLabel:"this day",
      svgId:"calendar-subject-distribution-chart",
      legendId:"calendar-subject-distribution-legend",
      labelId:"calendar-subject-distribution-date"
    });
  }
  panel.hidden = false;
}
function removeCalendarTask(task) {
  calendarTasks = calendarTasks.filter(item => item.id !== task.id);
  queueCalendarTasksSync();
  const todayKey = calendarDateKey(new Date());
  if (selectedCalendarDate && calendarDateKey(selectedCalendarDate) === todayKey)
    void saveCalendarDaySnapshot(todayKey,calendarTasks.filter(item => !item.dueDate || item.dueDate <= todayKey).map(item => ({
      id:item.id,text:item.text,completed:item.completedAt === todayKey
    })),false);
  renderCalendarDetails();
}
function updateCalendarTask(task, completed) {
  if (calendarTaskDays.find(day => day?.date === calendarDateKey(new Date()))?.locked) return;
  const todayKey = calendarDateKey(new Date());
  task.completed = completed;
  if (completed) task.completedAt = todayKey;
  else delete task.completedAt;
  queueCalendarTasksSync();
  void saveCalendarDaySnapshot(todayKey,calendarTasks.filter(item => !item.dueDate || item.dueDate <= todayKey).map(item => ({
    id:item.id,text:item.text,completed:item.completedAt === todayKey
  })),false);
  renderCalendarDetails();
}
let calendarSlideDirection = 0;
function renderCalendar() {
  const year = calendarDate.getFullYear(), month = calendarDate.getMonth(),
        firstDay = new Date(year, month, 1).getDay(), days = new Date(year, month + 1, 0).getDate(),
        dailyTotals = readDailyTotals();
  $("calendar-month").textContent =
      calendarDate.toLocaleDateString(undefined, {month: "long", year: "numeric"});
  const grid = $("calendar-grid");
  grid.replaceChildren();
  for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
    const el = document.createElement("div");
    el.className = "calendar-weekday";
    el.textContent = day;
    grid.append(el);
  }
  for (let blank = 0; blank < firstDay; blank++) {
    const spacer = document.createElement("div");
    spacer.className = "calendar-day-spacer";
    spacer.setAttribute("aria-hidden", "true");
    grid.append(spacer);
  }
  const today = new Date();
  for (let day = 1; day <= days; day++) {
    const date = new Date(year, month, day), key = calendarDateKey(date),
          studied = Math.max(0, Number(dailyTotals[key]) || 0),
          cell = document.createElement("button"), number = document.createElement("span"),
          time = document.createElement("span");
    cell.type = "button";
    cell.className = "calendar-day";
    if (studied > 0) {
      cell.classList.add("has-study");
      cell.style.setProperty("--study-level", String(Math.min(4, Math.max(1, Math.ceil(studied / 1800000)))));
    }
    if (selectedCalendarDate && key === calendarDateKey(selectedCalendarDate))
      cell.classList.add("selected");
    if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate()) cell.classList.add("today");
    number.className = "calendar-day-number";
    number.textContent = String(day);
    time.className = "calendar-day-time";
    time.textContent = studied > 0 ? formatCalendarTime(studied) : "";
    cell.append(number, time);
    cell.dataset.date = key;
    cell.setAttribute("aria-label", date.toLocaleDateString(undefined, {dateStyle:"full"}) +
      ", studied " + formatCalendarTime(studied));
    cell.setAttribute("aria-pressed", String(Boolean(selectedCalendarDate && key === calendarDateKey(selectedCalendarDate))));
    grid.append(cell);
  }
  if (calendarSlideDirection) {
    const direction = calendarSlideDirection;
    calendarSlideDirection = 0;
    const enteringFrom = direction > 0 ? "28px" : "-28px";
    const keyframes = [{transform:"translateX(" + enteringFrom + ")",opacity:0.45},{transform:"translateX(0)",opacity:1}];
    const options = {duration:260,easing:"cubic-bezier(.22,.75,.25,1)"};
    $("calendar-grid").animate(keyframes, options);
    $("calendar-month").animate(keyframes, options);
  }
  renderCalendarDetails();
}
let calendarPointerStart = null;
let calendarSwipeHandled = false;
$("calendar-grid").addEventListener("click", event => {
  if (calendarSwipeHandled) {
    calendarSwipeHandled = false;
    event.preventDefault();
    return;
  }
  const cell = event.target.closest("button.calendar-day[data-date]");
  if (!cell) return;
  const [year, month, day] = cell.dataset.date.split("-").map(Number);
  selectedCalendarDate = new Date(year, month - 1, day);
  calendarDate = new Date(year, month - 1, 1);
  renderCalendar();
});
$("calendar-grid").addEventListener("pointerdown", event => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  calendarPointerStart = {x:event.clientX, y:event.clientY};
});
$("calendar-grid").addEventListener("pointerup", event => {
  if (!calendarPointerStart) return;
  const dx = event.clientX - calendarPointerStart.x, dy = event.clientY - calendarPointerStart.y;
  calendarPointerStart = null;
  if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
  calendarSwipeHandled = true;
  const direction = dx < 0 ? 1 : -1;
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + direction, 1);
  selectedCalendarDate = null;
  calendarSlideDirection = direction;
  renderCalendar();
});
$("calendar-grid").addEventListener("pointercancel", () => calendarPointerStart = null);
$("calendar-grid").addEventListener("wheel", event => {
  if (Math.abs(event.deltaX) < 25 || Math.abs(event.deltaX) < Math.abs(event.deltaY)) return;
  event.preventDefault();
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + (event.deltaX > 0 ? 1 : -1), 1);
  selectedCalendarDate = null;
  renderCalendar();
}, {passive:false});

// From Uiverse.io by ashif_6672 - https://uiverse.io/ashif_6672/nice-warthog-84
// MIT License, Copyright (c) ashif_6672 (Ashif)
// Bucket summary and expandable folder tree.
let analyticsBucketItems = [];
let analyticsBucketRootId = null;
let selectedAnalyticsBucketId = null;
function createBucketTreeIcon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("class",kind === "file" ? "icon" : "icon " + (kind === "open" ? "folder-open-icon" : "folder-closed-icon"));
  svg.setAttribute("xmlns","http://www.w3.org/2000/svg");
  svg.setAttribute("viewBox","0 0 24 24");
  svg.setAttribute("fill","none");
  svg.setAttribute("stroke","currentColor");
  svg.setAttribute("stroke-width","2");
  svg.setAttribute("stroke-linecap","round");
  svg.setAttribute("stroke-linejoin","round");
  const path=document.createElementNS("http://www.w3.org/2000/svg","path");
  if(kind==="file"){
    path.setAttribute("d","M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z");
    const line=document.createElementNS("http://www.w3.org/2000/svg","polyline");
    line.setAttribute("points","14 2 14 8 20 8");
    svg.append(path,line);
  } else {
    path.setAttribute("d","M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z");
    svg.append(path);
    if(kind==="open"){
      const line=document.createElementNS("http://www.w3.org/2000/svg","path");
      line.setAttribute("d","M2 10h20");
      svg.append(line);
    }
  }
  return svg;
}
function renderBucketTreeNode(item,childrenByParent,depth=0){
  const li=document.createElement("li");
  li.className="tree-item";
  li.dataset.itemId=item.id;
  li.dataset.itemType=item.item_type;
  if(item.item_type==="folder"){
    const toggle=document.createElement("input");
    toggle.type="checkbox";
    toggle.className="tree-toggle";
    toggle.checked=depth===0;
    toggle.id="bucket-tree-toggle-"+String(item.id).replace(/[^a-zA-Z0-9_-]/g,"");
    const label=document.createElement("label");
    label.className="tree-label";
    label.htmlFor=toggle.id;
    label.dataset.itemId=item.id;
    label.style.setProperty("--item-folder-colour",item.folder_color||"transparent");
    const closedIcon=createBucketTreeIcon("closed");
    const openIcon=createBucketTreeIcon("open");
    if(item.folder_color){
      closedIcon.style.color=item.folder_color;
      openIcon.style.color=item.folder_color;
    }
    label.append(closedIcon,openIcon,document.createTextNode(item.name));
    const wrapper=document.createElement("div");
    wrapper.className="tree-children-wrapper";
    const children=document.createElement("ul");
    children.className="tree-children";
    for(const child of childrenByParent.get(item.id)||[])
      children.append(renderBucketTreeNode(child,childrenByParent,depth+1));
    wrapper.append(children);
    li.append(toggle,label,wrapper);
  } else {
    const file=document.createElement("div");
    file.className="file-item";
    file.dataset.itemId=item.id;
    file.append(createBucketTreeIcon("file"),document.createTextNode(item.name));
    li.append(file);
  }
  return li;
}function bucketDescendantIds(bucketId){
  const descendants=new Set([bucketId]);
  let changed=true;
  while(changed){
    changed=false;
    for(const item of analyticsBucketItems){
      if(item.parent_id && descendants.has(item.parent_id) && !descendants.has(item.id)){
        descendants.add(item.id);
        changed=true;
      }
    }
  }
  return descendants;
}
function renderBucketStructure(){
  const tree=$("bucket-tree");
  tree.replaceChildren();
  const buckets=analyticsBucketItems.filter(item=>item.item_type==="folder"&&item.parent_id===analyticsBucketRootId);
  if(!buckets.length){
    const empty=document.createElement("p");
    empty.className="empty";
    empty.textContent="You have not created any buckets yet.";
    tree.append(empty);
    return;
  }
  const grid=document.createElement("div");
  grid.className="bucket-tree-grid";
  for(const bucket of buckets){
    const descendants=bucketDescendantIds(bucket.id);
    const childrenByParent=new Map();
    for(const item of analyticsBucketItems){
      if(!descendants.has(item.id)||item.parent_id==null) continue;
      if(!childrenByParent.has(item.parent_id)) childrenByParent.set(item.parent_id,[]);
      childrenByParent.get(item.parent_id).push(item);
    }
    for(const children of childrenByParent.values()){
      children.sort((left,right)=>(left.item_type==="folder"?0:1)-(right.item_type==="folder"?0:1)||
        Number(left.sort_order||0)-Number(right.sort_order||0)||left.name.localeCompare(right.name));
    }
    const card=document.createElement("div");
    card.className="bucket-tree-card";
    card.style.setProperty("--bucket-colour",bucket.folder_color||"#e5e7eb");
    const rootList=document.createElement("ul");
    rootList.append(renderBucketTreeNode(bucket,childrenByParent));
    card.append(rootList);
    grid.append(card);
  }
  tree.append(grid);
}
async function loadSharedBucketStructures(){
  const target=$("shared-bucket-tree");
  if(!target)return;
  target.replaceChildren();
  try{
    const result=await bucketAction("shared_buckets_list");
    const shares=Array.isArray(result?.buckets)?result.buckets:[];
    if(!shares.length){
      const empty=document.createElement("p");
      empty.className="empty";
      empty.textContent="No buckets have been shared with you yet.";
      target.append(empty);
      return;
    }
    const grid=document.createElement("div");
    grid.className="bucket-tree-grid shared-bucket-tree-grid";
    const opened=await Promise.all(shares.map(async bucket=>{
      try{
        const data=await bucketAction("shared_bucket_open",{bucketId:bucket.id});
        return {bucket,items:Array.isArray(data?.items)?data.items:[]};
      }catch(error){
        return {bucket,error};
      }
    }));
    for(const entry of opened){
      const owner=document.createElement("h4");
      owner.className="shared-bucket-owner-heading";
      owner.textContent=(entry.bucket.ownerUsername||"Coolanas user")+"’s bucket";
      const wrapper=document.createElement("section");
      wrapper.className="shared-bucket-structure";
      wrapper.append(owner);
      if(entry.error){
        const error=document.createElement("p");
        error.className="empty";
        error.textContent="Could not load this shared bucket: "+entry.error.message;
        wrapper.append(error);
        grid.append(wrapper);
        continue;
      }
      const root=entry.items.find(item=>item.id===entry.bucket.id&&item.item_type==="folder");
      if(!root){
        const error=document.createElement("p");
        error.className="empty";
        error.textContent="This shared bucket is currently unavailable.";
        wrapper.append(error);
        grid.append(wrapper);
        continue;
      }
      const descendants=new Set([root.id]);
      let changed=true;
      while(changed){
        changed=false;
        for(const item of entry.items){
          if(item.parent_id&&descendants.has(item.parent_id)&&!descendants.has(item.id)){
            descendants.add(item.id);
            changed=true;
          }
        }
      }
      const childrenByParent=new Map();
      for(const item of entry.items){
        if(!descendants.has(item.id)||item.parent_id==null)continue;
        if(!childrenByParent.has(item.parent_id))childrenByParent.set(item.parent_id,[]);
        childrenByParent.get(item.parent_id).push(item);
      }
      for(const children of childrenByParent.values()){
        children.sort((left,right)=>(left.item_type==="folder"?0:1)-(right.item_type==="folder"?0:1)||
          Number(left.sort_order||0)-Number(right.sort_order||0)||left.name.localeCompare(right.name));
      }
      const card=document.createElement("div");
      card.className="bucket-tree-card shared-bucket-tree-card";
      card.style.setProperty("--bucket-colour",entry.bucket.folder_color||root.folder_color||"#e5e7eb");
      const rootList=document.createElement("ul");
      rootList.append(renderBucketTreeNode(root,childrenByParent));
      card.append(rootList);
      wrapper.append(card);
      grid.append(wrapper);
    }
    target.append(grid);
  }catch(error){
    const message=document.createElement("p");
    message.className="empty";
    message.textContent=error.message||"Could not load shared buckets.";
    target.append(message);
  }
}
// Bucket item actions, queued metadata changes, and folder uploads.
async function bucketAction(action,payload={}){
  const retryable=new Set([408,425,429,500,502,503,504]);
  for(let attempt=1;attempt<=4;attempt++){
    const {data,error}=await supabase.functions.invoke("coolanas-files-b2",{body:{action,...payload}});
    if(!error&&!data?.error)return data;
    const status=Number(error?.context?.status)||0;
    const message=data?.error||error?.message||"Bucket request failed.";
    if(attempt===4||(!retryable.has(status)&&status!==0))throw new Error(message);
    await new Promise(resolve=>setTimeout(resolve,500*attempt));
  }
  throw new Error("Bucket request failed.");
}
const bucketSyncDb=new Promise((resolve,reject)=>{
  const request=indexedDB.open("coolanas-analytics-bucket-sync",1);
  request.onupgradeneeded=()=>{
    if(!request.result.objectStoreNames.contains("mutations"))
      request.result.createObjectStore("mutations",{keyPath:"id"});
  };
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error||new Error("Could not open bucket sync queue."));
});
async function bucketQueueRead(){
  const db=await bucketSyncDb;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("mutations","readonly");
    const req=tx.objectStore("mutations").getAll();
    req.onsuccess=()=>resolve(req.result||[]);
    req.onerror=()=>reject(req.error||new Error("Could not read bucket changes."));
  });
}
async function bucketQueueWrite(mutation){
  const db=await bucketSyncDb;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("mutations","readwrite");
    const store=tx.objectStore("mutations");
    const req=store.getAll();
    req.onsuccess=()=>{
      const existing=(req.result||[]).filter(entry=>entry.userId===session.user.id&&entry.itemId===mutation.itemId);
      if(mutation.type==="delete"){
        existing.forEach(entry=>store.delete(entry.id));
        store.put(mutation);
      }else{
        if(existing.some(entry=>entry.type==="delete"))return;
        const prior=existing.find(entry=>entry.type==="patch");
        existing.filter(entry=>entry!==prior).forEach(entry=>store.delete(entry.id));
        if(prior)store.put({...prior,changes:{...(prior.changes||{}),...(mutation.changes||{})}});
        else store.put(mutation);
      }
    };
    req.onerror=()=>reject(req.error||new Error("Could not read pending bucket changes."));
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error||new Error("Could not save bucket change."));
    tx.onabort=()=>reject(tx.error||new Error("Bucket change was not saved."));
  });
}
async function bucketQueueRemove(id){
  const db=await bucketSyncDb;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("mutations","readwrite");
    tx.objectStore("mutations").delete(id);
    tx.oncomplete=resolve;
    tx.onerror=()=>reject(tx.error||new Error("Could not clear synced bucket change."));
  });
}
let bucketFlushPromise=null;
async function flushBucketChanges(){
  if(bucketFlushPromise)return bucketFlushPromise;
  bucketFlushPromise=(async()=>{
    const pending=(await bucketQueueRead()).filter(entry=>entry.userId===session.user.id).sort((a,b)=>a.createdAt-b.createdAt);
    for(const entry of pending){
      if(entry.type==="delete")await bucketAction("delete",{id:entry.itemId});
      else{
        if(typeof entry.changes?.name==="string")
          await bucketAction("rename",{id:entry.itemId,name:entry.changes.name});
        const metadata={...entry.changes};
        delete metadata.name;
        if(Object.keys(metadata).length)
          await bucketAction("update_metadata",{id:entry.itemId,...metadata});
      }
      await bucketQueueRemove(entry.id);
    }
  })().catch(error=>{
    console.warn("Bucket changes remain queued until the next sync:",error.message);
  }).finally(()=>{bucketFlushPromise=null;});
  return bucketFlushPromise;
}
async function queueBucketChange(type,itemId,changes={}){
  const mutation={id:crypto.randomUUID(),userId:session.user.id,type,itemId,changes,createdAt:Date.now()};
  await bucketQueueWrite(mutation);
  if(type==="delete"){
    const removed=bucketDescendantIds(itemId);
    analyticsBucketItems=analyticsBucketItems.filter(item=>!removed.has(item.id));
  }else{
    const item=analyticsBucketItems.find(value=>value.id===itemId);
    if(item)Object.assign(item,changes);
  }
  renderBucketStructure();
  updateBucketCounts();
}
function updateBucketCounts(){
  const buckets=analyticsBucketItems.filter(item=>item.item_type==="folder"&&item.parent_id===analyticsBucketRootId);
  const ids=new Set();
  for(const bucket of buckets)for(const id of bucketDescendantIds(bucket.id))ids.add(id);
  $("bucket-count").textContent=String(buckets.length);
  $("file-count").textContent=String(analyticsBucketItems.filter(item=>item.item_type==="file"&&ids.has(item.id)).length);
}
window.setInterval(()=>{void flushBucketChanges();},5000);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden")void flushBucketChanges();});
window.addEventListener("pagehide",()=>{void flushBucketChanges();});

const bucketMenu=document.createElement("div");
bucketMenu.className="bucket-context-menu";
bucketMenu.hidden=true;
bucketMenu.setAttribute("role","menu");
document.body.append(bucketMenu);
let bucketMenuItem=null;
function hideBucketMenu(){
  bucketMenu.classList.remove("is-open");
  bucketMenu.hidden=true;
  bucketMenuItem=null;
}
function addBucketMenuButton(label,action,danger=false){
  const button=document.createElement("button");
  button.type="button";
  button.className="bucket-menu-action"+(danger?" danger":"");
  button.textContent=label;
  button.dataset.action=action;
  button.setAttribute("role","menuitem");
  bucketMenu.append(button);
  return button;
}
function showBucketMenu(item,x,y){
  bucketMenuItem=item;
  bucketMenu.replaceChildren();
  if(item.item_type==="folder"){
    addBucketMenuButton("Add file","add-file");
    addBucketMenuButton("Add folder","add-folder");
    addBucketMenuButton("Drag & drop","drag-drop");
    const divider=document.createElement("div");
    divider.className="bucket-menu-divider";
    bucketMenu.append(divider);
  }
  addBucketMenuButton("Rename","rename");
  if(item.item_type==="folder"){
    const colorButton=addBucketMenuButton("Colour","colour");
    const palette=document.createElement("div");
    palette.className="bucket-menu-palette";
    palette.hidden=true;
    for(const color of ["#e6b325","#3b82f6","#22a06b","#a855f7","#ef4444","#6b7280"]){
      const choice=document.createElement("button");
      choice.type="button";
      choice.className="bucket-menu-color";
      choice.dataset.color=color;
      choice.style.setProperty("--swatch",color);
      choice.title=color;
      choice.setAttribute("aria-label","Set folder colour "+color);
      palette.append(choice);
    }
    bucketMenu.append(palette);
    colorButton.addEventListener("click",()=>{palette.hidden=!palette.hidden;});
  }
  const divider=document.createElement("div");
  divider.className="bucket-menu-divider";
  bucketMenu.append(divider);
  addBucketMenuButton("Delete","delete",true);
  bucketMenu.hidden=false;
  bucketMenu.style.left="0px";
  bucketMenu.style.top="0px";
  bucketMenu.classList.remove("is-open");
  requestAnimationFrame(()=>{
    const rect=bucketMenu.getBoundingClientRect();
    bucketMenu.style.left=Math.max(8,Math.min(x,innerWidth-rect.width-8))+"px";
    bucketMenu.style.top=Math.max(8,Math.min(y,innerHeight-rect.height-8))+"px";
    requestAnimationFrame(()=>bucketMenu.classList.add("is-open"));
  });
}
const bucketTree=$("bucket-tree");
bucketTree.addEventListener("contextmenu",event=>{
  const node=event.target.closest(".tree-item[data-item-id]");
  if(!node)return;
  const item=analyticsBucketItems.find(value=>value.id===node.dataset.itemId);
  if(!item)return;
  event.preventDefault();
  showBucketMenu(item,event.clientX,event.clientY);
});
bucketTree.addEventListener("click",async event=>{
  const file=event.target.closest(".file-item[data-item-id]");
  if(!file)return;
  const item=analyticsBucketItems.find(value=>value.id===file.dataset.itemId);
  if(!item)return;
  const tab=window.open("about:blank","_blank");
  try{
    const result=await bucketAction("file_preview",{id:item.id});
    if(tab)tab.location=result.downloadUrl;
    else location.assign(result.downloadUrl);
  }catch(error){
    if(tab)tab.close();
    alert("Could not open file: "+error.message);
  }
});
document.addEventListener("click",async event=>{
  if(!bucketMenu.hidden&&!event.target.closest(".bucket-context-menu"))hideBucketMenu();
  const actionButton=event.target.closest(".bucket-menu-action,.bucket-menu-color");
  if(!actionButton||bucketMenu.hidden||!bucketMenuItem)return;
  event.preventDefault();
  event.stopPropagation();
  const item=bucketMenuItem;
  const action=actionButton.dataset.action;
  if(action==="colour"||actionButton.dataset.color)return;
  hideBucketMenu();
  if(action==="drag-drop"){
    openBucketUpload(item);
  }else if(action==="add-file"){
    bucketUploadTarget=item;
    bucketFilePicker.click();
  }else if(action==="add-folder"){
    bucketUploadTarget=item;
    bucketFolderPicker.click();
  }else if(action==="rename"){
    const name=prompt("Rename item",item.name);
    if(!name?.trim()||name.trim()===item.name)return;
    try{await queueBucketChange("patch",item.id,{name:name.trim()});}
    catch(error){alert("Could not queue rename: "+error.message);}
  }else if(action==="delete"){
    if(!confirm("Delete “"+item.name+"”"+(item.item_type==="folder"?" and everything inside it":"")+"?"))return;
    try{await queueBucketChange("delete",item.id);}
    catch(error){alert("Could not queue deletion: "+error.message);}
  }
});
bucketMenu.addEventListener("click",async event=>{
  const choice=event.target.closest(".bucket-menu-color[data-color]");
  if(!choice||!bucketMenuItem)return;
  const item=bucketMenuItem;
  const color=choice.dataset.color;
  hideBucketMenu();
  try{await queueBucketChange("patch",item.id,{folder_color:color});}
  catch(error){alert("Could not queue folder colour: "+error.message);}
});
document.addEventListener("keydown",event=>{if(event.key==="Escape"){hideBucketMenu();closeBucketUpload();}});

const bucketUploadOverlay=document.createElement("div");
bucketUploadOverlay.className="bucket-upload-overlay";
bucketUploadOverlay.hidden=true;
bucketUploadOverlay.innerHTML='<section class="bucket-upload-panel" role="dialog" aria-modal="true" aria-labelledby="bucket-upload-title"><header><div><h2 id="bucket-upload-title">Upload to folder</h2><p id="bucket-upload-target"></p></div></header><div class="bucket-drop-zone" tabindex="0"><div class="bucket-drop-icon">↑</div><strong>Drag files or folders here</strong><p class="bucket-upload-status" aria-live="polite"> </p></div></section>';
document.body.append(bucketUploadOverlay);
const bucketFilePicker=document.createElement("input");
bucketFilePicker.type="file";bucketFilePicker.multiple=true;bucketFilePicker.hidden=true;
const bucketFolderPicker=document.createElement("input");
bucketFolderPicker.type="file";bucketFolderPicker.multiple=true;bucketFolderPicker.setAttribute("webkitdirectory","");
bucketFolderPicker.hidden=true;
document.body.append(bucketFilePicker,bucketFolderPicker);
let bucketUploadTarget=null,bucketUploadBusy=false;
function closeBucketUpload(){
  if(bucketUploadBusy)return;
  bucketUploadOverlay.hidden=true;
  bucketUploadTarget=null;
  bucketFilePicker.value="";
  bucketFolderPicker.value="";
}
function openBucketUpload(folder){
  bucketUploadTarget=folder;
  $("bucket-upload-target").textContent="Destination: "+folder.name;
  bucketUploadOverlay.hidden=false;
  bucketUploadOverlay.querySelector(".bucket-upload-status").textContent=" ";
}
bucketUploadOverlay.addEventListener("click",event=>{if(event.target===bucketUploadOverlay)closeBucketUpload();});
const bucketDropZone=bucketUploadOverlay.querySelector(".bucket-drop-zone");
bucketDropZone.addEventListener("dragover",event=>{event.preventDefault();bucketDropZone.classList.add("drag-active");});
bucketDropZone.addEventListener("dragleave",event=>{if(!bucketDropZone.contains(event.relatedTarget))bucketDropZone.classList.remove("drag-active");});
bucketDropZone.addEventListener("drop",async event=>{
  event.preventDefault();bucketDropZone.classList.remove("drag-active");
  if(event.dataTransfer?.files?.length)await uploadBucketEntries(await extractBucketEntries(event.dataTransfer),bucketUploadTarget?.id);
});
bucketFilePicker.addEventListener("change",async()=>{
  const entries=[...bucketFilePicker.files].map(file=>({file,path:file.name}));
  await uploadBucketEntries(entries,bucketUploadTarget?.id);bucketFilePicker.value="";
});
bucketFolderPicker.addEventListener("change",async()=>{
  const entries=[...bucketFolderPicker.files].map(file=>({file,path:file.webkitRelativePath||file.name}));
  await uploadBucketEntries(entries,bucketUploadTarget?.id);bucketFolderPicker.value="";
});
async function readBucketDirectory(entry,path,output){
  if(entry.isFile){
    const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));
    output.push({file,path:path+entry.name});return;
  }
  if(entry.isDirectory){
    const reader=entry.createReader();
    while(true){
      const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));
      if(!batch.length)break;
      for(const child of batch)await readBucketDirectory(child,path+entry.name+"/",output);
    }
  }
}
async function extractBucketEntries(dataTransfer){
  const output=[];
  const entries=[...(dataTransfer.items||[])].filter(item=>item.kind==="file").map(item=>item.webkitGetAsEntry?.()).filter(Boolean);
  if(entries.length){for(const entry of entries)await readBucketDirectory(entry,"",output);}
  else for(const file of [...(dataTransfer.files||[])])output.push({file,path:file.name});
  return output;
}
async function uploadBucketEntries(entries,parentId){
  if(!parentId||!entries.length||bucketUploadBusy)return;
  bucketUploadBusy=true;
  const status=bucketUploadOverlay.querySelector(".bucket-upload-status");
  const popupVisible=!bucketUploadOverlay.hidden;
  const folderCache=new Map();
  let uploaded=0;
  try{
    for(const entry of entries){
      const parts=(entry.path||entry.file.name).split("/").filter(Boolean);
      if(!parts.length)continue;
      let parent=parentId;
      for(let index=0;index<parts.length-1;index++){
        const cacheKey=parent+":"+parts[index];
        if(!folderCache.has(cacheKey)){
          let folder=analyticsBucketItems.find(value=>value.item_type==="folder"&&value.parent_id===parent&&value.name===parts[index]);
          if(!folder){
            const result=await bucketAction("create_folder",{parentId:parent,name:parts[index]});
            folder=result.item;analyticsBucketItems.push(folder);
          }
          folderCache.set(cacheKey,folder.id);
        }
        parent=folderCache.get(cacheKey);
      }
      const name=parts[parts.length-1];
      status.textContent="Uploading "+(uploaded+1)+" of "+entries.length+": "+name;
      const created=await bucketAction("create_upload",{parentId:parent,name,contentType:entry.file.type||"application/octet-stream"});
      try{
        const response=await fetch(created.uploadUrl,{method:"PUT",headers:{"Content-Type":created.contentType},body:entry.file});
        if(!response.ok)throw new Error("Upload failed for "+name+" (HTTP "+response.status+").");
        await bucketAction("finish_upload",{id:created.item.id});
        analyticsBucketItems.push(created.item);
      }catch(error){
        await bucketAction("delete",{id:created.item.id}).catch(()=>{});
        throw error;
      }
      uploaded++;
    }
    status.textContent="Uploaded "+uploaded+" item(s) successfully.";
    if(!popupVisible)alert("Uploaded "+uploaded+" item(s) into "+(analyticsBucketItems.find(item=>item.id===parentId)?.name||"the selected folder")+".");
    renderBucketStructure();updateBucketCounts();
    setTimeout(()=>{if(!bucketUploadBusy)closeBucketUpload();},900);
  }catch(error){
    status.textContent="Upload stopped: "+error.message;
    if(!popupVisible)alert("Upload stopped: "+error.message);
    renderBucketStructure();updateBucketCounts();
  }finally{bucketUploadBusy=false;}
}
async function loadBuckets(){
  const list=$("bucket-list");
  try{
    if(!analyticsBucketRootId){
      const {data:structure,error:structureError}=await supabase.functions.invoke(
        "coolanas-files-b2",{body:{action:"ensure_structure"}});
      if(structureError||structure?.error)throw new Error(structure?.error||structureError.message);
      analyticsBucketRootId=structure?.exhibitionsId||null;
    }
    const {data,error}=await supabase.functions.invoke(
      "coolanas-files-b2",{body:{action:"list"}});
    if(error||data?.error)throw new Error(data?.error||error.message);
    analyticsBucketItems=Array.isArray(data?.items)?data.items:[];
    const pendingBucketChanges=await bucketQueueRead().catch(()=>[]);
    for(const pending of pendingBucketChanges.filter(entry=>entry.userId===session.user.id).sort((a,b)=>a.createdAt-b.createdAt)){
      if(pending.type==="delete"){
        const removed=bucketDescendantIds(pending.itemId);
        analyticsBucketItems=analyticsBucketItems.filter(item=>!removed.has(item.id));
      }else{
        const item=analyticsBucketItems.find(value=>value.id===pending.itemId);
        if(item)Object.assign(item,pending.changes||{});
      }
    }
    const buckets=analyticsBucketItems.filter(item=>item.item_type==="folder"&&item.parent_id===analyticsBucketRootId);
    const allBucketDescendants=new Set();
    for(const bucket of buckets)
      for(const id of bucketDescendantIds(bucket.id)) allBucketDescendants.add(id);
    const files=analyticsBucketItems.filter(item=>item.item_type==="file"&&allBucketDescendants.has(item.id));
    $("bucket-count").textContent=String(buckets.length);
    $("file-count").textContent=String(files.length);
    list.replaceChildren();
    renderBucketStructure();
    void loadSharedBucketStructures();
  }catch(error){
    $("bucket-count").textContent="—";
    $("file-count").textContent="—";
    list.replaceChildren();
    $("bucket-tree").textContent=error.message||"Could not load your buckets.";
  }
}
renderTimer();
renderMonthlyChart();
void loadCloudAnalytics();
renderCalendar();
void loadCalendarSubjectColours().then(renderCalendarDetails);
void loadCalendarTasks().then(renderCalendarDetails);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void loadCalendarTasks().then(renderCalendarDetails); });
window.addEventListener("focus", () => { void loadCalendarTasks().then(renderCalendarDetails); });
loadBuckets();
setInterval(() => {
  renderTimer();
  renderMonthlyChart();
  renderCalendar();
}, 15000);
setInterval(() => {
  void loadCloudAnalytics();
}, 5000);
setInterval(loadBuckets, 60000);
