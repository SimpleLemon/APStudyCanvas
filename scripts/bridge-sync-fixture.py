"""Isolated JSON-line fixture: real Flask routes/services, temporary databases only."""
import contextlib
import hashlib
import json
import sys
from tests.test_extension_calendar_routes import ExtensionCalendarRouteTests
from services.calendar_store import calendar_connection
from services.extension_mirrors import inspect_item, change_item

fixture = ExtensionCalendarRouteTests()
with contextlib.redirect_stdout(sys.stderr):
    fixture.setUp()
client = fixture.client('user-1')
accounts = []


def dispatch(message):
    action = message['action']
    if action == 'seed':
        caps = ('calendar_read', 'calendar_upload', 'calendar_shares_ics', 'calendar_two_way_writeback', 'calendar_mirroring')
        for user in ('1', '2'):
            origin = 'https://canvas.example.edu'
            account = hashlib.sha256(f'canvas-account-v1\0{origin}\0{user}'.encode()).hexdigest()
            fixture.grant(client, account_key=account, capabilities=caps)
            token = fixture.csrf(client)
            response = client.post('/api/extension/calendar/sources', json={'account_key':account,'source_id':'source-'+user,'origin':origin,'provider_user_id':user,'label':'Canvas '+user,'consent_version':1},headers={'X-CSRFToken':token})
            assert response.status_code == 200, response.get_data(as_text=True)
            source = response.get_json()['source']
            response = client.put('/api/extension/consent',json={'version':2,'account_key':account,'source_key':'canvas:'+account,'action':'grant','scopes':['personal_events_write','planner_items_write','selected_item_mirroring']},headers={'X-CSRFToken':token})
            assert response.status_code == 200, response.get_data(as_text=True)
            accounts.append({'account_key':account,'source_ref':source['source_ref'],'source_key':'canvas:'+account,'origin':origin,'nest_user_id':'user-1','provider_user_id':user})
        with calendar_connection() as c:
            for name in ('one','two','three'):
                c.execute('INSERT INTO user_events (id,user_id,title,description,start,end,is_all_day,created_at) VALUES (?,?,?,?,?,?,?,?)',[name,'user-1','Nest '+name,'','2026-09-09T12:00:00Z','2026-09-09T13:00:00Z',0,'2026-09-09T00:00:00Z'])
        return accounts
    if action == 'request':
        response=client.open(message['path'],method=message.get('method','GET'),headers=message.get('headers',{}),data=message.get('body'))
        return {'status':response.status_code,'headers':dict(response.headers),'body':response.get_data(as_text=True)}
    if action == 'mirror':
        view=inspect_item('user-1','user:'+message['item'])
        return change_item('user-1',{'event_ref':'user:'+message['item'],'source_ref':accounts[message.get('account',0)]['source_ref'],'action':'mirror','expected_revision':view['expected_revision']})
    if action == 'edit':
        with calendar_connection() as c:
            c.execute('UPDATE user_events SET title=? WHERE id=? AND user_id=?',[message['title'],message.get('item','one'),'user-1'])
        return True
    if action == 'state':
        with calendar_connection() as c:
            return {table:[dict(row) for row in c.execute('SELECT * FROM '+table)] for table in ('user_events','calendar_event_links','calendar_writebacks')}
    if action == 'unlink':
        view=inspect_item('user-1','user:'+message.get('item','one'))
        return change_item('user-1',{'event_ref':view['event_ref'],'source_ref':accounts[message.get('account',0)]['source_ref'],'action':'unlink','expected_revision':view['expected_revision']})
    raise ValueError('Unknown fixture command')

try:
    for line in sys.stdin:
        try:
            with contextlib.redirect_stdout(sys.stderr), fixture.app.app_context():
                result=dispatch(json.loads(line))
            print(json.dumps({'ok':True,'result':result}),flush=True)
        except Exception as error:
            import traceback
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({'ok':False,'error':str(error)}),flush=True)
finally:
    with contextlib.redirect_stdout(sys.stderr):
        fixture.doCleanups()
