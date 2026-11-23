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
  if(item.item_type==="folder"){
    const toggle=document.createElement("input");
    toggle.type="checkbox";
    toggle.className="tree-toggle";
    toggle.checked=depth===0;
    toggle.id="bucket-tree-toggle-"+String(item.id).replace(/[^a-zA-Z0-9_-]/g,"");
    const label=document.createElement("label");
    label.className="tree-label";
    label.htmlFor=toggle.id;
    label.append(createBucketTreeIcon("closed"),createBucketTreeIcon("open"),document.createTextNode(item.name));
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
    file.append(createBucketTreeIcon("file"),document.createTextNode(item.name));
    li.append(file);
  }
  return li;
}
function bucketDescendantIds(bucketId){
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
  const picker=$("bucket-structure-picker"),tree=$("bucket-tree");
  picker.replaceChildren();
  tree.replaceChildren();
  const buckets=analyticsBucketItems.filter(item=>item.item_type==="folder"&&item.parent_id===analyticsBucketRootId);
  if(!buckets.length){
    const empty=document.createElement("p");
    empty.className="empty";
    empty.textContent="You have not created any buckets yet.";
    tree.append(empty);
    tree.style.removeProperty("--bucket-colour");
    return;
  }
  if(!buckets.some(item=>item.id===selectedAnalyticsBucketId))
    selectedAnalyticsBucketId=buckets[0].id;
  for(const bucket of buckets){
    const button=document.createElement("button");
    button.type="button";
    button.className="bucket-structure-choice"+(bucket.id===selectedAnalyticsBucketId?" selected":"");
    button.dataset.bucketId=bucket.id;
    button.style.setProperty("--bucket-colour",bucket.folder_color||"#e5e7eb");
    const name=document.createElement("span");
    name.textContent=bucket.name;
    button.append(name);
    button.setAttribute("aria-pressed",String(bucket.id===selectedAnalyticsBucketId));
    picker.append(button);
  }
  const selected=buckets.find(item=>item.id===selectedAnalyticsBucketId);
  tree.style.setProperty("--bucket-colour",selected.folder_color||"#e5e7eb");
  const descendants=bucketDescendantIds(selected.id);
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
  const rootList=document.createElement("ul");
  rootList.append(renderBucketTreeNode(selected,childrenByParent));
  tree.append(rootList);
}
$("bucket-structure-picker").addEventListener("click",event=>{
  const choice=event.target.closest("button[data-bucket-id]");
  if(!choice)return;
  selectedAnalyticsBucketId=choice.dataset.bucketId;
  renderBucketStructure();
});
async function loadBuckets(){
  const list=$("bucket-list");
  try{
    const {data:structure,error:structureError}=await supabase.functions.invoke(
      "coolanas-files-b2",{body:{action:"ensure_structure"}});
    if(structureError||structure?.error)throw new Error(structure?.error||structureError.message);
    const {data,error}=await supabase.functions.invoke(
      "coolanas-files-b2",{body:{action:"list"}});
    if(error||data?.error)throw new Error(data?.error||error.message);
    analyticsBucketRootId=structure?.exhibitionsId||null;
    analyticsBucketItems=Array.isArray(data?.items)?data.items:[];
    const buckets=analyticsBucketItems.filter(item=>item.item_type==="folder"&&item.parent_id===analyticsBucketRootId);
    const allBucketDescendants=new Set();
    for(const bucket of buckets)
      for(const id of bucketDescendantIds(bucket.id)) allBucketDescendants.add(id);
    const files=analyticsBucketItems.filter(item=>item.item_type==="file"&&allBucketDescendants.has(item.id));
    $("bucket-count").textContent=String(buckets.length);
    $("file-count").textContent=String(files.length);
    list.replaceChildren();
    renderBucketStructure();
  }catch(error){
    $("bucket-count").textContent="—";
    $("file-count").textContent="—";
    list.replaceChildren();
    $("bucket-structure-picker").replaceChildren();
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
}, 60000);
setInterval(loadBuckets, 60000);
