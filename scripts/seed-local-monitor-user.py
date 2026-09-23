import sys,runpy,contextlib,io,json,secrets
from pathlib import Path
sys.argv=['local-ten-hr.py','status']
with contextlib.redirect_stdout(io.StringIO()):scope=runpy.run_path(str(Path(__file__).with_name('local-ten-hr.py')),run_name='monitor_fixture')
from models import db,HrUser,HrOperator
path=scope['DATA']/'monitor-user-private.json'
with scope['app'].app_context():
    if not path.exists():
        account='qa-local-ten-monitor'
        assert not HrUser.query.filter_by(account_id=account).first()
        password=secrets.token_urlsafe(24)
        user=HrUser(account_id=account,is_active=True);user.set_password(password);db.session.add(user);db.session.flush()
        db.session.add(HrOperator(user_id=user.id,operator_id=account,name='本地验收员',role='admin',permissions=['*'],status='active'));db.session.commit()
        path.write_text(json.dumps({'account_id':account,'password':password}),encoding='utf8')
print('LOCAL_MONITOR_USER_READY')
