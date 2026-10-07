'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHash,randomUUID}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const source=path.join(__dirname,'atomic-rename.cs');
const digest=data=>createHash('sha256').update(data).digest('hex');
function prepare(options={}) {
  const key=digest(fs.readFileSync(source));
  const cache=options.cache || path.join(process.env.LOCALAPPDATA || os.tmpdir(),require('./product').NAME,'native',key);
  const executable=path.join(cache,'atomic-rename.exe'),manifest=path.join(cache,'sha256.txt');
  const valid=()=>{
    try{return digest(fs.readFileSync(executable))===fs.readFileSync(manifest,'utf8').trim();}catch{return false;}
  };
  if(valid())return executable;
  fs.mkdirSync(cache,{recursive:true});
  {
    const compiler=options.compiler || path.join(process.env.SystemRoot || 'C:\\Windows','Microsoft.NET',
      process.arch==='ia32'?'Framework':'Framework64','v4.0.30319','csc.exe');
    if(!fs.existsSync(compiler))throw new Error('Windows native save helper compiler is unavailable');
    const output=path.join(cache,'build-'+randomUUID()+'.exe');
    try {
      const result=spawnSync(compiler,['/nologo','/target:exe','/optimize+','/out:'+output,source],
        {windowsHide:true,encoding:'utf8',timeout:8000,maxBuffer:65536});
      if(result.error||result.status!==0)throw new Error('Could not build Windows native save helper');
      const hash=digest(fs.readFileSync(output));
      // Compilers use unique outputs. A competing completed build may win;
      // no persistent lock can strand recovery after an interrupted process.
      /* ONLY THE FIRST BUILD IS PUBLISHED. Every caller used to rename its own build over the
         executable and then write the manifest, so with simultaneous first use one caller's manifest
         could describe another caller's executable, or a rename hit a file another caller had just
         put in place (EPERM): that save failed. A hard link is created only if the name is free, so
         exactly one build becomes the executable and only its builder writes the manifest; the
         others wait for that. An executable left without a valid manifest (a builder that died, a
         corrupted file) is still replaced after the wait, so recovery never depends on a lock. */
      const settle=()=>{for(let i=0;i<40&&!valid();i++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);return valid();};
      if(valid())return executable;
      let published=false;
      try { fs.linkSync(output,executable);published=true; }
      catch(error) { if(error.code!=='EEXIST')throw error; }
      if(published)fs.writeFileSync(manifest,hash);
      else if(!settle()) {
        try { fs.renameSync(output,executable);fs.writeFileSync(manifest,hash); }
        catch(error) { if(!settle())throw error; }
      }
    } finally {if(fs.existsSync(output))fs.unlinkSync(output);}
    return executable;
  }
}
function replace(from,to,options={}) {
  const executable=options.executable || prepare(options);
  const result=spawnSync(executable,[from,to],{windowsHide:true,encoding:'utf8',timeout:options.timeout || 3000,maxBuffer:4096});
  if(result.status===0&&result.stdout.trim()==='COMMITTED')return;
  if(result.error && ['ENOENT','EACCES'].includes(result.error.code))throw new Error('Native save helper could not start');
  if(result.status===2&&/^NATIVE_ERROR:\d+\s*$/.test(result.stderr))throw new Error('Windows could not replace the saved file ('+result.stderr.trim()+')');
  // Only a structured pre-commit rejection is a confirmed failure.
  if(result.status===64 && result.stderr.trim()==='INVALID_REQUEST')throw new Error('Native save helper rejected the file paths');
  const error=new Error('Save outcome could not be confirmed. Inspect the saved file before retrying; recovery evidence was preserved.');
  error.outcomeUncertain=true;throw error;
}
module.exports={prepare,replace};
