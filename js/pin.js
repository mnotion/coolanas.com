const form=document.getElementById("pin-form"),field=document.getElementById("pin"),error=document.getElementById("pin-error"),card=document.querySelector(".pin-card");
let feedbackTimer;
function showWrongPin(){
  document.body.classList.remove("wrong-pin");
  card.classList.remove("wrong-pin");
  void document.body.offsetWidth;
  document.body.classList.add("wrong-pin");
  card.classList.add("wrong-pin");
  clearTimeout(feedbackTimer);
  feedbackTimer=setTimeout(()=>{
    document.body.classList.remove("wrong-pin");
    card.classList.remove("wrong-pin");
  },700);
}
form.addEventListener("submit",async event=>{
  event.preventDefault();
  error.textContent="";
  const value=field.value.trim().toUpperCase();
  if(!value)return;
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
  if(hash==="bcd147460adf0408dd4f6fd86ce70c22461924debb0607aa649a1e02eabd4240"){
    sessionStorage.setItem("coolanas-pin-unlocked","1");
    location.href="dashboard.html";
  }else{
    error.textContent="That PIN isn't correct. Try again.";
    field.value="";
    showWrongPin();
    field.focus();
  }
});
