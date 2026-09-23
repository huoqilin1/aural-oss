"""Four database behavior gates, fresh local database, no external sockets."""
import os, json, subprocess, socket, sys
from pathlib import Path
from urllib.parse import quote
import psycopg2
from psycopg2 import sql

base='/home/wanghostname/.local/share/oprun-local-acceptance'
result=subprocess.run(['wsl.exe','-u','root','-e','env',
    'DOCKER_HOST=unix://'+base+'/docker-runtime/docker.sock',
    base+'/docker-tools/docker/docker','inspect',
    'supabase_db_oprun-entry-local-20260914','--format','{{json .Config.Env}}'],
    capture_output=True,text=True,check=True)
values=dict(x.split('=',1) for x in json.loads(result.stdout) if '=' in x)
password=values['POSTGRES_PASSWORD']
database='hr_local_gate_20260915_1850'
connection=psycopg2.connect(host='127.0.0.1',port=55322,user='postgres',password=password,dbname='postgres',connect_timeout=8)
connection.autocommit=True
with connection.cursor() as cursor:
    cursor.execute('SELECT 1 FROM pg_database WHERE datname=%s',(database,))
    assert cursor.fetchone() is None,'Existing gate database: inspect before retry'
    cursor.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(database)))
connection.close()
os.environ['DATABASE_URL']='postgresql://postgres:'+quote(password,safe='')+'@127.0.0.1:55322/'+database
os.environ['OPRUN_HR_AUTO_CREATE_SCHEMA']='1'
os.environ['OPRUN_OUTBOUND_MODE']='record_only'
os.environ['SECRET_KEY']='local-postgres-gate-secret'
os.environ['JWT_SECRET_KEY']='local-postgres-gate-jwt'
os.environ['REDIS_URL']='redis://127.0.0.1:9/0'
original=socket.socket.connect
def local_only(self,address):
    if isinstance(address,tuple) and address[0] not in ('127.0.0.1','::1','localhost'):
        raise RuntimeError('Local database gate forbids external network')
    return original(self,address)
socket.socket.connect=local_only
backend=Path('D:/GGGG/kiro/oprun-hr-quality-release/backend')
os.chdir(backend);sys.path.insert(0,str(backend))
import pytest
raise SystemExit(pytest.main(['-q',
    'tests/test_recruit_postgres_concurrency.py',
    'tests/test_hr_recording_concurrency.py',
    'tests/test_hr_model_usage.py::test_postgres_usage_survives_business_rollback']))
