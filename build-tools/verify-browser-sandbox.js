'use strict';
// Verify the exact account-browser launch options with a throwaway profile and
// local-only page. Never touch an installed profile or contact Douyin.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const fixture=fs.mkdtempSync(path.join(__dirname,'qa-browser-sandbox-'));
process.env.DY_LEAD_DATA_DIR=path.join(fixture,'data');
const engine=require('../dy-lead-app/engine');
const store=require('../dy-lead-app/store');
store.setAccounts([{id:'sandbox-qa',name:'Sandbox QA'}]);
engine.configure({authorize:async()=>true});
(async()=>{
  let browser;
  try {
    browser=await engine.launchAccount('sandbox-qa',{headless:true});
    await browser.context.route('**/*',route=>route.abort());
    await browser.page.setContent('<!doctype html><html><body><button>Local sandbox check</button></body></html>');
    assert.equal(process.platform,'win32','This verifier checks the Windows client runtime');
    const isolatedProfile=store.profileDir('sandbox-qa').replace(/'/g,"''");
    const processCheck=`$profileDirectory='${isolatedProfile}'; $ownedBrowsers=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|msedge|chromium)\\.exe$' -and $_.CommandLine -and $_.CommandLine.Contains($profileDirectory) }); [pscustomobject]@{matched=$ownedBrowsers.Count; noSandboxFlagPresent=[bool]($ownedBrowsers | Where-Object { $_.CommandLine.Contains('--no-sandbox') })} | ConvertTo-Json -Compress`;
    const processResult=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',processCheck],{encoding:'utf8',windowsHide:true,timeout:15000}).trim());
    assert(processResult.matched>0,'Isolated account browser must actually be running');
    assert.equal(processResult.noSandboxFlagPresent,false,'Account browser must keep Chromium sandbox enabled');
    assert.equal(await browser.page.locator('button').textContent(),'Local sandbox check');
    const report={ok:true,chromiumSandboxEnabled:true,noSandboxFlagAbsent:true,isolatedProfile:true,platformRequestsMade:false};
    fs.writeFileSync(path.join(__dirname,'browser-sandbox-verification.json'),JSON.stringify(report,null,2));
    console.log('PASS: actual account-browser launch keeps sandbox enabled; isolated profile and local page only');
  } finally {
    await engine.shutdown();
    if(path.dirname(fixture)!==__dirname||!path.basename(fixture).startsWith('qa-browser-sandbox-'))throw new Error('Unsafe fixture cleanup');
    fs.rmSync(fixture,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
