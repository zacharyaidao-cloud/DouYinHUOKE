from pathlib import Path
p=Path('C:/Users/HUAMAO/.codex/visualizations/2026/10/07/01a116de-a162-75e2-86b7-d582fced1aa0/huamao-erp-list-design.html')
s=p.read_text(encoding='utf-8')
def change(old,new):
    global s
    assert old in s,old
    s=s.replace(old,new)
change('--hm-font:16px','--hm-font:15px')
change('<col style="width:23%"><col style="width:24%">','<col style="width:24%"><col style="width:23%">')
change('<th>作品标题 / 内容</th><th>用户评论</th>','<th>用户评论</th><th>作品标题 / 内容</th>')
comment='<td><button class="hm-comment cursor-interaction" data-detail="${l.id}" aria-label="查看${esc(l.name)}的完整评论"><span class="hm-two" data-tooltip="${esc(l.comment)}">${esc(l.comment)}</span></button></td>'
work='<td>${workCell(w,l.id)}</td>'
change(work+comment,comment+work)
change('font:[15,16,17,18].includes(saved?.font)?saved.font:16','font:saved?.layoutVersion===2&&[15,16,17,18].includes(saved?.font)?saved.font:15')
change('erpDesign:{page:state.page','erpDesign:{layoutVersion:2,page:state.page')
change('if([15,16,17,18].includes(s.font))design.font=s.font;','if(s.layoutVersion===2&&[15,16,17,18].includes(s.font))design.font=s.font;')
p.write_text(s,encoding='utf-8')
check=Path('D:/B1-抖音获客/build-tools/verify-erp-list-design.cjs')
check.write_text(check.read_text(encoding='utf-8').replace('16px','15px'),encoding='utf-8')
print('Updated preview: comment precedes work, uniform 15px, old saved font migrated')
