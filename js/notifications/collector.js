// Executed in the existing Canvas tab's isolated world, never in the background's origin.
async function collectCanvasNotifications(expectedOrigin, expectedUserId) {
    const modules = globalThis.APStudyCanvasContent;
    if (location.origin !== expectedOrigin || !modules?.TodoApi || !modules?.TodoModel) throw new Error('Canvas connection unavailable');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 25000);
    const origin = location.origin;
    async function read(path) {
        const url = new URL(path, origin);
        if (url.origin !== origin || !url.pathname.startsWith('/api/v1/') || url.username || url.password) throw new Error('Invalid Canvas URL');
        const response = await fetch(url.href, { credentials: 'include', redirect: 'error', cache: 'no-store', signal: abort.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('Canvas refresh failed');
        return response;
    }
    async function pages(path) {
        const items = [], seen = new Set();
        let next = path;
        for (let i = 0; next && i < 50; i++) {
            const url = new URL(next, origin);
            if (seen.has(url.href) || url.pathname !== new URL(path, origin).pathname) throw new Error('Invalid pagination');
            seen.add(url.href);
            const response = await read(url.href);
            const body = await response.json();
            if (!Array.isArray(body)) throw new Error('Invalid Canvas response');
            items.push(...body);
            next = response.headers.get('Link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
        }
        if (next) throw new Error('Canvas page limit reached');
        return items;
    }
    try {
        const user = await (await read('/api/v1/users/self/profile')).json();
        if (String(user.id) !== String(expectedUserId)) throw new Error('Canvas account changed');
        const accountKey = await globalThis.APStudyCanvasCanvasAdapter.Identity.accountKey({ origin, userId: user.id });
        const options = { origin, userId: user.id, accountKey, timeZone: user.time_zone };
        const courses = await pages('/api/v1/courses?enrollment_state=active&enrollment_type=student&per_page=100');
        const activities = [], tasks = [];
        const local = await chrome.storage.local.get(`todo-completion:${accountKey}`);
        const completed = local[`todo-completion:${accountKey}`] || {};
        for (const course of courses) {
            if (!/^\d+$/.test(String(course.id))) throw new Error('Invalid course');
            const assignments = await pages(`/api/v1/courses/${course.id}/assignments?include[]=submission&per_page=100`);
            for (const raw of assignments) {
                const result = await modules.TodoModel.normalizeCanvasTask('assignment', { ...raw, course_id: course.id }, { ...options, course });
                if (!result.ok) throw new Error('Invalid assignment');
                const task = result.task;
                const item = { id: task.id, title: task.title, course: course.course_code || course.name, url: task.url, due: task.due, completed: task.completion || completed[task.id] === true, submitted: task.submitted };
                tasks.push(item);
                const submission = raw.submission || {};
                // posted_at explicitly null means the instructor has not released this grade.
                const visible = submission.grade != null && submission.grade !== '' && submission.workflow_state === 'graded' && submission.posted_at !== null;
                activities.push({ ...item, id: `grade:${task.id}`, kind: 'grades', title: `Grade updated: ${task.title}`, revision: visible ? JSON.stringify([submission.grade, submission.score]) : 'ungraded' });
            }
        }
        // Personal Canvas planner notes also have due dates, distinct from planned work sessions.
        const date = offset => modules.TodoTime.localDateKey(Date.now() + offset * 86400000, user.time_zone);
        const planner = await modules.TodoApi.fetchCanvasPlanner({ origin, range: { start: date(-30), end: date(30) }, signal: abort.signal, fetchImpl: url => read(url) });
        if (!planner.ok) throw new Error('Planner unavailable');
        for (const row of planner.items || []) {
            if (row.plannable_type !== 'planner_note') continue;
            const raw = { ...row, ...row.plannable, id: row.plannable_id || row.plannable?.id, todo_date: row.plannable?.todo_date || row.plannable_date, planner_override: row.planner_override };
            const result = await modules.TodoModel.normalizeCanvasTask('planner_note', raw, options);
            if (!result.ok) throw new Error('Invalid planner note');
            const task = result.task;
            tasks.push({ id: task.id, title: task.title, course: 'Personal task', url: task.url || '/planner', due: task.due, completed: task.completion, submitted: task.submitted });
        }
        if (courses.length) {
            const result = await modules.TodoApi.fetchCanvasAnnouncements({ origin, contextCodes: courses.map(c => `course_${c.id}`), signal: abort.signal, fetchImpl: (url) => read(url) });
            if (!result.ok) throw new Error('Announcements unavailable');
            for (const raw of result.items || []) {
                const courseId = String(raw.context_code || '').replace('course_', '') || String(raw.course_id || '');
                const course = courses.find(c => String(c.id) === courseId);
                if (Date.parse(raw.posted_at || raw.created_at) > Date.now()) continue;
                activities.push({ id: `announcement:${courseId}:${raw.id}`, kind: 'announcements', revision: 'new', title: raw.title || 'Canvas announcement', course: course?.course_code || course?.name || '', url: raw.html_url });
            }
        }
        const endUser = await (await read('/api/v1/users/self/profile')).json();
        if (String(endUser.id) !== String(user.id) || location.origin !== origin) throw new Error('Canvas account changed');
        return { activities, tasks };
    } finally { clearTimeout(timer); }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { collectCanvasNotifications };
