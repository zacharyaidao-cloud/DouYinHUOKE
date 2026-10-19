'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..'),source=path.join(root,'dy-lead-app'),release=path.join(root,'dy-lead-app-release');
for(const file of ['app.js','index.html','style.css']) assert.equal(fs.readFileSync(path.join(source,'web',file),'utf8'),fs.readFileSync(path.join(release,'web',file),'utf8'),'发布UI应与验收源码相同');
const result=spawnSync(path.join(source,'node.exe'),['--test',path.join(source,'tests','ui.test.js')],{stdio:'inherit',windowsHide:true});
if(result.status!==0) process.exit(result.status||1);
console.log('PASS 发布界面与已验收源码一致');
