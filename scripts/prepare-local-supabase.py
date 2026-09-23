"""Prepare an unlinked local Supabase project from repository migrations."""
from pathlib import Path
import hashlib
import json
import shutil
import tomllib

source = Path('/mnt/d/GGGG/kiro/aural-entry-fix-20260913/supabase')
target = Path('/home/wanghostname/.local/share/oprun-local-acceptance/supabase-entry')
target.mkdir(exist_ok=True)
(target / 'supabase').mkdir(exist_ok=True)
for directory in ('migrations', 'templates'):
    shutil.copytree(source / directory, target / 'supabase' / directory, dirs_exist_ok=True)
shutil.copyfile(source / 'seed.sql', target / 'supabase/seed.sql')
config = (source / 'config.toml').read_text()
config = config.replace('project_id = "aural"', 'project_id = "oprun-entry-local-20260914"')
for port in (54320, 54321, 54322, 54323, 54324, 54327, 54329):
    config = config.replace(str(port), str(port + 1000))
config = config.replace('127.0.0.1:3000', '127.0.0.1:3219')
parsed = tomllib.loads(config)
assert parsed['project_id'] == 'oprun-entry-local-20260914'
assert parsed['api']['port'] == 55321
assert parsed['auth']['site_url'] == 'http://127.0.0.1:3219'
(target / 'supabase/config.toml').write_text(config)
manifest = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (source / 'migrations').glob('*.sql')}
(target / 'source-manifest.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps({'prepared': True, 'project': str(target), 'migrations': len(manifest), 'linked': False}))
