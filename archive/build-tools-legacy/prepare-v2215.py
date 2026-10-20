from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
files=['desktop/package.json','dy-lead-app/server.js','build-tools/build.ps1','build-tools/setup.iss','build-tools/verify-artifacts.ps1','build-tools/verify-clean-release.js']
for rel in files:
    path=ROOT/rel
    content=path.read_text('utf-8-sig')
    if '2.2.14' not in content and '2.2.15' not in content:
        raise RuntimeError('Missing expected version: '+rel)
    path.write_text(content.replace('2.2.14','2.2.15'),'utf-8')
p=ROOT/'desktop/preload.js'
p.write_text(p.read_text('utf-8-sig').replace("version: '2.2.11'", "version: '2.2.15'"),'utf-8')
print('Prepared 2.2.15 version markers without touching installed client or data')
