// scripts/supercommit/index.js
// Node 20+, ESM. Uses global fetch.
// Applies Jira transition (from STATUS:...), logs Tempo (from LOG:...),
// posts a Jira comment (ADF), and sets the "Ready" field if READY: token is present.

import { parseCommitMessage } from "./parse.js";
import { logTempo } from "./logTempo.js";
import fs from "node:fs";

// ---- Env -------------------------------------------------------------------

const env = {
    baseUrl: process.env.JIRA_BASE_URL?.trim().replace(/\/+$/, "") ?? "",
    email: process.env.JIRA_EMAIL ?? "",
    token: process.env.JIRA_API_TOKEN ?? "",
    dryRun: String(process.env.DRY_RUN ?? "false").toLowerCase() === "true",
    commitMessage: process.env.COMMIT_MESSAGE ?? "",

    // Tempo
    tempoToken: process.env.TEMPO_TOKEN ?? process.env.TEMPO_API_TOKEN ?? "",
    tempoAuthorId: process.env.TEMPO_AUTHOR_ACCOUNT_ID ?? "",
    tempoAttrKey: (process.env.TEMPO_CATEGORY_ATTRIBUTE_KEY ?? "_Category_").trim(),
    tempoCategoryValue: (process.env.TEMPO_CATEGORY_KEY ?? "").trim(),
    tempoAllowedValues: (process.env.TEMPO_CATEGORY_ALLOWED ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean),

    // Jira Ready custom field
    readyFieldId: process.env.JIRA_READY_FIELD_ID ?? "",
    readyFieldType: (process.env.JIRA_READY_FIELD_TYPE ?? "").trim().toLowerCase(),
    readyYesValue: (process.env.JIRA_READY_YES_VALUE ?? "Yes").trim(),

    // Jira REST
    jiraApiBase: process.env.JIRA_BASE_URL?.trim().replace(/\/+$/, "") ?? "",
};

// ---- GitHub step output helper ---------------------------------------------

function setStepOutput(name, value) {
    const f = process.env.GITHUB_OUTPUT;
    if (f) {
        fs.appendFileSync(f, `${name}=${value}\n`);
    } else {
        console.log(`[SuperCommit][OUTPUT] ${name}=${value}`);
    }
}

// Default: do NOT create a PR unless explicitly triggered
setStepOutput("create_pr", "no");

// ---- HTTP helpers -----------------------------------------------------------

async function jiraFetch(path, opts = {}) {
    const url = `${env.jiraApiBase}${path}`;
    const headers = {
        "Authorization": `Basic ${Buffer.from(`${env.email}:${env.token}`).toString("base64")}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...(opts.headers ?? {})
    };
    const res = await fetch(url, { ...opts, headers });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`[Jira] ${res.status} ${res.statusText}. Body: ${text}`);
    }
    return res;
}

async function getIssueMinimal(issueKey) {
    const res = await jiraFetch(`/rest/api/3/issue/${issueKey}?fields=status`);
    const json = await res.json();
    return {
        id: json?.id,
        status: json?.fields?.status?.name ?? ""
    };
}

async function getTransitions(issueKey) {
    const res = await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`);
    const json = await res.json();
    return json?.transitions ?? [];
}

async function applyTransition(issueKey, transitionId) {
    await jiraFetch(`/rest/api/3/issue/${issueKey}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: String(transitionId) } })
    });
}

// ---- Ready Field Update -----------------------------------------------------

async function updateReadyField(issueKey, readyValueBool) {
    if (!env.readyFieldId) {
        console.log("[SuperCommit] Ready field id missing; skipping.");
        return;
    }

    const yesLabel = env.readyYesValue || "Yes";
    const noLabel = (yesLabel.toLowerCase() === "yes") ? "No" : "No";
    const label = readyValueBool ? yesLabel : noLabel;

    const bodiesByType = {
        string: [{ fields: { [env.readyFieldId]: label } }],
        option: [{ fields: { [env.readyFieldId]: { value: label } } }],
        array: [{ fields: { [env.readyFieldId]: [{ value: label }] } }],
    };

    const fallback = [
        { fields: { [env.readyFieldId]: label } },
        { fields: { [env.readyFieldId]: { value: label } } },
        { fields: { [env.readyFieldId]: [{ value: label }] } },
    ];

    const typed = bodiesByType[env.readyFieldType] ?? [];
    const candidateBodies = typed.concat(
        fallback.filter(
            b1 => !typed.some(b0 => JSON.stringify(b0) === JSON.stringify(b1))
        )
    );

    let lastErr = null;
    for (const body of candidateBodies) {
        try {
            await jiraFetch(`/rest/api/3/issue/${issueKey}`, {
                method: "PUT",
                body: JSON.stringify(body)
            });
            console.log(`[SuperCommit] Ready field updated on ${issueKey} -> ${label}.`);
            return;
        } catch (e) {
            lastErr = e;
        }
    }

    console.warn(
        `[SuperCommit][WARN] Ready update failed for ${issueKey}. ` +
        `Check JIRA_READY_FIELD_ID, JIRA_READY_FIELD_TYPE and that option "${label}" exists. ` +
        `Last error: ${lastErr?.message || String(lastErr)}`
    );
}

// ---- Add Jira ADF comment ---------------------------------------------------

async function addJiraCommentADF(issueKey, message) {
    const adf = {
        body: {
            type: "doc",
            version: 1,
            content: [
                {
                    type: "paragraph",
                    content: [{ type: "text", text: message || "" }]
                }
            ]
        }
    };
    await jiraFetch(`/rest/api/3/issue/${issueKey}/comment`, {
        method: "POST",
        body: JSON.stringify(adf)
    });
    console.log(`[SuperCommit] Jira comment posted (ADF).`);
}

// ---- Tempo category helpers -------------------------------------------------

function normalizeCategoryName(x) {
    if (!x) return "";
    const s = String(x).trim().toLowerCase();
    const map = new Map([
        ["dev", "Development"],
        ["development", "Development"],
        ["build", "Development"],
        ["test", "Testing"],
        ["testing", "Testing"],
        ["qa", "Testing"],
        ["docs", "Documentation"],
        ["doc", "Documentation"],
        ["document", "Documentation"],
        ["ops", "Operations"],
        ["deploy", "Deployment"],
        ["release", "Deployment"],
        ["bugfix", "Bug Fixing"],
        ["bug", "Bug Fixing"],
        ["analysis", "Analysis"],
        ["analyze", "Analysis"],
    ]);
    if (map.has(s)) return map.get(s);
    return s ? s.replace(/\b\w/g, c => c.toUpperCase()) : "";
}

function chooseValidCategory(candidateRaw) {
    const normalized = normalizeCategoryName(candidateRaw);
    const allowed = env.tempoAllowedValues;

    if (!normalized) return "";
    if (allowed.length === 0) return normalized;
    if (allowed.includes(normalized)) return normalized;

    console.warn(
        `[SuperCommit][WARN] Tempo category "${normalized}" not in allowed list [${allowed.join(", ")}]; using fallback.`
    );

    if (env.tempoCategoryValue && allowed.includes(env.tempoCategoryValue)) {
        return env.tempoCategoryValue;
    }
    return allowed[0] || "";
}

// ---- Main -------------------------------------------------------------------

function firstLineOf(msg) {
    return String(msg || "").split(/\r?\n/)[0].trim();
}

async function main() {
    const firstLine = firstLineOf(env.commitMessage);
    if (!firstLine) throw new Error("Empty COMMIT_MESSAGE.");

    // 🚫 Skip merge commits early
    if (/^Merge\b/i.test(firstLine)) {
        console.log("[SuperCommit] Merge commit detected — skipping entirely.");
        return;
    }

    const parsed = parseCommitMessage(firstLine);
    const issueKey = parsed.issueKey || parsed.issue || "";
    if (!issueKey) {
        console.error("[SuperCommit][DEBUG] Parsed object:", JSON.stringify(parsed));
        throw new Error("Commit must start with ISSUE-KEY (e.g., PEB-4).");
    }

    const hasStatus = !!parsed.status;
    const hasLog = parsed.logHours != null;
    const hasComment = !!parsed.comment;

    console.log(
        `[SuperCommit] issue=${issueKey} status=${parsed.status ?? "(none)"} ` +
        `log=${hasLog ? `${parsed.logHours}@${parsed.logDate || "today"}` : "(none)"} ` +
        `phase=${parsed.phase ? parsed.phase : "(none)"}`
    );

    // 0) Ready
    if (parsed.ready !== null && parsed.ready !== undefined) {
        try {
            await updateReadyField(issueKey, !!parsed.ready);
        } catch (err) {
            console.warn(`[SuperCommit][WARN] Ready update skipped: ${String(err.message || err)}`);
        }
    }

    // 1) Status change
    if (hasStatus) {
        try {
            const current = await getIssueMinimal(issueKey);
            console.log(`[SuperCommit] ${issueKey} current status: ${current.status}`);

            const transitions = await getTransitions(issueKey);
            const best =
                transitions.find(
                    t =>
                        (t?.to?.name ?? "")
                            .trim()
                            .toLowerCase() === parsed.status.trim().toLowerCase()
                ) ||
                transitions.find(t =>
                    (t?.name ?? "")
                        .toLowerCase()
                        .includes(parsed.status.trim().toLowerCase())
                );

            console.log(
                `[SuperCommit] Available transitions: ${transitions
                    .map(t => `"${t.name}"(id=${t.id}, to="${t?.to?.name}")`)
                    .join(", ")}`
            );

            if (!best) {
                console.warn(
                    `[SuperCommit][WARN] No matching transition found for status="${parsed.status}". Skipping transition.`
                );
            } else {
                console.log(
                    `[SuperCommit] Transition resolved → "${best.name}" (to="${best?.to?.name}", id=${best.id})`
                );
                if (!env.dryRun) {
                    await applyTransition(issueKey, best.id);
                    console.log(`[SuperCommit] Jira transition applied successfully (id=${best.id}).`);

                    // ✅ PR trigger: only when going from Build -> Validate Test
                    const goingTo = (best?.to?.name ?? "").trim().toLowerCase();
                    const from = (current?.status ?? "").trim().toLowerCase();
                    if (from === "build" && goingTo === "validate test") {
                        setStepOutput("create_pr", "yes");
                        console.log("[SuperCommit] PR trigger enabled (Build → Validate Test).");
                    }
                } else {
                    console.log(`[SuperCommit][DRY_RUN] Would apply Jira transition id=${best.id}.`);

                    // 🧩 DRY_RUN mode → never set PR trigger
                    console.log("[SuperCommit][DRY_RUN] Skipping PR trigger because DRY_RUN=true.");
                }
            }
        } catch (err) {
            console.warn(
                `[SuperCommit][WARN] Jira transition skipped due to error: ${String(err.message || err)}`
            );
        }
    }

    // 2) Tempo
    if (hasLog) {
        try {
            let issueNumericId = null;
            try {
                const issue = await getIssueMinimal(issueKey);
                issueNumericId = issue.id;
            } catch {
                // handled below
            }
            if (!issueNumericId) {
                console.warn(`[SuperCommit][WARN] [Tempo] Skipping worklog: could not resolve Jira issueId for ${issueKey}.`);
            } else {
                const attrKey = (env.tempoAttrKey || "").trim();
                const candidate = parsed.phase || env.tempoCategoryValue;
                const finalCategory = candidate && attrKey ? chooseValidCategory(candidate) : "";

                if (finalCategory && attrKey) {
                    console.log(`[SuperCommit] Tempo attribute key length=${attrKey.length}, value="${finalCategory}"`);
                } else {
                    console.log("[SuperCommit] Tempo Category omitted (disabled or empty).");
                }

                const _attributeProps = finalCategory && attrKey
                    ? { attributeKey: attrKey, attributeValue: finalCategory }
                    : {};

                await logTempo({
                    tempoApiToken: env.tempoToken,
                    authorAccountId: env.tempoAuthorId,
                    issueId: String(issueNumericId),
                    hours: parsed.logHours,
                    when: parsed.logDate || undefined,
                    comment: parsed.comment || "",
                    ..._attributeProps,
                    issue: undefined,
                    logHours: parsed.logHours,
                    logDate: parsed.logDate,
                    dryRun: env.dryRun
                });
            }
        } catch (err) {
            console.warn(`[SuperCommit][WARN] Tempo log skipped due to error: ${String(err.message || err)}`);
        }
    }

    // 3) Jira comment
    if (hasComment) {
        try {
            await addJiraCommentADF(issueKey, parsed.comment);
        } catch (err) {
            console.warn(`[SuperCommit][WARN] Jira comment skipped due to error: ${String(err.message || err)}`);
        }
    }

    console.log("Done.");
}

main().catch(e => {
    console.error(`[SuperCommit][FATAL] ${e?.stack || e?.message || String(e)}`);
    process.exitCode = 1;
});