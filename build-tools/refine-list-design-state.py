from pathlib import Path
p=Path('C:/Users/HUAMAO/.codex/visualizations/2026/10/07/01a116de-a162-75e2-86b7-d582fced1aa0/huamao-list-design.html')
s=p.read_text(encoding='utf-8')
def replace(a,b):
    global s
    assert a in s,a
    s=s.replace(a,b)
replace('const models=[];',"const models=[]; let localRevision=Number(window.openai?.widgetState?.modelContent?.revision)||0;")
replace('modelContent:{listDesign:state}', 'modelContent:{revision:++localRevision,listDesign:state}')
replace("window.addEventListener('openai:set_globals',e=>{const next=e.detail?.globals?.widgetState?.modelContent?.listDesign;", "window.addEventListener('openai:set_globals',e=>{const incoming=e.detail?.globals?.widgetState?.modelContent;if(!incoming||(Number(incoming.revision)||0)<localRevision)return;localRevision=Number(incoming.revision)||0;const next=incoming.listDesign;")
replace('#hm-list-design .hm-app {--hm-bg:', '#hm-list-design .hm-app {font-family:"Microsoft YaHei UI","Microsoft YaHei","PingFang SC",Arial,sans-serif;--hm-bg:')
replace('#hm-list-design table {width:', '#hm-list-design table {font-family:inherit;width:')
p.write_text(s,encoding='utf-8')
print('State echo ordering and product font inheritance corrected')
