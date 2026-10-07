'use strict';
// A failed cleanup must remain unresolved in the ledger, but not hang the runner.
module.exports=function waitForChild(child,stop,{timeout=180000,grace=15000}={}) {
  return new Promise(resolve=>{
    let done=false,timedOut=false,graceTimer,exitResult,cleanupComplete=false;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(graceTimer);resolve({timedOut,...result});};
    const uncertain=error=>{child.unref();finish({cleanupUnconfirmed:true,error});};
    const timer=setTimeout(()=>{
      timedOut=true;
      graceTimer=setTimeout(()=>uncertain('Child exit was not confirmed after cleanup deadline'),grace);
      Promise.resolve().then(()=>stop(child)).then(error=>{
        if(error&&!done)uncertain(String(error));
        else if(!error){cleanupComplete=true;if(exitResult)finish(exitResult);}
      },error=>{if(!done)uncertain(String(error));});
    },timeout);
    child.once('error',e=>finish({error:e.message}));
    child.once('exit',(code,signal)=>{
      exitResult={code,signal};
      if(!timedOut||cleanupComplete)finish(exitResult);
    });
  });
};
