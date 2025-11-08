// Node 20+, ESM. Uses global fetch.
const asJson = async (res) => {
    const text = await res.text();
    try { return JSON.parse(text || "{}"); } catch { return { raw: text }; }
};

const authHeader = (email, token) =>
    "Basic " + Buffer.from(`${email}:${token}`).toString("base64");

// Map STATUS tokens -> your Jira board statuses (from your screenshot)
export const statusMap = {
    Analyze: "Analyze and Size",
    AnalyzeAndSize: "Analyze and Size",
    Build: "Build",
    ValidateTest: "Validate Test",
    EndToEndTest: "End to End Testing",
    RegressionTest: "Regression Testing",
    CertifyRelease: "Certify and Release",
};

export async function updateJiraStatus({
    baseUrl,          // e.g. https://<your>.atlassian.net
    email,            // Jira user email
    token,            // Jira API token
    issueKey,         // e.g. PEB-4
    statusToken,      // e.g. "Build" (from commit)
    dryRun = false,
}) {
    if (!baseUrl || !email || !token) throw new Error("Jira credentials missing.");
    if (!issueKey) throw new Error("issueKey missing.");
    if (!statusToken) {
        console.log("[Jira] No STATUS token provided; skipping transition.");
        return { skipped: true };
    }

    const targetStatus = statusMap[statusToken] || statusToken; // allow direct status names too
    const headers = {
        Authorization: authHeader(email, token),
        Accept: "application/json",
        "Content-Type": "application/json",
    };

    // 1) Get current status (optional, just for logs)
    {
        const res = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}?fields=status`, { headers });
        if (!res.ok) {
            const body = await asJson(res);
            console.warn(`[Jira] Could not read current status (${res.status}).`, body);
        } else {
            const info = await res.json();
            console.log(`[Jira] ${issueKey} current status: ${info?.fields?.status?.name}`);
        }
    }

    // 2) Get available transitions
    const tRes = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, { headers });
    if (!tRes.ok) {
        const body = await asJson(tRes);
        throw new Error(`[Jira] transitions fetch failed: ${tRes.status} ${JSON.stringify(body)}`);
    }
    const tJson = await tRes.json();
    const transitions = tJson?.transitions || [];

    // Try to match by target status name (case-insensitive)
    const match = transitions.find(t =>
        (t.to?.name || "").toLowerCase() === targetStatus.toLowerCase()
    ) ||
        // Fallback: sometimes transition name equals the column name
        transitions.find(t =>
            (t.name || "").toLowerCase() === targetStatus.toLowerCase()
        );

    if (!match) {
        console.warn(`[Jira] No transition found to "${targetStatus}". Available: ${transitions.map(t => `${t.name}->${t.to?.name}`).join(", ")}`);
        return { skipped: true, reason: "no-transition" };
    }

    console.log(`[Jira] Will transition via "${match.name}" → "${match.to?.name}" (id=${match.id}). target="${targetStatus}"`);

    if (dryRun) {
        console.log("[Jira] dryRun=true, skipping POST /transitions");
        return { dryRun: true, transitionId: match.id, to: match.to?.name };
    }

    // 3) Apply transition
    const postRes = await fetch(`${baseUrl}/rest/api/3/issue/${issueKey}/transitions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ transition: { id: match.id } }),
    });

    if (!postRes.ok) {
        const body = await asJson(postRes);
        throw new Error(`[Jira] transition POST failed: ${postRes.status} ${JSON.stringify(body)}`);
    }

    console.log(`[Jira] Transition applied to "${match.to?.name}"`);
    return { ok: true, to: match.to?.name, transitionId: match.id };
}