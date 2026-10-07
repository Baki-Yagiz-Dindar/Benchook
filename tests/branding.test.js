'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
test('Windows icon contains the approved PNG sizes with valid offsets',()=>{
 const ico=fs.readFileSync(path.join(root,'panel/benchook.ico'));
 assert.equal(ico.readUInt16LE(0),0);assert.equal(ico.readUInt16LE(2),1);
 const sizes=[16,24,32,48,64,128,256];assert.equal(ico.readUInt16LE(4),sizes.length);
 let end=6+16*sizes.length;
 sizes.forEach((size,i)=>{const p=6+i*16,n=ico.readUInt32LE(p+8),offset=ico.readUInt32LE(p+12);
 assert.equal(offset,end);assert.equal(ico[p]||256,size);assert.equal(ico[p+1]||256,size);
 assert.equal(ico.readUInt16LE(p+6),32);const png=ico.subarray(offset,offset+n);
 assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);end+=n;});
 assert.equal(end,ico.length);
});
test('branding refuses the installed Electron runtime',async()=>{
 const {brand}=require('../tools/brand-windows.cjs');
 await assert.rejects(brand(require('../panel/node_modules/electron')),/copied Benchook.exe/);
});
test('window and portable package both include the Windows icon',()=>{
 assert.match(fs.readFileSync(path.join(root,'panel/main.js'),'utf8'),/icon: path.join\(__dirname, 'benchook.ico'\)/);
 const pkg=fs.readFileSync(path.join(root,'tools/package-windows.cjs'),'utf8');
 assert.match(pkg,/'panel\/benchook.ico'/);assert.match(pkg,/'brand-windows.cjs'/);
});
