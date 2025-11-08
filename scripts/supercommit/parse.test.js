// scripts/supercommit/parse.test.js
// Node 20+, ESM using node:test
import test from "node:test";
import assert from "node:assert/strict";
import { parseCommitMessage } from "./parse.js";

test("all tokens present, any order", () => {
    const msg = "PAY-101 COMMENT:Refactor LOG:2.5h@2025-10-01 STATUS:In Progress PHASE:Development";
    const r = parseCommitMessage(msg);
    assert.equal(r.issue, "PAY-101");
    assert.equal(r.status, "In Progress");
    assert.equal(r.logHours, 2.5);
    assert.equal(r.logDate, "2025-10-01");
    assert.equal(r.comment, "Refactor");
    assert.equal(r.phase, "Development"); // ✅ New field check
});

test("issue only", () => {
    const r = parseCommitMessage("ABC-7");
    assert.equal(r.issue, "ABC-7");
    assert.equal(r.status, null);
    assert.equal(r.logHours, null);
    assert.equal(r.logDate, null);
    assert.equal(r.comment, null);
    assert.equal(r.phase, null); // ✅ New field check
});

test("LOG only", () => {
    const r = parseCommitMessage("OPS-55 LOG:1h@2025-12-31");
    assert.equal(r.issue, "OPS-55");
    assert.equal(r.logHours, 1);
    assert.equal(r.logDate, "2025-12-31");
    assert.equal(r.status, null);
    assert.equal(r.comment, null);
    assert.equal(r.phase, null); // ✅ New field check
});

test("invalid issue key", () => {
    assert.throws(
        () => parseCommitMessage("OPS55 LOG:1h@2025-12-31"),
        /Super Commit format/i
    );
});

test("invalid hours (non-positive)", () => {
    // Use 0h so regex still matches, then parser enforces positive
    assert.throws(
        () => parseCommitMessage("ABC-1 LOG:0h@2025-01-01"),
        /positive number/i
    );
});

test("invalid date format", () => {
    // Slashes don't match the regex, so expect the generic format error
    assert.throws(
        () => parseCommitMessage("ABC-1 LOG:1h@2025/01/01"),
        /Super Commit format/i
    );
});

test("invalid calendar date", () => {
    assert.throws(
        () => parseCommitMessage("ABC-1 LOG:1h@2025-02-30"),
        /valid calendar date/i
    );
});

test("multiple LOG tokens -> error", () => {
    assert.throws(
        () => parseCommitMessage("ABC-1 LOG:1h@2025-10-01 LOG:2h@2025-10-02"),
        /Only one LOG token/i
    );
});

test("multiple STATUS tokens -> error", () => {
    assert.throws(
        () => parseCommitMessage("ABC-1 STATUS:In Progress STATUS:Done"),
        /Only one STATUS token/i
    );
});

test("multiple COMMENT tokens -> error", () => {
    assert.throws(
        () => parseCommitMessage("ABC-1 COMMENT:one COMMENT:two"),
        /Only one COMMENT token/i
    );
});

// ✅ NEW TEST — Multiple PHASE tokens should throw an error
test("multiple PHASE tokens -> error", () => {
    assert.throws(
        () => parseCommitMessage("ABC-1 PHASE:Design PHASE:Development"),
        /Only one PHASE token/i
    );
});