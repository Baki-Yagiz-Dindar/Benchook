'use strict';
const readline=require('node:readline');
const mode=process.argv[2];
readline.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);
  if(r.id===1){
    if(mode==='disconnect')process.exit(0);
    if(mode==='null-prefix')process.stdout.write('null\n[]\n42\n');
    console.log(JSON.stringify({id:1,result:{}}));
  }
  if(r.id===2)console.log(JSON.stringify(mode==='reject'
    ? {id:2,error:{message:'Fixture rate limit exceeded'}}
    : {id:2,result:{rateLimits:{primary:{usedPercent:25}}}}));
});
