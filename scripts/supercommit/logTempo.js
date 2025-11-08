// scripts/supercommit/logTempo.js
// Node 20+, ESM. Uses global fetch.
// Backward-compatible Tempo worklog helpers (v4 API).
//
// Supported caller shapes:
//
//   // legacy
//   logTempo({ issue, issueId, logHours, logDate, comment, phase, authorAccountId })
//
//   // new (preferred by updated index.js)
//   logTempo({ issueId, hours, when, comment, attributeKey, attributeValue, authorAccountId })
//
// Both forms accept tempoApiToken (or read from env), tempoApiBase (defaults to v4).

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Normalize to yyyy-mm-dd; accepts "yyyy-mm-dd", ISO datetime, or Date */
function toYMD(d) {
    if (!d) return new Date().toISOString().slice(0, 10);
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    const s = String(d).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const dt = new Date(s);
    if (!Number.isFinite(dt.getTime())) throw new Error(`Invalid date: "${d}"`);
    return dt.toISOString().slice(0, 10);
}

function toSeconds(hoursLike) {
    const n = Number(hoursLike);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid log hours: ${hoursLike}`);
    return Math.round(n * 3600);
}

/** Helpers to introspect Tempo work attributes (best-effort). */
async function getWorkAttributes(tempoApiBase, token) {
    const url = `${tempoApiBase.replace(/\/+$/, "")}/work-attributes`;
    const res = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });
    if (!res.ok) throw new Error(`[Tempo] ${res.status} ${await res.text()}`);
    return res.json();
}

async function adviseCategory(tempoApiBase, token) {
    try {
        const data = await getWorkAttributes(tempoApiBase, token);
        const cat = (data?.results || []).find(a => a.key === "_Category_");
        if (!cat) {
            console.warn("[Tempo] Work attribute _Category_ not found. You can remove TEMPO_CATEGORY_KEY or create the attribute in Tempo Settings → Work attributes.");
            return;
        }
        const opts = (cat?.options || []).map(o => o.value).join(", ");
        console.warn(`[Tempo] Valid Category options are: ${opts}`);
    } catch (e) {
        console.warn("[Tempo] Could not list Category options:", String(e));
    }
}

/**
 * Low-level: create a Tempo worklog using seconds + date.
 */
export async function logTempoWorklog({
    tempoApiBase = "https://api.tempo.io/4",
    tempoApiToken,
    issueKey,                 // e.g., "PEB-4"
    issueId,                  // numeric Jira id (string/number)
    description,              // human text
    startDate,                // yyyy-mm-dd
    startTime = "09:00:00",   // hh:mm:ss
    timeSpentSeconds,         // integer seconds
    authorAccountId,          // required for your tenant
    attributes = {}           // optional: { "_Category_": "Development", ... }
}) {
    // fallbacks
    const authorFromEnv = process.env.TEMPO_AUTHOR_ACCOUNT_ID || process.env.JIRA_ACCOUNT_ID;
    if (!authorAccountId && authorFromEnv) authorAccountId = authorFromEnv;

    if (!tempoApiToken) throw new Error("Tempo token missing.");
    if (!issueKey && !issueId) throw new Error("Tempo worklog requires issueKey or issueId.");
    if (!startDate) throw new Error("Tempo worklog requires startDate.");
    if (!timeSpentSeconds) throw new Error("Tempo worklog requires timeSpentSeconds.");
    if (!authorAccountId) throw new Error("Tempo worklog requires authorAccountId (set TEMPO_AUTHOR_ACCOUNT_ID).");

    const url = `${tempoApiBase.replace(/\/+$/, "")}/worklogs`;
    const headers = {
        "Authorization": `Bearer ${tempoApiToken}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
    };

    // Build attributes array, skipping empty values
    let attributesArray;
    if (attributes && Object.keys(attributes).length) {
        const filtered = Object.entries(attributes)
            .filter(([_, v]) => v !== undefined && v !== null && String(v).trim() !== "")
            .map(([k, v]) => ({ key: String(k), value: String(v) }));
        if (filtered.length) attributesArray = filtered;
    }

    const payload = {
        ...(issueId ? { issueId: String(issueId) } : {}),
        ...(issueKey ? { issueKey } : {}),
        description: description ?? "",
        startDate,
        startTime,
        timeSpentSeconds: Math.round(Number(timeSpentSeconds)),
        authorAccountId,
        ...(attributesArray ? { attributes: attributesArray } : {})
    };

    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });

            if (res.ok) {
                const json = await res.json().catch(() => ({}));
                console.log(
                    `[Tempo] Worklog created: id=${json?.id ?? "unknown"} issue=${issueKey ?? issueId} secs=${payload.timeSpentSeconds} date=${payload.startDate}`
                );
                return json;
            }

            if (res.status === 409) {
                console.warn(`[Tempo] 409 Conflict: matching worklog already exists. Treating as success.`);
                return { conflict: true };
            }

            if (res.status === 400) {
                const text = await res.text().catch(() => "");
                if (/already\s+exists|duplicate/i.test(text)) {
                    console.warn(`[Tempo] 400 Duplicate detected. Treating as success.`);
                    return { duplicate: true };
                }
                // Special advice for Category mismatch errors; do not retry 400s.
                if (/Category/i.test(text)) {
                    await adviseCategory(tempoApiBase, tempoApiToken);
                }
                const e = new Error(`[Tempo] 400 Bad Request. Body: ${text}`);
                e.noRetry = true;
                throw e;
            }

            if (res.status === 429 || res.status >= 500) {
                const retryAfter = Number(res.headers.get("retry-after")) || 500 * Math.pow(2, attempt - 1);
                console.warn(`[Tempo] ${res.status} → retrying in ${retryAfter} ms (attempt ${attempt}/${maxRetries})`);
                await sleep(retryAfter);
                continue;
            }

            const bodyTxt = await res.text().catch(() => "");
            const e = new Error(`[Tempo] ${res.status} ${res.statusText}. Body: ${bodyTxt}`);
            // treat other 4xx as non-retriable
            if (res.status >= 400 && res.status < 500) e.noRetry = true;
            throw e;
        } catch (err) {
            if (err?.noRetry) {
                // Permanent error; don't retry further.
                throw err;
            }
            if (attempt < maxRetries) {
                const backoff = 500 * Math.pow(2, attempt - 1);
                console.warn(`[Tempo] Network error: ${err.message}. Retrying in ${backoff} ms...`);
                await sleep(backoff);
                continue;
            }
            throw new Error(`[Tempo] Network error after ${maxRetries} attempts: ${err.message}`);
        }
    }
}

/**
 * High-level convenience wrapper used by index.js.
 * Accepts both the legacy and the new calling shapes.
 */
export async function logTempo(args = {}) {
    const tempoApiBase = args.tempoApiBase || "https://api.tempo.io/4";
    const tempoApiToken = args.tempoApiToken || process.env.TEMPO_API_TOKEN || process.env.TEMPO_TOKEN;

    // identify issue reference
    const issueKey = args.issue ?? undefined;
    const issueId = args.issueId ?? undefined;

    // support both hours fields
    const hours = (args.hours ?? args.logHours);
    if (!(hours > 0)) throw new Error("Tempo logHours missing.");
    const timeSpentSeconds = toSeconds(hours);

    // support both date fields
    const startDate = toYMD(args.when ?? args.logDate);

    const description = args.comment ?? "";

    // author
    let authorAccountId = args.authorAccountId || process.env.TEMPO_AUTHOR_ACCOUNT_ID || process.env.JIRA_ACCOUNT_ID;

    // attributes:
    // - If explicit key/value provided, include only if value is non-empty.
    // - Else, legacy 'phase' maps to a category-like attribute, included only if non-empty.
    const attributes = {};
    const attrKeyRaw = args.attributeKey;
    const attrValRaw = args.attributeValue;

    if (attrKeyRaw && String(attrValRaw ?? "").trim() !== "") {
        attributes[String(attrKeyRaw)] = String(attrValRaw).trim();
    } else if (args.phase && String(args.phase).trim() !== "") {
        // Keep legacy mapping without breaking callers; many tenants use "_Category_" as the key.
        // If your env supplies a specific key, prefer that; otherwise default to "_Category_".
        const legacyKey = process.env.TEMPO_CATEGORY_ATTRIBUTE_KEY?.trim() || "_Category_";
        attributes[legacyKey] = String(args.phase).trim();
    }

    return logTempoWorklog({
        tempoApiBase,
        tempoApiToken,
        issueKey,
        issueId,
        description,
        startDate,
        timeSpentSeconds,
        authorAccountId,
        attributes
    });
}