(function (root, factory) {
    "use strict";

    const adapter = root?.APStudyCanvasCanvasAdapter || {};
    const content = root?.APStudyCanvasContent || {};
    const identity = adapter.Identity || (typeof require === "function" ? require("../canvas-adapter/identity.js") : null);
    const pagination = adapter.Pagination || (typeof require === "function" ? require("../canvas-adapter/pagination.js") : null);
    const model = root?.APStudyCanvasSidebarModel || (typeof require === "function" ? require("./sidebar-model.js") : null);
    const context = content.Context || (typeof require === "function" ? require("./context.js") : null);
    const api = factory(identity, pagination, model, context);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { SidebarAdapter: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (identity, pagination, model, context) {
    "use strict";

    const VERSION = 1;
    const API_PAGE_SIZE = 100;
    const MAX_API_PAGES = 100;
    const COURSE_PATH = "/api/v1/courses";
    const USER_PATH = "/api/v1/users/self";
    const UNREAD_PATH = "/api/v1/conversations/unread_count";
    const KNOWN_PAGES = Object.freeze([
        Object.freeze({ id: "dashboard", label: "Dashboard", iconRole: "dashboard", paths: ["/", "/dashboard"] }),
        Object.freeze({ id: "courses", label: "Courses", iconRole: "courses", paths: ["/courses"] }),
        Object.freeze({ id: "calendar", label: "Calendar", iconRole: "calendar", paths: ["/calendar"] }),
        Object.freeze({ id: "inbox", label: "Inbox", iconRole: "inbox", paths: ["/conversations", "/inbox"] }),
        Object.freeze({ id: "history", label: "History", iconRole: "history", paths: ["/users/self/history", "/history"] }),
        Object.freeze({ id: "help", label: "Help", iconRole: "help", paths: ["/help"] })
    ]);
    // These controls route to existing Canvas or APStudyCanvas surfaces. They
    // deliberately carry an action rather than masquerading as Canvas links:
    // Notes and Study open their already-mounted UI, while Planner and Grades
    // use the same-origin destinations Canvas already owns.
    const APSTUDY_PAGES = Object.freeze([
        Object.freeze({ id: "apstudy:planner", label: "Planner", href: "/planner", action: "planner", iconRole: "planner" }),
        Object.freeze({ id: "apstudy:notes", label: "Notes", action: "notes", iconRole: "notes" }),
        Object.freeze({ id: "apstudy:grades", label: "Grades", href: "/grades", action: "grades", iconRole: "grades" }),
        Object.freeze({ id: "apstudy:study", label: "Study", action: "study", iconRole: "study" })
    ]);
    const KNOWN_BY_ID = new Map(KNOWN_PAGES.map((page) => [page.id, page]));
    const PAGE_SELECTORS = Object.freeze({
        dashboard: "#global_nav_dashboard_link, #global-nav-dashboard-link",
        courses: "#global_nav_courses_link, #global-nav-courses-link",
        calendar: "#global_nav_calendar_link, #global-nav-calendar-link",
        inbox: "#global_nav_conversations_link, #global_nav_inbox_link, #global-nav-inbox-link",
        history: "#global_nav_history_link, #global-nav-history-link",
        help: "#global_nav_help_link, #global-nav-help-link",
    });
    const NAV_SELECTORS = "#global_nav, #global-nav, .ic-app-header";
    const LOGO_SELECTORS = "#global_nav_logo, #global-nav-logo, .ic-app-header__logomark, .ic-app-header__logo, .ic-app-header__brand";
    const PROFILE_SELECTORS = "#global_nav_profile_link, [data-testid='account-nav'], [data-testid='global-nav-profile']";
    const DASHBOARD_COURSE_SELECTORS = "a.ic-DashboardCard__link[href], #DashboardCard_Container a[href]";
    const SECRET_URL_PART = /(?:access[_-]?token|api[_-]?key|authorization|bearer|cookie|credential|csrf|jwt|password|private|secret|session|signature|token)/i;
    const COURSE_ID = /^[1-9]\d{0,19}$/;

    function isObject(value) {
        return Boolean(value && typeof value === "object" && !Array.isArray(value));
    }

    function text(value, limit = 160) {
        if (typeof value !== "string" && typeof value !== "number") return null;
        const result = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
        return result ? result.slice(0, limit) : null;
    }

    function normalizedOrigin(value) {
        return identity?.normalizeCanvasOrigin?.(value) || context?.normalizeCanvasOrigin?.(value) || null;
    }

    function currentOrigin(location, explicitOrigin) {
        let supplied = explicitOrigin || location?.origin || (location?.protocol && location?.host ? `${location.protocol}//${location.host}` : null);
        if (!supplied && (typeof location === "string" || location instanceof URL)) {
            try { supplied = new URL(String(location)).origin; } catch (error) { supplied = null; }
        }
        return normalizedOrigin(supplied);
    }

    function safeUrl(value, origin, { courseId = null, available = true, verified = true } = {}) {
        if (available === false || verified === false || typeof value !== "string" || !origin) return null;
        const candidate = value.trim();
        if (!candidate
            || candidate.includes("#")
            || candidate.startsWith("//")
            || candidate.toLowerCase().startsWith("javascript:")) return null;
        let url;
        try { url = new URL(candidate, origin); } catch (error) { return null; }
        if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash) return null;
        for (const [key, parameter] of url.searchParams.entries()) {
            if (SECRET_URL_PART.test(key) || SECRET_URL_PART.test(parameter)) return null;
        }
        if (courseId !== null && url.pathname !== `/courses/${courseId}` && url.pathname !== `/courses/${courseId}/`) return null;
        return url.href;
    }

    function canonicalPath(value, origin) {
        let url;
        try { url = value instanceof URL ? new URL(value.href) : new URL(String(value || "/"), origin || undefined); } catch (error) { return null; }
        if (origin && url.origin !== origin) return null;
        let pathname = url.pathname || "/";
        pathname = pathname.replace(/\/+/g, "/");
        if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
        return pathname || "/";
    }

    function routeMatchesPath(pathname, candidate, origin) {
        const path = canonicalPath(pathname, origin);
        const target = canonicalPath(candidate, origin);
        if (!path || !target) return false;
        return path === target || target !== "/" && path.startsWith(`${target}/`);
    }

    function unknownPageIdForRoute(pathname) {
        const path = canonicalPath(pathname) || "/";
        const hash = identity?.sha256HexSync?.(`canvas-sidebar-route-v${VERSION}\u0000${path}`) || Array.from(path).map((character) => character.charCodeAt(0).toString(16)).join("");
        return `canvas-route:${hash.slice(0, 40)}`;
    }

    function parseCanvasRoute(value, { origin: explicitOrigin } = {}) {
        const origin = currentOrigin(value?.location || value, explicitOrigin);
        const source = value?.location || value;
        let url;
        try {
            url = source instanceof URL ? new URL(source.href) : new URL(source?.href || source?.pathname || String(source || "/"), origin || undefined);
        } catch (error) {
            return { origin, pathname: null, kind: "unknown", pageId: null, courseId: null, resource: null };
        }
        const pathname = canonicalPath(url, origin);
        if (!pathname) return { origin, pathname: null, kind: "unknown", pageId: null, courseId: null, resource: null };
        const courseMatch = pathname.match(/^\/courses\/([1-9]\d{0,19})(?:\/(.*))?$/);
        if (courseMatch) {
            const resource = courseMatch[2] ? courseMatch[2].split("/").filter(Boolean) : [];
            return { origin, pathname, kind: "course", pageId: "courses", courseId: courseMatch[1], resource };
        }
        const known = KNOWN_PAGES.find((page) => {
            // A malformed course path must not fall back to the global Courses
            // destination; otherwise `/courses/42x` would look actionable.
            if (page.id === "courses" && pathname.startsWith("/courses/")) return false;
            return page.paths.some((candidate) => routeMatchesPath(pathname, candidate, origin));
        });
        if (known) return { origin, pathname, kind: known.id, pageId: known.id, courseId: null, resource: pathname.split("/").filter(Boolean) };
        return { origin, pathname, kind: "unknown", pageId: unknownPageIdForRoute(pathname), courseId: null, resource: pathname.split("/").filter(Boolean) };
    }

    function routeMatches(page, routeOrLocation, options = {}) {
        const pageId = typeof page === "string" ? page : page?.id;
        if (!pageId) return false;
        const route = routeOrLocation?.kind ? routeOrLocation : parseCanvasRoute(routeOrLocation, options);
        if (typeof page === "object") {
            const rawHref = typeof page?.href === "string" ? page.href.trim() : "";
            if (page?.available === false
                || !rawHref
                || rawHref.startsWith("#")
                || rawHref.startsWith("//")
                || rawHref.toLowerCase().startsWith("javascript:")) return false;
            const routeOrigin = route?.origin || currentOrigin(routeOrLocation, options.origin);
            if (routeOrigin && !safeUrl(rawHref, routeOrigin)) return false;
        }
        if (pageId === "courses" && route.kind === "course") return true;
        if (pageId === route.pageId) return true;
        const href = typeof page === "object" ? page.href : null;
        return Boolean(href && route.pathname && routeMatchesPath(route.pathname, href, route.origin));
    }

    function nodeAttribute(node, name) {
        return node?.getAttribute?.(name) || node?.[name] || null;
    }

    function firstNode(document, selector) {
        try { return document?.querySelector?.(selector) || null; } catch (error) { return null; }
    }

    function allNodes(root, selector) {
        try {
            if (root?.querySelectorAll) return Array.from(root.querySelectorAll(selector));
        } catch (error) { /* A partially initialized Canvas DOM is normal during boot. */ }
        return [];
    }

    function nodeLabel(node, fallback) {
        return text(nodeAttribute(node, "aria-label") || nodeAttribute(node, "title") || node?.textContent, 120) || fallback;
    }

    // Some institutions ship the nav logomark as a CSS background rather than
    // an <img>; read the declared style before falling back to computed style.
    function cssBackgroundUrl(node) {
        if (!node) return null;
        let declared = String(node.style?.backgroundImage || "");
        if (!declared && typeof globalThis.getComputedStyle === "function") {
            try { declared = String(globalThis.getComputedStyle(node)?.backgroundImage || ""); } catch (error) { declared = ""; }
        }
        const match = /url\((?:['"]?)([^'")]+)(?:['"]?)\)/.exec(declared);
        return match?.[1] || null;
    }

    function parseCount(node) {
        if (!node) return null;
        const direct = [nodeAttribute(node, "data-unread-count"), nodeAttribute(node, "data-count")];
        for (const value of direct) {
            if (/^\d{1,6}$/.test(String(value || "").trim())) return Number(value);
        }
        const badge = firstNode(node, ".menu-item__badge, .ic-notification-badge, [data-testid='unread-count'], [data-unread-count], [data-count]");
        const raw = text(nodeAttribute(badge, "data-unread-count") || nodeAttribute(badge, "data-count") || badge?.textContent, 80);
        if (raw && /^\d{1,6}$/.test(raw)) return Number(raw);
        const labelled = [nodeAttribute(node, "aria-label"), nodeAttribute(node, "title")].find((value) => /\d/.test(String(value || "")));
        const match = String(labelled || "").match(/\b(\d{1,6})\b/);
        return match ? Number(match[1]) : null;
    }

    function unreadCount(unread, category = "conversations") {
        const value = unread?.categories?.[category] ?? unread?.[category] ?? unread?.count ?? unread?.unread_count;
        const count = Number(value);
        return Number.isSafeInteger(count) && count >= 0 ? count : null;
    }

    function discoverIdentity({ document, location, origin: explicitOrigin, profile, canvasUser, apiUser, accountKey: suppliedAccountKey, userId: suppliedUserId } = {}) {
        const origin = currentOrigin(location, explicitOrigin);
        const logo = firstNode(document, LOGO_SELECTORS);
        const logoImage = firstNode(logo, "img") || (String(logo?.tagName || "").toLowerCase() === "img" ? logo : null);
        const logoUrl = safeUrl(
            nodeAttribute(logoImage, "src")
            || nodeAttribute(logoImage, "data-src")
            || nodeAttribute(logo, "data-logo-url")
            || cssBackgroundUrl(logoImage || logo),
            origin
        );
        const institutionName = text(
            nodeAttribute(logoImage, "alt") || nodeAttribute(logo, "aria-label") || nodeAttribute(logo, "title") || logo?.textContent,
            120
        );

        const profileNode = firstNode(document, PROFILE_SELECTORS);
        const profileImage = firstNode(profileNode, "img") || (String(profileNode?.tagName || "").toLowerCase() === "img" ? profileNode : null);
        const domName = text(nodeAttribute(profileNode, "data-user-name") || nodeAttribute(profileNode, "aria-label") || nodeAttribute(profileNode, "title") || nodeAttribute(profileImage, "alt"), 120);
        const domAvatar = nodeAttribute(profileImage, "src") || nodeAttribute(profileImage, "data-src") || nodeAttribute(profileNode, "data-avatar-url");
        const rawUser = apiUser || canvasUser || (profile ? { id: suppliedUserId, name: profile.displayName || profile.name, avatar_url: profile.avatarUrl || profile.avatar_url } : null);
        const sanitized = context?.sanitizeCanvasUser
            ? context.sanitizeCanvasUser(rawUser || {}, origin)
            : { id: text(rawUser?.id, 120), name: text(rawUser?.name || rawUser?.display_name, 120), avatarUrl: safeUrl(rawUser?.avatar_url || rawUser?.avatarUrl, origin) };
        const avatarUrl = sanitized.avatarUrl || (context?.safeAvatar ? context.safeAvatar(domAvatar, origin) : safeUrl(domAvatar, origin));
        const name = sanitized.name || domName || null;
        const userId = sanitized.id || text(suppliedUserId, 120) || null;
        const accountKey = /^[a-f0-9]{64}$/i.test(String(suppliedAccountKey || "")) ? String(suppliedAccountKey).toLowerCase() : null;
        return {
            origin,
            userId,
            accountKey,
            institution: { markUrl: logoUrl, name: institutionName || null },
            user: { avatarUrl: avatarUrl || null, name },
            // These aliases make the adapter convenient for the identity header
            // without requiring the renderer to know the nested shape.
            institutionMarkUrl: logoUrl,
            institutionName: institutionName || null,
            userAvatarUrl: avatarUrl || null,
            userName: name
        };
    }

    function pageFromNode({ id, node, origin, unread } = {}) {
        const known = KNOWN_BY_ID.get(id);
        const href = safeUrl(nodeAttribute(node, "href"), origin);
        const count = id === "inbox" ? parseCount(node) ?? unreadCount(unread) : parseCount(node);
        const result = {
            id,
            label: nodeLabel(node, known?.label || id),
            href,
            source: "canvas",
            iconRole: known?.iconRole || "canvas",
            available: Boolean(href),
            known: Boolean(known)
        };
        if (count !== null) { result.unread = count; result.count = count; }
        return result;
    }

    function discoverPages({ document, location, origin: explicitOrigin, unread } = {}) {
        const origin = currentOrigin(location, explicitOrigin);
        const nav = firstNode(document, NAV_SELECTORS) || document;
        const pages = KNOWN_PAGES.map((known) => pageFromNode({ id: known.id, node: firstNode(nav, PAGE_SELECTORS[known.id]), origin, unread }));
        const knownNodes = new Set(pages.map((page) => firstNode(nav, PAGE_SELECTORS[page.id])).filter(Boolean));
        const seen = new Set(pages.map((page) => page.href).filter(Boolean));
        for (const node of allNodes(nav, "a[href]")) {
            if (knownNodes.has(node)) continue;
            const href = safeUrl(nodeAttribute(node, "href"), origin);
            if (!href || seen.has(href)) continue;
            const route = parseCanvasRoute(href, { origin });
            const id = route.kind === "unknown" ? route.pageId : route.kind;
            if (!id || KNOWN_BY_ID.has(id)) continue;
            seen.add(href);
            pages.push({
                id,
                label: nodeLabel(node, route.pathname || "Canvas page"),
                href,
                source: "canvas",
                iconRole: "canvas",
                available: true,
                known: false,
                ...(parseCount(node) === null ? {} : { unread: parseCount(node), count: parseCount(node) })
            });
        }
        APSTUDY_PAGES.forEach((page) => {
            const href = page.href ? safeUrl(page.href, origin) : null;
            pages.push({
                ...page,
                href,
                source: "apstudycanvas",
                available: true,
                known: true
            });
        });
        return pages;
    }

    function normalizeCourseId(value) {
        if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
        const candidate = String(value ?? "").trim();
        return COURSE_ID.test(candidate) ? candidate : null;
    }

    function normalizeColor(value) {
        const candidate = text(value, 32);
        if (!candidate) return null;
        if (/^#[0-9a-f]{3,8}$/i.test(candidate)) return candidate;
        if (/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\)$/i.test(candidate)) return candidate;
        return null;
    }

    function enrollmentIsActive(enrollment) {
        if (!isObject(enrollment)) return false;
        const state = enrollment.enrollment_state ?? enrollment.workflow_state ?? enrollment.state;
        return state === "active";
    }

    function isPublishedActiveCourse(course, { serverFilteredActive = false } = {}) {
        if (!isObject(course)) return false;
        if (course.available === false || course.published === false || course.is_published === false || course.concluded === true) return false;
        const availability = String(course.availability ?? course.access_state ?? "").toLowerCase();
        if (["unavailable", "unpublished", "private", "restricted", "concluded"].includes(availability)) return false;
        const workflow = String(course.workflow_state ?? course.course_state ?? "").toLowerCase();
        if (workflow && !["available", "published", "active"].includes(workflow)) return false;
        const courseEnrollmentState = course.enrollment_state ?? course.enrollment?.enrollment_state ?? course.enrollment?.workflow_state;
        if (courseEnrollmentState !== undefined && courseEnrollmentState !== null && courseEnrollmentState !== "active") return false;
        // The active-course endpoint establishes enrollment safety through its
        // request filters. Canvas may still include an empty or non-authoritative
        // `enrollments` array in those results, so only the response path marked
        // by fetchCourses may ignore that collection. Direct normalization stays
        // fail-closed when enrollment data is explicitly supplied.
        if (!serverFilteredActive && Object.prototype.hasOwnProperty.call(course, "enrollments")) {
            if (!Array.isArray(course.enrollments) || !course.enrollments.length || !course.enrollments.some(enrollmentIsActive)) return false;
        }
        return true;
    }

    function normalizeCourse(course, { origin, sourceOrder = 0, serverFilteredActive = false } = {}) {
        const id = normalizeCourseId(course?.id ?? course?.course_id);
        if (!id || !origin || !isPublishedActiveCourse(course, { serverFilteredActive })) return null;
        const name = text(course.name || course.original_name || course.course_code, 160);
        if (!name) return null;
        return {
            id,
            courseId: id,
            name,
            href: `${origin}/courses/${id}`,
            color: normalizeColor(course.course_color ?? course.color ?? course.brand_color),
            sourceOrder: Number.isInteger(sourceOrder) && sourceOrder >= 0 ? sourceOrder : 0,
            available: true,
            published: true
        };
    }

    // Inline display:none is the hide/show signal our own dashboard card
    // customization writes (content.js customizeCards sets card.style.display
    // for custom_cards entries flagged hidden), so the declared style is
    // checked alongside the hidden/aria-hidden/class signals.
    function inlineDisplayNone(node) {
        if (!node) return false;
        const style = node.style;
        if (style && typeof style === "object" && String(style.display || "").trim().toLowerCase() === "none") return true;
        return /(?:^|;)\s*display\s*:\s*none(?:\s*!important)?\s*(?:;|$)/i.test(String(nodeAttribute(node, "style") || ""));
    }

    function isVisibleNode(node) {
        for (let current = node; current; current = current.parentElement) {
            if (nodeAttribute(current, "hidden") !== null || nodeAttribute(current, "aria-hidden") === "true") return false;
            if (/(?:^|\s)(?:hidden|is-hidden)(?:\s|$)/.test(String(nodeAttribute(current, "class") || ""))) return false;
            if (inlineDisplayNone(current)) return false;
        }
        return true;
    }

    // Dashboard cards actually rendered in the page DOM are the authoritative
    // displayed-card set — the same principle BetterCampus applies when it maps
    // its per-card features onto whatever `.ic-DashboardCard` nodes exist.
    // Canvas's dashboard_cards endpoint answers a broader menu question and
    // cannot see client-side hidden cards, so it is not card evidence. Nodes
    // hidden inline (our own custom_cards hide/show path), by attribute, or by
    // class are excluded, as are course ids the caller knows are hidden.
    function discoverDashboardCourses({ document, location, origin: explicitOrigin, hiddenCourseIds = [] } = {}) {
        const origin = currentOrigin(location, explicitOrigin);
        const route = parseCanvasRoute(location, { origin });
        if (!origin || route.kind !== "dashboard") return [];
        const hidden = new Set((Array.isArray(hiddenCourseIds) ? hiddenCourseIds : []).map((id) => normalizeCourseId(id)).filter(Boolean));
        const seen = new Set();
        const courses = [];
        allNodes(document, DASHBOARD_COURSE_SELECTORS).forEach((node) => {
            if (!isVisibleNode(node)) return;
            const href = safeUrl(nodeAttribute(node, "href"), origin);
            const match = href && new URL(href).pathname.match(/^\/courses\/([1-9]\d{0,19})\/?$/);
            const id = match?.[1];
            const name = nodeLabel(node, null);
            if (!id || !name || seen.has(id) || hidden.has(id)) return;
            const course = normalizeCourse({ id, name, workflow_state: "available" }, {
                origin,
                sourceOrder: courses.length,
                serverFilteredActive: true
            });
            if (!course) return;
            seen.add(id);
            courses.push(course);
        });
        return courses;
    }

    function courseTabId(value, fallbackHref, courseId) {
        const candidate = text(value, 120);
        if (candidate && model?.isStableId?.(candidate)) return candidate;
        const path = canonicalPath(fallbackHref, null) || "/";
        const seed = `canvas-course-tab-v${VERSION}\u0000${courseId}\u0000${path}`;
        const hash = identity?.sha256HexSync?.(seed) || Array.from(seed).map((character) => character.charCodeAt(0).toString(16)).join("");
        return `canvas-course-tab:${hash.slice(0, 40)}`;
    }

    function safeCourseTabUrl(value, origin, courseId) {
        const href = safeUrl(value, origin);
        if (!href || !courseId) return null;
        let url;
        try { url = new URL(href); } catch (error) { return null; }
        const prefix = `/courses/${courseId}`;
        if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
        return href;
    }

    function normalizeCourseTab(tab, { origin, courseId, source = "canvas-api" } = {}) {
        if (!isObject(tab)) return null;
        const id = normalizeCourseId(courseId);
        const href = safeCourseTabUrl(tab.html_url ?? tab.full_url ?? tab.url, origin, id);
        const label = text(tab.label ?? tab.name ?? tab.title, 120);
        if (!id || !href || !label) return null;
        const visibility = String(tab.visibility ?? "").toLowerCase();
        if (tab.hidden === true || ["hidden", "disabled"].includes(visibility)) return null;
        return {
            id: courseTabId(tab.id ?? tab.tab_id, href, id),
            courseId: id,
            label,
            href,
            source: source === "canvas-dom" ? "canvas-dom" : "canvas-api",
            available: true,
            disclosure: true,
            ...(Number.isInteger(tab.position) && tab.position >= 0 ? { position: tab.position } : {})
        };
    }

    function normalizeCourseNavigation(tabs, options = {}) {
        const source = Array.isArray(tabs) ? tabs : [];
        const seen = new Set();
        return source.map((tab) => normalizeCourseTab(tab, options)).filter((tab) => {
            if (!tab || seen.has(tab.id)) return false;
            seen.add(tab.id);
            return true;
        });
    }

    function responseHeader(response, name) {
        const headers = response?.headers;
        if (typeof headers?.get === "function") return headers.get(name) || headers.get(name.toLowerCase()) || "";
        if (!headers || typeof headers !== "object") return "";
        const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
        return key ? String(headers[key] || "") : "";
    }

    async function readResponse(response) {
        if (!response || Number(response.status ?? 200) < 200 || Number(response.status ?? 200) >= 300) throw new Error("Canvas request failed");
        if (typeof response.json === "function") return response.json();
        if (response.data !== undefined) return response.data;
        if (response.body !== undefined) return response.body;
        throw new Error("Canvas JSON response unavailable");
    }

    async function fetchJson({ fetchImpl, url, signal } = {}) {
        if (typeof fetchImpl !== "function") throw new Error("Canvas fetch is unavailable");
        const response = await fetchImpl(url, { method: "GET", credentials: "include", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
        return { response, data: await readResponse(response) };
    }

    async function fetchPaginated({ fetchImpl, firstUrl, origin, signal, maxPages = MAX_API_PAGES, onPage } = {}) {
        const items = [];
        const visited = new Set();
        let next = firstUrl;
        for (let page = 0; next && page < maxPages; page += 1) {
            if (visited.has(next)) throw new Error("Canvas pagination cycle");
            visited.add(next);
            const result = await fetchJson({ fetchImpl, url: next, signal });
            if (!Array.isArray(result.data)) throw new Error("Canvas collection response is not an array");
            items.push(...result.data);
            // The Courses API is normally a single 100-item page, but large
            // institutions can return several pages. Let the rail render the
            // first verified page without waiting on every later request.
            // Progress is observational: a renderer failure must never turn a
            // successful Canvas response into an error state.
            try { onPage?.({ page, items: result.data, allItems: items.slice() }); } catch (error) {}
            const link = responseHeader(result.response, "link");
            if (!link) { next = null; continue; }
            const parsed = pagination?.parseLinkHeader
                ? pagination.parseLinkHeader(link, { expectedOrigin: origin, baseUrl: next })
                : { ok: true, next: null };
            if (!parsed.ok) throw new Error(parsed.code || "Canvas pagination invalid");
            next = parsed.next;
        }
        if (next) throw new Error("Canvas pagination exceeded limit");
        return items;
    }

    async function fetchCurrentUser({ fetchImpl, origin, signal } = {}) {
        try { return (await fetchJson({ fetchImpl, url: `${origin}${USER_PATH}`, signal })).data; }
        catch (error) {
            if (signal?.aborted || error?.name === "AbortError") throw error;
            return null;
        }
    }

    async function fetchUnread({ fetchImpl, origin, signal } = {}) {
        try { return (await fetchJson({ fetchImpl, url: `${origin}${UNREAD_PATH}`, signal })).data; }
        catch (error) {
            if (signal?.aborted || error?.name === "AbortError") throw error;
            return null;
        }
    }

    function courseState(courses, { retryable = false, reason = null } = {}) {
        const normalized = Array.isArray(courses) ? courses : [];
        return { status: normalized.length ? "populated" : "empty", courses: normalized, retryable, reason };
    }

    // Canvas's dashboard_cards endpoint answers "which courses are in this
    // user's dashboard menu", not "which cards are on screen": it keeps courses
    // the user hid and partitions published/unpublished client-side, and it
    // cannot see our own client-side card hiding. Intersecting against it (or
    // unioning it with the DOM) therefore over-shares the rail. The displayed
    // DOM set — persisted per origin for off-dashboard pages — is the evidence
    // the rail mirrors instead.
    function filterCoursesToDashboardCards(courses, cardIds) {
        const source = Array.isArray(courses) ? courses : [];
        const cards = Array.isArray(cardIds) ? cardIds.map((id) => normalizeCourseId(id)).filter(Boolean) : [];
        if (!cards.length) return source;
        const visible = new Set(cards);
        return source.filter((course) => visible.has(normalizeCourseId(course?.id ?? course?.courseId) || ""));
    }

    async function fetchCoursesState({ fetchImpl, origin, signal, maxPages = MAX_API_PAGES, onProgress } = {}) {
        if (!origin) return { status: "error", courses: [], retryable: false, reason: "missing-origin" };
        // A favorite can be concluded, unpublished, or hidden. The rail is a
        // current-study surface, so use Canvas's active, available enrollment
        // collection as its course ceiling; assembly then removes the courses
        // this user hid from their Canvas dashboard cards.
        const url = new URL(`${origin}${COURSE_PATH}`);
        url.searchParams.set("enrollment_state", "active");
        url.searchParams.append("state[]", "available");
        url.searchParams.set("per_page", String(API_PAGE_SIZE));
        try {
            const courses = [];
            const seen = new Set();
            const publish = () => {
                const next = courseState(courses.slice());
                try { onProgress?.(next); } catch (error) {}
            };
            await fetchPaginated({
                fetchImpl,
                firstUrl: url.href,
                origin,
                signal,
                maxPages,
                onPage: ({ items }) => {
                    items.forEach((course) => {
                        const normalized = normalizeCourse(course, {
                            origin,
                            sourceOrder: courses.length,
                            serverFilteredActive: true
                        });
                        if (!normalized || seen.has(normalized.id)) return;
                        seen.add(normalized.id);
                        courses.push(normalized);
                    });
                    publish();
                }
            });
            // A successful empty response still needs to replace the initial
            // loading state, even though no page yielded an eligible course.
            if (!courses.length) publish();
            return courseState(courses);
        } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") throw error;
            return { status: "error", courses: [], retryable: true, reason: "request-failed" };
        }
    }

    async function fetchCourses(options = {}) {
        return (await fetchCoursesState(options)).courses;
    }

    async function fetchCourseNavigation({ courseId, fetchImpl, origin, signal } = {}) {
        const id = normalizeCourseId(courseId);
        if (!id || !origin) return [];
        if (typeof fetchImpl !== "function") throw new Error("Canvas fetch is unavailable");
        try {
            const result = await fetchJson({ fetchImpl, url: `${origin}${COURSE_PATH}/${id}/tabs`, signal });
            if (!Array.isArray(result.data)) throw new Error("Canvas course navigation response is not an array");
            return normalizeCourseNavigation(result.data, { origin, courseId: id, source: "canvas-api" });
        } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") throw error;
            throw error;
        }
    }

    async function getCourseNavigation({ course, courseId = course?.id ?? course?.courseId, fetchImpl, origin, signal, navigationResolver, tabs } = {}) {
        const id = normalizeCourseId(courseId);
        if (!id || !origin) return { courseId: id, loaded: true, available: false, tabs: [] };
        try {
            const raw = Array.isArray(tabs)
                ? tabs
                : typeof navigationResolver === "function"
                    ? await navigationResolver({ course, courseId: id, origin, signal })
                    : await fetchCourseNavigation({ courseId: id, fetchImpl, origin, signal });
            const normalized = normalizeCourseNavigation(raw, {
                origin,
                courseId: id,
                source: typeof navigationResolver === "function" ? "canvas-dom" : "canvas-api"
            });
            return { courseId: id, loaded: true, available: normalized.length > 0, tabs: normalized };
        } catch (error) {
            if (signal?.aborted || error?.name === "AbortError") throw error;
            throw error;
        }
    }

    async function resolveAccountKey({ origin, userId, accountKey: suppliedAccountKey } = {}) {
        if (!origin || !userId || typeof identity?.accountKey !== "function") return null;
        try {
            const expected = await identity.accountKey({ origin, userId });
            if (!/^[a-f0-9]{64}$/i.test(String(expected || ""))) return null;
            if (suppliedAccountKey !== undefined && suppliedAccountKey !== null && String(suppliedAccountKey).toLowerCase() !== String(expected).toLowerCase()) return null;
            return String(expected).toLowerCase();
        } catch (error) { return null; }
    }

    async function resolveIdentity(options = {}) {
        const document = options.document || globalThis.document;
        const location = options.location || globalThis.location;
        const origin = currentOrigin(location, options.origin);
        const apiUser = options.apiUser !== undefined
            ? options.apiUser
            : await fetchCurrentUser({ fetchImpl: options.fetchImpl || globalThis.fetch, origin, signal: options.signal });
        const identityRecord = discoverIdentity({ ...options, document, location, origin, apiUser });
        identityRecord.accountKey = await resolveAccountKey({
            origin,
            userId: identityRecord.userId,
            accountKey: options.accountKey || identityRecord.accountKey
        });
        return {
            apiUser,
            identity: identityRecord,
            account: { origin, userId: identityRecord.userId, accountKey: identityRecord.accountKey }
        };
    }

    async function assembleSidebarModel(options = {}) {
        const document = options.document || globalThis.document;
        const location = options.location || globalThis.location;
        const origin = currentOrigin(location, options.origin);
        const route = parseCanvasRoute(location, { origin });
        // Course discovery is independent of the account badge and unread
        // count. Starting all three immediately keeps the rail responsive on
        // slower Canvas sessions.
        const reportCourses = (result) => {
            if (!result || !Array.isArray(result.courses)) return;
            try { options.onCourses?.({ ...result, courses: result.courses.slice() }); } catch (error) {}
        };
        // Dashboard cards visible in the page DOM are the authoritative
        // displayed-card evidence for the final filter. Discovery always runs
        // — even when the caller pins the active course list — so a
        // post-hydration reconciliation can find card evidence without
        // refetching; only the provisional paint is skipped for pinned
        // callers, because the pinned list already carries the full set.
        const dashboardCardCourses = discoverDashboardCourses({ document, location, origin, hiddenCourseIds: options.hiddenCardCourseIds });
        if (dashboardCardCourses.length && !Array.isArray(options.courses)) reportCourses(courseState(dashboardCardCourses));
        const courseResultPromise = Array.isArray(options.courses)
            ? Promise.resolve().then(() => {
                const courses = options.courses.map((course, index) => normalizeCourse(course, { origin, sourceOrder: index })).filter(Boolean);
                const result = courseState(courses);
                reportCourses(result);
                return result;
            })
            : fetchCoursesState({
                fetchImpl: options.fetchImpl || globalThis.fetch,
                origin,
                signal: options.signal,
                maxPages: options.maxPages,
                onProgress: reportCourses
            });
        // Displayed-card evidence precedence: a caller-pinned set wins, then
        // the cards actually rendered in the dashboard DOM (excluding inline
        // display:none / hidden / aria-hidden / known-hidden course ids), then
        // the persisted displayed subset for this origin — which keeps
        // off-dashboard pages matching the card section the user last saw.
        // No authoritative evidence at all falls open to every active
        // enrollment: an empty set is a safe fallback, never a hidden set.
        const discoveredCardIds = dashboardCardCourses.map((course) => course.id);
        const displayedCardsPromise = (async () => {
            if (options.dashboardCards !== undefined) return { source: "pinned", ids: options.dashboardCards };
            if (discoveredCardIds.length) return { source: "dom", ids: discoveredCardIds };
            if (typeof options.displayedCardStore?.read === "function") {
                try {
                    const entry = await options.displayedCardStore.read({ origin });
                    if (Array.isArray(entry?.courseIds) && entry.courseIds.length) return { source: "cache", ids: entry.courseIds };
                } catch (error) { /* A broken cache reads as no evidence. */ }
            }
            return { source: "none", ids: [] };
        })();
        const [resolvedIdentity, unread, courseResult, displayedCards] = await Promise.all([
            resolveIdentity({ ...options, document, location, origin }),
            options.unread !== undefined ? Promise.resolve(options.unread) : fetchUnread({ fetchImpl: options.fetchImpl || globalThis.fetch, origin, signal: options.signal }),
            courseResultPromise,
            displayedCardsPromise
        ]);
        // Evidence entries may arrive as course objects (pinned callers) or id
        // strings (DOM, cache); normalize once so the filter only ever sees
        // valid course ids.
        const dashboardCardIds = (Array.isArray(displayedCards.ids) ? displayedCards.ids : [])
            .map((card) => normalizeCourseId(card && typeof card === "object" ? card.id ?? card.course_id ?? card.courseId : card))
            .filter(Boolean);
        // Persist the authoritative displayed subset so pages without a card
        // section (course pages, calendar) can still mirror it. The write is
        // observational: a rejected cache write must never fail assembly.
        if (displayedCards.source === "dom" && dashboardCardIds.length && typeof options.displayedCardStore?.write === "function") {
            try {
                void Promise.resolve(options.displayedCardStore.write({
                    origin,
                    userId: resolvedIdentity.identity?.userId ?? null,
                    courseIds: dashboardCardIds.slice()
                })).catch(() => {});
            } catch (error) { /* Observational. */ }
        }
        const apiUser = resolvedIdentity.apiUser;
        const identityRecord = resolvedIdentity.identity;
        const pages = discoverPages({ document, location, origin, unread });
        const knownPages = pages.length ? pages : KNOWN_PAGES.map((page) => ({ id: page.id, label: page.label, href: null, source: "canvas", iconRole: page.iconRole, available: false, known: true }));
        const reconciledPages = model?.reconcileSidebarPages
            ? model.reconcileSidebarPages({ knownPages, savedOrder: options.savedOrder, savedVisibility: options.savedVisibility })
            : { pages: knownPages, order: knownPages.map((page) => page.id), visibility: {} };
        // The rail mirrors the student's dashboard: active enrollments set the
        // ceiling, and the authoritative displayed-card evidence removes the
        // courses whose cards are not actually rendered.
        const courses = courseResult.status === "error"
            ? courseResult.courses
            : filterCoursesToDashboardCards(courseResult.courses, dashboardCardIds);
        const reconciledCourses = model?.reconcileSidebarCourses
            ? model.reconcileSidebarCourses({ courses, savedOrder: options.savedCourseOrder })
            : { courses, order: courses.map((course) => course.id) };
        // Canvas hydrates dashboard cards asynchronously: an initial refresh on
        // a dashboard route can legitimately find zero rendered cards before
        // the framework paints them. No evidence at all then falls open to the
        // active ceiling, which must stay a temporary state — the caller is
        // told the evidence is pending so it can reconcile once hydration
        // lands instead of mirroring every active enrollment permanently.
        const displayedCardsPending = displayedCards.source === "none"
            && route.kind === "dashboard"
            && courseResult.status === "populated";
        return {
            version: VERSION,
            identity: identityRecord,
            account: { origin, userId: identityRecord.userId, accountKey: identityRecord.accountKey },
            route,
            pages: reconciledPages.pages,
            pageOrder: reconciledPages.order,
            pageVisibility: reconciledPages.visibility,
            courses: reconciledCourses.courses,
            courseOrder: reconciledCourses.order,
            displayedCardIds: dashboardCardIds,
            displayedCardSource: displayedCards.source,
            displayedCardsPending,
            courseState: {
                status: courseResult.status === "error" ? "error" : reconciledCourses.courses.length ? "populated" : "empty",
                retryable: courseResult.retryable === true,
                reason: courseResult.reason || null
            }
        };
    }

    function createSidebarAdapter(options = {}) {
        const defaults = { ...options };
        return Object.freeze({
            version: VERSION,
            // assemble() resolves identity (and the opaque account key) itself.
            // The sidebar controller reads this flag to skip its external
            // identity probe, which would duplicate the /users/self request on
            // every refresh.
            identityWithinAssembly: true,
            discoverIdentity: (input = {}) => discoverIdentity({ ...defaults, ...input }),
            discoverPages: (input = {}) => discoverPages({ ...defaults, ...input }),
            fetchCurrentUser: (input = {}) => fetchCurrentUser({ ...defaults, ...input }),
            fetchUnread: (input = {}) => fetchUnread({ ...defaults, ...input }),
            fetchCourses: (input = {}) => fetchCourses({ ...defaults, ...input }),
            fetchCoursesState: (input = {}) => fetchCoursesState({ ...defaults, ...input }),
            fetchCourseNavigation: (input = {}) => fetchCourseNavigation({ ...defaults, ...input }),
            getCourseNavigation: (input = {}) => getCourseNavigation({ ...defaults, ...input }),
            resolveIdentity: (input = {}) => resolveIdentity({ ...defaults, ...input }),
            assemble: (input = {}) => assembleSidebarModel({ ...defaults, ...input })
        });
    }

    return Object.freeze({
        VERSION,
        API_PAGE_SIZE,
        KNOWN_PAGES,
        APSTUDY_PAGES,
        PAGE_SELECTORS,
        COURSE_PATH,
        normalizeCanvasOrigin: normalizedOrigin,
        safeUrl,
        canonicalPath,
        unknownPageIdForRoute,
        parseCanvasRoute,
        routeMatches,
        parseCount,
        normalizeCourseId,
        isPublishedActiveCourse,
        normalizeCourse,
        discoverDashboardCourses,
        normalizeCourseTab,
        normalizeCourseNavigation,
        fetchJson,
        fetchPaginated,
        fetchCurrentUser,
        fetchUnread,
        filterCoursesToDashboardCards,
        fetchCourses,
        fetchCoursesState,
        fetchCourseNavigation,
        getCourseNavigation,
        resolveIdentity,
        discoverIdentity,
        discoverPages,
        assembleSidebarModel,
        createSidebarAdapter
    });
}));
