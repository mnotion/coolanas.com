(()=>{
  const DB_NAME="coolanas-background-uploads",STORE="tasks";
  const SUPABASE_URL="https://nacwftrsdpglzrhasmit.supabase.co";
  const SUPABASE_KEY="sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
  let registration=null,dbPromise=null,lastTasks=[];
  const style=document.createElement("style");
  style.textContent=`
    #coolanas-upload-status{position:fixed;z-index:2147483000;left:50%;bottom:18px;transform:translateX(-50%);width:min(440px,calc(100vw - 28px));padding:12px 14px;background:var(--upload-bg,#fff);color:var(--upload-fg,#222);border:1px solid rgba(120,120,120,.22);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.16);font:13px/1.4 system-ui,-apple-system,sans-serif;display:none}
    #coolanas-upload-status.visible{display:block}
    #coolanas-upload-status .cu-top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:7px;font-weight:650}
    #coolanas-upload-status .cu-track{height:6px;border-radius:8px;background:rgba(120,120,120,.2);overflow:hidden}
    #coolanas-upload-status .cu-fill{height:100%;width:0;background:#4778ee;transition:width .2s}
    #coolanas-upload-status .cu-bottom{display:flex;justify-content:space-between;gap:10px;margin-top:6px;color:inherit;opacity:.72;font-size:11px}
    #coolanas-upload-status button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
    @media(prefers-color-scheme:dark){#coolanas-upload-status{--upload-bg:#242424;--upload-fg:#f5f5f5}}
  `;
  document.head.append(style);
  const panel=document.createElement("section");
  panel.id="coolanas-upload-status";
  panel.setAttribute("role","status");
  panel.setAttribute("aria-live","polite");
  panel.innerHTML='<div class="cu-top"><span class="cu-title">Uploading files</span><button type="button" class="cu-dismiss" aria-label="Dismiss upload status">Hide</button></div><div class="cu-track"><div class="cu-fill"></div></div><div class="cu-bottom"><span class="cu-detail">Preparing uploads…</span><span class="cu-count"></span></div>';
  document.body.append(panel);
  panel.querySelector(".cu-dismiss").addEventListener("click",()=>panel.classList.remove("visible"));
  function openDb(){
    if(!("indexedDB" in window))return Promise.resolve(null);
    if(!dbPromise)dbPromise=new Promise(resolve=>{
      const req=indexedDB.open(DB_NAME,1);
      req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(STORE)){const st=db.createObjectStore(STORE,{keyPath:"id"});st.createIndex("status","status");st.createIndex("batchId","batchId");}};
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>resolve(null);
    });
    return dbPromise;
  }
  async function getTasks(){
    const db=await openDb();if(!db)return [];
    return new Promise(resolve=>{const req=db.transaction(STORE,"readonly").objectStore(STORE).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>resolve([]);});
  }
  async function refresh(){
    const tasks=await getTasks();lastTasks=tasks;
    const active=tasks.filter(t=>t.status==="pending"||t.status==="uploading");
    const failed=tasks.filter(t=>t.status==="failed");
    const completed=tasks.filter(t=>t.status==="complete");
    if(!active.length&&!failed.length){
      panel.classList.remove("visible");
      if(completed.length)setTimeout(async()=>{const db=await openDb();if(!db)return;const tx=db.transaction(STORE,"readwrite");for(const t of completed)tx.objectStore(STORE).delete(t.id);},30000);
      return;
    }
    const done=completed.length, total=tasks.length;
    panel.classList.add("visible");
    panel.querySelector(".cu-title").textContent=failed.length?"Some uploads need attention":"Uploading files in background";
    panel.querySelector(".cu-fill").style.width=(total?Math.round(done/total*100):0)+"%";
    panel.querySelector(".cu-detail").textContent=active[0]?.fileName||failed[0]?.error||"Finishing uploads…";
    panel.querySelector(".cu-count").textContent=done+" / "+total+" complete";
  }
  async function registerWorker(){
    if(!("serviceWorker" in navigator))return null;
    try{
      registration=await navigator.serviceWorker.register("/upload-sw.js",{scope:"/"});
      await navigator.serviceWorker.ready;
      navigator.serviceWorker.addEventListener("message",event=>{if(event.data?.type==="COOLANAS_UPLOADS_UPDATED")refresh();});
      return registration;
    }catch(error){console.warn("Background uploads are unavailable:",error);return null;}
  }
  async function enqueue(tasks,auth){
    const db=await openDb();if(!db)throw new Error("This browser cannot store background uploads.");
    const batchId=crypto.randomUUID();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,"readwrite"),store=tx.objectStore(STORE);
      for(const task of tasks)store.put({
        id:crypto.randomUUID(),batchId,file:task.file,fileName:task.fileName,
        parentId:task.parentId??null,contentType:task.file.type||"application/octet-stream",
        accessToken:auth.accessToken,status:"pending",createdAt:Date.now(),error:null
      });
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
    panel.classList.add("visible");
    await refresh();
    if(!registration)await registerWorker();
    if(registration?.sync){
      try{await registration.sync.register("coolanas-upload-queue");}catch(error){console.warn("Background sync registration failed:",error);}
    }
    registration?.active?.postMessage({type:"PROCESS_COOLANAS_UPLOADS"});
    navigator.serviceWorker?.controller?.postMessage({type:"PROCESS_COOLANAS_UPLOADS"});
    return {batchId,count:tasks.length};
  }
  async function updateToken(accessToken){
    const db=await openDb();if(!db)return;
    const tasks=await getTasks();
    await new Promise(resolve=>{
      const tx=db.transaction(STORE,"readwrite"),store=tx.objectStore(STORE);
      for(const task of tasks)if(task.status==="pending"||task.status==="uploading")store.put({...task,accessToken});
      tx.oncomplete=resolve;tx.onerror=tx.onabort=resolve;
    });
  }
  navigator.serviceWorker?.addEventListener("message",event=>{if(event.data?.type==="COOLANAS_UPLOADS_UPDATED")refresh();});
  window.addEventListener("storage",refresh);
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")refresh();});
  window.CoolanasUploads={
    enqueue,updateToken,refresh,
    setAuth:async(accessToken)=>{await updateToken(accessToken);},
    getTasks
  };
  registerWorker().then(()=>refresh());
  setInterval(refresh,1200);
})();