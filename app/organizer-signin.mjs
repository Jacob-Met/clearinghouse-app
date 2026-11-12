const form=document.querySelector("#organizer-signin"),field=form.elements.code,button=form.querySelector("button"),message=document.querySelector("#organizer-message");
form.addEventListener("submit",async event=>{
  event.preventDefault();if(button.disabled)return;button.disabled=true;message.textContent="Opening workspace…";field.removeAttribute("aria-invalid");
  try{
    const response=await fetch("/organizer/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:field.value})});
    const result=await response.json();if(!response.ok)throw new Error(result.message||"Sign-in did not complete.");
    field.value="";location.replace("/");
  }catch(error){message.textContent=error.message;field.setAttribute("aria-invalid","true");field.focus();}
  finally{button.disabled=false;}
});
button.disabled=false;
