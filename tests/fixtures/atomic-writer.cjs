'use strict';
const saved=require('../../panel/persistent-json');
for(let i=0;i<30;i++)saved.atomic(process.argv[2],{writer:process.argv[3],sequence:i,payload:process.argv[3].repeat(2000)});
