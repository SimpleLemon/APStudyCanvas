(function () {
    "use strict";

    const NEST_ORIGIN = "https://nest.apstudy.org";
    const BRIDGE_REQUEST = "APSTUDYCANVAS_NEST_BRIDGE_REQUEST";
    const BRIDGE_RESPONSE = "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE";
    const platform = globalThis.APStudyCanvasPlatform;
    const contract = platform?.Contract;
    const transport = platform?.Transport;

    function extensionSender(sender) {
        return contract?.isExactExtensionSender(sender, contract.extensionOrigin(chrome.runtime));
    }

    function bridgeError(requestId, code) {
        return { kind: BRIDGE_RESPONSE, version: 1, request_id: requestId, ok: false, code: /^NEST_[A-Z0-9_]+$/.test(code || "") ? code : "NEST_BRIDGE_FAILED" };
    }

    async function fetchRequest(request, { allowCsrfHeader = false } = {}) {
        const response = await fetch(`${NEST_ORIGIN}${request.path}`, {
            method: request.method,
            credentials: "include",
            headers: request.headers,
            ...(request.body === undefined ? {} : { body: request.body })
        });
        return transport.responseFromFetch(response, { allowCsrfHeader });
    }

    async function freshCsrf(requestId) {
        const request = transport.validateTransportRequest({
            method: "GET",
            path: "/api/extension/csrf",
            headers: { Accept: "application/json", "X-Request-ID": requestId }
        });
        const response = await fetchRequest(request, { allowCsrfHeader: true });
        const token = response?.headers?.["x-csrftoken"];
        if (!response?.ok || typeof token !== "string" || !token || token.length > 512 || /[\r\n]/.test(token)) throw new Error("NEST_CSRF_UNAVAILABLE");
        return token;
    }

    function mutationRequest(base, csrf, requestId, idempotencyKey) {
        return transport.validateTransportRequest({
            method: base.method,
            path: base.path,
            body: base.body,
            headers: Object.assign({}, base.headers, {
                "X-CSRFToken": csrf,
                "X-Request-ID": requestId,
                "Idempotency-Key": idempotencyKey,
                "Content-Type": "application/json",
                Accept: "application/json"
            })
        });
    }

    async function performMutation(base, requestId, metadata) {
        if (base.method === "GET" || base.headers["x-csrftoken"]) throw new Error("NEST_BRIDGE_MUTATION_INVALID");
        if (!platform.Security.isPlainObject(metadata) || typeof metadata.idempotent !== "boolean" || typeof metadata.idempotency_key !== "string" || !metadata.idempotency_key || metadata.idempotency_key.length > 160 || /[\r\n]/.test(metadata.idempotency_key)) throw new Error("NEST_BRIDGE_MUTATION_INVALID");
        let csrf = await freshCsrf(requestId);
        let retried = false;
        for (;;) {
            const response = await fetchRequest(mutationRequest(base, csrf, requestId, metadata.idempotency_key));
            const csrfFailure = response.status === 403 || response.status === 419;
            if (!csrfFailure || !metadata.idempotent || retried) return Object.assign(response, { retried });
            retried = true;
            csrf = await freshCsrf(requestId);
        }
    }

    async function handleBridgeRequest(message, sender) {
        if (location.origin !== NEST_ORIGIN || !extensionSender(sender)) return undefined;
        if (!transport || !contract || message?.kind !== BRIDGE_REQUEST || message.version !== 1 || typeof message.request_id !== "string") return undefined;
        let request;
        try {
            request = transport.validateTransportRequest(message.request);
            if (request.path === "/api/extension/csrf" || request.headers["x-csrftoken"]) throw new Error("NEST_BRIDGE_REQUEST_FORBIDDEN");
            const response = message.mutation
                ? await performMutation(request, message.request_id, message.mutation)
                : await fetchRequest(request);
            return Object.assign({ kind: BRIDGE_RESPONSE, version: 1, request_id: message.request_id }, response);
        } catch (error) {
            return bridgeError(message.request_id, error?.message);
        }
    }

    if (location.origin === NEST_ORIGIN && chrome.runtime?.onMessage?.addListener) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message?.kind !== BRIDGE_REQUEST) return false;
            handleBridgeRequest(message, sender).then((response) => {
                if (response) sendResponse(response);
            }).catch(() => sendResponse(bridgeError(message?.request_id, "NEST_BRIDGE_FAILED")));
            return true;
        });
    }
}());
