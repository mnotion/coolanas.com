const DB_NAME="coolanas-background-uploads";
const DB_VERSION=1;
const STORE="tasks";
const SUPABASE_URL="https://nacwftrsdpglzrhasmit.supabase.co";
const SUPABASE_KEY="sb_publishable_4OLO5cw2lr_l90MECEAG0A_MJY1NQQF";
function openDb(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE)){const store=db.createObjectStore(STORE,{keyPath:"id"});store.createIndex("status","status");store.createIndex("batchId","batchId");}};
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function getTasks(){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const request=db.transaction(STORE,"readonly").objectStore(STORE).getAll();
    request.onsuccess=()=>resolve(request.result||[]);
    request.onerror=()=>reject(request.error);
  });
}
async function saveTask(task){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite");
    tx.objectStore(STORE).put(task);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
    tx.onabort=()=>reject(tx.error);
  });
}
async function patchTask(id,patch){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite");
    const store=tx.objectStore(STORE);
    const request=store.get(id);
    request.onsuccess=()=>{if(request.result)store.put({...request.result,...patch,updatedAt:Date.now()});};
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}
async function removeTask(id){
  const db=await openDb();
  return new Promise(resolve=>{
    const tx=db.transaction(STORE,"readwrite");tx.objectStore(STORE).delete(id);
    tx.oncomplete=tx.onerror=()=>resolve();
  });
}
async function updateClients(){
  const tasks=await getTasks();
  const clients=await self.clients.matchAll({type:"window",includeUncontrolled:true});
  for(const client of clients)client.postMessage({type:"COOLANAS_UPLOADS_UPDATED",tasks:tasks.map(({file,...task})=>task)});
}
async function invoke(action,task,payload={}){
  const response=await fetch(SUPABASE_URL+"/functions/v1/coolanas-files-b2",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer "+task.accessToken,"apikey":SUPABASE_KEY},
    body:JSON.stringify({action,...payload})
  });
  let data={};try{data=await response.json();}catch{}
  if(!response.ok||data.error)throw new Error(data.error||("Storage request failed ("+response.status+")."));
  return data;
}
async function uploadTask(task){
  await patchTask(task.id,{status:"uploading",error:null});
  try{
    let current=task;
    if(!current.itemId||!current.uploadUrl){
      const created=await invoke("create_upload",current,{parentId:current.parentId,name:current.fileName,contentType:current.contentType});
      current={...current,itemId:created.item.id,uploadUrl:created.uploadUrl,contentType:created.contentType};
      await patchTask(task.id,{itemId:current.itemId,uploadUrl:current.uploadUrl,contentType:current.contentType});
    }
    const response=await fetch(current.uploadUrl,{method:"PUT",headers:{"Content-Type":current.contentType},body:current.file});
    if(!response.ok){
      if(response.status===403||response.status===401){
        await patchTask(task.id,{uploadUrl:null,status:"pending",error:"Upload link expired; retrying"});
        throw new Error("Signed upload link expired");
      }
      throw new Error("File upload failed ("+response.status+").");
    }
    await invoke("finish_upload",current,{id:current.itemId});
    await patchTask(task.id,{status:"complete",completedAt:Date.now(),error:null,file:null,uploadUrl:null,accessToken:null});
  }catch(error){
    const transient=/fetch|network|temporar|expired|429|500|502|503|504/i.test(error.message);
    await patchTask(task.id,{status:transient?"pending":"failed",error:error.message});
    throw error;
  }
}
async function processQueueImpl(){
  const tasks=(await getTasks()).filter(task=>task.status==="pending"||task.status==="uploading");
  let cursor=0,transientFailure=null;
  async function worker(){
    while(cursor<tasks.length){
      const task=tasks[cursor++];
      try{await uploadTask(task);}
      catch(error){if(/fetch|network|temporar|expired|429|500|502|503|504/i.test(error.message))transientFailure=error;}
      await updateClients();
    }
  }
  await Promise.all(Array.from({length:Math.min(3,tasks.length)},worker));
  await updateClients();
  if(transientFailure)throw transientFailure;
  const remaining=(await getTasks()).some(task=>task.status==="pending"||task.status==="uploading");
  if(remaining)throw new Error("Uploads remain queued.");
}
let processingPromise=null;
function processQueue(){
  if(processingPromise)return processingPromise;
  processingPromise=processQueueImpl().finally(()=>{processingPromise=null;});
  return processingPromise;
}
self.addEventListener("install",event=>event.waitUntil(self.skipWaiting()));
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("sync",event=>{
  if(event.tag==="coolanas-upload-queue")event.waitUntil(processQueue());
});
self.addEventListener("message",event=>{
  if(event.data?.type==="PROCESS_COOLANAS_UPLOADS")event.waitUntil(processQueue());
  if(event.data?.type==="REFRESH_COOLANAS_UPLOADS")event.waitUntil(updateClients());
});
