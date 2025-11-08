// Node 20+, ESM
// <ISSUE-KEY> [STATUS:<new-status>] [LOG:<time>[@<yyyy-mm-dd>]] [DATE:<yyyy-mm-dd>] [COMMENT:<free text>] [PHASE:<phase>] [CAT:<phase>] [READY:<Yes|No|True|False|1|0|Y|N>]
//
// LOG supported:
//   - 2h@2025-10-06   (decimal hours + date)
//   - 1.5h            (decimal hours)
//   - 1:30@2025-10-06 (h:mm + date)
//   - 90m@2025-10-06  (minutes + date)
//   - 90m             (minutes)
//
// Returns: { issue, issueKey, status, logHours, logDate, comment, phase, ready, firstLine }

function sanitizeFirstLine(message) {
    const rawFirst = String(message ?? "").split(/\r?\n/)[0] ?? "";
    // strip BOM + zero-width chars, then left-trim spaces/tabs; keep trailing spacing intact
    return rawFirst
        .replace(/^\uFEFF/, "")           // UTF-8 BOM
        .replace(/^[\u200B\u200C\u200D]+/, "") // ZWSP/ZWNJ/ZWJ
        .replace(/^\s+/, "")              // leading whitespace
        .trimEnd();
}

function parseReady(val) {
    if (val == null) return null;
    const s = String(val).trim().toLowerCase();
    if (["y", "yes", "true", "1"].includes(s)) return true;
    if (["n", "no", "false", "0"].includes(s)) return false;
    return null;
}

export function parseCommitMessage(message) {
    if (typeof message !== "string" || !message.trim()) {
        throw new Error("Super Commit format: commit message is empty.");
    }

    const firstLine = sanitizeFirstLine(message);

    // ---- helpers ------------------------------------------------------------
    const failFormat = (msg) => { throw new Error(`Super Commit format: ${msg}`); };

    const onlyOne = (name) => {
        const count = (firstLine.match(new RegExp(String.raw`(?:^|\s)${name}:`, "g")) || []).length;
        if (count > 1) failFormat(`only one ${name} token is allowed.`);
    };

    const getToken = (name) => {
        // Capture up to next ALL-CAPS token or end of line
        const re = new RegExp(String.raw`(?:^|\s)${name}:\s*([^\s].*?)\s*(?=(?:\s[A-Z]+:|$))`);
        const m = firstLine.match(re);
        return m ? m[1].trim() : null;
    };

    const tidy = (v) => (typeof v === "string" && v.trim().length ? v.trim() : null);

    const isValidISODate = (s) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
        if (!m) return false;
        const y = +m[1], mo = +m[2], d = +m[3];
        const dt = new Date(Date.UTC(y, mo - 1, d));
        return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
    };

    // ---- issue key ----------------------------------------------------------
    const keyMatch = firstLine.match(/^([A-Z][A-Z0-9]{1,9}-\d+)\b/);
    if (!keyMatch) {
        failFormat("missing or invalid JIRA issue key at start (e.g., ABC-123).");
    }
    const issue = keyMatch[1];
    const issueKey = issue; // alias for callers that expect issueKey

    // ---- uniqueness ---------------------------------------------------------
    ["STATUS", "LOG", "COMMENT", "PHASE", "DATE", "CAT", "READY"].forEach(onlyOne);

    // ---- tokens -------------------------------------------------------------
    const status = tidy(getToken("STATUS"));
    const comment = tidy(getToken("COMMENT"));
    let phase = tidy(getToken("PHASE"));
    const catAlias = tidy(getToken("CAT"));
    if (!phase && catAlias) phase = catAlias;

    const dateToken = tidy(getToken("DATE"));

    // READY: Yes/No/True/False/1/0/Y/N
    const readyToken = tidy(getToken("READY"));
    const ready = parseReady(readyToken);

    // ---- LOG parsing --------------------------------------------------------
    const rawLog = tidy(getToken("LOG"));
    let logHours = null;
    let logDate = null;

    if (rawLog) {
        // optional @date split
        let timePart = rawLog;
        let datePart = null;
        const atIdx = rawLog.indexOf("@");
        if (atIdx >= 0) {
            timePart = rawLog.slice(0, atIdx);
            datePart = rawLog.slice(atIdx + 1).trim();
        }

        // 1) decimal hours
        let m = timePart.match(/^(\d+(?:\.\d+)?)h$/i);
        if (m) {
            logHours = parseFloat(m[1]);
        } else {
            // 2) h:mm
            m = timePart.match(/^(\d+):(\d{1,2})$/);
            if (m) {
                const h = parseInt(m[1], 10);
                const mins = parseInt(m[2], 10);
                if (mins >= 60) failFormat("LOG minutes must be < 60 for h:mm.");
                logHours = h + mins / 60;
            } else {
                // 3) minutes
                m = timePart.match(/^(\d+)m$/i);
                if (m) {
                    const minutes = parseInt(m[1], 10);
                    logHours = minutes / 60;
                } else {
                    failFormat("LOG must be 2h@YYYY-MM-DD, 1.5h, 1:30, or 90m.");
                }
            }
        }

        if (!(logHours > 0)) {
            failFormat("LOG hours must be a positive number.");
        }

        // date validation: format vs calendar validity
        if (datePart) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
                failFormat("date must be yyyy-mm-dd.");
            }
            if (!isValidISODate(datePart)) {
                throw new Error("LOG date must be a valid calendar date (yyyy-mm-dd).");
            }
            logDate = datePart;
        } else if (dateToken) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateToken)) {
                failFormat("date must be yyyy-mm-dd.");
            }
            if (!isValidISODate(dateToken)) {
                throw new Error("LOG date must be a valid calendar date (yyyy-mm-dd).");
            }
            logDate = dateToken;
        } else {
            logDate = null;
        }
    } else {
        // No LOG; still validate DATE if present
        if (dateToken) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateToken)) {
                failFormat("date must be yyyy-mm-dd.");
            }
            if (!isValidISODate(dateToken)) {
                throw new Error("LOG date must be a valid calendar date (yyyy-mm-dd).");
            }
            logDate = dateToken;
        } else {
            logDate = null;
        }
    }

    if (status !== null && !status.trim()) {
        failFormat("STATUS value cannot be empty.");
    }

    return { issue, issueKey, status, logHours, logDate, comment, phase, ready, firstLine };
}

export default { parseCommitMessage };