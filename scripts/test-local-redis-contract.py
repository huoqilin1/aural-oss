"""Exercise real HR nonce/blacklist storage across independent processes."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

if len(sys.argv) > 1 and sys.argv[1] == '--worker':
    sys.path.insert(0, os.environ['LOCAL_HR_BACKEND'])
    from core.auth_middleware import _NonceStore, _TokenBlacklist
    store, blacklist = _NonceStore(), _TokenBlacklist()
    assert store._redis is not None and blacklist._redis is not None
    while time.time() < float(os.environ['LOCAL_START_AT']):
        time.sleep(0.005)
    nonce = os.environ['LOCAL_NONCE']
    if os.environ.get('LOCAL_REVOKE') == '1':
        blacklist.revoke(nonce, 60)
    print(json.dumps({'replay': store.has_nonce(nonce), 'revoked': blacklist.is_revoked(nonce),
        'redis': True, 'ttl': store._redis.ttl('mall_nonce:' + nonce)}))
    sys.exit(0)

aural = Path(__file__).resolve().parents[1]
hr = Path(sys.argv[1]).resolve(strict=True)
runtime = aural / 'output/local-sandbox' / ('redis-contract-' + uuid.uuid4().hex)
runtime.mkdir(parents=True)
helper = '/mnt/' + aural.drive[0].lower() + str(aural)[2:].replace('\\', '/') + '/scripts/local-redis-fixture.py'
platform = {k: v for k, v in os.environ.items() if k.upper() in {
    'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'USERPROFILE'}}
fixture = None
children = []
report = {'passed': False, 'fullInterviewAcceptancePassed': False}
try:
    setup = subprocess.run(['wsl', '-d', 'Ubuntu', '--', 'python3', helper, 'start'],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
    assert setup.returncode == 0, 'Redis fixture setup failed'
    fixture = json.loads(setup.stdout)
    nonce = 'local-' + uuid.uuid4().hex
    env = {**platform, 'REDIS_URL': f"redis://:{fixture['password']}@127.0.0.1:{fixture['port']}/0",
        'LOCAL_HR_BACKEND': str(hr / 'backend'), 'LOCAL_NONCE': nonce,
        'LOCAL_START_AT': str(time.time() + 3), 'OPRUN_LOAD_DOTENV': 'false'}
    for _ in range(8):
        children.append(subprocess.Popen([sys.executable, __file__, '--worker'], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace'))
    results = []
    for child in children:
        stdout, _ = child.communicate(timeout=15)
        assert child.returncode == 0, 'Nonce worker failed'
        results.append(json.loads(stdout))
    assert sum(not r['replay'] for r in results) == 1
    assert all(r['redis'] and 0 < r['ttl'] <= 300 for r in results)
    env['LOCAL_REVOKE'] = '1'
    first = subprocess.run([sys.executable, __file__, '--worker'], env=env, capture_output=True, text=True, timeout=15)
    assert first.returncode == 0
    assert json.loads(first.stdout)['revoked']
    env.pop('LOCAL_REVOKE')
    restarted = subprocess.run([sys.executable, __file__, '--worker'], env=env, capture_output=True, text=True, timeout=15)
    assert restarted.returncode == 0
    restored = json.loads(restarted.stdout)
    assert restored['replay'] and restored['revoked']
    report.update(passed=True, workers=8, acceptedNonce=1, rejectedReplays=7,
        nonceTtlVerified=True, newProcessRetainsNonce=True, newProcessRetainsBlacklist=True)
except Exception as error:
    report['errorType'] = type(error).__name__
    report['error'] = str(error) if isinstance(error, AssertionError) else 'Fixture execution failed'
finally:
    for child in children:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
    if fixture:
        stopped = subprocess.run(['wsl', '-d', 'Ubuntu', '--', 'python3', helper, 'stop', fixture['runtime']],
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
        report['fixtureStopped'] = stopped.returncode == 0
        report['fixtureRuntime'] = fixture['runtime']
        if stopped.returncode:
            report['passed'] = False
    (runtime / 'result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))
sys.exit(0 if report['passed'] else 1)
