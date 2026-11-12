const header=document.querySelector(".masthead")||document.querySelector("header");
if(header){
  const button=document.createElement("button");button.type="button";button.textContent="Sign out";button.id="organizer-signout";
  button.addEventListener("click",async()=>{
    button.disabled=true;
    try{
      const response=await fetch("/organizer/logout",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
      if(!response.ok)throw new Error("Sign out did not complete");
      location.replace("/");
    }catch{button.textContent="Try signing out again";button.disabled=false;}
  });
  header.append(button);
}
