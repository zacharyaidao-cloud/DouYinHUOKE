from pathlib import Path
p=Path('C:/Users/HUAMAO/.codex/visualizations/2026/10/07/01a116de-a162-75e2-86b7-d582fced1aa0/huamao-list-design.html')
s=p.read_text(encoding='utf-8')
def replace(old,new):
    global s
    assert old in s, old
    s=s.replace(old,new)
replace('width:16px;height:16px;vertical-align:middle;', 'width:16px;height:16px;margin:0;vertical-align:middle;')
replace('grid-template-columns:24px minmax(0,1fr) 205px 130px;gap:14px;padding:14px 16px;', 'grid-template-columns:24px minmax(0,1fr) 205px 130px;gap:14px;padding:var(--hm-pad) 16px;')
replace('padding-top:13px;padding-bottom:13px;', 'padding-top:var(--hm-pad);padding-bottom:var(--hm-pad);')
replace("function filtered(){return rows.filter(r=>(state.ai==='all'||r.ai===state.ai)&&", "function filtered(ignoreAi=false){return rows.filter(r=>(ignoreAi||state.ai==='all'||r.ai===state.ai)&&")
replace("const list=filtered(),visibleSelected=list.filter(r=>state.selected.has(r.id)).length;", "const list=filtered(),visibleSelected=list.filter(r=>state.selected.has(r.id)).length;\n      const base=filtered(true);app.querySelectorAll('[data-ai]').forEach(b=>{b.querySelector('em').textContent=b.dataset.ai==='all'?base.length:base.filter(r=>r.ai===b.dataset.ai).length;});\n      find('[data-act=preview]').textContent=state.selected.size?'预检查已勾选 '+state.selected.size+' 条':'预检查当前筛选';\n      find('[data-act=judge]').textContent=state.selected.size?'AI 判断已勾选 '+state.selected.size+' 条':'批量 AI 判断';")
replace('<col style="width:3%"><col style="width:5%">','<col style="width:36px"><col style="width:5%">')
replace('<div class="hm-record-ai">${badge(r)}<div class="hm-date" style="margin-top:8px">${date(r)}</div></div>', '<div class="hm-record-ai">${badge(r)}</div>')
replace('<span>编号 ${r.id}</span><button class="hm-link" data-copy=', '<span>编号 ${r.id}</span><span class="hm-date" aria-label="评论时间">${date(r)}</span><button class="hm-link" data-copy=')
replace('<h4>所属作品标题与正文</h4><p>${esc(r.work)}</p>', '<h4>所属作品标题</h4><p>${esc(r.work)}</p>')
replace('label:\'表格上下留白\'', 'label:\'列表上下留白\'')
p.write_text(s,encoding='utf-8')
print('Prototype refinements applied')
