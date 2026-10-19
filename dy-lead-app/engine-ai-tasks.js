const crypto = require('crypto');
const AI = require('./ai');
const { aiInputHash } = require('./workflow');
const { TaskStopError } = require('./scheduler');
const { isCommentUser, aiExclusionReason } = require('./lead-query');
const MAX_PROVIDER_RETRIES = 2;
const SAVE_CHUNK = 32;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const httpStatus = error => Number(error?.status) || Number(String(error?.message||'').match(/^AI 接口返回 HTTP (\d+)$/)?.[1]) || 0;
function failureKind(error) {
  const status=httpStatus(error);
  if(status===429 || status>=500&&status<=599 || ['AI_NETWORK_ERROR','AI_TIMEOUT','AI_TRANSPORT_RESPONSE_INVALID'].includes(error?.code))return 'transient';
  if(error instanceof TaskStopError || error?.name==='AbortError')return 'stop';
  if(status)return 'provider';
  if(['AI_FORMAT_INVALID','AI_OUTPUT_LENGTH','AI_RESPONSE_INVALID','AI_OUTPUT_INCOMPLETE'].includes(error?.code)
    || /^AI (?:返回|批量返回)格式无效/.test(error?.message||''))return 'format';
  return 'fatal';
}
const budgetFailure=error=>error?.code==='AI_TIMEOUT'||error?.code==='AI_TRANSPORT_RESPONSE_INVALID'||failureKind(error)==='format';
function currentResult(lead,settings,videos) {
  return AI.isStoredResultCurrent(lead,AI.getRuleSet(settings).version,videos);
}
function settingsSignature(settings) {
  const a=settings.ai||{};
  return hash({version:AI.getRuleSet(settings).version,enabled:a.enabled===true,apiKey:a.apiKey,baseUrl:a.baseUrl,model:a.model,
    timeout:a.requestTimeoutSec,batchMode:a.batchMode,batchMaxChars:a.batchMaxChars,batchMaxCount:a.batchMaxCount});
}
function snapshots(rows,videos) {
  const result=new Map();
  for(const source of rows) {
    if(source.id==null||!String(source.id).trim())throw new Error('线索编号缺失，请检查数据');
    const id=String(source.id),row=structuredClone(source),old=result.get(id);
    if(old && (aiInputHash(old,videos)!==aiInputHash(row,videos)||AI.baselineHash(old)!==AI.baselineHash(row)))throw new Error('同一线索编号有不同资料，请检查数据');
    if(!old)result.set(id,row);
  }
  return [...result.values()];
}
function createAiTasks({store,taskState,setTask,failTask,makeScheduler,checkpoint,getSignal}) {
  const audit=(event,data={})=>{
    try{store.log('system','AI_AUDIT '+JSON.stringify({event,...data}));}
    catch(_){setTask({auditWarning:'AI 日志写入失败，请检查本地数据目录'});}
  };
  const reason=error=>{
    if(error instanceof TaskStopError)return error.code==='AI_CONSECUTIVE_ERRORS'&&error.cause?error.message+'；最近原因：'+reason(error.cause):error.message;
    if(error?.code==='AI_OUTPUT_LENGTH')return '模型输出被长度限制截断';
    if(error?.code==='AI_OUTPUT_REFUSED')return '模型拒绝本次判断，请检查业务材料';
    if(error?.code==='AI_PROVIDER_ERROR')return '接口报告本次失败，请检查接口配置';
    const status=httpStatus(error);
    if(status===402)return 'DeepSeek API 余额不足（HTTP 402），请检查账户余额后继续';
    if(status===429)return 'AI 接口限流（HTTP 429）';
    if(status)return 'AI 接口返回 HTTP '+status;
    if(error?.code==='AI_TIMEOUT')return 'AI 请求超时';
    if(error?.code==='AI_NETWORK_ERROR')return 'AI 接口连接失败';
    if(failureKind(error)==='format')return '回执未符合二值短理由协议';
    if(/^(?:公司介绍与判断要求|单条线索|单条共享上下文|未知模型|所选|无法确认|DeepSeek 模型|请选择|AI请求|AI规划|AI 每批|待判断|线索编号|同一线索编号)/.test(error?.message||'')
      || /完整上下文容量|\d+%上下文|\d+%预算/.test(error?.message||''))return error.message;
    return 'AI 请求或回执未完成，请检查接口和设置';
  };
  const check=(signature,signal)=>{
    if(taskState.stopRequested||signal?.aborted)throw new TaskStopError('已手动停止，未完成的线索保留待判断');
    if(settingsSignature(store.getSettings())!==signature)throw new TaskStopError('AI 规则、模型或接口设置已变化，请重新开始判断','RULE_CHANGED');
  };
  const aiScheduler=settings=>makeScheduler(settings);
  function savedAudit(lead,saved,meta) {
    audit('result',{...meta,leadId:String(lead.id),outcome:saved.ok?'success':saved.skipped?'skipped':'failed',
      ...(saved.ok?{need:saved.need,reason:saved.reason}:{reason:saved.skipped?saved.error||'线索或结果变化，未写入':'本条未取得有效 AI 回执'})});
  }
  function onRequest(result,meta) {
    return data=>{
      if(data?.kind==='completion')result.completionRequestCount++;
      else if(data?.kind==='models')result.modelRequestCount++;
      audit('request_sent',{...meta,...data,completionRequestCount:result.completionRequestCount,modelRequestCount:result.modelRequestCount});
      setTask({aiCompletionRequests:result.completionRequestCount,aiModelRequests:result.modelRequestCount});
    };
  }
  async function retryProvider(operation,{scheduler,checkCurrent,meta,result,splitOnTimeout=false,recoverOnBudgetFailure=false}) {
    for(let attempt=0;;attempt++) {
      checkCurrent();scheduler.checkStopped();
      try{return await operation(attempt);}
      catch(error) {
        checkCurrent();
        if(splitOnTimeout&&error?.code==='AI_TIMEOUT'||recoverOnBudgetFailure&&budgetFailure(error))throw error;
        if(failureKind(error)!=='transient'||attempt>=MAX_PROVIDER_RETRIES)throw error;
        result.providerRetryCount++;
        const delayMs=Math.min(30000,Math.max(1000*2**attempt,Number(error.retryAfterMs)||0));
        audit('provider_retry',{...meta,retryNo:attempt+1,delayMs,reason:reason(error)});
        await scheduler.waitAiRetry(delayMs,checkCurrent,reason(error));
      }
    }
  }
  async function aiJudgeBatch(batch,settings=store.getSettings(),options={}) {
    if(!Array.isArray(batch)||!batch.length)throw new Error('AI 判断范围为空');
    const scheduler=options.scheduler||aiScheduler(settings),meta={accountId:batch[0].accountId,kind:'ai'};
    return scheduler.run(meta,async()=>{
      const replies=await AI.judgeBatch(settings,batch,options.videos||store.getVideos(),{signal:options.signal,targetRatio:options.targetRatio,
        authorize:async()=>{options.checkCurrent?.();return scheduler.before(meta);},
        onDiagnostic:options.onDiagnostic,onUsage:options.onUsage,onRequest:options.onRequest});
      if(!replies){const error=new Error('AI 批量返回格式无效，本批未标记为已判断');error.code='AI_FORMAT_INVALID';throw error;}
      return replies;
    },{deferAiFailure:options.deferAiFailure});
  }
  async function aiJudgeOne(leadId) {
    if(taskState.running)return failTask('已有任务在运行');
    let settings,videos,lead,signature;
    try {
      settings=structuredClone(store.getSettings());videos=structuredClone(store.getVideos());
      lead=store.getLeads().find(row=>String(row.id)===String(leadId));
      if(!lead)return failTask('线索不存在');
      if(!isCommentUser(lead,videos))return failTask(aiExclusionReason(lead,videos));
      if(!settings.ai.enabled||!settings.ai.apiKey)return failTask('请启用 AI 并配置 API Key');
      lead=structuredClone(lead);signature=settingsSignature(settings);
    } catch(error){return failTask(reason(error));}
    const result={completionRequestCount:0,modelRequestCount:0,providerRetryCount:0};
    setTask({kind:'ai',running:true,accountId:lead.accountId,status:'正在判断选中线索',done:0,total:1,errors:[],aiBudget:null,aiUsage:null,aiBaseBudget:null,
      aiCompletionRequests:0,aiModelRequests:0,aiAttempts:0,aiConsecutiveErrors:0,auditWarning:null});
    const signal=getSignal(),checkCurrent=()=>check(signature,signal),meta={accountId:lead.accountId,kind:'ai'};
    const auditMeta={batchNo:1,batchCount:1,mode:'single',count:1,ruleVersion:AI.getRuleSet(settings).version};
    try {
      const scheduler=aiScheduler(settings),request=AI.buildJudgeRequest(settings,[lead],videos),observer=onRequest(result,auditMeta);
      audit('request',{...auditMeta,stage:'prepared',reason:'用户手动选择单条判断',payloadChars:request.payloadChars,workCount:request.workCount,fieldMapping:AI.FIELD_MAPPING});
      const discovery=await retryProvider(()=>scheduler.run(meta,()=>AI.listModels(settings,{forceRefresh:true,signal,
        authorize:async()=>{checkCurrent();return scheduler.before(meta);},onRequest:observer})),{scheduler,checkCurrent,meta:auditMeta,result});
      checkCurrent();
      const capacity=AI.modelCapacity(settings,discovery),budget=AI.estimateRequestBudget(request.messages,1,capacity);
      const plan=AI.planJudgeBatches({...settings,ai:{...settings.ai,batchMode:'auto'}},[lead],videos,capacity,{targetRatio:0.9});
      setTask({aiBudget:{...budget,...capacity,count:1,batchNo:1,baseBudget:plan.baseBudget},aiBaseBudget:plan.baseBudget});
      audit('budget',{...auditMeta,...budget,capacity,baseBudget:plan.baseBudget});
      if(!budget.withinBudget)throw new Error('单条线索超过模型90%上下文或输出预算，未发判断请求');
      const reply=await retryProvider(()=>scheduler.run(meta,()=>AI.judgeOne(settings,lead,videos,{signal,
        authorize:async()=>{checkCurrent();return scheduler.before(meta);},onRequest:observer,
        onDiagnostic:data=>audit('response_invalid',{...auditMeta,...data}),
        onUsage:data=>{audit('usage',{...auditMeta,...data});setTask({aiUsage:data});}})),{scheduler,checkCurrent,meta:auditMeta,result});
      checkCurrent();
      const current=store.getLeads().find(row=>String(row.id)===String(lead.id));
      const saved=current&&!isCommentUser(current,store.getVideos())?{ok:false,skipped:true,error:aiExclusionReason(current,store.getVideos())}:AI.applyResultPatch(store,lead,reply,{signal});
      savedAudit(lead,saved,{...auditMeta,i:1});
      setTask({running:false,done:saved.ok?1:0,status:saved.ok?'AI 判断完成':saved.error||'判断结果未写入'});
      return saved;
    } catch(error) {
      const message=taskState.stopRequested?'已手动停止，未写入判断结果':reason(error);
      audit('request_failed',{...auditMeta,reason:message});setTask({running:false,status:message});
      return {ok:false,error:message};
    }
  }
  async function aiTask(options={}) {
    if(taskState.running)return failTask('已有任务在运行');
    let settings,videos,selected,pending,version,signature;
    try {
      if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('AI 判断范围无效');
      if(options.leadIds!==undefined&&!Array.isArray(options.leadIds))throw new Error('leadIds 必须为数组');
      if(options.force!==undefined&&typeof options.force!=='boolean')throw new Error('force 必须为布尔值');
      settings=structuredClone(store.getSettings());videos=structuredClone(store.getVideos());
      if(!settings.ai.enabled||!settings.ai.apiKey)return failTask('请启用 AI 并配置 API Key');
      const filtered=require('./lead-query').filterLeads(store.getLeads(),videos,options.filters||{},{settings,now:Date.now(),...(Object.hasOwn(options,'leadIds')?{leadIds:options.leadIds}:{})});
      selected=snapshots(filtered,videos);version=AI.getRuleSet(settings).version;signature=settingsSignature(settings);
      pending=selected.filter(row=>isCommentUser(row,videos)&&(options.force||!currentResult(row,settings,videos)));
    } catch(error){return failTask(error.message);}
    if(!pending.length)return failTask(selected.length&&selected.every(row=>!isCommentUser(row,videos))?'当前范围均不参与 AI 判断（作品作者或空评论），无需重复提交':'当前范围没有待判断线索（旧版或规则变更结果须重新判断）');
    setTask({kind:'ai',running:true,accountId:'',status:'准备判断当前固定筛选范围',done:0,total:pending.length,errors:[],aiBudget:null,aiUsage:null,aiBaseBudget:null,
      aiCompletionRequests:0,aiModelRequests:0,aiAttempts:0,aiConsecutiveErrors:0,auditWarning:null});
    const signal=getSignal(),checkCurrent=()=>check(signature,signal),processed=[],processedSet=new Set();
    const result={ok:true,okCount:0,yesCount:0,noCount:0,failCount:0,skipped:0,oversizeCount:0,batchCount:0,
      scheduledSingleCount:0,fallbackCount:0,splitRetryCount:0,providerRetryCount:0,completionRequestCount:0,modelRequestCount:0};
    const progress=()=>{
      checkpoint({processedLeadIds:[...processed],counts:{yes:result.yesCount,no:result.noCount,failed:result.failCount,skipped:result.skipped}});
      setTask({done:processed.length,detail:'是 '+result.yesCount+'｜否 '+result.noCount+'｜失败 '+result.failCount+'｜跳过 '+result.skipped+'｜缩批重试 '+result.splitRetryCount+'｜接口重试 '+result.providerRetryCount});
    };
    const record=(lead,saved,meta)=>{
      const id=String(lead.id);if(processedSet.has(id))return;
      if(saved.ok){result.okCount++;if(saved.need==='是')result.yesCount++;else result.noCount++;}
      else if(saved.skipped)result.skipped++;else result.failCount++;
      savedAudit(lead,saved,meta);processedSet.add(id);processed.push(id);
    };
    try {
      checkpoint({id:crypto.randomUUID(),kind:'ai',accountId:'',planId:null,leadIds:pending.map(row=>String(row.id)),processedLeadIds:[],state:'running',
        stopReason:null,completedAt:null,ruleVersion:version,counts:{yes:0,no:0,failed:0,skipped:0}});
      audit('selection',{ruleVersion:version,selectedCount:selected.length,pendingCount:pending.length,force:options.force===true,filter:require('./lead-query').normalizeFilters(options.filters||{}).f});
      const scheduler=aiScheduler(settings),discoveryMeta={mode:'models',ruleVersion:version};
      const discovery=await retryProvider(()=>scheduler.run({accountId:'',kind:'ai'},()=>AI.listModels(settings,{forceRefresh:true,signal,
        authorize:async()=>{checkCurrent();return scheduler.before({accountId:'',kind:'ai'});},onRequest:onRequest(result,discoveryMeta)})),
        {scheduler,checkCurrent,meta:discoveryMeta,result});
      checkCurrent();
      const capacity=AI.modelCapacity(settings,discovery);
      audit('model_capacity',{ruleVersion:version,...capacity,targetRatio:settings.ai.batchMode==='manual'?0.9:0.75,estimateMethod:'UTF-8字节＋完整消息包装＋输出预留，保守估算'});
      let plan=await AI.planJudgeBatchesAsync(settings,pending,videos,capacity,{checkStopped:()=>{checkCurrent();scheduler.checkStopped();},
        onProgress:p=>setTask({status:'正在按模型预算规划：'+p.processed+'/'+p.total+'条，可随时停止'})});
      let {batches,oversizeCount}=plan;
      const automatic=plan.mode==='auto';let strategyIndex=0;
      Object.assign(result,{oversizeCount,batchCount:batches.length,scheduledSingleCount:batches.filter(b=>b.mode==='single').length});
      setTask({aiBaseBudget:plan.baseBudget||null});
      audit('plan',{ruleVersion:version,count:pending.length,batchMode:plan.mode,batchCount:batches.length,multiBatchCount:batches.filter(b=>b.mode==='batch').length,
        scheduledSingleCount:result.scheduledSingleCount,oversizeCount,maxChars:plan.maxChars,maxCount:plan.maxCount,executionMaxCount:plan.executionMaxCount,targetRatio:plan.targetRatio,recoveryTier:strategyIndex,strategy:automatic?AI.AUTOMATIC_BATCH_STRATEGIES[0].name:'手动',requestTimeoutSec:settings.ai.requestTimeoutSec||60,capacity,baseBudget:plan.baseBudget,fieldMapping:AI.FIELD_MAPPING});
      for(const rejected of plan.rejected||[]) {
        checkCurrent();record(rejected.lead,{ok:false,error:rejected.reason},{mode:'budget_rejected',ruleVersion:version});
        audit('budget_rejected',{leadId:String(rejected.lead.id),ruleVersion:version,reason:rejected.reason,...rejected.budget});
      }
      if(plan.rejected?.length)progress();
      const save=async(items,replies,meta)=>{
        const counts={yes:0,no:0,failed:0,skipped:0};
        for(let offset=0;offset<items.length;offset+=SAVE_CHUNK) {
          checkCurrent();scheduler.checkStopped();
          const liveSettings=store.getSettings(),liveVideos=store.getVideos();let staged=store.getLeads(),changed=false;
          const stagingStore={getSettings:()=>liveSettings,getVideos:()=>liveVideos,getLeads:()=>staged,setLeads:rows=>{staged=rows;changed=true;},nowStr:()=>store.nowStr()};
          const decisions=[];
          for(let i=offset;i<Math.min(items.length,offset+SAVE_CHUNK);i++) {
            const lead=items[i],current=staged.find(row=>String(row.id)===String(lead.id));
            const saved=current&&!isCommentUser(current,liveVideos)?{ok:false,skipped:true,error:aiExclusionReason(current,liveVideos)}:
              replies?AI.applyResultPatch(stagingStore,lead,replies[i+1],{signal}):{ok:false,error:'未取得有效 AI 回执，保留待判断状态'};
            decisions.push({lead,saved,i:i+1});
          }
          // Commit a bounded synchronous chunk using fresh stored records. This
          // preserves contact fields and avoids one full-file rewrite per row.
          if(changed)store.setLeads(staged);
          for(const {lead,saved,i} of decisions) {
            if(saved.ok){if(saved.need==='是')counts.yes++;else counts.no++;}
            else if(saved.skipped)counts.skipped++;else counts.failed++;
            record(lead,saved,{...meta,i});
          }
          progress();await new Promise(resolve=>setImmediate(resolve));
        }
        audit('batch_completed',{...meta,...counts});
      };
      const processBatch=async(items,batchMeta)=>{
        checkCurrent();scheduler.checkStopped();
        const request=AI.buildJudgeRequest(settings,items,videos),budget=AI.estimateRequestBudget(request.messages,items.length,capacity,plan.targetRatio);
        if(!budget.withinBudget)throw new Error(`AI请求超过模型${Math.round(plan.targetRatio*100)}%上下文或输出预算，已停止发送`);
        const mode=items.length===1?(batchMeta.retry?'fallback_single':'single'):(batchMeta.retry?'retry_batch':'batch');
        const meta={...batchMeta,mode,count:items.length,ruleVersion:version,targetRatio:plan.targetRatio,recoveryTier:strategyIndex,
          strategy:automatic?AI.AUTOMATIC_BATCH_STRATEGIES[strategyIndex].name:'手动'};
        if(mode==='fallback_single')result.fallbackCount++;
        audit('request',{...meta,stage:'prepared',payloadChars:request.payloadChars,workCount:request.workCount,budget});
        setTask({status:'AI '+(items.length===1?'单条':'批量')+'判断第 '+meta.batchNo+'/'+batches.length+' 批，共 '+items.length+' 条'+(automatic?' · '+meta.strategy:'')+(meta.retry?'（缩批重试）':''),
          aiBudget:{...budget,...capacity,batchNo:meta.batchNo,count:items.length,baseBudget:plan.baseBudget}});
        let replies=null,diagnostic=null,failed=null;
        try {
          replies=await retryProvider(()=>aiJudgeBatch(items,settings,{scheduler,signal,videos,checkCurrent,targetRatio:plan.targetRatio,
            deferAiFailure:error=>automatic&&strategyIndex<AI.AUTOMATIC_BATCH_STRATEGIES.length-1&&budgetFailure(error),onRequest:onRequest(result,meta),
            onDiagnostic:data=>{diagnostic=data;audit('response_invalid',{...meta,...data});},
            onUsage:data=>{audit('usage',{...meta,...data});setTask({aiUsage:data});}}),{scheduler,checkCurrent,meta,result,splitOnTimeout:items.length>1,recoverOnBudgetFailure:automatic});
          checkCurrent();
        } catch(error) {
          checkCurrent();if(failureKind(error)==='stop')throw error;
          failed=error;audit('request_failed',{...meta,reason:diagnostic?.message||reason(error)});
          if(automatic&&budgetFailure(error)) {
            if(strategyIndex>=AI.AUTOMATIC_BATCH_STRATEGIES.length-1)throw error;
            const recovery=new Error('AI自动组批需要降低预算');recovery.code='AI_BUDGET_REPLAN';recovery.cause=error;throw recovery;
          }
          if(failureKind(error)!=='format'&&error?.code!=='AI_TIMEOUT')throw error;
        }
        if(!replies&&items.length>1) {
          if(failed?.code==='AI_TIMEOUT') {
            const chunkSize=Math.min(Math.ceil(items.length/2),200),chunkCount=Math.ceil(items.length/chunkSize);
            result.splitRetryCount++;
            audit('retry_split',{...meta,splitKind:'timeout',reason:reason(failed),chunkSize,chunkCount});
            setTask({status:`AI 请求超时，将 ${items.length} 条缩为 ${chunkCount} 个子批，每批最多 ${chunkSize} 条，可随时停止`});
            for(let offset=0;offset<items.length;offset+=chunkSize) {
              checkCurrent();scheduler.checkStopped();
              await processBatch(items.slice(offset,offset+chunkSize),{...batchMeta,retry:true,path:(batchMeta.path||'')+'T'+(offset/chunkSize+1)});
            }
            return;
          }
          const midpoint=Math.ceil(items.length/2);result.splitRetryCount++;
          audit('retry_split',{...meta,reason:diagnostic?.message||reason(failed),leftCount:midpoint,rightCount:items.length-midpoint});
          await processBatch(items.slice(0,midpoint),{...batchMeta,retry:true,path:(batchMeta.path||'')+'L'});
          await processBatch(items.slice(midpoint),{...batchMeta,retry:true,path:(batchMeta.path||'')+'R'});return;
        }
        await save(items,replies,meta);
      };
      for(let b=0;b<batches.length;b++) {
        checkCurrent();scheduler.checkStopped();
        const current=new Map(store.getLeads().map(row=>[String(row.id),row])),liveVideos=store.getVideos(),items=[];
        for(const lead of batches[b].leads) {
          const row=current.get(String(lead.id));
          const skipped=!row?'线索已删除':!isCommentUser(row,liveVideos)?aiExclusionReason(row,liveVideos):aiInputHash(row,liveVideos)!==aiInputHash(lead,videos)?'线索或作品资料已变化':
            AI.baselineHash(row)!==AI.baselineHash(lead)?'已有更新的 AI 结果，本次未重复判断':'';
          if(skipped)record(lead,{ok:false,skipped:true,error:skipped},{mode:'preflight_skipped',batchNo:b+1,ruleVersion:version});
          else items.push(lead);
        }
        if(items.length!==batches[b].leads.length)progress();
        if(items.length) {
          try {await processBatch(items,{batchNo:b+1,batchCount:batches.length,splitReason:batches[b].splitReason,reason:batches[b].singleReason||'正常批量请求'});}
          catch(error) {
            if(error.code!=='AI_BUDGET_REPLAN')throw error;
            // Freeze scope and retain all already committed results. Repack the
            // failed batch together with every unsent row at the lower tier.
            const remaining=pending.filter(lead=>!processedSet.has(String(lead.id))),previous=AI.AUTOMATIC_BATCH_STRATEGIES[strategyIndex];
            let nextPlan;
            while(strategyIndex<AI.AUTOMATIC_BATCH_STRATEGIES.length-1) {
              strategyIndex++;checkCurrent();scheduler.checkStopped();
              const strategy=AI.AUTOMATIC_BATCH_STRATEGIES[strategyIndex];
              try {
                nextPlan=await AI.planJudgeBatchesAsync(settings,remaining,videos,capacity,{...strategy,checkStopped:()=>{checkCurrent();scheduler.checkStopped();},
                  onProgress:p=>setTask({status:'AI 改用 '+strategy.name+' 重新规划剩余 '+p.processed+'/'+p.total+' 条，可随时停止'})});
                if(!nextPlan.rejected.length||strategyIndex===AI.AUTOMATIC_BATCH_STRATEGIES.length-1)break;
              } catch(planningError) {
                if(!/^公司介绍与判断要求已超过模型\d+%预算/.test(planningError.message)||strategyIndex===AI.AUTOMATIC_BATCH_STRATEGIES.length-1)throw planningError;
              }
              // A lower soft budget must not silently drop complete fields or
              // mark previously admissible rows failed before the 200-row mode.
              audit('budget_strategy_skipped',{strategy:strategy.name,recoveryTier:strategyIndex,targetRatio:strategy.targetRatio,reason:'完整资料无法放入本档预算，转下一档'});
            }
            plan=nextPlan;batches=plan.batches;result.batchCount=batches.length;result.splitRetryCount++;
            result.scheduledSingleCount=batches.filter(batch=>batch.mode==='single').length;
            const strategy=AI.AUTOMATIC_BATCH_STRATEGIES[strategyIndex];
            audit('budget_recovery',{fromStrategy:previous.name,strategy:strategy.name,recoveryTier:strategyIndex,targetRatio:plan.targetRatio,
              executionMaxCount:plan.executionMaxCount,count:remaining.length,batchCount:batches.length,firstBatchCount:batches[0]?.leads.length||0,reason:reason(error.cause)});
            setTask({aiBaseBudget:plan.baseBudget,status:'AI 改用 '+strategy.name+'，剩余 '+remaining.length+' 条，重新规划 '+batches.length+' 批'});
            for(const rejected of plan.rejected||[]) {
              checkCurrent();record(rejected.lead,{ok:false,error:rejected.reason},{mode:'budget_rejected',ruleVersion:version});
              audit('budget_rejected',{leadId:String(rejected.lead.id),ruleVersion:version,reason:rejected.reason,...rejected.budget});
            }
            if(plan.rejected.length)progress();
            b=-1;
          }
        }
      }
      checkCurrent();result.partial=result.failCount>0;
      checkpoint({state:result.partial?'completed_with_errors':'completed',stopReason:null,completedAt:store.nowStr()});
      setTask({running:false,status:'AI 判断结束：是 '+result.yesCount+'｜否 '+result.noCount+'｜失败 '+result.failCount+'｜跳过 '+result.skipped});
      audit('completed',{ruleVersion:version,...result});
    } catch(error) {
      result.ok=false;result.error=taskState.stopRequested?'已手动停止，未完成的线索保留待判断':reason(error);
      try{checkpoint({state:'paused',stopReason:result.error});}catch(_){result.error='任务记录保存失败，请检查本地数据目录';}
      setTask({running:false,status:'AI 判断已暂停：'+result.error});
      audit('paused',{ruleVersion:version,count:processed.length,yes:result.yesCount,no:result.noCount,failed:result.failCount,skipped:result.skipped,
        fallback:result.fallbackCount,completionRequestCount:result.completionRequestCount,providerRetryCount:result.providerRetryCount,reason:result.error});
    }
    return result;
  }
  return {aiJudgeOne,aiJudgeBatch,aiTask};
}
module.exports={createAiTasks};
