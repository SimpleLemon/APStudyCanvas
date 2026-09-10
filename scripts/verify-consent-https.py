"""Reproduce Nest's HTTPS consent CSRF boundary using temporary fixture data.

Run with Nest's Python environment and pass its repository path as argv[1].
No production requests or databases are used.
"""
import sys

sys.path.insert(0, sys.argv[1])
from tests.test_extension_calendar_routes import ExtensionCalendarRouteTests, ACCOUNT_1

fixture = ExtensionCalendarRouteTests()
fixture.setUp()
try:
    client = fixture.client('user-1')
    fixture.enable_capabilities('calendar_read', 'calendar_upload', 'calendar_shares_ics')
    payload = {
        'version': 1, 'source_key': 'canvas:' + ACCOUNT_1,
        'account_key': ACCOUNT_1, 'action': 'grant',
        'scopes': ['full_history_upload', 'ongoing_read', 'shares_ics_inclusion'],
    }
    for referrer, expected in [(None, 400), (None, 400), ('https://localhost/extension/connect', 200)]:
        # Refreshing the token does not repair the missing HTTPS referrer.
        headers = {'X-CSRFToken': fixture.csrf(client)}
        if referrer:
            headers['Referer'] = referrer
        result = client.put('/api/extension/consent', base_url='https://localhost', json=payload, headers=headers)
        assert result.status_code == expected, result.get_data(as_text=True)
        if expected == 400:
            assert result.headers.get('X-APStudy-CSRF-Error') == '1'
        else:
            assert result.get_json()['consent']['granted'] is True
        print(f'same-origin referrer={bool(referrer)}: HTTP {result.status_code}')
finally:
    fixture.doCleanups()
